import { supabaseAdmin, stripe, FRONTEND_URL } from '../shared.js'
import { requireAuth } from '../middleware.js'
import { randomBytes } from 'crypto'

// Short, human-shareable join code (no ambiguous chars). e.g. "K7P4-9QMX".
function makeJoinCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const bytes = randomBytes(8)
  let s = ''
  for (let i = 0; i < 8; i++) s += alphabet[bytes[i] % alphabet.length]
  return `${s.slice(0, 4)}-${s.slice(4)}`
}

// Which dealership IDs can this profile see? Group admins see every dealership
// in their group; everyone else sees their own dealership only.
export async function accessibleDealershipIds(profile) {
  if (!profile) return []
  if (profile.role === 'DEALER_GROUP' && profile.group_id) {
    const { data } = await supabaseAdmin.from('dealerships').select('id').eq('group_id', profile.group_id)
    return (data || []).map(d => d.id)
  }
  return profile.dealership_id ? [profile.dealership_id] : []
}

function isGroupAdmin(profile) {
  return profile?.role === 'DEALER_GROUP' || profile?.role === 'OWNER'
}

const OWNER_EMAIL = (process.env.OWNER_EMAIL || 'massiejay@gmail.com').toLowerCase()
const isOwner = (req) => (req.user?.email || '').toLowerCase() === OWNER_EMAIL || req.profile?.role === 'OWNER'

