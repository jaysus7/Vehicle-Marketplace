/**
 * Per-dealer credentials for the gated F&I / history networks (Carfax, RouteOne,
 * Dealertrack). Secrets are encrypted at rest (crypto-pii) and NEVER returned to the
 * client — the UI only learns whether a provider is configured/enabled and its status.
 */
import { supabaseAdmin } from '../shared.js'
import { requireAuth } from '../middleware.js'
import { encryptJson, piiConfigured } from '../crypto-pii.js'
import { emitWebhook, WEBHOOK_EVENTS } from '../webhooks.js'

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
  quickbooks:      { category: 'Accounting',  label: 'QuickBooks Online',    live: false, desc: 'Push sold-deal and F&I income to QuickBooks. Coming soon.' },
  xero:            { category: 'Accounting',  label: 'Xero',                 live: false, desc: 'Push sold-deal and F&I income to Xero. Coming soon.' },
  google_business: { category: 'Marketing',   label: 'Google Business',      live: false, desc: 'Auto-post inventory and request reviews on your Google Business Profile. Coming soon.' },
  twilio:          { category: 'Messaging',   label: 'Twilio SMS',           live: false, desc: 'Bring your own Twilio number for outbound texts. Coming soon.' },
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
      return {
        provider: p,
        label: meta.label || p,
        category: meta.category || 'Other',
        description: meta.desc || '',
        live: !!meta.live,
        enabled: !!r?.enabled,
        status: r?.status || 'not_connected',
        configured: !!r?.credentials_enc,             // has a stored secret (never the secret itself)
        lender_code_map: r?.lender_code_map || {},
        updated_at: r?.updated_at || null,
      }
    })
    res.json({ providers: list, webhook_events: WEBHOOK_EVENTS, pii_ready: piiConfigured() })
  })

  // Fire a test webhook so the dealer can confirm their endpoint is wired up.
  app.post('/integrations/webhook/test', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership' })
    if (!isMgr(req)) return res.status(403).json({ error: 'Manager access required' })
    const { data: row } = await supabaseAdmin.from('dealer_integrations')
      .select('enabled, lender_code_map')
      .eq('dealership_id', req.dealershipId).eq('provider', 'webhook').maybeSingle()
    const url = row?.lender_code_map?.url
    if (!row?.enabled || !url) return res.status(400).json({ error: 'Save and enable a webhook URL first.' })
    await emitWebhook(req.dealershipId, 'test.ping', { message: 'Hello from MarketSync', sent_by: req.user?.email || null })
    res.json({ ok: true, url })
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
    res.json({ ok: true })
  })

  // Disconnect: remove the stored config (and secret) for a provider.
  app.delete('/integrations/:provider', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership' })
    if (!isMgr(req)) return res.status(403).json({ error: 'Manager access required' })
    const provider = String(req.params.provider || '').toLowerCase()
    await supabaseAdmin.from('dealer_integrations').delete()
      .eq('dealership_id', req.dealershipId).eq('provider', provider)
    res.json({ ok: true })
  })
}
