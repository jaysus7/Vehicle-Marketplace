import { supabaseAdmin, browserFetch } from '../shared.js'
import { requireAuth } from '../middleware.js'
import { runInventorySync, syncProgress } from '../sync/engine.js'

// Pull the Carfax report link the dealer already embeds on a listing page (their
// paid Carfax badge). Returns the best-matching absolute carfax URL, or null.
function extractCarfaxLink(html, vin) {
  const hrefs = [...html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)].map(m => m[1].replace(/&amp;/g, '&'))
  const carfax = hrefs.filter(u =>
    /carfax/i.test(u) && /^https?:\/\//i.test(u) && !/\.(png|jpe?g|svg|gif|css|js)(\?|#|$)/i.test(u))
  if (!carfax.length) return null
  const vinU = (vin || '').toUpperCase()
  const score = u => (vinU && u.toUpperCase().includes(vinU) ? 10 : 0) + (/vhr|report|vehicle-history/i.test(u) ? 3 : 0)
  return carfax.sort((a, b) => score(b) - score(a))[0]
}

export function registerRoutes(app) {
  // GET /inventory/:id/carfax — resolve the Carfax report link for a vehicle by
  // scraping the badge off its source listing page (cached after first hit).
  app.get('/inventory/:id/carfax', requireAuth, async (req, res) => {
    const { data: v } = await supabaseAdmin.from('inventory')
      .select('id, vin, source_url, carfax_url')
      .eq('id', req.params.id).eq('dealership_id', req.dealershipId).maybeSingle()
    if (!v) return res.status(404).json({ error: 'Not found' })
    if (v.carfax_url) return res.json({ url: v.carfax_url, source: 'cached' })

    let found = null
    if (v.source_url) {
      try {
        const r = await browserFetch(v.source_url)
        if (r.ok) found = extractCarfaxLink(await r.text(), v.vin)
      } catch { /* fall through to fallback */ }
    }
    if (found) {
      await supabaseAdmin.from('inventory').update({ carfax_url: found }).eq('id', v.id)
      return res.json({ url: found, source: 'website' })
    }
    // No badge found on the page — fall back to a Carfax Canada VIN search.
    const fallback = v.vin
      ? `https://www.carfax.ca/vehicle-history-reports?vin=${encodeURIComponent(v.vin)}`
      : 'https://www.carfax.ca/'
    res.json({ url: fallback, source: 'fallback' })
  })

  // ── 6. INVENTORY ──
  app.get('/inventory', requireAuth, async (req, res) => {
    const { data, error } = await supabaseAdmin
      .from('inventory')
      .select('*')
      .eq('dealership_id', req.dealershipId)
      .eq('status', 'available')
      .order('created_at', { ascending: false })
    if (error) return res.status(500).json({ error: error.message })
    res.json(data)
  })

  app.get('/inventory/all', requireAuth, async (req, res) => {
    const { data, error } = await supabaseAdmin
      .from('inventory')
      .select('id, vin, year, make, model, trim, price, mileage, condition, exterior_color, interior_color, body_style, fuel_type, drivetrain, transmission, engine, doors, status, image_urls, source_url, description, stocknumber, last_synced_at, window_sticker_url, window_sticker_oem_url, window_sticker_gen_url, brochure_url, brochure_oem_url, brochure_gen_url, recalls, recalls_checked_at, vin_data')
      .eq('dealership_id', req.dealershipId)
      .neq('status', 'archived')   // archived = dropped off the feed (retained for history, not shown on the lot)
      .order('created_at', { ascending: false })
    if (error) return res.status(500).json({ error: error.message })
    res.json(data || [])
  })

  app.get('/inventory/:id', requireAuth, async (req, res) => {
    const { data, error } = await supabaseAdmin
      .from('inventory')
      .select('*')
      .eq('id', req.params.id)
      .eq('dealership_id', req.dealershipId)
      .single()
    if (error) return res.status(404).json({ error: 'Not found' })
    res.json(data)
  })

  // Lightweight progress poll for the dashboard Sync button. Returns the live
  // percentage/phase of an in-flight sync for the caller's dealership, or idle.
  app.get('/inventory/sync/progress', requireAuth, (req, res) => {
    if (!req.dealershipId) return res.json({ phase: 'idle', pct: 0 })
    res.json(syncProgress.get(req.dealershipId) || { phase: 'idle', pct: 0 })
  })

  app.post('/inventory/sync', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership associated with this account' })
    try {
      const result = await runInventorySync(req.dealershipId)
      if (!result.success) return res.status(400).json(result)
      res.json(result)
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  // ── 11. DIAGNOSTICS ──
  app.get('/debug', requireAuth, async (req, res) => {
    res.json({ user_id: req.user.id, profile: req.profile, dealership_id: req.dealershipId })
  })
}
