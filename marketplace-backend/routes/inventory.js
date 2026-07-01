import { supabaseAdmin } from '../shared.js'
import { requireAuth } from '../middleware.js'
import { runInventorySync, syncProgress } from '../sync/engine.js'

export function registerRoutes(app) {
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
      .select('id, vin, year, make, model, trim, price, mileage, condition, exterior_color, status, image_urls, source_url, description, stocknumber, last_synced_at')
      .eq('dealership_id', req.dealershipId)
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