export function registerGroups(app) {
  // Create a dealer group. The caller becomes its group admin. If the caller
  // already runs a dealership, that dealership is pulled into the new group.
  app.post('/groups', requireAuth, async (req, res) => {
    const { name } = req.body || {}
    if (!name || !name.trim()) return res.status(400).json({ error: 'Group name is required' })
    const canCreate = req.profile.role === 'DEALER_ADMIN' || req.profile.role === 'OWNER' || req.profile.role === 'DEALER_GROUP'
    if (!canCreate) return res.status(403).json({ error: 'Only a dealer admin can create a group' })

    const { data: group, error } = await supabaseAdmin
      .from('dealer_groups')
      .insert({ name: name.trim(), owner_profile_id: req.user.id, join_code: makeJoinCode() })
      .select('id, name, billing_mode, join_code, created_at')
      .single()
    if (error) return res.status(500).json({ error: error.message })

    // Promote the caller to group admin and attach their current dealership.
    await supabaseAdmin.from('profiles').update({ role: 'DEALER_GROUP', group_id: group.id }).eq('id', req.user.id)
    if (req.profile.dealership_id) {
      await supabaseAdmin.from('dealerships').update({ group_id: group.id }).eq('id', req.profile.dealership_id)
    }
    res.json({ group })
  })

  // Join an existing group with a shared code. A dealer admin enters the code
  // and their whole dealership attaches to the group — nothing is copied or
  // deleted, we only set the dealership's group_id, so ALL inventory, listings,
  // reps and history stay exactly as they are.
  app.post('/groups/join', requireAuth, async (req, res) => {
    const canJoin = req.profile.role === 'DEALER_ADMIN' || req.profile.role === 'OWNER'
    if (!canJoin) return res.status(403).json({ error: 'Only a dealer admin can join a group' })
    if (!req.profile.dealership_id) return res.status(400).json({ error: 'Your account has no dealership to add' })

    const code = String(req.body?.code || '').trim().toUpperCase()
    if (!code) return res.status(400).json({ error: 'Enter the group join code' })

    const { data: group } = await supabaseAdmin
      .from('dealer_groups').select('id, name').eq('join_code', code).maybeSingle()
    if (!group) return res.status(404).json({ error: 'No group found for that code — double-check it with the group.' })

    const { error } = await supabaseAdmin
      .from('dealerships').update({ group_id: group.id }).eq('id', req.profile.dealership_id)
    if (error) return res.status(500).json({ error: error.message })
    res.json({ ok: true, group: { id: group.id, name: group.name } })
  })

  // What group (if any) is my dealership in? Lets the dashboard show status.
  app.get('/groups/mine', requireAuth, async (req, res) => {
    if (!req.profile.dealership_id) return res.json({ group: null })
    const { data: dealer } = await supabaseAdmin
      .from('dealerships').select('group_id').eq('id', req.profile.dealership_id).single()
    if (!dealer?.group_id) return res.json({ group: null })
    const { data: group } = await supabaseAdmin
      .from('dealer_groups').select('id, name').eq('id', dealer.group_id).single()
    res.json({ group: group || null })
  })

  // Leave the group my dealership is currently in (keeps all our own data).
  app.post('/groups/leave', requireAuth, async (req, res) => {
    const canLeave = req.profile.role === 'DEALER_ADMIN' || req.profile.role === 'OWNER'
    if (!canLeave || !req.profile.dealership_id) return res.status(403).json({ error: 'Dealer admin required' })
    const { error } = await supabaseAdmin
      .from('dealerships').update({ group_id: null }).eq('id', req.profile.dealership_id)
    if (error) return res.status(500).json({ error: error.message })
    res.json({ ok: true })
  })

  // Attach an existing dealership to the caller's group (by dealership id).
  app.post('/groups/dealerships', requireAuth, async (req, res) => {
    if (!isGroupAdmin(req.profile) || !req.profile.group_id) {
      return res.status(403).json({ error: 'Group admin required' })
    }
    const { dealership_id } = req.body || {}
    if (!dealership_id) return res.status(400).json({ error: 'dealership_id is required' })
    const { error } = await supabaseAdmin
      .from('dealerships').update({ group_id: req.profile.group_id }).eq('id', dealership_id)
    if (error) return res.status(500).json({ error: error.message })
    res.json({ ok: true })
  })

  // Detach a dealership from the group (it keeps all its own data + billing).
  app.delete('/groups/dealerships/:id', requireAuth, async (req, res) => {
    if (!isGroupAdmin(req.profile) || !req.profile.group_id) {
      return res.status(403).json({ error: 'Group admin required' })
    }
    const { error } = await supabaseAdmin
      .from('dealerships').update({ group_id: null })
      .eq('id', req.params.id).eq('group_id', req.profile.group_id)
    if (error) return res.status(500).json({ error: error.message })
    res.json({ ok: true })
  })

  // Group rollup: one card per store with the headline metrics (the image-2 view).
  app.get('/groups/overview', requireAuth, async (req, res) => {
    if (!isGroupAdmin(req.profile) || !req.profile.group_id) {
      return res.status(403).json({ error: 'Group admin required' })
    }
    const groupId = req.profile.group_id

    let { data: group } = await supabaseAdmin
      .from('dealer_groups').select('id, name, billing_mode, billing_status, join_code, monthly_price_cents').eq('id', groupId).single()
    // Backfill a join code for groups created before invite codes existed.
    if (group && !group.join_code) {
      const code = makeJoinCode()
      await supabaseAdmin.from('dealer_groups').update({ join_code: code }).eq('id', groupId)
      group.join_code = code
    }
    const { data: stores } = await supabaseAdmin
      .from('dealerships').select('id, name, billing_status').eq('group_id', groupId)

    const storeIds = (stores || []).map(s => s.id)
    // Pull the raw rows we need once, then aggregate in JS (reliable at any scale).
    const [{ data: reps }, { data: inv }, { data: listings }, { data: sales }] = await Promise.all([
      supabaseAdmin.from('profiles').select('id, dealership_id, role').in('dealership_id', storeIds.length ? storeIds : ['00000000-0000-0000-0000-000000000000']),
      supabaseAdmin.from('inventory').select('id, dealership_id, status').in('dealership_id', storeIds.length ? storeIds : ['00000000-0000-0000-0000-000000000000']),
      supabaseAdmin.from('listings').select('id, inventory_id, status, posted_at, sold_at').limit(20000),
      supabaseAdmin.from('sales').select('id, dealership_id, sold_at').in('dealership_id', storeIds.length ? storeIds : ['00000000-0000-0000-0000-000000000000']),
    ])

    // Map inventory_id → dealership for listing attribution.
    const invStore = new Map((inv || []).map(v => [v.id, v.dealership_id]))

    const perStore = {}
    for (const s of stores || []) {
      perStore[s.id] = { id: s.id, name: s.name, billing_status: s.billing_status, reps: 0, listings: 0, posted: 0, sold: 0, available: 0, days_samples: [] }
    }
    for (const p of reps || []) if (perStore[p.dealership_id]) perStore[p.dealership_id].reps++
    for (const v of inv || []) {
      const st = perStore[v.dealership_id]; if (!st) continue
      st.listings++
      if (v.status === 'available') st.available++
      if (v.status === 'sold') st.sold++
    }
    for (const l of listings || []) {
      const store = perStore[invStore.get(l.inventory_id)]
      if (!store) continue
      if (l.status === 'posted') store.posted++
      if (l.sold_at && l.posted_at) {
        const d = (new Date(l.sold_at) - new Date(l.posted_at)) / 86400000
        if (d >= 0 && d < 365) store.days_samples.push(d)
      }
    }

    const storesOut = Object.values(perStore).map(st => {
      const avgDays = st.days_samples.length
        ? Math.round((st.days_samples.reduce((a, b) => a + b, 0) / st.days_samples.length) * 10) / 10
        : null
      const { days_samples, ...rest } = st
      return { ...rest, avg_days_to_sell: avgDays }
    })

    const totals = storesOut.reduce((t, s) => ({
      stores: t.stores + 1,
      reps: t.reps + s.reps,
      listings: t.listings + s.listings,
      posted: t.posted + s.posted,
      sold: t.sold + s.sold,
    }), { stores: 0, reps: 0, listings: 0, posted: 0, sold: 0 })

    res.json({ group: group || { id: groupId }, totals, stores: storesOut, is_owner: isOwner(req) })
  })

  // Set how the group is billed: 'group' (one central subscription covers every
  // store) or 'per_dealer' (each store keeps its own subscription so one can
  // leave without affecting the others).
  app.patch('/groups/billing-mode', requireAuth, async (req, res) => {
    if (!isGroupAdmin(req.profile) || !req.profile.group_id) {
      return res.status(403).json({ error: 'Group admin required' })
    }
    const mode = req.body?.mode
    if (!['group', 'per_dealer'].includes(mode)) {
      return res.status(400).json({ error: "mode must be 'group' or 'per_dealer'" })
    }
    const { error } = await supabaseAdmin
      .from('dealer_groups').update({ billing_mode: mode }).eq('id', req.profile.group_id)
    if (error) return res.status(500).json({ error: error.message })
    res.json({ ok: true, billing_mode: mode })
  })

  // Owner sets a group's negotiated monthly price (custom per group). Amount in
  // dollars; stored as cents. Only the MarketSync owner can set it.
  app.patch('/groups/:id/price', requireAuth, async (req, res) => {
    if (!isOwner(req)) return res.status(403).json({ error: 'Only MarketSync can set a group price' })
    const dollars = Number(req.body?.monthly_price)
    if (!Number.isFinite(dollars) || dollars < 0 || dollars > 100000) {
      return res.status(400).json({ error: 'monthly_price must be a dollar amount' })
    }
    const { error } = await supabaseAdmin
      .from('dealer_groups').update({ monthly_price_cents: Math.round(dollars * 100) }).eq('id', req.params.id)
    if (error) return res.status(500).json({ error: error.message })
    res.json({ ok: true, monthly_price_cents: Math.round(dollars * 100) })
  })

  // Start a central group subscription checkout. The price is built inline from
  // the group's own negotiated monthly amount (no per-group Stripe Price needed).
  app.post('/groups/billing/checkout', requireAuth, async (req, res) => {
    if (!isGroupAdmin(req.profile) || !req.profile.group_id) {
      return res.status(403).json({ error: 'Group admin required' })
    }
    if (!stripe) return res.status(503).json({ error: 'Billing is not configured' })
    try {
      const { data: group } = await supabaseAdmin
        .from('dealer_groups').select('id, name, stripe_customer_id, monthly_price_cents').eq('id', req.profile.group_id).single()

      // Prefer the group's custom negotiated price; fall back to a fixed env price
      // only if one is configured. If neither, tell them to contact us.
      let line_items
      if (group.monthly_price_cents && group.monthly_price_cents > 0) {
        line_items = [{
          quantity: 1,
          price_data: {
            currency: 'cad',
            unit_amount: group.monthly_price_cents,
            recurring: { interval: 'month' },
            product_data: { name: `MarketSync Dealer Group — ${group.name}` },
          },
        }]
      } else if (process.env.STRIPE_GROUP_PRICE_ID) {
        line_items = [{ price: process.env.STRIPE_GROUP_PRICE_ID, quantity: 1 }]
      } else {
        return res.status(503).json({ error: "Your group's price hasn't been set yet — contact MarketSync to finalize it." })
      }

      const session = await stripe.checkout.sessions.create({
        mode: 'subscription',
        line_items,
        customer: group?.stripe_customer_id || undefined,
        client_reference_id: group.id,
        metadata: { group_id: group.id },
        subscription_data: { trial_period_days: 3, metadata: { group_id: group.id } },
        success_url: `${FRONTEND_URL}/group.html?group_session={CHECKOUT_SESSION_ID}`,
        cancel_url: `${FRONTEND_URL}/group.html`,
      })
      // Flip to group billing the moment they start checkout.
      await supabaseAdmin.from('dealer_groups').update({ billing_mode: 'group' }).eq('id', group.id)
      res.json({ url: session.url })
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  // Drill into one store the group admin owns: its metrics, team and recent
  // listings. Verifies the store actually belongs to the caller's group.
  app.get('/groups/stores/:storeId', requireAuth, async (req, res) => {
    if (!isGroupAdmin(req.profile) || !req.profile.group_id) {
      return res.status(403).json({ error: 'Group admin required' })
    }
    const storeId = req.params.storeId
    const { data: store } = await supabaseAdmin
      .from('dealerships').select('id, name, group_id, billing_status').eq('id', storeId).single()
    if (!store || store.group_id !== req.profile.group_id) {
      return res.status(404).json({ error: 'Store not found in your group' })
    }

    const [{ data: inv }, { data: team }] = await Promise.all([
      supabaseAdmin.from('inventory').select('id, status').eq('dealership_id', storeId),
      supabaseAdmin.from('profiles').select('id, full_name, display_name, role').eq('dealership_id', storeId),
    ])
    const invIds = (inv || []).map(v => v.id)
    let listings = []
    if (invIds.length) {
      const { data } = await supabaseAdmin
        .from('listings')
        .select('id, inventory_id, vehicle_label, status, posted_at, sold_at')
        .in('inventory_id', invIds)
        .order('posted_at', { ascending: false })
        .limit(25)
      listings = data || []
    }

    const counts = { available: 0, sold: 0, pending: 0, total: (inv || []).length }
    for (const v of inv || []) { if (counts[v.status] != null) counts[v.status]++ }
    const posted = listings.filter(l => l.status === 'posted').length
    const daySamples = listings.filter(l => l.sold_at && l.posted_at)
      .map(l => (new Date(l.sold_at) - new Date(l.posted_at)) / 86400000).filter(d => d >= 0 && d < 365)
    const avgDays = daySamples.length ? Math.round((daySamples.reduce((a, b) => a + b, 0) / daySamples.length) * 10) / 10 : null

    res.json({
      store: { id: store.id, name: store.name, billing_status: store.billing_status },
      counts, posted, avg_days_to_sell: avgDays,
      team: (team || []).map(p => ({ id: p.id, name: p.display_name || p.full_name || '—', role: p.role })),
      recent_listings: listings.slice(0, 15).map(l => ({ label: l.vehicle_label || '—', status: l.status, posted_at: l.posted_at })),
    })
  })

  // Full downline — every manager and rep across the group, grouped by store.
  app.get('/groups/downline', requireAuth, async (req, res) => {
    if (!isGroupAdmin(req.profile) || !req.profile.group_id) {
      return res.status(403).json({ error: 'Group admin required' })
    }
    const { data: stores } = await supabaseAdmin
      .from('dealerships').select('id, name').eq('group_id', req.profile.group_id)
    const storeIds = (stores || []).map(s => s.id)
    const { data: people } = await supabaseAdmin
      .from('profiles')
      .select('id, full_name, display_name, role, dealership_id')
      .in('dealership_id', storeIds.length ? storeIds : ['00000000-0000-0000-0000-000000000000'])
    const byStore = (stores || []).map(s => ({
      id: s.id, name: s.name,
      members: (people || []).filter(p => p.dealership_id === s.id)
        .map(p => ({ id: p.id, name: p.display_name || p.full_name || '—', role: p.role })),
    }))
    res.json({ stores: byStore })
  })
}
