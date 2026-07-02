/**
 * Market data scraper — AutoTrader Canada & CarGurus Canada (or .com for US).
 *
 * Both sites embed listing JSON in their HTML pages; we parse it out.
 * If a scrape fails for any reason the caller falls back to the AI estimate
 * and we fire an alert email so the failure is visible.
 *
 * NOTE: These sites do not provide official APIs for this use. Page structure
 * can change without notice; keep an eye on the alert emails.
 */

import { browserFetch, resend, EMAIL_FROM } from './shared.js'

const ALERT_TO = 'noreply@marketsync.link'

// ── Alert email ────────────────────────────────────────────────────────────

export async function sendScrapeAlert({ source, vehicleLabel, error, url }) {
  if (!resend) return
  try {
    await resend.emails.send({
      from: EMAIL_FROM,
      to: ALERT_TO,
      subject: `Scrape failure: ${source} — ${vehicleLabel}`,
      html: `
        <p>The <strong>${source}</strong> scraper failed for <strong>${vehicleLabel}</strong>.</p>
        <p><strong>Error:</strong> ${String(error?.message || error)}</p>
        ${url ? `<p><strong>URL attempted:</strong> <code>${url}</code></p>` : ''}
        <p>The AI estimate fallback was used instead. Check if the site's page structure has changed.</p>
        <hr>
        <p style="color:#94a3b8;font-size:12px">MarketSync AI Boost — scraper monitor</p>
      `
    })
  } catch {}
}

// ── Helpers ────────────────────────────────────────────────────────────────

function median(arr) {
  if (!arr.length) return null
  const s = [...arr].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 !== 0 ? s[m] : (s[m - 1] + s[m]) / 2
}

function extractJsonFromScriptTag(html, patterns) {
  for (const pattern of patterns) {
    const match = html.match(pattern)
    if (match?.[1]) {
      try { return JSON.parse(match[1]) } catch {}
    }
  }
  return null
}

// Walk an object tree looking for arrays of objects that have both a price
// and a mileage field — used as a last-resort fallback parser.
function findListingArrays(obj, depth = 0) {
  if (depth > 8 || !obj || typeof obj !== 'object') return []
  if (Array.isArray(obj) && obj.length > 0) {
    const sample = obj[0]
    if (sample && typeof sample === 'object') {
      const keys = Object.keys(sample)
      const hasPrice = keys.some(k => /price|amount|msrp/i.test(k))
      const hasMileage = keys.some(k => /mileage|kilometre|kilometer|odometer|miles/i.test(k))
      if (hasPrice && hasMileage) return [obj]
    }
  }
  const results = []
  for (const val of Object.values(obj)) {
    results.push(...findListingArrays(val, depth + 1))
  }
  return results
}

// Parse a listing date string or unix timestamp into days-since-listed.
function parseDaysOnline(l) {
  // Direct numeric field (some sites return integer days directly)
  const direct = l.daysOnMarket ?? l.daysOnLot ?? l.daysListed ?? l.age ?? l.listingAge
  if (direct != null && !isNaN(Number(direct)) && Number(direct) >= 0) {
    return Math.round(Number(direct))
  }

  // Date-string fields — compute days from activation/posted date to today
  const raw =
    l.activationDate ?? l.postedDate ?? l.listingDate ?? l.createdDate ??
    l.datePosted ?? l.dateAdded ?? l.dateCreated ?? l.publishedDate ??
    l.firstSeen ?? l.dateFirstListed ?? l.listedDate ?? l.startDate ??
    l.created_at ?? l.created ?? l.date

  if (!raw) return null

  let ts
  if (typeof raw === 'number') {
    // Unix seconds or ms
    ts = raw > 1e10 ? raw : raw * 1000
  } else if (typeof raw === 'string') {
    ts = Date.parse(raw)
  }

  if (!ts || isNaN(ts)) return null
  const days = Math.round((Date.now() - ts) / 86400000)
  return days >= 0 && days < 3650 ? days : null // ignore bad dates
}

