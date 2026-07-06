import { supabaseAdmin, browserFetch } from '../shared.js'
import { requireAuth } from '../middleware.js'
import { fetchViaBrowser, harvestVehicleUrls } from '../puppeteerRenderer.js'
import { detectFeedPlatform, PLATFORM_PROBES } from '../sync/platforms.js'
import { inventoryHasFeedId, normalizeFeedUrl, matchesFeedType, buildSourceUrl } from '../sync/engine.js'
import { mapFuel, buildDescription } from '../utils/description.js'
import { parseGenericFeed } from '../sync/genericFeed.js'
import { autoDecodeInventory } from '../sync/vinDecode.js'

export function registerRoutes(app) {
  app.post('/feeds/probe', async (req, res) => {
    const { url } = req.body || {}
    if (!url) return res.status(400).json({ error: 'url is required' })
    try {
      const result = await detectFeedPlatform(url)
      res.json(result)
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  // ── EXTENSION-SIDE INVENTORY CAPTURE ───────────────────────────────────────
  // The user's Chrome extension (dealer-extract.js) fetched inventory from
  // inside their authenticated browser session and is uploading it here. Used
  // for dealer sites our backend can't reach (Cloudflare, custom auth, etc.).
  //
  // Payload: { vehicles: [...], source_url, platform }
  // `feed_id` from the URL path must belong to req.dealershipId.
  app.post('/feeds/:id/extension-capture', requireAuth, async (req, res) => {
    const feedId = req.params.id
    const { vehicles, source_url, platform } = req.body || {}

    if (!Array.isArray(vehicles)) {
      return res.status(400).json({ error: 'vehicles array required' })
    }

    // Verify the caller owns this feed
    const { data: feed, error: feedErr } = await supabaseAdmin
      .from('inventory_feeds')
      .select('id, dealership_id, feed_url, platform')
      .eq('id', feedId)
      .single()
    if (feedErr || !feed) return res.status(404).json({ error: 'Feed not found' })
    if (feed.dealership_id !== req.dealershipId) {
      return res.status(403).json({ error: 'Feed does not belong to your dealership' })
    }

    // Stamp the feed so the dashboard can show "last captured via extension".
    // Preserve the needs_extension_capture marker for Cloudflare-protected feeds so
    // the extension bar + dashboard warning keep showing (the server still can't sync
    // these; they must always be re-captured via the browser). Record when we last did.
    await supabaseAdmin
      .from('inventory_feeds')
      .update({
        platform: feed.platform === 'needs_extension_capture' ? 'needs_extension_capture' : (platform || 'extension_capture'),
        last_extension_sync_at: new Date().toISOString(),
        source_dealer_url: source_url || feed.feed_url
      })
      .eq('id', feedId)

    // Upsert each vehicle. Re-uses the same record shape as runInventorySync
    // so the dashboard catalog / sold-tracking / leaderboard all just work.
    const hasFeedId = await inventoryHasFeedId()
    let upserted = 0, skipped = 0
    const capturedVins = new Set()   // VINs seen in THIS capture — for the drop-off diff
    for (const v of vehicles) {
      // The probe inside the extension already runs roughly the same field
      // normalization as PLATFORM_PROBES.mapVehicle. Apply the canonical mapper
      // here too so weirdly-shaped feeds still land in the right columns.
      const probe = PLATFORM_PROBES.find(p => p.platform === platform)
      const mapped = probe?.mapVehicle ? { ...v, ...probe.mapVehicle(v) } : v

      if (!mapped.vin && !mapped.stocknumber) { skipped++; continue }
      if (!matchesFeedType(mapped, 'all')) { skipped++; continue }

      const effectiveVin = mapped.vin || `STK-${req.dealershipId.slice(0, 8)}-${mapped.stocknumber}`

      // Platform-agnostic sold/pending detection — mirrors runInventorySync so the
      // dashboard catalog / sold-tracking / Facebook queue behave the same whether a
      // feed synced server-side or was captured by the extension (Cloudflare dealers).
      // A vehicle can't be both — sold wins over pending.
      const statusStr = String(mapped.status || mapped.availability || mapped.sale_status || mapped.saleStatus || mapped.state || '').toLowerCase()
      const isSold = mapped.sold === true || /\bsold\b|sold[\s_-]?out|soldout/.test(statusStr)
      const isPending = !isSold && (mapped.salepending === true || mapped.sale_pending === true || /pending|deposit|on[\s_-]?hold|in[\s_-]?progress/.test(statusStr))

      const record = {
        dealership_id: req.dealershipId,
        vin: effectiveVin,
        year: parseInt(mapped.year) || null,
        make: mapped.make,
        model: mapped.model,
        trim: mapped.trim || null,
        price: mapped.saleprice || mapped.price || 0,
        mileage: mapped.mileage || 0,
        condition: (mapped.demo === true || mapped.demo === 1 || /^demo/i.test(mapped.condition || '') || /^demo/i.test(mapped.sale_class || '')) ? 'Demo' : (mapped.condition || null),
        exterior_color: mapped.exteriorcolor || null,
        interior_color: mapped.interiorcolor || null,
        transmission: mapped.transmission || null,
        fuel_type: mapFuel(mapped.fueltype),
        description: buildDescription(mapped),
        image_urls: Array.isArray(mapped.image_urls) ? mapped.image_urls : [],
        source_url: buildSourceUrl({ ...feed, platform, url_template: null, url_map: null }, mapped),
        status: isSold ? 'sold' : (isPending ? 'pending' : 'available'),
        last_synced_at: new Date().toISOString(),
        ...(hasFeedId ? { feed_id: feedId } : {})
      }

      const { error } = await supabaseAdmin
        .from('inventory')
        .upsert(record, { onConflict: 'vin' })
      if (error) { skipped++; continue }
      upserted++
      capturedVins.add(effectiveVin)
    }

    // ── Auto-removal + sold→FB queue (feed-scoped) ──
    // The extension capture is a full-inventory snapshot, so any vehicle that was
    // previously captured for THIS feed but isn't in the snapshot has dropped off the
    // dealer site (sold/removed). Delete it, and queue any posted Facebook listing for
    // deletion first. Scoped to feed_id so we only ever touch this feed's rows — never
    // another feed's inventory in the same dealership. Requires the feed_id column.
    let removed = 0
    if (hasFeedId && capturedVins.size > 0) {
      try {
        const { data: currentRows, error: fetchErr } = await supabaseAdmin
          .from('inventory')
          .select('id, vin, status')
          .eq('dealership_id', req.dealershipId)
          .eq('feed_id', feedId)
          .eq('status', 'available')
        if (fetchErr) {
          console.warn('[extension-capture] could not fetch inventory for diff:', fetchErr.message)
        } else {
          const toDelete = []
          for (const row of currentRows || []) {
            if (!row.vin) continue
            if (!capturedVins.has(row.vin)) toDelete.push(row.id)
          }
          // Safety brake: refuse to wipe >50% of this feed's inventory (partial capture).
          const totalCount = (currentRows || []).length
          if (totalCount > 0 && toDelete.length / totalCount > 0.5) {
            console.warn(`[extension-capture] would delete ${toDelete.length}/${totalCount} rows — refusing (likely partial capture)`)
          } else if (toDelete.length) {
            for (let i = 0; i < toDelete.length; i += 100) {
              const slice = toDelete.slice(i, i + 100)
              // Queue Facebook deletion for any posted listing BEFORE deleting inventory
              // (so inventory_id still matches). Wrapped for pre-migration DBs.
              try {
                await supabaseAdmin
                  .from('listings')
                  .update({ status: 'deleted', deleted_at: new Date().toISOString(), fb_sync_action: 'delete', fb_synced_at: null })
                  .in('inventory_id', slice)
                  .eq('status', 'posted')
                  .not('fb_listing_url', 'is', null)
              } catch (e) { console.warn('[extension-capture] delete→FB queue failed (non-fatal):', e.message) }
              await supabaseAdmin.from('inventory').delete().in('id', slice)
            }
            removed = toDelete.length
            console.log(`[extension-capture] auto-delete: ${removed} rows removed (dropped from feed)`)
          }
        }
      } catch (e) { console.warn('[extension-capture] auto-removal failed (non-fatal):', e.message) }

      // Feed marks a vehicle SOLD but keeps it listed → if posted to Facebook, queue a
      // "mark sold" so the FB listing reflects it. Idempotent once it flips to 'sold'.
      try {
        const { data: soldRows } = await supabaseAdmin
          .from('inventory').select('id')
          .eq('dealership_id', req.dealershipId).eq('feed_id', feedId).eq('status', 'sold')
        const soldIds = (soldRows || []).map(r => r.id)
        for (let i = 0; i < soldIds.length; i += 100) {
          const slice = soldIds.slice(i, i + 100)
          await supabaseAdmin.from('listings')
            .update({ status: 'sold', deleted_at: new Date().toISOString(), fb_sync_action: 'sold', fb_synced_at: null })
            .in('inventory_id', slice).eq('status', 'posted').not('fb_listing_url', 'is', null)
        }
      } catch (e) { console.warn('[extension-capture] sold→FB queue failed (non-fatal):', e.message) }
    }

    // Auto-decode newly-captured VINs via NHTSA (free, incremental). Fire-and-
    // forget so the capture response returns immediately — this is the only path
    // Cloudflare dealers have, so their inventory gets the same NHTSA enrichment.
    autoDecodeInventory(req.dealershipId).catch(e => console.warn('[extension-capture] vin auto-decode failed:', e.message))

    console.log(`[extension-capture] feed=${feedId} upserted=${upserted} skipped=${skipped} removed=${removed}`)
    res.json({ success: true, upserted, skipped, removed, total: vehicles.length })
  })

  app.get('/inventory-feeds', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.json([])
    const { data, error } = await supabaseAdmin
      .from('inventory_feeds')
      .select('id, feed_url, feed_type, platform, created_at, last_extension_sync_at, source_dealer_url')
      .eq('dealership_id', req.dealershipId)
      .order('created_at', { ascending: false })
    if (error) return res.status(500).json({ error: error.message })
    res.json(data)
  })

  app.post('/inventory-feeds', requireAuth, async (req, res) => {
    const canManage = req.profile.role === 'DEALER_ADMIN'
      || req.profile.role === 'OWNER'
      || req.profile.dealerships?.is_personal === true
    if (!canManage) return res.status(403).json({ error: 'Only dealer admins or solo reps can manage feeds' })
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership associated with this account' })

    const { feed_url: rawUrl, feed_type: requestedType } = req.body || {}
    if (!rawUrl) return res.status(400).json({ error: 'feed_url is required' })

    const typeHint = normalizeFeedUrl(rawUrl)
    if (!typeHint) return res.status(400).json({ error: 'Invalid URL' })

    let workingUrl = null
    let detectedPlatform = null
    let detectedPlatformSlug = null
    let attempts = []
    let cloudflareBlocked = false

    // A pasted feed URL is one that points at a data file (JSON/XML/CSV/TSV) rather
    // than a dealer web page — e.g. the direct inventory feed the dealer's platform
    // syndicates to AutoTrader/CarGurus/Google/Meta. We parse it generically.
    const userPastedFeed = (() => {
      try { return /\.(json|xml|csv|tsv|txt)$/i.test(new URL(rawUrl.trim()).pathname) }
      catch { return false }
    })()

    if (userPastedFeed) {
      try {
        const r = await browserFetch(rawUrl, { headers: { 'Accept': 'application/json, application/xml, text/xml, text/csv, text/plain, */*', 'Sec-Fetch-Dest': 'empty', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Site': 'same-origin' } })
        attempts.push({ url: rawUrl, status: r.status, ok: r.ok })
        if (r.ok) {
          // Validate it actually parses into vehicles, and record the detected format
          // so the sync engine uses the generic parser (not the legacy JSON-only path).
          const ct = r.headers.get('content-type') || ''
          const body = await r.text()
          const { vehicles, format } = parseGenericFeed(body, ct)
          if (vehicles.length > 0) {
            workingUrl = rawUrl
            detectedPlatformSlug = 'direct_feed'
            detectedPlatform = `Direct feed (${(format || 'data').toUpperCase()})`
          } else {
            attempts.push({ url: rawUrl, note: 'fetched but 0 vehicles parsed' })
          }
        } else if (r.status === 403 || r.status === 503) {
          // Cloudflare/WAF — confirm reachability through real Chrome before giving up.
          const br = await fetchViaBrowser(rawUrl)
          attempts.push({ url: rawUrl, status: br.status, ok: br.ok, via: 'headless-chrome' })
          if (br.ok) {
            const { vehicles, format } = parseGenericFeed(br.body || '', br.contentType || '')
            if (vehicles.length > 0) {
              workingUrl = rawUrl
              detectedPlatformSlug = 'direct_feed'
              detectedPlatform = `Direct feed (${(format || 'data').toUpperCase()})`
            } else cloudflareBlocked = true
          } else cloudflareBlocked = true
        }
      } catch (e) {
        attempts.push({ url: rawUrl, error: e.message })
      }
    } else {
      const detection = await detectFeedPlatform(rawUrl)
      attempts = detection.attempts || []
      cloudflareBlocked = !!detection.cloudflare_blocked
      if (detection.success) {
        workingUrl = detection.feed_url
        detectedPlatform = detection.platform_label
        detectedPlatformSlug = detection.platform
      }
    }

    if (!workingUrl) {
      if (cloudflareBlocked) {
        // Cloudflare blocks server-side access, but the user's OWN browser can reach
        // the site. Instead of failing, create the feed flagged for extension capture
        // so the extension's "Connect dealer site" button appears and pulls inventory
        // from their session. No server-side sync runs for this feed.
        workingUrl = rawUrl
        detectedPlatformSlug = 'needs_extension_capture'
        detectedPlatform = 'Browser capture (Cloudflare-protected)'
      } else {
        return res.status(400).json({
          cloudflare_blocked: false,
          error: `Could not find a working inventory feed at this dealer site. We tried ${attempts.length} known platform paths. If your dealer uses a different system, paste the direct JSON feed URL instead.`,
          attempted: attempts.slice(0, 8).map(a => `${a.url} → ${a.status || a.error || 'no data'}`)
        })
      }
    }

    // Respect the user's explicit dropdown choice — including "all" — over URL-path detection.
    // (Old behavior treated "all" as "auto-detect", which silently overrode the user's
    // selection to "new" when the URL contained /new/, defeating the point of the dropdown.)
    const feedType = requestedType || typeHint.detectedType || 'all'

    // For SPA-rendered dealers, keep the user's original URL — we need it to re-render
    // the site if the captured XHR URL stops working (e.g. auth tokens rotate).
    // eDealer API only returns one page; we fall back to DOM scraping the dealer site.
    // Keep the original URL so the scraper knows which page to render.
    const sourceDealerUrl = ['spa_render', 'convertus', 'needs_extension_capture', 'dealerpage', 'edealer'].includes(detectedPlatformSlug) ? rawUrl : null

    // For LeadBox feeds, harvest per-vehicle URLs from the dealer's listing pages now
    // (their JSON feed doesn't include vehicle detail URLs). Saves a stock→URL map onto
    // the feed row; the sync engine uses it to set source_url per vehicle.
    let urlMap = null
    if (detectedPlatformSlug === 'leadbox' && workingUrl) {
      try {
        console.log(`[feed-add] Harvesting per-vehicle URLs from ${rawUrl}...`)
        const feedRes = await fetch(workingUrl)
        const feedJson = await feedRes.json().catch(() => null)
        const vehicleKeys = (feedJson?.vehicles || [])
          .map(v => ({
            stock: v.stocknumber || v.stock_id || v.stock || null,
            vin: v.vin || v.VIN || null
          }))
          .filter(v => v.stock || v.vin)
        if (vehicleKeys.length) {
          const harvest = await harvestVehicleUrls(rawUrl, vehicleKeys)
          if (harvest.success) {
            urlMap = harvest.map
            console.log(`[feed-add] Harvested ${harvest.matched}/${harvest.total} URLs`)
          } else {
            console.warn(`[feed-add] Harvest yielded 0 matches: ${harvest.error || 'no anchors'}`)
          }
        }
      } catch (e) {
        console.warn(`[feed-add] URL harvest failed (non-fatal): ${e.message}`)
      }
    }

    const { data, error } = await supabaseAdmin
      .from('inventory_feeds')
      .insert({
        dealership_id: req.dealershipId,
        user_id: req.user.id,
        feed_url: workingUrl,
        feed_type: feedType,
        platform: detectedPlatformSlug,
        source_dealer_url: sourceDealerUrl,
        url_map: urlMap
      })
      .select()
      .single()
    if (error) return res.status(500).json({ error: error.message })
    console.log(`✓ Added feed: ${detectedPlatform || 'direct'} → ${workingUrl}`)
    res.json({
      ...data,
      platform: detectedPlatform,
      needs_extension_capture: detectedPlatformSlug === 'needs_extension_capture'
    })
  })

  app.delete('/inventory-feeds/:id', requireAuth, async (req, res) => {
    const canManage = req.profile.role === 'DEALER_ADMIN'
      || req.profile.role === 'OWNER'
      || req.profile.dealerships?.is_personal === true
    if (!canManage) return res.status(403).json({ error: 'Only dealer admins or solo reps can manage feeds' })

    const { data: feed } = await supabaseAdmin
      .from('inventory_feeds')
      .select('id, dealership_id, feed_url, source_dealer_url')
      .eq('id', req.params.id)
      .single()
    if (!feed || feed.dealership_id !== req.dealershipId) {
      return res.status(404).json({ error: 'Feed not found' })
    }

    // Collect every origin this feed covers. We check BOTH feed_url and
    // source_dealer_url because for many platforms the vehicles' source_url lives on
    // the dealer site origin while the feed_url is a JSON/proxy host on a different
    // origin — matching only feed_url would orphan inventory on delete.
    const originsOf = (...urls) => {
      const s = new Set()
      for (const u of urls) { try { if (u) s.add(new URL(u).origin) } catch {} }
      return s
    }
    const feedOrigins = originsOf(feed.feed_url, feed.source_dealer_url)

    // 0. Precise path: if inventory rows are tagged with this feed_id, remove them
    // (and detach their listings) directly — reliable for ANY platform regardless of
    // whether the vehicle source_url shares the feed's origin. Legacy rows without a
    // feed_id fall through to the origin-matching logic below.
    let deletedByFeedId = 0
    if (await inventoryHasFeedId()) {
      const { data: byFeed } = await supabaseAdmin
        .from('inventory').select('id').eq('dealership_id', req.dealershipId).eq('feed_id', req.params.id)
      const ids = (byFeed || []).map(r => r.id)
      for (let i = 0; i < ids.length; i += 100) {
        const slice = ids.slice(i, i + 100)
        await supabaseAdmin.from('listings').delete().in('inventory_id', slice)
        await supabaseAdmin.from('inventory').delete().in('id', slice)
      }
      deletedByFeedId = ids.length
    }

    // 1. Remove the feed row itself
    const { error: delFeedErr } = await supabaseAdmin
      .from('inventory_feeds').delete().eq('id', req.params.id)
    if (delFeedErr) return res.status(500).json({ error: delFeedErr.message })

    // 2. Decide what inventory should also be removed.
    // Look at the dealership's REMAINING feeds. If another feed still covers one of
    // this feed's origins (e.g., you deleted /new/ but kept /used/), leave that
    // inventory — the remaining feed covers it and the next sync reconciles.
    const { data: remainingFeeds } = await supabaseAdmin
      .from('inventory_feeds').select('feed_url, source_dealer_url').eq('dealership_id', req.dealershipId)

    const remainingOrigins = new Set()
    for (const f of remainingFeeds || []) {
      for (const o of originsOf(f.feed_url, f.source_dealer_url)) remainingOrigins.add(o)
    }

    let inventoryDeleted = 0
    let toDelete = []

    if (Array.isArray(remainingFeeds) && remainingFeeds.length === 0) {
      // No feeds left at all — wipe the dealership's inventory entirely
      const { data: all } = await supabaseAdmin
        .from('inventory').select('id').eq('dealership_id', req.dealershipId)
      toDelete = (all || []).map(r => r.id)
    } else {
      // Origins covered ONLY by the deleted feed (not by any remaining feed).
      const orphanedOrigins = [...feedOrigins].filter(o => !remainingOrigins.has(o))
      if (orphanedOrigins.length) {
        const { data: matching } = await supabaseAdmin
          .from('inventory').select('id, source_url')
          .eq('dealership_id', req.dealershipId)
        toDelete = (matching || [])
          .filter(r => r.source_url && orphanedOrigins.some(o => r.source_url.startsWith(o)))
          .map(r => r.id)
      }
    }

    // 3. Cascade-delete listings then inventory, batched to avoid URL-length limits
    if (toDelete.length) {
      for (let i = 0; i < toDelete.length; i += 100) {
        const slice = toDelete.slice(i, i + 100)
        // Listings have FK to inventory — must go first
        await supabaseAdmin.from('listings').delete().in('inventory_id', slice)
        await supabaseAdmin.from('inventory').delete().in('id', slice)
      }
      inventoryDeleted = toDelete.length
    }
    inventoryDeleted += deletedByFeedId
    if (inventoryDeleted) {
      console.log(`[feed delete] dealership=${req.dealershipId} feed=${req.params.id} removed ${inventoryDeleted} inventory rows (${deletedByFeedId} by feed_id)`)
    }

    res.json({ success: true, inventory_deleted: inventoryDeleted })
  })
}
