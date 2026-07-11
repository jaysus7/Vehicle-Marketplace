// Headless browser renderer for SPA dealer sites that don't expose a static JSON feed.
// Loads the dealer URL in real Chromium, captures every XHR/fetch response, and returns
// the ones that look like inventory data. Used as the last-resort detection path after
// PLATFORM_PROBES fail.
//
// Runs on Render via @sparticuz/chromium (slim Lambda-style Chromium). Locally, falls
// back to whatever Chrome/Chromium is on the host. Cold start ~2-4s, warm ~5-15s.

import { resolveLotDate } from './sync/genericFeed.js'

// Lazy-load puppeteer-core only when actually needed. On free-tier Render the
// puppeteer-core + @sparticuz/chromium pair adds ~150-200MB just by being imported,
// which is enough to push memory-tight syncs over the limit. With dynamic import,
// the cost only lands when the user explicitly opts into headless features.
let _puppeteer = null
async function getPuppeteer() {
  if (_puppeteer) return _puppeteer
  _puppeteer = (await import('puppeteer-core')).default
  return _puppeteer
}

let cachedBrowser = null
let cachedLaunchPromise = null

async function getChromiumExecutable() {
  // Render / production: use the bundled headless build
  if (process.env.NODE_ENV === 'production' || process.env.RENDER) {
    const chromium = (await import('@sparticuz/chromium')).default
    return {
      executablePath: await chromium.executablePath(),
      args: chromium.args,
      headless: chromium.headless
    }
  }
  // Local dev fallback — try a few common paths
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser'
  ]
  const fs = await import('fs')
  const exec = candidates.find(p => { try { fs.statSync(p); return true } catch { return false } })
  if (!exec) throw new Error('No local Chrome/Chromium found — set CHROME_PATH or run on Render')
  return {
    executablePath: exec,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    headless: 'new'
  }
}

const SAFE_CHROMIUM_ARGS = [
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-extensions',
  '--single-process',
]

async function getBrowser() {
  // Kill-switch: on a memory-tight tier (512MB Render), launching Chromium while
  // serving the app can saturate RAM/CPU and make the web server unresponsive or
  // OOM-crash. Set DISABLE_HEADLESS=1 to stop ALL server-side Chromium — every
  // headless caller catches this and degrades gracefully (Cloudflare/SPA dealers
  // fall through to extension-capture; feed detection returns fast). Flip it off
  // (or bump the Render tier) to restore server-side rendering.
  if (process.env.DISABLE_HEADLESS === '1') {
    throw new Error('headless rendering disabled (DISABLE_HEADLESS=1)')
  }
  if (cachedBrowser && cachedBrowser.connected !== false) return cachedBrowser
  if (cachedLaunchPromise) return cachedLaunchPromise
  cachedLaunchPromise = (async () => {
    const puppeteer = await getPuppeteer()
    const cfg = await getChromiumExecutable()
    const safeArgs = [...new Set([...(cfg.args || []), ...SAFE_CHROMIUM_ARGS])]
    const browser = await puppeteer.launch({
      executablePath: cfg.executablePath,
      args: safeArgs,
      headless: cfg.headless,
      defaultViewport: { width: 1366, height: 900 }
    })
    cachedBrowser = browser
    browser.on('disconnected', () => { cachedBrowser = null })
    return browser
  })()
  try {
    return await cachedLaunchPromise
  } finally {
    cachedLaunchPromise = null
  }
}

// ── Headless Chrome memory safeguard ──────────────────────────────────────────
// Each Chromium instance is ~150-200MB. On Render's 512MB tier, two at once (or one
// heavy page) pushes the process past its limit and Render kills it (exit 134),
// aborting the WHOLE sync run — every dealer that hadn't synced yet gets nothing.
// This guard adds three seatbelts around every headless op:
//   1. Serialize — only ONE headless op runs at a time (others queue behind it).
//   2. Memory precheck — if the heap is already high, SKIP rather than risk OOM
//      (the caller falls back to its next method / the extension).
//   3. GC hint after each op so memory is reclaimed before the next one.
// Tune the skip threshold with HEADLESS_HEAP_LIMIT_MB (default 350).
let _headlessChain = Promise.resolve()
const HEADLESS_HEAP_LIMIT_MB = parseInt(process.env.HEADLESS_HEAP_LIMIT_MB) || 350

