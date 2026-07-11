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

// A reliable market read needs at least this many clean, trim-matched comps.
// Below this we return null (the UI shows "not enough data") rather than invent a
// value off 1–2 noisy Canadian listings — which produced absurd numbers before
// (a 2019 Corvette "median" of $7k, or $99k off a single mispriced listing).
const MIN_COMPS = 3

/**
 * Robust market value for a vehicle, computed from actual comparable listings
 * (not MarketCheck's raw stats, which get dragged around by payment/placeholder/
 * salvage prices in thin Canadian samples). We trim-match, drop price outliers,
 * and require a minimum number of clean comps. Returns null when we can't value
 * it reliably. Also returns the clean `listings` for the appraisal charts.
 */
// Canonicalise the many ways a drivetrain is written (AWD / All Wheel Drive /
// 4x4 / Front Wheel Drive / 4MATIC …) into one of AWD / 4WD / FWD / RWD so we can
// match the subject vehicle against comp listings reliably.
export function normalizeDrivetrain(v) {
  const s = String(v || '').toUpperCase()
  if (!s) return null
  if (/\bAWD\b|ALL[\s-]?WHEEL|4MATIC|QUATTRO|XDRIVE|ALL4/.test(s)) return 'AWD'
  if (/\b4WD\b|4X4|FOUR[\s-]?WHEEL|4-WHEEL/.test(s)) return '4WD'
  if (/\bFWD\b|FRONT[\s-]?WHEEL|4X2|2WD/.test(s)) return 'FWD'
  if (/\bRWD\b|REAR[\s-]?WHEEL/.test(s)) return 'RWD'
  return null
}

// Pull a litre displacement out of an engine string ("3.5L V6", "5.3L", "2.0T").
export function engineLitres(v) {
  const m = String(v || '').match(/(\d\.\d)\s*L?/i)
  return m ? parseFloat(m[1]) : null
}

