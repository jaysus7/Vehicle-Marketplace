import { supabaseAdmin, FRONTEND_URL } from '../shared.js'
import { requireAuth } from '../middleware.js'

// Shared helper: after a vehicle is sold via any path, snapshot identity onto the listing
// so leaderboard/activity feeds still have year/make/model after the inventory row is gone,
// then DELETE the inventory row entirely. Listings/sales FKs are ON DELETE SET NULL so their
// historical records survive.
async function finalizeSold(listingId, inventoryId) {
  const now = new Date().toISOString()
  // 1. Snapshot vehicle identity onto the listing row
  if (inventoryId) {
    const { data: inv } = await supabaseAdmin
      .from('inventory')
      .select('year, make, model, trim, vin, price')
      .eq('id', inventoryId)
      .single()
    if (inv) {
      const label = [inv.year, inv.make, inv.model, inv.trim].filter(Boolean).join(' ').trim()
      // fb_sync_action='sold' queues the extension to mark the FB listing "Sold".
      await supabaseAdmin
        .from('listings')
        .update({ status: 'sold', deleted_at: now, sold_at: now, vehicle_label: label || null, fb_sync_action: 'sold', fb_synced_at: null })
        .eq('id', listingId)
    } else {
      await supabaseAdmin
        .from('listings')
        .update({ status: 'sold', deleted_at: now, sold_at: now, fb_sync_action: 'sold', fb_synced_at: null })
        .eq('id', listingId)
    }
    // 2. Clear cached PDFs — no longer needed after sold
    const { data: invRow } = await supabaseAdmin.from('inventory').select('dealership_id').eq('id', inventoryId).single()
    if (invRow?.dealership_id) {
      await Promise.allSettled([
        supabaseAdmin.storage.from('vehicle-pdfs').remove([`${invRow.dealership_id}/${inventoryId}/window-sticker.pdf`]),
        supabaseAdmin.storage.from('vehicle-pdfs').remove([`${invRow.dealership_id}/${inventoryId}/brochure.pdf`]),
      ])
    }
    // 3. Delete the inventory row — vehicle is gone from the dealer site / sold
    await supabaseAdmin.from('inventory').delete().eq('id', inventoryId)
  }
}

const DEFAULT_GUARDRAILS = { enabled: true, daily_cap: 25, min_spacing_minutes: 4 }

// Compute a rep's posting-guardrail status for their dealership.
async function computeGuardrail(req) {
  const { data: dealer } = await supabaseAdmin
    .from('dealerships').select('posting_guardrails').eq('id', req.dealershipId).maybeSingle()
  const g = { ...DEFAULT_GUARDRAILS, ...(dealer?.posting_guardrails || {}) }

  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString()
  const { data: recent } = await supabaseAdmin
    .from('listings')
    .select('posted_at')
    .eq('posted_by', req.user.id)
    .in('status', ['posted', 'sold'])
    .gte('posted_at', since)
    .order('posted_at', { ascending: false })
    .limit(200)

  const postsToday = (recent || []).length
  const lastPostAt = recent?.[0]?.posted_at || null
  const spacingMs = (g.min_spacing_minutes || 0) * 60000
  let cooldownSeconds = 0
  if (lastPostAt && spacingMs > 0) {
    const elapsed = Date.now() - new Date(lastPostAt).getTime()
    if (elapsed < spacingMs) cooldownSeconds = Math.ceil((spacingMs - elapsed) / 1000)
  }

  let allowed = true, reason = null
  if (g.enabled) {
    if (postsToday >= g.daily_cap) { allowed = false; reason = 'daily_limit' }
    else if (cooldownSeconds > 0) { allowed = false; reason = 'cooldown' }
  }
  return {
    allowed, reason,
    enabled: g.enabled,
    posts_today: postsToday,
    daily_cap: g.daily_cap,
    remaining: Math.max(0, g.daily_cap - postsToday),
    min_spacing_minutes: g.min_spacing_minutes,
    cooldown_seconds: cooldownSeconds,
    next_allowed_at: cooldownSeconds > 0 ? new Date(Date.now() + cooldownSeconds * 1000).toISOString() : null,
  }
}

