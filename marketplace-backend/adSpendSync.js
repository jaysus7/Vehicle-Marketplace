/**
 * Ad-spend auto-import — Meta Ads + Google Ads → marketing_spend.
 *
 * Feeds the Marketing ROI report automatically instead of hand-keyed spend. Each
 * connection is per-dealership (one admin connects the store's ad account); a pull
 * writes monthly spend into marketing_spend under the SAME channel names the ROI
 * model derives from lead sources, so spend lines up with leads/sales:
 *   Meta       -> "Facebook Marketplace"
 *   Google Ads -> "Google"
 *
 * CONFIG-GATED — dark until the OAuth app keys are set on the server:
 *   META_ADS_CLIENT_ID / META_ADS_CLIENT_SECRET
 *   GOOGLE_ADS_CLIENT_ID / GOOGLE_ADS_CLIENT_SECRET / GOOGLE_ADS_DEVELOPER_TOKEN
 *
 * Redirect URIs to register:
 *   <BACKEND_URL>/adspend/callback/meta
 *   <BACKEND_URL>/adspend/callback/google_ads
 *
 * Reuses the signed-state CSRF helpers from calendarSync.js.
 */
import { supabaseAdmin, BACKEND_URL } from './shared.js'
import { signState, verifyState } from './calendarSync.js'

const META = { id: process.env.META_ADS_CLIENT_ID || '', secret: process.env.META_ADS_CLIENT_SECRET || '', ver: 'v21.0' }
const GADS = {
  id: process.env.GOOGLE_ADS_CLIENT_ID || '', secret: process.env.GOOGLE_ADS_CLIENT_SECRET || '',
  devToken: process.env.GOOGLE_ADS_DEVELOPER_TOKEN || '', ver: 'v17',
}
export const AD_PROVIDERS = ['meta', 'google_ads']
export const CHANNEL_OF_PROVIDER = { meta: 'Facebook Marketplace', google_ads: 'Google' }

export function adProviderConfigured(p) {
  if (p === 'meta') return !!(META.id && META.secret)
  if (p === 'google_ads') return !!(GADS.id && GADS.secret && GADS.devToken)
  return false
}
export function anyAdProviderConfigured() { return AD_PROVIDERS.some(adProviderConfigured) }
const redirectUri = (p) => `${BACKEND_URL}/adspend/callback/${p}`

export { signState, verifyState }

// ── Authorize URL ────────────────────────────────────────────────────────────
export function adAuthUrl(provider, state) {
  if (provider === 'meta') {
    const q = new URLSearchParams({ client_id: META.id, redirect_uri: redirectUri('meta'), state, response_type: 'code', scope: 'ads_read' })
    return `https://www.facebook.com/${META.ver}/dialog/oauth?${q}`
  }
  if (provider === 'google_ads') {
    const q = new URLSearchParams({
      client_id: GADS.id, redirect_uri: redirectUri('google_ads'), response_type: 'code',
      access_type: 'offline', prompt: 'consent', scope: 'https://www.googleapis.com/auth/adwords', state,
    })
    return `https://accounts.google.com/o/oauth2/v2/auth?${q}`
  }
  throw new Error('Unknown provider')
}

async function jsonFetch(url, opts = {}) {
  const r = await fetch(url, opts)
  const data = await r.json().catch(() => ({}))
  if (!r.ok) { const e = new Error(data.error?.message || data.error_description || data.error || `HTTP ${r.status}`); e.status = r.status; throw e }
  return data
}

// ── Exchange auth code → stored connection ───────────────────────────────────
export async function adExchangeAndStore(provider, code, { dealershipId, userId }) {
  if (provider === 'meta') {
    // Short-lived token, then swap for a ~60-day long-lived token (Meta has no refresh token).
    const short = await jsonFetch(`https://graph.facebook.com/${META.ver}/oauth/access_token?` + new URLSearchParams({
      client_id: META.id, client_secret: META.secret, redirect_uri: redirectUri('meta'), code,
    }))
    const long = await jsonFetch(`https://graph.facebook.com/${META.ver}/oauth/access_token?` + new URLSearchParams({
      grant_type: 'fb_exchange_token', client_id: META.id, client_secret: META.secret, fb_exchange_token: short.access_token,
    }))
    const access_token = long.access_token || short.access_token
    const expires_in = Number(long.expires_in) || 60 * 86400
    // Pick the first ad account on the token.
    const accts = await jsonFetch(`https://graph.facebook.com/${META.ver}/me/adaccounts?` + new URLSearchParams({ fields: 'account_id,name', access_token }))
    const first = (accts.data || [])[0]
    if (!first) throw new Error('No ad account found on this Facebook login.')
    return storeConnection({ dealershipId, userId, provider, account_id: first.account_id, account_name: first.name || null, access_token, refresh_token: null, expires_in })
  }
  if (provider === 'google_ads') {
    const tok = await jsonFetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code, client_id: GADS.id, client_secret: GADS.secret, redirect_uri: redirectUri('google_ads'), grant_type: 'authorization_code' }),
    })
    const access_token = tok.access_token
    const customers = await jsonFetch('https://googleads.googleapis.com/' + GADS.ver + '/customers:listAccessibleCustomers', {
      headers: { Authorization: `Bearer ${access_token}`, 'developer-token': GADS.devToken },
    })
    const resName = (customers.resourceNames || [])[0]
    const customerId = resName ? resName.split('/')[1] : null
    if (!customerId) throw new Error('No Google Ads account is accessible on this login.')
    return storeConnection({ dealershipId, userId, provider, account_id: customerId, account_name: customerId, access_token, refresh_token: tok.refresh_token || null, expires_in: Number(tok.expires_in) || 3500 })
  }
  throw new Error('Unknown provider')
}