function normaliseListings(raw) {
  return raw
    .map(l => {
      // Try many common field name variants
      const price = Number(
        l.price ?? l.listPrice ?? l.askingPrice ?? l.displayPrice ?? l.amount ?? 0
      )
      const mileage = Number(
        l.mileage ?? l.kilometres ?? l.kilometers ?? l.odometer ??
        l.mileageKm ?? l.kms ?? l.miles ?? 0
      )
      const daysOnline = parseDaysOnline(l)
      return { price, mileage, daysOnline }
    })
    .filter(l => l.price > 1000 && l.mileage > 0)
}

function summarise(listings) {
  if (!listings.length) return null
  const prices = listings.map(l => l.price)
  const mileages = listings.map(l => l.mileage)

  // Only include listings where we have a real days-online value
  const withDays = listings.filter(l => l.daysOnline != null)
  const avgDaysOnline = withDays.length
    ? Math.round(withDays.reduce((a, b) => a + b.daysOnline, 0) / withDays.length)
    : null
  const medianDaysOnline = withDays.length ? Math.round(median(withDays.map(l => l.daysOnline))) : null

  return {
    count: listings.length,
    avg_price: Math.round(prices.reduce((a, b) => a + b, 0) / prices.length),
    median_price: Math.round(median(prices)),
    avg_mileage: Math.round(mileages.reduce((a, b) => a + b, 0) / mileages.length),
    median_mileage: Math.round(median(mileages)),
    min_price: Math.min(...prices),
    max_price: Math.max(...prices),
    avg_days_online: avgDaysOnline,
    median_days_online: medianDaysOnline,
    days_online_sample: withDays.length,
  }
}

// ── AutoTrader Canada / AutoTrader.com ─────────────────────────────────────

export async function scrapeAutoTrader({ make, model, year, trim, postalCode, province, isUS }) {
  const domain = isUS ? 'autotrader.com' : 'autotrader.ca'
  let url

  if (isUS) {
    const params = new URLSearchParams({
      zip: postalCode || '10001',
      startYear: year,
      endYear: year,
      makeCodeList: make.toUpperCase(),
      modelCodeList: model.toUpperCase(),
      ...(trim ? { trimCodeList: trim.toUpperCase() } : {}),
      searchRadius: 150,
      listingType: 'USED',
      numRecords: 25,
      firstRecord: 0,
    })
    url = `https://www.autotrader.com/cars-for-sale/used-cars/${encodeURIComponent(make.toLowerCase())}/${encodeURIComponent(model.toLowerCase())}/?${params}`
  } else {
    const prov = (province || 'on').toLowerCase()
    const params = new URLSearchParams({
      rcp: '25',
      rcs: '0',
      srt: '35',
      yRng: `${year},${year}`,
      mak: make,
      mdl: model,
      ...(trim ? { trim } : {}),
      prx: '150',
      ...(postalCode ? { loc: postalCode } : {}),
      sts: 'Used',
    })
    url = `https://www.autotrader.ca/cars/${prov}/?${params}`
  }

  const res = await browserFetch(url, {
    headers: { 'Accept-Language': isUS ? 'en-US,en;q=0.9' : 'en-CA,en;q=0.9' }
  })
  if (!res.ok) throw new Error(`AutoTrader HTTP ${res.status}`)
  const html = await res.text()

  // AutoTrader CA embeds data in __NEXT_DATA__; AT.com in window.__PRELOADED_STATE__ or __NEXT_DATA__
  const data = extractJsonFromScriptTag(html, [
    /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/,
    /window\.__NEXT_DATA__\s*=\s*({[\s\S]*?});\s*<\/script>/,
    /window\.__PRELOADED_STATE__\s*=\s*({[\s\S]*?});\s*<\/script>/,
    /<script type="application\/json" data-id="listing-results">([\s\S]*?)<\/script>/,
  ])

  if (!data) throw new Error('AutoTrader: could not parse page JSON')

  // Try known path first, then walk tree
  const knownPaths = [
    data?.props?.pageProps?.searchResults?.listings,
    data?.props?.pageProps?.listings,
    data?.props?.pageProps?.initialState?.srp?.listings,
    data?.initialState?.srp?.listings,
    data?.listings,
  ].filter(Boolean)

  let raw = []
  for (const p of knownPaths) {
    if (Array.isArray(p) && p.length) { raw = p; break }
  }

  if (!raw.length) {
    const arrays = findListingArrays(data)
    raw = arrays[0] || []
  }

  const listings = normaliseListings(raw)
  if (!listings.length) throw new Error('AutoTrader: no usable listings parsed')

  return { source: isUS ? 'AutoTrader.com' : 'AutoTrader Canada', ...summarise(listings), listings }
}

