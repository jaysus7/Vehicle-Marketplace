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

  // Send a real test SMS through the dealer's connected Twilio account.
  app.post('/integrations/twilio/test', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership' })
    if (!isMgr(req)) return res.status(403).json({ error: 'Manager access required' })
    const to = String(req.body?.to || '').trim()
    if (!/^\+?[0-9][0-9\s()-]{8,}$/.test(to)) return res.status(400).json({ error: 'Enter a valid phone number to text.' })
    invalidateTwilioCache(req.dealershipId)   // pick up a just-saved config
    const r = await sendDealerSms(req.dealershipId, to, 'MarketSync test ✓ — your Twilio number is connected and ready to send.')
    if (r.simulated) return res.status(400).json({ error: 'Save and enable your Twilio SID, token, and from-number first.' })
    if (!r.ok) return res.status(400).json({ error: r.error || 'Twilio rejected the message — double-check the SID, token, and from-number.' })
    res.json({ ok: true })
  })

  // ── QuickBooks Online (Intuit OAuth2) ───────────────────────────────────────
  // Start the connect flow: returns the Intuit authorize URL for the dealer to open.
  app.get('/integrations/quickbooks/connect', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership' })
    if (!isMgr(req)) return res.status(403).json({ error: 'Manager access required' })
    if (!qboConfigured()) return res.status(503).json({ error: 'QuickBooks isn’t enabled on this MarketSync account yet.' })
    if (!piiConfigured()) return res.status(400).json({ error: 'Set PII_ENCRYPTION_KEY before connecting QuickBooks.' })
    res.json({ url: qboAuthorizeUrl(signState(req.dealershipId)) })
  })

  // Intuit redirects the browser back here (no JWT) — the signed `state` proves which
  // dealership started the flow. Exchange the code, store tokens, bounce to the app.
  app.get('/integrations/quickbooks/callback', async (req, res) => {
    const backTo = (ok, msg) => res.redirect(`${FRONTEND_URL}/dashboard.html?integration=quickbooks&status=${ok ? 'connected' : 'error'}${msg ? '&msg=' + encodeURIComponent(msg) : ''}`)
    try {
      const { code, state, realmId } = req.query
      const dealershipId = verifyState(state)
      if (!dealershipId || !code || !realmId) return backTo(false, 'Link expired — try connecting again.')
      const creds = await qboExchangeCode(String(code))
      await supabaseAdmin.from('dealer_integrations').upsert({
        dealership_id: dealershipId, provider: 'quickbooks',
        enabled: true, status: 'connected',
        credentials_enc: encryptJson(creds),
        lender_code_map: { realm_id: String(realmId), connected_at: new Date().toISOString() },
        last_status_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      }, { onConflict: 'dealership_id,provider' })
      backTo(true)
    } catch (e) {
      console.error('[quickbooks] callback failed:', e.message)
      backTo(false, e.message)
    }
  })

  // Verify the connection by naming the linked QuickBooks company. Refreshes + persists
  // a rotated token when the access token has expired.
  app.post('/integrations/quickbooks/test', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership' })
    if (!isMgr(req)) return res.status(403).json({ error: 'Manager access required' })
    const { data: row } = await supabaseAdmin.from('dealer_integrations')
      .select('credentials_enc, lender_code_map').eq('dealership_id', req.dealershipId).eq('provider', 'quickbooks').maybeSingle()
    if (!row?.credentials_enc || !row.lender_code_map?.realm_id) return res.status(400).json({ error: 'Connect QuickBooks first.' })
    try {
      let creds = decryptJson(row.credentials_enc)
      const ensured = await qboEnsureToken(creds)
      if (ensured.refreshed) {
        creds = ensured.creds
        await supabaseAdmin.from('dealer_integrations').update({ credentials_enc: encryptJson(creds), updated_at: new Date().toISOString() })
          .eq('dealership_id', req.dealershipId).eq('provider', 'quickbooks')
      }
      const name = await qboCompanyName({ accessToken: creds.access_token, realmId: row.lender_code_map.realm_id })
      res.json({ ok: true, company: name || 'your QuickBooks company' })
    } catch (e) {
      res.status(400).json({ error: e.message || 'QuickBooks check failed — try reconnecting.' })
    }
  })

  // Toggle "auto-post income on delivery" for a connected accounting provider.
  // Merges into lender_code_map so the stored tokens/tenant are preserved.
  app.put('/integrations/:provider/autosync', requireAuth, async (req, res) => {
    const provider = String(req.params.provider || '')
    if (!['quickbooks', 'xero'].includes(provider)) return res.status(400).json({ error: 'Not an accounting provider' })
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership' })
    if (!isMgr(req)) return res.status(403).json({ error: 'Manager access required' })
    const { data: row } = await supabaseAdmin.from('dealer_integrations')
      .select('lender_code_map, credentials_enc').eq('dealership_id', req.dealershipId).eq('provider', provider).maybeSingle()
    if (!row?.credentials_enc) return res.status(400).json({ error: 'Connect it first.' })
    const map = { ...(row.lender_code_map || {}), autosync: !!req.body?.autosync }
    const { error } = await supabaseAdmin.from('dealer_integrations')
      .update({ lender_code_map: map, updated_at: new Date().toISOString() })
      .eq('dealership_id', req.dealershipId).eq('provider', provider)
    if (error) return res.status(500).json({ error: 'Save failed' })
    res.json({ ok: true, autosync: map.autosync })
  })

  // ── Generic OAuth2 connectors (Xero, Google Business) ───────────────────────
  // Same flow as QuickBooks, driven by the provider registry in providers/oauth.js.
  // Registered after the QuickBooks-specific routes so those win for `quickbooks`.
  app.get('/integrations/:provider/connect', requireAuth, async (req, res) => {
    const provider = String(req.params.provider || '')
    if (!OAUTH_PROVIDERS.includes(provider)) return res.status(404).json({ error: 'Unknown provider' })
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership' })
    if (!isMgr(req)) return res.status(403).json({ error: 'Manager access required' })
    if (!oauthConfigured(provider)) return res.status(503).json({ error: `${CATALOG[provider]?.label || provider} isn’t enabled on this MarketSync account yet.` })
    if (!piiConfigured()) return res.status(400).json({ error: 'Set PII_ENCRYPTION_KEY before connecting.' })
    res.json({ url: oauthAuthorizeUrl(provider, signOAuthState(req.dealershipId, provider)) })
  })

  app.get('/integrations/:provider/callback', async (req, res) => {
    const provider = String(req.params.provider || '')
    const backTo = (ok, msg) => res.redirect(`${FRONTEND_URL}/dashboard.html?integration=${provider}&status=${ok ? 'connected' : 'error'}${msg ? '&msg=' + encodeURIComponent(msg) : ''}`)
    if (!OAUTH_PROVIDERS.includes(provider)) return backTo(false, 'Unknown provider')
    try {
      const { code, state } = req.query
      const dealershipId = verifyOAuthState(state, provider)
      if (!dealershipId || !code) return backTo(false, 'Link expired — try connecting again.')
      const creds = await oauthExchangeCode(provider, String(code))
      const tenant = await oauthAfterToken(provider, creds)
      await supabaseAdmin.from('dealer_integrations').upsert({
        dealership_id: dealershipId, provider, enabled: true, status: 'connected',
        credentials_enc: encryptJson(creds),
        lender_code_map: { ...(tenant || {}), connected_at: new Date().toISOString() },
        last_status_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      }, { onConflict: 'dealership_id,provider' })
      backTo(true)
    } catch (e) {
      console.error(`[${provider}] callback failed:`, e.message)
      backTo(false, e.message)
    }
  })

  app.post('/integrations/:provider/test', requireAuth, async (req, res) => {
    const provider = String(req.params.provider || '')
    if (!OAUTH_PROVIDERS.includes(provider)) return res.status(404).json({ error: 'Unknown provider' })
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership' })
    if (!isMgr(req)) return res.status(403).json({ error: 'Manager access required' })
    const { data: row } = await supabaseAdmin.from('dealer_integrations')
      .select('credentials_enc, lender_code_map').eq('dealership_id', req.dealershipId).eq('provider', provider).maybeSingle()
    if (!row?.credentials_enc) return res.status(400).json({ error: 'Connect it first.' })
    try {
      let creds = decryptJson(row.credentials_enc)
      const ensured = await oauthEnsureToken(provider, creds)
      if (ensured.refreshed) {
        creds = ensured.creds
        await supabaseAdmin.from('dealer_integrations').update({ credentials_enc: encryptJson(creds), updated_at: new Date().toISOString() })
          .eq('dealership_id', req.dealershipId).eq('provider', provider)
      }
      const msg = await oauthTest(provider, creds, row.lender_code_map || {})
      res.json({ ok: true, company: msg })
    } catch (e) {
      res.status(400).json({ error: e.message || 'Connection check failed — try reconnecting.' })
    }
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
