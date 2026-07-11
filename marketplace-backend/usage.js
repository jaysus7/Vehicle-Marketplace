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
import { marketcheckMarket, marketcheckSoldListings, marketcheckEnabled } from './marketcheck.js'

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

// Per-dealership DAILY cap on live (paid) MarketCheck calls, on top of the monthly
// soft quota — stops one dealer draining the shared budget in a single day.
const MARKETCHECK_DAILY_CAP = Number(process.env.MARKETCHECK_DAILY_CAP || 200)

const period = () => new Date().toISOString().slice(0, 7)  // 'YYYY-MM' (UTC)
const dayPeriod = () => new Date().toISOString().slice(0, 10) // 'YYYY-MM-DD' (UTC)

// Stable key for a vehicle's market lookup — lowercased market|make|model|year|trim.
export function marketSignature({ make, model, year, trim, drivetrain, engine, zip, radius, isUS }) {
  // Base key (make/model/year/trim) — unchanged so the scan & price-report callers,
  // which don't pass the finer filters, keep hitting the same cache entries as before.
  const base = [isUS ? 'us' : 'ca', make, model, year, (trim || '').trim()]
    .map(s => String(s ?? '').toLowerCase().trim()).join('|')
  // Appraisal passes tighter filters; fold them in so a nearby-AWD-3.5L read can't
  // collide with a national all-drivetrain read of the same make/model/year/trim.
  const extra = []
  if (drivetrain) extra.push('dt:' + String(drivetrain).toLowerCase().trim())
  if (engine) extra.push('eng:' + String(engine).toLowerCase().replace(/\s+/g, ''))
  if (zip && Number(radius) > 0) extra.push('geo:' + String(zip).toLowerCase().replace(/\s+/g, '') + '@' + Math.round(Number(radius)))
  return extra.length ? base + '||' + extra.join('|') : base
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
  if (u.marketcheck_calls >= QUOTAS.marketcheck) return false      // monthly soft quota
  const d = await usageRow(dealershipId, dayPeriod())
  return d.marketcheck_calls < MARKETCHECK_DAILY_CAP               // daily cap
}

// Count one live MarketCheck call against BOTH the monthly counters (per-dealer +
// global budget) and today's per-dealer daily cap. Use this from any endpoint
// that makes a raw MarketCheck call outside getMarketData.
export async function recordMarketcheckCall(dealershipId) {
  await recordUsage(dealershipId, { marketcheck: 1 })
  if (dealershipId) {
    try {
      await supabaseAdmin.rpc('bump_usage', { p_dealership: dealershipId, p_period: dayPeriod(), p_mc: 1, p_ai: 0 })
    } catch { /* not provisioned yet — ignore */ }
  }
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
 *
 * Live (paid) calls are gated by `allowLive`. It defaults to FALSE so passive /
 * incidental reads (AI listing copy, card badges, etc.) only ever hit the cache
 * and never spend. Live MarketCheck is reserved for the nightly comp refresh and
 * explicit button actions (Scan All, Apply Rules, Appraise, Price Report), which
 * pass allowLive:true. A cache miss with allowLive:false returns null so the
 * caller falls back to its estimate — at $0.
 */
export async function getMarketData({ dealershipId, isOwner = false, params, allowLive = false }) {
  // No key configured → no live call to make or meter; let callers fall back.
  if (!marketcheckEnabled()) return { data: null, cached: false, capped: false }

  const sig = marketSignature(params)
  const hit = await getCache(sig)
  if (hit) return { data: hit, cached: true, capped: false }

  // Cache miss on a passive read → do NOT make a paid call. Caller falls back.
  if (!allowLive) return { data: null, cached: false, capped: false }

  if (!(await marketcheckAllowed(dealershipId, isOwner))) {
    return { data: null, cached: false, capped: true }
  }
  const data = await marketcheckMarket(params)
  // Count the call even when it returns no comps — the API request still cost money.
  await recordMarketcheckCall(dealershipId)
  if (data) await setCache(sig, data)
  return { data, cached: false, capped: false }
}

/**
 * Cached + metered RECENTLY-SOLD lookup — same contract as getMarketData but hits
 * MarketCheck's Past Inventory (sold) product. Kept as its own signature namespace
 * ('||sold') so it never collides with the live-comp cache. Returns { data, cached,
 * capped }; data is null when the plan isn't entitled to sold data (endpoint 403s),
 * in which case the caller simply omits the sold panel. Sold data changes slowly,
 * so it shares the same TTL as live comps.
 */
export async function getSoldData({ dealershipId, isOwner = false, params, allowLive = false }) {
  if (!marketcheckEnabled()) return { data: null, cached: false, capped: false }

  const sig = marketSignature(params) + '||sold'
  const hit = await getCache(sig)
  if (hit) return { data: hit._empty ? null : hit, cached: true, capped: false }
  if (!allowLive) return { data: null, cached: false, capped: false }
  if (!(await marketcheckAllowed(dealershipId, isOwner))) {
    return { data: null, cached: false, capped: true }
  }
  const data = await marketcheckSoldListings(params)
  await recordMarketcheckCall(dealershipId)
  // Cache a negative result too (empty object) so a plan-without-sold or a thin
  // sold market doesn't re-hit the paid endpoint on every appraisal for 7 days.
  await setCache(sig, data || { _empty: true })
  return { data: data && !data._empty ? data : null, cached: false, capped: false }
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