export async function withHeadlessGuard(fn, { label = 'headless', onSkip } = {}) {
  // Kill-switch — skip instantly (no browser, no queue) when headless is disabled.
  if (process.env.DISABLE_HEADLESS === '1') {
    return typeof onSkip === 'function' ? onSkip() : { skipped: true }
  }
  const run = async () => {
    const heapMB = process.memoryUsage().heapUsed / 1024 / 1024
    if (heapMB > HEADLESS_HEAP_LIMIT_MB) {
      console.warn(`[headless] SKIP ${label}: heap ${Math.round(heapMB)}MB > ${HEADLESS_HEAP_LIMIT_MB}MB limit — avoiding OOM`)
      return typeof onSkip === 'function' ? onSkip() : { skipped: true }
    }
    try { return await fn() }
    finally { if (global.gc) { try { global.gc() } catch {} } }
  }
  // Chain so only one runs at a time; swallow rejections so the chain never breaks.
  const result = _headlessChain.then(run, run)
  _headlessChain = result.catch(() => {})
  return result
}

// Fetch one or more URLs through real Chrome to get past Cloudflare / bot
// protection that 403s plain `fetch` (UA sniffing or JS challenges). We navigate
// the origin ONCE so any Cloudflare interstitial ("Just a moment…") runs its JS
// and sets the cf_clearance cookie, then issue same-origin in-page fetches for
// each target URL — those carry the clearance cookie and return the raw body.
// Returns [{ url, ok, status, body, contentType, error? }] in input order.
export async function fetchUrlsViaBrowser(urls, opts = {}) {
  if (!Array.isArray(urls) || urls.length === 0) return []
  return withHeadlessGuard(() => _fetchUrlsViaBrowserImpl(urls, opts), {
    label: `fetchUrlsViaBrowser(${urls.length} url${urls.length > 1 ? 's' : ''})`,
    onSkip: () => urls.map(u => ({ url: u, ok: false, status: 0, body: '', contentType: '', error: 'skipped (memory guard)' }))
  })
}

async function _fetchUrlsViaBrowserImpl(urls, opts = {}) {
  const { timeoutMs = 30000 } = opts
  const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
  let page
  try {
    const origin = new URL(urls[0]).origin
    const browser = await getBrowser()
    page = await browser.newPage()
    await page.setUserAgent(UA)
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' })

    // Warm the origin so a Cloudflare JS challenge (if any) clears once.
    await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: timeoutMs }).catch(() => {})
    const title = await page.title().catch(() => '')
    if (/just a moment|attention required|checking your browser|verify you are human/i.test(title)) {
      // Wait for the challenge to solve and redirect to real content.
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {})
    }

    const out = []
    for (const u of urls) {
      const res = await page.evaluate(async (target) => {
        try {
          const r = await fetch(target, {
            headers: { Accept: 'application/json, text/plain, */*' },
            credentials: 'include'
          })
          return { status: r.status, body: await r.text(), contentType: r.headers.get('content-type') || '' }
        } catch (e) {
          return { status: 0, body: '', contentType: '', error: String(e) }
        }
      }, u)
      out.push({ url: u, ok: res.status >= 200 && res.status < 300 && !!res.body, ...res })
    }
    return out
  } catch (e) {
    return urls.map(u => ({ url: u, ok: false, status: 0, body: '', contentType: '', error: e.message }))
  } finally {
    if (page) await page.close().catch(() => {})
  }
}

// Convenience wrapper for a single URL.
export async function fetchViaBrowser(targetUrl, opts = {}) {
  const [r] = await fetchUrlsViaBrowser([targetUrl], opts)
  return r || { ok: false, status: 0, body: '', contentType: '' }
}

// Heuristics for "this XHR is the inventory list"
function looksLikeInventoryUrl(url) {
  const u = url.toLowerCase()
  return /inventory|vehicles?|stock|listings?|catalog/.test(u)
}

