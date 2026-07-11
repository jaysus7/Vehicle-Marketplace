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

// Geocode a postal/ZIP to lat/long. MarketCheck's `zip` filter only understands US
// ZIP codes — Canadian postal codes are silently ignored, so a CA "radius" search
// returns NATIONAL results. For CA we must pass latitude/longitude instead. Uses
// OpenStreetMap Nominatim (free, no key), cached in-memory per process.
const _geoCache = new Map()
async function geocodePostal(postal, isUS) {
  const clean = String(postal || '').trim().toUpperCase()
  if (!clean) return null
  if (_geoCache.has(clean)) return _geoCache.get(clean)
  try {
    const params = new URLSearchParams({
      postalcode: clean.replace(/\s+/g, ' '), country: isUS ? 'us' : 'ca', format: 'json', limit: '1',
    })
    const r = await fetch(`https://nominatim.openstreetmap.org/search?${params.toString()}`, {
      headers: { 'User-Agent': 'MarketSync/1.0 (vehicle appraisal comps)' },
      signal: AbortSignal.timeout(8000),
    })
    if (!r.ok) { _geoCache.set(clean, null); return null }
    const j = await r.json()
    const hit = (Array.isArray(j) && j[0]?.lat && j[0]?.lon)
      ? { lat: Number(j[0].lat), lon: Number(j[0].lon) } : null
    _geoCache.set(clean, hit)
    return hit
  } catch (e) {
    console.warn('[geocode] failed for', clean, e.message)
    _geoCache.set(clean, null)
    return null
  }
}

// The first letter of a Canadian postal code maps to a province/region — a reliable,
// offline way to scope comps when geocoding is unavailable. Returns a 2-letter code.
const CA_POSTAL_PROVINCE = {
  A: 'NL', B: 'NS', C: 'PE', E: 'NB', G: 'QC', H: 'QC', J: 'QC',
  K: 'ON', L: 'ON', M: 'ON', N: 'ON', P: 'ON', R: 'MB', S: 'SK',
  T: 'AB', V: 'BC', X: 'NT', Y: 'YT',
}
function provinceFromPostal(postal) {
  const c = String(postal || '').trim().toUpperCase()[0]
  return CA_POSTAL_PROVINCE[c] || null
}