// ── CarGurus Canada / CarGurus.com ─────────────────────────────────────────

export async function scrapeCarGurus({ make, model, year, trim, postalCode, province, isUS }) {
  const domain = isUS ? 'cargurus.com' : 'cargurus.ca'
  // CarGurus uses zip/postal for radius search
  const zip = postalCode || (isUS ? '10001' : 'M5V 3A8')

  // CarGurus search URL — they accept zip + free-text params
  const params = new URLSearchParams({
    zip,
    showNegotiable: 'true',
    sortDir: 'ASC',
    sortType: 'PRICE',
    trim: trim || '',
    // CarGurus uses entity IDs internally; the plain search URL still works for HTML scraping
  })

  // CarGurus search URLs include make/model in the path slug
  const makeSlug = encodeURIComponent(make.toLowerCase().replace(/\s+/g, '-'))
  const modelSlug = encodeURIComponent(model.toLowerCase().replace(/\s+/g, '-'))
  const url = `https://www.${domain}/Cars/l-Used-${make}-${model}-d0#listing=eyJzb3J0VHlwZSI6IlBSSUNFIiwic29ydERpciI6IkFTQyIsImxpc3RpbmdUeXBlIjoiVVNFRCIsInppcCI6IiR7emlwfSIsInllYXJNaW4iOiR7eWVhcn0sInllYXJNYXgiOiR7eWVhcn19`

  // CarGurus also exposes a JSON-returning search endpoint used by their own frontend
  const apiUrl = `https://www.${domain}/Cars/searchResults.action?zip=${encodeURIComponent(zip)}&trim=${encodeURIComponent(trim || '')}&startYear=${year}&endYear=${year}&entitySelectingHelper.selectedEntity.seoType=D&entitySelectingHelper.selectedEntity.makeModelSubfilterType=MAKE_MODEL_TRIM&sortType=PRICE&sortDir=ASC&maxResults=25&offset=0&includePrivateSellers=true&searchId=&isDepressionBanner=false&isFiltered=false&nonShippable=false&isMobile=false&searchView=LIST&feedbackIsOpen=false`

  let html = ''
  let usedUrl = apiUrl
  try {
    const res = await browserFetch(apiUrl, {
      headers: {
        'Accept': 'application/json, text/html, */*',
        'X-Requested-With': 'XMLHttpRequest',
        'Referer': `https://www.${domain}/`
      }
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    html = await res.text()
  } catch {
    // Fall back to the main search page
    usedUrl = `https://www.${domain}/Cars/l-Used-${encodeURIComponent(make)}-${encodeURIComponent(model)}/?zip=${zip}&trim=${encodeURIComponent(trim || '')}&startYear=${year}&endYear=${year}&maxResults=25`
    const res2 = await browserFetch(usedUrl)
    if (!res2.ok) throw new Error(`CarGurus HTTP ${res2.status}`)
    html = await res2.text()
  }

  // CarGurus embeds data in window.prefetchedData, window.CarGurus, or __NEXT_DATA__
  let data = null

  // Try direct JSON parse first (if searchResults.action returned JSON)
  try { data = JSON.parse(html) } catch {}

  if (!data) {
    data = extractJsonFromScriptTag(html, [
      /window\.prefetchedData\s*=\s*({[\s\S]*?});\s*(?:window|<\/script>)/,
      /window\._cg_app_config\s*=\s*({[\s\S]*?});\s*<\/script>/,
      /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/,
      /window\.__CarGurus_Listings__\s*=\s*({[\s\S]*?});\s*<\/script>/,
      /"listings"\s*:\s*(\[[\s\S]*?\])\s*,\s*"(?:total|count|numListings)"/,
    ])
  }

  if (!data) throw new Error('CarGurus: could not parse page data')

  // Try known paths
  const knownPaths = [
    data?.listings,
    data?.searchResults?.listings,
    data?.props?.pageProps?.searchResults?.listings,
    data?.initialState?.listings,
    data?.data?.listings,
  ].filter(Boolean)

  let raw = []
  for (const p of knownPaths) {
    if (Array.isArray(p) && p.length) { raw = p; break }
  }

  if (!raw.length) {
    // Walk for listing arrays
    const arrays = findListingArrays(data)
    raw = arrays[0] || []
  }

  const listings = normaliseListings(raw)
  if (!listings.length) throw new Error('CarGurus: no usable listings parsed')

  return { source: isUS ? 'CarGurus.com' : 'CarGurus Canada', ...summarise(listings), listings }
}

// ── Copart Canada ──────────────────────────────────────────────────────────

/**
 * Scrape Copart Canada public auction listings for a given vehicle.
 * Copart's search API is called by their own frontend and returns JSON
 * without requiring authentication for public lot data.
 *
 * NOTE: These are salvage/insurance-write-off vehicles. Results are clearly
 * labelled as auction/salvage reference data, NOT retail comparables.
 */
export async function scrapeCopart({ make, model, year, trim, province, isUS }) {
  if (isUS) throw new Error('Copart: US not enabled yet')

  // Copart public search endpoint (used by their SPA frontend)
  const body = {
    query: ['*'],
    filter: {
      MAKE: [make.toUpperCase()],
      MODEL: [model.toUpperCase()],
      YEAR: [`${year}`],
      COUNTRY: ['CA'],
    },
    sort: ['auction_date_type desc'],
    page: 0,
    size: 25,
    start: 0,
    watchListOnly: false,
    searchCopartOnly: false,
  }

  const res = await browserFetch('https://www.copart.com/public/lots/search-results', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Referer': 'https://www.copart.com/',
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`Copart HTTP ${res.status}`)

  const json = await res.json()

  // Copart wraps results under data.results.content
  const content = json?.data?.results?.content || json?.returnCode === 'SUCCESS' && json?.data?.results?.content || []
  if (!content.length) throw new Error('Copart: no results in response')

  const listings = content
    .map(l => {
      const price = Number(l.fv ?? l.bid ?? l.currentBid ?? l.actualCashValue ?? l.lv ?? 0)
      const mileage = Number(l.od ?? l.orr ?? l.mileage ?? 0)
      const daysOnline = parseDaysOnline(l)
      return { price, mileage, daysOnline }
    })
    .filter(l => l.price > 500 && l.mileage > 0)

  if (!listings.length) throw new Error('Copart: no usable listings after normalisation')

  const summary = summarise(listings)
  return {
    source: 'Copart Canada (auction/salvage)',
    isSalvage: true,
    ...summary,
    listings,
  }
}

// ── Main entry point ────────────────────────────────────────────────────────

/**
 * Scrape market data from AutoTrader, CarGurus, and Copart Canada.
 * Returns { autotrader, cargurus, copart } — any may be null if scraping failed.
 * Sends alert email for each retail scrape failure (Copart failure is silent).
 */
export async function scrapeMarketData({ make, model, year, trim, postalCode, province, city, isUS, vehicleLabel }) {
  const opts = { make, model, year, trim, postalCode, province, isUS }
  const label = vehicleLabel || `${year} ${make} ${model}${trim ? ' ' + trim : ''}`

  const [atResult, cgResult, copartResult] = await Promise.allSettled([
    scrapeAutoTrader(opts),
    scrapeCarGurus(opts),
    scrapeCopart(opts),
  ])

  let autotrader = null
  let cargurus = null
  let copart = null

  if (atResult.status === 'fulfilled') {
    autotrader = atResult.value
  } else {
    console.error('[scraper] AutoTrader failed:', atResult.reason?.message)
    sendScrapeAlert({ source: 'AutoTrader', vehicleLabel: label, error: atResult.reason })
  }

  if (cgResult.status === 'fulfilled') {
    cargurus = cgResult.value
  } else {
    console.error('[scraper] CarGurus failed:', cgResult.reason?.message)
    sendScrapeAlert({ source: 'CarGurus', vehicleLabel: label, error: cgResult.reason })
  }

  if (copartResult.status === 'fulfilled') {
    copart = copartResult.value
  } else {
    // Copart is reference data only — log but don't alert
    console.error('[scraper] Copart failed:', copartResult.reason?.message)
  }

  return { autotrader, cargurus, copart }
}
