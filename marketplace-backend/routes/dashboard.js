import { supabaseAdmin } from '../shared.js'
import { requireAuth } from '../middleware.js'

async function buildUserStats(userId) {
  const countOf = async (status) => {
    try {
      let q = supabaseAdmin
        .from('listings')
        .select('id', { count: 'exact', head: true })
        .eq('posted_by', userId)
      if (status) q = q.eq('status', status)
      const { count, error } = await q
      if (error) {
        console.warn(`countOf(${status || 'all'}) failed:`, error.message)
        return 0
      }
      return count || 0
    } catch (e) {
      console.warn(`countOf(${status || 'all'}) threw:`, e.message)
      return 0
    }
  }

  const [total, active, sold, deleted] = await Promise.all([
    countOf(null),
    countOf('posted'),
    countOf('sold'),
    countOf('deleted')
  ])

  let recent = []
  try {
    const { data, error } = await supabaseAdmin
      .from('listings')
      .select('id, status, posted_at, fb_listing_url, inventory!listings_inventory_id_fkey(id, year, make, model, trim, price, image_urls)')
      .eq('posted_by', userId)
      .order('posted_at', { ascending: false })
      .limit(10)
    if (error) console.warn('Recent listings failed:', error.message)
    else recent = data || []
  } catch (e) {
    console.warn('Recent listings threw:', e.message)
  }

  return {
    totals: { total, active, sold, deleted },
    recent: (recent || []).map(l => ({
      listing_id: l.id,
      status: l.status,
      posted_at: l.posted_at,
      fb_listing_url: l.fb_listing_url,
      vehicle: l.inventory
    }))
  }
}

