// ─────────────────────────────────────────────────────────────────────────
// Cost controls for MarketCheck (metered, per-call cost) and AI usage.
//
//   • Shared cache — one live MarketCheck lookup per vehicle signature is reused
//     for MARKET_CACHE_DAYS and shared across the scan / appraisal / price report,
//     so a re-scan (or two identical trims) costs $0. This is the biggest saver.
//   • Soft per-dealership monthly quota — when a dealer exceeds it we DON'T block;
//     callers fall back to cache/estimate. Predictable cost per subscriber.
//   • Global monthly budget kill-switch — MARKETCHECK_MONTHLY_BUDGET caps total
//     live calls across ALL dealers so a bug or abuse can't blow past your ceiling.
//
// Everything fails OPEN: if the migration (market_cache / api_usage / bump_usage)
// hasn't been run yet, caching is skipped and nothing is capped — behaviour is
// exactly as before. Once the tables exist, the controls activate automatically.
// ─────────────────────────────────────────────────────────────────────────
import { supabaseAdmin } from './shared.js'
import { marketcheckMarket, marketcheckEnabled } from './marketcheck.js'

const GLOBAL_ID = '00000000-0000-0000-0000-000000000000'
const CACHE_DAYS = Number(process.env.MARKET_CACHE_DAYS || 7)

// Monthly included live MarketCheck lookups + AI ops per dealership (soft cap).
// Caching means real usage sits far below these; tune via env as you learn costs.
export const QUOTAS = {
  marketcheck: Number(process.env.MARKETCHECK_MONTHLY_QUOTA || 1500),
  ai: Number(process.env.AI_MONTHLY_QUOTA || 4000),
}
// Platform-wide monthly ceiling on live MarketCheck calls. 0 = disabled.
const GLOBAL_MC_BUDGET = Number(process.env.MARKETCHECK_MONTHLY_BUDGET || 0)

// Per-dealership DAILY cap on AI-assistant chats, so one chatty user can't burn
// the month's AI budget in an afternoon. Tracked in api_usage under a day-keyed
// period row (distinct from the 'YYYY-MM' monthly rows), so no new table needed.
const ASSISTANT_DAILY_CAP = Number(process.env.AI_ASSISTANT_DAILY_CAP || 40)

const period = () => new Date().toISOString().slice(0, 7)  // 'YYYY-MM' (UTC)
const dayPeriod = () => new Date().toISOString().slice(0, 10) // 'YYYY-MM-DD' (UTC)

// Stable key for a vehicle's market lookup — lowercased market|make|model|year|trim.
export function marketSignature({ make, model, year, trim, isUS }) {
  return [isUS ? 'us' : 'ca', make, model, year, (trim || '').trim()]
    .map(s => String(s ?? '').toLowerCase().trim()).join('|')
}

async function getCache(sig) {
  try {
    const { data, error } = await supabaseAdmin
      .from('market_cache').select('data, fetched_at').eq('signature', sig).maybeSingle()
    if (error || !data) return null
    if ((Date.now() - new Date(data.fetched_at)) / 86400000 > CACHE_DAYS) return null
    return data.data
  } catch { return null }
}

async function setCache(sig, data) {
  try {
    await supabaseAdmin.from('market_cache')
      .upsert({ signature: sig, data, fetched_at: new Date().toISOString() })
  } catch { /* table may not exist yet — ignore */ }
}

async function usageRow(id, p = period()) {
  try {
    const { data, error } = await supabaseAdmin
      .from('api_usage').select('marketcheck_calls, ai_calls')
      .eq('dealership_id', id).eq('period', p).maybeSingle()
    if (error || !data) return { marketcheck_calls: 0, ai_calls: 0 }
    return data
  } catch { return { marketcheck_calls: 0, ai_calls: 0 } }
}

// Increment usage counters (best-effort, atomic via RPC). Also rolls the totals
// into the global sentinel row for the budget kill-switch.
export async function recordUsage(dealershipId, { marketcheck = 0, ai = 0 } = {}) {
  if (!marketcheck && !ai) return
  const p = period()
  try {
    if (dealershipId) {
      await supabaseAdmin.rpc('bump_usage', { p_dealership: dealershipId, p_period: p, p_mc: marketcheck, p_ai: ai })
    }
    await supabaseAdmin.rpc('bump_usage', { p_dealership: GLOBAL_ID, p_period: p, p_mc: marketcheck, p_ai: ai })
  } catch { /* not provisioned yet — ignore */ }
}

// May we make a live (paid) MarketCheck call right now? Owner is exempt from the
// per-dealer quota but the global budget still applies to everyone.
export async function marketcheckAllowed(dealershipId, isOwner) {
  if (GLOBAL_MC_BUDGET > 0) {
    const g = await usageRow(GLOBAL_ID)
    if (g.marketcheck_calls >= GLOBAL_MC_BUDGET) return false
  }
  if (isOwner) return true
  const u = await usageRow(dealershipId)
  return u.marketcheck_calls < QUOTAS.marketcheck
}

// Whether a dealer is under its monthly AI quota (soft). Owner exempt.
export async function aiAllowed(dealershipId, isOwner) {
  if (isOwner || !dealershipId) return true
  const u = await usageRow(dealershipId)
  return u.ai_calls < QUOTAS.ai
}

// Whether a dealer is under its DAILY assistant-chat cap. Owner exempt. Reads a
// day-keyed api_usage row that only the assistant writes to (via
// recordAssistantChat), so it counts chats specifically, not other AI ops.
export async function assistantDailyAllowed(dealershipId, isOwner) {
  if (isOwner || !dealershipId) return true
  const u = await usageRow(dealershipId, dayPeriod())
  return u.ai_calls < ASSISTANT_DAILY_CAP
}

// Count one assistant chat against today's cap. Best-effort; fails open.
export async function recordAssistantChat(dealershipId) {
  if (!dealershipId) return
  try {
    await supabaseAdmin.rpc('bump_usage', { p_dealership: dealershipId, p_period: dayPeriod(), p_mc: 0, p_ai: 1 })
  } catch { /* not provisioned yet — ignore */ }
}

export const ASSISTANT_DAILY_LIMIT = ASSISTANT_DAILY_CAP

/**
 * Cached + metered market lookup — the single entry point every MarketCheck
 * consumer should use. Returns { data, cached, capped }:
 *   • cache hit  → { data, cached:true,  capped:false }  (free)
 *   • live call  → { data, cached:false, capped:false }  (counted)
 *   • over cap   → { data:null, cached:false, capped:true } (caller falls back)
 */
export async function getMarketData({ dealershipId, isOwner = false, params }) {
  // No key configured → no live call to make or meter; let callers fall back.
  if (!marketcheckEnabled()) return { data: null, cached: false, capped: false }

  const sig = marketSignature(params)
  const hit = await getCache(sig)
  if (hit) return { data: hit, cached: true, capped: false }

  if (!(await marketcheckAllowed(dealershipId, isOwner))) {
    return { data: null, cached: false, capped: true }
  }
  const data = await marketcheckMarket(params)
  // Count the call even when it returns no comps — the API request still cost money.
  await recordUsage(dealershipId, { marketcheck: 1 })
  if (data) await setCache(sig, data)
  return { data, cached: false, capped: false }
}

// For the usage endpoint / UI.
export async function getUsage(dealershipId) {
  const u = await usageRow(dealershipId)
  return {
    period: period(),
    marketcheck: { used: u.marketcheck_calls, limit: QUOTAS.marketcheck },
    ai: { used: u.ai_calls, limit: QUOTAS.ai },
  }
}
