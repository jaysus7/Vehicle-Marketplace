/**
 * MarketCheck — licensed real-time market data (the same class of data vAuto uses).
 *
 * We hit the active-listings search endpoint with `stats=price,miles`, which returns
 * aggregated price/mileage statistics (count, mean, median, min, max, stddev) for the
 * exact year/make/model/trim in one call — no HTML scraping, no bot blocks. This is the
 * accurate, dealer-grade source; the AutoTrader/CarGurus scraper stays as the fallback
 * for when no MarketCheck key is set or a query returns nothing.
 *
 * Set MARKETCHECK_API_KEY in the environment to enable it. Without the key this module
 * is a no-op and callers fall back to the scraper.
 *
 * Docs: https://apidocs.marketcheck.com/
 */

const BASE = 'https://mc-api.marketcheck.com/v2'

export function marketcheckEnabled() {
  return !!process.env.MARKETCHECK_API_KEY
}

/**
 * Health check — verifies the key is set AND actually works against the API.
 * Returns { configured, ok, sample_found?, status?, error? }.
 */
export async function marketcheckPing() {
  if (!process.env.MARKETCHECK_API_KEY) return { configured: false, ok: false }
  try {
    const params = new URLSearchParams({
      api_key: process.env.MARKETCHECK_API_KEY,
      rows: '0', car_type: 'used', make: 'Chevrolet', model: 'Silverado', stats: 'price',
    })
    const r = await fetch(`${BASE}/search/car/active?${params.toString()}`, {
      headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10000),
    })
    if (!r.ok) return { configured: true, ok: false, status: r.status }
    const j = await r.json()
    return { configured: true, ok: true, sample_found: Number(j?.num_found ?? 0) }
  } catch (e) {
    return { configured: true, ok: false, error: e.message }
  }
}

/**
 * Competitor lot stats from MarketCheck — reliable, no scraping, no Cloudflare.
 * MarketCheck tags every listing with its `source` (the dealer's website domain),
 * so we map a competitor's URL → domain → their active listings + price stats.
 * Returns { listing_count, avg_price, min_price, max_price, platform } or null.
 */
export async function marketcheckCompetitorStats({ url, isUS }) {
  const key = process.env.MARKETCHECK_API_KEY
  if (!key || !url) return null
  let domain = ''
  try { domain = new URL(url).hostname.replace(/^www\./i, '').toLowerCase() } catch { return null }
  if (!domain) return null

  const path = '/search/car/active'
  const params = new URLSearchParams({ api_key: key, country: isUS ? 'us' : 'ca', source: domain, stats: 'price', rows: '0' })
  try {
    const r = await fetch(`${BASE}${path}?${params.toString()}`, {
      headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(12000),
    })
    if (!r.ok) { console.error('[marketcheck] competitor HTTP', r.status, domain); return null }
    const j = await r.json()
    const count = Number(j?.num_found ?? 0)
    if (!count) return null
    const p = j?.stats?.price || {}
    return {
      listing_count: count,
      avg_price: p.mean ? Math.round(p.mean) : (p.median ? Math.round(p.median) : null),
      min_price: p.min ? Math.round(p.min) : null,
      max_price: p.max ? Math.round(p.max) : null,
      platform: 'MarketCheck',
      method: 'marketcheck',
      scanned_at: new Date().toISOString(),
    }
  } catch (e) {
    console.error('[marketcheck] competitor lookup failed:', e.message)
    return null
  }
}

/**
 * Fetch aggregated market stats for a vehicle.
 * Returns a summary shaped like the scraper's summarise() output, or null.
 */
export async function marketcheckMarket({ make, model, year, trim, mileage, postalCode, province, isUS }) {
  const key = process.env.MARKETCHECK_API_KEY
  if (!key || !make || !model || !year) return null

  // One active-listings endpoint for both markets; `country` selects US vs Canada.
  // (The /search/car/ca/active path 404s — Canada is served via country=ca here.)
  const path = '/search/car/active'
  const params = new URLSearchParams({
    api_key: key,
    country: isUS ? 'us' : 'ca',
    car_type: 'used',
    make: String(make),
    model: String(model),
    year: String(year),
    stats: 'price,miles',
    rows: '0', // we only need the aggregate stats, not the listing bodies
  })
  if (trim) params.set('trim', String(trim))
  // Radius search around the dealer's postal/ZIP when we have one.
  const zip = (postalCode || '').replace(/\s+/g, '')
  if (zip) { params.set('zip', zip); params.set('radius', '250') }
  // Constrain comps to a comparable mileage window (±40%) so a 200k-km car isn't
  // averaged against 20k-km ones.
  if (mileage && mileage > 0) {
    params.set('miles_range', `${Math.round(mileage * 0.6)}-${Math.round(mileage * 1.4)}`)
  }

  let json
  try {
    const r = await fetch(`${BASE}${path}?${params.toString()}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(12000),
    })
    if (!r.ok) {
      console.error('[marketcheck] HTTP', r.status, isUS ? 'US' : 'CA')
      return null
    }
    json = await r.json()
  } catch (e) {
    console.error('[marketcheck] request failed:', e.message)
    return null
  }

  let numFound = Number(json?.num_found ?? 0)
  let price = json?.stats?.price
  let miles = json?.stats?.miles

  // If a tight trim+mileage query returned nothing, retry once without the mileage
  // window (broader but still same trim) so thin segments still get a number.
  if ((!numFound || !price?.median) && (mileage || trim)) {
    const retry = new URLSearchParams(params)
    retry.delete('miles_range')
    try {
      const r2 = await fetch(`${BASE}${path}?${retry.toString()}`, {
        headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(12000),
      })
      if (r2.ok) {
        const j2 = await r2.json()
        if (Number(j2?.num_found ?? 0) > 0 && j2?.stats?.price?.median) {
          numFound = Number(j2.num_found); price = j2.stats.price; miles = j2.stats.miles
        }
      }
    } catch {}
  }

  if (!numFound || !price) return null
  const median = Math.round(price.median ?? price.mean ?? 0)
  if (!median) return null

  const sd = Number(price.standard_deviation ?? 0)
  const low = Math.round(price.min && price.min > median * 0.4 ? Math.max(price.min, median - (sd ? sd * 0.8 : median * 0.12)) : median - (sd ? sd * 0.8 : median * 0.12))
  const high = Math.round(price.max && price.max < median * 2.5 ? Math.min(price.max, median + (sd ? sd * 0.8 : median * 0.12)) : median + (sd ? sd * 0.8 : median * 0.12))

  return {
    source: 'MarketCheck',
    count: numFound,
    avg_price: Math.round(price.mean ?? median),
    median_price: median,
    low_price: Math.max(1, low),
    high_price: Math.max(median + 1, high),
    min_price: price.min ? Math.round(price.min) : null,
    max_price: price.max ? Math.round(price.max) : null,
    avg_mileage: miles ? Math.round(miles.mean ?? miles.median ?? 0) || null : null,
    median_mileage: miles ? Math.round(miles.median ?? miles.mean ?? 0) || null : null,
  }
}
