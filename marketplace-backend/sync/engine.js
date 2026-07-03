import { supabaseAdmin, sleep, browserFetch } from '../shared.js'
import { renderAndCaptureInventory, genericMapVehicle, inferUrlTemplate, renderUrlTemplate, fetchViaBrowser } from '../puppeteerRenderer.js'
import { PLATFORM_PROBES, fetchConvertusInventory, fetchDealerPageInventory,
         fetchEDealerInventoryFromSitemap, extractEDealerDetailUrls, fetchEDealerDetailImageGroups,
         extractEDealerImageGroups, extractCarsFromJsonLd, fetchListingPageInventory } from './platforms.js'
import { mapFuel, buildDescription, fetchVehiclePhotos } from '../utils/description.js'

// Per-dealership in-flight sync tracking. Prevents the boot sync, the post-add
// auto-sync, and a manual Sync Now click from all running for the same dealership
// at the same time — that overlap was the cause of "Exited with status 134" (OOM
// from multiple large feed parses overlapping in memory).
const _syncsInFlight = new Map()  // dealershipId → Promise<result>

// Live sync progress, keyed by dealershipId, so the dashboard's Sync button can
// poll an accurate percentage and the user knows it isn't frozen. In-memory only
// (fine for our single Render instance); entries self-expire shortly after a sync
// finishes. Overall pct blends feed index + per-feed import fraction so it climbs
// smoothly 0→100 even across multiple feeds.
export const syncProgress = new Map()  // dealershipId → { phase, feedIndex, feedCount, current, total, pct, message, updatedAt }

export function setSyncProgress(dealershipId, patch) {
  const prev = syncProgress.get(dealershipId) || {}
  syncProgress.set(dealershipId, { ...prev, ...patch, updatedAt: Date.now() })
}

function syncOverallPct(feedIndex, feedCount, current, total) {
  if (!feedCount) return 0
  const feedFraction = total > 0 ? current / total : 0
  // Cap at 99 until the run fully finalizes (delete-diff + count queries still run).
  return Math.min(99, Math.round(((feedIndex + feedFraction) / feedCount) * 100))
}

// Feature-detect the inventory.feed_id column once per process. Lets us tag each
// vehicle with the feed that produced it (precise, cascade-safe deletes) WITHOUT
// breaking sync if the migration hasn't been run yet — we just omit the column.
let _invHasFeedId = null
export async function inventoryHasFeedId() {
  if (_invHasFeedId !== null) return _invHasFeedId
  const { error } = await supabaseAdmin.from('inventory').select('feed_id').limit(1)
  _invHasFeedId = !error
  if (error) console.warn('[sync] inventory.feed_id column missing — run the migration for precise feed-scoped deletes (falling back to origin matching)')
  return _invHasFeedId
}

export async function runInventorySync(dealershipId) {
  if (_syncsInFlight.has(dealershipId)) {
    console.log(`[sync] piggy-backing on in-flight sync for ${dealershipId}`)
    return _syncsInFlight.get(dealershipId)
  }
  setSyncProgress(dealershipId, { phase: 'starting', feedIndex: 0, feedCount: 0, current: 0, total: 0, pct: 0, message: 'Starting sync…' })
  const promise = _runInventorySyncInner(dealershipId)
  _syncsInFlight.set(dealershipId, promise)
  try {
    const result = await promise
    setSyncProgress(dealershipId, { phase: 'done', pct: 100, message: 'Sync complete.' })
    return result
  } catch (e) {
    setSyncProgress(dealershipId, { phase: 'error', message: e.message || 'Sync failed.' })
    throw e
  } finally {
    _syncsInFlight.delete(dealershipId)
    // Keep the terminal state briefly so a final poll can read 100%/error, then drop it.
    const ds = dealershipId
    setTimeout(() => syncProgress.delete(ds), 15000)
  }
}