export async function marketcheckMarket({ make, model, year, trim, mileage, drivetrain, engine, zip, radius, isUS = false } = {}) {
  const key = process.env.MARKETCHECK_API_KEY
  if (!key || !make || !model || !year) return null

  const wantDrive = normalizeDrivetrain(drivetrain)
  const wantLitres = engineLitres(engine)
  const cleanZip = String(zip || '').replace(/\s+/g, '').toUpperCase() || null
  const rad = Number(radius) > 0 ? Math.round(Number(radius)) : null

  // One fetch with a given set of filters. geo/drivetrain/trim can each be turned
  // off so the caller can relax them when a tighter query comes back too thin.
  const fetchListings = async ({ withTrim, withDrive, withGeo }) => {
    const p = new URLSearchParams({
      api_key: key, country: isUS ? 'us' : 'ca', car_type: 'used',
      make: String(make), model: String(model), year: String(year),
      rows: '50', sort_by: 'price', sort_order: 'asc',
    })
    if (withTrim && trim) p.set('trim', String(trim))
    if (withDrive && wantDrive) p.set('drivetrain', wantDrive)
    if (withGeo && cleanZip && rad) { p.set('zip', cleanZip); p.set('radius', String(rad)) }
    try {
      const r = await fetch(`${BASE}/search/car/active?${p.toString()}`, {
        headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(12000),
      })
      if (!r.ok) { console.error(`[marketcheck] HTTP ${r.status} ${isUS ? 'US' : 'CA'} ${make} ${model} ${year}`); return null }
      const j = await r.json()
      const raw = Array.isArray(j?.listings) ? j.listings : []
      return {
        num_found: Number(j?.num_found ?? raw.length),
        listings: raw.map(l => ({
          price: Number(l.price ?? 0), miles: Number(l.miles ?? 0),
          city: l.dealer?.city || null, region: l.dealer?.state || null, dealer: l.dealer?.name || null,
          dist: (l.dist != null ? Number(l.dist) : null),
          // The live listing's detail page + the site it's on (dealer site / AutoTrader
          // / CarGurus, whatever MarketCheck aggregated it from) so reps can click through.
          vdp_url: l.vdp_url || l.href || null,
          source: l.source || null,
          year: l.build?.year ?? null, trim: l.build?.trim || null,
          drivetrain: normalizeDrivetrain(l.build?.drivetrain),
          engine: l.build?.engine || null,
          litres: (l.build?.engine_size != null ? Number(l.build.engine_size) : engineLitres(l.build?.engine)),
        })),
      }
    } catch (e) { console.error('[marketcheck] request failed:', e.message); return null }
  }

  // Comp-selection cascade: start as tight as the data we were given (trim +
  // drivetrain + local radius), then relax one constraint at a time only when the
  // tighter query can't field enough clean comps. Accuracy where data is rich,
  // coverage where it's thin — never mixing trims/drivetrains just to pad a result.
  const priced = (res) => (res?.listings || []).filter(l => l.price >= 2500)
  const attempts = [
    { withTrim: true,  withDrive: true,  withGeo: true,  applied: { trim: !!trim, drivetrain: !!wantDrive, geo: !!(cleanZip && rad) } },
    { withTrim: true,  withDrive: true,  withGeo: false, applied: { trim: !!trim, drivetrain: !!wantDrive, geo: false } },
    { withTrim: true,  withDrive: false, withGeo: false, applied: { trim: !!trim, drivetrain: false, geo: false } },
    { withTrim: false, withDrive: false, withGeo: false, applied: { trim: false, drivetrain: false, geo: false } },
  ]
  let res = null, applied = null
  const seenKeys = new Set()
  for (const a of attempts) {
    // Effective query — skip attempts identical to one we already ran (e.g. there's
    // no drivetrain/geo to drop, so relaxing them changes nothing).
    const key = [a.withTrim && trim ? 't' : '', a.withDrive && wantDrive ? 'd' : '', a.withGeo && cleanZip && rad ? 'g' : ''].join('|')
    if (seenKeys.has(key)) continue
    seenKeys.add(key)
    const cand = await fetchListings(a)
    if (!cand) continue
    const pc = priced(cand).length
    if (pc >= MIN_COMPS) { res = cand; applied = a.applied; break }
    // Keep the widest partial result as a floor in case nothing clears the bar.
    if (!res || pc > (res._pc || 0)) { res = cand; res._pc = pc; applied = a.applied }
  }
  if (!res) return null

  // Engine displacement is unreliable as a search param, so filter it here from the
  // listing's decoded build — but only if it leaves us enough comps (else ignore it).
  let workingList = res.listings
  if (wantLitres) {
    const sameEngine = workingList.filter(l => l.litres != null && Math.abs(l.litres - wantLitres) <= 0.3)
    if (sameEngine.filter(l => l.price >= 2500).length >= MIN_COMPS) {
      workingList = sameEngine
      applied = { ...applied, engine: true }
    }
  }

  // Drop obvious junk (payment/placeholder/salvage) before finding the center.
  let prices = workingList.map(l => l.price).filter(p => p >= 2500).sort((a, b) => a - b)
  console.log(`[marketcheck] ${make} ${model} ${year} ${isUS ? 'US' : 'CA'} raw=${workingList.length} priced=${prices.length} applied=${JSON.stringify(applied)}`)
  if (prices.length < MIN_COMPS) return null

  // Outlier band around the raw median removes remaining low junk and high
  // wrong-trim/loaded outliers, then we recompute on the clean set.
  const med0 = prices[Math.floor(prices.length / 2)]
  const inBand = (p) => p >= med0 * 0.5 && p <= med0 * 1.8
  const clean = prices.filter(inBand)
  if (clean.length < MIN_COMPS) return null

  const median = clean[Math.floor(clean.length / 2)]
  const avg = Math.round(clean.reduce((a, b) => a + b, 0) / clean.length)
  const cleanListings = workingList.filter(l => inBand(l.price))
  const miles = workingList.map(l => l.miles).filter(m => m > 0).sort((a, b) => a - b)
  const dists = cleanListings.map(l => l.dist).filter(d => d != null && d >= 0).sort((a, b) => a - b)

  return {
    source: 'MarketCheck',
    count: clean.length,
    num_found: res.num_found,
    median_price: median,
    avg_price: avg,
    low_price: clean[Math.max(0, Math.floor(clean.length * 0.1))],
    high_price: clean[Math.min(clean.length - 1, Math.max(0, Math.ceil(clean.length * 0.9) - 1))],
    min_price: clean[0],
    max_price: clean[clean.length - 1],
    avg_mileage: miles.length ? Math.round(miles.reduce((a, b) => a + b, 0) / miles.length) : null,
    median_mileage: miles.length ? miles[Math.floor(miles.length / 2)] : null,
    // Which of the requested filters actually shaped this comp set (for the UI).
    matched_on: applied || {},
    radius_used: (applied?.geo && rad) ? rad : null,
    median_distance: dists.length ? dists[Math.floor(dists.length / 2)] : null,
    max_distance: dists.length ? dists[dists.length - 1] : null,
    listings: cleanListings,
  }
}

/**
 * Fetch actual comparable listings (not just stats) with price, mileage and
 * location — used to draw the appraisal PDF's price-distribution chart and the
 * "where these comps are" map/breakdown. Returns { count, listings:[{price,
 * miles, city, region, dealer}] } or null. Broadens like marketcheckMarket.
 */
