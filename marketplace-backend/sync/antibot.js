// Optional commercial anti-bot fetch — residential IP + JS render — for the rare
// Cloudflare/Turnstile dealer sites that defeat our OWN headless Chrome (those get
// flagged needs_extension_capture). This is the "always-on capture" backstop: it
// runs server-side with no rep browser, but only when ANTIBOT_API_KEY is set, so it
// costs nothing until you turn it on. Provider-agnostic; defaults to a ScraperAPI-
// style GET endpoint (api_key + url + render). Set ANTIBOT_ENDPOINT for another
// provider, ANTIBOT_PREMIUM=1 to request residential/premium proxies.

export function antibotEnabled() {
  return !!process.env.ANTIBOT_API_KEY
}

// Fetch a URL through the anti-bot service. Returns { ok, status, body, contentType }.
// We ask for a rendered page so JS-gated / Cloudflare-challenged endpoints resolve.
export async function fetchViaAntibot(targetUrl, { render = true, timeoutMs = 45000 } = {}) {
  const key = process.env.ANTIBOT_API_KEY
  if (!key || !targetUrl) return { ok: false, status: 0, body: '', contentType: '' }
  const endpoint = process.env.ANTIBOT_ENDPOINT || 'http://api.scraperapi.com'
  let requestUrl
  try {
    const u = new URL(endpoint)
    u.searchParams.set('api_key', key)
    u.searchParams.set('url', targetUrl)
    if (render) u.searchParams.set('render', 'true')
    if (process.env.ANTIBOT_PREMIUM === '1') u.searchParams.set('premium', 'true')
    requestUrl = u.toString()
  } catch { return { ok: false, status: 0, body: '', contentType: '' } }

  try {
    const r = await fetch(requestUrl, { signal: AbortSignal.timeout(timeoutMs) })
    const contentType = r.headers.get('content-type') || ''
    const body = await r.text()
    return { ok: r.ok && !!body, status: r.status, body, contentType }
  } catch (e) {
    console.warn('[antibot] fetch failed:', e.message)
    return { ok: false, status: 0, body: '', contentType: '', error: e.message }
  }
}

// Best-effort inventory extraction from an anti-bot response. We only trust a clean
// JSON payload (the case where the feed endpoint is JSON but our datacenter IP was
// Cloudflare-blocked — a residential IP clears it). We deliberately do NOT scrape
// arbitrary rendered HTML here; that's what the extension capture is for.
export function inventoryFromAntibotBody(body, contentType = '') {
  if (!body) return null
  const looksJson = contentType.includes('json') || /^\s*[[{]/.test(body)
  if (!looksJson) return null
  let j
  try { j = JSON.parse(body) } catch { return null }
  const arr = Array.isArray(j) ? j
    : j.vehicles || j.Vehicles || j.inventory || j.Inventory || j.items || j.records || j.results || j.data
  return Array.isArray(arr) && arr.length ? arr : null
}
