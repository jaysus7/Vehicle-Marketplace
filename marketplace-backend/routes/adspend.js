/**
 * Ad-spend connect/sync routes — Meta Ads + Google Ads → marketing_spend, so the
 * Marketing ROI report fills its spend column automatically.
 *
 *   GET  /adspend/status                 what's configured + connected (dealership)
 *   GET  /adspend/connect/:provider      -> { url } to start OAuth (admin)
 *   GET  /adspend/callback/:provider      OAuth redirect target (public)
 *   POST /adspend/disconnect/:provider    remove a connection (admin)
 *   POST /adspend/sync-now                pull spend for this store now (manager)
 *   POST /cron/adspend-pull               nightly sweep of all connections (CRON_SECRET)
 */
import { supabaseAdmin, FRONTEND_URL } from '../shared.js'
import { requireAuth } from '../middleware.js'
import { audit, AuditAction } from '../audit.js'
import {
  AD_PROVIDERS, adProviderConfigured, anyAdProviderConfigured, adAuthUrl,
  signState, verifyState, adExchangeAndStore, pullAdSpend,
} from '../adSpendSync.js'

const isMgr = (req) => ['DEALER_ADMIN', 'OWNER', 'MANAGER'].includes(req.profile?.role)
const isAdmin = (req) => ['DEALER_ADMIN', 'OWNER'].includes(req.profile?.role)
const label = (p) => (p === 'meta' ? 'Meta Ads' : p === 'google_ads' ? 'Google Ads' : p)

export function registerAdSpend(app) {
  app.get('/adspend/status', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership' })
    if (!isMgr(req)) return res.status(403).json({ error: 'Manager access required' })
    const { data: conns } = await supabaseAdmin.from('ad_connections')
      .select('provider, account_name, account_id, last_synced_at, last_error').eq('dealership_id', req.dealershipId)
    const by = Object.fromEntries((conns || []).map(c => [c.provider, c]))
    res.json({
      ok: true, can_manage: isAdmin(req),
      providers: AD_PROVIDERS.map(p => ({
        provider: p, label: label(p), configured: adProviderConfigured(p),
        connected: !!by[p], account: by[p]?.account_name || by[p]?.account_id || null,
        last_synced_at: by[p]?.last_synced_at || null, last_error: by[p]?.last_error || null,
      })),
      any_configured: anyAdProviderConfigured(),
    })
  })

  app.get('/adspend/connect/:provider', requireAuth, async (req, res) => {
    const provider = req.params.provider
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership' })
    if (!isAdmin(req)) return res.status(403).json({ error: 'Admin access required' })
    if (!AD_PROVIDERS.includes(provider)) return res.status(400).json({ error: 'Unknown provider' })
    if (!adProviderConfigured(provider)) return res.status(501).json({ error: `${label(provider)} isn’t configured on this server yet.` })
    const state = signState({ uid: req.user.id, did: req.dealershipId, p: provider, kind: 'ad' })
    res.json({ ok: true, url: adAuthUrl(provider, state) })
  })

  app.get('/adspend/callback/:provider', async (req, res) => {
    const provider = req.params.provider
    const done = (ok, msg) => res.redirect(`${FRONTEND_URL}/dashboard.html?adspend=${ok ? 'connected' : 'error'}&provider=${provider}&msg=${encodeURIComponent(msg || '')}`)
    try {
      if (!AD_PROVIDERS.includes(provider) || !adProviderConfigured(provider)) return done(false, 'Not configured')
      if (req.query.error) return done(false, String(req.query.error_description || req.query.error))
      const st = verifyState(req.query.state)
      if (!st || st.p !== provider || st.kind !== 'ad') return done(false, 'This link expired — try again.')
      const r = await adExchangeAndStore(provider, String(req.query.code || ''), { dealershipId: st.did, userId: st.uid })
      audit({ user: { id: st.uid }, dealershipId: st.did, headers: req.headers }, AuditAction.CONFIG_UPDATED, { ad_connected: provider, account: r.account_id })
      // First pull immediately so the ROI report is populated right away.
      try { const { data: conn } = await supabaseAdmin.from('ad_connections').select('*').eq('dealership_id', st.did).eq('provider', provider).maybeSingle(); if (conn) await pullAdSpend(conn) } catch (e) { console.error('[adspend] first pull failed:', e.message) }
      done(true, label(provider))
    } catch (e) { console.error('[adspend] callback failed:', e.message); done(false, e.message) }
  })

  app.post('/adspend/disconnect/:provider', requireAuth, async (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ error: 'Admin access required' })
    await supabaseAdmin.from('ad_connections').delete().eq('dealership_id', req.dealershipId).eq('provider', req.params.provider)
    audit(req, AuditAction.CONFIG_UPDATED, { ad_disconnected: req.params.provider })
    res.json({ ok: true })
  })

  app.post('/adspend/sync-now', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership' })
    if (!isMgr(req)) return res.status(403).json({ error: 'Manager access required' })
    const { data: conns } = await supabaseAdmin.from('ad_connections').select('*').eq('dealership_id', req.dealershipId)
    if (!conns?.length) return res.status(400).json({ error: 'No ad account connected.' })
    const results = []
    for (const conn of conns) {
      try { const r = await pullAdSpend(conn); results.push({ provider: conn.provider, ...r }) }
      catch (e) { await supabaseAdmin.from('ad_connections').update({ last_error: e.message?.slice(0, 300) || 'sync failed' }).eq('id', conn.id); results.push({ provider: conn.provider, error: e.message }) }
    }
    res.json({ ok: true, results })
  })

  // Nightly sweep. Render Cron Job:
  //   curl -X POST https://<backend>/cron/adspend-pull -H "x-cron-secret: $CRON_SECRET"
  app.post('/cron/adspend-pull', async (req, res) => {
    if ((req.headers['x-cron-secret'] || '').trim() !== (process.env.CRON_SECRET || '').trim()) return res.status(403).json({ error: 'Forbidden' })
    const { data: conns } = await supabaseAdmin.from('ad_connections').select('*').limit(1000)
    let ok = 0, failed = 0
    for (const conn of (conns || [])) {
      try { await pullAdSpend(conn); ok++ }
      catch (e) { failed++; await supabaseAdmin.from('ad_connections').update({ last_error: e.message?.slice(0, 300) || 'sync failed' }).eq('id', conn.id) }
    }
    res.json({ ok: true, synced: ok, failed })
  })
}
