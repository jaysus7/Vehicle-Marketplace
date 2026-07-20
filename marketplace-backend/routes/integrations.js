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
import { OAUTH_PROVIDERS, oauthConfigured, oauthAuthorizeUrl, oauthExchangeCode, oauthEnsureToken, oauthAfterToken, oauthTest, gbpCreatePost, signState as signOAuthState, verifyState as verifyOAuthState } from '../providers/oauth.js'
import { stripeDepositsConfigured } from './deposits.js'
import { squareConfigured } from '../providers/square.js'
import Anthropic from '@anthropic-ai/sdk'
import { aiAllowed, recordUsage } from '../usage.js'

const OWNER_EMAIL = (process.env.OWNER_EMAIL || 'massiejay@gmail.com').toLowerCase()

/**
 * The Integrations Hub catalog. Each entry is a connectable service. `live: true`
 * means it works today (webhooks are our own outbound "glue" — no partner needed);
 * `live: false` are the gated F&I / history rails whose credential store + provider
 * abstraction exist but that flip on only once we're DSP-certified with the partner.
 */
// `manual: true` + `fields` describe a credential form the dealer can fill in now:
// creds are stored encrypted and used in manual/export mode today (deep-link + upload),
// then flip to a native pull the moment we're DSP-certified with that partner — no
// re-entry needed. Each field: { key, label, placeholder, secret }. Secret fields are
// encrypted into credentials_enc; non-secret ones are kept in lender_code_map (so the
// UI can show "connected as dealer #123" without ever exposing the secret).
const CATALOG = {
  webhook:         { category: 'Automation',  label: 'Webhooks / Zapier',    live: true,  desc: 'Send MarketSync events (new lead, deal sold, delivered) to any URL — Zapier, Make, a spreadsheet, your own app.' },
  carfax:          { category: 'F&I',         label: 'CARFAX Canada',        live: false, manual: true, desc: 'Vehicle history reports, liens and valuations. Stage your credentials now; native in-deal pull activates once certified.',
    fields: [
      { key: 'account_number', label: 'Account / Dealer #', placeholder: 'e.g. 100xxxxx', secret: false },
      { key: 'api_key',        label: 'API key / password', placeholder: 'Your CARFAX API key', secret: true },
    ] },
  routeone:        { category: 'F&I',         label: 'RouteOne',             live: false, manual: true, desc: 'Submit credit applications to lenders and pull decisions. Stage your credentials now; live submit activates once certified.',
    fields: [
      { key: 'dealer_id', label: 'RouteOne Dealer ID', placeholder: 'e.g. RO-123456', secret: false },
      { key: 'username',  label: 'Username',            placeholder: 'RouteOne username', secret: false },
      { key: 'password',  label: 'Password',            placeholder: 'RouteOne password', secret: true },
    ] },
  dealertrack:     { category: 'F&I',         label: 'Dealertrack',          live: false, manual: true, desc: 'Dealertrack DealTransfer credit submission. Stage your credentials now; live submit activates once certified.',
    fields: [
      { key: 'dealer_id',  label: 'Dealertrack Dealer ID',  placeholder: 'e.g. 5-digit dealer #', secret: false },
      { key: 'partner_id', label: 'Partner / Integration ID', placeholder: 'Assigned by Dealertrack', secret: false },
      { key: 'password',   label: 'Password / API secret',  placeholder: 'Dealertrack secret', secret: true },
    ] },
  quickbooks:      { category: 'Accounting',  label: 'QuickBooks Online',    live: false, oauth: true, desc: 'Connect your QuickBooks Online company to sync sold-deal and F&I income.' },
  xero:            { category: 'Accounting',  label: 'Xero',                 live: false, oauth: true, desc: 'Connect your Xero organisation to sync sold-deal and F&I income.' },
  google_business: { category: 'Marketing',   label: 'Google Business',      live: false, oauth: true, desc: 'Let AI write Google Business posts for new arrivals, specials and updates — post them today, one-click auto-publish once Google approves access.' },
  twilio:          { category: 'Messaging',   label: 'Twilio SMS',           live: true,  desc: 'Bring your own Twilio account so automated texts send from your own A2P-registered number.' },
  stripe_deposits: { category: 'Payments',    label: 'Online Deposits (Stripe)', deposits: true, desc: 'Take a real, refundable "reserve this vehicle" deposit on your website — paid straight into your own Stripe account.' },
  square_deposits: { category: 'Payments',    label: 'Deposits (Square)',    square: true, oauth: true, desc: 'Run on Square? Take the same refundable deposit — on your website and inside a deal — paid straight into your own Square account.' },
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
        : meta.square ? squareConfigured()
        : OAUTH_PROVIDERS.includes(p) ? oauthConfigured(p)
        : meta.deposits ? stripeDepositsConfigured()
        : !!meta.live
      return {
        provider: p,
        label: meta.label || p,
        category: meta.category || 'Other',
        description: meta.desc || '',
        live,
        oauth: !!meta.oauth,
        deposits: !!meta.deposits,                    // Stripe Connect card (own connect/config endpoints)
        manual: !!meta.manual,                        // connectable now via a credentials form (manual/export mode)
        fields: Array.isArray(meta.fields) ? meta.fields : null,
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

  // ── Google Business Profile posts ───────────────────────────────────────────
  // AI-write a Google Business post (new arrival / offer / update), optionally about
  // a specific vehicle. Gated to AI Boost, same as the other AI writers.
  app.post('/integrations/google_business/compose', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership' })
    if (!isMgr(req)) return res.status(403).json({ error: 'Manager access required' })
    const isOwner = (req.user.email || '').toLowerCase() === OWNER_EMAIL
    const { data: dealer } = await supabaseAdmin.from('dealerships')
      .select('name, ai_tone, ai_boost_active, city, province').eq('id', req.dealershipId).maybeSingle()
    if (!isOwner && !dealer?.ai_boost_active) return res.status(403).json({ error: 'AI Boost not active' })
    if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ error: 'AI is not configured on this account.' })
    if (!(await aiAllowed(req.dealershipId, isOwner))) return res.status(429).json({ error: 'Monthly AI limit reached — resets next month.' })

    const b = req.body || {}
    const kind = ['new_arrival', 'special', 'update'].includes(b.kind) ? b.kind : 'update'
    let vehLine = ''
    if (b.inventory_id) {
      const { data: v } = await supabaseAdmin.from('inventory')
        .select('year, make, model, trim, price, mileage, exterior_color, body_style, fuel_type')
        .eq('dealership_id', req.dealershipId).eq('id', b.inventory_id).maybeSingle()
      if (v) {
        const bits = [[v.year, v.make, v.model, v.trim].filter(Boolean).join(' ')]
        if (v.exterior_color) bits.push(v.exterior_color)
        if (v.mileage) bits.push(`${Number(v.mileage).toLocaleString()} km`)
        if (v.price) bits.push(`$${Number(v.price).toLocaleString()}`)
        vehLine = `The post is about this vehicle: ${bits.filter(Boolean).join(', ')}.`
      }
    }
    const loc = [dealer?.city, dealer?.province].filter(Boolean).join(', ')
    const tone = dealer?.ai_tone === 'friendly' ? 'warm and welcoming' : dealer?.ai_tone === 'aggressive' ? 'energetic and deal-focused' : 'confident and professional'
    const kindHint = {
      new_arrival: 'announce a fresh arrival on the lot and invite a test drive',
      special: 'promote a limited-time offer or price on inventory and create urgency',
      update: 'share a friendly dealership update that keeps the profile active and encourages a visit',
    }[kind]
    const prompt = `You are writing a Google Business Profile post for ${dealer?.name || 'a car dealership'}${loc ? ' in ' + loc : ''}. Tone: ${tone}.
Write a single Google Business post that will ${kindHint}. ${vehLine}
Rules: 1 short paragraph, roughly 30–80 words, plain text only (no markdown, no hashtags-spam — at most one relevant emoji), end with a light call to action. Do NOT invent prices, financing terms, or specs that were not given. Output only the post text.`
    try {
      const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
      const msg = await Promise.race([
        anthropic.messages.create({ model: 'claude-haiku-4-5-20251001', max_tokens: 300, temperature: 1, messages: [{ role: 'user', content: prompt }] }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 20000)),
      ])
      const textOut = (msg.content?.[0]?.text || '').trim()
      if (!textOut) return res.status(502).json({ error: 'AI returned nothing — try again.' })
      recordUsage(req.dealershipId, { ai: 1 })
      res.json({ ok: true, text: textOut })
    } catch (e) {
      res.status(502).json({ error: e.message === 'timeout' ? 'AI timed out — try again.' : 'AI is temporarily unavailable — try again.' })
    }
  })

  // Publish a Google Business post. Attempts the Business Profile API with the
  // dealer's connected token; when Google hasn't approved the API for our project
  // yet it returns { staged:true } so the UI can fall back to assisted posting
  // (copy the text, open Google Business). No change needed here once approved.
  app.post('/integrations/google_business/post', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership' })
    if (!isMgr(req)) return res.status(403).json({ error: 'Manager access required' })
    const text = String(req.body?.text || '').trim()
    if (!text) return res.status(400).json({ error: 'Write the post text first.' })
    const { data: row } = await supabaseAdmin.from('dealer_integrations')
      .select('credentials_enc').eq('dealership_id', req.dealershipId).eq('provider', 'google_business').maybeSingle()
    if (!row?.credentials_enc) return res.json({ staged: true, reason: 'Connect Google Business first, then MarketSync can publish for you.' })
    try {
      let creds = decryptJson(row.credentials_enc)
      const ensured = await oauthEnsureToken('google_business', creds)
      if (ensured.refreshed) {
        creds = ensured.creds
        await supabaseAdmin.from('dealer_integrations').update({ credentials_enc: encryptJson(creds), updated_at: new Date().toISOString() })
          .eq('dealership_id', req.dealershipId).eq('provider', 'google_business')
      }
      const cta = req.body?.cta_url ? { cta: 'LEARN_MORE', ctaUrl: String(req.body.cta_url).slice(0, 300) } : {}
      const result = await gbpCreatePost(creds, { summary: text, mediaUrl: req.body?.media_url || null, ...cta })
      res.json(result)
    } catch (e) {
      res.json({ staged: true, reason: e.message || 'Could not reach Google Business — copy the post and add it manually for now.' })
    }
  })
}
