import { supabaseAdmin, resend, EMAIL_FROM, FRONTEND_URL, EXTENSION_URL, BACKEND_URL } from '../shared.js'
import { runInventorySync, syncAllDealerships } from '../sync/engine.js'
import { runDripCampaign, verifyUnsubToken } from '../drip.js'

function runDrip(trigger) {
  return runDripCampaign({
    supabaseAdmin,
    resend,
    emailFrom: EMAIL_FROM,
    frontendUrl: FRONTEND_URL,
    extensionUrl: EXTENSION_URL,
    unsubBaseUrl: BACKEND_URL,
    unsubSecret: process.env.SYNC_SECRET || '',
    trigger
  })
}

async function applyDripUnsubscribe(req) {
  const userId = String((req.query.u || req.body?.u) || '')
  const token = String((req.query.t || req.body?.t) || '')
  if (!verifyUnsubToken(userId, token, process.env.SYNC_SECRET || '')) return false
  try {
    await supabaseAdmin
      .from('profiles')
      .update({ drip_unsubscribed_at: new Date().toISOString() })
      .eq('id', userId)
  } catch (e) {
    console.warn('[unsubscribe] update failed:', e.message)
  }
  return true
}

async function cleanupExpiredSoldListings() {
  const twoWeeksAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString()
  const { data: expired, error: fetchErr } = await supabaseAdmin
    .from('listings')
    .select('id, vehicle_label, sold_at')
    .eq('status', 'sold')
    .not('sold_at', 'is', null)
    .lt('sold_at', twoWeeksAgo)

  if (fetchErr) {
    console.error('[cleanup-sold] fetch error:', fetchErr.message)
    return
  }
  if (!expired?.length) {
    console.log('[cleanup-sold] no expired sold listings to clean up')
    return
  }

  const ids = expired.map(l => l.id)
  const { error: updateErr } = await supabaseAdmin
    .from('listings')
    .update({ status: 'deleted' })
    .in('id', ids)

  if (updateErr) {
    console.error('[cleanup-sold] soft-delete error:', updateErr.message)
  } else {
    console.log(`[cleanup-sold] soft-deleted ${ids.length} expired sold listings`)
  }
}

export function registerRoutes(app) {
  app.get('/sync', async (req, res) => {
    if (!process.env.SYNC_SECRET) return res.status(503).json({ error: 'Sync endpoint not configured' })
    if (req.query.secret !== process.env.SYNC_SECRET) {
      return res.status(401).json({ error: 'Unauthorized' })
    }
    const targetDealershipId = req.query.dealership_id
    if (!targetDealershipId) return res.status(400).json({ error: 'Missing target dealership parameter' })

    try {
      const { data: currentDealer } = await supabaseAdmin
        .from('dealerships').select('id').eq('id', targetDealershipId).single()
      if (!currentDealer) return res.status(404).json({ error: 'Target business identity not found.' })

      // Respond immediately — sync runs in background so the HTTP connection
      // doesn't time out on large inventories or slow dealer sites.
      res.json({ success: true, message: 'Sync started' })
      runInventorySync(targetDealershipId).catch(e =>
        console.error(`[sync] background sync failed for ${targetDealershipId}:`, e.message)
      )
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  app.post('/cron/sync-all', async (req, res) => {
    if (!process.env.SYNC_SECRET) return res.status(503).json({ error: 'Cron endpoint not configured' })
    const secret = req.headers['x-cron-secret'] || req.query.secret
    if (secret !== process.env.SYNC_SECRET) return res.status(401).json({ error: 'Unauthorized' })
    res.json({ success: true, message: 'Full sync started' })
    syncAllDealerships('manual').catch(e =>
      console.error('[sync] background sync-all failed:', e.message)
    )
  })

  app.post('/cron/drip', async (req, res) => {
    if (!process.env.SYNC_SECRET) return res.status(503).json({ error: 'Cron endpoint not configured' })
    const secret = req.headers['x-cron-secret'] || req.query.secret
    if (secret !== process.env.SYNC_SECRET) return res.status(401).json({ error: 'Unauthorized' })
    const result = await runDrip('manual')
    res.json(result)
  })

  app.get('/unsubscribe', async (req, res) => {
    const ok = await applyDripUnsubscribe(req)
    if (!ok) {
      return res.status(400).type('html').send('<p>This unsubscribe link is invalid or expired.</p>')
    }
    res.type('html').send(
      '<div style="font-family:-apple-system,sans-serif;max-width:480px;margin:64px auto;text-align:center;color:#0f172a;">' +
      '<h1 style="font-size:20px;">You\'re unsubscribed</h1>' +
      '<p style="color:#475569;">You won\'t get any more MarketSync onboarding tips. ' +
      'Account and security emails (like password resets) will still come through.</p>' +
      '<p><a href="https://marketsync.link/" style="color:#6366f1;">Back to MarketSync</a></p></div>'
    )
  })

  app.post('/unsubscribe', async (req, res) => {
    const ok = await applyDripUnsubscribe(req)
    res.status(ok ? 200 : 400).json({ success: ok })
  })

  // Run once 5 minutes after boot, then every 24 hours
  setTimeout(() => cleanupExpiredSoldListings(), 5 * 60 * 1000)
  setInterval(() => cleanupExpiredSoldListings(), 24 * 60 * 60 * 1000)
  console.log('🧹 Sold listing cleanup scheduled (daily, 14-day retention)')

  const DRIP_INTERVAL_HOURS = Number(process.env.DRIP_INTERVAL_HOURS || 24)
  if (DRIP_INTERVAL_HOURS > 0) {
    setTimeout(() => runDrip('boot'), 2 * 60 * 1000)
    setInterval(() => runDrip('interval'), DRIP_INTERVAL_HOURS * 60 * 60 * 1000)
    console.log(`📧 Scheduled onboarding drip every ${DRIP_INTERVAL_HOURS}h (set DRIP_INTERVAL_HOURS=0 to disable)`)
  }
}