export function registerRoutes(app) {
  // ── Posting guardrails (FB ban protection) ──
  // The extension calls this before a rep posts to show a "safe to post /
  // cooldown / daily limit reached" indicator (rolling 24h window, per rep).
  app.get('/posting/guardrail', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.json({ allowed: true, enabled: false })
    try { res.json(await computeGuardrail(req)) }
    catch (e) { res.json({ allowed: true, enabled: false, error: e.message }) }
  })

  // Dealer admins configure the cap + spacing (or disable guardrails).
  app.put('/posting/guardrail-settings', requireAuth, async (req, res) => {
    if (!['DEALER_ADMIN', 'OWNER', 'MANAGER'].includes(req.profile.role)) {
      return res.status(403).json({ error: 'Dealer admin required' })
    }
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership' })
    const body = req.body || {}
    const next = {
      enabled: body.enabled !== undefined ? !!body.enabled : true,
      daily_cap: Math.max(1, Math.min(500, parseInt(body.daily_cap) || DEFAULT_GUARDRAILS.daily_cap)),
      min_spacing_minutes: Math.max(0, Math.min(120, parseInt(body.min_spacing_minutes) ?? DEFAULT_GUARDRAILS.min_spacing_minutes)),
    }
    const { error } = await supabaseAdmin
      .from('dealerships').update({ posting_guardrails: next }).eq('id', req.dealershipId)
    if (error) return res.status(500).json({ error: error.message })
    res.json({ ok: true, posting_guardrails: next })
  })

  // ── 7. LISTINGS ──
  app.post('/listings', requireAuth, async (req, res) => {
    const { inventory_id, fb_listing_id } = req.body

    // Verify the inventory row belongs to the caller's own dealership before
    // creating/matching a listing against it (prevents cross-tenant IDOR).
    const { data: inv, error: invErr } = await supabaseAdmin
      .from('inventory').select('id, dealership_id').eq('id', inventory_id).single()
    if (invErr || !inv) return res.status(404).json({ error: 'Inventory item not found' })
    if (inv.dealership_id !== req.dealershipId) return res.status(403).json({ error: 'Not your dealership' })

    // Only store a Facebook URL if it's a real posted-item permalink
    // (.../marketplace/item/<id>). The extension's manual "Mark Posted" button can
    // fire while still on the create page, which would otherwise save the generic
    // .../marketplace/create/vehicle URL and make "View on FB" link to a blank form.
    const rawUrl = req.body.fb_listing_url
    const fb_listing_url = (typeof rawUrl === 'string' && rawUrl.includes('/marketplace/item/'))
      ? rawUrl
      : null

    // Dedupe: the manual button and the auto-detector can both fire for the same
    // vehicle. Reuse an existing 'posted' listing and backfill its URL/id instead of
    // inserting a duplicate (manual marks it posted first, auto-detect fills the URL).
    const { data: existingRows } = await supabaseAdmin
      .from('listings').select('id, fb_listing_url, fb_listing_id')
      .eq('inventory_id', inventory_id).eq('posted_by', req.user.id).eq('status', 'posted')
      .order('posted_at', { ascending: false }).limit(1)
    const existing = existingRows?.[0]

    if (existing) {
      const patch = {}
      if (fb_listing_url && !existing.fb_listing_url) patch.fb_listing_url = fb_listing_url
      if (fb_listing_id && !existing.fb_listing_id) patch.fb_listing_id = fb_listing_id
      if (!Object.keys(patch).length) return res.json(existing)
      const { data, error } = await supabaseAdmin
        .from('listings').update(patch).eq('id', existing.id).select().single()
      if (error) return res.status(500).json({ error: error.message })
      return res.json(data)
    }

    const { data, error } = await supabaseAdmin
      .from('listings')
      .insert({
        inventory_id,
        posted_by: req.user.id,
        fb_listing_id: fb_listing_id || null,
        fb_listing_url,
        status: 'posted',
        posted_at: new Date().toISOString()
      })
      .select()
      .single()
    if (error) return res.status(500).json({ error: error.message })
    res.json(data)
  })

  // status filter: ?status=posted (default), sold, all — explicit FK hint + scoped
  // to the caller's own posts via posted_by to avoid ambiguous join / cross-user leak.
  app.get('/listings', requireAuth, async (req, res) => {
    const statusParam = req.query.status || 'posted'
    let query = supabaseAdmin
      .from('listings')
      .select('*, inventory!listings_inventory_id_fkey(*)')
      .eq('posted_by', req.user.id)
      .order('posted_at', { ascending: false })

    if (statusParam === 'all') {
      query = query.in('status', ['posted', 'sold'])
    } else {
      query = query.eq('status', statusParam)
    }

    const { data, error } = await query
    if (error) return res.status(500).json({ error: error.message })
    res.json(data || [])
  })

  app.patch('/listings/:id/fb-url', requireAuth, async (req, res) => {
    const { fb_listing_url } = req.body || {}
    if (!fb_listing_url || !/facebook\.com\/marketplace\/item\/\d+/i.test(fb_listing_url)) {
      return res.status(400).json({ error: 'Must be a valid facebook.com/marketplace/item/<id> URL' })
    }
    const { data: listing, error: lookupErr } = await supabaseAdmin
      .from('listings').select('id, posted_by').eq('id', req.params.id).single()
    if (lookupErr || !listing) return res.status(404).json({ error: 'Listing not found' })
    if (listing.posted_by !== req.user.id) return res.status(403).json({ error: 'Not your listing' })
    const { error } = await supabaseAdmin
      .from('listings').update({ fb_listing_url }).eq('id', req.params.id)
    if (error) return res.status(500).json({ error: error.message })
    res.json({ success: true, fb_listing_url })
  })

  app.patch('/listings/:id/delete', requireAuth, async (req, res) => {
    // Queue the Facebook listing for DELETION (not "sold") — the extension will
    // remove it from Marketplace. We only queue it if there's an FB URL to act on;
    // fb_synced_at stays null so the extension's poller picks it up.
    const { data: listing, error: lookupErr } = await supabaseAdmin
      .from('listings').select('id, posted_by').eq('id', req.params.id).single()
    if (lookupErr || !listing) return res.status(404).json({ error: 'Listing not found' })
    if (listing.posted_by !== req.user.id) return res.status(403).json({ error: 'Not your listing' })

    const { error } = await supabaseAdmin
      .from('listings')
      .update({
        status: 'deleted',
        deleted_at: new Date().toISOString(),
        fb_sync_action: 'delete',
        fb_synced_at: null
      })
      .eq('id', req.params.id)
    if (error) return res.status(500).json({ error: error.message })
    res.json({ success: true })
  })

  // ── Facebook auto-sync queue ──────────────────────────────────────────────────
  // Facebook Marketplace has no server-side API for personal listings, so the
  // browser extension performs "Mark as sold" / "Delete" actions client-side.
  // These two endpoints are the queue: the extension polls pending-fb-sync for the
  // signed-in user's own listings, acts on Facebook, then reports back via fb-sync-done.

  // What FB actions are waiting for THIS user to perform (scoped to posted_by — the
  // FB session belongs to the logged-in rep, so we only ever touch their own posts).
  app.get('/listings/pending-fb-sync', requireAuth, async (req, res) => {
    const { data, error } = await supabaseAdmin
      .from('listings')
      .select('id, fb_listing_url, fb_sync_action, fb_sync_attempts, vehicle_label')
      .eq('posted_by', req.user.id)
      .not('fb_sync_action', 'is', null)
      .is('fb_synced_at', null)
      .not('fb_listing_url', 'is', null)
      .lt('fb_sync_attempts', 5)       // give up after 5 failed attempts
      .order('deleted_at', { ascending: true })
      .limit(25)
    if (error) return res.status(500).json({ error: error.message })
    res.json(data || [])
  })

  // Extension reports the outcome. ok=true → mark synced (stop queueing).
  // ok=false → bump the attempt counter so we eventually stop retrying.
  app.post('/listings/:id/fb-sync-done', requireAuth, async (req, res) => {
    const { ok } = req.body || {}
    const { data: listing } = await supabaseAdmin
      .from('listings')
      .select('id, posted_by, fb_sync_attempts')
      .eq('id', req.params.id)
      .single()
    if (!listing) return res.status(404).json({ error: 'Listing not found' })
    if (listing.posted_by !== req.user.id) return res.status(403).json({ error: 'Not your listing' })

    const update = ok
      ? { fb_synced_at: new Date().toISOString() }
      : { fb_sync_attempts: (listing.fb_sync_attempts || 0) + 1 }
    const { error } = await supabaseAdmin.from('listings').update(update).eq('id', req.params.id)
    if (error) return res.status(500).json({ error: error.message })
    res.json({ success: true })
  })

  app.post('/listings/sync-fb-sold', requireAuth, async (req, res) => {
    const { fb_listing_url } = req.body || {}
    if (!fb_listing_url) return res.status(400).json({ error: 'fb_listing_url required' })

    const normalizedUrl = fb_listing_url.split('?')[0].split('#')[0]

    const { data: candidates } = await supabaseAdmin
      .from('listings')
      .select('id, inventory_id, status, fb_listing_url, inventory!listings_inventory_id_fkey(dealership_id)')
      .eq('status', 'posted')
      .ilike('fb_listing_url', `${normalizedUrl}%`)

    const listing = (candidates || []).find(l => l.inventory?.dealership_id === req.dealershipId)
    if (!listing) return res.json({ success: false, matched: false })

    await finalizeSold(listing.id, listing.inventory_id)
    // FB already shows this as sold (that's how we detected it) — no need to queue
    // the extension to mark it sold again.
    await supabaseAdmin
      .from('listings')
      .update({ fb_sync_action: null, fb_synced_at: new Date().toISOString() })
      .eq('id', listing.id)
    res.json({ success: true, matched: true, listing_id: listing.id })
  })

  // "I Sold It" — rep closed the deal. Records sale (500 pts) + deletes inventory row.
  app.post('/listings/:id/sold-by-me', requireAuth, async (req, res) => {
    const { data: listing, error: lookupErr } = await supabaseAdmin
      .from('listings')
      .select('id, inventory_id, inventory!listings_inventory_id_fkey(dealership_id)')
      .eq('id', req.params.id)
      .single()
    if (lookupErr || !listing) return res.status(404).json({ error: 'Listing not found' })
    if (listing.inventory?.dealership_id !== req.dealershipId) return res.status(403).json({ error: 'Not your dealership' })

    // Record the sale FIRST (before deleting inventory) so points are credited.
    const { error: saleErr } = await supabaseAdmin.from('sales').insert({
      inventory_id: listing.inventory_id,
      sold_by: req.user.id,
      dealership_id: req.dealershipId,
      points_awarded: 500
    })
    if (saleErr) console.warn('Sales insert failed (table may not exist yet):', saleErr.message)

    await finalizeSold(listing.id, listing.inventory_id)
    res.json({ success: true, points_awarded: 500 })
  })

  // "I Sold It on FB" — rep closed a deal that came through the Facebook listing.
  // Bonus points (750) since the sale came from MarketSync's posting.
  app.post('/listings/:id/sold-on-fb', requireAuth, async (req, res) => {
    const { data: listing, error: lookupErr } = await supabaseAdmin
      .from('listings')
      .select('id, inventory_id, inventory!listings_inventory_id_fkey(dealership_id)')
      .eq('id', req.params.id)
      .single()
    if (lookupErr || !listing) return res.status(404).json({ error: 'Listing not found' })
    if (listing.inventory?.dealership_id !== req.dealershipId) return res.status(403).json({ error: 'Not your dealership' })

    const { error: saleErr } = await supabaseAdmin.from('sales').insert({
      inventory_id: listing.inventory_id,
      sold_by: req.user.id,
      dealership_id: req.dealershipId,
      points_awarded: 750
    })
    if (saleErr) console.warn('Sales insert failed:', saleErr.message)

    await finalizeSold(listing.id, listing.inventory_id)
    res.json({ success: true, points_awarded: 750 })
  })

  // "Sold by Other" — someone else closed it. No points, but vehicle still gets removed.
  app.post('/listings/:id/sold-by-other', requireAuth, async (req, res) => {
    const { data: listing, error: lookupErr } = await supabaseAdmin
      .from('listings')
      .select('id, inventory_id, inventory!listings_inventory_id_fkey(dealership_id)')
      .eq('id', req.params.id)
      .single()
    if (lookupErr || !listing) return res.status(404).json({ error: 'Listing not found' })
    if (listing.inventory?.dealership_id !== req.dealershipId) return res.status(403).json({ error: 'Not your dealership' })

    await finalizeSold(listing.id, listing.inventory_id)
    res.json({ success: true, points_awarded: 0 })
  })

  // Legacy /sold endpoint — keep working, treats as "sold by other" (no point credit)
  app.post('/listings/:id/sold', requireAuth, async (req, res) => {
    const { data: listing, error: lookupErr } = await supabaseAdmin
      .from('listings')
      .select('id, inventory_id, inventory!listings_inventory_id_fkey(dealership_id)')
      .eq('id', req.params.id)
      .single()
    if (lookupErr || !listing) return res.status(404).json({ error: 'Listing not found' })
    if (listing.inventory?.dealership_id !== req.dealershipId) return res.status(403).json({ error: 'Not your dealership' })

    await finalizeSold(listing.id, listing.inventory_id)
    res.json({ success: true })
  })

  // ── CLICK REDIRECT (Facebook Marketplace attribution) ──
  // Buyer clicks the dealer link in a Marketplace listing description → hits this
  // endpoint → we log the click and 302 to the actual dealer URL. Public — no auth
  // required (Facebook strips referrer auth headers, and the link must work for
  // anonymous buyers). The listing_id alone is enough since each listing row stores
  // the dealer source_url via its linked inventory row.
  app.get('/r/:listingId', async (req, res) => {
    const { listingId } = req.params

    // Look up the destination URL: prefer the inventory row's source_url, fall back
    // to a stored snapshot if inventory has been deleted (sold/dropped).
    let destination = null
    try {
      const { data: listing } = await supabaseAdmin
        .from('listings')
        .select('inventory_id, inventory!listings_inventory_id_fkey(source_url)')
        .eq('id', listingId)
        .maybeSingle()
      destination = listing?.inventory?.source_url || null
    } catch {}

    // Log the click (don't block redirect on logging errors)
    supabaseAdmin
      .from('listing_clicks')
      .insert({
        listing_id: listingId,
        source: req.query.s || 'fb_marketplace',
        user_agent: (req.headers['user-agent'] || '').slice(0, 500),
        referrer: (req.headers.referer || req.headers.referrer || '').slice(0, 500)
      })
      .then(({ error }) => { if (error) console.warn('listing_click insert failed:', error.message) })

    if (destination) return res.redirect(302, destination)
    // Fall back to the homepage rather than 404 — buyer should land somewhere usable
    res.redirect(302, FRONTEND_URL)
  })

  // Tracked redirect keyed by INVENTORY id. The extension embeds this link in the FB
  // Marketplace description, where the listing row doesn't exist yet at fill time. At
  // click time the post is live, so we resolve the dealer URL from inventory and
  // attribute the click to the most recent posted listing for that vehicle.
  app.get('/r/v/:inventoryId', async (req, res) => {
    const { inventoryId } = req.params

    let destination = null
    let listingId = null
    try {
      const { data: inv } = await supabaseAdmin
        .from('inventory').select('source_url').eq('id', inventoryId).maybeSingle()
      destination = inv?.source_url || null

      const { data: rows } = await supabaseAdmin
        .from('listings').select('id')
        .eq('inventory_id', inventoryId).eq('status', 'posted')
        .order('posted_at', { ascending: false }).limit(1)
      listingId = rows?.[0]?.id || null
    } catch {}

    // Only log when we can attribute the click to a real listing — the insights metric
    // counts clicks via listings.posted_by, so an unattributed click wouldn't be counted.
    if (listingId) {
      supabaseAdmin
        .from('listing_clicks')
        .insert({
          listing_id: listingId,
          source: req.query.s || 'fb_marketplace',
          user_agent: (req.headers['user-agent'] || '').slice(0, 500),
          referrer: (req.headers.referer || req.headers.referrer || '').slice(0, 500)
        })
        .then(({ error }) => { if (error) console.warn('listing_click insert failed:', error.message) })
    }

    if (destination) return res.redirect(302, destination)
    res.redirect(302, FRONTEND_URL)
  })
}
