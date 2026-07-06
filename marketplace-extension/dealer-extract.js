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

  // Scrape vehicle data from an eDealer-rendered page. eDealer renders all
  // inventory cards into the DOM after JS execution; API endpoints only return
  // one page (25 vehicles) and ignore pagination params. DOM scraping gets all.
  function eDealerScrapeDOM() {
    const vehicles = []
    const seen = new Set()

    // 1. Window-level inventory globals injected by eDealer's JS bundle
    const GLOBALS = ['inventoryData', 'inventory', 'inventoryItems', 'vehicles',
                     'inventoryList', 'vehicleData', 'allVehicles']
    for (const g of GLOBALS) {
      const val = window[g]
      const arr = Array.isArray(val) ? val
        : Array.isArray(val?.vehicles) ? val.vehicles
        : Array.isArray(val?.inventory) ? val.inventory
        : Array.isArray(val?.items) ? val.items
        : null
      if (arr && arr.length && (arr[0]?.VIN || arr[0]?.vin)) {
        for (const v of arr) {
          const id = v.VIN || v.vin || v.StockNumber || v.stocknumber
          if (id && !seen.has(id)) { seen.add(id); vehicles.push(v) }
        }
        if (vehicles.length) return vehicles
      }
    }

    // 2. JSON embedded in <script> tags (eDealer sometimes inlines inventory
    //    as a JSON assignment or array literal in a non-module script tag)
    for (const s of document.querySelectorAll('script:not([src]):not([type="application/ld+json"])')) {
      const text = s.textContent || ''
      // Look for patterns like: var inventory=[{...}] or window.inventory=[{...}]
      const m = text.match(/(?:var |window\.)(?:inventory|inventoryData|vehicles|inventoryItems)\s*=\s*(\[[\s\S]{20,}\])/i)
        || text.match(/\binventory\s*:\s*(\[[\s\S]{20,}\])/i)
      if (m) {
        try {
          const arr = JSON.parse(m[1])
          if (Array.isArray(arr) && arr.length && (arr[0]?.VIN || arr[0]?.vin || arr[0]?.stocknumber)) {
            for (const v of arr) {
              const id = v.VIN || v.vin || v.StockNumber || v.stocknumber
              if (id && !seen.has(id)) { seen.add(id); vehicles.push(v) }
            }
            if (vehicles.length) return vehicles
          }
        } catch {}
      }
    }

    // 3. DOM card scraping — eDealer renders each vehicle as a card element
    //    with data-* attributes for VIN, year, make, model, price, etc.
    const cardSelectors = [
      '[data-vin]', '[data-vehicle-vin]', '[data-vehiclevin]',
      '.vehicle-card[data-vin]', '.inventory-card[data-vin]',
      'li[data-vin]', 'article[data-vin]'
    ]
    for (const sel of cardSelectors) {
      const cards = document.querySelectorAll(sel)
      if (!cards.length) continue
      for (const el of cards) {
        const vin = el.dataset.vin || el.dataset.vehicleVin || el.dataset.vehiclevin
        if (!vin || seen.has(vin)) continue
        seen.add(vin)
        // Try to read companion data attributes; fall back to text content parsing
        const year = el.dataset.year || el.querySelector('[data-year]')?.dataset.year
        const make = el.dataset.make || el.querySelector('[data-make]')?.dataset.make
        const model = el.dataset.model || el.querySelector('[data-model]')?.dataset.model
        const trim = el.dataset.trim || null
        const stock = el.dataset.stock || el.dataset.stocknumber || el.dataset.stockNumber || null
        const priceRaw = el.dataset.price || el.dataset.saleprice || el.dataset.salePrice
          || el.querySelector('.price, [class*="price"]')?.textContent?.replace(/[^0-9]/g, '')
        const price = priceRaw ? parseInt(priceRaw, 10) || 0 : 0
        const condition = el.dataset.condition || el.dataset.type || null
        const mileageRaw = el.dataset.mileage || el.dataset.odometer
          || el.querySelector('[class*="mileage"], [class*="odometer"]')?.textContent?.replace(/[^0-9]/g, '')
        const mileage = mileageRaw ? parseInt(mileageRaw, 10) || 0 : 0
        const imgEl = el.querySelector('img[src]')
        const image_urls = imgEl ? [imgEl.src] : []
        const linkEl = el.querySelector('a[href]')
        const vdp_url = linkEl ? (linkEl.href || null) : null
        vehicles.push({ VIN: vin, vin, year: year || null, make: make || null, model: model || null,
          trim, StockNumber: stock, stocknumber: stock, price, saleprice: price, mileage,
          condition, image_urls, vdp_url })
      }
      if (vehicles.length) break
    }

    return vehicles
  }

  // Full eDealer inventory by paginating the LISTING pages from inside the user's
  // browser session. This is the legitimate, Cloudflare-safe method: the user already
  // passed Cloudflare's challenge to view the site, so fetch() here inherits their
  // cf_clearance cookie (credentials:'include') and the ?page=N requests go through —
  // no evasion, just the authenticated session. Each listing page carries Schema.org
  // Car JSON-LD; we walk pages until no new vehicles. Gets ALL of them, not just the
  // ~24 rendered on one page.
  async function walkEDealerListingPages() {
    const seen = new Set()
    const all = []
    const jsonLdRe = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
    const extractCars = (html) => {
      const cars = []
      let m
      while ((m = jsonLdRe.exec(html)) !== null) {
        let data
        try { data = JSON.parse(m[1]) } catch { continue }
        const q = [data]
        while (q.length) {
          const n = q.pop()
          if (!n || typeof n !== 'object') continue
          if (Array.isArray(n)) { for (const x of n) q.push(x); continue }
          if (Array.isArray(n['@graph'])) { for (const x of n['@graph']) q.push(x); continue }
          const t = n['@type']
          const types = Array.isArray(t) ? t : (t ? [t] : [])
          if (types.some(x => x === 'Car' || x === 'Vehicle' || x === 'MotorVehicle')) cars.push(n)
          else for (const v of Object.values(n)) if (v && typeof v === 'object') q.push(v)
        }
      }
      jsonLdRe.lastIndex = 0
      return cars
    }
    const mapCar = (c) => {
      const cond = (c.itemCondition || '') + ' ' + (c.name || '')
      const cfg = typeof c.vehicleConfiguration === 'string' ? c.vehicleConfiguration.split(' ').filter(Boolean) : []
      const offer = Array.isArray(c.offers) ? c.offers[0] : c.offers
      let price = offer?.price || c.offers?.lowPrice || 0
      if (typeof price === 'string') price = parseInt(price.replace(/[^0-9]/g, '')) || 0
      let imgs = c.image
      if (imgs && typeof imgs === 'object' && !Array.isArray(imgs)) imgs = imgs.url || imgs.contentUrl
      imgs = (Array.isArray(imgs) ? imgs : (imgs ? [imgs] : []))
        .map(i => typeof i === 'string' ? i : (i?.url || i?.contentUrl))
        .filter(u => u && !/coming|no-?image|placeholder/i.test(u))
      return {
        vin: c.vehicleIdentificationNumber || null,
        year: c.vehicleModelDate ? parseInt(c.vehicleModelDate) : null,
        make: c.brand?.name || c.manufacturer?.name || (typeof c.brand === 'string' ? c.brand : null),
        model: typeof c.model === 'string' ? c.model : (c.model?.name || null),
        trim: cfg.length > 1 ? cfg.slice(1).join(' ') : null,
        price, saleprice: price,
        mileage: c.mileageFromOdometer?.value || c.mileageFromOdometer || 0,
        exteriorcolor: c.color || null, transmission: c.vehicleTransmission || null,
        fueltype: c.fuelType || c.vehicleEngine?.fuelType || null, bodystyle: c.bodyType || null,
        condition: /demo/i.test(cond) ? 'Demo' : /new/i.test((c.itemCondition||'')) ? 'New' : /used|pre-?owned|certified/i.test(cond) ? 'Used' : null,
        demo: /demo/i.test(cond),
        stocknumber: c.sku || c.productID || c.mpn || null,
        image_urls: imgs, onweb: true, salepending: false
      }
    }

    // Walk both new + used listing bases (eDealer splits them). Include the current
    // page's path too, in case the dealer uses a custom inventory root.
    const bases = new Set([`${origin}/inventory/new/`, `${origin}/inventory/used/`])
    if (/\/inventory\//i.test(location.pathname)) {
      bases.add(location.origin + location.pathname.replace(/\/$/, '').replace(/[^/]*vdp\/?$/i, '') + '/')
    }

    for (const base of bases) {
      for (let page = 1; page <= 40; page++) {
        const url = page === 1 ? base : `${base}?page=${page}`
        let html
        try {
          const r = await fetch(url, { credentials: 'include', headers: { Accept: 'text/html' } })
          if (!r.ok) break
          html = await r.text()
        } catch { break }
        const cars = extractCars(html)
        if (!cars.length) break
        let fresh = 0
        for (const c of cars) {
          const v = mapCar(c)
          const id = v.vin || (v.stocknumber ? 'stk:' + v.stocknumber : null)
          if (id && !seen.has(id)) { seen.add(id); all.push(v); fresh++ }
        }
        if (fresh === 0) break  // page returned only already-seen vehicles — past the end
        try { chrome.runtime.sendMessage({ type: 'CAPTURE_PROGRESS', feed_id: window.__marketsyncFeedId || null, phase: 'scanning', current: all.length, total: all.length }) } catch {}
        await new Promise(r => setTimeout(r, 40))
      }
    }
    return all
  }

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
      // eDealer: /api/inventory/getall exists but caps at 24/page and doesn't
      // return a totalCount, so we paginate until we get an empty page.
      paths: [
        '/api/inventory/getall',
        '/api/inventory/vehicles',
        '/api/vehicles',
        '/Inventory/GetInventory'
      ],
      validate: d => {
        if (Array.isArray(d) && d[0]?.VIN) return true
        if (Array.isArray(d?.vehicles) && d.vehicles[0]?.VIN) return true
        if (Array.isArray(d?.Vehicles) && d.Vehicles[0]?.VIN) return true
        if (d?.Items && Array.isArray(d.Items) && d.Items[0]?.VIN) return true
        return false
      },
      extract: d => {
        if (Array.isArray(d)) return d
        return d?.vehicles || d?.Vehicles || d?.Items || []
      },
      paginate: async (basePath, firstPage) => {
        const pageSize = firstPage.length || 25
        // Track VINs/stocknumbers to detect when API loops (returns same page repeatedly)
        const seen = new Set(firstPage.map(v => v.VIN || v.vin || v.StockNumber || v.stocknumber).filter(Boolean))
        const all = [...firstPage]

        // Strategy A: condition-specific endpoints (new + used as separate calls)
        // Some eDealer installs split inventory by type rather than paginating
        const conditionPaths = [
          '/api/inventory/new', '/api/inventory/used',
          '/api/inventory/getall?conditionType=NEW', '/api/inventory/getall?conditionType=USED',
          '/api/inventory/vehicles?condition=New', '/api/inventory/vehicles?condition=Used',
        ]
        for (const cp of conditionPaths) {
          if (cp === basePath) continue
          try {
            const r = await fetch(`${origin}${cp}`, { credentials: 'include', headers: { Accept: 'application/json' } })
            if (!r.ok) continue
            const ct = r.headers.get('content-type') || ''
            if (!ct.includes('json')) continue
            const d = await r.json()
            const batch = Array.isArray(d) ? d : (d?.vehicles || d?.Vehicles || d?.Items || [])
            const fresh = batch.filter(v => {
              const id = v.VIN || v.vin || v.StockNumber || v.stocknumber
              return id && !seen.has(id)
            })
            if (fresh.length > 0) { fresh.forEach(v => seen.add(v.VIN || v.vin || v.StockNumber || v.stocknumber)); all.push(...fresh) }
          } catch {}
        }
        if (all.length > firstPage.length) {
          try { chrome.runtime.sendMessage({ type: 'CAPTURE_PROGRESS', feed_id: window.__marketsyncFeedId || null, phase: 'scanning', current: all.length, total: all.length }) } catch {}
          return all
        }

        // Strategy B: query-string pagination — try multiple param styles, use VIN dedup
        // to detect loops (eDealer sometimes returns the same page regardless of params)
        const PARAM_STYLES = [
          p => `?pageNumber=${p}&pageSize=${pageSize}`,
          p => `?page=${p}&pageSize=${pageSize}`,
          p => `?pageNum=${p}&pageSize=${pageSize}`,
          p => `?skip=${(p - 1) * pageSize}&take=${pageSize}`,
          p => `?start=${(p - 1) * pageSize}&limit=${pageSize}`,
          p => `?offset=${(p - 1) * pageSize}&limit=${pageSize}`,
          p => `?PageNumber=${p}&PageSize=${pageSize}`,
          p => `?currentPage=${p}&pageSize=${pageSize}`,
        ]
        let workingStyle = null
        for (const style of PARAM_STYLES) {
          try {
            const r = await fetch(`${origin}${basePath}${style(2)}`, { credentials: 'include', headers: { Accept: 'application/json' } })
            if (!r.ok) continue
            const ct = r.headers.get('content-type') || ''
            if (!ct.includes('json')) continue
            const d = await r.json()
            const batch = Array.isArray(d) ? d : (d?.vehicles || d?.Vehicles || d?.Items || [])
            const fresh = batch.filter(v => {
              const id = v.VIN || v.vin || v.StockNumber || v.stocknumber
              return id && !seen.has(id)
            })
            if (fresh.length > 0) {
              fresh.forEach(v => seen.add(v.VIN || v.vin || v.StockNumber || v.stocknumber))
              all.push(...fresh)
              workingStyle = style
              try { chrome.runtime.sendMessage({ type: 'CAPTURE_PROGRESS', feed_id: window.__marketsyncFeedId || null, phase: 'scanning', current: all.length, total: all.length }) } catch {}
              break
            }
          } catch {}
        }
        if (workingStyle) {
          let page = 3
          while (page <= 100) {
            try {
              const r = await fetch(`${origin}${basePath}${workingStyle(page)}`, { credentials: 'include', headers: { Accept: 'application/json' } })
              if (!r.ok) break
              const d = await r.json()
              const batch = Array.isArray(d) ? d : (d?.vehicles || d?.Vehicles || d?.Items || [])
              const fresh = batch.filter(v => {
                const id = v.VIN || v.vin || v.StockNumber || v.stocknumber
                return id && !seen.has(id)
              })
              if (!fresh.length) break
              fresh.forEach(v => seen.add(v.VIN || v.vin || v.StockNumber || v.stocknumber))
              all.push(...fresh)
              try { chrome.runtime.sendMessage({ type: 'CAPTURE_PROGRESS', feed_id: window.__marketsyncFeedId || null, phase: 'scanning', current: all.length, total: all.length }) } catch {}
              page++
            } catch { break }
          }
          return all
        }

        // Strategy C: DOM scrape — eDealer renders vehicle cards server-side so the
        // API only returns one page but ALL vehicles are in the rendered HTML.
        // Extract from [data-vin] elements, window globals, or embedded JSON in <script>.
        const domVehicles = eDealerScrapeDOM()
        const domFresh = domVehicles.filter(v => {
          const id = v.VIN || v.vin || v.StockNumber || v.stocknumber
          return id && !seen.has(id)
        })
        if (domFresh.length > 0) {
          log(`eDealer DOM scrape found ${domFresh.length} additional vehicles`)
          domFresh.forEach(v => seen.add(v.VIN || v.vin || v.StockNumber || v.stocknumber))
          all.push(...domFresh)
          try { chrome.runtime.sendMessage({ type: 'CAPTURE_PROGRESS', feed_id: window.__marketsyncFeedId || null, phase: 'scanning', current: all.length, total: all.length }) } catch {}
        }
        return all
      }
    },
    {
      platform: 'dealer_inspire',
      paths: ['/wp-json/di-wp/v2/inventory', '/wp-json/inventory/v1/vehicles'],
      validate: d => Array.isArray(d) && d[0]?.vin,
      extract: d => d,
      // Paginate via ?page=N&per_page=100
      paginate: async (basePath, firstPage) => {
        const all = [...firstPage]
        const pageSize = firstPage.length
        if (pageSize < 100) return all
        let page = 2
        while (page <= 50) {
          try {
            const r = await fetch(`${origin}${basePath}?page=${page}&per_page=100`, { credentials: 'include', headers: { Accept: 'application/json' } })
            if (!r.ok) break
            const d = await r.json()
            if (!Array.isArray(d) || !d.length) break
            all.push(...d)
            if (d.length < 100) break
            page++
          } catch { break }
        }
        return all
      }
    },
    {
      platform: 'dealer_com',
      // dealer.com (used by GM/Ford/Chrysler OEM dealers): defaults to 24/page.
      // Pass limit=500 to try grabbing everything in one shot; paginate via
      // firstRecord offset if the response includes a totalCount.
      paths: ['/apis/widget/INVENTORY_LISTING_DEFAULT_AUTO_ALL:inventory-data-bus1/getInventory'],
      validate: d => Array.isArray(d?.inventory) && d.inventory.length > 0,
      extract: d => d.inventory,
      paginate: async (basePath, firstPage, firstData) => {
        const total = firstData?.totalCount ?? firstData?.total ?? null
        const all = [...firstPage]
        if (!total || all.length >= total) return all
        const pageSize = firstPage.length || 100
        let offset = pageSize
        while (all.length < total && offset < total && offset < 2000) {
          try {
            const r = await fetch(`${origin}${basePath}?limit=${pageSize}&firstRecord=${offset}`, { credentials: 'include', headers: { Accept: 'application/json' } })
            if (!r.ok) break
            const d = await r.json()
            const batch = d?.inventory
            if (!Array.isArray(batch) || !batch.length) break
            all.push(...batch)
            offset += batch.length
            try { chrome.runtime.sendMessage({ type: 'CAPTURE_PROGRESS', feed_id: window.__marketsyncFeedId || null, phase: 'scanning', current: all.length, total }) } catch {}
          } catch { break }
        }
        return all
      }
    },
    {
      platform: 'sincro',
      paths: ['/api/inventory/vehicles', '/api/vehicles', '/inventory/api/vehicles'],
      validate: d => {
        if (Array.isArray(d?.vehicles) && d.vehicles[0]?.vin) return true
        if (Array.isArray(d?.data) && d.data[0]?.vin) return true
        return false
      },
      extract: d => d?.vehicles || d?.data || [],
      // Paginate via ?page=N&pageSize=100
      paginate: async (basePath, firstPage, firstData) => {
        const total = firstData?.total ?? firstData?.totalCount ?? null
        const all = [...firstPage]
        if (!total || all.length >= total) return all
        let page = 2
        while (all.length < total && page <= 50) {
          try {
            const r = await fetch(`${origin}${basePath}?page=${page}&pageSize=100`, { credentials: 'include', headers: { Accept: 'application/json' } })
            if (!r.ok) break
            const d = await r.json()
            const batch = d?.vehicles || d?.data || []
            if (!batch.length) break
            all.push(...batch)
            page++
            try { chrome.runtime.sendMessage({ type: 'CAPTURE_PROGRESS', feed_id: window.__marketsyncFeedId || null, phase: 'scanning', current: all.length, total }) } catch {}
          } catch { break }
        }
        return all
      }
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
  // For dealer_com and paginating probes, try with a high limit first,
  // then paginate if the response indicates more records are available.
  //
  let result = null

  for (const probe of PROBES) {
    for (const path of probe.paths) {
      // dealer_com: request max in one shot; other probes use their own path variants
      const fetchPath = probe.platform === 'dealer_com' && !path.includes('?')
        ? `${path}?limit=500&firstRecord=0`
        : path
      const url = origin + fetchPath
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
        let vehicles = probe.extract(data)
        log(`✓ matched ${probe.platform} at ${url} — ${vehicles.length} vehicles (initial)`)
        // Run paginator if defined and first page might be incomplete
        if (probe.paginate && vehicles.length > 0) {
          // Pass the base path (no query string) so paginators can build clean URLs
          const basePath = path.split('?')[0]
          vehicles = await probe.paginate(basePath, vehicles, data)
          log(`  paginated ${probe.platform} — total ${vehicles.length} vehicles`)
        }
        result = { platform: probe.platform, source_url: url, vehicles }
        break
      } catch (e) {
        // Network error, parse error, or CORS — try the next path
      }
    }
    if (result) break
  }

  // Convertus / motocommerce (VMS): standard paths 404 here. Inventory loads via a
  // same-origin proxy, and the dealer's inventoryId is embedded in the page. Paginate
  // the proxy from the user's browser (their session + residential IP clear any gate).
  if (!result) {
    try {
      const html = document.documentElement.innerHTML
      const idMatch = html.match(/"inventoryId"\s*:\s*"?(\d{1,8})"?/i)
      if (idMatch && /convertus|achilles/i.test(html)) {
        const inventoryId = idMatch[1]
        const buildUrl = (page) => {
          const ep = `https://vms.prod.convertus.rocks/api/filtering/?cp=${inventoryId}&ln=en&pg=${page}&pc=100&dc=true&sc=&ai=true&in_stock=true&on_order=true&in_transit=true`
          return `${origin}/wp-content/plugins/convertus-vms/include/php/ajax-vehicles.php?endpoint=${encodeURIComponent(ep)}&action=vms_data`
        }
        const mapV = (v) => {
          const price = (v.sale_price && v.sale_price > 0 ? v.sale_price : 0) || v.internet_price || v.asking_price || v.msrp || 0
          const imgs = Array.isArray(v.image) ? v.image.map(i => i?.image_original || i?.image_lg).filter(Boolean) : []
          const sc = String(v.sale_class || '').toLowerCase()
          return {
            vin: v.vin || null, year: v.year || null, make: v.make || null, model: v.model || null,
            trim: v.trim || v.search_trim || null, stocknumber: v.stock_number || null,
            price, saleprice: price, mileage: Number(v.odometer) || 0,
            condition: sc.startsWith('new') ? 'New' : sc.startsWith('used') ? 'Used' : (v.sale_class || null),
            demo: v.demo === 1, exteriorcolor: v.exterior_color || null, interiorcolor: v.interior_color || null,
            transmission: v.transmission || null, fueltype: v.fuel_type || null, bodystyle: v.body_style || null,
            image_urls: imgs, vdp_url: v.vdp_url || null, onweb: true, salepending: false
          }
        }
        const all = []; let pg = 1, total = Infinity
        while (all.length < total && pg <= 50) {
          const r = await fetch(buildUrl(pg), { credentials: 'include', headers: { 'Accept': 'application/json, text/plain, */*' } })
          if (!r.ok) break
          const d = await r.json().catch(() => null)
          if (!d) break
          total = Number(d?.summary?.total_vehicles) || all.length
          const res = Array.isArray(d?.results) ? d.results : []
          if (!res.length) break
          all.push(...res.map(mapV)); pg++
          // Report pagination progress so the popup can show a live percentage.
          try {
            chrome.runtime.sendMessage({
              type: 'CAPTURE_PROGRESS', feed_id: window.__marketsyncFeedId || null,
              phase: 'scanning', current: all.length, total: Number.isFinite(total) ? total : all.length
            })
          } catch {}
        }
        if (all.length) {
          result = { platform: 'convertus', source_url: buildUrl(1), vehicles: all }
          log(`✓ matched convertus — ${all.length} vehicles`)
        }
      }
    } catch (e) { log('convertus probe failed:', e.message) }
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

  // Signal the upload phase so the popup's progress reflects "almost done".
  try {
    chrome.runtime.sendMessage({
      type: 'CAPTURE_PROGRESS', feed_id: window.__marketsyncFeedId || null,
      phase: 'uploading', current: result.vehicles.length, total: result.vehicles.length
    })
  } catch {}

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
