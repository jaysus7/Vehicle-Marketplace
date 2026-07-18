/**
 * Generic OAuth2 connector engine for the Integrations Hub.
 *
 * QuickBooks has its own file (providers/quickbooks.js) for realm-specific API calls;
 * this module drives every other OAuth2 integration (Xero, Google Business) through one
 * registry so adding a connector is just a config block. Each stays inert until MarketSync
 * provisions that provider's app and sets its client id/secret env vars — the same
 * "ops secret" pattern as PII_ENCRYPTION_KEY, not app logic.
 *
 *   Xero:            XERO_CLIENT_ID,   XERO_CLIENT_SECRET
 *   Google Business: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET
 *
 * Redirect URI to register with each provider:  {BACKEND_URL}/integrations/{provider}/callback
 *
 * Per-dealer tokens live encrypted in dealer_integrations.credentials_enc; any tenant/
 * company id the provider needs goes in lender_code_map. Access tokens are refreshed on demand.
 */
import crypto from 'node:crypto'
import { BACKEND_URL } from '../shared.js'

const STATE_SECRET = () => process.env.OAUTH_STATE_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || 'dev-secret'

// Signed state so the JWT-less OAuth callback can be trusted to carry the dealership +
// provider it was started for, and can't be forged or replayed after 15 minutes.
export function signState(dealershipId, provider) {
  const payload = `${dealershipId}|${provider}|${Date.now()}`
  const sig = crypto.createHmac('sha256', STATE_SECRET()).update(payload).digest('hex').slice(0, 32)
  return Buffer.from(`${payload}|${sig}`).toString('base64url')
}
export function verifyState(state, provider, maxAgeMs = 15 * 60 * 1000) {
  try {
    const [dealershipId, prov, ts, sig] = Buffer.from(String(state), 'base64url').toString('utf8').split('|')
    if (!dealershipId || !prov || !ts || !sig) return null
    if (provider && prov !== provider) return null
    const expect = crypto.createHmac('sha256', STATE_SECRET()).update(`${dealershipId}|${prov}|${ts}`).digest('hex').slice(0, 32)
    if (sig.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null
    if (Date.now() - Number(ts) > maxAgeMs) return null
    return dealershipId
  } catch { return null }
}

const REG = {
  xero: {
    label: 'Xero',
    tokenAuth: 'basic',
    authUrl: 'https://login.xero.com/identity/connect/authorize',
    tokenUrl: 'https://identity.xero.com/connect/token',
    scope: 'openid profile email accounting.transactions accounting.contacts offline_access',
    clientId: () => process.env.XERO_CLIENT_ID,
    clientSecret: () => process.env.XERO_CLIENT_SECRET,
    authExtra: {},
    // Xero returns the connected organisation(s) from a separate call after the token.
    afterToken: async (creds) => {
      try {
        const r = await fetch('https://api.xero.com/connections', {
          headers: { Authorization: `Bearer ${creds.access_token}`, Accept: 'application/json' },
          signal: AbortSignal.timeout(12000),
        })
        const arr = await r.json().catch(() => [])
        const t = Array.isArray(arr) && arr[0] ? arr[0] : null
        return t ? { tenant_id: t.tenantId, tenant_name: t.tenantName } : {}
      } catch { return {} }
    },
    test: async (_creds, cfg) => (cfg?.tenant_name ? `Linked to ${cfg.tenant_name}` : 'Connected to Xero'),
  },
  google_business: {
    label: 'Google Business Profile',
    tokenAuth: 'body',
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scope: 'https://www.googleapis.com/auth/business.manage',
    clientId: () => process.env.GOOGLE_CLIENT_ID,
    clientSecret: () => process.env.GOOGLE_CLIENT_SECRET,
    authExtra: { access_type: 'offline', prompt: 'consent' },   // needed for a refresh_token
    afterToken: async () => ({}),
    test: async (creds) => {
      const r = await fetch('https://mybusinessaccountmanagement.googleapis.com/v1/accounts', {
        headers: { Authorization: `Bearer ${creds.access_token}` }, signal: AbortSignal.timeout(12000),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(j?.error?.message || 'Google check failed — try reconnecting.')
      const acct = (j.accounts || [])[0]
      return acct ? `Connected: ${acct.accountName || acct.name}` : 'Connected to Google'
    },
  },
}

export const OAUTH_PROVIDERS = Object.keys(REG)
export function oauthProvider(p) { return REG[p] || null }
export function oauthConfigured(p) { const c = REG[p]; return !!(c && c.clientId() && c.clientSecret()) }
export function oauthRedirectUri(p) { return `${BACKEND_URL.replace(/\/$/, '')}/integrations/${p}/callback` }

export function oauthAuthorizeUrl(p, state) {
  const c = REG[p]
  const params = new URLSearchParams({
    client_id: c.clientId(), response_type: 'code', scope: c.scope,
    redirect_uri: oauthRedirectUri(p), state, ...c.authExtra,
  })
  return `${c.authUrl}?${params.toString()}`
}

async function tokenReq(c, params) {
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }
  const body = { ...params }
  if (c.tokenAuth === 'basic') headers.Authorization = 'Basic ' + Buffer.from(`${c.clientId()}:${c.clientSecret()}`).toString('base64')
  else { body.client_id = c.clientId(); body.client_secret = c.clientSecret() }
  const r = await fetch(c.tokenUrl, { method: 'POST', headers, body: new URLSearchParams(body), signal: AbortSignal.timeout(12000) })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(j.error_description || j.error || `Token error ${r.status}`)
  return j
}

export async function oauthExchangeCode(p, code) {
  const j = await tokenReq(REG[p], { grant_type: 'authorization_code', code, redirect_uri: oauthRedirectUri(p) })
  return { access_token: j.access_token, refresh_token: j.refresh_token, expires_at: Date.now() + (Number(j.expires_in || 1800) - 60) * 1000 }
}
export async function oauthRefresh(p, refreshToken) {
  const j = await tokenReq(REG[p], { grant_type: 'refresh_token', refresh_token: refreshToken })
  return { access_token: j.access_token, refresh_token: j.refresh_token || refreshToken, expires_at: Date.now() + (Number(j.expires_in || 1800) - 60) * 1000 }
}
export async function oauthEnsureToken(p, creds) {
  if (!creds?.access_token) throw new Error('Not connected.')
  if (creds.expires_at && Date.now() < creds.expires_at) return { creds, refreshed: false }
  if (!creds.refresh_token) throw new Error('Session expired — reconnect.')
  return { creds: await oauthRefresh(p, creds.refresh_token), refreshed: true }
}
export async function oauthAfterToken(p, creds) { const c = REG[p]; return c.afterToken ? c.afterToken(creds) : {} }
export async function oauthTest(p, creds, cfg) { const c = REG[p]; return c.test ? c.test(creds, cfg) : 'Connected' }

// Book a sold/delivered deal as a Xero ACCREC invoice. Returns the InvoiceID.
// AccountCode 200 is Xero's default "Sales" revenue account.
export async function xeroCreateInvoice({ customerName, amount, memo }, { accessToken, tenantId }) {
  if (!tenantId) throw new Error('Xero organisation not linked — reconnect.')
  if (!(Number(amount) > 0)) throw new Error('Deal total must be greater than zero to sync.')
  const r = await fetch('https://api.xero.com/api.xro/2.0/Invoices', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Xero-tenant-id': tenantId, Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      Type: 'ACCREC',
      Contact: { Name: String(customerName || 'Customer').slice(0, 255) },
      LineItems: [{ Description: (memo || 'Vehicle sale').slice(0, 4000), Quantity: 1, UnitAmount: Math.round(Number(amount) * 100) / 100, AccountCode: '200' }],
      Status: 'AUTHORISED',
    }),
    signal: AbortSignal.timeout(15000),
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(j?.Elements?.[0]?.ValidationErrors?.[0]?.Message || j?.Message || `Xero API error ${r.status}`)
  return j?.Invoices?.[0]?.InvoiceID || null
}