export function registerRoutes(app) {
  // ── Per-dealer feature toggles ───────────────────────────────────────────
  // Managers hide paid features they don't use. Nav gates on this + entitlement.
  const FEATURE_KEYS = ['website', 'automation', 'equity', 'inv_intel', 'appraisals', 'reports']
  app.get('/dealership/features', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.json({ features: {}, can_manage: false })
    const { data } = await supabaseAdmin.from('dealerships').select('feature_flags').eq('id', req.dealershipId).maybeSingle()
    const f = (data?.feature_flags && typeof data.feature_flags === 'object') ? data.feature_flags : {}
    const features = Object.fromEntries(FEATURE_KEYS.map(k => [k, f[k] !== false]))   // default on
    res.json({ features, can_manage: ['DEALER_ADMIN', 'OWNER', 'MANAGER'].includes(req.profile?.role) })
  })
  app.put('/dealership/features', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership' })
    if (!['DEALER_ADMIN', 'OWNER'].includes(req.profile?.role)) return res.status(403).json({ error: 'Admin access required' })
    const body = req.body || {}
    const flags = {}
    for (const k of FEATURE_KEYS) if (k in body) flags[k] = !!body[k]
    const { error } = await supabaseAdmin.from('dealerships').update({ feature_flags: flags }).eq('id', req.dealershipId)
    if (error) return res.status(500).json({ error: 'Save failed' })
    res.json({ ok: true, features: Object.fromEntries(FEATURE_KEYS.map(k => [k, flags[k] !== false])) })
  })

  app.get('/dealership/leaderboard', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.json({ ranking: [], total_members: 0 })
    if (req.profile.dealerships?.is_personal === true) return res.json({ ranking: [], total_members: 0 })

    const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString()

    const { data: members } = await supabaseAdmin
      .from('profiles').select('id, full_name, role').eq('dealership_id', req.dealershipId)
    if (!members?.length) return res.json({ ranking: [], total_members: 0 })

    try {
    // Real closed sales (desked deals) and trade appraisals so the board rewards
    // the whole job, not just Facebook activity. A "sale" of record is a won CRM
    // contact (status sold/fni/delivered) attributed to its assigned rep; each
    // appraisal is credited to whoever created it. Both are pulled ONCE for the
    // dealership and tallied in memory (bounded), then merged into each rep's row.
    // Each is independently guarded — a failure in one must never blank the board.
    const WON = ['sold', 'fni', 'delivered']
    const [{ data: wonContacts }, { data: apprRows }] = await Promise.all([
      supabaseAdmin.from('contacts')
        .select('assigned_rep, status').eq('dealership_id', req.dealershipId)
        .in('status', WON).limit(50000).then(r => ({ data: r.data || [] }), () => ({ data: [] })),
      supabaseAdmin.from('trade_appraisals')
        .select('created_by').eq('dealership_id', req.dealershipId).limit(50000).then(r => ({ data: r.data || [] }), () => ({ data: [] })),
    ])
    const dealsByRep = new Map(), apprByRep = new Map()
    for (const c of (wonContacts || [])) if (c.assigned_rep) dealsByRep.set(c.assigned_rep, (dealsByRep.get(c.assigned_rep) || 0) + 1)
    for (const a of (apprRows || [])) if (a.created_by) apprByRep.set(a.created_by, (apprByRep.get(a.created_by) || 0) + 1)

    const rows = await Promise.all(members.map(async (m) => {
      const { count: posted } = await supabaseAdmin
        .from('listings').select('id', { count: 'exact', head: true })
        .eq('posted_by', m.id).eq('status', 'posted')
      const { count: sold } = await supabaseAdmin
        .from('listings').select('id', { count: 'exact', head: true })
        .eq('posted_by', m.id).eq('status', 'sold')
      const { count: total } = await supabaseAdmin
        .from('listings').select('id', { count: 'exact', head: true })
        .eq('posted_by', m.id)
      const { count: recentLogins } = await supabaseAdmin
        .from('logins').select('id', { count: 'exact', head: true })
        .eq('user_id', m.id).gte('created_at', fourteenDaysAgo)
      return {
        id: m.id,
        name: m.full_name,
        role: m.role,
        total_listings: total || 0,
        active_listings: posted || 0,
        sold_listings: sold || 0,
        deals_closed: dealsByRep.get(m.id) || 0,
        appraisals: apprByRep.get(m.id) || 0,
        recent_logins: recentLogins || 0,
        conversion_rate: (total || 0) > 0
          ? Math.round(((sold || 0) / (total || 0)) * 100)
          : 0
      }
    }))

    // Points mirror the frontend legend: listing·100 + FB-sold·500 + deal·500 + appraisal·50.
    const pointsOf = (r) => (r.total_listings * 100) + (r.sold_listings * 500) + (r.deals_closed * 500) + (r.appraisals * 50)
    const ranking = rows
      .slice()
      .sort((a, b) =>
        pointsOf(b) - pointsOf(a)
        || b.deals_closed - a.deals_closed
        || b.sold_listings - a.sold_listings
        || b.recent_logins - a.recent_logins
        || a.name.localeCompare(b.name)
      )
      .map((r, i) => ({ ...r, rank: i + 1 }))

    const totalListings = rows.reduce((s, r) => s + r.total_listings, 0)
    const totalSold = rows.reduce((s, r) => s + r.sold_listings, 0)
    const totalDeals = rows.reduce((s, r) => s + r.deals_closed, 0)
    const totalAppraisals = rows.reduce((s, r) => s + r.appraisals, 0)

    res.json({
      ranking,
      total_members: members.length,
      team_total_listings: totalListings,
      team_total_sold: totalSold,
      team_total_deals: totalDeals,
      team_total_appraisals: totalAppraisals,
      team_conversion_rate: totalListings > 0
        ? Math.round((totalSold / totalListings) * 100)
        : 0
    })
    } catch (e) {
      console.error('[dealership/leaderboard] failed:', e.message)
      res.json({ ranking: [], total_members: members.length })
    }
  })

  app.get('/dealership/activity', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.json({ events: [] })
    if (req.profile.dealerships?.is_personal === true) return res.json({ events: [] })

    const { data: members } = await supabaseAdmin
      .from('profiles').select('id, full_name').eq('dealership_id', req.dealershipId)
    if (!members?.length) return res.json({ events: [] })

    const memberMap = new Map(members.map(m => [m.id, m.full_name]))
    const memberIds = members.map(m => m.id)

    const { data: listings } = await supabaseAdmin
      .from('listings')
      .select('id, status, posted_at, deleted_at, posted_by, vehicle_label, inventory!listings_inventory_id_fkey(year, make, model)')
      .in('posted_by', memberIds)
      .order('posted_at', { ascending: false })
      .limit(50)

    const events = []
    for (const l of listings || []) {
      // Prefer the live inventory row; fall back to the snapshotted vehicle_label on the listing
      // (vehicle_label is set when finalizeSold runs, so sold/deleted vehicles still show)
      const liveLabel = `${l.inventory?.year || ''} ${l.inventory?.make || ''} ${l.inventory?.model || ''}`.trim()
      const vehicle = liveLabel || l.vehicle_label || 'Vehicle'
      const userName = memberMap.get(l.posted_by) || 'Unknown'
      if (l.posted_at) {
        events.push({ type: 'posted', user_name: userName, vehicle, timestamp: l.posted_at, points: 100 })
      }
      if (l.status === 'sold' && l.deleted_at) {
        events.push({ type: 'sold', user_name: userName, vehicle, timestamp: l.deleted_at, points: 500 })
      }
    }
    events.sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''))
    res.json({ events: events.slice(0, 25) })
  })

  app.get('/dealership/charts', requireAuth, async (req, res) => {
    if (!['DEALER_ADMIN', 'OWNER', 'MANAGER'].includes(req.profile.role)) {
      return res.status(403).json({ error: 'Admins only' })
    }
    if (!req.dealershipId) return res.json({ daily: [], by_rep: [] })

    // Honor the same ?range= filter as /dashboard/insights. Lifetime means no filter.
    const rangeParam = String(req.query.range || 'lifetime').toLowerCase()
    const rangeDays = ({ '7': 7, '30': 30, '90': 90, '365': 365, '1y': 365 }[rangeParam]) || null
    const rangeStartMs = rangeDays ? Date.now() - rangeDays * 24 * 60 * 60 * 1000 : null
    const rangeStart = rangeStartMs ? new Date(rangeStartMs).toISOString() : null

    // Daily bucket window matches the range when set, else default 30d for the line chart.
    const dailyWindow = rangeDays || 30
    const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString()

    const { data: members } = await supabaseAdmin
      .from('profiles').select('id, full_name').eq('dealership_id', req.dealershipId)
    if (!members?.length) return res.json({ daily: [], by_rep: [] })
    const memberIds = members.map(m => m.id)

    // Daily posts buckets
    let dailyQuery = supabaseAdmin.from('listings').select('posted_at, posted_by').in('posted_by', memberIds)
    const dailyWindowStart = new Date(Date.now() - dailyWindow * 24 * 60 * 60 * 1000).toISOString()
    dailyQuery = dailyQuery.gte('posted_at', dailyWindowStart)
    const { data: recentListings } = await dailyQuery

    const dayBuckets = new Map()
    for (let i = dailyWindow - 1; i >= 0; i--) {
      const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000)
      dayBuckets.set(d.toISOString().slice(0, 10), 0)
    }
    for (const l of recentListings || []) {
      const key = (l.posted_at || '').slice(0, 10)
      if (dayBuckets.has(key)) dayBuckets.set(key, dayBuckets.get(key) + 1)
    }

    // Active days per rep (from logins, last 14 days) — independent of listings
    const { data: logins14 } = await supabaseAdmin
      .from('logins').select('user_id, created_at')
      .in('user_id', memberIds).gte('created_at', fourteenDaysAgo)
    const activeDaysByRep = new Map(members.map(m => [m.id, new Set()]))
    for (const l of logins14 || []) {
      const day = (l.created_at || '').slice(0, 10)
      if (day && activeDaysByRep.has(l.user_id)) activeDaysByRep.get(l.user_id).add(day)
    }

    // Per-rep stats — counted the SAME way as /dealership/leaderboard (count by
    // posted_by) so the Players cards and charts always match the leaderboard's
    // points. Range is applied on posted_at (and sold_at for sold counts); lifetime
    // means no date filter. Using reliable COUNT queries per rep instead of a single
    // multi-column row fetch avoids the bucketing bug that zeroed everyone out.
    const repStats = await Promise.all(members.map(async (m) => {
      let listingsQ = supabaseAdmin.from('listings')
        .select('id', { count: 'exact', head: true }).eq('posted_by', m.id)
      if (rangeStart) listingsQ = listingsQ.gte('posted_at', rangeStart)
      const { count: listingsCount } = await listingsQ

      let soldQ = supabaseAdmin.from('listings')
        .select('id', { count: 'exact', head: true }).eq('posted_by', m.id).eq('status', 'sold')
      if (rangeStart) soldQ = soldQ.gte('sold_at', rangeStart)
      const { count: soldCount } = await soldQ

      // Avg time-to-sell (days) across this rep's sold listings in range
      let ttsQ = supabaseAdmin.from('listings')
        .select('created_at, sold_at').eq('posted_by', m.id).eq('status', 'sold')
        .not('sold_at', 'is', null)
      if (rangeStart) ttsQ = ttsQ.gte('sold_at', rangeStart)
      const { data: soldRows } = await ttsQ
      let avgDays = 0
      if (soldRows?.length) {
        const totalMs = soldRows.reduce((acc, r) =>
          acc + Math.max(0, new Date(r.sold_at).getTime() - new Date(r.created_at).getTime()), 0)
        avgDays = Math.round(totalMs / soldRows.length / (1000 * 60 * 60 * 24) * 10) / 10
      }

      return {
        id: m.id,
        name: m.full_name,
        count: listingsCount || 0,
        sold: soldCount || 0,
        activeDays: activeDaysByRep.get(m.id)?.size || 0,
        avgDays
      }
    }))

    const by_rep = repStats
      .map(r => ({ id: r.id, name: r.name, count: r.count }))
      .sort((a, b) => b.count - a.count)
    const sold_by_rep = repStats
      .map(r => ({ name: r.name, count: r.sold }))
      .sort((a, b) => b.count - a.count)
    const active_days_by_rep = repStats
      .map(r => ({ name: r.name, count: r.activeDays }))
      .sort((a, b) => b.count - a.count)
    const sell_through_by_rep = repStats
      .map(r => ({ name: r.name, percent: r.count > 0 ? Math.round((r.sold / r.count) * 1000) / 10 : 0 }))
      .sort((a, b) => b.percent - a.percent)
    const time_to_sell_by_rep = repStats
      .map(r => ({ name: r.name, days: r.avgDays }))
      .sort((a, b) => a.days - b.days)  // ascending — faster sellers first

    res.json({
      range: rangeDays ? String(rangeDays) : 'lifetime',
      daily_window_days: dailyWindow,
      daily: [...dayBuckets.entries()].map(([date, count]) => ({ date, count })),
      by_rep,
      sold_by_rep,
      active_days_by_rep,
      sell_through_by_rep,
      time_to_sell_by_rep
    })
  })

  app.get('/me/stats', requireAuth, async (req, res) => {
    const stats = await buildUserStats(req.user.id)
    res.json(stats)
  })

  // Personal chart data for the solo/rep insights page: posts & sales over time +
  // a status breakdown. Mirrors what dealer admins get, scoped to this one user.
  app.get('/me/charts', requireAuth, async (req, res) => {
    try {
      const range = String(req.query.range || 'lifetime')
      const { data: rows, error } = await supabaseAdmin
        .from('listings')
        .select('status, posted_at, deleted_at')
        .eq('posted_by', req.user.id)
      if (error) return res.status(500).json({ error: error.message })
      const listings = rows || []

      const breakdown = { active: 0, sold: 0, deleted: 0 }
      for (const l of listings) {
        if (l.status === 'sold') breakdown.sold++
        else if (l.status === 'deleted') breakdown.deleted++
        else breakdown.active++
      }

      const days = range === '7' ? 7 : range === '30' ? 30 : range === '90' ? 90 : range === '365' ? 365 : null
      const monthly = days === null || days > 90       // lifetime / 1y → monthly buckets
      const since = days ? Date.now() - days * 86400000 : null
      const keyOf = (iso) => new Date(iso).toISOString().slice(0, monthly ? 7 : 10)

      const buckets = new Map()
      const bump = (iso, field) => {
        if (!iso) return
        if (since && new Date(iso).getTime() < since) return
        const k = keyOf(iso)
        const b = buckets.get(k) || { date: k, posted: 0, sold: 0 }
        b[field]++
        buckets.set(k, b)
      }
      for (const l of listings) {
        bump(l.posted_at, 'posted')
        if (l.status === 'sold') bump(l.deleted_at || l.posted_at, 'sold')
      }
      const trend = [...buckets.values()].sort((a, b) => a.date.localeCompare(b.date))
      res.json({ trend, breakdown, monthly })
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  // ── Global leaderboard ─────────────────────────────────────────────────────────
  // Platform-wide ranking of every rep and every dealership. ANONYMIZED: each caller
  // sees only their OWN name; everyone else shows as "Rep #N" / "Dealer #N". Lets solo
  // reps and dealers see how they stack up against the whole network without exposing
  // competitors' identities. Points = listings·100 + sold·500 (same as team board).
  app.get('/leaderboard/global', requireAuth, async (req, res) => {
    try {
      const [{ data: listings }, { data: profiles }] = await Promise.all([
        supabaseAdmin.from('listings').select('posted_by, status'),
        supabaseAdmin.from('profiles').select('id, full_name, display_name, avatar_url, dealership_id, dealerships(name, is_personal)')
      ])
      const profById = new Map((profiles || []).map(p => [p.id, p]))

      // Tally listings + sold per rep (include current user even with 0 activity).
      const repTally = new Map()
      // Seed the current user so they always appear on the reps board
      if (!repTally.has(req.user.id)) repTally.set(req.user.id, { posted: 0, sold: 0 })
      for (const l of listings || []) {
        if (!l.posted_by) continue
        const t = repTally.get(l.posted_by) || { posted: 0, sold: 0 }
        t.posted++
        if (l.status === 'sold') t.sold++
        repTally.set(l.posted_by, t)
      }
      const pts = (t) => t.posted * 100 + t.sold * 500
      const displayName = (p) => p?.display_name || p?.full_name || null

      // Reps board — every rep with activity (+ current user seeded above).
      const reps = [...repTally.entries()].map(([uid, t]) => {
        const p = profById.get(uid)
        return { uid, points: pts(t), sold: t.sold, posted: t.posted,
          name: displayName(p) || 'Rep', avatar_url: p?.avatar_url || null, isYou: uid === req.user.id }
      }).sort((a, b) => b.points - a.points || b.sold - a.sold)

      // Dealers board — roll reps up into their (non-personal) dealership.
      const dealerTally = new Map()
      // Seed current dealership so admin always appears even with 0 rep activity
      if (req.dealershipId) {
        const myProf = profById.get(req.user.id)
        if (myProf?.dealerships && !myProf.dealerships.is_personal) {
          dealerTally.set(req.dealershipId, { points: 0, sold: 0, posted: 0, name: myProf.dealerships.name || 'Your Dealership' })
        }
      }
      for (const [uid, t] of repTally.entries()) {
        const p = profById.get(uid)
        if (!p?.dealership_id || p.dealerships?.is_personal) continue
        const d = dealerTally.get(p.dealership_id) || { points: 0, sold: 0, posted: 0, name: p.dealerships?.name || 'Dealer' }
        d.points += pts(t); d.sold += t.sold; d.posted += t.posted
        dealerTally.set(p.dealership_id, d)
      }
      const dealers = [...dealerTally.entries()].map(([did, d]) => ({
        did, ...d, isYou: did === req.dealershipId
      })).sort((a, b) => b.points - a.points || b.sold - a.sold)

      const repsOut = reps.map((r, i) => ({
        rank: i + 1, points: r.points, sold: r.sold, posted: r.posted,
        isYou: r.isYou,
        // Show display_name if set (they opted in to be identified); otherwise anonymize
        name: r.isYou ? (r.name || 'You') : (profById.get(r.uid)?.display_name || `Rep #${i + 1}`),
        avatar_url: r.avatar_url || null
      }))
      const dealersOut = dealers.map((d, i) => ({
        rank: i + 1, points: d.points, sold: d.sold, posted: d.posted,
        isYou: d.isYou, name: d.isYou ? (d.name || 'Your dealership') : `Dealer #${i + 1}`
      }))

      const avg = (arr, key) => arr.length ? Math.round(arr.reduce((s, r) => s + (r[key] || 0), 0) / arr.length) : 0
      const avgConv = (arr) => {
        const active = arr.filter(r => r.posted > 0)
        return active.length ? Math.round(active.reduce((s, r) => s + (r.sold / r.posted) * 100, 0) / active.length) : 0
      }
      res.json({
        total_reps: repsOut.length,
        total_dealers: dealersOut.length,
        reps: repsOut.slice(0, 100),
        dealers: dealersOut.slice(0, 100),
        you_rep: repsOut.find(r => r.isYou) || null,
        you_dealer: dealersOut.find(d => d.isYou) || null,
        avg_rep_points: avg(repsOut, 'points'),
        avg_rep_posted: avg(repsOut, 'posted'),
        avg_rep_sold: avg(repsOut, 'sold'),
        avg_rep_conv: avgConv(repsOut),
        avg_dealer_points: avg(dealersOut, 'points'),
        avg_dealer_posted: avg(dealersOut, 'posted'),
        avg_dealer_sold: avg(dealersOut, 'sold'),
        avg_dealer_conv: avgConv(dealersOut),
      })
    } catch (e) {
      console.error('[leaderboard/global] failed:', e.message)
      res.status(500).json({ error: e.message })
    }
  })

  // ── Gamification: achievement badges (rep level + dealership level) ────────────
  // Everything is DERIVED from data we already write (listings, trade_appraisals,
  // inventory) and scoped to ONE dealership, so the queries are bounded — no new
  // tables, no platform-wide aggregates. Cached 10 min per dealership to keep the
  // 512MB box calm even if the whole team opens the page at once.
  const _gamCache = new Map()   // dealershipId -> { exp, data }
  const GAM_TTL_MS = 10 * 60 * 1000
  const HR = 60 * 60 * 1000

  // Ascending badge (higher value = better). Returns level (0..N) + progress to next.
  const ascBadge = (key, icon, label, description, value, thresholds, unit = '') => {
    let level = 0
    for (const t of thresholds) if (value >= t) level++
    const next = thresholds[level] ?? null
    const prev = level > 0 ? thresholds[level - 1] : 0
    const progress_pct = next == null ? 100
      : Math.max(0, Math.min(100, Math.round(((value - prev) / (next - prev)) * 100)))
    return { key, icon, label, description, value, unit, level, max_level: thresholds.length, thresholds, next, progress_pct }
  }
  // Descending badge (lower value = better, e.g. hours-to-post). thresholds hardest last.
  const descBadge = (key, icon, label, description, value, thresholds, unit = '') => {
    let level = 0
    if (value != null) for (const t of thresholds) if (value <= t) level++
    const next = thresholds[level] ?? null
    return { key, icon, label, description, value, unit, level, max_level: thresholds.length, thresholds, next, progress_pct: null }
  }

  app.get('/gamification', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.json({ me: null, dealership: null })
    try {
      const cached = _gamCache.get(req.dealershipId)
      if (cached && cached.exp > Date.now()) {
        const me = cached.data.repBadges[req.user.id] || cached.data.emptyMe(req)
        return res.json({ dealership: cached.data.dealership, me })
      }

      const { data: members } = await supabaseAdmin
        .from('profiles').select('id, full_name').eq('dealership_id', req.dealershipId)
      const memberIds = (members || []).map(m => m.id)
      const nameOf = new Map((members || []).map(m => [m.id, m.full_name]))

      // One bounded pull of the team's listings (+ the inventory add-date for the
      // speed-to-market metric), plus appraisals and the available-inventory count.
      const [{ data: listings }, { data: appraisals }, { count: availCount }] = await Promise.all([
        memberIds.length ? supabaseAdmin
          .from('listings')
          .select('posted_by, status, posted_at, inventory:inventory_id(created_at)')
          .in('posted_by', memberIds).limit(20000)
          : Promise.resolve({ data: [] }),
        supabaseAdmin
          .from('trade_appraisals').select('created_by').eq('dealership_id', req.dealershipId).limit(20000),
        supabaseAdmin
          .from('inventory').select('id', { count: 'exact', head: true })
          .eq('dealership_id', req.dealershipId).eq('status', 'available'),
      ])

      // Per-rep aggregation.
      const agg = new Map()   // repId -> { posted, sold, apprs, fastFlags:[{t,fast}] }
      const bump = (id) => { if (!agg.has(id)) agg.set(id, { posted: 0, sold: 0, apprs: 0, fastFlags: [] }); return agg.get(id) }
      for (const l of listings || []) {
        const a = bump(l.posted_by)
        a.posted++
        if (l.status === 'sold') a.sold++
        const addedAt = l.inventory?.created_at
        if (l.posted_at && addedAt) {
          a.fastFlags.push({ t: l.posted_at, fast: (new Date(l.posted_at) - new Date(addedAt)) <= 24 * HR })
        }
      }
      for (const ap of appraisals || []) { if (ap.created_by) bump(ap.created_by).apprs++ }

      // Current speed-to-market streak = consecutive most-recent posts under 24h.
      const streakOf = (flags) => {
        const ordered = flags.slice().sort((x, y) => (y.t || '').localeCompare(x.t || ''))
        let s = 0
        for (const f of ordered) { if (f.fast) s++; else break }
        return s
      }

      const repBadgesFor = (id) => {
        const a = agg.get(id) || { posted: 0, sold: 0, apprs: 0, fastFlags: [] }
        return [
          ascBadge('closer', '🏆', 'Closer', 'Cars you\'ve sold', a.sold, [10, 50, 250], 'sold'),
          ascBadge('mover', '📣', 'Marketplace Mover', 'Cars you\'ve posted to Facebook', a.posted, [25, 100, 500], 'posted'),
          ascBadge('speed', '⚡', 'Speed to Market', 'Consecutive cars posted within 24h of hitting inventory', streakOf(a.fastFlags), [5, 15, 40], 'streak'),
          ascBadge('hunter', '🔍', 'Trade Hunter', 'Trade appraisals completed', a.apprs, [10, 50, 200], 'appraisals'),
        ]
      }

      // Build a badge map for every rep (so the cache serves any rep instantly).
      const repBadges = {}
      for (const id of memberIds) repBadges[id] = { name: nameOf.get(id) || 'You', badges: repBadgesFor(id) }

      // ── Dealership-level badges ──
      const teamSold = [...agg.values()].reduce((s, a) => s + a.sold, 0)
      // Sold this (calendar) month, team-wide.
      const monthStart = new Date(); monthStart.setUTCDate(1); monthStart.setUTCHours(0, 0, 0, 0)
      let soldThisMonth = 0
      for (const l of listings || []) {
        if (l.status === 'sold' && l.posted_at && new Date(l.posted_at) >= monthStart) soldThisMonth++
      }
      // Coverage = posted listings / available inventory (capped at 100%).
      const postedCount = (listings || []).filter(l => l.status === 'posted').length
      const coverage = availCount ? Math.min(100, Math.round((postedCount / availCount) * 100)) : 0
      // Median hours-to-post across the team.
      const gaps = (listings || [])
        .filter(l => l.posted_at && l.inventory?.created_at)
        .map(l => (new Date(l.posted_at) - new Date(l.inventory.created_at)) / HR)
        .filter(h => h >= 0).sort((x, y) => x - y)
      const medianGap = gaps.length ? Math.round(gaps[Math.floor(gaps.length / 2)]) : null

      const dealershipBadges = [
        ascBadge('coverage', '🛡️', 'Full Coverage', 'Share of available inventory listed on Facebook', coverage, [60, 80, 95], '%'),
        descBadge('fastlot', '🏁', 'Fast Lot', 'Median hours from inventory add to Facebook post (lower is better)', medianGap, [48, 24, 6], 'h'),
        ascBadge('sellthrough', '💰', 'Sell-Through', 'Cars sold this month', soldThisMonth, [5, 15, 40], 'this month'),
      ]

      const dealerName = req.profile?.dealerships?.name || 'Your dealership'
      const data = {
        repBadges,
        emptyMe: (r) => ({ name: r.profile?.full_name || 'You', badges: repBadgesFor('__none__') }),
        dealership: { name: dealerName, badges: dealershipBadges, team_sold: teamSold, coverage },
      }
      _gamCache.set(req.dealershipId, { exp: Date.now() + GAM_TTL_MS, data })
      res.json({ dealership: data.dealership, me: repBadges[req.user.id] || data.emptyMe(req) })
    } catch (e) {
      console.error('[gamification] failed:', e.message)
      res.status(500).json({ error: e.message })
    }
  })

  // ── Sync health / staleness monitor ───────────────────────────────────────────
  // Server-side feeds refresh every night hands-off. Cloudflare feeds
  // (needs_extension_capture) only refresh when a rep's Chrome is open, so they can
  // silently go stale. This surfaces that so the dashboard can nudge the rep to open
  // MarketSync and sync — turning "stale for days, nobody noticed" into an alert.
  app.get('/dashboard/sync-health', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.json({ needs_browser: false, stale: false })
    try {
      const { data: feeds } = await supabaseAdmin
        .from('inventory_feeds')
        .select('platform, last_extension_sync_at, source_dealer_url, feed_url')
        .eq('dealership_id', req.dealershipId)
      const browserFeeds = (feeds || []).filter(f => f.platform === 'needs_extension_capture')
      if (!browserFeeds.length) return res.json({ needs_browser: false, stale: false })

      const staleHours = Number(process.env.EXT_STALE_HOURS || 36)
      const now = Date.now()
      let worst = 0
      let neverSynced = false
      for (const f of browserFeeds) {
        if (!f.last_extension_sync_at) { neverSynced = true; worst = Math.max(worst, 9999); continue }
        const h = (now - new Date(f.last_extension_sync_at).getTime()) / 3600000
        worst = Math.max(worst, h)
      }
      const stale = neverSynced || worst > staleHours
      const days = Math.floor(worst / 24)
      const openUrl = browserFeeds[0]?.source_dealer_url || browserFeeds[0]?.feed_url || null
      res.json({
        needs_browser: true,
        stale,
        worst_hours: Math.round(worst),
        message: !stale ? null
          : neverSynced
            ? 'This dealer’s inventory hasn’t synced yet. Open MarketSync in Chrome and connect the dealer site to pull inventory.'
            : `This dealer’s inventory hasn’t refreshed in ${days >= 1 ? days + ' day' + (days > 1 ? 's' : '') : Math.round(worst) + ' hours'}. Open MarketSync in Chrome to sync.`,
        open_url: openUrl,
      })
    } catch (e) {
      console.error('[sync-health] failed:', e.message)
      res.json({ needs_browser: false, stale: false })
    }
  })

  app.get('/dashboard/insights', requireAuth, async (req, res) => {
    const isAdmin = ['DEALER_ADMIN', 'OWNER', 'MANAGER'].includes(req.profile.role)
    const now = new Date()

    // Time range filter: lifetime | 365 | 90 | 30 | 7 (days). Defaults to lifetime.
    // Returns ISO `start` so we can re-apply it to .gte() consistently across queries.
    const rangeParam = String(req.query.range || 'lifetime').toLowerCase()
    const rangeDays = ({ '7': 7, '30': 30, '90': 90, '365': 365, '1y': 365 }[rangeParam]) || null
    const rangeStart = rangeDays
      ? new Date(now.getTime() - rangeDays * 24 * 60 * 60 * 1000).toISOString()
      : null
    const rangeLabel = rangeDays ? `last ${rangeDays} days` : 'lifetime'

    const day = now.getUTCDay() || 7
    const startOfWeek = new Date(Date.UTC(
      now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (day - 1)
    )).toISOString()

    let inventorySynced = 0, inventoryAvailable = 0, listingsPosted = 0
    let soldThisMonth = 0, activeDaysThisWeek = 0, listingsByAdmin = 0, listingsByReps = 0
    let avgTimeToSellDays = null, postsPerDay = 0, sellThroughRate = 0
    let inventoryAged60d = 0
    const warnings = {}

    // Helper: apply rangeStart filter to a supabase query builder
    const withRange = (q, col = 'created_at') => rangeStart ? q.gte(col, rangeStart) : q

    try {
      if (req.dealershipId) {
        const { count, error } = await supabaseAdmin
          .from('inventory').select('id', { count: 'exact', head: true })
          .eq('dealership_id', req.dealershipId)
        if (error) warnings.inventory_total = error.message
        else inventorySynced = count || 0

        const { count: avail, error: availErr } = await supabaseAdmin
          .from('inventory').select('id', { count: 'exact', head: true })
          .eq('dealership_id', req.dealershipId)
          .eq('status', 'available')
        if (availErr) warnings.inventory_available = availErr.message
        else inventoryAvailable = avail || 0

        // Aged inventory: available cars on the lot more than 60 days. Age from the
        // true lot date when the feed gave us one, else created_at (first-seen).
        const sixtyDaysAgoMs = now.getTime() - 60 * 24 * 60 * 60 * 1000
        const { data: availRows, error: agedErr } = await supabaseAdmin
          .from('inventory').select('lot_date, created_at')
          .eq('dealership_id', req.dealershipId)
          .eq('status', 'available')
        if (agedErr) warnings.inventory_aged = agedErr.message
        else inventoryAged60d = (availRows || []).filter(r => {
          const ref = r.lot_date || r.created_at
          return ref && new Date(ref).getTime() < sixtyDaysAgoMs
        }).length
      }
    } catch (e) { warnings.inventory = e.message }

    try {
      if (isAdmin && req.dealershipId) {
        const { data: members, error: memErr } = await supabaseAdmin
          .from('profiles').select('id, role').eq('dealership_id', req.dealershipId)
        if (memErr) {
          warnings.listings = memErr.message
        } else {
          const memberIds = (members || []).map(m => m.id)
          const adminIds = (members || [])
            .filter(m => m.role === 'DEALER_ADMIN' || m.role === 'OWNER')
            .map(m => m.id)
          const repIds = (members || [])
            .filter(m => m.role === 'SALES_REP')
            .map(m => m.id)

          if (memberIds.length) {
            const { count: total } = await withRange(
              supabaseAdmin.from('listings').select('id', { count: 'exact', head: true })
                .in('posted_by', memberIds)
            )
            listingsPosted = total || 0

            const { count: sold } = await withRange(
              supabaseAdmin.from('listings').select('id', { count: 'exact', head: true })
                .in('posted_by', memberIds).eq('status', 'sold')
            , 'sold_at')
            soldThisMonth = sold || 0

            // Avg time-to-sell: pull sold rows in range, compute (sold_at - created_at) avg in days
            const soldQuery = supabaseAdmin
              .from('listings').select('created_at, sold_at')
              .in('posted_by', memberIds).eq('status', 'sold')
              .not('sold_at', 'is', null)
            const { data: soldRows } = await withRange(soldQuery, 'sold_at')
            if (soldRows && soldRows.length) {
              const totalMs = soldRows.reduce((acc, r) => {
                const diff = new Date(r.sold_at).getTime() - new Date(r.created_at).getTime()
                return acc + Math.max(0, diff)
              }, 0)
              avgTimeToSellDays = Math.round(totalMs / soldRows.length / (1000 * 60 * 60 * 24) * 10) / 10
            }
          }
          if (adminIds.length) {
            const { count } = await withRange(
              supabaseAdmin.from('listings').select('id', { count: 'exact', head: true })
                .in('posted_by', adminIds)
            )
            listingsByAdmin = count || 0
          }
          if (repIds.length) {
            const { count } = await withRange(
              supabaseAdmin.from('listings').select('id', { count: 'exact', head: true })
                .in('posted_by', repIds)
            )
            listingsByReps = count || 0
          }
        }
      } else {
        const { count: total, error: totalErr } = await withRange(
          supabaseAdmin.from('listings').select('id', { count: 'exact', head: true })
            .eq('posted_by', req.user.id)
        )
        if (totalErr) warnings.listings = totalErr.message
        else listingsPosted = total || 0

        const { count: sold, error: soldErr } = await withRange(
          supabaseAdmin.from('listings').select('id', { count: 'exact', head: true })
            .eq('posted_by', req.user.id).eq('status', 'sold')
        , 'sold_at')
        if (soldErr) warnings.sold = soldErr.message
        else soldThisMonth = sold || 0

        const { data: soldRows } = await withRange(
          supabaseAdmin.from('listings').select('created_at, sold_at')
            .eq('posted_by', req.user.id).eq('status', 'sold')
            .not('sold_at', 'is', null)
        , 'sold_at')
        if (soldRows && soldRows.length) {
          const totalMs = soldRows.reduce((acc, r) =>
            acc + Math.max(0, new Date(r.sold_at).getTime() - new Date(r.created_at).getTime()), 0)
          avgTimeToSellDays = Math.round(totalMs / soldRows.length / (1000 * 60 * 60 * 24) * 10) / 10
        }
      }
    } catch (e) { warnings.listings = e.message }

    // Derived metrics
    if (listingsPosted > 0 && rangeDays) {
      postsPerDay = Math.round((listingsPosted / rangeDays) * 10) / 10
    }
    if (listingsPosted > 0) {
      sellThroughRate = Math.round((soldThisMonth / listingsPosted) * 1000) / 10  // e.g. 23.4 (%)
    }


    try {
      const { data, error } = await supabaseAdmin
        .from('logins')
        .select('created_at')
        .eq('user_id', req.user.id)
        .gte('created_at', startOfWeek)
      if (error) warnings.logins = error.message
      else {
        const distinctDays = new Set((data || []).map(l => l.created_at.slice(0, 10)))
        activeDaysThisWeek = distinctDays.size
      }
    } catch (e) { warnings.logins = e.message }

    if (Object.keys(warnings).length) {
      console.warn('Insights partial:', { user: req.user.id, role: req.profile.role, warnings })
    }

    res.json({
      range: rangeDays ? String(rangeDays) : 'lifetime',
      range_label: rangeLabel,
      inventory_available: inventoryAvailable,
      inventory_synced: inventorySynced,
      inventory_aged_60d: inventoryAged60d,
      listings_posted: listingsPosted,
      listings_by_admin: listingsByAdmin,
      listings_by_reps: listingsByReps,
      sold_this_month: soldThisMonth,
      avg_time_to_sell_days: avgTimeToSellDays,
      posts_per_day: postsPerDay,
      sell_through_rate: sellThroughRate,
      active_days_this_week: activeDaysThisWeek,
      scope: isAdmin ? 'dealership' : 'personal',
      warnings: Object.keys(warnings).length ? warnings : undefined
    })
  })

  app.get('/dealership/team/:userId/stats', requireAuth, async (req, res) => {
    if (!['DEALER_ADMIN', 'OWNER', 'MANAGER'].includes(req.profile.role)) {
      return res.status(403).json({ error: 'Admins only' })
    }

    const { data: target } = await supabaseAdmin
      .from('profiles')
      .select('id, full_name, role, dealership_id, created_at')
      .eq('id', req.params.userId)
      .single()
    if (!target || target.dealership_id !== req.dealershipId) {
      return res.status(404).json({ error: 'User not found in your dealership' })
    }

    const { data: authUser } = await supabaseAdmin.auth.admin
      .getUserById(req.params.userId).catch(() => ({ data: null }))
    const stats = await buildUserStats(req.params.userId)
    res.json({
      profile: {
        id: target.id,
        full_name: target.full_name,
        email: authUser?.user?.email || null,
        role: target.role,
        joined_at: target.created_at
      },
      ...stats
    })
  })

  // ── Executive ROI dashboard (managers) — proves the platform is paying off ───
  // Every metric here is computed from data we already capture, so the numbers are
  // real, not modelled: speed-to-lead, lead volume, conversion, days-to-sell,
  // marketplace posts, appraisals, follow-up completion, repricing signals, and
  // (once captured) attributed sales by source.
  app.get('/dashboard/executive', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.json({ ok: true, empty: true })
    const isMgr = ['DEALER_ADMIN', 'OWNER', 'MANAGER'].includes(req.profile?.role)
    const selfId = req.user.id
    const days = ({ '7': 7, '30': 30, '90': 90, '365': 365 }[String(req.query.range || '90')]) || 90
    const now = Date.now()
    const startIso = new Date(now - days * 86400000).toISOString()
    const prevStartIso = new Date(now - days * 2 * 86400000).toISOString()
    const did = req.dealershipId

    // Roster (for per-rep names + the leaderboard).
    const { data: staff } = await supabaseAdmin.from('profiles')
      .select('id, full_name, display_name, role, active').eq('dealership_id', did)
    const nameOf = (id) => { const p = (staff || []).find(s => s.id === id); return p ? (p.full_name || p.display_name || '—') : '—' }

    // Contacts (owner + status) → conversion, attribution, and contact→rep map.
    const { data: contactRows } = await supabaseAdmin.from('contacts')
      .select('id, status, assigned_rep, sold_source, sold_at').eq('dealership_id', did).limit(50000)
    const contactRep = {}
    for (const c of (contactRows || [])) if (c.id) contactRep[c.id] = c.assigned_rep || null
    const WON = ['sold', 'fni', 'delivered']
    // A "sale" is a won contact whose deal closed inside the window (sold_at).
    const soldInRange = (c) => WON.includes(c.status) && c.sold_at && c.sold_at >= startIso

    // Leads over the double window; attribute each to the contact's owner (routed
    // rep), falling back to whoever keyed it in.
    const { data: leadRows } = await supabaseAdmin.from('leads')
      .select('id, contact_id, created_by, created_at').eq('dealership_id', did).gte('created_at', prevStartIso).limit(30000)
    const leadRepOf = (l) => (l.contact_id && contactRep[l.contact_id]) || l.created_by || null
    const allCur = (leadRows || []).filter(l => l.created_at >= startIso)
    const allPrev = (leadRows || []).filter(l => l.created_at < startIso)

    // First outbound touch per contact (for speed-to-lead), computed once.
    const firstLeadByContact = {}
    for (const l of allCur) { if (!l.contact_id) continue; const t = new Date(l.created_at).getTime(); if (!firstLeadByContact[l.contact_id] || t < firstLeadByContact[l.contact_id]) firstLeadByContact[l.contact_id] = t }
    const leadContactIds = Object.keys(firstLeadByContact)
    const firstTouch = {}
    if (leadContactIds.length) {
      const { data: comms } = await supabaseAdmin.from('communications')
        .select('contact_id, occurred_at, created_at').eq('dealership_id', did)
        .in('contact_id', leadContactIds.slice(0, 3000)).in('direction', ['out', 'outbound']).limit(50000)
      for (const c of (comms || [])) { const t = new Date(c.occurred_at || c.created_at).getTime(); if (!Number.isFinite(t)) continue; if (!firstTouch[c.contact_id] || t < firstTouch[c.contact_id]) firstTouch[c.contact_id] = t }
    }
    // Speed metrics over an arbitrary lead set → {responded, under5, respTimes}.
    const speedOf = (leads) => {
      let responded = 0, under5 = 0; const respTimes = []
      const seen = new Set()
      for (const l of leads) {
        const cid = l.contact_id; if (!cid || seen.has(cid)) continue; seen.add(cid)
        const touch = firstTouch[cid], lead = firstLeadByContact[cid]
        if (touch && lead && touch >= lead) { const m = (touch - lead) / 60000; responded++; respTimes.push(m); if (m <= 5) under5++ }
      }
      respTimes.sort((a, b) => a - b)
      return { responded, under5, median: respTimes.length ? Math.round(respTimes[Math.floor(respTimes.length / 2)]) : null }
    }

    // Tasks (owner + done) and appraisals (creator) over the window.
    const [{ data: taskRows }, { data: apprRows }, { count: priceFlags }] = await Promise.all([
      supabaseAdmin.from('crm_tasks').select('assigned_to, done').eq('dealership_id', did).gte('created_at', startIso).limit(50000),
      supabaseAdmin.from('trade_appraisals').select('created_by').eq('dealership_id', did).gte('created_at', startIso).limit(50000),
      supabaseAdmin.from('ai_activity').select('id', { count: 'exact', head: true }).eq('dealership_id', did).eq('price_flagged', true).gte('created_at', startIso),
    ])

    // Marketplace posts + days-to-sell (store-wide — listings via this dealer's inventory).
    const { data: invIds } = await supabaseAdmin.from('inventory').select('id').eq('dealership_id', did).limit(5000)
    const ids = (invIds || []).map(v => v.id)
    let mkPosted = 0; const daysSamples = []
    if (ids.length) {
      const { data: listings } = await supabaseAdmin.from('listings')
        .select('inventory_id, posted_at, sold_at').in('inventory_id', ids.slice(0, 5000)).limit(50000)
      for (const l of (listings || [])) {
        if (l.posted_at && l.posted_at >= startIso) mkPosted++
        if (l.sold_at && l.posted_at && l.sold_at >= startIso) { const d = (new Date(l.sold_at) - new Date(l.posted_at)) / 86400000; if (d >= 0 && d < 365) daysSamples.push(d) }
      }
    }
    const avgDaysToSell = daysSamples.length ? Math.round((daysSamples.reduce((a, b) => a + b, 0) / daysSamples.length) * 10) / 10 : null

    // ── Scope the CRM figures: reps see only their own book, managers see all. ──
    const mineLead = (l) => leadRepOf(l) === selfId
    const curLeads = isMgr ? allCur : allCur.filter(mineLead)
    const prevLeads = isMgr ? allPrev : allPrev.filter(mineLead)
    const contacts = isMgr ? (contactRows || []) : (contactRows || []).filter(c => c.assigned_rep === selfId)
    const tasks = isMgr ? (taskRows || []) : (taskRows || []).filter(t => t.assigned_to === selfId)
    const appraisals = isMgr ? (apprRows || []) : (apprRows || []).filter(a => a.created_by === selfId)

    const sp = speedOf(curLeads)
    const under5Pct = sp.responded ? Math.round((sp.under5 / sp.responded) * 100) : 0
    const respRate = curLeads.length ? Math.round((sp.responded / curLeads.length) * 100) : 0
    const wonRows = contacts.filter(c => WON.includes(c.status))          // snapshot → conversion
    const salesInRange = contacts.filter(soldInRange)                      // period-bound → sales
    const conversionPct = contacts.length ? Math.round((wonRows.length / contacts.length) * 1000) / 10 : 0
    const sourceMap = {}
    for (const c of salesInRange) { const s = c.sold_source || 'Unattributed'; sourceMap[s] = (sourceMap[s] || 0) + 1 }
    const sold_by_source = Object.entries(sourceMap).map(([k, v]) => ({ source: k, count: v })).sort((a, b) => b.count - a.count)
    const taskTotal = tasks.length, taskDone = tasks.filter(t => t.done).length
    const followupPct = taskTotal ? Math.round((taskDone / taskTotal) * 100) : 0

    // ── Per-rep breakdown (managers only): the "sales per salesperson" report. ──
    let per_rep = []
    if (isMgr) {
      const acc = {}
      const bump = (id) => (acc[id] = acc[id] || { rep_id: id, leads: 0, responded: 0, under5: 0, deals: 0, tasks_total: 0, tasks_done: 0, appraisals: 0 })
      for (const l of allCur) { const r = leadRepOf(l); if (r) bump(r).leads++ }
      // speed per rep: attribute each responded contact to its owner
      const seen = new Set()
      for (const l of allCur) {
        const cid = l.contact_id; if (!cid || seen.has(cid)) continue; seen.add(cid)
        const r = contactRep[cid]; if (!r) continue
        const touch = firstTouch[cid], lead = firstLeadByContact[cid]
        if (touch && lead && touch >= lead) { bump(r).responded++; if ((touch - lead) / 60000 <= 5) bump(r).under5++ }
      }
      for (const c of (contactRows || [])) if (c.assigned_rep && soldInRange(c)) bump(c.assigned_rep).deals++
      for (const t of (taskRows || [])) if (t.assigned_to) { const a = bump(t.assigned_to); a.tasks_total++; if (t.done) a.tasks_done++ }
      for (const a of (apprRows || [])) if (a.created_by) bump(a.created_by).appraisals++
      per_rep = Object.values(acc)
        .filter(r => (staff || []).some(s => s.id === r.rep_id && s.role !== 'DEALER_GROUP'))
        .map(r => ({
          rep_id: r.rep_id, name: nameOf(r.rep_id), leads: r.leads, deals: r.deals, appraisals: r.appraisals,
          under_5min_pct: r.responded ? Math.round((r.under5 / r.responded) * 100) : 0,
          followup_pct: r.tasks_total ? Math.round((r.tasks_done / r.tasks_total) * 100) : 0,
        }))
        .sort((a, b) => b.deals - a.deals || b.leads - a.leads)
    }
    const totalSales = (contactRows || []).filter(soldInRange).length

    res.json({
      ok: true, range_days: days, is_manager: isMgr,
      leads: {
        total: curLeads.length, prev_total: prevLeads.length,
        trend_pct: prevLeads.length ? Math.round(((curLeads.length - prevLeads.length) / prevLeads.length) * 100) : (curLeads.length ? 100 : 0),
        response_rate_pct: respRate, under_5min_pct: under5Pct, responded: sp.responded, median_response_min: sp.median,
      },
      pipeline: { total_contacts: contacts.length, won: wonRows.length, conversion_pct: conversionPct, sold_by_source },
      inventory: { marketplace_posted: mkPosted, avg_days_to_sell: avgDaysToSell, days_sold_count: daysSamples.length, repricing_signals: priceFlags || 0 },
      activity: { appraisals: appraisals.length, followup_completion_pct: followupPct, tasks_total: taskTotal, tasks_done: taskDone },
      sales: { total: isMgr ? totalSales : wonRows.length },
      per_rep,
    })
  })

  // ── Inventory mix & aging report (managers) ─────────────────────────────────
  // The classic lot breakdown: age buckets (0-30 / 31-60 / 61-90 / 90+), plus mix
  // by colour, by mileage band, and by make — count, value, and average age each.
  app.get('/dashboard/inventory-mix', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.json({ ok: true, empty: true })
    if (!['DEALER_ADMIN', 'OWNER', 'MANAGER'].includes(req.profile?.role)) return res.status(403).json({ error: 'Manager access required' })
    const { data: dealer } = await supabaseAdmin.from('dealerships').select('country').eq('id', req.dealershipId).maybeSingle()
    const c = (dealer?.country || '').trim().toUpperCase()
    const isUS = c === 'US' || c === 'USA' || c === 'UNITED STATES'
    const unit = isUS ? 'mi' : 'km'

    const { data: inv } = await supabaseAdmin.from('inventory')
      .select('price, mileage, exterior_color, make, condition, lot_date, created_at, last_synced_at')
      .eq('dealership_id', req.dealershipId).eq('status', 'available').is('archived_at', null).limit(20000)
    const list = inv || []
    const now = Date.now()
    const ageOf = (v) => { const ref = v.lot_date || v.created_at || v.last_synced_at; return ref ? Math.floor((now - new Date(ref).getTime()) / 86400000) : 0 }
    const num = (n) => { const x = Number(n); return Number.isFinite(x) ? x : null }

    // Generic bucketer → [{key, count, value, avg_price, avg_age}]
    const groupBy = (rows, keyFn, order) => {
      const m = {}
      for (const v of rows) {
        const k = keyFn(v); if (k == null) continue
        const g = m[k] || (m[k] = { key: k, count: 0, value: 0, priced: 0, ageSum: 0 })
        g.count++; g.ageSum += ageOf(v)
        const p = num(v.price); if (p) { g.value += p; g.priced++ }
      }
      let arr = Object.values(m).map(g => ({
        key: g.key, count: g.count, value: Math.round(g.value),
        avg_price: g.priced ? Math.round(g.value / g.priced) : null,
        avg_age: g.count ? Math.round(g.ageSum / g.count) : null,
      }))
      if (order) arr.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key))
      else arr.sort((a, b) => b.count - a.count)
      return arr
    }

    const ageBucket = (v) => { const d = ageOf(v); return d <= 30 ? '0–30' : d <= 60 ? '31–60' : d <= 90 ? '61–90' : '90+' }
    const AGE_ORDER = ['0–30', '31–60', '61–90', '90+']
    const kmBucket = (v) => {
      const m = num(v.mileage); if (m == null) return 'Unknown'
      return m < 50000 ? `Under 50k` : m < 100000 ? `50–100k` : m < 150000 ? `100–150k` : `150k+`
    }
    const KM_ORDER = ['Under 50k', '50–100k', '100–150k', '150k+', 'Unknown']

    const totalValue = list.reduce((s, v) => s + (num(v.price) || 0), 0)
    const avgAge = list.length ? Math.round(list.reduce((s, v) => s + ageOf(v), 0) / list.length) : 0
    const aged60 = list.filter(v => ageOf(v) > 60).length

    res.json({
      ok: true, distance_unit: unit,
      summary: { total_units: list.length, total_value: Math.round(totalValue), avg_age: avgAge, aged_over_60: aged60 },
      by_age: groupBy(list, ageBucket, AGE_ORDER),
      by_color: groupBy(list, v => (v.exterior_color || '').trim() || 'Unspecified').slice(0, 12),
      by_mileage: groupBy(list, kmBucket, KM_ORDER),
      by_make: groupBy(list, v => (v.make || '').trim() || 'Unspecified').slice(0, 12),
      by_condition: groupBy(list, v => { const x = (v.condition || '').toLowerCase(); return x === 'new' ? 'New' : x === 'demo' ? 'Demo' : x === 'certified' ? 'Certified' : 'Used' }),
    })
  })

  // ── Sales analysis (managers) — what actually sold, sliced by attribute ─────
  // A "sale" is a unit that left the lot: status 'sold' (feed-flagged or manual) or
  // 'archived' (dropped off the feed). Sale date = sold_at ?? archived_at, and
  // days-to-sell = sale date − lot date. Grouped by colour, mileage band, make,
  // condition, and price band — count + avg days-to-sell + total value each.
  app.get('/dashboard/sales-analysis', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.json({ ok: true, empty: true })
    if (!['DEALER_ADMIN', 'OWNER', 'MANAGER'].includes(req.profile?.role)) return res.status(403).json({ error: 'Manager access required' })
    const days = ({ '30': 30, '90': 90, '180': 180, '365': 365 }[String(req.query.range || '90')]) || 90
    const startMs = Date.now() - days * 86400000
    const { data: dealer } = await supabaseAdmin.from('dealerships').select('country').eq('id', req.dealershipId).maybeSingle()
    const c = (dealer?.country || '').trim().toUpperCase()
    const unit = (c === 'US' || c === 'USA' || c === 'UNITED STATES') ? 'mi' : 'km'

    const { data: rows } = await supabaseAdmin.from('inventory')
      .select('price, mileage, exterior_color, make, condition, lot_date, created_at, sold_at, archived_at, last_synced_at, status')
      .eq('dealership_id', req.dealershipId).in('status', ['sold', 'archived']).limit(50000)
    const num = (n) => { const x = Number(n); return Number.isFinite(x) ? x : null }
    // Keep only units whose sale date falls in the window; compute days-to-sell.
    const sold = []
    for (const v of (rows || [])) {
      const saleRef = v.sold_at || v.archived_at || v.last_synced_at
      if (!saleRef) continue
      const saleMs = new Date(saleRef).getTime()
      if (!(saleMs >= startMs)) continue
      const lotRef = v.lot_date || v.created_at
      const dts = lotRef ? Math.max(0, Math.round((saleMs - new Date(lotRef).getTime()) / 86400000)) : null
      sold.push({ ...v, _dts: dts })
    }

    const groupBy = (keyFn, order) => {
      const m = {}
      for (const v of sold) {
        const k = keyFn(v); if (k == null) continue
        const g = m[k] || (m[k] = { key: k, count: 0, value: 0, priced: 0, dtsSum: 0, dtsN: 0 })
        g.count++; const p = num(v.price); if (p) { g.value += p; g.priced++ }
        if (v._dts != null) { g.dtsSum += v._dts; g.dtsN++ }
      }
      let arr = Object.values(m).map(g => ({
        key: g.key, count: g.count, value: Math.round(g.value),
        avg_price: g.priced ? Math.round(g.value / g.priced) : null,
        avg_days_to_sell: g.dtsN ? Math.round(g.dtsSum / g.dtsN) : null,
      }))
      if (order) arr.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key))
      else arr.sort((a, b) => b.count - a.count)
      return arr
    }
    const kmBucket = (v) => { const m = num(v.mileage); if (m == null) return 'Unknown'; return m < 50000 ? 'Under 50k' : m < 100000 ? '50–100k' : m < 150000 ? '100–150k' : '150k+' }
    const dtsBucket = (v) => { const d = v._dts; if (d == null) return 'Unknown'; return d <= 30 ? '0–30' : d <= 60 ? '31–60' : d <= 90 ? '61–90' : '90+' }
    const dtsAll = sold.map(v => v._dts).filter(x => x != null).sort((a, b) => a - b)
    const medianDts = dtsAll.length ? dtsAll[Math.floor(dtsAll.length / 2)] : null
    const totalValue = sold.reduce((s, v) => s + (num(v.price) || 0), 0)

    res.json({
      ok: true, range_days: days, distance_unit: unit,
      summary: {
        units_sold: sold.length,
        total_value: Math.round(totalValue),
        avg_days_to_sell: dtsAll.length ? Math.round(dtsAll.reduce((a, b) => a + b, 0) / dtsAll.length) : null,
        median_days_to_sell: medianDts,
      },
      by_days_to_sell: groupBy(dtsBucket, ['0–30', '31–60', '61–90', '90+', 'Unknown']),
      by_color: groupBy(v => (v.exterior_color || '').trim() || 'Unspecified').slice(0, 12),
      by_mileage: groupBy(kmBucket, ['Under 50k', '50–100k', '100–150k', '150k+', 'Unknown']),
      by_make: groupBy(v => (v.make || '').trim() || 'Unspecified').slice(0, 12),
      by_condition: groupBy(v => { const x = (v.condition || '').toLowerCase(); return x === 'new' ? 'New' : x === 'demo' ? 'Demo' : x === 'certified' ? 'Certified' : 'Used' }),
    })
  })

  // ── Sold deals report (managers) — the per-rep sold sheet + custom filters ──
  // One row per won contact (Sold/F&I/Delivered) with the customer, the vehicle of
  // interest, and delivery/ownership. F&I desk fields (manager, deposit, term,
  // products, gross, commissions, surveys) are returned as null — they need a deal
  // record that isn't captured yet, so they ship as empty columns to fill later.
  app.get('/reports/sold-deals', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.json({ ok: true, rows: [], reps: [] })
    if (!['DEALER_ADMIN', 'OWNER', 'MANAGER'].includes(req.profile?.role)) return res.status(403).json({ error: 'Manager access required' })
    const did = req.dealershipId
    const days = ({ '30': 30, '90': 90, '180': 180, '365': 365, 'all': null }[String(req.query.range || '365')])
    const startIso = days ? new Date(Date.now() - days * 86400000).toISOString() : null
    const repFilter = req.query.rep && req.query.rep !== 'all' ? String(req.query.rep) : null
    const statuses = ['sold', 'fni', 'delivered']

    let q = supabaseAdmin.from('contacts')
      .select('id, first_name, last_name, full_name, email, phone, phone_mobile, phone_home, address, city, province, postal_code, country, birthday, status, source, sold_source, sold_at, assigned_rep, interest_inventory_id, trade_vehicle, opt_out, consent_email, consent_sms, created_at')
      .eq('dealership_id', did).in('status', statuses).limit(20000)
    if (repFilter) q = q.eq('assigned_rep', repFilter)
    if (startIso) q = q.or(`sold_at.gte.${startIso},and(sold_at.is.null,created_at.gte.${startIso})`)
    const { data: contacts } = await q

    // Roster (names + the dropdown), vehicles, and ownership in bulk.
    const { data: staff } = await supabaseAdmin.from('profiles')
      .select('id, full_name, display_name, role').eq('dealership_id', did)
    const repName = (id) => { const p = (staff || []).find(s => s.id === id); return p ? (p.full_name || p.display_name || '') : '' }
    const reps = (staff || []).filter(p => p.role !== 'DEALER_GROUP').map(p => ({ id: p.id, name: p.full_name || p.display_name || '—' })).sort((a, b) => a.name.localeCompare(b.name))

    const invIds = [...new Set((contacts || []).map(c => c.interest_inventory_id).filter(Boolean))]
    let veh = {}
    if (invIds.length) {
      const { data: iv } = await supabaseAdmin.from('inventory')
        .select('id, year, make, model, trim, vin, stocknumber, drivetrain, condition, body_style').in('id', invIds)
      veh = Object.fromEntries((iv || []).map(v => [v.id, v]))
    }
    const contactIds = (contacts || []).map(c => c.id)
    let own = {}, deals = {}
    if (contactIds.length) {
      const { data: ot } = await supabaseAdmin.from('customer_ownership_tracking')
        .select('customer_id, delivery_date, owns_vehicle, vehicle_status').in('customer_id', contactIds)
      own = Object.fromEntries((ot || []).map(o => [o.customer_id, o]))
      const { data: dl } = await supabaseAdmin.from('deals')
        .select('*').eq('dealership_id', did).in('contact_id', contactIds)
      deals = Object.fromEntries((dl || []).map(d => [d.contact_id, d]))
    }
    const money = (n) => (n == null || n === '') ? null : Number(n).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
    const yn = (b) => b === true ? 'Yes' : b === false ? 'No' : null

    const STATUS_LABEL = { sold: 'Sold', fni: 'F&I', delivered: 'Delivered' }
    const rows = (contacts || [])
      .sort((a, b) => new Date(b.sold_at || b.created_at) - new Date(a.sold_at || a.created_at))
      .map(c => {
        const v = veh[c.interest_inventory_id] || {}
        const o = own[c.id] || {}
        const dl = deals[c.id] || {}
        const delivered = dl.delivery_date || o.delivery_date || (c.status === 'delivered' ? c.sold_at : null)
        const noLongerOwns = o.owns_vehicle === false || ['traded_in', 'sold_private', 'totaled'].includes(o.vehicle_status)
        const cond = (v.condition || '').toLowerCase()
        return {
          contact_id: c.id,
          has_deal: !!deals[c.id],
          sold_date: c.sold_at || null,
          source: c.sold_source || c.source || null,
          first_name: c.first_name || null,
          last_name: c.last_name || (c.full_name && !c.first_name ? c.full_name : null),
          phone: c.phone || c.phone_mobile || c.phone_home || null,
          email: c.email || null,
          street_address: c.address || null,
          city: c.city || null,
          region: c.province || null,
          postal_code: c.postal_code || null,
          country: c.country || null,
          birthday: c.birthday || null,
          status: STATUS_LABEL[c.status] || c.status,
          delivery_date: delivered || null,
          delivery_time: dl.delivery_time || null,
          fni_manager: dl.fni_manager || null,
          deposit_amount: money(dl.deposit_amount),
          type_of_vehicle: cond === 'new' ? 'New' : cond === 'demo' ? 'Demo' : cond === 'certified' ? 'Certified' : cond ? 'Used' : (v.body_style || null),
          stock_number: v.stocknumber || null,
          vin: v.vin || null,
          year: v.year || null, make: v.make || null, model: v.model || null, trim: v.trim || null,
          drivetrain: v.drivetrain || null,
          deal_type: dl.deal_type || null,
          term: dl.term != null ? String(dl.term) : null,
          plates: dl.plates || null,
          fni_products: dl.fni_products || null,
          trade_type: c.trade_vehicle ? 'Trade' : null,
          google_review: yn(dl.google_review),
          gm_survey: yn(dl.gm_survey),
          gm_survey_pct: dl.gm_survey_pct != null ? dl.gm_survey_pct + '%' : null,
          fni_gross_1500: yn(dl.fni_gross_1500),
          split_deal: yn(dl.split_deal),
          split_with: dl.split_with || null,
          vehicle_commission: money(dl.vehicle_commission),
          fni_commission: money(dl.fni_commission),
          unsubscribed: (c.opt_out || c.consent_email === false || c.consent_sms === false) ? 'Yes' : 'No',
          no_longer_owns: noLongerOwns ? 'Yes' : 'No',
          salesperson: repName(c.assigned_rep) || null,
        }
      })
    res.json({ ok: true, rows, reps, count: rows.length })
  })

  // Desk / F&I record for a sold deal — managers enter the fields MarketSync
  // doesn't otherwise capture. Keyed one-per-contact; upserted on contact_id.
  // Numeric money/rate fields (stored denormalised for reporting + the printed docs).
  const DEAL_NUM_FIELDS = ['deposit_amount', 'gm_survey_pct', 'vehicle_commission', 'fni_commission', 'term',
    'selling_price', 'trade_value', 'trade_payoff', 'down_payment', 'rebate', 'apr',
    'amount_financed', 'payment', 'tax_rate', 'tax_amount', 'total_price',
    'retail', 'rebate_before_tax', 'adjustment', 'balloon', 'deferral_days',
    'buy_rate', 'residual_amount', 'mileage_allowance']
  const DEAL_BOOL_FIELDS = ['google_review', 'gm_survey', 'fni_gross_1500', 'split_deal', 'tax_on_difference']
  const DEAL_TEXT_FIELDS = ['inventory_id', 'delivery_date', 'delivery_time', 'fni_manager', 'deal_type', 'plates',
    'fni_products', 'split_with', 'notes', 'deal_status', 'payment_freq', 'trade_desc', 'trade_vin',
    'finance_company', 'first_payment_date', 'sale_type', 'program', 'co_buyer', 'tax_province', 'tax_country']
  // JSONB line-item / block fields — the full deal detail for the estimate + bill of sale.
  const DEAL_JSON_FIELDS = ['addons', 'fni_items', 'fees', 'insurance', 'vehicle']

  app.get('/reports/deal', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership' })
    if (!['DEALER_ADMIN', 'OWNER', 'MANAGER'].includes(req.profile?.role)) return res.status(403).json({ error: 'Manager access required' })
    const contactId = String(req.query.contact_id || '')
    if (!contactId) return res.status(400).json({ error: 'contact_id required' })
    const { data } = await supabaseAdmin.from('deals')
      .select('*').eq('dealership_id', req.dealershipId).eq('contact_id', contactId).maybeSingle()
    // Customer # lives on the contact; the deal carries deal #. Surface both plus the
    // salesperson (name + registration/OMVIC #) so the bill of sale can print them.
    const { data: cust } = await supabaseAdmin.from('contacts')
      .select('customer_number').eq('id', contactId).maybeSingle()
    let salesperson = null
    const repId = data?.created_by
    if (repId) {
      const { data: rep } = await supabaseAdmin.from('profiles').select('full_name, registration_id').eq('id', repId).maybeSingle()
      if (rep) salesperson = { name: rep.full_name || null, registration_id: rep.registration_id || null }
    }
    res.json({ ok: true, deal: data || null, customer_number: cust?.customer_number || null, salesperson })
  })

  // Next sequential number for a dealership (max+1, base-offset so it reads like a
  // real dealer number). Low-concurrency per dealer, so max+1 is safe enough.
  async function nextDealershipNumber(table, col, dealershipId, base) {
    const { data } = await supabaseAdmin.from(table).select(col)
      .eq('dealership_id', dealershipId).not(col, 'is', null).order(col, { ascending: false }).limit(1).maybeSingle()
    const cur = data?.[col]
    return (cur && cur >= base) ? cur + 1 : base
  }

  app.post('/reports/deal', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership' })
    if (!['DEALER_ADMIN', 'OWNER', 'MANAGER'].includes(req.profile?.role)) return res.status(403).json({ error: 'Manager access required' })
    const contactId = String(req.body?.contact_id || '')
    if (!contactId) return res.status(400).json({ error: 'contact_id required' })
    // Confirm the contact belongs to this dealership before writing.
    const { data: ct } = await supabaseAdmin.from('contacts').select('id').eq('id', contactId).eq('dealership_id', req.dealershipId).maybeSingle()
    if (!ct) return res.status(404).json({ error: 'Contact not found' })

    const num = (v) => { if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null }
    const bool = (v) => v === true || v === 'true' || v === 'on' || v === 1 || v === '1'
    const str = (v) => { const s = (v == null ? '' : String(v)).trim(); return s || null }
    // Accept a JSON block whether it arrived as an object/array or a stringified one.
    const json = (v) => { if (v == null || v === '') return null; if (typeof v === 'string') { try { return JSON.parse(v) } catch { return null } } return v }
    const row = { dealership_id: req.dealershipId, contact_id: contactId, created_by: req.user?.id || null, updated_at: new Date().toISOString() }
    const body = req.body || {}
    for (const f of DEAL_NUM_FIELDS)  if (f in body) row[f] = num(body[f])
    for (const f of DEAL_BOOL_FIELDS) if (f in body) row[f] = bool(body[f])
    for (const f of DEAL_TEXT_FIELDS) if (f in body) row[f] = str(body[f])
    for (const f of DEAL_JSON_FIELDS) if (f in body) row[f] = json(body[f])

    // Assign a permanent deal # (once) and make sure the customer has a customer #.
    // Both are per-dealership sequential and stay attached: the deal references the
    // contact, and the bill of sale prints both numbers together.
    const { data: existingDeal } = await supabaseAdmin.from('deals')
      .select('deal_number').eq('contact_id', contactId).eq('dealership_id', req.dealershipId).maybeSingle()
    if (existingDeal?.deal_number) row.deal_number = existingDeal.deal_number
    else row.deal_number = await nextDealershipNumber('deals', 'deal_number', req.dealershipId, 1000)

    const { data: custRow } = await supabaseAdmin.from('contacts').select('customer_number').eq('id', contactId).maybeSingle()
    let customerNumber = custRow?.customer_number || null
    if (!customerNumber) {
      customerNumber = await nextDealershipNumber('contacts', 'customer_number', req.dealershipId, 1000)
      await supabaseAdmin.from('contacts').update({ customer_number: customerNumber }).eq('id', contactId)
    }

    const { data, error } = await supabaseAdmin.from('deals')
      .upsert(row, { onConflict: 'contact_id' }).select().maybeSingle()
    if (error) { console.error('deal upsert failed:', error.message); return res.status(500).json({ error: 'Save failed' }) }
    // Once F&I has added products and saved, the vehicle is no longer up for grabs —
    // mark it pending sale (only if it's still an available unit, never overriding a
    // sold car). This is the "desk a deal → pending on F&I save" behavior.
    let vehiclePending = false
    const fniItems = Array.isArray(data?.fni_items) ? data.fni_items : []
    if (data?.inventory_id && fniItems.some(x => (x?.name || '').trim() || Number(x?.price) > 0)) {
      const { data: veh } = await supabaseAdmin.from('inventory')
        .select('status').eq('id', data.inventory_id).eq('dealership_id', req.dealershipId).maybeSingle()
      if (veh && String(veh.status || 'available').toLowerCase() === 'available') {
        await supabaseAdmin.from('inventory').update({ status: 'pending' }).eq('id', data.inventory_id).eq('dealership_id', req.dealershipId)
        vehiclePending = true
      }
    }
    // If this deal is already sold (not delivered), make sure it's on the Cleanup /
    // get-ready board — saving a sold deal must never drop the car off it.
    if (data?.inventory_id && data.deal_status === 'sold') {
      await ensureGetReadyCard(req.dealershipId, { inventoryId: data.inventory_id, dealId: data.id })
    }
    let salesperson = null
    if (row.created_by) {
      const { data: rep } = await supabaseAdmin.from('profiles').select('full_name, registration_id').eq('id', row.created_by).maybeSingle()
      if (rep) salesperson = { name: rep.full_name || null, registration_id: rep.registration_id || null }
    }
    res.json({ ok: true, deal: data, customer_number: customerNumber, salesperson, vehicle_pending: vehiclePending })
  })

  // Move a deal through its lifecycle from the desk. Managers + F&I only.
  //   pending_credit → credit app submitted; car pending, customer "turned over"
  //   cash / sold    → deal closed; car sold, customer sold (not yet delivered)
  //   delivered      → vehicle handed over; car sold, customer delivered
  // Updates the deal + its linked inventory unit. The CONTACT status is updated
  // separately by the client (via /crm/contacts/:id) so pipeline automation fires.
  app.post('/reports/deal/status', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership' })
    if (!['DEALER_ADMIN', 'OWNER', 'MANAGER'].includes(req.profile?.role)) return res.status(403).json({ error: 'Manager access required' })
    const contactId = String(req.body?.contact_id || '')
    const action = String(req.body?.action || '').toLowerCase()
    if (!contactId) return res.status(400).json({ error: 'contact_id required' })
    const now = new Date().toISOString()
    // action → { deal_status, inventory status, timestamp column }
    const MAP = {
      working:        { deal: 'working',        inv: 'available' },
      pending_credit: { deal: 'pending_credit', inv: 'pending', stamp: 'credit_app_at' },
      cash:           { deal: 'sold',           inv: 'sold', stamp: 'sold_at' },
      sold:           { deal: 'sold',           inv: 'sold', stamp: 'sold_at' },
      delivered:      { deal: 'delivered',      inv: 'sold', stamp: 'delivered_at' },
    }
    const m = MAP[action]
    if (!m) return res.status(400).json({ error: 'Invalid action' })
    const { data: deal } = await supabaseAdmin.from('deals')
      .select('id, inventory_id').eq('contact_id', contactId).eq('dealership_id', req.dealershipId).maybeSingle()
    if (!deal) return res.status(404).json({ error: 'Save the deal first, then set its status.' })
    const patch = { deal_status: m.deal, updated_at: now }
    if (m.stamp) patch[m.stamp] = now
    const { error } = await supabaseAdmin.from('deals').update(patch).eq('id', deal.id).eq('dealership_id', req.dealershipId)
    if (error) { console.error('deal status update failed:', error.message); return res.status(500).json({ error: 'Update failed' }) }
    // Flip the vehicle to match. Never touch a car that isn't linked to this deal.
    if (deal.inventory_id) {
      const invPatch = { status: m.inv }
      if (m.inv === 'sold') invPatch.sold_at = now
      if (m.inv === 'available') invPatch.sold_at = null
      await supabaseAdmin.from('inventory').update(invPatch).eq('id', deal.inventory_id).eq('dealership_id', req.dealershipId)
    }
    res.json({ ok: true, deal_status: m.deal, vehicle_status: m.inv })
  })

  // ── Desk-a-deal helpers: search customers, prefill one, search inventory ──────
  // Search ALL contacts (not just sold) so a deal can be started for anyone.
  app.get('/deals/customers', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.json({ ok: true, rows: [] })
    if (!['DEALER_ADMIN', 'OWNER', 'MANAGER'].includes(req.profile?.role)) return res.status(403).json({ error: 'Manager access required' })
    const q = String(req.query.q || '').trim()
    let query = supabaseAdmin.from('contacts')
      .select('id, first_name, last_name, full_name, email, phone, phone_mobile, city, province')
      .eq('dealership_id', req.dealershipId).order('last_activity_at', { ascending: false, nullsFirst: false }).limit(25)
    if (q) {
      const like = `%${q.replace(/[%,]/g, ' ')}%`
      query = query.or(`full_name.ilike.${like},first_name.ilike.${like},last_name.ilike.${like},email.ilike.${like},phone.ilike.${like},phone_mobile.ilike.${like}`)
    }
    const { data } = await query
    const rows = (data || []).map(c => ({
      id: c.id,
      name: c.full_name || [c.first_name, c.last_name].filter(Boolean).join(' ') || c.email || 'Customer',
      email: c.email || null, phone: c.phone || c.phone_mobile || null,
      city: c.city || null, province: c.province || null,
    }))
    res.json({ ok: true, rows })
  })

  // Full buyer block for the bill of sale (address, DL, phones), plus any vehicle
  // of interest so the desk can prefill the vehicle section.
  app.get('/deals/customer', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership' })
    if (!['DEALER_ADMIN', 'OWNER', 'MANAGER'].includes(req.profile?.role)) return res.status(403).json({ error: 'Manager access required' })
    const id = String(req.query.id || '')
    if (!id) return res.status(400).json({ error: 'id required' })
    const { data: c } = await supabaseAdmin.from('contacts')
      .select('id, first_name, last_name, full_name, email, phone, phone_mobile, phone_home, phone_work, address, city, province, postal_code, country, dl_number, dl_expiry, interest_inventory_id, interest_vehicle, trade_vehicle')
      .eq('id', id).eq('dealership_id', req.dealershipId).maybeSingle()
    if (!c) return res.status(404).json({ error: 'Contact not found' })
    let vehicle = null
    if (c.interest_inventory_id) {
      const { data: v } = await supabaseAdmin.from('inventory')
        .select('id, vin, year, make, model, trim, mileage, exterior_color, stocknumber, price')
        .eq('id', c.interest_inventory_id).eq('dealership_id', req.dealershipId).maybeSingle()
      if (v) vehicle = v
    }
    res.json({ ok: true, contact: c, vehicle })
  })

  // Saved trade appraisals for this customer — to pull into the desk's trade section.
  app.get('/deals/trades', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.json({ ok: true, rows: [] })
    if (!['DEALER_ADMIN', 'OWNER', 'MANAGER'].includes(req.profile?.role)) return res.status(403).json({ error: 'Manager access required' })
    const contactId = String(req.query.contact_id || '')
    if (!contactId) return res.json({ ok: true, rows: [] })
    const cols = 'id, year, make, model, trim, vin, mileage, color, suggested_offer, retail_median, created_at, contact_id, customer'
    // Primary match: appraisals explicitly linked to this contact.
    const { data: linked } = await supabaseAdmin.from('trade_appraisals')
      .select(cols).eq('dealership_id', req.dealershipId).eq('contact_id', contactId)
      .order('created_at', { ascending: false }).limit(10)
    const rows = [...(linked || [])]
    // Fallback: an appraisal may have been saved before the contact existed (or under a
    // separate contact record for the same person) — match on the customer's email/phone
    // captured on the appraisal so it still pulls into the deal.
    const { data: c } = await supabaseAdmin.from('contacts')
      .select('email, phone, phone_mobile').eq('id', contactId).eq('dealership_id', req.dealershipId).maybeSingle()
    const email = (c?.email || '').trim().toLowerCase()
    const phone = (c?.phone || c?.phone_mobile || '').replace(/\D/g, '')
    if (email || phone) {
      const { data: recent } = await supabaseAdmin.from('trade_appraisals')
        .select(cols).eq('dealership_id', req.dealershipId)
        .order('created_at', { ascending: false }).limit(200)
      const seen = new Set(rows.map(r => r.id))
      for (const a of (recent || [])) {
        if (seen.has(a.id)) continue
        const cust = a.customer || {}
        const aEmail = String(cust.email || '').trim().toLowerCase()
        const aPhone = String(cust.mobile_phone || cust.phone || cust.home_phone || '').replace(/\D/g, '')
        if ((email && aEmail && aEmail === email) || (phone && aPhone && aPhone === phone)) {
          rows.push(a); seen.add(a.id)
          if (rows.length >= 10) break
        }
      }
    }
    // Strip the customer blob from the response (only needed for matching above).
    res.json({ ok: true, rows: rows.map(({ customer, ...r }) => r) })
  })

  // Search this dealer's inventory for the vehicle section (VIN / stock / name).
  app.get('/deals/vehicles', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.json({ ok: true, rows: [] })
    if (!['DEALER_ADMIN', 'OWNER', 'MANAGER'].includes(req.profile?.role)) return res.status(403).json({ error: 'Manager access required' })
    const q = String(req.query.q || '').trim()
    let query = supabaseAdmin.from('inventory')
      .select('id, vin, year, make, model, trim, mileage, exterior_color, stocknumber, price, status')
      .eq('dealership_id', req.dealershipId).order('created_at', { ascending: false }).limit(25)
    if (q) {
      const like = `%${q.replace(/[%,]/g, ' ')}%`
      query = query.or(`vin.ilike.${like},stocknumber.ilike.${like},make.ilike.${like},model.ilike.${like},trim.ilike.${like}`)
    }
    const { data } = await query
    res.json({ ok: true, rows: data || [] })
  })

  // Inventory report — the "what" data source for the custom report builder.
  // Filters by status and (lot-date) range; returns a flat row per vehicle.
  app.get('/reports/inventory', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.json({ ok: true, rows: [] })
    if (!['DEALER_ADMIN', 'OWNER', 'MANAGER'].includes(req.profile?.role)) return res.status(403).json({ error: 'Manager access required' })
    const did = req.dealershipId
    const days = ({ '30': 30, '90': 90, '180': 180, '365': 365, 'all': null }[String(req.query.range || 'all')])
    const startIso = days ? new Date(Date.now() - days * 86400000).toISOString() : null
    const status = String(req.query.status || 'all')

    let q = supabaseAdmin.from('inventory')
      .select('stocknumber, vin, year, make, model, trim, condition, body_style, exterior_color, interior_color, mileage, price, status, drivetrain, fuel_type, transmission, lot_date, created_at, sold_at, archived_at')
      .eq('dealership_id', did).limit(20000)
    if (status === 'available') q = q.eq('status', 'available').is('archived_at', null)
    else if (status === 'sold') q = q.eq('status', 'sold')
    else if (status === 'archived') q = q.not('archived_at', 'is', null)
    if (startIso) q = q.or(`lot_date.gte.${startIso},and(lot_date.is.null,created_at.gte.${startIso})`)
    const { data: inv } = await q

    const now = Date.now()
    const money = (n) => (n == null || n === '') ? null : Number(n).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
    const STATUS_LABEL = { available: 'Available', sold: 'Sold', archived: 'Archived', pending: 'Pending' }
    const rows = (inv || [])
      .sort((a, b) => new Date(b.lot_date || b.created_at || 0) - new Date(a.lot_date || a.created_at || 0))
      .map(v => {
        const ref = v.lot_date || v.created_at
        const end = v.sold_at || v.archived_at || (v.status === 'available' ? null : null)
        const daysOnLot = ref ? Math.floor(((end ? new Date(end).getTime() : now) - new Date(ref).getTime()) / 86400000) : null
        const st = (v.archived_at && v.status !== 'sold') ? 'archived' : v.status
        return {
          stock_number: v.stocknumber || null,
          vin: v.vin || null,
          year: v.year || null, make: v.make || null, model: v.model || null, trim: v.trim || null,
          condition: v.condition || null,
          body_style: v.body_style || null,
          exterior_color: v.exterior_color || null,
          interior_color: v.interior_color || null,
          mileage: v.mileage != null ? Number(v.mileage).toLocaleString('en-US') : null,
          price: money(v.price),
          status: STATUS_LABEL[st] || st || null,
          drivetrain: v.drivetrain || null,
          fuel_type: v.fuel_type || null,
          transmission: v.transmission || null,
          days_on_lot: daysOnLot != null ? String(daysOnLot) : null,
          lot_date: ref || null,
          sold_date: v.sold_at || null,
        }
      })
    res.json({ ok: true, rows, count: rows.length })
  })

  // ── Teams ────────────────────────────────────────────────────────────────
  // Sales & Management are login users (profiles); Service/Admin/Cleanup/Lot are
  // label-only staff records. One roster endpoint serves both.
  const LOGIN_TEAMS = { sales: ['SALES_REP'], management: ['MANAGER', 'DEALER_ADMIN', 'OWNER'] }
  const LABEL_TEAMS = ['service', 'admin', 'cleanup', 'lot']
  const isMgr = (req) => ['DEALER_ADMIN', 'OWNER', 'MANAGER'].includes(req.profile?.role)

  app.get('/team/roster', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.json({ ok: true, team: 'sales', members: [], login: false })
    const team = String(req.query.team || 'sales').toLowerCase()
    if (LOGIN_TEAMS[team]) {
      const { data } = await supabaseAdmin.from('profiles')
        .select('id, full_name, display_name, role, avatar_url').eq('dealership_id', req.dealershipId).in('role', LOGIN_TEAMS[team])
      const members = (data || []).map(p => ({ id: p.id, name: p.full_name || p.display_name || '—', role: p.role, avatar_url: p.avatar_url || null, login: true }))
        .sort((a, b) => a.name.localeCompare(b.name))
      return res.json({ ok: true, team, login: true, members })
    }
    if (LABEL_TEAMS.includes(team)) {
      const { data } = await supabaseAdmin.from('staff_members')
        .select('id, name, phone, email, notes, active').eq('dealership_id', req.dealershipId).eq('team', team).order('name')
      return res.json({ ok: true, team, login: false, members: (data || []).map(m => ({ ...m, login: false })) })
    }
    res.status(400).json({ error: 'Unknown team' })
  })

  app.post('/team/staff', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership' })
    if (!isMgr(req)) return res.status(403).json({ error: 'Manager access required' })
    const team = String(req.body?.team || '').toLowerCase()
    const name = String(req.body?.name || '').trim()
    if (!LABEL_TEAMS.includes(team)) return res.status(400).json({ error: 'Invalid team' })
    if (!name) return res.status(400).json({ error: 'Name required' })
    const row = {
      dealership_id: req.dealershipId, team, name,
      phone: String(req.body?.phone || '').trim() || null,
      email: String(req.body?.email || '').trim() || null,
      notes: String(req.body?.notes || '').trim() || null,
      created_by: req.user?.id || null, updated_at: new Date().toISOString(),
    }
    if (req.body?.id) {
      const { data, error } = await supabaseAdmin.from('staff_members').update(row).eq('id', req.body.id).eq('dealership_id', req.dealershipId).select().maybeSingle()
      if (error) return res.status(500).json({ error: 'Save failed' })
      return res.json({ ok: true, member: data })
    }
    const { data, error } = await supabaseAdmin.from('staff_members').insert(row).select().maybeSingle()
    if (error) return res.status(500).json({ error: 'Save failed' })
    res.json({ ok: true, member: data })
  })

  app.delete('/team/staff/:id', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership' })
    if (!isMgr(req)) return res.status(403).json({ error: 'Manager access required' })
    const { error } = await supabaseAdmin.from('staff_members').delete().eq('id', req.params.id).eq('dealership_id', req.dealershipId)
    if (error) return res.status(500).json({ error: 'Delete failed' })
    res.json({ ok: true })
  })
}