async function storeConnection({ dealershipId, userId, provider, account_id, account_name, access_token, refresh_token, expires_in }) {
  const row = {
    dealership_id: dealershipId, provider, account_id, account_name, access_token,
    token_expires_at: new Date(Date.now() + expires_in * 1000).toISOString(),
    connected_by: userId, last_error: null, updated_at: new Date().toISOString(),
  }
  const { data: existing } = await supabaseAdmin.from('ad_connections').select('id, refresh_token').eq('dealership_id', dealershipId).eq('provider', provider).maybeSingle()
  row.refresh_token = refresh_token || existing?.refresh_token || null   // Google keeps its first refresh token
  if (existing) await supabaseAdmin.from('ad_connections').update(row).eq('id', existing.id)
  else await supabaseAdmin.from('ad_connections').insert(row)
  return { account_id, account_name }
}

// Google Ads access tokens are short-lived; refresh from the stored refresh token.
async function googleValidToken(conn) {
  if (conn.access_token && conn.token_expires_at && new Date(conn.token_expires_at).getTime() - 60000 > Date.now()) return conn.access_token
  if (!conn.refresh_token) throw new Error('Google Ads session expired — reconnect.')
  const tok = await jsonFetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ refresh_token: conn.refresh_token, client_id: GADS.id, client_secret: GADS.secret, grant_type: 'refresh_token' }),
  })
  const access_token = tok.access_token
  await supabaseAdmin.from('ad_connections').update({ access_token, token_expires_at: new Date(Date.now() + (Number(tok.expires_in) || 3500) * 1000).toISOString() }).eq('id', conn.id)
  conn.access_token = access_token
  return access_token
}

const ym = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`

// ── Pull monthly spend → upsert marketing_spend ──────────────────────────────
// Returns { months: n } written. Only touches rows this provider owns (source col).
export async function pullAdSpend(conn, { days = 120 } = {}) {
  const channel = CHANNEL_OF_PROVIDER[conn.provider]
  const byMonth = {}   // 'YYYY-MM' -> amount
  if (conn.provider === 'meta') {
    if (!conn.access_token) throw new Error('Not connected.')
    if (conn.token_expires_at && new Date(conn.token_expires_at) < new Date()) throw new Error('Facebook token expired — reconnect.')
    const since = new Date(Date.now() - days * 86400000)
    const acct = conn.account_id.startsWith('act_') ? conn.account_id : `act_${conn.account_id}`
    const url = `https://graph.facebook.com/${META.ver}/${acct}/insights?` + new URLSearchParams({
      fields: 'spend', level: 'account', time_increment: 'monthly', access_token: conn.access_token,
      time_range: JSON.stringify({ since: since.toISOString().slice(0, 10), until: new Date().toISOString().slice(0, 10) }),
    })
    const data = await jsonFetch(url)
    for (const row of (data.data || [])) { const m = ym(new Date(row.date_start)); byMonth[m] = (byMonth[m] || 0) + (Number(row.spend) || 0) }
  } else {
    const token = await googleValidToken(conn)
    const query = `SELECT metrics.cost_micros, segments.month FROM customer WHERE segments.date DURING LAST_${days >= 365 ? '365' : days >= 90 ? '90' : '30'}_DAYS`
    const out = await jsonFetch(`https://googleads.googleapis.com/${GADS.ver}/customers/${conn.account_id}/googleAds:searchStream`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'developer-token': GADS.devToken, 'login-customer-id': conn.account_id, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    })
    const batches = Array.isArray(out) ? out : [out]
    for (const b of batches) for (const r of (b.results || [])) {
      const month = r.segments?.month            // 'YYYY-MM-01'
      const cost = Number(r.metrics?.costMicros || r.metrics?.cost_micros || 0) / 1e6
      if (month) { const m = month.slice(0, 7); byMonth[m] = (byMonth[m] || 0) + cost }
    }
  }
  // Upsert one spend row per month (rounded), tagged with this provider as source.
  const months = Object.keys(byMonth)
  for (const period of months) {
    await supabaseAdmin.from('marketing_spend').upsert({
      dealership_id: conn.dealership_id, channel, period, amount: Math.round(byMonth[period] * 100) / 100,
      source: conn.provider, notes: 'Auto-imported', updated_at: new Date().toISOString(),
    }, { onConflict: 'dealership_id,channel,period' })
  }
  await supabaseAdmin.from('ad_connections').update({ last_synced_at: new Date().toISOString(), last_error: null }).eq('id', conn.id)
  return { months: months.length }
}