function extractVehicleArray(json) {
  if (!json || typeof json !== 'object') return null
  // Direct array of vehicle-shaped objects
  if (Array.isArray(json)) {
    if (json.length && (json[0]?.vin || json[0]?.VIN || json[0]?.stock_id || json[0]?.stockNumber)) {
      return json
    }
    return null
  }
  // Common wrappers: { records: [...] }, { vehicles: [...] }, { inventory: [...] }, etc.
  const candidates = [
    json.records, json.vehicles, json.Vehicles, json.inventory, json.Inventory,
    json.data, json.items, json.results, json.listings
  ]
  for (const c of candidates) {
    if (Array.isArray(c) && c.length && (c[0]?.vin || c[0]?.VIN || c[0]?.stock_id || c[0]?.stockNumber)) {
      return c
    }
  }
  return null
}

// Render a dealer URL, watch every XHR/fetch response, return any that looked like inventory.
// Returns { success, vehicles, source_url, attempts } — attempts is for diagnostics.
// Guarded so it never OOM-crashes the sync (serialized + memory precheck).
export async function renderAndCaptureInventory(dealerUrl, opts = {}) {
  return withHeadlessGuard(() => _renderAndCaptureInventoryImpl(dealerUrl, opts), {
    label: 'renderAndCaptureInventory',
    onSkip: () => ({ success: false, error: 'skipped (memory guard)', vehicles: [], attempts: [] })
  })
}

async function _renderAndCaptureInventoryImpl(dealerUrl, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 45000
  const waitForXhrMs = opts.waitForXhrMs ?? 8000
  const attempts = []
  let page

  try {
    const browser = await getBrowser()
    page = await browser.newPage()
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36')
    await page.setRequestInterception(false)

    const captured = []
    page.on('response', async (res) => {
      try {
        const url = res.url()
        const ct = res.headers()['content-type'] || ''
        if (!ct.includes('json')) return
        if (!looksLikeInventoryUrl(url)) return
        const status = res.status()
        if (status < 200 || status >= 300) return

        const text = await res.text().catch(() => null)
        if (!text || text.length < 50) return
        let parsed
        try { parsed = JSON.parse(text) } catch { return }

        const vehicles = extractVehicleArray(parsed)
        attempts.push({ url, vehicleCount: vehicles?.length || 0, status })
        if (vehicles && vehicles.length > 0) {
          captured.push({ url, vehicles })
        }
      } catch {}
    })

    await page.goto(dealerUrl, { waitUntil: 'networkidle2', timeout: timeoutMs }).catch(() => {})

    // Give late-loading inventory XHRs a chance to complete
    await new Promise(r => setTimeout(r, waitForXhrMs))

    // Pick the response with the most vehicles (typically the main inventory list)
    captured.sort((a, b) => b.vehicles.length - a.vehicles.length)
    if (captured.length === 0) {
      return { success: false, error: 'No inventory XHR detected on page', attempts }
    }
    const best = captured[0]
    return {
      success: true,
      source_url: best.url,
      vehicles: best.vehicles,
      sample: best.vehicles.slice(0, 3),
      attempts
    }
  } catch (e) {
    return { success: false, error: e.message, attempts }
  } finally {
    if (page) { try { await page.close() } catch {} }
  }
}

