import { supabaseAdmin, resend, EMAIL_FROM } from '../shared.js'
import { requireAuth } from '../middleware.js'
import { createNotification } from '../notifications.js'

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

    // Join inventory inline and filter by dealership on the embedded resource.
    // (Avoids building a giant .in('inventory_id', [hundreds of IDs]) which blows
    // PostgREST's URL length limit and makes the request hang on big stores.)
    let q = supabaseAdmin
      .from('listings')
      .select('id, inventory_id, posted_by, vehicle_label, status, posted_at, sold_at, pipeline_stage, fb_listing_url, relisted_at, appointment_at, appointment_note, inventory:inventory_id!inner(dealership_id, year, make, model, trim, price, mileage, exterior_color, condition, stocknumber, image_urls, source_url)')
      .eq('inventory.dealership_id', req.dealershipId)
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
      // Pipeline is an internal management view → show the rep's real name.
      repNames = Object.fromEntries((reps || []).map(r => [r.id, r.full_name || r.display_name || '—']))
    }

    const columns = emptyCols()
    for (const l of listings || []) {
      const v = l.inventory || {}
      const label = l.vehicle_label || [v.year, v.make, v.model].filter(Boolean).join(' ') || '—'
      const card = {
        id: l.id,
        label,
        year: v.year || null,
        make: v.make || null,
        model: v.model || null,
        trim: v.trim || null,
        price: v.price || null,
        mileage: v.mileage || null,
        exterior_color: v.exterior_color || null,
        condition: v.condition || null,
        stocknumber: v.stocknumber || null,
        image: Array.isArray(v.image_urls) ? v.image_urls[0] : null,
        source_url: v.source_url || null,
        rep: repNames[l.posted_by] || null,
        posted_at: l.posted_at,
        stage: stageFor(l),
        fb_listing_url: l.fb_listing_url || null,
        appointment_at: l.appointment_at || null,
        appointment_note: l.appointment_note || null,
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

    if (stage === 'appointment_set') {
      // Capture the appointment time (+ optional note). Re-arm the reminder.
      if (req.body.appointment_at) {
        const dt = new Date(req.body.appointment_at)
        if (isNaN(dt)) return res.status(400).json({ error: 'Invalid appointment time' })
        update.appointment_at = dt.toISOString()
      }
      if (req.body.appointment_note !== undefined) update.appointment_note = req.body.appointment_note || null
      update.appointment_reminded_at = null
    } else {
      // Leaving the appointment column clears the appointment.
      update.appointment_at = null
      update.appointment_note = null
      update.appointment_reminded_at = null
    }

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

  // Cron: remind on appointments happening within the next 24h (once each).
  // Creates an in-app notification for the store and emails the manager address
  // when set. Schedule this hourly/daily with the x-cron-secret header.
  app.post('/cron/appointment-reminders', async (req, res) => {
    // Trim both sides — a stray newline/space when pasting the secret into a
    // scheduler is the usual cause of a spurious 401.
    if ((req.headers['x-cron-secret'] || '').trim() !== (process.env.CRON_SECRET || '').trim()) {
      return res.status(401).json({ error: 'Unauthorized' })
    }
    const now = new Date()
    const soon = new Date(now.getTime() + 24 * 3600 * 1000)
    const { data: due } = await supabaseAdmin
      .from('listings')
      .select('id, inventory_id, vehicle_label, appointment_at, appointment_note, posted_by, inventory:inventory_id(dealership_id)')
      .eq('pipeline_stage', 'appointment_set')
      .is('appointment_reminded_at', null)
      .gte('appointment_at', now.toISOString())
      .lte('appointment_at', soon.toISOString())
      .limit(500)

    let sent = 0
    for (const l of due || []) {
      const dealershipId = l.inventory?.dealership_id
      if (!dealershipId) continue
      const when = new Date(l.appointment_at).toLocaleString('en-CA', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
      const label = l.vehicle_label || 'a vehicle'
      await createNotification({
        dealershipId,
        type: 'appointment',
        title: `Appointment soon — ${label}`,
        body: `${when}${l.appointment_note ? ' · ' + l.appointment_note : ''}`,
        linkPage: 'inventory',
      })
      // Email the manager address if configured.
      try {
        const { data: dealer } = await supabaseAdmin
          .from('dealerships').select('name, ai_manager_email').eq('id', dealershipId).maybeSingle()
        if (dealer?.ai_manager_email && resend) {
          await resend.emails.send({
            from: EMAIL_FROM,
            to: dealer.ai_manager_email,
            subject: `Appointment reminder: ${label}`,
            html: `<p>Upcoming appointment for <strong>${label}</strong>.</p><p><strong>When:</strong> ${when}</p>${l.appointment_note ? `<p><strong>Note:</strong> ${l.appointment_note}</p>` : ''}`,
          }).catch(() => {})
        }
      } catch {}
      await supabaseAdmin.from('listings').update({ appointment_reminded_at: now.toISOString() }).eq('id', l.id)
      sent++
    }
    res.json({ ok: true, reminded: sent })
  })
}

function emptyCols() { return { posted: [], appointment_set: [], claimed_sale: [], need_relisting: [] } }
function zeroCounts() { return { posted: 0, appointment_set: 0, claimed_sale: 0, need_relisting: 0 } }