async function _runInventorySyncInner(dealershipId) {
  // Defensive: ask for the new columns first; if any is missing (migration not yet run),
  // retry with the legacy column set so sync still works. Surfaces a clear warning instead
  // of silently flipping to "No inventory feeds configured".
  let feeds = null
  let selectError = null
  {
    const { data, error } = await supabaseAdmin
      .from('inventory_feeds')
      .select('id, feed_url, feed_type, platform, source_dealer_url, url_map, url_template')
      .eq('dealership_id', dealershipId)
    if (!error) { feeds = data }
    else selectError = error
  }
  if (!feeds) {
    console.warn(`[sync] full column select failed (${selectError?.message}) — falling back to legacy columns`)
    const { data, error } = await supabaseAdmin
      .from('inventory_feeds')
      .select('id, feed_url, feed_type')
      .eq('dealership_id', dealershipId)
    if (error) {
      console.error('[sync] legacy column select also failed:', error.message)
      return { success: false, error: `Could not read inventory feeds: ${error.message}` }
    }
    feeds = data
  }
  if (!feeds || feeds.length === 0) {
    return { success: false, error: 'No inventory feeds configured for this dealership.' }
  }

  let totalAttempts = 0, totalSkipped = 0, totalVehiclesFound = 0
  // Aggregate skip reasons across all feeds for this dealership — surfaced in the API
  // response so the dashboard can show exactly WHY vehicles got rejected. Beats reading
  // Render logs to debug a sync.
  const skipReasons = { feed_type: 0, offline: 0, no_identifier: 0, upsert_error: 0 }
  const uniqueVins = new Set()  // VINs successfully upserted this run
  const allRawVins = new Set()  // every VIN from raw feed data (no filter) — for auto-sold

  const jsonCache = new Map()
  const hasFeedId = await inventoryHasFeedId()

  let feedIndex = -1
  for (const feed of feeds) {
    feedIndex++
    setSyncProgress(dealershipId, {
      phase: 'fetching', feedIndex, feedCount: feeds.length, current: 0, total: 0,
      pct: syncOverallPct(feedIndex, feeds.length, 0, 0),
      message: feeds.length > 1 ? `Fetching inventory (feed ${feedIndex + 1}/${feeds.length})…` : 'Fetching inventory…'
    })
    try {
      let vehicles

      if (feed.platform === 'needs_extension_capture') {
        // This feed was flagged Cloudflare-blocked when it was added — but that
        // detection is often wrong (it ran while the server was overloaded, or the
        // block was transient). Try walking the dealer's listing page directly from
        // the server via the universal JSON-LD paginator. If we get vehicles, the
        // site is reachable — permanently flip it to 'edealer' so it syncs without
        // the extension forever after. If genuinely blocked, skip fast: NO puppeteer,
        // NO sitemap walker, nothing that can stall the loop for the other dealers.
        const listingUrl = feed.source_dealer_url || feed.feed_url
        let healedVehicles = null
        try {
          healedVehicles = await fetchListingPageInventory(listingUrl)
        } catch {}
        if (healedVehicles && healedVehicles.length > 0) {
          const apiUrl = (() => { try { return new URL(listingUrl).origin + '/api/inventory/getall' } catch { return feed.feed_url } })()
          console.log(`[sync] feed ${feed.id}: reachable server-side (${healedVehicles.length} vehicles) — flipping to edealer`)
          await supabaseAdmin
            .from('inventory_feeds')
            .update({ platform: 'edealer', feed_url: apiUrl, source_dealer_url: listingUrl })
            .eq('id', feed.id)
          feed.platform = 'edealer'
          feed.feed_url = apiUrl
          feed.source_dealer_url = listingUrl
          // We already have the inventory from the heal probe — use it directly.
          vehicles = healedVehicles
          jsonCache.set(feed.feed_url, vehicles)
        } else {
          console.log(`[sync] feed ${feed.id} requires Chrome extension — skipping server-side fetch`)
          continue
        }
      }

      // Match this feed to its probe definition so we can apply the right field mapper
      const probe = PLATFORM_PROBES.find(p => p.platform === feed.platform)

      // ── URL DISCOVERY (puppeteer-gated) ─────────────────────────────────────
      // Browser-based template inference + URL harvest are MEMORY HUNGRY (~200MB
      // per Chromium instance). On Render's free tier they push the process past
      // its 512MB limit and crash the sync mid-run. The deterministic builders
      // in buildSourceUrl already cover LeadBox + UX Auto (the two platforms we
      // actually use), so this puppeteer-based discovery is now opt-in only.
      //
      // To re-enable on a beefier instance, set ENABLE_PUPPETEER_DISCOVERY=1 in
      // Render → Environment. The deterministic builders run regardless.
      if (process.env.ENABLE_PUPPETEER_DISCOVERY === '1' && !feed.url_template) {
        try {
          console.log(`[sync] Inferring url_template for feed ${feed.id} (${feed.platform || 'unknown'})...`)
          const dealerSite = feed.source_dealer_url
            || (feed.feed_url?.includes('/wp-content') ? feed.feed_url.split('/wp-content')[0] : null)
            || (() => { try { return new URL(feed.feed_url).origin } catch { return null } })()
          if (dealerSite) {
            let feedJson = null
            try {
              const feedRes = await fetch(feed.feed_url, {
                headers: {
                  'Accept': 'application/json',
                  'Origin': feed.source_dealer_url ? new URL(feed.source_dealer_url).origin : '',
                  'Referer': feed.source_dealer_url || ''
                }
              })
              feedJson = await feedRes.json().catch(() => null)
            } catch {}
            const samples = feedJson?.vehicles || feedJson?.records || (Array.isArray(feedJson) ? feedJson : [])
            if (samples.length) {
              const inferred = await inferUrlTemplate(dealerSite, samples)
              if (inferred.ok && inferred.template) {
                await supabaseAdmin
                  .from('inventory_feeds')
                  .update({ url_template: inferred.template })
                  .eq('id', feed.id)
                feed.url_template = inferred.template
                console.log(`[sync] ✓ Inferred template (via ${inferred.matched_by}): ${inferred.template}`)
              } else {
                console.warn(`[sync] Template inference failed: ${inferred.error}`)
              }
            }
          }
        } catch (e) {
          console.warn(`[sync] url_template inference failed (non-fatal): ${e.message}`)
        }
      }

      if (jsonCache.has(feed.feed_url)) {
        vehicles = jsonCache.get(feed.feed_url)
      } else if (feed.platform === 'spa_render') {
        // SPA dealer. The captured XHR URL almost always works for plain HTTP fetches —
        // try that first (fast). Re-render the dealer site only if direct fetch fails
        // (XHR URL broken, auth rotated, dealer moved). When re-render finds a new URL,
        // update the stored feed_url so future syncs use it.
        vehicles = []
        let usedFreshUrl = null

        try {
          const r = await fetch(`${feed.feed_url}?v=${Date.now()}`, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36',
              'Accept': 'application/json',
              'Origin': feed.source_dealer_url ? new URL(feed.source_dealer_url).origin : '',
              'Referer': feed.source_dealer_url || ''
            }
          })
          const ct = r.headers.get('content-type') || ''
          if (r.ok && ct.includes('json')) {
            const data = await r.json()
            const raw = data.records || data.vehicles || data.data || data.inventory || (Array.isArray(data) ? data : [])
            if (raw.length > 0) {
              vehicles = raw.map(genericMapVehicle)
              console.log(`[sync] SPA direct fetch: ${vehicles.length} vehicles from ${feed.feed_url}`)
            }
          }
        } catch (e) {
          console.warn(`[sync] SPA direct fetch failed for ${feed.feed_url}: ${e.message}`)
        }

        // Direct fetch returned nothing → re-render the dealer's listing page
        if (vehicles.length === 0 && feed.source_dealer_url) {
          console.log(`[sync] SPA direct fetch returned 0 — re-rendering ${feed.source_dealer_url}`)
          const rendered = await renderAndCaptureInventory(feed.source_dealer_url)
          if (rendered.success && rendered.vehicles?.length > 0) {
            vehicles = rendered.vehicles.map(genericMapVehicle)
            usedFreshUrl = rendered.source_url
            console.log(`[sync] SPA re-render: ${vehicles.length} vehicles from ${rendered.source_url}`)
          } else {
            console.warn(`[sync] SPA re-render also failed: ${rendered.error}`)
          }
        }

        // Persist the new XHR URL if re-render found a different one
        if (usedFreshUrl && usedFreshUrl !== feed.feed_url) {
          await supabaseAdmin
            .from('inventory_feeds')
            .update({ feed_url: usedFreshUrl })
            .eq('id', feed.id)
          console.log(`[sync] Updated feed_url for feed ${feed.id} → ${usedFreshUrl}`)
        }

        jsonCache.set(feed.feed_url, vehicles)
        totalVehiclesFound += vehicles.length
      } else if (feed.platform === 'convertus') {
        // Convertus/VMS — re-derive origin + inventoryId from the stored proxy feed_url
        // and paginate the same-origin proxy for the full inventory.
        const origin = (() => { try { return new URL(feed.feed_url).origin } catch { return null } })()
        const cpMatch = decodeURIComponent(feed.feed_url).match(/[?&]cp=(\d+)/)
        const inventoryId = cpMatch ? cpMatch[1] : null
        if (origin && inventoryId) {
          vehicles = await fetchConvertusInventory(origin, inventoryId, feed.feed_type)
        } else {
          console.warn(`[sync] Convertus feed ${feed.id} missing origin/inventoryId in feed_url`)
          vehicles = []
        }
        jsonCache.set(feed.feed_url, vehicles)
        totalVehiclesFound += vehicles.length
      } else if (feed.platform === 'dealerpage') {
        // DealerPage — re-fetch & re-parse the listing HTML each sync (real photo
        // URLs are in the page, so no detail-page enrichment is needed).
        vehicles = await fetchDealerPageInventory(feed.feed_url)
        jsonCache.set(feed.feed_url, vehicles)
        totalVehiclesFound += vehicles.length
      } else if (feed.platform === 'ux_auto') {
        // UX Auto splits inventory across /NEW, /USED, /DEMO endpoints — fetch all three
        const base = feed.feed_url.replace(/\/(NEW|USED|DEMO|new|used|demo)\/?$/, '')
        const conditions = ['NEW', 'USED', 'DEMO']
        const all = []
        for (const cond of conditions) {
          try {
            const r = await browserFetch(`${base}/${cond}?v=${Date.now()}`, {
              headers: { 'Accept': 'application/json' }
            })
            if (!r.ok) continue
            const d = await r.json()
            if (d?.result === 'Success' && Array.isArray(d.records)) all.push(...d.records)
          } catch {}
        }
        vehicles = all
        jsonCache.set(feed.feed_url, vehicles)
        totalVehiclesFound += vehicles.length
      } else if (feed.platform === 'edealer') {
        // eDealer full inventory: paginate the LISTING page and read its Schema.org
        // JSON-LD. The /api/inventory/getall API caps at ~25 and ignores pagination,
        // so the listing-page walk (lightweight HTML fetches, ~25 vehicles/page with
        // VIN dedup) is the reliable full-inventory source. API is only a fallback.
        let origin
        try { origin = new URL(feed.feed_url).origin } catch { origin = '' }

        // Build the listing page(s) to walk. Prefer the dealer URL the user actually
        // added; otherwise derive /inventory/<type>/ from the origin + feed_type.
        const listingUrls = []
        const src = feed.source_dealer_url
        if (src && /\/(inventory|inventaire|new|used|pre-owned|vehicles)\b/i.test(src)) {
          listingUrls.push(src)
        } else if (origin) {
          const ft = (feed.feed_type || 'all').toLowerCase()
          if (ft === 'new') listingUrls.push(`${origin}/inventory/new/`)
          else if (ft === 'used') listingUrls.push(`${origin}/inventory/used/`)
          else listingUrls.push(`${origin}/inventory/new/`, `${origin}/inventory/used/`)
        }

        const seenIds = new Set()
        const all = []
        for (const lu of listingUrls) {
          const walked = await fetchListingPageInventory(lu)
          for (const v of walked || []) {
            const id = v.vin || (v.stocknumber ? `stk:${v.stocknumber}` : null)
            if (id && !seenIds.has(id)) { seenIds.add(id); all.push(v) }
          }
        }

        if (all.length > 0) {
          vehicles = all
          console.log(`[sync] eDealer listing walk: ${vehicles.length} vehicles`)
        } else {
          // Listing walk found nothing (blocked, or non-standard structure) — try the
          // API once so we at least get the first page. Skip fast if that's blocked too.
          const basePath = feed.feed_url.replace(origin, '').split('?')[0]
          try {
            const r = await browserFetch(`${origin}${basePath}`, { headers: { Accept: 'application/json' } })
            if (r.ok && (r.headers.get('content-type') || '').includes('json')) {
              const d = await r.json().catch(() => null)
              const probe = PLATFORM_PROBES.find(p => p.platform === 'edealer')
              vehicles = d && probe?.validate(d) ? probe.extract(d) : []
              console.log(`[sync] eDealer API fallback: ${vehicles.length} vehicles`)
            } else {
              console.log(`[sync] eDealer unreachable (HTTP ${r.status}) — extension capture required`)
              vehicles = []
            }
          } catch (e) {
            console.log(`[sync] eDealer fetch failed: ${e.message}`)
            vehicles = []
          }
        }
        jsonCache.set(feed.feed_url, vehicles)
        totalVehiclesFound += vehicles.length
      } else {
        const feedRes = await browserFetch(`${feed.feed_url}?v=${Date.now()}`, {
          headers: { 'Accept': 'application/json, text/plain, */*', 'Sec-Fetch-Dest': 'empty', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Site': 'same-origin' }
        })
        let ct = feedRes.headers.get('content-type') || ''

        // Read the body once. On a Cloudflare/WAF block (403/503), skip fast.
        // Retrying via headless Chrome is opt-in (ENABLE_PUPPETEER_FALLBACK=1):
        // on the 512MB tier, launching Chrome starves the whole server — every
        // other dealer's sync AND all dashboard API calls stall behind it.
        let bodyText
        if (feedRes.status === 403 || feedRes.status === 503) {
          if (process.env.ENABLE_PUPPETEER_FALLBACK === '1') {
            console.log(`[sync] feed ${feed.feed_url} blocked (HTTP ${feedRes.status}) — retrying via headless Chrome`)
            const br = await fetchViaBrowser(`${feed.feed_url}?v=${Date.now()}`)
            bodyText = br.ok ? br.body : ''
            if (br.contentType) ct = br.contentType
          } else {
            console.log(`[sync] feed ${feed.feed_url} blocked (HTTP ${feedRes.status}) — skipping (extension capture or ENABLE_PUPPETEER_FALLBACK=1)`)
            bodyText = ''
          }
        } else {
          bodyText = await feedRes.text()
        }

        const looksJson = ct.includes('json') || /^\s*[\[{]/.test(bodyText || '')
        if (!bodyText) {
          // Blocked or empty response — nothing to parse, don't run the sitemap
          // walker (it would just re-hit the same WAF 100 more times).
          vehicles = []
          jsonCache.set(feed.feed_url, vehicles)
        } else if (looksJson) {
          let data = null
          try { data = JSON.parse(bodyText) } catch {}
          vehicles = data ? (data.vehicles || data.inventory || data.data || data.items || data.records || (Array.isArray(data) ? data : [])) : []
          jsonCache.set(feed.feed_url, vehicles)
          totalVehiclesFound += vehicles.length
        } else {
          // HTML response — extract Schema.org JSON-LD, then try Puppeteer
          const html = bodyText
          const blocks = []
          const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
          let m
          while ((m = re.exec(html)) !== null) {
            try { blocks.push(JSON.parse(m[1])) } catch {}
          }
          // Iterative flattener — same stack-safety reason as extractCarsFromJsonLd
          const flat = []
          const walkQueue = [...blocks]
          while (walkQueue.length > 0) {
            const n = walkQueue.pop()
            if (!n) continue
            if (Array.isArray(n)) { for (const x of n) walkQueue.push(x); continue }
            if (Array.isArray(n['@graph'])) { for (const x of n['@graph']) walkQueue.push(x); continue }
            flat.push(n)
          }
          const cars = extractCarsFromJsonLd(flat)
          const origin = new URL(feed.feed_url).origin

          // Universal listing-page JSON-LD paginator — feed_url returned HTML, so it
          // IS a listing page. Paginate it to get FULL inventory across every major
          // US/Canada platform (Dealer.com, DealerInspire, DealerOn, Sincro/CDK,
          // eDealer, VinSolutions, …). Falls back to the eDealer sitemap walker, then
          // to single-page JSON-LD + detail enrichment.
          const walked = await fetchListingPageInventory(feed.feed_url)
          const sitemapVehicles = (!walked || walked.length <= cars.length)
            ? await fetchEDealerInventoryFromSitemap(origin) : null
          if (walked && walked.length > 0 && walked.length >= cars.length &&
              (!sitemapVehicles || walked.length >= sitemapVehicles.length)) {
            console.log(`[sync] Using listing-page walk (${walked.length} vehicles)`)
            vehicles = walked
            jsonCache.set(feed.feed_url, vehicles)
            totalVehiclesFound += vehicles.length
          } else if (sitemapVehicles && sitemapVehicles.length > cars.length) {
            console.log(`[sync] Using sitemap walker (${sitemapVehicles.length} vehicles) instead of listing-page JSON-LD (${cars.length})`)
            vehicles = sitemapVehicles
            jsonCache.set(feed.feed_url, vehicles)
            totalVehiclesFound += vehicles.length
          } else {
            // Fallback: listing-page JSON-LD + detail page photo enrichment
            const detailUrls = extractEDealerDetailUrls(html, origin)
            let imageGroups = []
            if (detailUrls.length === cars.length && detailUrls.length > 0) {
              console.log(`[sync] Fetching ${detailUrls.length} detail pages for per-vehicle photos`)
              imageGroups = await fetchEDealerDetailImageGroups(detailUrls)
            } else {
              imageGroups = extractEDealerImageGroups(html)
            }
            vehicles = cars.map((c, i) => ({
              vin: c.vehicleIdentificationNumber,
              year: c.vehicleModelDate,
              make: c.brand?.name || c.manufacturer?.name || c.brand,
              model: c.model,
              trim: (() => {
                const cfg = typeof c.vehicleConfiguration === 'string' ? c.vehicleConfiguration : ''
                const parts = cfg.split(' ')
                return parts.length > 1 ? parts.slice(0, -1).join(' ') : null
              })(),
              price: c.offers?.price,
              mileage: c.mileageFromOdometer?.value,
              exteriorcolor: c.color,
              interiorcolor: c.vehicleInteriorColor,
              transmission: c.vehicleTransmission,
              fueltype: c.vehicleEngine?.fuelType,
              bodystyle: c.bodyType,
              condition: (c.itemCondition || '').includes('NewCondition') ? 'New'
                : (c.itemCondition || '').includes('UsedCondition') ? 'Used' : null,
              stocknumber: c.sku || c.productID,
              onweb: true,
              salepending: false,
              image_urls: (() => {
                if (imageGroups[i]?.length) return imageGroups[i]
                const img = Array.isArray(c.image) ? c.image[0] : c.image
                if (!img || (typeof img === 'string' && img.includes('coming.png'))) return []
                return [img]
              })(),
              _detail_url: detailUrls[i] || feed.feed_url
            }))
            jsonCache.set(feed.feed_url, vehicles)
            totalVehiclesFound += vehicles.length
          }
        }
      }

      // Normalize raw vehicle records using this platform's mapper (additive — raw
      // fields stay accessible, mapper overrides with the canonical field names that
      // the rest of the sync engine expects: vin, stocknumber, price, exteriorcolor, etc.)
      if (probe?.mapVehicle) {
        // In-place merge instead of spread+map — saves ~50% peak memory on large
        // feeds (500+ cars). The previous version doubled the vehicles array by
        // creating a new wrapper object for every entry.
        for (const raw of vehicles) Object.assign(raw, probe.mapVehicle(raw))
      }

      // Capture every VIN from raw feed for auto-sold logic
      for (const v of vehicles) {
        if (v.vin) allRawVins.add(v.vin)
      }

      let skippedNoIdentifier = 0
      let skippedFeedType = 0
      let skippedOnweb = 0

      // Iterate by index so we can null-out each vehicle after upserting it.
      // For 500+ vehicle feeds this lets V8 reclaim per-vehicle memory mid-loop
      // instead of holding the whole array until the sync finishes.
      const feedTotal = vehicles.length
      setSyncProgress(dealershipId, {
        phase: 'importing', feedIndex, feedCount: feeds.length, current: 0, total: feedTotal,
        pct: syncOverallPct(feedIndex, feeds.length, 0, feedTotal),
        message: feeds.length > 1
          ? `Importing vehicles (feed ${feedIndex + 1}/${feeds.length}): 0/${feedTotal}`
          : `Importing vehicles: 0/${feedTotal}`
      })
      for (let vehicleIdx = 0; vehicleIdx < vehicles.length; vehicleIdx++) {
        const v = vehicles[vehicleIdx]
        // Report progress every vehicle — cheap, and the loop already sleeps 200ms each.
        setSyncProgress(dealershipId, {
          current: vehicleIdx + 1,
          pct: syncOverallPct(feedIndex, feeds.length, vehicleIdx + 1, feedTotal),
          message: feeds.length > 1
            ? `Importing vehicles (feed ${feedIndex + 1}/${feeds.length}): ${vehicleIdx + 1}/${feedTotal}`
            : `Importing vehicles: ${vehicleIdx + 1}/${feedTotal}`
        })
        if (!v) continue
        if (!matchesFeedType(v, feed.feed_type)) { totalSkipped++; skippedFeedType++; vehicles[vehicleIdx] = null; continue }
        if (v.onweb === false || v.nonvehicle) { totalSkipped++; skippedOnweb++; vehicles[vehicleIdx] = null; continue }
        // Need SOME unique identifier — VIN preferred, stock# acceptable. Was previously
        // rejecting all vehicles with no VIN, which made schema_jsonld dealer sites (where
        // JSON-LD often omits VIN) sync 0 vehicles.
        if (!v.vin && !v.stocknumber) { totalSkipped++; skippedNoIdentifier++; vehicles[vehicleIdx] = null; continue }

        await sleep(200)

        let imageUrls = Array.isArray(v.image_urls) && v.image_urls.length ? v.image_urls : []
        if (!imageUrls.length && v.stocknumber) {
          imageUrls = await fetchVehiclePhotos(v.stocknumber)
        }

        const sourceUrl = buildSourceUrl(feed, v)

        // Synthesize a stable VIN when one isn't provided — combine dealer + stock so
        // the same vehicle re-syncs cleanly without exploding the inventory table.
        const effectiveVin = v.vin || `STK-${dealershipId.slice(0, 8)}-${v.stocknumber}`

        // Platform-agnostic sold/pending detection: honor whatever status the feed
        // exposes (DealerPage sets v.sold; JSON feeds may carry status/availability)
        // A vehicle can't be both — sold wins over pending.
        const statusStr = String(v.status || v.availability || v.sale_status || v.saleStatus || v.state || '').toLowerCase()
        const isSold = v.sold === true || /\bsold\b|sold[\s_-]?out|soldout/.test(statusStr)
        const isPending = !isSold && (v.salepending === true || v.sale_pending === true || /pending|deposit|on[\s_-]?hold|in[\s_-]?progress/.test(statusStr))

        const record = {
  dealership_id: dealershipId,
  vin: effectiveVin,
  year: parseInt(v.year),
  make: v.make,
  model: v.model,
  trim: v.trim || null,
  price: v.saleprice || v.price || 0,
  mileage: v.mileage || 0,
  condition: (v.demo === true || v.demo === 1 || /^demo/i.test(v.condition || '') || /^demo/i.test(v.sale_class || '')) ? 'Demo' : (v.condition || null),
  stocknumber: v.stocknumber || null,
  exterior_color: v.exteriorcolor || null,
  interior_color: v.interiorcolor || null,
  transmission: v.transmission || null,
  fuel_type: mapFuel(v.fueltype),
  description: buildDescription(v),
  image_urls: imageUrls,
  source_url: sourceUrl,
  status: isSold ? 'sold' : (isPending ? 'pending' : 'available'),
  last_synced_at: new Date().toISOString(),
  // Tag the originating feed when the column exists → ON DELETE CASCADE removes
  // these rows automatically when the feed is deleted (omitted pre-migration).
  ...(hasFeedId ? { feed_id: feed.id } : {})
}

        const { error } = await supabaseAdmin
          .from('inventory')
          .upsert(record, { onConflict: 'vin' })
        if (error) {
          totalSkipped++
          skipReasons.upsert_error++
          if (skipReasons.upsert_error <= 3) console.warn(`[sync] upsert error: ${error.message}`)
        } else {
          totalAttempts++
          uniqueVins.add(effectiveVin)
        }
        // Release per-vehicle memory after upsert — gives V8 the chance to GC
        // the vehicle's image_urls + description + raw feed fields mid-loop
        vehicles[vehicleIdx] = null
      }

      // Aggregate this feed's skip counts into the dealership-wide totals
      skipReasons.feed_type += skippedFeedType
      skipReasons.offline += skippedOnweb
      skipReasons.no_identifier += skippedNoIdentifier

      // Verbose per-feed skip diagnostics — also kept in Render logs for deeper digs
      if (totalSkipped > 0) {
        console.log(`[sync] feed ${feed.id} skip breakdown: feed_type=${skippedFeedType}, offline=${skippedOnweb}, no_identifier=${skippedNoIdentifier}, upsert_error=${skipReasons.upsert_error}`)
      }
    } catch (feedErr) {
      console.error('[sync] Feed error:', feedErr.message)
    }
  }

  // ── Auto-sold: single clean block ──
  // Union raw feed VINs with successfully upserted VINs to avoid false sold marking
  // when JSON-LD is missing vehicleIdentificationNumber on some vehicles.
  console.log(`[sync] allRawVins captured: ${allRawVins.size} of ${totalVehiclesFound} vehicles`)

  if (allRawVins.size > 0) {
    const captureRate = allRawVins.size / Math.max(totalVehiclesFound, 1)
    if (captureRate < 0.8) {
      console.warn(`[sync] VIN capture rate too low (${Math.round(captureRate * 100)}%) — skipping auto-sold to avoid false positives`)
    } else {
      // Union: allRawVins (from feed) + uniqueVins (actually upserted this run)
      const feedVinSet = new Set([...allRawVins, ...uniqueVins])

      // Compute the sold/restore diffs in JS rather than via PostgREST .not().in()
      // — the URL-encoded VIN list breaks past ~100 VINs and silently matches everything,
      // causing the entire inventory to flip to sold. Doing it in JS is reliable at any scale.
      const { data: currentRows, error: fetchErr } = await supabaseAdmin
        .from('inventory')
        .select('id, vin, status')
        .eq('dealership_id', dealershipId)
        .eq('status', 'available')   // sold rows are now deleted, not flagged
      if (fetchErr) {
        console.error('[sync] could not fetch current inventory for diff:', fetchErr.message)
      } else {
        // Vehicle no longer in feed → it's gone from the dealer site, delete it.
        // (Listings rows survive thanks to ON DELETE SET NULL on inventory_id.)
        const toDelete = []
        for (const row of currentRows || []) {
          if (!row.vin) continue
          if (!feedVinSet.has(row.vin)) toDelete.push(row.id)
        }

        // Safety brake: if the diff says >50% of current inventory must be deleted,
        // something's off (feed change, partial fetch) — skip rather than wipe data.
        const totalCount = (currentRows || []).length
        if (totalCount > 0 && toDelete.length / totalCount > 0.5) {
          console.warn(`[sync] would delete ${toDelete.length}/${totalCount} inventory rows — refusing (likely sync glitch)`)
        } else if (toDelete.length) {
          for (let i = 0; i < toDelete.length; i += 100) {
            const slice = toDelete.slice(i, i + 100)
            // Dropped from the feed → if any were posted to Facebook, queue their
            // listings for DELETION from Marketplace (the extension performs it). Do
            // this BEFORE deleting inventory so inventory_id still matches. Wrapped so a
            // pre-migration DB (no fb_sync_action column) never breaks the sync.
            try {
              await supabaseAdmin
                .from('listings')
                .update({ status: 'deleted', deleted_at: new Date().toISOString(), fb_sync_action: 'delete', fb_synced_at: null })
                .in('inventory_id', slice)
                .eq('status', 'posted')
                .not('fb_listing_url', 'is', null)
            } catch (e) { console.warn('[sync] delete→FB queue failed (non-fatal):', e.message) }
            // Listings FK is ON DELETE SET NULL → their history survives.
            await supabaseAdmin.from('inventory').delete().in('id', slice)
          }
          console.log(`[sync] auto-delete: ${toDelete.length} inventory rows removed (dropped from feed)`)
        }
      }
    }
  }

  // Feed marks a vehicle SOLD but keeps it listed (e.g. DealerPage) → if it was
  // posted to Facebook, queue a "mark sold" so the FB listing reflects it. Idempotent:
  // once the listing flips to 'sold' it no longer matches status='posted'.
  try {
    const { data: soldRows } = await supabaseAdmin
      .from('inventory').select('id')
      .eq('dealership_id', dealershipId).eq('status', 'sold')
    const soldIds = (soldRows || []).map(r => r.id)
    for (let i = 0; i < soldIds.length; i += 100) {
      const slice = soldIds.slice(i, i + 100)
      await supabaseAdmin.from('listings')
        .update({ status: 'sold', deleted_at: new Date().toISOString(), fb_sync_action: 'sold', fb_synced_at: null })
        .in('inventory_id', slice).eq('status', 'posted').not('fb_listing_url', 'is', null)
    }
  } catch (e) { console.warn('[sync] sold→FB queue failed (non-fatal):', e.message) }

  setSyncProgress(dealershipId, { phase: 'finalizing', pct: 99, message: 'Finalizing…' })

  const { count: availableCount } = await supabaseAdmin
    .from('inventory')
    .select('id', { count: 'exact', head: true })
    .eq('dealership_id', dealershipId)
    .eq('status', 'available')

  return {
    success: true,
    total_in_feeds: totalVehiclesFound,
    unique_vehicles: uniqueVins.size,
    available_after_sync: availableCount || 0,
    attempts: totalAttempts,
    duplicates_merged: Math.max(0, totalAttempts - uniqueVins.size),
    skipped: totalSkipped,
    skip_breakdown: skipReasons,
    synced_at: new Date().toISOString()
  }
}

export async function syncAllDealerships(triggerLabel = 'scheduled') {
  const startedAt = new Date().toISOString()
  console.log(`[sync-all:${triggerLabel}] started at ${startedAt}`)

  const { data: dealerships, error } = await supabaseAdmin
    .from('dealerships').select('id, name')
  if (error) {
    console.error(`[sync-all:${triggerLabel}] failed to list dealerships:`, error.message)
    return { success: false, error: error.message }
  }

  const results = []
  for (const d of dealerships || []) {
    try {
      const r = await runInventorySync(d.id)
      console.log(
        `[sync-all:${triggerLabel}] ${d.name} (${d.id}):`,
        r.success ? `${r.unique_vehicles} unique, ${r.skipped} skipped` : r.error
      )
      results.push({ dealership_id: d.id, ...r })
    } catch (e) {
      console.error(`[sync-all:${triggerLabel}] ${d.id} threw:`, e.message)
      results.push({ dealership_id: d.id, success: false, error: e.message })
    }

    // Breathing room between dealerships — gives V8's GC time to reclaim memory
    // from the previous dealership's sitemap walker before the next one starts.
    // Also logs current heap usage so we can see what's actually accumulating.
    const mem = process.memoryUsage()
    const mb = (n) => (n / 1024 / 1024).toFixed(0)
    console.log(`[sync-all:${triggerLabel}] heap=${mb(mem.heapUsed)}/${mb(mem.heapTotal)}MB rss=${mb(mem.rss)}MB`)
    if (global.gc) global.gc()
    await new Promise(r => setTimeout(r, 2000))
  }

  console.log(`[sync-all:${triggerLabel}] finished. ${results.length} dealership(s) processed.`)
  return {
    success: true,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    results
  }
}

// ── Helper functions used by sync engine and extension-capture ──

export function normalizeFeedUrl(input) {
  if (!input) return null
  let url
  try { url = new URL(input.trim()) } catch { return null }

  const path = url.pathname.toLowerCase()
  let detectedType = null
  if (path.includes('new-inventory') || path.includes('/new/') || path.includes('/new?')) detectedType = 'new'
  else if (path.includes('used-inventory') || path.includes('/used/') || path.includes('/used?')) detectedType = 'used'
  else if (path.includes('demo-inventory') || path.includes('/demo/')) detectedType = 'demo'
  else if (path.includes('/fleet')) detectedType = 'fleet'

  if (path.endsWith('.json')) return { jsonUrl: url.toString(), detectedType }

  const origin = url.origin
  const host = url.hostname.toLowerCase()

  if (host.includes('edealer')) return { jsonUrl: `${origin}/api/inventory/getall`, detectedType }
  if (host.includes('dealerinspire') || host.includes('di-uploads')) return { jsonUrl: `${origin}/wp-json/di-wp/v2/inventory`, detectedType }
  if (host.includes('dealer.com')) return { jsonUrl: `${origin}/apis/widget/INVENTORY_LISTING_DEFAULT_AUTO_ALL:inventory-data-bus1/getInventory`, detectedType }
  if (host.includes('sincro') || host.includes('dealeron')) return { jsonUrl: `${origin}/api/inventory/vehicles`, detectedType }
  if (host.includes('vicimus') || host.includes('glovebox')) return { jsonUrl: `${origin}/api/inventory`, detectedType }
  if (host.includes('sm360')) return { jsonUrl: `${origin}/api/inventory/list`, detectedType }
  if (host.includes('cdk') || host.includes('cobalt')) return { jsonUrl: `${origin}/inventory/api/vehicles`, detectedType }
  if (host.includes('dealerfire') || host.includes('solera')) return { jsonUrl: `${origin}/ws/getData.php?type=inventory`, detectedType }

  return { jsonUrl: `${origin}/wp-content/uploads/data/inventory.json`, detectedType }
}

export function matchesFeedType(v, feedType) {
  if (!feedType || feedType === 'all' || feedType === 'fleet') return true
  if (feedType === 'new') return v.condition === 'New' && !v.demo
  if (feedType === 'used') return v.condition === 'Used'
  if (feedType === 'demo') return v.demo === true
  return true
}

// ── Helper: build condition-based source URL for LeadBox sites ──
// Generic source URL resolver — works for ANY feed (LeadBox, EDealer, custom JSON, etc.)
// Strategy: try the most specific URL we have, fall back to progressively broader pages.
// Guarantees a non-404 link to the dealer's site for every vehicle.
export function buildSourceUrl(feed, vehicle) {
  // 1. EDealer sitemap walker (and any future walker) provides the actual detail URL
  if (vehicle._detail_url
      && typeof vehicle._detail_url === 'string'
      && vehicle._detail_url.startsWith('http')
      && !vehicle._detail_url.endsWith('/inventory/')) {
    return vehicle._detail_url
  }

  // 2. Some feeds include the vehicle's own detail URL inline. Check a wide set of
  //    field names — LeadBox/others vary (vdpUrl, vehicle_url, link, href, etc.).
  const explicit = vehicle.url || vehicle.permalink || vehicle.detailUrl || vehicle.detail_url
                || vehicle.vdpurl || vehicle.vdpUrl || vehicle.vdp_url || vehicle.thirdpartyvdpurl
                || vehicle.vehicleUrl || vehicle.vehicle_url || vehicle.vehicleURL
                || vehicle.link || vehicle.href || vehicle.detailURL || vehicle.detailsUrl
  if (typeof explicit === 'string' && explicit.startsWith('http')) return explicit

  // 2b. LeadBox: build the deterministic, verified VDP URL up front. LeadBox ships
  //     no inline per-vehicle URL, and the harvested url_map / category fallback were
  //     producing 404s — so prefer this exact pattern over those when we can build a
  //     complete slug. (Falls through to url_map/category only if a field is missing.)
  if (isLeadBoxFeed(feed)) {
    const lb = buildLeadBoxVdpUrl(feed.feed_url, vehicle)
    if (lb) return lb
  }

  // 3. UNIVERSAL: inferred url_template — applies to ANY dealer site. Set once
  //    per feed by inferUrlTemplate() during the first sync after feed-add.
  if (feed.url_template) {
    const rendered = renderUrlTemplate(feed.url_template, vehicle)
    if (rendered && rendered.startsWith('http')) return rendered
  }

  // 4. Per-feed harvested URL map (fallback for platforms that haven't inferred a template)
  if (feed.url_map && vehicle.stocknumber) {
    const fromMap = feed.url_map[String(vehicle.stocknumber)]
    if (typeof fromMap === 'string' && fromMap.startsWith('http')) return fromMap
  }

  // 5. LeadBox-specific category fallback (last-resort, guaranteed not to 404)
  if (feed.feed_url && feed.feed_url.includes('/wp-content')) {
    return buildLeadBoxSourceUrl(feed.feed_url, vehicle)
  }

  // 6. If the saved feed_url is a viewable HTML page (not raw JSON), use it as-is
  if (feed.feed_url && !feed.feed_url.toLowerCase().endsWith('.json')) {
    return feed.feed_url
  }

  // 7. Last resort: dealer's homepage (origin only) — never 404s
  try { return new URL(feed.feed_url).origin } catch { return feed.feed_url || null }
}

// LeadBox dealers don't expose a consistent per-vehicle URL pattern across all sites
// (we tested /inventory/{stock}/, /vehicle/{stock}/, /vehicles/{stock}/, /?p={stock} —
// every one of them 404s on most dealer instances). Until we can probe each dealer's real
// detail URL at feed-add time, fall back to the category listing page — it always works
// and the visitor can find the specific car from there. EDealer + any feed that ships an
// explicit per-vehicle URL is handled via `_detail_url` instead and never hits this fn.
function buildLeadBoxSourceUrl(feedUrl, vehicle) {
  const origin = feedUrl.split('/wp-content')[0]

  // Prefer the deterministic per-vehicle VDP, then any explicit inline URL.
  const vdp = buildLeadBoxVdpUrl(feedUrl, vehicle)
  if (vdp) return vdp
  const explicit = vehicle.url || vehicle.permalink || vehicle.detailUrl || vehicle.detail_url
                || vehicle.vdpurl || vehicle.thirdpartyvdpurl
  if (typeof explicit === 'string' && explicit.startsWith('http')) return explicit

  // Category listing — last resort when we can't build a per-vehicle slug
  if (vehicle.condition === 'New') return `${origin}/new-vehicles/`
  if (vehicle.condition === 'Used') return `${origin}/used-vehicles/`
  if (vehicle.demo) return `${origin}/demo-inventory/`
  return `${origin}/vehicles/`
}

function isLeadBoxFeed(feed) {
  return feed?.platform === 'leadbox'
    || (typeof feed?.feed_url === 'string' && feed.feed_url.includes('/wp-content/uploads/data/inventory.json'))
}

// Build LeadBox's verified VDP URL: {origin}/view/{condition}-{year}-{make}-{model}-{id}/
// (lowercased, non-alphanumeric runs → single hyphen). The trailing id is LeadBox's
// internal vehicle `id` field — NOT the stock number. Returns null if any slug part
// is missing so callers can fall back. Verified against live wellandchev.com listings.
function buildLeadBoxVdpUrl(feedUrl, vehicle) {
  const origin = typeof feedUrl === 'string' && feedUrl.includes('/wp-content')
    ? feedUrl.split('/wp-content')[0]
    : (() => { try { return new URL(feedUrl).origin } catch { return null } })()
  if (!origin) return null
  const id = vehicle.id || vehicle.vehicle_id || vehicle.leadbox_id
  const condition = vehicle.condition || (vehicle.demo ? 'Demo' : null)
  if (!id || !vehicle.year || !vehicle.make || !vehicle.model || !condition) return null
  const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  const path = `${slug(condition)}-${vehicle.year}-${slug(vehicle.make)}-${slug(vehicle.model)}-${id}`
  return `${origin}/view/${path}/`
}