// Harvest every per-vehicle detail-page URL from a dealer's inventory listing pages.
// Renders new + used + demo listing pages, scrolls each to trigger lazy-load, collects
// anchor hrefs, then builds a `stockNumber → fullUrl` map by matching feed stock numbers
// (and VINs as a fallback) against each anchor's href and surrounding card text. Saved
// once per feed; the sync engine uses it to resolve per-vehicle source_url without re-
// rendering on every sync. Generic across LeadBox, EDealer, Dealer.com, and most dealer
// CMSes — anything that publishes anchor-linked vehicle cards on listing pages works.
//
// vehicles — array of `{ stock?: string, vin?: string }` objects.
//            Stock match is tried first (most common in URL slugs), VIN as a fallback.
//            Stock-only call sites can pass `[{stock: '12345'}, ...]`.
export async function harvestVehicleUrls(dealerOriginOrUrl, vehicles, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 45000
  const scrollMs = opts.scrollMs ?? 6000

  // Backwards-compat: callers that still pass an array of plain strings are auto-promoted
  const normalized = (vehicles || []).map(v =>
    typeof v === 'string' ? { stock: v } : { stock: v?.stock || null, vin: v?.vin || null }
  ).filter(v => v.stock || v.vin)
  if (!normalized.length) return { success: false, error: 'no stock numbers or VINs given', map: {} }

  const origin = (() => {
    try { return new URL(dealerOriginOrUrl).origin } catch { return null }
  })()
  if (!origin) return { success: false, error: 'invalid dealer URL', map: {} }

  // Listing pages we try (priority order, broadest possible coverage across dealer CMSes).
  // LeadBox conventions first; UX Auto (Angular SPA) variants next; then generic catch-alls.
  const listingPaths = [
    // LeadBox / WordPress-style
    '/new-vehicles/', '/used-vehicles/', '/demo-inventory/',
    '/new-inventory/', '/used-inventory/', '/pre-owned/',
    // UX Auto SPAs (Mike Knapp Ford etc.) — uppercase + lowercase + plural "demos"
    '/inventory/list/new', '/inventory/list/used', '/inventory/list/demos',
    '/inventory/list/NEW', '/inventory/list/USED', '/inventory/list/DEMO',
    // Short-path conventions
    '/new/', '/used/', '/new-cars/', '/used-cars/',
    // Generic catch-alls
    '/inventory/', '/vehicles/', '/cars/', '/showroom/',
    '/all-inventory/', '/view/'
  ]

  // Word-boundary matcher — prevents stock "300" from false-matching `?page=300`
  // by requiring the value to sit between non-alphanumeric characters (or string edges).
  const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const matchesValue = (haystack, value) => {
    if (!haystack || !value) return false
    const re = new RegExp(`(^|[^a-z0-9])${escapeRegex(String(value).toLowerCase())}([^a-z0-9]|$)`)
    return re.test(haystack.toLowerCase())
  }

  const stockToUrl = {}
  const pagesVisited = []
  let page

  try {
    const browser = await getBrowser()
    page = await browser.newPage()
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36')

    for (const path of listingPaths) {
      const listingUrl = `${origin}${path}`
      try {
        const res = await page.goto(listingUrl, { waitUntil: 'networkidle2', timeout: timeoutMs }).catch(() => null)
        if (!res || res.status() >= 400) continue
        pagesVisited.push(listingUrl)

        // Scroll to bottom in chunks to trigger lazy-loaded cards
        await page.evaluate(async (totalMs) => {
          const step = 400
          const delay = 200
          const start = performance.now()
          while (performance.now() - start < totalMs) {
            window.scrollBy(0, step)
            await new Promise(r => setTimeout(r, delay))
          }
          window.scrollTo(0, 0)
        }, scrollMs)

        // Collect every anchor that looks vehicle-detail-shaped, with surrounding text for matching
        const anchors = await page.evaluate(() => {
          const out = []
          for (const a of document.querySelectorAll('a[href]')) {
            const href = a.href
            if (!href || href.startsWith('javascript:') || href.includes('#')) continue
            // Skip obvious non-vehicle links
            const lower = href.toLowerCase()
            if (lower.includes('mailto:') || lower.includes('tel:')) continue
            // Card text (used for stock-number matching)
            const card = a.closest('[class*="card"], [class*="vehicle"], [class*="listing"], li, article') || a
            out.push({ href, text: (card.textContent || '').slice(0, 600) })
          }
          return out
        })

        // For each feed vehicle, try to match an anchor by stock first, then by VIN.
        // Both use word-boundary matching so we don't false-positive on substring hits.
        for (const v of normalized) {
          const mapKey = v.stock || v.vin  // key the result by stock (falling back to VIN)
          if (!mapKey || stockToUrl[mapKey]) continue  // already found on an earlier page

          let hit = null
          if (v.stock) {
            hit = anchors.find(a => matchesValue(a.href, v.stock) || matchesValue(a.text, v.stock))
          }
          if (!hit && v.vin) {
            hit = anchors.find(a => matchesValue(a.href, v.vin) || matchesValue(a.text, v.vin))
          }
          if (hit) stockToUrl[mapKey] = hit.href
        }

        // Stop early if we matched every vehicle we were given
        if (Object.keys(stockToUrl).length >= normalized.length) break
      } catch (e) {
        console.warn(`[harvest] failed on ${listingUrl}: ${e.message}`)
      }
    }

    return {
      success: Object.keys(stockToUrl).length > 0,
      map: stockToUrl,
      matched: Object.keys(stockToUrl).length,
      total: normalized.length,
      pages_visited: pagesVisited
    }
  } catch (e) {
    return { success: false, error: e.message, map: stockToUrl, pages_visited: pagesVisited }
  } finally {
    if (page) { try { await page.close() } catch {} }
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// UNIVERSAL URL TEMPLATE INFERRER
// ──────────────────────────────────────────────────────────────────────────────
// Runs ONCE per feed (at feed-add or first sync if missing). Renders the dealer's
// listing page, finds an anchor that links to a vehicle whose stock/VIN we already
// know, then reverse-engineers a TEMPLATE — e.g.
//   "/view/{condition_lower}-{year}-{make_slug}-{model_slug}-{stock}/"
// The template is saved on the feed row. At sync time we just plug in each
// vehicle's data — instant, no re-rendering, works for any dealer platform.

const slugify = (s) => String(s || '').toLowerCase().trim()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// Extract canonical field values from a feed vehicle in a platform-agnostic way
function readVehicleFields(v) {
  return {
    stock: v.stocknumber || v.stock_id || v.stock || v.stockNumber || v.StockNumber || null,
    vin: v.vin || v.VIN || v.Vin || null,
    year: v.year || v.Year || v.modelYear || null,
    make: v.make || v.Make || null,
    model: v.model || v.Model || null,
    condition: v.condition || v.Condition || v.type || v.newOrUsed || null
  }
}

// Given the dealer's site + a few sample vehicles from the feed, find an anchor
// that links to one of them and derive a template.
export async function inferUrlTemplate(dealerSite, sampleVehicles, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 12000   // 12s per page (down from 45s)
  const scrollMs = opts.scrollMs ?? 3000      // 3s scroll (down from 6s)

  const origin = (() => { try { return new URL(dealerSite).origin } catch { return null } })()
  if (!origin) return { ok: false, error: 'invalid dealer URL' }

  const samples = (sampleVehicles || []).slice(0, 5).map(readVehicleFields).filter(v => v.stock || v.vin)
  if (!samples.length) return { ok: false, error: 'no sample vehicles with stock/VIN' }

  // Listing paths in PRIORITY order — most likely to have anchors first.
  // We break out the moment we find a match, so order matters a lot.
  const listingPaths = [
    '/used-vehicles/', '/new-vehicles/', '/demo-inventory/',           // LeadBox conventions
    '/inventory/list/new', '/inventory/list/used', '/inventory/list/demos',  // UX Auto SPAs
    '/used-inventory/', '/new-inventory/', '/pre-owned/',
    '/new/', '/used/', '/inventory/', '/vehicles/'
  ]

  let page
  try {
    const browser = await getBrowser()
    page = await browser.newPage()
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36')

    const pagesVisited = []
    for (const path of listingPaths) {
      const listingUrl = `${origin}${path}`
      try {
        const res = await page.goto(listingUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs }).catch(() => null)
        if (!res) { continue }
        const status = res.status()
        if (status >= 400) {
          console.log(`[inferTemplate]   ${status} ${listingUrl} — skipped`)
          continue
        }
        pagesVisited.push(listingUrl)

        // Scroll to trigger lazy loads (Angular/React SPAs)
        await page.evaluate(async (totalMs) => {
          const start = performance.now()
          while (performance.now() - start < totalMs) {
            window.scrollBy(0, 400)
            await new Promise(r => setTimeout(r, 200))
          }
          window.scrollTo(0, 0)
        }, scrollMs).catch(() => {})

        const anchors = await page.evaluate(() =>
          [...document.querySelectorAll('a[href]')]
            .map(a => a.href)
            .filter(h => h && !h.startsWith('javascript:') && !h.startsWith('mailto:') && !h.startsWith('tel:'))
        )
        console.log(`[inferTemplate]   ${status} ${listingUrl} — ${anchors.length} anchors`)

        // Find first anchor that matches ANY sample's stock or VIN
        for (const sample of samples) {
          for (const href of anchors) {
            const lowerHref = href.toLowerCase()
            const matchedBy = sample.stock && lowerHref.includes(String(sample.stock).toLowerCase()) ? 'stock'
                            : sample.vin && lowerHref.includes(String(sample.vin).toLowerCase()) ? 'vin'
                            : null
            if (!matchedBy) continue

            const template = deriveTemplate(href, sample)
            console.log(`[inferTemplate]   ✓ MATCH on ${listingUrl} via ${matchedBy}: ${href}`)
            await page.close().catch(() => {})
            return { ok: true, template, source_url: href, matched_by: matchedBy, listing_page: listingUrl }
          }
        }
      } catch (e) {
        console.warn(`[inferTemplate]   error on ${listingUrl}: ${e.message}`)
      }
    }

    return { ok: false, error: `No matching anchor on any listing page (visited ${pagesVisited.length})`, pages_visited: pagesVisited }
  } catch (e) {
    return { ok: false, error: e.message }
  } finally {
    if (page) { try { await page.close() } catch {} }
  }
}

// Replace a sample vehicle's known values in the URL with template placeholders.
// Replaces longest strings first to avoid partial-match accidents.
// Tries multiple variants per field: raw, lowercase, slugified.
function deriveTemplate(url, fields) {
  let template = url
  const replacements = []  // [{ pattern, placeholder, length }] — sort and apply

  const push = (rawValue, placeholder) => {
    if (rawValue == null) return
    const str = String(rawValue)
    if (str.length < 2) return  // skip 1-char values — too many false positives
    replacements.push({ pattern: escapeRe(str), placeholder, length: str.length })
  }

  // Stock + VIN (highest priority — most unique)
  push(fields.stock, '{stock}')
  push(fields.vin, '{vin}')
  push(fields.year, '{year}')

  // Make + model: try raw, lower, slug
  if (fields.make) {
    push(fields.make, '{make}')
    push(String(fields.make).toLowerCase(), '{make}')
    push(slugify(fields.make), '{make_slug}')
  }
  if (fields.model) {
    push(fields.model, '{model}')
    push(String(fields.model).toLowerCase(), '{model}')
    push(slugify(fields.model), '{model_slug}')
  }

  // Condition: raw + lowercase variants
  if (fields.condition) {
    push(fields.condition, '{condition}')
    push(String(fields.condition).toLowerCase(), '{condition_lower}')
  }

  // Apply longest first to avoid partial replacements (e.g. "Trail" matching inside "Trailblazer")
  replacements.sort((a, b) => b.length - a.length)
  for (const { pattern, placeholder } of replacements) {
    // Word-boundary-style replacement to avoid eating substrings inside other tokens
    template = template.replace(new RegExp(pattern, 'g'), placeholder)
  }
  return template
}

// Render an eDealer inventory page in headless Chrome and extract all vehicles
// via page.evaluate(). eDealer renders all cards server-side (the REST API only
// returns one page and ignores pagination params), so DOM scraping is the only
// reliable way to get the full inventory count from the server side.
//
// Returns { success, vehicles, source_url, error }.
export async function renderAndScrapeEDealer(dealerUrl, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 30000
  let page
  try {
    const browser = await getBrowser()
    page = await browser.newPage()
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36')
    await page.goto(dealerUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs }).catch(() => {})
    // Wait for eDealer widget JS to inject vehicles into the DOM / window scope
    await new Promise(r => setTimeout(r, 5000))

    const vehicles = await page.evaluate(() => {
      // 1. Window globals
      const GLOBALS = ['inventoryData', 'inventory', 'inventoryItems', 'vehicles',
                       'inventoryList', 'vehicleData', 'allVehicles']
      for (const g of GLOBALS) {
        const val = window[g]
        const arr = Array.isArray(val) ? val
          : Array.isArray(val?.vehicles) ? val.vehicles
          : Array.isArray(val?.inventory) ? val.inventory
          : Array.isArray(val?.items) ? val.items
          : null
        if (arr && arr.length && (arr[0]?.VIN || arr[0]?.vin)) return arr
      }
      // 2. DOM card scraping — [data-vin] elements rendered by eDealer widget
      const cards = document.querySelectorAll('[data-vin],[data-vehicle-vin]')
      if (cards.length) {
        const out = []
        for (const el of cards) {
          const vin = el.dataset.vin || el.dataset.vehicleVin
          if (!vin) continue
          const priceText = el.querySelector('.price,[class*="price"]')?.textContent || ''
          const price = parseInt(priceText.replace(/[^0-9]/g, ''), 10) || 0
          const mileageText = el.querySelector('[class*="mileage"],[class*="odometer"]')?.textContent || ''
          const mileage = parseInt(mileageText.replace(/[^0-9]/g, ''), 10) || 0
          const imgSrc = el.querySelector('img[src]')?.src || null
          const href = el.querySelector('a[href]')?.href || null
          out.push({
            VIN: vin, vin,
            year: el.dataset.year || null,
            make: el.dataset.make || null,
            model: el.dataset.model || null,
            trim: el.dataset.trim || null,
            StockNumber: el.dataset.stock || el.dataset.stocknumber || null,
            stocknumber: el.dataset.stock || el.dataset.stocknumber || null,
            condition: el.dataset.condition || null,
            price, saleprice: price, mileage,
            image_urls: imgSrc ? [imgSrc] : [],
            vdp_url: href
          })
        }
        if (out.length) return out
      }
      return []
    })

    if (!vehicles || !vehicles.length) {
      return { success: false, error: 'No vehicles found in DOM after render', source_url: dealerUrl }
    }
    return { success: true, vehicles, source_url: dealerUrl }
  } catch (e) {
    return { success: false, error: e.message, source_url: dealerUrl }
  } finally {
    if (page) { try { await page.close() } catch {} }
  }
}

