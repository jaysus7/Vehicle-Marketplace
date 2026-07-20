/**
 * Square deposits — an alternative to Stripe for dealers who run their storefront on
 * Square. Same idea as the Stripe deposit flow: take a real, refundable deposit that
 * lands straight in the DEALER's own Square account (via Square OAuth — we never touch
 * the money). Stays completely inert until MarketSync provisions a Square app and sets
 * its env vars, exactly like the other OAuth connectors ("ops secret", not app logic):
 *
 *   SQUARE_APP_ID, SQUARE_APP_SECRET        — the MarketSync Square application
 *   SQUARE_ENV                              — 'production' (default) or 'sandbox'
 *   SQUARE_WEBHOOK_SIGNATURE_KEY            — verifies inbound payment webhooks
 *
 * Redirect URI to register with Square:  {BACKEND_URL}/square/callback
 * Webhook URL to register with Square:   {BACKEND_URL}/square/webhook  (event: payment.updated)
 *
 * Per-dealer OAuth tokens live encrypted in dealer_integrations.credentials_enc; the
 * (non-secret) merchant + location id live in lender_code_map. Tokens refresh on demand.
 */
import crypto from 'node:crypto'
import { BACKEND_URL, supabaseAdmin } from '../shared.js'
import { encryptJson, decryptJson } from '../crypto-pii.js'

export const PROVIDER = 'square_deposits'
const SQUARE_VERSION = '2024-10-17'

export const squareConfigured = () => !!(process.env.SQUARE_APP_ID && process.env.SQUARE_APP_SECRET)
const isSandbox = () => String(process.env.SQUARE_ENV || 'production').toLowerCase() === 'sandbox'
const apiBase = () => isSandbox() ? 'https://connect.squareupsandbox.com' : 'https://connect.squareup.com'

