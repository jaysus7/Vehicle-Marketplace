// dealer-extract.js — runs on dealer websites (NOT facebook.com).
//
// Job: when this page is on a dealer's inventory site, fetch the inventory data
// using THE USER'S authenticated browser session and post it to our backend.
// Because the request comes from real Chrome with the user's cookies + IP +
// TLS fingerprint, Cloudflare / DataDome / etc. let it through cleanly — no
// bot detection, no headless browser, no proxies needed.
//
// Loaded dynamically via chrome.scripting.executeScript from background.js
// once the user grants permission for a specific dealer domain.

(async () => {
  // Guard: only run once per page load. Some dealer SPAs re-render on every
  // route change; without this we'd fire multiple captures per navigation.
  if (window.__marketsyncExtractRan) return
  window.__marketsyncExtractRan = true

  const origin = location.origin
  const log = (...a) => console.log('[MarketSync extract]', ...a)

  // Detect which platform this dealer runs. Same probe shapes as the server
  // PLATFORM_PROBES array, but client-side. Each entry tries a candidate path,
  // validates the response shape, and returns normalized vehicles.
  const PROBES = [
    {
      platform: 'leadbox',
      paths: ['/wp-content/uploads/data/inventory.json'],
      validate: d => Array.isArray(d?.vehicles) && d.vehicles.length > 0,
      extract: d => d.vehicles
    },
    {
      platform: 'edealer',
      paths: ['/api/inventory/getall', '/api/vehicles', '/Inventory/GetInventory'],
      validate: d => {
        if (Array.isArray(d) && d[0]?.VIN) return true
        if (Array.isArray(d?.vehicles) && d.vehicles[0]?.VIN) return true
        return false
      },
      extract: d => Array.isArray(d) ? d : (d?.vehicles || d?.Vehicles || [])
    },
    {
      platform: 'dealer_inspire',
      paths: ['/wp-json/di-wp/v2/inventory', '/wp-json/inventory/v1/vehicles'],
      validate: d => Array.isArray(d) && d[0]?.vin,
      extract: d => d
    },
    {
      platform: 'dealer_com',
      paths: ['/apis/widget/INVENTORY_LISTING_DEFAULT_AUTO_ALL:inventory-data-bus1/getInventory'],
      validate: d => Array.isArray(d?.inventory) && d.inventory.length > 0,
      extract: d => d.inventory
    },
    {
      platform: 'sincro',
      paths: ['/api/inventory/vehicles', '/api/vehicles', '/inventory/api/vehicles'],
      validate: d => {
        if (Array.isArray(d?.vehicles) && d.vehicles[0]?.vin) return true
        if (Array.isArray(d?.data) && d.data[0]?.vin) return true
        return false
      },
      extract: d => d?.vehicles || d?.data || []
    },
    {
      platform: 'strathcom',
      paths: ['/wp-content/uploads/data/inventory.json', '/vehicle-inventory/feeds/all.json'],
      validate: d => Array.isArray(d?.vehicles) && d.vehicles.length > 0,
      extract: d => d.vehicles
    },
    {
      platform: 'ux_auto',
      paths: ['/inventory/list/NEW', '/inventory/list/USED', '/inventory/list/DEMO'],
      validate: d => d?.result === 'Success' && Array.isArray(d?.records) && d.records.length > 0,
      extract: d => d.records
    }
  ]

  // Try each probe in order. First one that returns vehicles wins.
  let result = null
  for (const probe of PROBES) {
    for (const path of probe.paths) {
      const url = origin + path
      try {
        log('probing', url)
        // credentials: 'include' — sends the user's cookies for THIS origin,
        // mode: 'cors' — explicit so failures throw cleanly instead of silent
        const r = await fetch(url, {
          credentials: 'include',
          headers: { 'Accept': 'application/json' }
        })
        if (!r.ok) continue
        const ct = r.headers.get('content-type') || ''
        if (!ct.includes('json')) continue
        const data = await r.json()
        if (!probe.validate(data)) continue
        result = {
          platform: probe.platform,
          source_url: url,
          vehicles: probe.extract(data)
        }
        log(`✓ matched ${probe.platform} at ${url} — ${result.vehicles.length} vehicles`)
        break
      } catch (e) {
        // Network error, parse error, or CORS — try the next path
      }
    }
    if (result) break
  }

  // Fallback: Schema.org JSON-LD baked into the current page HTML.
  // Works on any dealer site that exposes structured data even if no JSON
  // endpoint exists. Re-uses the recursive walker pattern from the backend.
  if (!result) {
    const blocks = []
    for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
      try { blocks.push(JSON.parse(s.textContent)) } catch {}
    }
    const cars = []
    const seen = new WeakSet()
    const queue = [blocks]
    while (queue.length) {
      const n = queue.pop()
      if (!n) continue
      if (Array.isArray(n)) { for (const x of n) queue.push(x); continue }
      if (typeof n !== 'object') continue
      if (seen.has(n)) continue
      seen.add(n)
      const t = n['@type']
      const types = Array.isArray(t) ? t : (t ? [t] : [])
      if (types.some(x => x === 'Car' || x === 'Vehicle' || x === 'MotorVehicle')) {
        cars.push(n)
        continue
      }
      for (const v of Object.values(n)) if (v && typeof v === 'object') queue.push(v)
    }
    if (cars.length > 0) {
      result = {
        platform: 'schema_jsonld',
        source_url: location.href,
        vehicles: cars
      }
      log(`✓ matched schema_jsonld on current page — ${cars.length} cars`)
    }
  }

  if (!result) {
    log('no inventory found via probes or JSON-LD on this page')
    chrome.runtime.sendMessage({
      type: 'DEALER_INVENTORY_CAPTURED',
      feed_id: window.__marketsyncFeedId || null,
      source_url: location.href,
      platform: 'extension_capture',
      vehicles: [],
      error: 'no inventory detected on this page'
    })
    return
  }

  // Send the captured vehicles to the background script, which forwards to
  // the MarketSync backend. The background script will auto-close this tab
  // once the upload succeeds (unless the user is actively viewing it).
  chrome.runtime.sendMessage({
    type: 'DEALER_INVENTORY_CAPTURED',
    feed_id: window.__marketsyncFeedId || null,
    source_url: result.source_url,
    platform: result.platform,
    vehicles: result.vehicles
  }, (resp) => {
    if (resp?.success) log(`✓ uploaded ${result.vehicles.length} vehicles to MarketSync`)
    else log('upload failed:', resp?.error)
  })
})()
