/**
 * CarAPI (carapi.app) — a fallback vehicle-specs source when MarketCheck's neovin
 * decode is unavailable, over-cap, or returns nothing. CarAPI provides VIN decode
 * (year/make/model/trim, engine, body, fuel economy, MSRP) but NOT live market
 * listings/comps, so it only backstops the DECODE/ENRICHMENT path — never pricing.
 *
 * Auth: set CARAPI_API in the environment. It accepts either:
 *   • "api_token:api_secret" (or api_token|api_secret) — we exchange it for a JWT
 *     via POST /api/auth/login and cache the token (~23h), OR
 *   • a single pre-generated JWT/bearer token — used directly.
 */
const BASE = 'https://carapi.app/api'

export function carapiEnabled() {
  return !!process.env.CARAPI_API
}

let _jwt = null
let _jwtExpires = 0

// Resolve a bearer token: log in with token:secret (cached), or use the value as-is.
async function carapiToken() {
  const raw = (process.env.CARAPI_API || '').trim()
  if (!raw) return null
  const sep = raw.includes('|') ? '|' : (raw.includes(':') && !raw.startsWith('ey') ? ':' : null)
  if (!sep) return raw   // treat as a pre-generated JWT/bearer
  if (_jwt && Date.now() < _jwtExpires) return _jwt
  const [api_token, api_secret] = raw.split(sep)
  try {
    const r = await fetch(`${BASE}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/plain' },
      body: JSON.stringify({ api_token: api_token.trim(), api_secret: (api_secret || '').trim() }),
      signal: AbortSignal.timeout(12000),
    })
    if (!r.ok) { console.warn('[carapi] auth failed:', r.status); return null }
    const jwt = (await r.text()).trim().replace(/^"|"$/g, '')
    if (!jwt || jwt.length < 20) return null
    _jwt = jwt
    _jwtExpires = Date.now() + 23 * 60 * 60 * 1000   // JWTs last ~24h; refresh a little early
    return _jwt
  } catch (e) { console.warn('[carapi] auth error:', e.message); return null }
}

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null }
const str = (v) => (v == null || v === '' ? null : String(v).trim())

/**
 * Decode a VIN via CarAPI. Returns a normalized specs object (only the fields
 * CarAPI actually returned) or null. Shape is intentionally MarketCheck-ish so the
 * caller can merge it the same way:
 *   { year, make, model, trim, body_type, drivetrain, fuel_type, engine,
 *     cylinders, displacement_l, doors, city_mpg, highway_mpg, combined_mpg,
 *     msrp, options: [] }
 */
export async function carapiDecodeVin(vin) {
  const v = String(vin || '').trim().toUpperCase()
  if (v.length !== 17) return null
  const token = await carapiToken()
  if (!token) return null
  try {
    const r = await fetch(`${BASE}/vin/${encodeURIComponent(v)}`, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(12000),
    })
    if (r.status === 401) { _jwt = null; _jwtExpires = 0 }   // force re-auth next call
    if (!r.ok) return null
    const j = await r.json()
    if (!j || typeof j !== 'object') return null
    // CarAPI nests some data (make_model_trim / specs / engine). Read defensively
    // across the shapes different plans return.
    const trimObj = j.make_model_trim || j.trim_obj || {}
    const specs = j.specs || trimObj.specs || {}
    const engine = j.engine || specs.engine || {}
    const mm = j.make_model || {}
    const out = {
      year: num(j.year ?? trimObj.year),
      make: str(j.make ?? mm.make ?? j.make_name),
      model: str(j.model ?? mm.name ?? j.model_name),
      trim: str(j.trim ?? trimObj.name ?? j.trim_name),
      body_type: str(specs.body_type ?? j.body_type ?? specs.body),
      drivetrain: str(specs.drive_type ?? specs.drivetrain ?? j.drive_type),
      fuel_type: str(specs.fuel_type ?? j.fuel_type ?? engine.fuel_type),
      engine: str(engine.name ?? specs.engine ?? j.engine_description),
      cylinders: num(engine.cylinders ?? specs.cylinders),
      displacement_l: num(engine.size ?? specs.engine_size ?? engine.displacement),
      doors: num(specs.doors ?? j.doors),
      city_mpg: num(specs.epa_city_mpg ?? specs.city_mpg ?? j.city_mpg),
      highway_mpg: num(specs.epa_highway_mpg ?? specs.highway_mpg ?? j.highway_mpg),
      combined_mpg: num(specs.epa_combined_mpg ?? specs.combined_mpg ?? j.combined_mpg),
      msrp: num(specs.msrp ?? trimObj.msrp ?? j.msrp),
      options: Array.isArray(j.equipment) ? j.equipment.map(e => e?.name || e).filter(Boolean).slice(0, 30)
             : Array.isArray(specs.options) ? specs.options.map(e => e?.name || e).filter(Boolean).slice(0, 30) : [],
    }
    // Only return if we actually got something useful.
    const hasData = Object.entries(out).some(([k, val]) => k !== 'options' && val != null) || out.options.length
    return hasData ? out : null
  } catch (e) { console.warn('[carapi] decode error:', e.message); return null }
}
