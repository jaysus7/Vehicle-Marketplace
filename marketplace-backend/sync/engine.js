import { supabaseAdmin, sleep, browserFetch } from '../shared.js'
import { renderAndCaptureInventory, genericMapVehicle, inferUrlTemplate, renderUrlTemplate, fetchViaBrowser } from '../puppeteerRenderer.js'
import { PLATFORM_PROBES, fetchConvertusInventory, fetchDealerPageInventory,
         fetchEDealerInventoryFromSitemap, extractEDealerDetailUrls, fetchEDealerDetailImageGroups,
         extractEDealerImageGroups, extractCarsFromJsonLd } from './platforms.js'
import { mapFuel, buildDescription, fetchVehiclePhotos } from '../utils/description.js'
import { parseGenericFeed } from './genericFeed.js'
import { antibotEnabled, fetchViaAntibot, inventoryFromAntibotBody } from './antibot.js'
import { autoDecodeInventory, autoCheckRecalls } from './vinDecode.js'
import { runPhotoVision } from './photoVision.js'
import { brandDealershipPhotos } from '../utils/photoOverlay.js'
import { autoFetchOemStickers } from './oemStickers.js'
import { getMarketData } from '../usage.js'
import { marketcheckEnabled } from '../marketcheck.js'

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
      .select('id, feed_url, feed_type, platform, source_dealer_url, url_map, url_template, last_extension_sync_at')
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
      // Effective platform for the fetch dispatch below. Normally === feed.platform,
      // but a STALE extension-capture feed can be routed through the SPA-render path
      // as a best-effort headless fallback (see below).
      let effectivePlatform = feed.platform

      if (feed.platform === 'needs_extension_capture') {
        // Cloudflare-protected site — normally pulled through the rep's browser via the
        // Chrome extension. These were flagged BECAUSE server-side headless already
        // failed at connect time, so a nightly retry is opportunistic at best: only
        // attempt it when the feed has gone stale AND it's explicitly enabled
        // (EXT_HEADLESS_FALLBACK=1). The render is memory-guarded, so it self-skips
        // when the box is tight. If it captures nothing, we leave it to the extension
        // (0 vehicles → auto-archive is skipped, so inventory is never wiped).
        const lastRefreshMs = feed.last_extension_sync_at ? new Date(feed.last_extension_sync_at).getTime() : 0
        const hoursStale = (Date.now() - lastRefreshMs) / 3600000
        const staleThreshold = Number(process.env.EXT_STALE_HOURS || 36)
        const fallbackOn = process.env.EXT_HEADLESS_FALLBACK === '1'
        const renderTarget = feed.source_dealer_url || feed.feed_url
        if (fallbackOn && renderTarget && (lastRefreshMs === 0 || hoursStale > staleThreshold)) {
          console.log(`[sync] feed ${feed.id} extension-capture stale ${Math.round(hoursStale)}h — trying opportunistic headless fallback`)
          effectivePlatform = 'spa_render'   // route through the SPA-render branch below
        } else {
          console.log(`[sync] feed ${feed.id} requires Chrome extension — skipping server-side fetch (${Math.round(hoursStale)}h since last capture)`)
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
      } else if (effectivePlatform === 'spa_render') {
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

        // Last resort: commercial anti-bot fetch (residential IP) for hard-Cloudflare
        // sites that beat our own headless. Only runs when ANTIBOT_API_KEY is set, so
        // it's free until enabled. We only trust a clean JSON payload (endpoint that's
        // JSON but our datacenter IP was blocked); we don't scrape rendered HTML here.
        if (vehicles.length === 0 && antibotEnabled()) {
          const target = feed.feed_url || feed.source_dealer_url
          console.log(`[sync] feed ${feed.id} — trying anti-bot residential fetch on ${target}`)
          const ab = await fetchViaAntibot(target, { render: true })
          const arr = ab.ok ? inventoryFromAntibotBody(ab.body, ab.contentType) : null
          if (arr && arr.length) {
            vehicles = arr.map(genericMapVehicle)
            console.log(`[sync] anti-bot fallback captured ${vehicles.length} vehicles`)
          } else {
            console.log(`[sync] anti-bot fallback got nothing (status ${ab.status})`)
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
      } else if (feed.platform === 'direct_feed') {
        // Direct dealer data feed (the JSON/XML/CSV export the dealer's platform
        // syndicates to AutoTrader/CarGurus/Google/Meta). Fetch and parse generically —
        // works server-side on any device, no Cloudflare, no extension.
        try {
          const r = await browserFetch(`${feed.feed_url}${feed.feed_url.includes('?') ? '&' : '?'}v=${Date.now()}`, {
            headers: { Accept: 'application/json, application/xml, text/xml, text/csv, text/plain, */*' }
          })
          if (r.ok) {
            const ct = r.headers.get('content-type') || ''
            const body = await r.text()
            const { vehicles: parsed, format } = parseGenericFeed(body, ct)
            vehicles = parsed
            console.log(`[sync] direct_feed (${format || 'unknown'}): ${vehicles.length} vehicles from ${feed.feed_url}`)
          } else {
            console.log(`[sync] direct_feed HTTP ${r.status} at ${feed.feed_url}`)
            vehicles = []
          }
        } catch (e) {
          console.log(`[sync] direct_feed fetch failed: ${e.message}`)
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
        // eDealer (restored May flow): try the JSON API first; if it returns JSON, use
        // it (full inventory in one call). If Cloudflare-challenged / non-JSON, fall
        // back to the sitemap walker (fetches each detail page's JSON-LD), then to
        // headless Chrome (renders the listing page and captures the inventory), and
        // finally ScraperAPI (residential IP) if a key is configured.
        let origin
        try { origin = new URL(feed.feed_url).origin } catch { origin = '' }
        const probe = PLATFORM_PROBES.find(p => p.platform === 'edealer')
        const apiUrl = `${origin}/api/inventory/getall`
        vehicles = []

        // 1. JSON API
        try {
          const r = await browserFetch(apiUrl, { headers: { Accept: 'application/json' } })
          const ct = r.headers.get('content-type') || ''
          if (r.ok && ct.includes('json')) {
            const d = await r.json().catch(() => null)
            vehicles = d && probe?.validate(d) ? probe.extract(d) : (Array.isArray(d) ? d : [])
            console.log(`[sync] eDealer API: ${vehicles.length} vehicles`)
          } else {
            console.log(`[sync] eDealer API HTTP ${r.status} (${ct || 'no ct'}) — falling back to sitemap walker`)
          }
        } catch (e) { console.log(`[sync] eDealer API failed: ${e.message}`) }

        // 2. Sitemap walker — fetches the inventory sitemap, then each detail page's JSON-LD.
        // The getall API caps at ~24/page and returns NO totalCount, so a small result is
        // almost always TRUNCATED, not the real inventory. Whenever the API came back
        // page-capped (≤ 25), run the walker too and keep whichever is larger. This is the
        // fix for "sync only pulls 24" — previously any non-empty API result short-circuited
        // the walker.
        if ((vehicles.length === 0 || vehicles.length <= 25) && origin) {
          try {
            const sm = await fetchEDealerInventoryFromSitemap(origin)
            if (sm && sm.length > vehicles.length) {
              console.log(`[sync] eDealer sitemap walker: ${sm.length} vehicles (replacing ${vehicles.length} from capped API)`)
              vehicles = sm
            }
          } catch (e) { console.log(`[sync] eDealer sitemap walker failed: ${e.message}`) }
        }

        // 3. Headless Chrome — renders the listing page (passes a JS challenge) and
        //    captures the inventory XHR. The May fallback for JS-rendered / gated sites.
        if (!vehicles.length && (feed.source_dealer_url || origin)) {
          const src = feed.source_dealer_url || `${origin}/inventory/new/`
          try {
            const rendered = await renderAndCaptureInventory(src)
            if (rendered.success && rendered.vehicles?.length) {
              vehicles = rendered.vehicles.map(genericMapVehicle)
              console.log(`[sync] eDealer headless render: ${vehicles.length} vehicles from ${src}`)
            } else {
              console.log(`[sync] eDealer headless render: ${rendered.error || 'no inventory captured'}`)
            }
          } catch (e) { console.log(`[sync] eDealer headless render failed: ${e.message}`) }
        }

        if (!vehicles.length) console.log(`[sync] eDealer: 0 vehicles for ${origin} (Cloudflare challenge — use the extension for this dealer)`)
        jsonCache.set(feed.feed_url, vehicles)
        totalVehiclesFound += vehicles.length
      } else {
        const feedRes = await browserFetch(`${feed.feed_url}?v=${Date.now()}`, {
          headers: { 'Accept': 'application/json, text/plain, */*', 'Sec-Fetch-Dest': 'empty', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Site': 'same-origin' }
        })
        let ct = feedRes.headers.get('content-type') || ''

        // Read the body once. On a Cloudflare/WAF block (403/503), retry through real
        // Chrome so the JS challenge clears and we get the actual feed body (May flow).
        let bodyText
        if (feedRes.status === 403 || feedRes.status === 503) {
          console.log(`[sync] feed ${feed.feed_url} blocked (HTTP ${feedRes.status}) — retrying via headless Chrome`)
          const br = await fetchViaBrowser(`${feed.feed_url}?v=${Date.now()}`)
          bodyText = br.ok ? br.body : ''
          if (br.contentType) ct = br.contentType
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

          // Try the sitemap walker first — gets full paginated inventory (May flow).
          const sitemapVehicles = await fetchEDealerInventoryFromSitemap(origin)
          if (sitemapVehicles && sitemapVehicles.length > cars.length) {
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
  archived_at: null,   // present in the feed → not archived (un-archives a relisted unit)
  last_synced_at: new Date().toISOString(),
  // True lot/in-stock date when the feed provides one — aging uses COALESCE(lot_date,
  // created_at). Only set when present so we never overwrite a good value with null.
  ...(v.lot_date ? { lot_date: v.lot_date } : {}),
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
        .select('id, vin, status, source')
        .eq('dealership_id', dealershipId)
        .eq('status', 'available')   // only live units can drop off the feed
      if (fetchErr) {
        console.error('[sync] could not fetch current inventory for diff:', fetchErr.message)
      } else {
        // Vehicle no longer in feed → it's gone from the dealer site (almost always a
        // sale). ARCHIVE it rather than hard-delete: it leaves the live lot but the
        // record is retained (status='archived' + archived_at) so sell-through, turn
        // rate and "what sold" analytics have real history to learn from.
        const toArchive = []
        for (const row of currentRows || []) {
          if (row.source === 'manual') continue   // dealer-entered — never touched by feed sync
          if (!row.vin) continue
          if (!feedVinSet.has(row.vin)) toArchive.push(row.id)
        }

        // Safety brake: if the diff says >50% of current inventory dropped off,
        // something's off (feed change, partial fetch) — skip rather than mass-archive.
        const totalCount = (currentRows || []).length
        if (totalCount > 0 && toArchive.length / totalCount > 0.5) {
          console.warn(`[sync] would archive ${toArchive.length}/${totalCount} inventory rows — refusing (likely sync glitch)`)
        } else if (toArchive.length) {
          const archivedAt = new Date().toISOString()
          for (let i = 0; i < toArchive.length; i += 100) {
            const slice = toArchive.slice(i, i + 100)
            // Dropped from the feed → if any were posted to Facebook, queue their
            // listings for DELETION from Marketplace (the extension performs it).
            // Wrapped so a pre-migration DB (no fb_sync_action column) never breaks sync.
            try {
              await supabaseAdmin
                .from('listings')
                .update({ status: 'deleted', deleted_at: archivedAt, fb_sync_action: 'delete', fb_synced_at: null })
                .in('inventory_id', slice)
                .eq('status', 'posted')
                .not('fb_listing_url', 'is', null)
            } catch (e) { console.warn('[sync] delete→FB queue failed (non-fatal):', e.message) }
            // Archive (retain history) instead of deleting the inventory row.
            await supabaseAdmin.from('inventory')
              .update({ status: 'archived', archived_at: archivedAt })
              .in('id', slice)
          }
          console.log(`[sync] auto-archive: ${toArchive.length} inventory rows archived (dropped from feed)`)
        }
      }
    }
  }

  // Stamp sold_at the first time a unit shows sold in the feed, so sales-by-attribute
  // reports and real days-to-sell have a date to work from. Idempotent (only null ones).
  try {
    await supabaseAdmin.from('inventory')
      .update({ sold_at: new Date().toISOString() })
      .eq('dealership_id', dealershipId).eq('status', 'sold').is('sold_at', null)
  } catch (e) { console.warn('[sync] sold_at stamp failed (non-fatal):', e.message) }

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

  // Auto-decode any newly-synced VINs via NHTSA (free, incremental). Fire-and-
  // forget so the sync response returns immediately — enrichment lands shortly after.
  autoDecodeInventory(dealershipId).catch(e => console.warn('[sync] vin auto-decode failed:', e.message))

  // Auto-check open recalls (NHTSA, per-VIN) so each vehicle's card shows ✓/⚠
  // without anyone opening the VIN decoder. Incremental + fire-and-forget.
  autoCheckRecalls(dealershipId).catch(e => console.warn('[sync] recall auto-check failed:', e.message))

  // AI Vision: score newly-synced photos when the add-on is active (incremental).
  try {
    const { data: d } = await supabaseAdmin.from('dealerships').select('ai_boost_active').eq('id', dealershipId).single()
    if (d?.ai_boost_active) runPhotoVision(dealershipId).catch(e => console.warn('[sync] ai-vision failed:', e.message))
  } catch {}

  // Photo overlays: pre-brand new photos when the dealer has overlays on.
  brandDealershipPhotos(dealershipId).catch(e => console.warn('[sync] photo-overlay failed:', e.message))

  // Pull authentic OEM window stickers for new vehicles (VIN Sticker add-on).
  autoFetchOemStickers(dealershipId).catch(e => console.warn('[sync] oem-stickers failed:', e.message))

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

// Nightly market-comp refresh. For each of a dealer's used units it refreshes the
// live market median (warming the shared 7-day MarketCheck cache) and writes an
// ai_activity price flag — the same record the Inventory cards' "% to market" badge
// and the Lot Report read from. So the cards update every night automatically, and
// live MarketCheck only ever happens here (nightly) or on an explicit button click.
// Bounded by the 7-day cache + the dealer's MarketCheck caps, so most nights it
// costs little or nothing. Best-effort: never throws. Set NIGHTLY_MARKET_REFRESH=0
// to disable.
async function refreshDealerMarketComps(dealershipId) {
  try {
    if (!marketcheckEnabled()) return 0
    const { data: dealer } = await supabaseAdmin
      .from('dealerships').select('inv_intel_active, country').eq('id', dealershipId).maybeSingle()
    if (!dealer?.inv_intel_active) return 0   // Inventory Intelligence feature only

    const c = (dealer.country || '').trim().toUpperCase()
    const isUS = c === 'US' || c === 'USA' || c === 'UNITED STATES'
    const yearNow = new Date().getFullYear()

    const { data: vehicles } = await supabaseAdmin
      .from('inventory').select('id, year, make, model, trim, mileage, price, condition')
      .eq('dealership_id', dealershipId).eq('status', 'available')

    let refreshed = 0
    for (const v of vehicles || []) {
      // Skip new / demo / current-year / no-price units — no used-market comp set.
      const cond = (v.condition || '').toLowerCase()
      if (!v.price || !v.make || !v.model || !v.year) continue
      if (cond === 'new' || cond === 'demo' || Number(v.year) >= yearNow) continue
      const { data: mc, cached } = await getMarketData({
        dealershipId, isOwner: false, allowLive: true,
        params: { make: v.make, model: v.model, year: Number(v.year), trim: v.trim || '', mileage: v.mileage ? Number(v.mileage) : null, isUS },
      })
      if (mc?.median_price) {
        // Same price-flag math as the Inventory Scan (buildPriceFlag), inlined so the
        // sync engine doesn't depend on the routes layer. Guards against an absurd
        // number from a mismatched comp set (>45% off, or <3 comps).
        const price = Number(v.price), med = Number(mc.median_price), count = mc.count
        const pct = ((price - med) / med) * 100
        const reliable = (count == null || count >= 3) && Math.abs(pct) <= 45
        supabaseAdmin.from('ai_activity').insert({
          dealership_id: dealershipId,
          inventory_id: v.id,
          actor_id: null,                       // system-generated (nightly)
          vehicle_label: [v.year, v.make, v.model, v.trim].filter(Boolean).join(' '),
          warnings: null,
          price_flagged: reliable && Math.abs(pct) > 15,
          price_pct_diff: Math.round(pct * 10) / 10,
          price_median: med,
          copy_generated: false,
        }).then(() => {}).catch(() => {})
        refreshed++
      }
      if (!cached) await sleep(150)   // pace only the live (paid) calls
    }
    return refreshed
  } catch (e) {
    console.warn(`[market-refresh] ${dealershipId} failed:`, e.message)
    return 0
  }
}

// ── Staleness sweep ────────────────────────────────────────────────────────────
// Cloudflare feeds (needs_extension_capture) only refresh when a rep's Chrome is
// open, so they can silently fall behind. After the nightly sync, flag any that
// haven't refreshed past EXT_STALE_HOURS: drop an in-app notification AND email the
// owner — deduped so we alert at most once per 72h per dealer (no nightly spam).
export async function sweepStaleExtensionFeeds({ resend, emailFrom, frontendUrl } = {}) {
  const staleHours = Number(process.env.EXT_STALE_HOURS || 36)
  const now = Date.now()
  const { data: feeds, error } = await supabaseAdmin
    .from('inventory_feeds')
    .select('id, dealership_id, last_extension_sync_at, source_dealer_url, dealerships(name)')
    .eq('platform', 'needs_extension_capture')
  if (error || !feeds?.length) return { alerted: 0 }

  let alerted = 0
  const dedupCutoff = new Date(now - 72 * 3600000).toISOString()
  for (const f of feeds) {
    const last = f.last_extension_sync_at ? new Date(f.last_extension_sync_at).getTime() : 0
    const hours = (now - last) / 3600000
    if (last && hours <= staleHours) continue                 // still fresh enough

    // Dedup: skip if we already raised a sync_stale alert for this dealer in 72h.
    const { data: recent } = await supabaseAdmin.from('notifications')
      .select('id').eq('dealership_id', f.dealership_id).eq('type', 'sync_stale')
      .gte('created_at', dedupCutoff).limit(1)
    if (recent?.length) continue

    const days = Math.floor(hours / 24)
    const human = !last ? 'a while' : (days >= 1 ? `${days} day${days > 1 ? 's' : ''}` : `${Math.round(hours)} hours`)
    const dealerName = f.dealerships?.name || 'Your dealership'

    // 1) In-app notification (dealership-wide).
    try {
      await supabaseAdmin.from('notifications').insert({
        dealership_id: f.dealership_id, type: 'sync_stale',
        title: 'Inventory sync is behind',
        body: `${dealerName}'s inventory hasn't refreshed in ${human}. Open MarketSync in Chrome to sync.`,
        link_page: 'inventory',
      })
    } catch (e) { console.warn('[stale-sweep] notification insert failed:', e.message) }

    // 2) Email the owner/admin.
    if (resend && emailFrom) {
      try {
        const { data: owner } = await supabaseAdmin.from('profiles')
          .select('id').eq('dealership_id', f.dealership_id)
          .in('role', ['OWNER', 'DEALER_ADMIN']).limit(1).maybeSingle()
        if (owner?.id) {
          const { data: au } = await supabaseAdmin.auth.admin.getUserById(owner.id).catch(() => ({ data: null }))
          const to = au?.user?.email
          if (to) {
            const link = frontendUrl || 'https://marketsync.link'
            await resend.emails.send({
              from: emailFrom, to,
              subject: `⚠️ ${dealerName} inventory hasn't synced in ${human}`,
              html: `<div style="font-family:-apple-system,Segoe UI,Arial,sans-serif;max-width:520px;margin:0 auto;color:#0f172a">
                <h2 style="font-size:18px">Inventory sync is behind</h2>
                <p style="font-size:14px;line-height:1.6;color:#334155">${dealerName}'s inventory hasn't refreshed in <strong>${human}</strong>. This dealer's site is Cloudflare-protected, so it syncs through the MarketSync Chrome extension — which only runs while your browser is open.</p>
                <p style="font-size:14px;line-height:1.6;color:#334155"><strong>To fix:</strong> open Chrome with the MarketSync extension and the inventory will pull automatically within a few minutes.</p>
                <p style="margin-top:20px"><a href="${link}" style="background:#4f46e5;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:700;font-size:14px">Open MarketSync</a></p>
                <p style="font-size:11px;color:#94a3b8;margin-top:24px">You're getting this because inventory freshness affects your listings and reports. We send this at most once every 3 days.</p>
              </div>`,
            })
          }
        }
      } catch (e) { console.warn('[stale-sweep] owner email failed:', e.message) }
    }
    alerted++
  }
  if (alerted) console.log(`[stale-sweep] alerted ${alerted} stale extension feed(s)`)
  return { alerted }
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

  // Retention cap: permanently delete sold/archived history older than 1 year.
  try {
    const purgeCutoff = new Date(Date.now() - 365 * 86400000).toISOString()
    const { data: purgedA } = await supabaseAdmin.from('inventory').delete()
      .eq('status', 'archived').lt('archived_at', purgeCutoff).select('id')
    const { data: purgedS } = await supabaseAdmin.from('inventory').delete()
      .eq('status', 'sold').is('archived_at', null).lt('last_synced_at', purgeCutoff).select('id')
    const purged = (purgedA?.length || 0) + (purgedS?.length || 0)
    if (purged) console.log(`[sync-all:${triggerLabel}] purged ${purged} archived/sold rows older than 1 year`)
  } catch (e) { console.warn('[sync-all] 1-year purge failed (non-fatal):', e.message) }

  const results = []
  for (const d of dealerships || []) {
    try {
      const r = await runInventorySync(d.id)
      console.log(
        `[sync-all:${triggerLabel}] ${d.name} (${d.id}):`,
        r.success ? `${r.unique_vehicles} unique, ${r.skipped} skipped` : r.error
      )
      // Warm the MarketCheck cache for the freshly-synced lot so daytime reads are
      // free and live calls stay confined to this nightly pass + button actions.
      if (process.env.NIGHTLY_MARKET_REFRESH !== '0') {
        const refreshed = await refreshDealerMarketComps(d.id)
        if (refreshed) console.log(`[sync-all:${triggerLabel}] ${d.name}: refreshed ${refreshed} market comps / card badges`)
      }
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
