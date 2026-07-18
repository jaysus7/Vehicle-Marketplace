/**
 * QuickBooks Online connector (Intuit OAuth2).
 *
 * This is the real Intuit OAuth2 authorization-code flow. It stays inert until
 * MarketSync provisions ONE Intuit app and sets its credentials as env vars —
 * exactly like PII_ENCRYPTION_KEY is an ops prerequisite, not app logic:
 *
 *   QBO_CLIENT_ID, QBO_CLIENT_SECRET   (from the Intuit developer portal)
 *   QBO_ENV = 'production' | 'sandbox'  (default 'production')
 *
 * The redirect URI to register with Intuit is:  {BACKEND_URL}/integrations/quickbooks/callback
 *
 * Per-dealer tokens are stored encrypted in dealer_integrations.credentials_enc
 * ({access_token, refresh_token, expires_at}); the QBO company/realm id lives in
 * lender_code_map ({realm_id}). Access tokens last ~1h and are refreshed on demand.
 */
import crypto from 'node:crypto'
import { BACKEND_URL } from '../shared.js'

const AUTH_URL = 'https://appcenter.intuit.com/connect/oauth2'
const TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer'
const SCOPE = 'com.intuit.quickbooks.accounting'

export function qboConfigured() {
  return !!(process.env.QBO_CLIENT_ID && process.env.QBO_CLIENT_SECRET)
}
export function qboRedirectUri() {
  return `${BACKEND_URL.replace(/\/$/, '')}/integrations/quickbooks/callback`
}
function apiBase() {
  return (process.env.QBO_ENV === 'sandbox')
    ? 'https://sandbox-quickbooks.api.intuit.com'
    : 'https://quickbooks.api.intuit.com'
}
function basicAuthHeader() {
  return 'Basic ' + Buffer.from(`${process.env.QBO_CLIENT_ID}:${process.env.QBO_CLIENT_SECRET}`).toString('base64')
}

// ── Signed state, so the OAuth callback (which arrives without our JWT) can be
// trusted to carry the dealership it was started for and can't be forged. ──────
const STATE_SECRET = () => process.env.OAUTH_STATE_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || 'dev-secret'
export function signState(dealershipId) {
  const payload = `${dealershipId}.${Date.now()}`
  const sig = crypto.createHmac('sha256', STATE_SECRET()).update(payload).digest('hex').slice(0, 32)
  return Buffer.from(`${payload}.${sig}`).toString('base64url')
}
export function verifyState(state, maxAgeMs = 15 * 60 * 1000) {
  try {
    const decoded = Buffer.from(String(state), 'base64url').toString('utf8')
    const [dealershipId, ts, sig] = decoded.split('.')
    if (!dealershipId || !ts || !sig) return null
    const expect = crypto.createHmac('sha256', STATE_SECRET()).update(`${dealershipId}.${ts}`).digest('hex').slice(0, 32)
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null
    if (Date.now() - Number(ts) > maxAgeMs) return null
    return dealershipId
  } catch { return null }
}

export function qboAuthorizeUrl(state) {
  const p = new URLSearchParams({
    client_id: process.env.QBO_CLIENT_ID,
    response_type: 'code',
    scope: SCOPE,
    redirect_uri: qboRedirectUri(),
    state,
  })
  return `${AUTH_URL}?${p.toString()}`
}

async function tokenRequest(params) {
  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { Authorization: basicAuthHeader(), 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(params),
    signal: AbortSignal.timeout(12000),
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(j.error_description || j.error || `Intuit token error ${r.status}`)
  return j
}

// Exchange the authorization code for tokens. Returns the storable creds blob.
export async function qboExchangeCode(code) {
  const j = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: qboRedirectUri() })
  return {
    access_token: j.access_token,
    refresh_token: j.refresh_token,
    expires_at: Date.now() + (Number(j.expires_in || 3600) - 60) * 1000,
  }
}

// Refresh an access token; returns a fresh creds blob (Intuit rotates the refresh token).
export async function qboRefresh(refreshToken) {
  const j = await tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken })
  return {
    access_token: j.access_token,
    refresh_token: j.refresh_token || refreshToken,
    expires_at: Date.now() + (Number(j.expires_in || 3600) - 60) * 1000,
  }
}

// Ensure a non-expired access token. Takes the stored creds, refreshes if needed,
// and returns { creds, refreshed } so the caller can persist a rotated token.
export async function qboEnsureToken(creds) {
  if (!creds?.access_token) throw new Error('Not connected to QuickBooks.')
  if (creds.expires_at && Date.now() < creds.expires_at) return { creds, refreshed: false }
  if (!creds.refresh_token) throw new Error('QuickBooks session expired — reconnect.')
  const fresh = await qboRefresh(creds.refresh_token)
  return { creds: fresh, refreshed: true }
}

// GET a QBO API resource for a company/realm.
export async function qboApiGet(path, { accessToken, realmId }) {
  const url = `${apiBase()}/v3/company/${realmId}/${path.replace(/^\//, '')}`
  const sep = url.includes('?') ? '&' : '?'
  const r = await fetch(`${url}${sep}minorversion=70`, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(12000),
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(j?.Fault?.Error?.[0]?.Message || `QuickBooks API error ${r.status}`)
  return j
}

// Convenience: the connected company's name (used by the "test connection" button).
export async function qboCompanyName({ accessToken, realmId }) {
  const j = await qboApiGet(`companyinfo/${realmId}`, { accessToken, realmId })
  return j?.CompanyInfo?.CompanyName || null
}