export async function marketcheckMarket({ make, model, year, trim, mileage, drivetrain, engine, zip, radius, isUS = false } = {}) {
  const key = process.env.MARKETCHECK_API_KEY
  if (!key || !make || !model || !year) return null

  const wantDrive = normalizeDrivetrain(drivetrain)
  const wantLitres = engineLitres(engine)
  const cleanZip = String(zip || '').replace(/\s+/g, '').toUpperCase() || null
  const rad = Number(radius) > 0 ? Math.round(Number(radius)) : null

  // Resolve the geo filter once. US ZIP works natively; CA postal must be geocoded
  // to lat/long or MarketCheck ignores it and returns national comps.
  let geo = null
  if (cleanZip && rad) {
    if (isUS) geo = { zip: cleanZip }
    else {
      // Prefer a precise lat/long radius; if geocoding fails, fall back to the
      // dealer's PROVINCE (derived from the postal) so CA comps are never national.
      const g = await geocodePostal(zip || cleanZip, false)
      if (g) geo = { latitude: g.lat, longitude: g.lon }
      else { const prov = provinceFromPostal(cleanZip); if (prov) geo = { state: prov } }
    }
  }

  // One fetch with a given set of filters. geo/drivetrain/trim can each be turned
  // off so the caller can relax them when a tighter query comes back too thin.
  const fetchListings = async ({ withTrim, withDrive, withGeo }) => {
    const p = new URLSearchParams({
      api_key: key, country: isUS ? 'us' : 'ca', car_type: 'used',
      make: String(make), model: String(model), year: String(year),
      rows: '100', sort_by: 'price', sort_order: 'asc',
    })
    if (withTrim && trim) p.set('trim', String(trim))
    if (withDrive && wantDrive) p.set('drivetrain', wantDrive)
    if (withGeo && geo) {
      if (geo.zip) { p.set('zip', geo.zip); p.set('radius', String(rad)) }
      else if (geo.latitude != null) { p.set('latitude', String(geo.latitude)); p.set('longitude', String(geo.longitude)); p.set('radius', String(rad)) }
      else if (geo.state) { p.set('state', geo.state) }   // province scope (no radius)
    }
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

  // Comp-selection cascade. GEO IS STICKY: staying local matters more to a dealer
  // than an exact trim, so we relax drivetrain, then trim, WHILE KEEPING the local
  // scope — and only drop geo (go national) if the local market can't field enough
  // comps of the model at all. This is the fix for "clicked 250 but got national":
  // a scarce local Sport-AWD used to drop geo first and jump straight to nationwide.
  const priced = (res) => (res?.listings || []).filter(l => l.price >= 2500)
  const appliedOf = (a) => ({ trim: a.withTrim && !!trim, drivetrain: a.withDrive && !!wantDrive, geo: a.withGeo && !!geo })
  const attempts = [
    { withTrim: true,  withDrive: true,  withGeo: true  },   // local · exact trim+drivetrain
    { withTrim: true,  withDrive: false, withGeo: true  },   // local · trim (drop drivetrain)
    { withTrim: false, withDrive: false, withGeo: true  },   // local · any trim of the model
    { withTrim: true,  withDrive: true,  withGeo: false },   // national · exact (local was empty)
    { withTrim: true,  withDrive: false, withGeo: false },   // national · trim
    { withTrim: false, withDrive: false, withGeo: false },   // national · any trim
  ]
  let res = null, applied = null
  const seenKeys = new Set()
  for (const a of attempts) {
    // Effective query — skip attempts identical to one we already ran (e.g. there's
    // no drivetrain/geo to drop, so relaxing them changes nothing).
    const key = [a.withTrim && trim ? 't' : '', a.withDrive && wantDrive ? 'd' : '', a.withGeo && geo ? 'g' : ''].join('|')
    if (seenKeys.has(key)) continue
    seenKeys.add(key)
    const cand = await fetchListings(a)
    if (!cand) continue
    const pc = priced(cand).length
    if (pc >= MIN_COMPS) { res = cand; applied = appliedOf(a); break }
    // Keep the widest partial result as a floor in case nothing clears the bar.
    if (!res || pc > (res._pc || 0)) { res = cand; res._pc = pc; applied = appliedOf(a) }
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
    // Radius only applies when geo was a lat/long or zip scope; province scope has no radius.
    radius_used: (applied?.geo && !geo?.state && rad) ? rad : null,
    geo_scope: applied?.geo ? (geo?.state || 'radius') : null,   // 'ON' / 'radius' / null
    median_distance: dists.length ? dists[Math.floor(dists.length / 2)] : null,
    max_distance: dists.length ? dists[dists.length - 1] : null,
    listings: cleanListings,
  }
}

/**
 * RECENTLY SOLD / removed comparable listings — MarketCheck's Past Inventory
 * ("recents") product. These are cars that actually left the market, so their
 * last asking price is the closest public proxy for a real transaction price,
 * and their `dom` is a proven days-on-market. This is what lets us show "proven
 * to market" numbers instead of only live asks (which sit above what cars sell
 * for — the whole reason a comp-asking appraisal reads high).
 *
 * Past Inventory Search is a SEPARATE MarketCheck plan product. If the key isn't
 * entitled to it the endpoint 403/404s — we return null and the caller simply
 * hides the sold panel (never fails the appraisal). Path is overridable via
 * MARKETCHECK_SOLD_PATH in case the account is on a different recents route.
 *
 * Returns { count, num_found, median_price, avg_price, low_price, high_price,
 * median_mileage, median_dom, geo_scope, radius_used,
 * listings:[{price,miles,city,region,dealer,dom,sold_date,vdp_url,source}] } or null.
 */
export async function marketcheckSoldListings({ make, model, year, trim, drivetrain, engine, zip, radius, mileage, isUS = false } = {}) {
  const key = process.env.MARKETCHECK_API_KEY
  if (!key || !make || !model || !year) return null
  if (process.env.MARKETCHECK_SOLD_DISABLED === '1') return null   // kill-switch if plan lacks it
  const path = process.env.MARKETCHECK_SOLD_PATH || '/search/car/recents'
  const MIN_SOLD = 3

  const wantDrive = normalizeDrivetrain(drivetrain)
  const wantLitres = engineLitres(engine)
  const cleanZip = String(zip || '').replace(/\s+/g, '').toUpperCase() || null
  const rad = Number(radius) > 0 ? Math.round(Number(radius)) : null

  // Same geo resolution as the live comp search: US ZIP native, CA postal → lat/long
  // (or province fallback) so "sold near me" isn't silently national.
  let geo = null
  if (cleanZip && rad) {
    if (isUS) geo = { zip: cleanZip }
    else {
      const g = await geocodePostal(zip || cleanZip, false)
      if (g) geo = { latitude: g.lat, longitude: g.lon }
      else { const prov = provinceFromPostal(cleanZip); if (prov) geo = { state: prov } }
    }
  }

  const fetchSold = async ({ withTrim, withDrive, withGeo }) => {
    const p = new URLSearchParams({
      api_key: key, country: isUS ? 'us' : 'ca', car_type: 'used',
      make: String(make), model: String(model), year: String(year),
      rows: '50', sold: 'true', sort_by: 'last_seen_at', sort_order: 'desc',
    })
    if (withTrim && trim) p.set('trim', String(trim))
    if (withDrive && wantDrive) p.set('drivetrain', wantDrive)
    if (withGeo && geo) {
      if (geo.zip) { p.set('zip', geo.zip); p.set('radius', String(rad)) }
      else if (geo.latitude != null) { p.set('latitude', String(geo.latitude)); p.set('longitude', String(geo.longitude)); p.set('radius', String(rad)) }
      else if (geo.state) { p.set('state', geo.state) }
    }
    try {
      const r = await fetch(`${BASE}${path}?${p.toString()}`, {
        headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(12000),
      })
      if (!r.ok) {
        // 403/404 → plan not entitled to Past Inventory Search. Log once and bail
        // for the whole call (no point retrying the cascade against a dead route).
        if (r.status === 403 || r.status === 404) { console.warn(`[marketcheck] sold search unavailable on this plan (HTTP ${r.status}) — hiding sold panel`); return 'unavailable' }
        console.error(`[marketcheck] sold HTTP ${r.status} ${make} ${model} ${year}`); return null
      }
      const j = await r.json()
      const raw = Array.isArray(j?.listings) ? j.listings : []
      return {
        num_found: Number(j?.num_found ?? raw.length),
        listings: raw.map(l => ({
          price: Number(l.price ?? 0), miles: Number(l.miles ?? 0),
          city: l.dealer?.city || null, region: l.dealer?.state || null, dealer: l.dealer?.name || null,
          dom: (l.dom != null ? Number(l.dom) : null),
          sold_date: l.last_seen_at || l.sold_date || l.scraped_at || null,
          vdp_url: l.vdp_url || l.href || null, source: l.source || null,
          litres: (l.build?.engine_size != null ? Number(l.build.engine_size) : engineLitres(l.build?.engine)),
        })),
      }
    } catch (e) { console.error('[marketcheck] sold request failed:', e.message); return null }
  }

  // Same geo-sticky relax cascade as live comps: keep it local, relax trim/drivetrain
  // before going national. Sold pools are thinner, so we accept fewer and widen readily.
  const priced = (list) => (list || []).filter(l => l.price >= 2500)
  const attempts = [
    { withTrim: true,  withDrive: true,  withGeo: true  },
    { withTrim: true,  withDrive: false, withGeo: true  },
    { withTrim: false, withDrive: false, withGeo: true  },
    { withTrim: true,  withDrive: false, withGeo: false },
    { withTrim: false, withDrive: false, withGeo: false },
  ]
  let best = null
  const seen = new Set()
  for (const a of attempts) {
    const kkey = [a.withTrim && trim ? 't' : '', a.withDrive && wantDrive ? 'd' : '', a.withGeo && geo ? 'g' : ''].join('|')
    if (seen.has(kkey)) continue
    seen.add(kkey)
    const cand = await fetchSold(a)
    if (cand === 'unavailable') return null   // plan can't do sold at all
    if (!cand) continue
    const pc = priced(cand.listings).length
    if (pc >= MIN_SOLD) { best = { ...cand, applied: a }; break }
    if (!best || pc > (best._pc || 0)) best = { ...cand, applied: a, _pc: pc }
  }
  if (!best) return null

  // Optional engine-displacement narrowing (same as live comps) when it keeps enough.
  let list = best.listings
  if (wantLitres) {
    const sameEngine = list.filter(l => l.litres != null && Math.abs(l.litres - wantLitres) <= 0.3)
    if (priced(sameEngine).length >= MIN_SOLD) list = sameEngine
  }

  const good = list.filter(l => l.price >= 2500)
  if (good.length < MIN_SOLD) return null
  const prices = good.map(l => l.price).sort((a, b) => a - b)
  const med0 = prices[Math.floor(prices.length / 2)]
  const inBand = (p) => p >= med0 * 0.5 && p <= med0 * 1.8
  const kept = good.filter(l => inBand(l.price))
  if (kept.length < MIN_SOLD) return null
  const kp = kept.map(l => l.price).sort((a, b) => a - b)
  const km = kept.map(l => l.miles).filter(m => m > 0).sort((a, b) => a - b)
  const kd = kept.map(l => l.dom).filter(d => d != null && d >= 0).sort((a, b) => a - b)
  const median = (arr) => arr.length ? arr[Math.floor(arr.length / 2)] : null
  const applied = best.applied
  return {
    source: 'MarketCheck (sold)',
    count: kept.length,
    num_found: best.num_found,
    median_price: median(kp),
    avg_price: Math.round(kp.reduce((a, b) => a + b, 0) / kp.length),
    low_price: kp[Math.max(0, Math.floor(kp.length * 0.1))],
    high_price: kp[Math.min(kp.length - 1, Math.max(0, Math.ceil(kp.length * 0.9) - 1))],
    median_mileage: median(km),
    median_dom: median(kd),
    matched_on: { trim: !!(applied?.withTrim && trim), drivetrain: !!(applied?.withDrive && wantDrive), geo: !!(applied?.withGeo && geo) },
    radius_used: (applied?.withGeo && geo && !geo.state && rad) ? rad : null,
    geo_scope: (applied?.withGeo && geo) ? (geo.state || 'radius') : null,
    listings: kept.map(l => ({
      price: l.price, miles: l.miles, city: l.city, region: l.region,
      dealer: l.dealer, dom: l.dom, sold_date: l.sold_date, vdp_url: l.vdp_url, source: l.source,
    })),
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