export async function marketcheckListings({ make, model, year, trim, mileage, isUS = false, rows = 50 } = {}) {
  const key = process.env.MARKETCHECK_API_KEY
  if (!key || !make || !model || !year) return null
  const path = '/search/car/active'
  const base = () => {
    const p = new URLSearchParams({
      api_key: key, country: isUS ? 'us' : 'ca', car_type: 'used',
      make: String(make), model: String(model), year: String(year),
      rows: String(rows), sort_by: 'price', sort_order: 'asc',
    })
    if (trim) p.set('trim', String(trim))
    return p
  }
  const attempts = [
    (() => { const p = base(); if (mileage > 0) p.set('miles_range', `${Math.round(mileage * 0.6)}-${Math.round(mileage * 1.4)}`); return p })(),
    (() => { const p = base(); return p })(),
    (() => { const p = base(); p.delete('trim'); return p })(),
  ]
  for (const p of attempts) {
    try {
      const r = await fetch(`${BASE}${path}?${p.toString()}`, {
        headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(12000),
      })
      if (!r.ok) continue
      const j = await r.json()
      const raw = Array.isArray(j?.listings) ? j.listings : []
      const listings = raw.map(l => ({
        price: Number(l.price ?? 0),
        miles: Number(l.miles ?? 0),
        city: (l.dealer?.city || null),
        region: (l.dealer?.state || null),
        dealer: (l.dealer?.name || null),
      })).filter(l => l.price > 1000)
      if (listings.length) return { count: Number(j?.num_found ?? listings.length), listings }
    } catch { /* try next */ }
  }
  return null
}

/**
 * Full spec sheet for a VIN via MarketCheck's neovin decode (recipe 01) — richer
 * than the free NHTSA decode (trim, options, engine, fuel economy, MSRP). One
 * metered call. Returns the raw specs object, or null on any failure so callers
 * fall back to NHTSA.
 */
export async function marketcheckDecodeVin(vin) {
  const key = process.env.MARKETCHECK_API_KEY
  const v = String(vin || '').trim().toUpperCase()
  if (!key || v.length !== 17) return null
  try {
    const r = await fetch(`${BASE}/decode/car/neovin/${encodeURIComponent(v)}/specs?api_key=${encodeURIComponent(key)}`, {
      headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(12000),
    })
    if (!r.ok) return null
    const j = await r.json()
    return (j && typeof j === 'object' && Object.keys(j).length) ? j : null
  } catch { return null }
}

/**
 * Model-comparable predicted price + confidence band for a VIN (recipe 04). One
 * metered call. Returns { predicted, low, high, confidence } or null.
 */
export async function marketcheckPredictPrice({ vin, miles } = {}) {
  const key = process.env.MARKETCHECK_API_KEY
  const v = String(vin || '').trim().toUpperCase()
  if (!key || v.length !== 17) return null
  try {
    const p = new URLSearchParams({ api_key: key, vin: v, car_type: 'used' })
    if (miles != null && Number(miles) > 0) p.set('miles', String(Math.round(Number(miles))))
    const r = await fetch(`${BASE}/predict/car/price?${p.toString()}`, {
      headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(12000),
    })
    if (!r.ok) return null
    const j = await r.json()
    // MarketCheck returns a predicted price and (on most plans) a confidence band.
    const predicted = Number(j?.predicted_price ?? j?.price ?? j?.mean_price)
    if (!Number.isFinite(predicted) || predicted <= 0) return null
    const low = Number(j?.price_range?.low ?? j?.low_price ?? j?.min_price)
    const high = Number(j?.price_range?.high ?? j?.high_price ?? j?.max_price)
    return {
      predicted: Math.round(predicted),
      low: Number.isFinite(low) && low > 0 ? Math.round(low) : null,
      high: Number.isFinite(high) && high > 0 ? Math.round(high) : null,
      confidence: j?.confidence ?? j?.confidence_level ?? null,
    }
  } catch { return null }
}

/**
 * Market snapshot for a make/model in a market (recipe 05): count, price and
 * days-on-market aggregates. One metered call. Returns
 * { count, price:{median,mean,min,max}, dom:{median,mean}, miles:{median} } or null.
 */
export async function marketcheckMarketStats({ make, model, year, trim, zip, radius, isUS = false } = {}) {
  const key = process.env.MARKETCHECK_API_KEY
  if (!key || !make || !model) return null
  try {
    const p = new URLSearchParams({
      api_key: key, country: isUS ? 'us' : 'ca', car_type: 'used',
      rows: '0', stats: 'price,dom,miles',
      make: String(make), model: String(model),
    })
    if (year) p.set('year', String(year))
    if (trim) p.set('trim', String(trim))
    if (zip) { p.set('zip', String(zip)); p.set('radius', String(radius || 100)) }
    const r = await fetch(`${BASE}/search/car/active?${p.toString()}`, {
      headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(12000),
    })
    if (!r.ok) return null
    const j = await r.json()
    const s = j?.stats || {}
    const pick = o => (o && typeof o === 'object')
      ? { median: o.median ?? null, mean: o.mean ?? null, min: o.min ?? null, max: o.max ?? null } : null
    const count = Number(j?.num_found ?? 0)
    if (!count) return null
    return { count, price: pick(s.price), dom: pick(s.dom), miles: pick(s.miles) }
  } catch { return null }
}