const STATE_SECRET = () => process.env.OAUTH_STATE_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || 'dev-secret'
export function signState(dealershipId) {
  const payload = `${dealershipId}|square|${Date.now()}`
  const sig = crypto.createHmac('sha256', STATE_SECRET()).update(payload).digest('hex').slice(0, 32)
  return Buffer.from(`${payload}|${sig}`).toString('base64url')
}
export function verifyState(state, maxAgeMs = 15 * 60 * 1000) {
  try {
    const [dealershipId, prov, ts, sig] = Buffer.from(String(state), 'base64url').toString('utf8').split('|')
    if (!dealershipId || prov !== 'square' || !ts || !sig) return null
    const expect = crypto.createHmac('sha256', STATE_SECRET()).update(`${dealershipId}|square|${ts}`).digest('hex').slice(0, 32)
    if (sig.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null
    if (Date.now() - Number(ts) > maxAgeMs) return null
    return dealershipId
  } catch { return null }
}

export function squareAuthorizeUrl(state) {
  const scope = ['MERCHANT_PROFILE_READ', 'PAYMENTS_READ', 'PAYMENTS_WRITE', 'ORDERS_READ', 'ORDERS_WRITE'].join('+')
  const base = isSandbox() ? 'https://connect.squareupsandbox.com' : 'https://connect.squareup.com'
  return `${base}/oauth2/authorize?client_id=${encodeURIComponent(process.env.SQUARE_APP_ID)}` +
    `&scope=${scope}&session=false&state=${encodeURIComponent(state)}`
}

async function tokenRequest(body) {
  const r = await fetch(`${apiBase()}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Square-Version': SQUARE_VERSION },
    body: JSON.stringify({ client_id: process.env.SQUARE_APP_ID, client_secret: process.env.SQUARE_APP_SECRET, ...body }),
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(j.errors?.[0]?.detail || j.message || 'Square token request failed')
  return j
}
export const squareExchangeCode = (code) => tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: `${BACKEND_URL}/square/callback` })
export const squareRefresh = (refresh_token) => tokenRequest({ grant_type: 'refresh_token', refresh_token })

// The dealer's main (active) Square location — needed to attach the order/payment.
async function fetchLocationId(accessToken) {
  const r = await fetch(`${apiBase()}/v2/locations`, {
    headers: { Authorization: `Bearer ${accessToken}`, 'Square-Version': SQUARE_VERSION },
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(j.errors?.[0]?.detail || 'Could not read Square locations')
  const locs = j.locations || []
  const active = locs.find(l => l.status === 'ACTIVE') || locs[0]
  return active ? { id: active.id, currency: active.currency || 'USD', name: active.name } : null
}

// Persist a fresh OAuth grant (called from the callback). Stores the location up front.
export async function squareStoreGrant(dealershipId, grant) {
  const loc = await fetchLocationId(grant.access_token)
  await supabaseAdmin.from('dealer_integrations').upsert({
    dealership_id: dealershipId, provider: PROVIDER, enabled: true, status: 'connected',
    credentials_enc: encryptJson({ access_token: grant.access_token, refresh_token: grant.refresh_token, expires_at: grant.expires_at }),
    lender_code_map: { merchant_id: grant.merchant_id || null, location_id: loc?.id || null, currency: (loc?.currency || 'USD').toLowerCase(), location_name: loc?.name || null, connected_at: new Date().toISOString() },
    last_status_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  }, { onConflict: 'dealership_id,provider' })
  return loc
}

async function getRow(dealershipId) {
  const { data } = await supabaseAdmin.from('dealer_integrations')
    .select('enabled, status, lender_code_map, credentials_enc').eq('dealership_id', dealershipId).eq('provider', PROVIDER).maybeSingle()
  return data || null
}

// A valid access token for this dealer, refreshing + persisting if it's near expiry.
export async function squareEnsureToken(dealershipId) {
  const row = await getRow(dealershipId)
  if (!row?.credentials_enc) return null
  const creds = decryptJson(row.credentials_enc) || {}
  if (!creds.access_token) return null
  const soon = Date.now() + 5 * 60 * 1000
  if (creds.expires_at && new Date(creds.expires_at).getTime() < soon && creds.refresh_token) {
    try {
      const g = await squareRefresh(creds.refresh_token)
      const next = { access_token: g.access_token, refresh_token: g.refresh_token || creds.refresh_token, expires_at: g.expires_at }
      await supabaseAdmin.from('dealer_integrations').update({ credentials_enc: encryptJson(next), updated_at: new Date().toISOString() })
        .eq('dealership_id', dealershipId).eq('provider', PROVIDER)
      return { token: next.access_token, map: row.lender_code_map || {} }
    } catch { /* fall through to the existing token */ }
  }
  return { token: creds.access_token, map: row.lender_code_map || {} }
}

export async function squareStatus(dealershipId) {
  const row = await getRow(dealershipId)
  const m = row?.lender_code_map || {}
  const ready = !!(row?.enabled && row?.credentials_enc && m.location_id)
  return { connected: !!row?.credentials_enc, enabled: !!row?.enabled, ready, location_name: m.location_name || null, currency: m.currency || 'usd' }
}

export async function squareDisconnect(dealershipId) {
  await supabaseAdmin.from('dealer_integrations').update({ enabled: false, status: 'disconnected', credentials_enc: null, updated_at: new Date().toISOString() })
    .eq('dealership_id', dealershipId).eq('provider', PROVIDER)
}

// Create a hosted Square payment link for a deposit. `reference` (e.g. dep_<contactId>)
// rides on the order so the webhook can match the completed payment back to the contact.
export async function squareCreateDepositLink({ dealershipId, amount, description, buyerEmail, reference, redirectUrl }) {
  const t = await squareEnsureToken(dealershipId)
  if (!t || !t.map.location_id) throw new Error('Square isn’t connected for this dealership.')
  const currency = (t.map.currency || 'usd').toUpperCase()
  const body = {
    idempotency_key: crypto.randomUUID(),
    order: {
      location_id: t.map.location_id,
      reference_id: String(reference || '').slice(0, 40) || undefined,
      line_items: [{ name: String(description || 'Vehicle deposit').slice(0, 500), quantity: '1', base_price_money: { amount: Math.round(amount * 100), currency } }],
    },
    checkout_options: redirectUrl ? { redirect_url: redirectUrl } : undefined,
    pre_populated_data: buyerEmail ? { buyer_email: buyerEmail } : undefined,
  }
  const r = await fetch(`${apiBase()}/v2/online-checkout/payment-links`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${t.token}`, 'Content-Type': 'application/json', 'Square-Version': SQUARE_VERSION },
    body: JSON.stringify(body),
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(j.errors?.[0]?.detail || 'Square could not create the payment link.')
  return { url: j.payment_link?.url, orderId: j.payment_link?.order_id, currency: currency.toLowerCase() }
}

// Retrieve an order (for the webhook) to read its reference_id back.
export async function squareGetOrderReference(dealershipId, orderId) {
  const t = await squareEnsureToken(dealershipId)
  if (!t) return null
  const r = await fetch(`${apiBase()}/v2/orders/${encodeURIComponent(orderId)}`, {
    headers: { Authorization: `Bearer ${t.token}`, 'Square-Version': SQUARE_VERSION },
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) return null
  return { reference_id: j.order?.reference_id || null, total: j.order?.total_money?.amount ?? null, currency: j.order?.total_money?.currency || null }
}

// Verify a Square webhook signature: HMAC-SHA256(signatureKey, notificationUrl + rawBody), base64.
export function verifySquareWebhook(rawBody, signature, notificationUrl) {
  const key = process.env.SQUARE_WEBHOOK_SIGNATURE_KEY
  if (!key || !signature) return false
  const hmac = crypto.createHmac('sha256', key).update(notificationUrl + rawBody).digest('base64')
  try { return crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(String(signature))) } catch { return false }
}
