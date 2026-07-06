import { supabaseAdmin } from '../shared.js'
import { requireAuth } from '../middleware.js'

const STALE_DAYS = 21
const STAGES = ['posted', 'appointment_set', 'claimed_sale', 'need_relisting']

function isDealerLevel(profile) {
  return ['DEALER_ADMIN', 'OWNER', 'MANAGER'].includes(profile?.role)
}

// Which pipeline column a listing belongs in.
function stageFor(l) {
  if (l.status === 'sold' || l.pipeline_stage === 'claimed_sale') return 'claimed_sale'
  if (l.pipeline_stage === 'appointment_set') return 'appointment_set'
  if (l.pipeline_stage === 'need_relisting') return 'need_relisting'
  // Auto: a post that's been up a while with no movement needs relisting. The
  // freshness clock resets when a listing is relisted.
  const fresh = l.relisted_at || l.posted_at
  if (l.status === 'posted' && fresh) {
    const days = (Date.now() - new Date(fresh)) / 86400000
    if (days >= STALE_DAYS) return 'need_relisting'
  }
  return 'posted'
}

export function registerPipeline(app) {
  // The board: every posted/sold listing for the store (or just mine, for a rep),
  // grouped into the four sales-pipeline columns.
  app.get('/pipeline', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.json({ columns: {}, counts: {} })

    const { data: inv } = await supabaseAdmin
      .from('inventory').select('id').eq('dealership_id', req.dealershipId)
    const invIds = (inv || []).map(v => v.id)
    if (!invIds.length) return res.json({ columns: emptyCols(), counts: zeroCounts() })

    let q = supabaseAdmin
      .from('listings')
      .select('id, inventory_id, posted_by, vehicle_label, status, posted_at, sold_at, pipeline_stage, fb_listing_url, relisted_at')
      .in('inventory_id', invIds)
      .in('status', ['posted', 'sold'])
      .order('posted_at', { ascending: false })
      .limit(2000)
    // Reps only see their own posts; dealer-level sees the whole store.
    if (!isDealerLevel(req.profile)) q = q.eq('posted_by', req.user.id)
    const { data: listings, error } = await q
    if (error) return res.status(500).json({ error: error.message })

    // Resolve rep names in one shot.
    const repIds = [...new Set((listings || []).map(l => l.posted_by).filter(Boolean))]
    let repNames = {}
    if (repIds.length) {
      const { data: reps } = await supabaseAdmin
        .from('profiles').select('id, full_name, display_name').in('id', repIds)
      repNames = Object.fromEntries((reps || []).map(r => [r.id, r.display_name || r.full_name || '—']))
    }

    const columns = emptyCols()
    for (const l of listings || []) {
      const card = {
        id: l.id,
        label: l.vehicle_label || '—',
        rep: repNames[l.posted_by] || null,
        posted_at: l.posted_at,
        stage: stageFor(l),
        fb_listing_url: l.fb_listing_url || null,
      }
      columns[card.stage].push(card)
    }
    const counts = Object.fromEntries(STAGES.map(s => [s, columns[s].length]))
    res.json({ columns, counts, can_manage_all: isDealerLevel(req.profile) })
  })

  // Move a listing to a stage. Reps can only move their own posts.
  app.patch('/pipeline/:id', requireAuth, async (req, res) => {
    const stage = req.body?.stage
    if (!STAGES.includes(stage)) return res.status(400).json({ error: 'Invalid stage' })

    const { data: listing } = await supabaseAdmin
      .from('listings')
      .select('id, inventory_id, posted_by, status, inventory:inventory_id(dealership_id)')
      .eq('id', req.params.id)
      .single()
    if (!listing) return res.status(404).json({ error: 'Listing not found' })
    if (listing.inventory?.dealership_id !== req.dealershipId) {
      return res.status(403).json({ error: 'Not your dealership' })
    }
    if (!isDealerLevel(req.profile) && listing.posted_by !== req.user.id) {
      return res.status(403).json({ error: 'You can only move your own listings' })
    }

    const update = { pipeline_stage: stage === 'posted' ? null : stage, pipeline_updated_at: new Date().toISOString() }

    if (stage === 'claimed_sale') {
      // Mark the listing sold and log the sale (awards leaderboard points), once.
      update.status = 'sold'
      update.sold_at = new Date().toISOString()
      const { data: existing } = await supabaseAdmin
        .from('sales').select('id').eq('inventory_id', listing.inventory_id).maybeSingle()
      if (!existing) {
        await supabaseAdmin.from('sales').insert({
          inventory_id: listing.inventory_id,
          sold_by: listing.posted_by || req.user.id,
          dealership_id: req.dealershipId,
          sold_at: new Date().toISOString(),
        })
      }
    } else if (listing.status === 'sold' && stage !== 'claimed_sale') {
      // Moving back out of a sale — reopen the listing.
      update.status = 'posted'
      update.sold_at = null
      await supabaseAdmin.from('sales').delete().eq('inventory_id', listing.inventory_id)
    }

    const { error } = await supabaseAdmin.from('listings').update(update).eq('id', req.params.id)
    if (error) return res.status(500).json({ error: error.message })
    res.json({ ok: true, stage })
  })

  // One-click relist: reset the freshness clock and return the vehicle's details
  // so the rep can repost it to Facebook (the extension fills the form).
  app.post('/pipeline/:id/relist', requireAuth, async (req, res) => {
    const { data: listing } = await supabaseAdmin
      .from('listings')
      .select('id, inventory_id, posted_by, vehicle_label, inventory:inventory_id(dealership_id)')
      .eq('id', req.params.id)
      .single()
    if (!listing) return res.status(404).json({ error: 'Listing not found' })
    if (listing.inventory?.dealership_id !== req.dealershipId) {
      return res.status(403).json({ error: 'Not your dealership' })
    }
    if (!isDealerLevel(req.profile) && listing.posted_by !== req.user.id) {
      return res.status(403).json({ error: 'You can only relist your own listings' })
    }
    const { error } = await supabaseAdmin.from('listings').update({
      relisted_at: new Date().toISOString(),
      pipeline_stage: null,
      pipeline_updated_at: new Date().toISOString(),
    }).eq('id', req.params.id)
    if (error) return res.status(500).json({ error: error.message })
    res.json({ ok: true, inventory_id: listing.inventory_id, label: listing.vehicle_label })
  })
}

function emptyCols() { return { posted: [], appointment_set: [], claimed_sale: [], need_relisting: [] } }
function zeroCounts() { return { posted: 0, appointment_set: 0, claimed_sale: 0, need_relisting: 0 } }
