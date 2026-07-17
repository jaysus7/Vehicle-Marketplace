// Reconditioning board — moves each vehicle from arrival to frontline-ready.
// A recon record is one row per vehicle (unique inventory_id). The board is a
// kanban: stages are columns, cards are vehicles, with assignee + time-in-stage.
import { supabaseAdmin } from '../shared.js'
import { requireAuth } from '../middleware.js'

// Ordered recon stages. 'frontline' is terminal (unit is ready to post/sell).
export const RECON_STAGES = ['arrived', 'mechanical', 'parts', 'detail', 'photos', 'frontline']
const STAGE_LABELS = {
  arrived: 'Arrived', mechanical: 'Mechanical / Safety', parts: 'Parts',
  detail: 'Detail', photos: 'Photos', frontline: 'Frontline-Ready',
}

export function registerRecon(app) {
  // Board: every recon record for the dealership, joined to its vehicle. Also
  // returns which available vehicles aren't in recon yet, so the UI can add them.
  app.get('/recon', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership associated' })

    const { data: rows, error } = await supabaseAdmin
      .from('recon')
      .select('id, inventory_id, stage, assigned_to, notes, started_at, stage_since, done_at, updated_at, delivery_at, checklist, salesperson_id, fni_products, deal_id, inventory:inventory_id(year, make, model, trim, stocknumber, image_urls, price, status, condition)')
      .eq('dealership_id', req.dealershipId)
      .order('delivery_at', { ascending: true, nullsFirst: false })
    if (error) return res.status(500).json({ error: error.message })

    // Resolve assignee + salesperson display names in one query.
    const repIds = [...new Set([...(rows || []).map(r => r.assigned_to), ...(rows || []).map(r => r.salesperson_id)].filter(Boolean))]
    const repById = {}
    if (repIds.length) {
      const { data: reps } = await supabaseAdmin
        .from('profiles').select('id, full_name, display_name').in('id', repIds)
      for (const p of reps || []) repById[p.id] = p.display_name || p.full_name || 'Unassigned'
    }

    const now = Date.now()
    const inReconIds = new Set()
    const cards = (rows || [])
      .filter(r => r.inventory && r.inventory.status !== 'sold')   // drop sold units off the board
      .map(r => {
        inReconIds.add(r.inventory_id)
        const v = r.inventory || {}
        const hoursInStage = r.stage_since ? Math.floor((now - new Date(r.stage_since)) / 3600000) : 0
        return {
          id: r.id, inventory_id: r.inventory_id, stage: r.stage,
          label: [v.year, v.make, v.model, v.trim].filter(Boolean).join(' ') || 'Vehicle',
          stocknumber: v.stocknumber || null, price: v.price || null,
          photo: Array.isArray(v.image_urls) ? v.image_urls[0] || null : null,
          photo_count: Array.isArray(v.image_urls) ? v.image_urls.length : 0,
          assigned_to: r.assigned_to || null,
          assigned_name: r.assigned_to ? (repById[r.assigned_to] || 'Unassigned') : null,
          notes: r.notes || null,
          hours_in_stage: hoursInStage,
          days_in_recon: r.started_at ? Math.floor((now - new Date(r.started_at)) / 86400000) : 0,
          done_at: r.done_at || null,
          // Get-ready / cleanup fields
          delivery_at: r.delivery_at || null,
          checklist: Array.isArray(r.checklist) ? r.checklist : [],
          salesperson_id: r.salesperson_id || null,
          salesperson_name: r.salesperson_id ? (repById[r.salesperson_id] || null) : null,
          fni_products: r.fni_products || null,
          deal_id: r.deal_id || null,
        }
      })

    // Available units not yet in recon (so the manager can pull them onto the board).
    const { data: avail } = await supabaseAdmin
      .from('inventory')
      .select('id, year, make, model, trim, stocknumber, image_urls, price')
      .eq('dealership_id', req.dealershipId).is('archived_at', null).neq('status', 'sold')
      .order('created_at', { ascending: false }).limit(500)
    const notInRecon = (avail || [])
      .filter(v => !inReconIds.has(v.id))
      .map(v => ({
        inventory_id: v.id,
        label: [v.year, v.make, v.model, v.trim].filter(Boolean).join(' ') || 'Vehicle',
        stocknumber: v.stocknumber || null, price: v.price || null,
        photo: Array.isArray(v.image_urls) ? v.image_urls[0] || null : null,
      }))

    res.json({ stages: RECON_STAGES, stage_labels: STAGE_LABELS, cards, not_in_recon: notInRecon })
  })

  // Add a vehicle to the recon board (starts at 'arrived'). Idempotent.
  app.post('/recon/:inventory_id/start', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership associated' })
    const { inventory_id } = req.params

    // Verify the vehicle belongs to this dealership before touching recon.
    const { data: veh } = await supabaseAdmin
      .from('inventory').select('id').eq('id', inventory_id).eq('dealership_id', req.dealershipId).maybeSingle()
    if (!veh) return res.status(404).json({ error: 'Vehicle not found' })

    const now = new Date().toISOString()
    const { data, error } = await supabaseAdmin
      .from('recon')
      .upsert({
        dealership_id: req.dealershipId, inventory_id, stage: 'arrived',
        started_at: now, stage_since: now, done_at: null, updated_at: now,
      }, { onConflict: 'inventory_id', ignoreDuplicates: true })
      .select('id').maybeSingle()
    if (error) return res.status(500).json({ error: error.message })
    res.json({ ok: true, id: data?.id || null })
  })

  // Move a vehicle to a new stage. Resets time-in-stage; frontline sets done_at.
  app.post('/recon/:inventory_id/stage', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership associated' })
    const { inventory_id } = req.params
    const stage = String(req.body?.stage || '')
    if (!RECON_STAGES.includes(stage)) return res.status(400).json({ error: 'Invalid stage' })

    const now = new Date().toISOString()
    const patch = { stage, stage_since: now, updated_at: now, done_at: stage === 'frontline' ? now : null }
    const { error } = await supabaseAdmin
      .from('recon').update(patch)
      .eq('inventory_id', inventory_id).eq('dealership_id', req.dealershipId)
    if (error) return res.status(500).json({ error: error.message })
    res.json({ ok: true, stage })
  })

  // Assign (or clear) the detailer/tech responsible for this unit.
  app.post('/recon/:inventory_id/assign', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership associated' })
    const { inventory_id } = req.params
    const assigned_to = req.body?.assigned_to || null
    const { error } = await supabaseAdmin
      .from('recon').update({ assigned_to, updated_at: new Date().toISOString() })
      .eq('inventory_id', inventory_id).eq('dealership_id', req.dealershipId)
    if (error) return res.status(500).json({ error: error.message })
    res.json({ ok: true })
  })

  // Update the free-text notes for a unit (parts on order, waiting on approval, etc.).
  app.post('/recon/:inventory_id/notes', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership associated' })
    const { inventory_id } = req.params
    const notes = typeof req.body?.notes === 'string' ? req.body.notes.slice(0, 2000) : null
    const { error } = await supabaseAdmin
      .from('recon').update({ notes, updated_at: new Date().toISOString() })
      .eq('inventory_id', inventory_id).eq('dealership_id', req.dealershipId)
    if (error) return res.status(500).json({ error: error.message })
    res.json({ ok: true })
  })

  // Set (or clear) the scheduled delivery date/time — when the car is going out.
  app.post('/recon/:inventory_id/delivery', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership associated' })
    const raw = req.body?.delivery_at
    let delivery_at = null
    if (raw) { const d = new Date(raw); if (isNaN(d)) return res.status(400).json({ error: 'Invalid date' }); delivery_at = d.toISOString() }
    const { error } = await supabaseAdmin
      .from('recon').update({ delivery_at, updated_at: new Date().toISOString() })
      .eq('inventory_id', req.params.inventory_id).eq('dealership_id', req.dealershipId)
    if (error) return res.status(500).json({ error: error.message })
    res.json({ ok: true, delivery_at })
  })

  // Replace the get-ready checklist (list of what the car needs, each done/not).
  // The stock-card modal sends the whole array back on every change.
  app.post('/recon/:inventory_id/checklist', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership associated' })
    const items = Array.isArray(req.body?.checklist) ? req.body.checklist : null
    if (!items) return res.status(400).json({ error: 'checklist must be an array' })
    const checklist = items.slice(0, 100).map(it => ({
      label: String(it?.label || '').slice(0, 200),
      done: !!it?.done,
    })).filter(it => it.label)
    // A card is "done" when it has items and they're all checked → mark frontline-ready.
    const allDone = checklist.length > 0 && checklist.every(it => it.done)
    const now = new Date().toISOString()
    const patch = { checklist, updated_at: now }
    if (allDone) { patch.stage = 'frontline'; patch.done_at = now }
    const { error } = await supabaseAdmin
      .from('recon').update(patch)
      .eq('inventory_id', req.params.inventory_id).eq('dealership_id', req.dealershipId)
    if (error) return res.status(500).json({ error: error.message })
    res.json({ ok: true, checklist, all_done: allDone })
  })

  // Remove a vehicle from the recon board.
  app.delete('/recon/:inventory_id', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership associated' })
    const { error } = await supabaseAdmin
      .from('recon').delete()
      .eq('inventory_id', req.params.inventory_id).eq('dealership_id', req.dealershipId)
    if (error) return res.status(500).json({ error: error.message })
    res.json({ ok: true })
  })
}
