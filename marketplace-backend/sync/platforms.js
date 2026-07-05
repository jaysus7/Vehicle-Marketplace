import { browserFetch, sleep } from '../shared.js'
import { renderAndCaptureInventory, genericMapVehicle, harvestVehicleUrls,
         inferUrlTemplate, renderUrlTemplate, fetchUrlsViaBrowser, fetchViaBrowser } from '../puppeteerRenderer.js'
import { parseGenericFeed } from './genericFeed.js'

// Fetch a dealer's page and hunt for an inventory data-feed URL embedded in the HTML/JS
// (inventory.json, a wp-content data feed, etc.), then validate each candidate actually
// parses into vehicles. Returns { feed_url, format, count } or null. Fully generic —
// no per-dealer hardcoding. Also tries the standard LeadBox path as a candidate.
export async function findInventoryFeedInPage(dealerUrl, origin) {
  try { origin = origin || new URL(dealerUrl).origin } catch { return null }

  // Load the page HTML with a plain fetch (fast). We deliberately do NOT spin up
  // headless Chrome here — on the free tier it's slow/unstable and was timing out the
  // synchronous Add request ("Load failed"). If plain fetch can't read the page, we
  // just fall through to the standard candidate below and return fast.
  let html = ''
  try {
    const r = await browserFetch(dealerUrl)
    if (r.ok) html = await r.text()
  } catch {}

  const candidates = new Set([`${origin}/wp-content/uploads/data/inventory.json`])
  const add = (u) => { try { candidates.add(new URL(u, origin).href) } catch {} }
  if (html) {
    // Absolute feed URLs referencing inventory/vehicles/feed, ending in .json/.xml
    for (const m of html.matchAll(/https?:\/\/[^"'\s)>]+?(?:inventory|vehicles?|feed|export)[^"'\s)>]*?\.(?:json|xml)/gi)) add(m[0])
    // Relative wp-content data files
    for (const m of html.matchAll(/["'](\/wp-content\/[^"'\s)>]+?\.(?:json|xml))["']/gi)) add(m[1])
    // Any relative inventory/vehicles feed file
    for (const m of html.matchAll(/["'](\/[^"'\s)>]*(?:inventory|vehicles?)[^"'\s)>]*\.(?:json|xml))["']/gi)) add(m[1])
  }

  for (const url of candidates) {
    // The feed is a static file that plain fetch can read even when the page is
    // dynamic. Plain fetch only — keeps this fast and keeps sync (also plain fetch)
    // consistent with what we detect.
    try {
      const r = await browserFetch(url, { headers: { Accept: 'application/json, application/xml, text/xml, */*' } })
      if (!r.ok) continue
      const body = await r.text()
      const { vehicles, format } = parseGenericFeed(body, r.headers.get('content-type') || '')
      if (vehicles.length > 0) return { feed_url: url, format: format || 'json', count: vehicles.length }
    } catch {}
  }
  return null
}

export const PLATFORM_PROBES = [
  {
    platform: 'leadbox',
    label: 'LeadBox',
    buildUrls: (origin) => [`${origin}/wp-content/uploads/data/inventory.json`],
    validate: (data) => Array.isArray(data?.vehicles) && data.vehicles.length > 0,
    extract: (data) => data.vehicles,
    mapVehicle: (v) => ({
      vin: v.vin, year: v.year, make: v.make, model: v.model, trim: v.trim,
      price: v.saleprice || v.price, mileage: v.mileage, condition: v.condition,
      stocknumber: v.stocknumber, exteriorcolor: v.exteriorcolor
    })
  },
  {
    platform: 'edealer',
    label: 'EDealer',
    buildUrls: (origin) => [
      `${origin}/api/inventory/getall`,
      `${origin}/api/vehicles`,
      `${origin}/Inventory/GetInventory`
    ],
    validate: (data) => {
      if (Array.isArray(data) && data[0]?.VIN) return true
      if (Array.isArray(data?.vehicles) && data.vehicles[0]?.VIN) return true
      if (Array.isArray(data?.Vehicles) && data.Vehicles[0]?.VIN) return true
      return false
    },
    extract: (data) => Array.isArray(data) ? data : (data?.vehicles || data?.Vehicles || []),
    mapVehicle: (v) => ({
      vin: v.VIN || v.vin, year: v.Year || v.year, make: v.Make || v.make,
      model: v.Model || v.model, trim: v.Trim || v.trim,
      price: v.Price || v.ListPrice || v.price, mileage: v.Mileage || v.mileage,
      // Preserve a condition already resolved upstream (e.g. from listing-page JSON-LD,
      // which carries New/Used/Demo). Only fall back to the API's IsNew flag when unset.
      condition: v.condition || (v.IsNew ? 'New' : 'Used'), stocknumber: v.StockNumber || v.stocknumber,
      exteriorcolor: v.ExteriorColour || v.ExteriorColor || v.exteriorcolor
    })
  },
  {
    platform: 'dealer_inspire',
    label: 'Dealer Inspire',
    buildUrls: (origin) => [
      `${origin}/wp-json/di-wp/v2/inventory`,
      `${origin}/wp-json/inventory/v1/vehicles`
    ],
    validate: (data) => Array.isArray(data) && data[0]?.vin,
    extract: (data) => data,
    mapVehicle: (v) => ({
      vin: v.vin, year: v.year, make: v.make, model: v.model, trim: v.trim,
      price: v.price || v.final_price, mileage: v.mileage || v.odometer,
      condition: v.type, stocknumber: v.stock_number || v.stock, exteriorcolor: v.exterior_color
    })
  },
  {
    platform: 'dealer_com',
    label: 'Dealer.com',
    buildUrls: (origin) => [
      `${origin}/apis/widget/INVENTORY_LISTING_DEFAULT_AUTO_ALL:inventory-data-bus1/getInventory?limit=10`,
      `${origin}/apis/widget/INVENTORY_LISTING_DEFAULT_AUTO_ALL:inventory-data-bus1/getInventory`
    ],
    validate: (data) => Array.isArray(data?.inventory) && data.inventory.length > 0,
    extract: (data) => data.inventory,
    mapVehicle: (v) => ({
      vin: v.vin, year: v.modelYear || v.year, make: v.make, model: v.model, trim: v.trim,
      price: v.pricing?.advertised || v.finalPrice || v.price, mileage: v.odometer || v.mileage,
      condition: v.type, stocknumber: v.stockNumber || v.stock, exteriorcolor: v.exteriorColor
    })
  },
  {
    platform: 'sincro',
    label: 'Sincro / DealerOn',
    buildUrls: (origin) => [
      `${origin}/api/inventory/vehicles`,
      `${origin}/api/vehicles`,
      `${origin}/inventory/api/vehicles`
    ],
    validate: (data) => {
      if (Array.isArray(data?.vehicles) && data.vehicles[0]?.vin) return true
      if (Array.isArray(data?.data) && data.data[0]?.vin) return true
      return false
    },
    extract: (data) => data?.vehicles || data?.data || [],
    mapVehicle: (v) => ({
      vin: v.vin, year: v.year || v.modelYear, make: v.make, model: v.model, trim: v.trim,
      price: v.price || v.sellingPrice, mileage: v.mileage || v.odometer,
      condition: v.newOrUsed || v.condition, stocknumber: v.stockNumber || v.stock,
      exteriorcolor: v.exteriorColor || v.color
    })
  },
  {
    platform: 'cdk',
    label: 'CDK Global',
    buildUrls: (origin) => [
      `${origin}/inventory/api/vehicles?pageSize=10`,
      `${origin}/api/cdk/inventory`
    ],
    validate: (data) => Array.isArray(data?.vehicles || data?.results) &&
      (data?.vehicles || data?.results)?.[0]?.vin,
    extract: (data) => data?.vehicles || data?.results || [],
    mapVehicle: (v) => ({
      vin: v.vin, year: v.modelYear || v.year, make: v.make, model: v.model, trim: v.trim,
      price: v.internetPrice || v.price, mileage: v.mileage, condition: v.type,
      stocknumber: v.stockNumber, exteriorcolor: v.exteriorColor
    })
  },
  {
    platform: 'ux_auto',
    label: 'UX Auto',
    buildUrls: (origin) => [
      `${origin}/inventory/list/NEW`,
      `${origin}/inventory/list/USED`,
      `${origin}/inventory/list/DEMO`,
      `${origin}/inventory/list/new`,
      `${origin}/inventory/list/used`,
    ],
    validate: (data) =>
      data?.result === 'Success' && Array.isArray(data?.records) && data.records.length > 0,
    extract: (data) => data.records,
    mapVehicle: (v) => ({
      vin: v.vin,
      year: v.year,
      make: v.make,
      model: v.model,
      trim: v.trim || null,
      price: v.sale_price || v.list_price || v.retail_price || 0,
      mileage: v.mileage || 0,
      condition: v.condition || null,
      stocknumber: v.stock_id || v.stocknumber,
      exteriorcolor: v.ext_color || null,
      interiorcolor: v.int_color || null,
      bodystyle: v.body_type || v.body_style || null,
      fueltype: v.fuel_type || null,
      transmission: v.transmission || null,
      drivetrain: v.drivetrain || v.drive_train || null,
      onweb: v.active !== 'n',
      salepending: false,
      image_urls: v.s3_key
        ? [`https://d3ls4jww1dnhu4.cloudfront.net/${v.s3_key}`]
        : (Array.isArray(v.images) ? v.images : [])
    })
  },
  {
    platform: 'strathcom',
    label: 'Strathcom',
    buildUrls: (origin) => [
      `${origin}/wp-content/uploads/data/inventory.json`,
      `${origin}/vehicle-inventory/feeds/all.json`
    ],
    validate: (data) => Array.isArray(data?.vehicles) && data.vehicles.length > 0,
    extract: (data) => data.vehicles,
    mapVehicle: (v) => ({
      vin: v.vin, year: v.year, make: v.make, model: v.model, trim: v.trim,
      price: v.price || v.saleprice, mileage: v.mileage, condition: v.condition,
      stocknumber: v.stocknumber, exteriorcolor: v.exteriorcolor
    })
  },
  {
    platform: 'vicimus',
    label: 'Vicimus / Glovebox',
    buildUrls: (origin) => [
      `${origin}/api/inventory`,
      `${origin}/glovebox/api/inventory/vehicles`
    ],
    validate: (data) => Array.isArray(data?.data || data) && (data?.data || data)?.[0]?.vin,
    extract: (data) => data?.data || data || [],
    mapVehicle: (v) => ({
      vin: v.vin, year: v.year, make: v.make, model: v.model, trim: v.trim,
      price: v.price, mileage: v.odometer || v.mileage, condition: v.condition,
      stocknumber: v.stockNumber || v.stock, exteriorcolor: v.exteriorColour || v.exteriorColor
    })
  },
  {
    platform: 'sm360',
    label: 'SM360',
    buildUrls: (origin) => [
      `${origin}/api/inventory/list`,
      `${origin}/fr/api/vehicles`,
      `${origin}/en/api/vehicles`
    ],
    validate: (data) => Array.isArray(data?.vehicles || data?.results || data),
    extract: (data) => data?.vehicles || data?.results || (Array.isArray(data) ? data : []),
    mapVehicle: (v) => ({
      vin: v.vin || v.Vin, year: v.year || v.Year, make: v.make || v.Make,
      model: v.model || v.Model, trim: v.trim || v.Trim, price: v.price || v.Price,
      mileage: v.mileage || v.Mileage, condition: v.condition || v.Condition,
      stocknumber: v.stockNumber || v.StockNumber, exteriorcolor: v.exteriorColor || v.ExteriorColor
    })
  },
  {
    platform: 'dealerfire',
    label: 'DealerFire',
    buildUrls: (origin) => [
      `${origin}/ws/getData.php?type=inventory`,
      `${origin}/inventory.json`
    ],
    validate: (data) => Array.isArray(data?.vehicles || data) && (data?.vehicles || data)?.[0]?.vin,
    extract: (data) => data?.vehicles || (Array.isArray(data) ? data : []),
    mapVehicle: (v) => ({
      vin: v.vin, year: v.year, make: v.make, model: v.model, trim: v.trim,
      price: v.price, mileage: v.mileage, condition: v.condition,
      stocknumber: v.stock, exteriorcolor: v.color
    })
  },
  {
    platform: 'schema_jsonld',
    label: 'Schema.org JSON-LD',
    htmlProbe: true,
    buildUrls: () => [],
    validate: (data) => {
      if (!data?.jsonLd) return false
      return extractCarsFromJsonLd(data.jsonLd).length > 0
    },
    extract: (data) => extractCarsFromJsonLd(data.jsonLd),
    mapVehicle: (v) => {
      // Idempotent: works on RAW Schema.org Car nodes AND on already-normalized
      // vehicles from parseEDealerDetailPage. We pick whichever field name is
      // populated rather than blindly overwriting with undefined.
      // Without this, the sitemap walker's vin/stocknumber got wiped when the
      // mapper ran over its output → "128 no VIN/stock #" skips.
      const pick = (...keys) => {
        for (const k of keys) {
          if (v[k] != null && v[k] !== '') return v[k]
        }
        return null
      }
      const cond = v.itemCondition || v.condition || ''
      const condition = cond.includes('NewCondition') ? 'New'
        : cond.includes('UsedCondition') ? 'Used'
        : cond.includes('Refurbished') ? 'Certified'
        : (cond === 'New' || cond === 'Used' || cond === 'Demo') ? cond
        : null
      const drive = (v.driveWheelConfiguration || '').match(/\/(\w+)WheelDriveConfiguration/)?.[1]
      let trim = v.trim || null
      if (!trim && typeof v.vehicleConfiguration === 'string') {
        const parts = v.vehicleConfiguration.split(' ')
        trim = parts.slice(0, -1).join(' ') || null
      }
      const image = Array.isArray(v.image) ? v.image[0] : v.image
      return {
        vin: pick('vin', 'vehicleIdentificationNumber'),
        year: pick('year', 'vehicleModelDate'),
        make: v.make || v.brand?.name || v.manufacturer?.name || v.brand || null,
        model: pick('model'),
        trim,
        price: pick('price') ?? v.offers?.price ?? null,
        mileage: pick('mileage') ?? v.mileageFromOdometer?.value ?? null,
        condition,
        stocknumber: pick('stocknumber', 'sku', 'productID'),
        exteriorcolor: pick('exteriorcolor', 'color'),
        interiorcolor: pick('interiorcolor', 'vehicleInteriorColor'),
        bodystyle: pick('bodystyle', 'bodyType'),
        fueltype: pick('fueltype') ?? v.vehicleEngine?.fuelType ?? null,
        transmission: pick('transmission', 'vehicleTransmission'),
        drivetrain: pick('drivetrain') || drive,
        image_urls: Array.isArray(v.image_urls) && v.image_urls.length
          ? v.image_urls
          : (image && image !== 'https://static.edealer.ca/V4/assets/images/new_vehicles_images_coming.png'
              ? [image] : [])
      }
    }
  }
]

export async function probeUrlHtml(url, timeoutMs = 12000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await browserFetch(url, { signal: controller.signal })
    clearTimeout(timer)
    if (res.status === 403 || res.status === 503) return { ok: false, status: res.status, blocked: true }
    if (!res.ok) return { ok: false, status: res.status }
    const html = await res.text()
    const blocks = []
    const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
    let m
    while ((m = re.exec(html)) !== null) {
      try { blocks.push(JSON.parse(m[1])) } catch {}
    }
    const flat = []
    const walk = (node) => {
      if (!node) return
      if (Array.isArray(node)) { node.forEach(walk); return }
      if (Array.isArray(node['@graph'])) { node['@graph'].forEach(walk); return }
      flat.push(node)
    }
    blocks.forEach(walk)
    return { ok: true, jsonLd: flat }
  } catch (e) {
    clearTimeout(timer)
    return { ok: false, reason: e.name === 'AbortError' ? 'timeout' : e.message }
  }
}

// Extract the VIN from an EDealer detail page. The old approach —
// `html.match(/[A-HJ-NPR-Z0-9]{17}/)` — grabbed the FIRST 17-char uppercase-alnum
// run anywhere in the HTML, with no label and no boundaries. On EDealer's shared
// template that first run is often a constant token (asset hash, analytics/build
// ID), so EVERY vehicle page returned the SAME "VIN" and the whole inventory
// collapsed to one row ("1 unique · N duplicate VINs merged"). We now prefer an
// explicitly-labeled VIN and only fall back to a properly-bounded standalone token.
export function extractEDealerVin(html) {
  const labeled =
       html.match(/"vehicleIdentificationNumber"\s*:\s*"([A-HJ-NPR-Z0-9]{17})"/i)
    || html.match(/data-vin\s*=\s*["']([A-HJ-NPR-Z0-9]{17})["']/i)
    || html.match(/"vin"\s*:\s*"([A-HJ-NPR-Z0-9]{17})"/i)
    || html.match(/\bVIN\b[\s:#>"'\/]*([A-HJ-NPR-Z0-9]{17})\b/i)
  if (labeled) return labeled[1].toUpperCase()

  // Fallback: a standalone 17-char VIN-shaped token bounded by non-alphanumerics
  // on BOTH sides — so we never slice 17 chars out of a longer hash/minified token
  // that repeats on every page.
  const m = html.match(/(?<![A-Za-z0-9])([A-HJ-NPR-Z0-9]{17})(?![A-Za-z0-9])/)
  return m ? m[1].toUpperCase() : null
}

export function parseEDealerDetailPage(html, url) {
  const titleMatch = html.match(/<title>([^<]+)<\/title>/i)
  const title = titleMatch ? titleMatch[1].trim() : ''
  const condMatch = title.match(/^(New|Used|Demo|Pre-Owned|Certified Pre-Owned)\b/i)
  const condition = condMatch ? condMatch[1] : null
  const ymmMatch = title.match(/^(?:New|Used|Demo|Pre-Owned|Certified Pre-Owned)?\s*(\d{4})\s+(\S+)\s+(.+?)\s+for Sale/i)
  const year = ymmMatch ? parseInt(ymmMatch[1]) : null
  const make = ymmMatch ? ymmMatch[2] : null
  const model = ymmMatch ? ymmMatch[3] : null
  const metaMatch = html.match(/<meta\s+name="description"[^>]*content="([^"]+)"/i)
  const metaDesc = metaMatch ? metaMatch[1] : ''
  const stockMatch = metaDesc.match(/,\s*([A-Z0-9-]{3,20})\s+available/i)
  const stocknumber = stockMatch ? stockMatch[1] : null
  const priceMatch = metaDesc.match(/\$([\d,]+)/)
  const price = priceMatch ? parseInt(priceMatch[1].replace(/,/g, '')) : 0
  const vin = extractEDealerVin(html)
  const mileageMatch = html.match(/(\d{1,3}(?:,\d{3})*)\s*km\b/i)
  const mileage = mileageMatch ? parseInt(mileageMatch[1].replace(/,/g, '')) : 0
  const imageRe = /https:\/\/media\.edealer\.ca\/w_1920[^"'\s]*?\.webp/g
  const seen = new Set()
  const image_urls = []
  let m
  while ((m = imageRe.exec(html)) !== null) {
    if (!seen.has(m[0])) { seen.add(m[0]); image_urls.push(m[0]) }
  }
  // Need year+make plus at least one identifier (VIN or stock#). Downstream dedup
  // falls back to stock# when VIN is absent, so a missing VIN no longer drops the car.
  if (!year || !make || (!vin && !stocknumber)) return null
  return { vin, year, make, model, price, mileage, stocknumber, condition, onweb: true, salepending: false, image_urls, _detail_url: url }
}

// ── Puppeteer-based full inventory fetcher for JS-rendered EDealer sites ──
// HTTP-only EDealer walker — uses the inventory sitemap (works on every EDealer site
// with Yoast SEO, which is all of them). No Chrome/Puppeteer dependency.
// For 200-300 vehicles this finishes in ~30-60 seconds with concurrency=6.
export async function fetchEDealerInventoryFromSitemap(origin, opts = {}) {
  const extraHeaders = opts.headers || {}
  try {
    // eDealer installs expose their vehicle sitemap under several possible names,
    // and some only list it inside the Yoast sitemap index. Discover it robustly:
    // fetch each candidate; if one is a <sitemapindex>, follow its inventory child.
    const grabLocs = (xml) => [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map(m => m[1])
    const isDetail = (u) => /\/(inventory|vehicles?|vehicule|vehicule|cars?|autos?)\//i.test(u) &&
      (/vdp\/?$/i.test(u) || /-\d{4}-/.test(u) || /\/(new|used|demo|pre-owned|certified)-/i.test(u) || /[a-z0-9]{6,}vdp/i.test(u))

    const candidatePaths = [
      '/inventory-listing-sitemap.xml', '/inventory-sitemap.xml', '/vehicle-sitemap.xml',
      '/vehicles-sitemap.xml', '/inventory_sitemap.xml', '/sitemap_index.xml', '/sitemap.xml'
    ]

    let urls = []
    for (const path of candidatePaths) {
      let xml
      try {
        const r = await browserFetch(`${origin}${path}`, { headers: extraHeaders })
        if (!r.ok) continue
        xml = await r.text()
      } catch { continue }
      if (!xml) continue

      // Sitemap INDEX → follow child sitemaps that look inventory-related.
      if (/<sitemapindex/i.test(xml)) {
        const children = grabLocs(xml).filter(u => /invent|vehic|vehicule|listing|vdp/i.test(u))
        for (const child of children) {
          try {
            const cr = await browserFetch(child, { headers: extraHeaders })
            if (!cr.ok) continue
            const cxml = await cr.text()
            urls.push(...grabLocs(cxml).filter(isDetail))
          } catch {}
        }
      } else {
        urls.push(...grabLocs(xml).filter(isDetail))
      }
      if (urls.length) {
        console.log(`[sync] EDealer sitemap: found ${urls.length} detail URLs via ${path}`)
        break
      }
    }

    // Dedup
    urls = [...new Set(urls)]
    if (!urls.length) {
      console.warn(`[sync] EDealer sitemap: no detail URLs found at ${origin} (tried ${candidatePaths.length} paths)`)
      return null
    }

    // Memory cap: walking too many detail pages on Render's 512MB free tier blows
    // the heap (each page is ~300KB-1MB HTML, decoded to UTF-16 = 2x in V8). For
    // dealers with more inventory than this cap, we sync only the most recent N and
    // log how many were skipped. Configurable via env so upgrades unlock everything.
    const MAX_DETAIL_URLS = parseInt(process.env.MAX_SITEMAP_URLS) || 400
    const totalUrls = urls.length
    if (totalUrls > MAX_DETAIL_URLS) {
      urls = urls.slice(0, MAX_DETAIL_URLS)
      console.warn(`[sync] EDealer sitemap: capping walk at ${MAX_DETAIL_URLS}/${totalUrls} URLs (set MAX_SITEMAP_URLS env to raise)`)
    } else {
      console.log(`[sync] EDealer sitemap: ${urls.length} detail URLs to fetch`)
    }

    // Per-response size limit — a single misbehaving page (e.g. inline base64 photos)
    // could blow heap by itself. Cap reads at 3MB and skip oversized pages.
    const MAX_BYTES = 3 * 1024 * 1024

    const vehicles = []
    let fetched = 0, failed = 0, oversized = 0
    const CONCURRENCY = 3
    for (let i = 0; i < urls.length; i += CONCURRENCY) {
      const batch = urls.slice(i, i + CONCURRENCY)
      const results = await Promise.all(batch.map(async (url) => {
        try {
          const r = await browserFetch(url, { headers: extraHeaders })
          if (!r.ok) { failed++; return null }
          // Skip oversized responses without decoding the whole body to a string
          const lenHeader = parseInt(r.headers.get('content-length') || '0')
          if (lenHeader > MAX_BYTES) { oversized++; return null }
          let html = await r.text()
          if (html.length > MAX_BYTES) { html = null; oversized++; return null }
          const parsed = parseEDealerDetailPage(html, url)
          html = null  // explicit drop so GC reclaims the 1MB+ string before next batch
          fetched++
          return parsed
        } catch { failed++; return null }
      }))
      vehicles.push(...results.filter(Boolean))
      // Tiny pause between batches lets V8 schedule a young-gen GC pass —
      // measurably reduces peak heap on long walks
      if (i + CONCURRENCY < urls.length) await sleep(50)
    }
    console.log(`[sync] EDealer sitemap walker: ${vehicles.length} valid · ${fetched} fetched · ${failed} failed · ${oversized} oversized`)
    return vehicles.length > 0 ? vehicles : null
  } catch (e) {
    console.warn('[sync] EDealer sitemap walker failed:', e.message)
    return null
  }
}

// Map a Schema.org Vehicle/Car JSON-LD node to our canonical vehicle shape.
// Schema.org is the ONE format nearly every North-American dealer platform emits
// (Google requires it for vehicle rich-results), so this mapper is platform-agnostic:
// eDealer, Dealer.com, DealerInspire, DealerOn, Sincro/CDK, VinSolutions, etc.
export function schemaCarToVehicle(c) {
  const cond = (c.itemCondition || '')
  const cfg = typeof c.vehicleConfiguration === 'string' ? c.vehicleConfiguration : ''
  const cfgParts = cfg.split(' ').filter(Boolean)
  // Offers can be an object, an array, or an AggregateOffer wrapper.
  const offer = Array.isArray(c.offers) ? c.offers[0]
    : (c.offers?.offers ? (Array.isArray(c.offers.offers) ? c.offers.offers[0] : c.offers.offers) : c.offers)
  const price = offer?.price || c.offers?.lowPrice || c.offers?.price || 0
  const condText = `${cond} ${c.name || ''}`.toLowerCase()
  const condition = /demo|démo/.test(condText) ? 'Demo'
    : cond.includes('NewCondition') || /\bnew\b/.test(condText) ? 'New'
    : cond.includes('UsedCondition') || /used|pre-owned|preowned|certified/.test(condText) ? 'Used'
    : null
  return {
    vin: c.vehicleIdentificationNumber || c.vin || null,
    year: c.vehicleModelDate ? parseInt(c.vehicleModelDate) : (c.modelDate ? parseInt(c.modelDate) : null),
    make: c.brand?.name || c.manufacturer?.name || (typeof c.brand === 'string' ? c.brand : null),
    model: typeof c.model === 'string' ? c.model : (c.model?.name || null),
    trim: cfgParts.length > 1 ? cfgParts.slice(1).join(' ') : (c.vehicleConfiguration || null),
    price: typeof price === 'string' ? parseInt(price.replace(/[^0-9]/g, '')) || 0 : (price || 0),
    mileage: c.mileageFromOdometer?.value || c.mileageFromOdometer || 0,
    exteriorcolor: c.color || null,
    interiorcolor: c.vehicleInteriorColor || null,
    transmission: c.vehicleTransmission || null,
    fueltype: c.fuelType || c.vehicleEngine?.fuelType || null,
    bodystyle: c.bodyType || null,
    condition,
    demo: condition === 'Demo',
    stocknumber: c.sku || c.productID || c.mpn || null,
    onweb: true, salepending: false,
    image_urls: (() => {
      let imgs = c.image
      if (imgs && typeof imgs === 'object' && !Array.isArray(imgs)) imgs = imgs.url || imgs.contentUrl
      imgs = Array.isArray(imgs) ? imgs : (imgs ? [imgs] : [])
      return imgs
        .map(i => typeof i === 'string' ? i : (i?.url || i?.contentUrl))
        .filter(u => u && !u.includes('coming.png') && !u.includes('no-image'))
    })()
  }
}

// Pull FULL dealer inventory by paginating the LISTING page and reading the
// Schema.org JSON-LD baked into each page. This is the UNIVERSAL fallback that
// works across virtually every US/Canada dealer platform, because they all emit
// Vehicle/Car JSON-LD for SEO. It avoids per-platform APIs (which cap/paginate
// inconsistently) and heavy detail-page walks.
//
// Pagination formats vary by platform, so we auto-detect: on page 2 we try each
// candidate format and keep whichever returns NEW vehicles (VIN/stock dedup).
// If none return new vehicles, we stop with page 1 — never worse than a single page.
// A broken paginator therefore can't loop or hang: dedup + MAX_PAGES cap it.
//
// listingUrl: the dealer's inventory listing page (e.g. /inventory/new/,
//             /new-inventory/, /used-vehicles/). Pass source_dealer_url.
export async function fetchListingPageInventory(listingUrl, opts = {}) {
  const extraHeaders = opts.headers || {}
  let base
  try {
    const u = new URL(listingUrl)
    base = u.origin + u.pathname.replace(/\/$/, '') + '/'
  } catch { return null }

  const jsonLdRe = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  const extractCarsFromHtml = (html) => {
    const blocks = []
    let m
    while ((m = jsonLdRe.exec(html)) !== null) {
      try { blocks.push(JSON.parse(m[1])) } catch {}
    }
    jsonLdRe.lastIndex = 0
    const flat = []
    const q = [...blocks]
    while (q.length) {
      const n = q.pop()
      if (!n) continue
      if (Array.isArray(n)) { for (const x of n) q.push(x); continue }
      if (Array.isArray(n['@graph'])) { for (const x of n['@graph']) q.push(x); continue }
      flat.push(n)
    }
    return extractCarsFromJsonLd(flat)
  }
  const fetchCars = async (url) => {
    try {
      const r = await browserFetch(url, { headers: { Accept: 'text/html', ...extraHeaders } })
      if (!r.ok) return null
      return extractCarsFromHtml(await r.text())
    } catch { return null }
  }

  const seen = new Set()
  const all = []
  const addCars = (cars) => {
    let fresh = 0
    for (const c of cars || []) {
      const v = schemaCarToVehicle(c)
      const id = v.vin || (v.stocknumber ? `stk:${v.stocknumber}` : null)
      if (!id || seen.has(id)) continue
      seen.add(id); all.push(v); fresh++
    }
    return fresh
  }

  // Page 1
  const firstCars = await fetchCars(base)
  if (!firstCars || !firstCars.length) return null
  const pageSize = addCars(firstCars) || firstCars.length

  // Candidate pagination formats spanning the major platforms. p = 1-based page.
  const FORMATS = [
    p => `${base}?page=${p}`,                       // eDealer, DealerInspire, generic
    p => `${base}?start=${(p - 1) * pageSize}`,     // Dealer.com (offset)
    p => `${base}?pt=${p}`,                         // DealerOn
    p => `${base}?pn=${p}`,                         // Sincro / CDK
    p => `${base}page/${p}/`,                       // WordPress path style
    p => `${base}?_dFR%5Bpage%5D=${p}`,             // Algolia-backed
    p => `${base}?offset=${(p - 1) * pageSize}`,    // generic offset
  ]

  // Detect the working format on page 2.
  let workingFormat = null
  for (const fmt of FORMATS) {
    const cars = await fetchCars(fmt(2))
    if (cars && addCars(cars) > 0) { workingFormat = fmt; break }
  }

  if (workingFormat) {
    const MAX_PAGES = 60  // 60 * ~25 = 1500 vehicles; hard ceiling
    for (let page = 3; page <= MAX_PAGES; page++) {
      const cars = await fetchCars(workingFormat(page))
      if (!cars || !cars.length) break
      if (addCars(cars) === 0) break  // only dupes → past the end / paginator stalled
      await sleep(30)
    }
  }

  console.log(`[sync] listing-page walk: ${all.length} vehicles from ${base}`)
  return all.length > 0 ? all : null
}

// Cheap reachability probe: does this origin expose an eDealer inventory sitemap
// with vehicle detail URLs, fetchable from the server? Returns the URL count (0 if
// missing/blocked). Used at feed-add time to register eDealer sites as normal
// server-syncable 'edealer' feeds even when their JSON API is Cloudflare-gated —
// the sitemap + detail pages are frequently reachable when the API isn't. One HTTP
// fetch, so it's safe to call during the synchronous add request.
export async function eDealerSitemapReachable(origin) {
  try {
    const r = await browserFetch(`${origin}/inventory-listing-sitemap.xml`)
    if (!r.ok) return 0
    const xml = await r.text()
    return [...xml.matchAll(/<loc>([^<]+\/inventory\/[^<]+vdp\/?)<\/loc>/g)].length
  } catch { return 0 }
}

export function extractEDealerDetailUrls(html, origin) {
  const re = /href="(\/inventory\/[a-zA-Z0-9-]+vdp\/?)"/g
  const out = []
  const seen = new Set()
  let m
  while ((m = re.exec(html)) !== null) {
    const path = m[1].endsWith('/') ? m[1] : m[1] + '/'
    if (!seen.has(path)) { seen.add(path); out.push(`${origin}${path}`) }
  }
  return out
}

export function extractEDealerImagesFromPage(html) {
  const re = /https:\/\/media\.edealer\.ca\/w_1920[^"'\s]*?\.webp/g
  const seen = new Set()
  let m
  while ((m = re.exec(html)) !== null) seen.add(m[0])
  return [...seen]
}

export async function fetchEDealerDetailImageGroups(detailUrls, concurrency = 2) {
  const results = new Array(detailUrls.length).fill([])
  for (let i = 0; i < detailUrls.length; i += concurrency) {
    const batch = detailUrls.slice(i, i + concurrency)
    const batchResults = await Promise.all(batch.map(async (url) => {
      try {
        const r = await browserFetch(url)
        if (!r.ok) return []
        return extractEDealerImagesFromPage(await r.text())
      } catch { return [] }
    }))
    batchResults.forEach((imgs, idx) => { results[i + idx] = imgs })
  }
  return results
}

export function extractEDealerImageGroups(html) {
  const thumbRe = /https:\/\/media\.edealer\.ca\/w_400[^"'\s]*?\.webp/g
  const fullRe = /https:\/\/media\.edealer\.ca\/w_1920[^"'\s]*?\.webp/g
  const thumbs = []
  let m
  while ((m = thumbRe.exec(html)) !== null) thumbs.push({ pos: m.index, url: m[0] })
  const fulls = []
  while ((m = fullRe.exec(html)) !== null) fulls.push({ pos: m.index, url: m[0] })
  if (!thumbs.length) return []
  return thumbs.map((t, i) => {
    const end = i + 1 < thumbs.length ? thumbs[i + 1].pos : html.length
    const seen = new Set()
    const gallery = []
    for (const f of fulls) {
      if (f.pos > t.pos && f.pos < end && !seen.has(f.url)) {
        seen.add(f.url)
        gallery.push(f.url)
      }
    }
    return gallery
  })
}

export function extractCarsFromJsonLd(nodes) {
  const cars = []
  const seen = new WeakSet()
  const isCar = (node) => {
    const type = node?.['@type']
    if (!type) return false
    const types = Array.isArray(type) ? type : [type]
    return types.some(t => t === 'Car' || t === 'Vehicle' || t === 'MotorVehicle')
  }
  // ITERATIVE walker (no recursion). Yoast SEO + EDealer graphs can produce
  // deeply nested structures (50+ levels) — a recursive version blew Node's
  // stack on production and triggered SIGABRT (exit 134). This version uses
  // an explicit work-queue so it can handle ANY depth in O(nodes) memory.
  const queue = [nodes]
  while (queue.length > 0) {
    const node = queue.pop()
    if (!node) continue
    if (Array.isArray(node)) {
      for (const item of node) queue.push(item)
      continue
    }
    if (typeof node !== 'object') continue
    if (seen.has(node)) continue
    seen.add(node)
    if (isCar(node)) { cars.push(node); continue }
    for (const v of Object.values(node)) {
      if (v && typeof v === 'object') queue.push(v)
    }
  }
  return cars
}

// ── Convertus / motocommerce (VMS) ───────────────────────────────────────────
// Convertus dealer sites (WordPress "achilles" theme) expose none of the standard
// feed paths. Their SRP bundle loads inventory through a SAME-ORIGIN PHP proxy that
// forwards to the VMS API:
//   {origin}/wp-content/plugins/convertus-vms/include/php/ajax-vehicles.php
//       ?endpoint=<url-encoded VMS url>&action=vms_data
// VMS url: https://vms.prod.convertus.rocks/api/filtering/?cp=<inventoryId>&pg=N&pc=100&sc=<class>...
// cp = the dealer's inventoryId, embedded in every page as "inventoryId":"NNNN".
// Hitting the VMS host directly 403s (WAF); going through the dealer's own proxy works.
const CONVERTUS_VMS_FILTERING = 'https://vms.prod.convertus.rocks/api/filtering/'

export function extractConvertusInventoryId(html) {
  const m = html.match(/"inventoryId"\s*:\s*"?(\d{1,8})"?/i)
  return m ? m[1] : null
}

export function buildConvertusProxyUrl(origin, inventoryId, { page = 1, perPage = 100, saleClass = '' } = {}) {
  const endpoint = `${CONVERTUS_VMS_FILTERING}?cp=${inventoryId}&ln=en&pg=${page}&pc=${perPage}`
    + `&dc=true&sc=${encodeURIComponent(saleClass)}&ai=true&in_stock=true&on_order=true&in_transit=true`
  return `${origin}/wp-content/plugins/convertus-vms/include/php/ajax-vehicles.php`
    + `?endpoint=${encodeURIComponent(endpoint)}&action=vms_data`
}

export function mapConvertusVehicle(v) {
  const price = (v.sale_price && v.sale_price > 0 ? v.sale_price : 0)
    || v.internet_price || v.asking_price || v.retail_price || v.msrp || 0
  const image_urls = Array.isArray(v.image)
    ? v.image.map(im => im?.image_original || im?.image_lg || im?.image_md).filter(Boolean)
    : []
  const sc = String(v.sale_class || '').toLowerCase()
  const condition = sc.startsWith('new') ? 'New' : sc.startsWith('used') ? 'Used' : (v.sale_class || null)
  return {
    vin: v.vin || null,
    year: v.year || null,
    make: v.make || null,
    model: v.model || null,
    trim: v.trim || v.search_trim || null,
    stocknumber: v.stock_number || null,
    price,
    saleprice: price,
    mileage: Number(v.odometer) || 0,
    condition,
    demo: v.demo === 1 || v.demo === true,
    exteriorcolor: v.exterior_color || v.manu_exterior_color || null,
    interiorcolor: v.interior_color || null,
    transmission: v.transmission || null,
    fueltype: v.fuel_type || null,
    bodystyle: v.body_style || null,
    image_urls,
    vdp_url: v.vdp_url || null,
    onweb: true,
    salepending: false
  }
}

// Paginate the same-origin proxy for the full inventory. feedType maps to the VMS
// `sc` (sale class) param so "new"/"used" feeds fetch only that subset.
export async function fetchConvertusInventory(origin, inventoryId, feedType = 'all') {
  const saleClass = feedType === 'new' ? 'New' : feedType === 'used' ? 'Used' : ''
  const perPage = 100
  const all = []
  let page = 1, total = Infinity
  try {
    while (all.length < total && page <= 50) {
      const url = buildConvertusProxyUrl(origin, inventoryId, { page, perPage, saleClass })
      const r = await browserFetch(url, { headers: { 'Accept': 'application/json, text/plain, */*' } })
      if (!r.ok) { console.warn(`[sync] Convertus page ${page} HTTP ${r.status}`); break }
      let data
      try { data = JSON.parse(await r.text()) } catch { console.warn('[sync] Convertus page not JSON'); break }
      total = Number(data?.summary?.total_vehicles) || all.length
      const results = Array.isArray(data?.results) ? data.results : []
      if (!results.length) break
      all.push(...results.map(mapConvertusVehicle))
      page++
    }
    console.log(`[sync] Convertus: ${all.length}/${total} vehicles (inventoryId=${inventoryId}, sc='${saleClass}')`)
    return all
  } catch (e) {
    console.warn('[sync] Convertus fetch failed:', e.message)
    return all
  }
}

// Detection: fetch the dealer page, pull inventoryId, confirm the proxy returns vehicles.
export async function detectConvertus(dealerUrl) {
  try {
    const origin = new URL(dealerUrl).origin
    const pageRes = await browserFetch(dealerUrl)
    if (!pageRes.ok) return null
    const html = await pageRes.text()
    if (!/convertus|achilles/i.test(html)) return null
    const inventoryId = extractConvertusInventoryId(html)
    if (!inventoryId) return null
    const url = buildConvertusProxyUrl(origin, inventoryId, { page: 1, perPage: 100, saleClass: '' })
    const r = await browserFetch(url, { headers: { 'Accept': 'application/json, text/plain, */*' } })
    if (!r.ok) return null
    let data
    try { data = JSON.parse(await r.text()) } catch { return null }
    const results = Array.isArray(data?.results) ? data.results : []
    if (!results.length) return null
    return {
      success: true,
      platform: 'convertus',
      platform_label: 'Convertus (VMS)',
      feed_url: url,
      source_dealer_url: origin,
      vehicle_count: Number(data?.summary?.total_vehicles) || results.length,
      sample_vehicles: results.slice(0, 3).map(mapConvertusVehicle)
    }
  } catch (e) {
    console.warn('[probe] Convertus detection failed:', e.message)
    return null
  }
}

// ── DealerPage (dealerpage.ca) — server-rendered WordPress dealer theme ─────────
// These sites expose NO JSON feed and fire NO inventory XHR (the listing HTML is
// server-rendered), so neither the static path probes nor the headless SPA-render
// fallback catch them — every probe just hits the WordPress soft-404 (HTTP 200 +
// homepage HTML). We parse the /vehicles/ listing page directly: each card is an
// <a itemprop="url"> wrapper containing a CarGurus VIN/price span, labelled text
// (Mileage / Stock #), and a lazy-loaded image whose real URL sits in data-lazy-src.
export function decodeHtmlEntities(s) {
  return String(s || '')
    .replace(/&#0?38;|&amp;/g, '&')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&#x2f;|&#47;/gi, '/')
}

export function parseDealerPageHtml(html) {
  const anchorRe = /<a\b[^>]*\bitemprop="url"[^>]*>/gi
  const starts = []
  let m
  while ((m = anchorRe.exec(html)) !== null) starts.push(m.index)

  const vehicles = []
  for (let k = 0; k < starts.length; k++) {
    const chunk = html.slice(starts[k], k + 1 < starts.length ? starts[k + 1] : starts[k] + 9000)
    const href = (chunk.match(/<a\b[^>]*>/)?.[0].match(/href="([^"]+)"/) || [])[1] || null
    const img = (chunk.match(/data-lazy-src="([^"]+)"/) || chunk.match(/itemprop="image"[^>]+src="(https?:\/\/[^"]+)"/) || [])[1] || null
    const alt = (chunk.match(/alt="([^"]*)"/) || [])[1] || ''
    const text = chunk.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
    // Prefer the CarGurus widget data attrs, but fall back to the visible text so
    // dealers WITHOUT the CarGurus integration still get VIN + price.
    const vin = (chunk.match(/data-cg-vin="([^"]*)"/) || [])[1]
      || (text.match(/\bVIN[:\s#]*([A-HJ-NPR-Z0-9]{11,17})\b/i) || [])[1] || null
    const priceRaw = (chunk.match(/data-cg-price="([^"]*)"/) || [])[1]
      || (text.match(/(?:Dealer Price|Sale Price|Our Price|Price)[:\s]*\$\s*([\d,]+(?:\.\d+)?)/i) || [])[1]?.replace(/,/g, '') || null
    // Accept KM (Canada) or Miles (US).
    const mileage = (text.match(/(?:Mileage|Odometer)[:\s]*([\d,]+)\s*(?:KM|Miles|mi)\b/i) || [])[1]?.replace(/,/g, '') || null
    const stock = (text.match(/Stock\s*#?\s*:?\s*([A-Za-z0-9-]+)/i) || [])[1] || null
    const trans = (text.match(/Transmission\s+(.+?)\s+(?:Dealer Price|Price|Details|Get|Book|Apply)/i) || [])[1] || null
    const condition = (/\bUsed\b/i.test(text)) ? 'Used' : (/\bNew\b/i.test(text) ? 'New' : null)
    // Sold detection: DealerPage keeps sold cars on the listing page, flagged via the
    // schema.org availability ("Sold!") and a "SOLD" image overlay. Mark them so they
    // import as status:'sold' (shown in the catalog, but NOT offered for posting).
    const sold = /itemprop="availability"[^>]*>[^<]*sold/i.test(chunk)
      || /<p[^>]*>\s*SOLD\s*<\/p>/i.test(chunk)

    const toks = decodeHtmlEntities(alt).trim().split(/\s+/)
    const year = /^(19|20)\d{2}$/.test(toks[0] || '') ? toks[0] : null
    if (!vin && !year) continue   // not a real card

    vehicles.push({
      vin,
      year,
      make: toks[1] || null,
      model: toks[2] || null,
      trim: toks.slice(3).join(' ') || null,
      price: priceRaw ? Number(priceRaw) : null,
      mileage: mileage ? Number(mileage) : null,
      stock_number: stock,
      transmission: trans ? trans.trim() : null,
      condition,
      sold,
      vdp_url: href,
      images: img ? [decodeHtmlEntities(img)] : []
    })
  }
  return vehicles
}

// Fetch + parse a DealerPage listing page into canonical vehicle records.
export async function fetchDealerPageInventory(pageUrl) {
  const r = await browserFetch(`${pageUrl}${pageUrl.includes('?') ? '&' : '?'}v=${Date.now()}`, {
    headers: { 'Accept': 'text/html,application/xhtml+xml' }
  })
  if (!r.ok) return []
  const html = await r.text()
  return parseDealerPageHtml(html).map(v => ({ ...genericMapVehicle(v), sold: v.sold, vdp_url: v.vdp_url, _detail_url: v.vdp_url }))
}

export async function detectDealerPage(dealerUrl) {
  try {
    const origin = new URL(dealerUrl).origin
    // Listing page candidates, most-likely first. DealerPage uses /vehicles/.
    const candidates = [...new Set([dealerUrl, `${origin}/vehicles/`, `${origin}/inventory/`])]
    for (const url of candidates) {
      const r = await browserFetch(url)
      if (!r.ok) continue
      const html = await r.text()
      const isDealerPage = /dealerpage\.ca|dealersite-inventory/i.test(html)
        || (/data-cg-vin=/.test(html) && /itemprop="url"/.test(html))
      if (!isDealerPage) continue
      const raw = parseDealerPageHtml(html)
      if (!raw.length) continue
      return {
        success: true,
        platform: 'dealerpage',
        platform_label: 'DealerPage',
        feed_url: url,
        source_dealer_url: origin,
        vehicle_count: raw.length,
        sample_vehicles: raw.slice(0, 3).map(genericMapVehicle)
      }
    }
    return null
  } catch (e) {
    console.warn('[probe] DealerPage detection failed:', e.message)
    return null
  }
}

export async function probeUrl(url, timeoutMs = 8000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await browserFetch(url, {
      signal: controller.signal,
      headers: { 'Accept': 'application/json, text/plain, */*', 'Sec-Fetch-Dest': 'empty', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Site': 'same-origin' }
    })
    clearTimeout(timer)
    // Cloudflare/WAF block — signal to the caller that a real-browser retry may help.
    if (res.status === 403 || res.status === 503) return { ok: false, status: res.status, blocked: true }
    if (!res.ok) return { ok: false, status: res.status }
    const contentType = res.headers.get('content-type') || ''
    if (!contentType.includes('json')) return { ok: false, status: res.status, reason: 'non-json response' }
    const data = await res.json()
    return { ok: true, data }
  } catch (e) {
    clearTimeout(timer)
    return { ok: false, reason: e.name === 'AbortError' ? 'timeout' : e.message }
  }
}

export async function detectFeedPlatform(dealerUrl) {
  let origin
  try {
    origin = new URL(dealerUrl.trim()).origin
  } catch {
    return { success: false, error: 'Invalid URL' }
  }

  const attempts = []
  const blockedJsonProbes = []  // { platform, url } for JSON probes that 403/503'd (likely Cloudflare)

  for (const platform of PLATFORM_PROBES) {
    const urls = platform.htmlProbe ? [dealerUrl] : platform.buildUrls(origin)
    for (const url of urls) {
      const result = platform.htmlProbe ? await probeUrlHtml(url) : await probeUrl(url)
      const probeData = platform.htmlProbe ? result : result.data
      attempts.push({
        platform: platform.platform, label: platform.label, url,
        ok: result.ok, status: result.status, reason: result.reason
      })
      if (result.blocked && !platform.htmlProbe) blockedJsonProbes.push({ platform: platform.platform, url })

      if (result.ok && platform.validate(probeData)) {
        const vehicles = platform.extract(probeData)
        const sample = vehicles.slice(0, 3).map(platform.mapVehicle)
        return {
          success: true,
          platform: platform.platform,
          platform_label: platform.label,
          feed_url: url,
          vehicle_count: vehicles.length,
          sample_vehicles: sample,
          attempts
        }
      }
    }
  }

  // Cloudflare / WAF escalation: if static probes were BLOCKED (403/503) rather than
  // simply absent, the JSON feed likely exists but is gated behind bot protection.
  // Retry the blocked JSON endpoints through real Chrome (one warmed session that
  // clears any JS challenge), then validate/extract exactly as the static path would.
  if (blockedJsonProbes.length) {
    console.log(`[probe] ${blockedJsonProbes.length} probe(s) blocked (403/503) — retrying via headless Chrome`)
    try {
      const results = await fetchUrlsViaBrowser(blockedJsonProbes.map(p => p.url))
      for (const r of results) {
        if (!r.ok || !r.body) continue
        let data
        try { data = JSON.parse(r.body) } catch { continue }
        const ref = blockedJsonProbes.find(p => p.url === r.url)
        const platform = ref && PLATFORM_PROBES.find(pp => pp.platform === ref.platform)
        if (!platform || !platform.validate(data)) continue
        const vehicles = platform.extract(data)
        console.log(`[probe] Cloudflare-bypassed feed via Chrome: ${vehicles.length} vehicles from ${r.url}`)
        return {
          success: true,
          platform: platform.platform,
          platform_label: platform.label,
          feed_url: r.url,
          vehicle_count: vehicles.length,
          sample_vehicles: vehicles.slice(0, 3).map(platform.mapVehicle),
          cloudflare_bypassed: true,
          attempts
        }
      }
    } catch (e) {
      console.warn(`[probe] headless Cloudflare retry failed: ${e.message}`)
    }
  }

  // Convertus / motocommerce (VMS) sites hide inventory behind a same-origin proxy;
  // none of the static paths match. Detect via the listing page's inventoryId.
  const convertus = await detectConvertus(dealerUrl)
  if (convertus) {
    console.log(`[probe] Convertus detected: ${convertus.vehicle_count} vehicles`)
    return { ...convertus, attempts }
  }

  // DealerPage (dealerpage.ca) — server-rendered HTML, no JSON feed / no XHR.
  const dealerpage = await detectDealerPage(dealerUrl)
  if (dealerpage) {
    console.log(`[probe] DealerPage detected: ${dealerpage.vehicle_count} vehicles`)
    return { ...dealerpage, attempts }
  }

  // Fallback: render the SPA in a headless browser and watch for the inventory XHR.
  // Catches UX Auto, pure DealerInspire SPAs, and most other JS-rendered dealer sites.
  console.log(`[probe] No static probe matched — rendering ${dealerUrl} with headless Chromium`)
  try {
    const rendered = await renderAndCaptureInventory(dealerUrl)
    if (rendered.success && rendered.vehicles?.length > 0) {
      console.log(`[probe] Headless capture: ${rendered.vehicles.length} vehicles from ${rendered.source_url}`)
      return {
        success: true,
        platform: 'spa_render',
        platform_label: 'SPA (headless render)',
        feed_url: rendered.source_url,
        vehicle_count: rendered.vehicles.length,
        sample_vehicles: rendered.sample.map(genericMapVehicle),
        attempts: [...attempts, ...(rendered.attempts || [])]
      }
    }
    attempts.push({ platform: 'spa_render', label: 'SPA (headless render)', ok: false, reason: rendered.error })
  } catch (e) {
    attempts.push({ platform: 'spa_render', label: 'SPA (headless render)', ok: false, reason: e.message })
  }

  // If most probes were blocked (403/503) by a WAF and every fallback also failed,
  // this is almost certainly a Cloudflare IP-reputation block: server-side access —
  // INCLUDING our headless Chrome on Render — can't get through, because the block is
  // on the datacenter IP/ASN, not a solvable JS challenge. The user must use the
  // MarketSync Chrome extension, which captures from their own (residential) browser.
  const blockedCount = attempts.filter(a => a.status === 403 || a.status === 503).length
  const cloudflareBlocked = blockedCount >= 3
  return {
    success: false,
    cloudflare_blocked: cloudflareBlocked,
    error: cloudflareBlocked
      ? "This dealer site is protected by Cloudflare and blocks server-side access (the block is on the server's IP, so it can't be bypassed from our end). Use the MarketSync Chrome extension on the dealer's inventory page to capture vehicles directly from your browser."
      : 'No known inventory feed found for this dealer URL. Try pasting the direct JSON feed URL instead.',
    attempts
  }
}
