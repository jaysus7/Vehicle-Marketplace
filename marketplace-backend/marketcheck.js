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
 * Fetch aggregated market stats for a vehicle.
 * Returns a summary shaped like the scraper's summarise() output, or null.
 */
export async function marketcheckMarket({ make, model, year, trim, mileage, postalCode, province, isUS }) {
  const key = process.env.MARKETCHECK_API_KEY
  if (!key || !make || !model || !year) return null

  // US and Canada are separate datasets/paths on MarketCheck.
  const path = isUS ? '/search/car/active' : '/search/car/ca/active'
  const params = new URLSearchParams({
    api_key: key,
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
