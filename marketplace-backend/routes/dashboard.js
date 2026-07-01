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
  app.get('/dealership/leaderboard', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.json({ ranking: [], total_members: 0 })
    if (req.profile.dealerships?.is_personal === true) return res.json({ ranking: [], total_members: 0 })

    const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString()

    const { data: members } = await supabaseAdmin
      .from('profiles').select('id, full_name, role').eq('dealership_id', req.dealershipId)
    if (!members?.length) return res.json({ ranking: [], total_members: 0 })

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
        recent_logins: recentLogins || 0,
        conversion_rate: (total || 0) > 0
          ? Math.round(((sold || 0) / (total || 0)) * 100)
          : 0
      }
    }))

    const ranking = rows
      .slice()
      .sort((a, b) =>
        b.total_listings - a.total_listings
        || b.sold_listings - a.sold_listings
        || b.recent_logins - a.recent_logins
        || a.name.localeCompare(b.name)
      )
      .map((r, i) => ({ ...r, rank: i + 1 }))

    const totalListings = rows.reduce((s, r) => s + r.total_listings, 0)
    const totalSold = rows.reduce((s, r) => s + r.sold_listings, 0)

    res.json({
      ranking,
      total_members: members.length,
      team_total_listings: totalListings,
      team_total_sold: totalSold,
      team_conversion_rate: totalListings > 0
        ? Math.round((totalSold / totalListings) * 100)
        : 0
    })
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
    if (req.profile.role !== 'DEALER_ADMIN' && req.profile.role !== 'OWNER') {
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
        isYou: r.isYou, name: r.isYou ? (r.name || 'You') : `Rep #${i + 1}`,
        avatar_url: r.isYou ? (r.avatar_url || null) : null
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

  app.get('/dashboard/insights', requireAuth, async (req, res) => {
    const isAdmin = req.profile.role === 'DEALER_ADMIN' || req.profile.role === 'OWNER'
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
    let inventoryAged60d = 0, linkClicks = 0
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

        // Aged inventory: available cars on the lot more than 60 days
        const sixtyDaysAgo = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000).toISOString()
        const { count: aged, error: agedErr } = await supabaseAdmin
          .from('inventory').select('id', { count: 'exact', head: true })
          .eq('dealership_id', req.dealershipId)
          .eq('status', 'available')
          .lt('created_at', sixtyDaysAgo)
        if (agedErr) warnings.inventory_aged = agedErr.message
        else inventoryAged60d = aged || 0
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

    // Link clicks (FB Marketplace listing → MarketSync redirect → dealer site).
    // Counts rows in listing_clicks scoped to this user/dealership, within the range.
    try {
      let clickIds = null
      if (isAdmin && req.dealershipId) {
        const { data: members } = await supabaseAdmin
          .from('profiles').select('id').eq('dealership_id', req.dealershipId)
        clickIds = (members || []).map(m => m.id)
      } else {
        clickIds = [req.user.id]
      }
      if (clickIds && clickIds.length) {
        // Click attribution flows through listings.posted_by
        const { data: listingRows } = await supabaseAdmin
          .from('listings').select('id').in('posted_by', clickIds)
        const listingIds = (listingRows || []).map(l => l.id)
        if (listingIds.length) {
          const { count } = await withRange(
            supabaseAdmin.from('listing_clicks').select('id', { count: 'exact', head: true })
              .in('listing_id', listingIds)
          , 'clicked_at')
          linkClicks = count || 0
        }
      }
    } catch (e) {
      // listing_clicks table may not exist yet — that's fine, just leave linkClicks at 0
      if (!e.message?.includes('does not exist')) warnings.clicks = e.message
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
      link_clicks: linkClicks,
      active_days_this_week: activeDaysThisWeek,
      scope: isAdmin ? 'dealership' : 'personal',
      warnings: Object.keys(warnings).length ? warnings : undefined
    })
  })

  app.get('/dealership/team/:userId/stats', requireAuth, async (req, res) => {
    if (req.profile.role !== 'DEALER_ADMIN' && req.profile.role !== 'OWNER') {
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
}