// Apply a saved template to a fresh vehicle. Returns the full URL or null if any
// required placeholder can't be filled.
export function renderUrlTemplate(template, vehicle) {
  if (!template || typeof template !== 'string') return null
  const fields = readVehicleFields(vehicle)
  if (!fields.stock && !fields.vin) return null  // can't disambiguate

  const sub = {
    '{stock}': fields.stock || '',
    '{vin}': fields.vin || '',
    '{year}': fields.year || '',
    '{make}': fields.make || '',
    '{make_slug}': slugify(fields.make),
    '{model}': fields.model || '',
    '{model_slug}': slugify(fields.model),
    '{condition}': fields.condition || '',
    '{condition_lower}': String(fields.condition || '').toLowerCase()
  }

  let url = template
  for (const [ph, value] of Object.entries(sub)) {
    url = url.split(ph).join(encodeURIComponent(value))
    // For non-encoded slots (slugs, lowercased) the value is already URL-safe,
    // but encodeURIComponent on already-safe strings is a no-op. Keep it.
  }

  // If any placeholders remain unfilled, the template can't render → return null
  if (url.includes('{')) return null
  return url
}

// Map a raw vehicle from any platform to the canonical shape the sync engine expects.
// Field-name heuristics — covers UX Auto (sale_price/stock_id/ext_color), Dealer.com
// (modelYear/finalPrice/stockNumber), generic camelCase, and snake_case.
export function genericMapVehicle(v) {
  const pick = (...keys) => {
    for (const k of keys) {
      if (v[k] != null && v[k] !== '') return v[k]
    }
    return null
  }
  const s3Key = pick('s3_key', 's3Key')
  const imageUrl = pick('image_url', 'imageUrl', 'photo', 'photoUrl')
  return {
    vin: pick('vin', 'VIN', 'Vin'),
    year: pick('year', 'Year', 'modelYear', 'vehicleModelDate'),
    make: pick('make', 'Make', 'manufacturer'),
    model: pick('model', 'Model'),
    trim: pick('trim', 'Trim', 'trimLevel'),
    price: pick('sale_price', 'salePrice', 'price', 'Price', 'finalPrice', 'sellingPrice', 'list_price', 'listPrice', 'retail_price'),
    mileage: pick('mileage', 'Mileage', 'odometer'),
    condition: pick('condition', 'Condition', 'type', 'newOrUsed'),
    stocknumber: pick('stock_id', 'stockNumber', 'StockNumber', 'stock_number', 'stock', 'sku'),
    exteriorcolor: pick('ext_color', 'exteriorColor', 'exterior_color', 'ExteriorColor', 'ExteriorColour', 'color'),
    interiorcolor: pick('int_color', 'interiorColor', 'interior_color', 'vehicleInteriorColor'),
    bodystyle: pick('body_type', 'bodyType', 'body_style', 'bodyStyle'),
    fueltype: pick('fuel_type', 'fuelType'),
    transmission: pick('transmission', 'vehicleTransmission'),
    drivetrain: pick('drivetrain', 'driveTrain', 'drive_train'),
    lot_date: resolveLotDate(v),
    onweb: v.active !== 'n' && v.active !== false,
    salepending: false,
    image_urls: s3Key
      ? [`https://d3ls4jww1dnhu4.cloudfront.net/${s3Key}`]
      : imageUrl ? [imageUrl]
      : (Array.isArray(v.images) ? v.images : [])
  }
}
