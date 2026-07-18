/**
 * Per-dealer credentials for the gated F&I / history networks (Carfax, RouteOne,
 * Dealertrack). Secrets are encrypted at rest (crypto-pii) and NEVER returned to the
 * client — the UI only learns whether a provider is configured/enabled and its status.
 */
import { supabaseAdmin, FRONTEND_URL } from '../shared.js'
import { requireAuth } from '../middleware.js'
import { encryptJson, decryptJson, piiConfigured } from '../crypto-pii.js'
import { emitWebhook, WEBHOOK_EVENTS } from '../webhooks.js'
import { sendDealerSms, invalidateTwilioCache } from './automation.js'
import { qboConfigured, qboAuthorizeUrl, signState, verifyState, qboExchangeCode, qboEnsureToken, qboCompanyName } from '../providers/quickbooks.js'
import { OAUTH_PROVIDERS, oauthConfigured, oauthAuthorizeUrl, oauthExchangeCode, oauthEnsureToken, oauthAfterToken, oauthTest, signState as signOAuthState, verifyState as verifyOAuthState } from '../providers/oauth.js'

/**
 * The Integrations Hub catalog. Each entry is a connectable service. `live: true`
 * means it works today (webhooks are our own outbound "glue" — no partner needed);
 * `live: false` are the gated F&I / history rails whose credential store + provider
 * abstraction exist but that flip on only once we're DSP-certified with the partner.
 */
const CATALOG = {
  webhook:         { category: 'Automation',  label: 'Webhooks / Zapier',    live: true,  desc: 'Send MarketSync events (new lead, deal sold, delivered) to any URL — Zapier, Make, a spreadsheet, your own app.' },
  carfax:          { category: 'F&I',         label: 'CARFAX Canada',        live: false, desc: 'Vehicle history reports, liens and valuations pulled natively into the deal.' },
  routeone:        { category: 'F&I',         label: 'RouteOne',             live: false, desc: 'Submit credit applications to lenders and pull decisions.' },
  dealertrack:     { category: 'F&I',         label: 'Dealertrack',          live: false, desc: 'Dealertrack DealTransfer credit submission.' },
  quickbooks:      { category: 'Accounting',  label: 'QuickBooks Online',    live: false, oauth: true, desc: 'Connect your QuickBooks Online company to sync sold-deal and F&I income.' },
  xero:            { category: 'Accounting',  label: 'Xero',                 live: false, oauth: true, desc: 'Connect your Xero organisation to sync sold-deal and F&I income.' },
  google_business: { category: 'Marketing',   label: 'Google Business',      live: false, oauth: true, desc: 'Connect your Google Business Profile to post inventory and request reviews.' },
  twilio:          { category: 'Messaging',   label: 'Twilio SMS',           live: true,  desc: 'Bring your own Twilio account so automated texts send from your own A2P-registered number.' },
}
const PROVIDERS = Object.keys(CATALOG)
const isMgr = (req) => ['DEALER_ADMIN', 'OWNER', 'MANAGER'].includes(req.profile?.role)

export function registerIntegrations(app) {
  // List all providers with their (non-secret) status for this dealership.
  app.get('/integrations', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership' })
    if (!isMgr(req)) return res.status(403).json({ error: 'Manager access required' })
    const { data: rows } = await supabaseAdmin.from('dealer_integrations')
      .select('provider, enabled, status, lender_code_map, updated_at, credentials_enc')
      .eq('dealership_id', req.dealershipId)
    const byProvider = {}
    for (const r of (rows || [])) byProvider[r.provider] = r
    const list = PROVIDERS.map(p => {
      const r = byProvider[p]
      const meta = CATALOG[p] || {}
      // OAuth connectors flip live once their app credentials are provisioned.
      const live = p === 'quickbooks' ? qboConfigured()
        : OAUTH_PROVIDERS.includes(p) ? oauthConfigured(p)
        : !!meta.live
      return {
        provider: p,
        label: meta.label || p,
        category: meta.category || 'Other',
        description: meta.desc || '',
        live,
        oauth: !!meta.oauth,
        enabled: !!r?.enabled,
        status: r?.status || 'not_connected',
        configured: !!r?.credentials_enc,             // has a stored secret (never the secret itself)
        lender_code_map: r?.lender_code_map || {},
        updated_at: r?.updated_at || null,
      }
    })
    res.json({ providers: list, pii_ready: piiConfigured() })
  })

  // Create/update a provider's config. Only overwrites the secret when new
  // credentials are supplied, so toggling `enabled` doesn't wipe stored creds.
  app.put('/integrations/:provider', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership' })
    if (!isMgr(req)) return res.status(403).json({ error: 'Manager access required' })
    const provider = String(req.params.provider || '').toLowerCase()
    if (!PROVIDERS.includes(provider)) return res.status(400).json({ error: 'Unknown provider' })
    const b = req.body || {}

    const patch = { dealership_id: req.dealershipId, provider, updated_by: req.user?.id || null, updated_at: new Date().toISOString() }
    if (b.enabled !== undefined) patch.enabled = !!b.enabled
    if (b.status !== undefined && typeof b.status === 'string') patch.status = b.status.slice(0, 30)
    if (b.lender_code_map && typeof b.lender_code_map === 'object') patch.lender_code_map = b.lender_code_map

    // Encrypt a credential blob only if one was provided and non-empty.
    if (b.credentials && typeof b.credentials === 'object' && Object.keys(b.credentials).length) {
      if (!piiConfigured()) return res.status(400).json({ error: 'Set the PII_ENCRYPTION_KEY environment variable before storing credentials.' })
      patch.credentials_enc = encryptJson(b.credentials)
      if (patch.status === undefined) patch.status = 'configured'
      patch.last_status_at = new Date().toISOString()
    }

    const { error } = await supabaseAdmin.from('dealer_integrations')
      .upsert(patch, { onConflict: 'dealership_id,provider' })
    if (error) { console.error('[integrations] save failed:', error.message); return res.status(500).json({ error: 'Save failed' }) }
    if (provider === 'twilio') invalidateTwilioCache(req.dealershipId)
    res.json({ ok: true })
  })

  // Disconnect: remove the stored config (and secret) for a provider.
  app.delete('/integrations/:provider', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership' })
    if (!isMgr(req)) return res.status(403).json({ error: 'Manager access required' })
    const provider = String(req.params.provider || '').toLowerCase()
    await supabaseAdmin.from('dealer_integrations').delete()
      .eq('dealership_id', req.dealershipId).eq('provider', provider)
    if (provider === 'twilio') invalidateTwilioCache(req.dealershipId)
    res.json({ ok: true })
  })
}
