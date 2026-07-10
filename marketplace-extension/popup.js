const API = 'https://vehicle-marketplace-s0e4.onrender.com'
const DASHBOARD_BASE = 'https://marketsync.link/dashboard.html'

const $ = (id) => document.getElementById(id)

function setScreen(screen) {
  $('login-screen').classList.toggle('active', screen === 'login')
  $('register-screen').classList.toggle('active', screen === 'register')
  $('inventory-screen').classList.toggle('active', screen === 'inventory')
}

function formatPrice(p) {
  if (p === null || p === undefined || p === '') return 'N/A'
  return '$' + Number(p).toLocaleString()
}

// The backend runs on a tier that spins down when idle, so the first request
// after a lull can hang or return a 502/503/504 for ~30–60s while it wakes.
// Retry those (and timeouts) a few times with backoff so the popup self-heals
// instead of showing empty stats/inventory. 401/402 are never retried.
async function apiGet(path, token, { timeout = 20000, retries = 3 } = {}) {
  let lastErr
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeout)
    try {
      const r = await fetch(`${API}${path}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal
      })
      clearTimeout(timer)
      if (r.status === 401) {
        chrome.storage.local.remove(['token', 'user'])
        throw new Error('AUTH_EXPIRED — please sign in again')
      }
      if (r.status === 402) throw new Error('SUBSCRIPTION_REQUIRED')
      // Server waking up / gateway error → retry.
      if ([429, 500, 502, 503, 504].includes(r.status)) {
        lastErr = new Error(`Server status [${r.status}]`)
        if (attempt < retries) { await sleep(1000 * Math.pow(2, attempt)); continue }
        throw lastErr
      }
      const contentType = r.headers.get('content-type')
      if (!contentType || !contentType.includes('application/json')) {
        const textFallback = await r.text()
        console.error('Non-JSON response:', textFallback)
        throw new Error(`Server status [${r.status}]. Please try again in a moment.`)
      }
      return await r.json()
    } catch (e) {
      clearTimeout(timer)
      // Retry timeouts / network blips (but not auth/subscription errors).
      const transient = e.name === 'AbortError' || /Failed to fetch|NetworkError|Server status/.test(e.message || '')
      if (transient && !/AUTH_EXPIRED|SUBSCRIPTION_REQUIRED/.test(e.message || '') && attempt < retries) {
        lastErr = e
        await sleep(1000 * Math.pow(2, attempt))
        continue
      }
      if (e.name === 'AbortError') throw new Error('Server waking up — click Refresh in a moment')
      throw e
    }
  }
  throw lastErr || new Error('Request failed')
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

function handleSubscriptionGate(token) {
  $('stat-total').textContent = '0'
  $('stat-posted').textContent = 'Locked'
  $('stat-pending').textContent = 'Locked'
  $('stat-remaining').textContent = 'Locked'
  $('vehicle-list').innerHTML = `
    <div class="empty-state" style="padding:24px 12px;text-align:center;">
      <div style="color:#ff4d4d;font-size:24px;margin-bottom:8px;">💳</div>
      <p style="font-weight:bold;margin:4px 0;color:#fff;">Subscription Inactive</p>
      <p style="font-size:11px;color:#888;margin-bottom:14px;line-height:1.4;">Please activate your dealership plan to access sync features.</p>
      <button id="ui-manage-billing-btn" style="background:#3b82f6;color:white;border:none;padding:8px 16px;border-radius:4px;cursor:pointer;font-weight:bold;width:85%;font-size:12px;">Manage Account & Billing</button>
    </div>`
  $('ui-manage-billing-btn').addEventListener('click', async () => {
    const btn = $('ui-manage-billing-btn')
    btn.textContent = 'Connecting to Stripe...'
    btn.disabled = true
    try {
      let r = await fetch(`${API}/billing/portal`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
      })
      if (r.status === 400 || !r.ok) {
        r = await fetch(`${API}/billing/checkout`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
        })
      }
      const data = await r.json()
      if (data.url) chrome.tabs.create({ url: data.url })
      else { btn.textContent = 'Error loading gateway'; btn.disabled = false }
    } catch {
      btn.textContent = 'Connection Error'
      btn.disabled = false
    }
  })
}

// Returns a sort rank so list renders: New → Used/Demo → Posted → Pending → Sold
function vehicleSortRank(v, postedMap, soldMap) {
  const isPosted = postedMap.has(v.id)
  const isSold = soldMap.has(v.id)
  const status = String(v.status || 'available').toLowerCase()
  const cond = String(v.condition || '').toLowerCase()
  if (isSold || status === 'sold') return 40
  if (status === 'pending') return 30
  if (isPosted) return 20
  if (cond === 'new') return 0
  return 10 // used / demo / unknown
}

function applySearchFilter() {
  const q = (window.__msSearchQuery || '').trim().toLowerCase()
  const list = $('vehicle-list')
  if (!list) return
  const items = list.querySelectorAll('.vehicle-item')
  let visible = 0
  items.forEach(it => {
    const show = !q || it.textContent.toLowerCase().includes(q)
    it.style.display = show ? '' : 'none'
    if (show) visible++
  })
  let note = document.getElementById('search-no-results')
  if (q && visible === 0 && items.length) {
    if (!note) {
      note = document.createElement('div')
      note.id = 'search-no-results'
      note.style.cssText = 'padding:20px 12px;text-align:center;color:#888;font-size:12px;'
      list.appendChild(note)
    }
    note.textContent = `No vehicles match "${window.__msSearchQuery.trim()}".`
    note.style.display = ''
  } else if (note) {
    note.style.display = 'none'
  }
}

async function loadInventory(token) {
  $('vehicle-list').innerHTML = '<div class="loading">Loading inventory...</div>'

  try {
    const [inventoryRaw, listingsRes, soldListingsRes] = await Promise.all([
      apiGet('/inventory/all', token).catch(() => []),
      apiGet('/listings', token).catch(() => []),
      apiGet('/listings?status=sold', token).catch(() => [])
    ])
    const inventory = Array.isArray(inventoryRaw) ? inventoryRaw : []

    const listings = Array.isArray(listingsRes)
      ? listingsRes
      : (listingsRes && Array.isArray(listingsRes.data) ? listingsRes.data : [])

    const soldListings = Array.isArray(soldListingsRes)
      ? soldListingsRes
      : (soldListingsRes && Array.isArray(soldListingsRes.data) ? soldListingsRes.data : [])

    const postedMap = new Map()
    for (const l of listings) {
      const invId = l?.inventory_id || l?.inventory?.id
      if (invId && l?.id) postedMap.set(invId, {
        listingId: l.id, vehicle: l.inventory || null, fbUrl: l.fb_listing_url || null
      })
    }

    const soldMap = new Map()
    for (const l of soldListings) {
      const invId = l?.inventory_id || l?.inventory?.id
      if (invId && l?.id) soldMap.set(invId, {
        listingId: l.id, vehicle: l.inventory || null, fbUrl: l.fb_listing_url || null,
        fbSyncAction: l.fb_sync_action || null, fbSyncedAt: l.fb_synced_at || null,
        soldAt: l.sold_at || null, vehicleLabel: l.vehicle_label || null
      })
    }

    // Merged display list
    const seenIds = new Set(inventory.map(v => v.id))
    const displayList = [...inventory]
    for (const [invId, entry] of postedMap) {
      if (!seenIds.has(invId) && entry.vehicle) {
        displayList.push({ ...entry.vehicle, _outOfStock: true })
      }
    }

    const isAvail = (v) => String(v.status || 'available').toLowerCase() === 'available'
    const availableCount = inventory.filter(isAvail).length
    const postedInStock = inventory.filter(v => postedMap.has(v.id)).length
    const pendingCount = inventory.filter(v => String(v.status || '').toLowerCase() === 'pending').length

    $('stat-total').textContent = availableCount
    $('stat-posted').textContent = postedMap.size
    $('stat-pending').textContent = pendingCount
    $('stat-remaining').textContent = Math.max(0, availableCount - postedInStock)

    window.__msInvCache = { inventory, displayList, postedMap, soldMap, token }

    // Price-change detection: compare current prices against last-seen cache
    const priceCache = await new Promise(resolve =>
      chrome.storage.local.get('msPrice', d => resolve(d.msPrice || {}))
    )
    const newPriceCache = {}
    for (const v of displayList) {
      if (v.id && v.price != null) newPriceCache[v.id] = Number(v.price)
    }
    chrome.storage.local.set({ msPrice: newPriceCache })

    // Personal posting stats (derived from listings already fetched)
    const todayStr = new Date().toDateString()
    const postedToday = listings.filter(l => l.posted_at && new Date(l.posted_at).toDateString() === todayStr).length
    const statsEl = document.getElementById('my-stats-strip')
    if (statsEl) {
      statsEl.textContent = postedToday > 0
        ? `⚡ You posted ${postedToday} listing${postedToday === 1 ? '' : 's'} today · ${postedMap.size} total active`
        : `${postedMap.size} listing${postedMap.size === 1 ? '' : 's'} active on Facebook`
    }

    // Apply status filter
    const activeStatus = window.__msStatusFilter || 'all'
    const activeCond = window.__msCondFilter || 'all'
    const activeSeg = window.__msSegFilter || 'all'

    let filtered = displayList.filter(v => {
      const isPosted = postedMap.has(v.id)
      const isSold = soldMap.has(v.id)
      const status = String(v.status || 'available').toLowerCase()
      const cond = String(v.condition || '').toLowerCase()

      // status filter
      if (activeStatus === 'available' && (isPosted || isSold || status === 'sold' || status === 'pending')) return false
      if (activeStatus === 'posted' && !isPosted) return false
      if (activeStatus === 'pending' && status !== 'pending') return false
      if (activeStatus === 'sold' && !isSold && status !== 'sold') return false

      // condition filter
      if (activeCond !== 'all' && cond !== activeCond) return false

      // segment filter
      if (activeSeg !== 'all') {
        const mm = `${v.make} ${v.model}`.toLowerCase()
        if (activeSeg === 'hot' && !window.__msHotMakeModels?.has(mm)) return false
        if (activeSeg === 'cold' && !window.__msColdMakeModels?.has(mm)) return false
      }

      return true
    })

    // Sort: New → Used/Demo → Posted → Pending → Sold
    filtered.sort((a, b) => vehicleSortRank(a, postedMap, soldMap) - vehicleSortRank(b, postedMap, soldMap))

    if (!filtered.length) {
      $('vehicle-list').innerHTML = `
        <div class="empty-state" style="padding:24px 12px;text-align:center;">
          <div style="font-size:28px;margin-bottom:8px;">🚗</div>
          <p style="color:#aaa;">No vehicles match the current filters.</p>
        </div>`
      return
    }

    // Banners
    const cleanupNeeded = displayList.filter(v => v._outOfStock && postedMap.has(v.id))
    const soldNeedingFbDelete = soldListings.filter(l => l.fb_listing_url && !l.fb_synced_at)

    let soldBanner = ''
    if (soldMap.size > 0) {
      const needsFbDelete = soldNeedingFbDelete.length
      soldBanner = `
        <div id="sold-listings-banner" style="background:#1a1a2e;border:1px solid #6366f1;border-radius:8px;padding:12px;margin:10px 12px;">
          <div style="display:flex;align-items:flex-start;gap:8px;margin-bottom:${needsFbDelete ? '10px' : '0'};">
            <span style="font-size:18px;line-height:1;">🏷️</span>
            <div style="flex:1;">
              <div style="font-size:13px;font-weight:700;color:#fff;">${soldMap.size} vehicle${soldMap.size === 1 ? '' : 's'} marked sold</div>
              ${needsFbDelete
                ? `<div style="font-size:11px;color:#a5b4fc;margin-top:2px;line-height:1.4;">⚠️ ${needsFbDelete} still need${needsFbDelete === 1 ? 's' : ''} to be removed from Facebook Marketplace</div>`
                : `<div style="font-size:11px;color:#6ee7b7;margin-top:2px;">✓ All sold listings removed from Facebook</div>`
              }
            </div>
          </div>
          ${needsFbDelete ? `
          <button id="open-sold-fb-listings" style="background:#6366f1;color:#fff;border:none;padding:8px 12px;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer;width:100%;">
            Open ${needsFbDelete === 1 ? 'listing' : `${needsFbDelete} listings`} on Facebook to delete
          </button>` : ''}
        </div>`
    }

    let cleanupBanner = ''
    if (cleanupNeeded.length > 0) {
      cleanupBanner = `
        <div id="cleanup-banner" style="background:#3a1a1a;border:1px solid #ef4444;border-radius:8px;padding:12px;margin:10px 12px;">
          <div style="display:flex;align-items:flex-start;gap:8px;margin-bottom:10px;">
            <span style="font-size:18px;line-height:1;">⚠️</span>
            <div style="flex:1;">
              <div style="font-size:13px;font-weight:700;color:#fff;">${cleanupNeeded.length} sold ${cleanupNeeded.length === 1 ? 'listing needs' : 'listings need'} FB cleanup</div>
              <div style="font-size:11px;color:#fca5a5;margin-top:2px;line-height:1.4;">These vehicles are no longer in your inventory but may still be live on Facebook Marketplace.</div>
            </div>
          </div>
          <button id="cleanup-fb-open-all" style="background:#ef4444;color:#fff;border:none;padding:8px 12px;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer;width:100%;">Open ${cleanupNeeded.length === 1 ? 'listing' : 'all'} on Facebook</button>
        </div>`
    }

    // Render vehicles grouped by rank section
    let lastRank = -1
    const groupLabels = { 0: 'New', 10: 'Used / Demo', 20: 'Posted on Facebook', 30: 'Pending', 40: 'Sold' }

    const rows = filtered.map(v => {
      const entry = postedMap.get(v.id)
      const soldEntry = soldMap.get(v.id)
      const listingId = entry?.listingId
      const isPosted = !!listingId
      const isSold = !!soldEntry && !isPosted
      const img = v.image_urls?.[0]
      const rank = vehicleSortRank(v, postedMap, soldMap)

      const thumb = img
        ? `<img class="vehicle-thumb" src="${img}" onerror="this.style.display='none'">`
        : `<div class="vehicle-thumb" style="display:flex;align-items:center;justify-content:center;flex-shrink:0;background:#1a1a1a;font-size:18px;">🚗</div>`

      const vehName = `${v.year || ''} ${v.make || ''} ${v.model || ''}`.trim()
      const fbUrl = entry?.fbUrl || ''
      const status = String(v.status || 'available').toLowerCase()
      const available = status === 'available'

      // Days on lot (from first-sync date — best available approximation)
      const daysOnLot = v.created_at
        ? Math.floor((Date.now() - new Date(v.created_at)) / 86400000)
        : null
      const daysLabel = daysOnLot !== null
        ? (daysOnLot === 0 ? 'Today' : `${daysOnLot}d on lot`)
        : ''

      // Price change indicator vs last-seen price
      const prevPrice = priceCache[v.id]
      const currPrice = Number(v.price)
      let priceChangeBadge = ''
      if (prevPrice !== undefined && !isNaN(currPrice) && prevPrice !== currPrice) {
        const diff = currPrice - prevPrice
        const pct = Math.abs(Math.round((diff / prevPrice) * 100))
        priceChangeBadge = diff < 0
          ? `<span style="color:#22c55e;font-size:10px;font-weight:700;">↓ ${pct}%</span>`
          : `<span style="color:#ef4444;font-size:10px;font-weight:700;">↑ ${pct}%</span>`
      }

      // "View on FB" button only when we have an actual item URL (not create/other pages)
      const isValidFbUrl = url => url && /facebook\.com\/marketplace\/item\/\d+/i.test(url)
      const viewFbBtn = isPosted && isValidFbUrl(fbUrl)
        ? `<button class="open-fb-btn" data-fb-url="${fbUrl}" style="background:none;border:1px solid #3b82f6;color:#3b82f6;padding:3px 8px;border-radius:5px;font-size:10px;font-weight:600;cursor:pointer;white-space:nowrap;">View ↗</button>`
        : ''

      const openFbBtn = (isPosted && v._outOfStock)
        ? `<button class="open-fb-btn" data-fb-url="${fbUrl}" style="background:#1e3a5f;border:1px solid #3b82f6;color:#93c5fd;padding:5px 10px;border-radius:6px;font-size:11px;font-weight:600;cursor:pointer;white-space:nowrap;flex-shrink:0;margin-bottom:4px;">Open on FB</button>`
        : ''

      const pendingBadge = status === 'pending'
        ? `<span style="background:#1c1400;border:1px solid #fbbf24;color:#fbbf24;padding:2px 8px;border-radius:4px;font-size:10px;font-weight:700;text-align:center;">PENDING</span>`
        : ''
      const soldBtns = `<div style="display:flex;flex-direction:column;gap:3px;align-items:stretch;">
        ${pendingBadge}
        ${viewFbBtn}
        <button class="sold-by-me-btn" data-listing-id="${listingId}" data-vehicle-name="${vehName}" data-fb-url="${fbUrl}" style="background:#14532d;border:1px solid #22c55e;color:#86efac;padding:4px 8px;border-radius:6px;font-size:10px;font-weight:700;cursor:pointer;white-space:nowrap;">🤝 I Sold It</button>
        <button class="sold-on-fb-btn" data-listing-id="${listingId}" data-vehicle-name="${vehName}" data-fb-url="${fbUrl}" style="background:#172554;border:1px solid #3b82f6;color:#93c5fd;padding:4px 8px;border-radius:6px;font-size:10px;font-weight:700;cursor:pointer;white-space:nowrap;">📘 Sold on FB</button>
        <button class="sold-by-other-btn" data-listing-id="${listingId}" data-vehicle-name="${vehName}" style="background:#3a1a1a;border:1px solid #ef4444;color:#fca5a5;padding:4px 8px;border-radius:6px;font-size:10px;font-weight:600;cursor:pointer;white-space:nowrap;">🔄 Someone Else</button>
      </div>`

      const statusBadge = `<span style="background:#1f2937;border:1px solid #374151;color:${status === 'sold' ? '#9ca3af' : '#fbbf24'};padding:4px 10px;border-radius:6px;font-size:10px;font-weight:700;text-transform:uppercase;white-space:nowrap;flex-shrink:0;">${status}</span>`

      const soldFbNotice = isSold && soldEntry?.fbUrl && !soldEntry?.fbSyncedAt
        ? `<div style="display:flex;flex-direction:column;gap:3px;align-items:flex-end;">
             <span style="background:#7f1d1d;color:#fca5a5;padding:2px 6px;border-radius:4px;font-size:10px;font-weight:700;">SOLD</span>
             <button class="delete-from-fb-btn" data-fb-url="${soldEntry.fbUrl}" style="background:#3a1a1a;border:1px solid #ef4444;color:#fca5a5;padding:4px 8px;border-radius:6px;font-size:10px;font-weight:600;cursor:pointer;white-space:nowrap;">🗑️ Delete from FB</button>
           </div>`
        : isSold
        ? `<span style="background:#1f2937;color:#6ee7b7;padding:2px 8px;border-radius:4px;font-size:10px;font-weight:700;">SOLD ✓</span>`
        : null

      const actionBtn = soldFbNotice !== null
        ? soldFbNotice
        : isPosted
        ? soldBtns
        : available
        ? `<button class="post-btn" data-id="${v.id}">Post</button>`
        : statusBadge

      // Condition badge on vehicle name line
      const condBadge = v.condition ? `<span style="font-size:9px;font-weight:700;text-transform:uppercase;color:#555;margin-left:4px;">${v.condition}</span>` : ''

      // Hot/cold segment tag
      const mm = `${v.make} ${v.model}`.toLowerCase()
      const segTag = window.__msHotMakeModels?.has(mm)
        ? `<span style="font-size:9px;font-weight:700;padding:1px 5px;border-radius:99px;background:#fff7ed;color:#c2410c;margin-left:4px;">🔥 Hot</span>`
        : window.__msColdMakeModels?.has(mm)
          ? `<span style="font-size:9px;font-weight:700;padding:1px 5px;border-radius:99px;background:#f0f9ff;color:#0369a1;margin-left:4px;">❄️ Cold</span>`
          : ''

      // Group divider
      let divider = ''
      if (rank !== lastRank && groupLabels[rank]) {
        divider = `<div class="group-divider">${groupLabels[rank]}</div>`
        lastRank = rank
      }

      const stockNum = v.stock_number || v.stocknumber
      const subParts = [
        stockNum ? `#${stockNum}` : null,
        v.trim,
        v.mileage ? v.mileage.toLocaleString() + ' km' : null,
        daysLabel
      ].filter(Boolean)

      return `${divider}
        <div class="vehicle-item" data-id="${v.id}">
          ${thumb}
          <div class="vehicle-info">
            <div class="vehicle-name">${vehName}${condBadge}${segTag}</div>
            <div class="vehicle-sub">${subParts.join(' · ')}</div>
          </div>
          <div style="display:flex;flex-direction:column;align-items:flex-end;gap:2px;">
            <div style="display:flex;align-items:center;gap:5px;">
              ${priceChangeBadge}
              <div class="vehicle-price">${formatPrice(v.price)}</div>
            </div>
            ${openFbBtn}
            ${actionBtn}
          </div>
        </div>`
    }).join('')

    $('vehicle-list').innerHTML = soldBanner + cleanupBanner + rows

    // Wire up buttons
    document.querySelectorAll('.post-btn').forEach(btn => {
      btn.addEventListener('click', () => postVehicle(btn.dataset.id, token))
    })
    document.querySelectorAll('.sold-by-me-btn').forEach(btn => {
      btn.addEventListener('click', () => markSold(btn.dataset.listingId, btn.dataset.vehicleName, token, 'sold-by-me', btn.dataset.fbUrl))
    })
    document.querySelectorAll('.sold-on-fb-btn').forEach(btn => {
      btn.addEventListener('click', () => markSold(btn.dataset.listingId, btn.dataset.vehicleName, token, 'sold-on-fb', btn.dataset.fbUrl))
    })
    document.querySelectorAll('.sold-by-other-btn').forEach(btn => {
      btn.addEventListener('click', () => markSold(btn.dataset.listingId, btn.dataset.vehicleName, token, 'sold-by-other'))
    })
    document.getElementById('cleanup-fb-open-all')?.addEventListener('click', () => {
      const isValidUrl = url => url && /facebook\.com\/marketplace\/item\//.test(url)
      cleanupNeeded.forEach(v => {
        const entry = postedMap.get(v.id)
        const url = isValidUrl(entry?.fbUrl) ? entry.fbUrl : 'https://www.facebook.com/marketplace/you/selling'
        chrome.tabs.create({ url, active: false })
      })
    })
    document.querySelectorAll('.open-fb-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const url = btn.dataset.fbUrl && /facebook\.com\/marketplace\/item\/\d+/i.test(btn.dataset.fbUrl)
          ? btn.dataset.fbUrl : 'https://www.facebook.com/marketplace/you/selling'
        chrome.tabs.create({ url })
      })
    })
    document.querySelectorAll('.delete-from-fb-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const url = btn.dataset.fbUrl && /facebook\.com\/marketplace\/item\/\d+/i.test(btn.dataset.fbUrl)
          ? btn.dataset.fbUrl : 'https://www.facebook.com/marketplace/you/selling'
        chrome.tabs.create({ url })
      })
    })
    document.getElementById('open-sold-fb-listings')?.addEventListener('click', () => {
      soldNeedingFbDelete.forEach(l => {
        const url = l.fb_listing_url && /facebook\.com\/marketplace\/item\/\d+/i.test(l.fb_listing_url)
          ? l.fb_listing_url : 'https://www.facebook.com/marketplace/you/selling'
        chrome.tabs.create({ url, active: false })
      })
    })

    applySearchFilter()
  } catch (e) {
    if (e.message === 'SUBSCRIPTION_REQUIRED') {
      handleSubscriptionGate(token)
    } else {
      $('vehicle-list').innerHTML = `<div class="loading">⚠️ ${e.message || 'Error loading inventory.'}<br><br>Click Refresh to try again.</div>`
    }
  }
}

async function showInventoryScreen(token, user) {
  setScreen('inventory')
  $('header-name').textContent = user.email
  $('header-dealer').textContent = 'Loading profile...'

  loadInventory(token)
  renderGuardrail(token)

  apiGet('/auth/me', token)
    .then(profile => {
      if (profile) {
        $('header-name').textContent = profile.full_name || user.email
        $('header-dealer').textContent = profile.dealership?.name || ''
      }
    })
    .catch(err => {
      console.warn('Profile load error:', err.message)
      if (err.message === 'SUBSCRIPTION_REQUIRED') handleSubscriptionGate(token)
    })

  apiGet('/ai/config', token)
    .then(cfg => {
      if (cfg?.ai_boost_active) {
        const badge = $('ai-boost-badge')
        if (badge) badge.classList.add('visible')
      }
    })
    .catch(() => {})

  $('logout-btn').onclick = () => chrome.storage.local.remove(['token', 'user'], () => location.reload())
  $('refresh-btn').onclick = () => { loadInventory(token); renderGuardrail(token) }

  $('open-dashboard-btn').onclick = () => {
    chrome.storage.local.get(['token'], ({ token }) => {
      const url = token ? `${DASHBOARD_BASE}#tk=${encodeURIComponent(token)}` : DASHBOARD_BASE
      chrome.tabs.create({ url })
    })
  }

  // Status filter pills
  document.querySelectorAll('[data-status]').forEach(btn => {
    btn.addEventListener('click', () => {
      window.__msStatusFilter = btn.dataset.status
      document.querySelectorAll('[data-status]').forEach(b => {
        b.classList.toggle('active', b === btn)
      })
      loadInventory(token)
    })
  })

  // Condition filter pills
  document.querySelectorAll('[data-cond]').forEach(btn => {
    btn.addEventListener('click', () => {
      window.__msCondFilter = btn.dataset.cond
      document.querySelectorAll('[data-cond]').forEach(b => {
        b.classList.toggle('active', b === btn)
      })
      loadInventory(token)
    })
  })

  // Segment filter pills
  document.querySelectorAll('[data-seg]').forEach(btn => {
    btn.addEventListener('click', () => {
      window.__msSegFilter = btn.dataset.seg
      document.querySelectorAll('[data-seg]').forEach(b => {
        b.classList.toggle('active', b === btn)
      })
      loadInventory(token)
    })
  })

  // Pre-fetch intel caches for hot/cold segment filter
  apiGet('/ai/inventory-intelligence', token)
    .then(data => {
      if (!data || !data.hot_segments) return
      window.__msHotMakeModels = new Set((data.hot_segments || []).map(s => `${s.make} ${s.model}`.toLowerCase()))
      window.__msColdMakeModels = new Set((data.cold_segments || []).map(s => `${s.make} ${s.model}`.toLowerCase()))
      if (window.__msHotMakeModels.size > 0 || window.__msColdMakeModels.size > 0) {
        document.getElementById('segment-filter-row')?.classList.remove('hidden')
      }
    })
    .catch(() => {})

  // Search
  const searchInput = $('search-input')
  const searchWrap = $('search-wrap')
  const searchClear = $('search-clear')
  if (searchInput) {
    searchInput.value = window.__msSearchQuery || ''
    searchWrap?.classList.toggle('has-value', !!searchInput.value)
    searchInput.addEventListener('input', () => {
      window.__msSearchQuery = searchInput.value
      searchWrap?.classList.toggle('has-value', !!searchInput.value)
      applySearchFilter()
    })
    searchClear?.addEventListener('click', () => {
      searchInput.value = ''
      window.__msSearchQuery = ''
      searchWrap?.classList.remove('has-value')
      applySearchFilter()
      searchInput.focus()
    })
  }

  checkExtensionSyncNeeded(token)

  // Reflect any in-flight capture as soon as the panel opens.
  chrome.storage.local.get(['captureState'], ({ captureState }) => renderCaptureProgress(captureState))

  if (!window.__msCaptureWatch) {
    window.__msCaptureWatch = true
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes.captureState) return
      const s = changes.captureState.newValue
      renderCaptureProgress(s)
      if (s?.status === 'done') {
        checkExtensionSyncNeeded(token)
        loadInventory(token)
      }
    })
  }
}

// Render the live progress bar from the background's captureState.
function renderCaptureProgress(s) {
  const box  = $('ms-progress')
  if (!box) return
  const fill = $('ms-progress-fill')
  const pctEl = $('ms-progress-pct')
  const labelEl = $('ms-progress-label')
  const subEl = $('ms-progress-sub')

  if (!s || (s.status !== 'pulling' && s.status !== 'done' && s.status !== 'error')) {
    box.style.display = 'none'
    return
  }
  // Auto-hide a finished/failed bar shortly after it lands.
  if (s.finishedAt && Date.now() - s.finishedAt > 6000) { box.style.display = 'none'; return }

  // A "pulling" read that hasn't finished in 3 minutes is stalled — the dealer
  // site is almost certainly blocking the read. Show that instead of a frozen 8%.
  if (s.status === 'pulling' && s.startedAt && Date.now() - s.startedAt > 180000) {
    box.style.display = 'block'
    if (fill) { fill.style.width = '100%'; fill.style.background = 'var(--red)' }
    if (pctEl) { pctEl.textContent = ''; }
    if (labelEl) labelEl.textContent = 'Inventory read stalled'
    if (subEl) subEl.textContent = 'The dealer site is blocking the read. Tap Refresh to retry, or it will catch up on the next scheduled sync.'
    return
  }

  box.style.display = 'block'
  let pct, label, sub = '', color = null
  if (s.status === 'done') {
    pct = 100
    label = 'Inventory captured'
    sub = s.count != null ? `${s.count} vehicle${s.count === 1 ? '' : 's'} synced to MarketSync` : 'Sync complete'
  } else if (s.status === 'error') {
    pct = 100; color = 'var(--red)'
    label = 'Capture failed'
    sub = s.error || 'Something went wrong — please try again.'
  } else {
    // pulling — use the reported pct, or a gentle indeterminate crawl.
    pct = (typeof s.pct === 'number') ? s.pct : 8
    const phase = (s.phase || 'scanning')
    label = phase === 'uploading' ? 'Uploading to MarketSync…'
          : phase === 'scanning'  ? 'Reading dealer inventory…'
          : 'Working…'
    if (s.total) sub = `${s.current || 0} of ${s.total} pages scanned`
    // Re-render once the stall threshold passes so a frozen read flips to the
    // "stalled" message without needing a storage event.
    if (s.startedAt) {
      const remaining = 180000 - (Date.now() - s.startedAt)
      if (remaining > 0) { clearTimeout(renderCaptureProgress._t); renderCaptureProgress._t = setTimeout(() => renderCaptureProgress(s), remaining + 500) }
    }
  }
  if (fill) { fill.style.width = `${pct}%`; if (color) fill.style.background = color }
  if (pctEl) { pctEl.textContent = `${pct}%`; if (color) pctEl.style.color = color }
  if (labelEl) labelEl.textContent = label
  if (subEl) subEl.textContent = sub
}

// Show the FB posting-safety status: posts today vs cap, and any cooldown.
async function renderGuardrail(token) {
  const el = $('ms-guardrail')
  if (!el) return
  let g
  try { g = await apiGet('/posting/guardrail', token) } catch { el.style.display = 'none'; return }
  if (!g || !g.enabled) { el.style.display = 'none'; return }

  let bg, color, icon, text
  if (g.reason === 'daily_limit') {
    bg = 'rgba(220,38,38,.10)'; color = 'var(--red)'; icon = '⛔'
    text = `Daily limit reached — ${g.posts_today}/${g.daily_cap} posts today`
  } else if (g.reason === 'cooldown') {
    const mins = Math.max(1, Math.ceil((g.cooldown_seconds || 0) / 60))
    bg = 'rgba(217,119,6,.10)'; color = 'var(--amber)'; icon = '⏳'
    text = `Posted ${g.burst_size || 5} in a row — quick ~${mins} min rest · ${g.posts_today}/${g.daily_cap} today`
  } else {
    bg = 'rgba(22,163,74,.10)'; color = 'var(--green)'; icon = '🛡️'
    const br = g.burst_remaining != null ? g.burst_remaining : (g.burst_size || 5)
    text = `Safe to post · ${br} before a short rest · ${g.remaining} of ${g.daily_cap} left today`
  }
  el.style.background = bg
  el.style.color = color
  el.innerHTML = `<span>${icon}</span><span>${text}</span>`
  el.style.display = 'flex'
}

async function checkExtensionSyncNeeded(token) {
  try {
    const r = await fetch(`${API}/inventory-feeds`, {
      headers: { 'Authorization': `Bearer ${token}` }
    })
    if (!r.ok) return
    const feeds = await r.json()
    const bar = $('premium-sync-bar')
    const candidates = (feeds || []).filter(f => {
      const flagged = f.platform === 'extension_capture'
        || f.platform === 'needs_extension_capture'
        || (f.feed_url && !f.platform)
      return flagged && !f.last_extension_sync_at
    })
    if (!candidates.length) { if (bar) bar.style.display = 'none'; return }
    if (!bar) return
    bar.style.display = 'block'

    const enableBtn = $('enable-oneclick-btn')
    const enableNote = $('enable-oneclick-note')
    if (enableBtn) {
      const broad = { origins: ['https://*/*'] }
      chrome.permissions.contains(broad, (has) => {
        if (has) {
          enableBtn.style.display = 'none'
          if (enableNote) enableNote.style.display = 'block'
        } else {
          enableBtn.style.display = 'block'
          if (enableNote) enableNote.style.display = 'none'
          enableBtn.onclick = async () => {
            enableBtn.disabled = true
            enableBtn.textContent = 'Requesting…'
            try {
              const granted = await chrome.permissions.request(broad)
              if (granted) {
                enableBtn.style.display = 'none'
                if (enableNote) enableNote.style.display = 'block'
              } else {
                enableBtn.disabled = false
                enableBtn.textContent = '⚡ Enable one-click capture from dashboard'
              }
            } catch {
              enableBtn.disabled = false
              enableBtn.textContent = '⚡ Enable one-click capture from dashboard'
            }
          }
        }
      })
    }
  } catch (e) {
    console.warn('checkExtensionSyncNeeded failed:', e.message)
  }
}

async function markSold(listingId, vehicleName, token, kind, fbUrl) {
  const msg = kind === 'sold-by-me'
    ? `You sold "${vehicleName}"? This credits you with the sale (500 pts).`
    : kind === 'sold-on-fb'
    ? `You sold "${vehicleName}" through the Facebook listing? Credits you with a bonus (750 pts).`
    : `Mark "${vehicleName}" sold by someone else? It'll be cleared but no points are awarded.`
  if (!confirm(msg)) return
  try {
    const r = await fetch(`${API}/listings/${listingId}/${kind}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` }
    })
    const data = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(data.error || 'Failed to mark sold')
    chrome.runtime.sendMessage({ type: 'FB_SYNC_NOW' })

    // Option A: open FB listing so rep can manually mark sold there
    // Option B: send message to content script to auto-click "Mark as Sold"
    if (fbUrl && /facebook\.com\/marketplace\/item\/\d+/i.test(fbUrl) && kind !== 'sold-by-other') {
      chrome.tabs.create({ url: fbUrl }, (tab) => {
        // Option B: once the tab loads, inject content script to click Mark as Sold
        chrome.tabs.onUpdated.addListener(function listener(tabId, info) {
          if (tabId === tab.id && info.status === 'complete') {
            chrome.tabs.onUpdated.removeListener(listener)
            chrome.tabs.sendMessage(tab.id, { type: 'MARK_SOLD_ON_FB' })
          }
        })
      })
    }

    loadInventory(token)
  } catch (err) {
    alert(`Could not mark sold: ${err.message}`)
  }
}

async function postVehicle(inventoryId, token) {
  const btn = document.querySelector(`.post-btn[data-id="${inventoryId}"]`)
  if (!btn) return

  // FB ban protection: check the rep hasn't hit the daily cap or is still in a
  // spacing cooldown before we open Facebook.
  try {
    const g = await apiGet('/posting/guardrail', token)
    if (g && g.enabled && !g.allowed) {
      if (g.reason === 'daily_limit') {
        alert(`Daily posting limit reached (${g.daily_cap}/day). This protects your Facebook account from posting-rate flags. Try again tomorrow.`)
      } else if (g.reason === 'cooldown') {
        const mins = Math.max(1, Math.ceil((g.cooldown_seconds || 0) / 60))
        alert(`You've posted ${g.burst_size || 5} in a row — take a quick ~${mins} min break, then you can post another batch. Short rests keep your Facebook account safe.`)
      } else {
        alert('Posting is paused by your dealership right now.')
      }
      return
    }
  } catch { /* guardrail check is best-effort — never block on a network hiccup */ }

  btn.classList.add('posting')
  btn.textContent = 'Generating AI copy...'
  btn.disabled = true
  try {
    const [vehicle, enriched, poster] = await Promise.all([
      apiGet(`/inventory/${inventoryId}`, token),
      fetch(`${API}/ai/enrich-listing`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ inventory_id: inventoryId })
      }).then(r => r.ok ? r.json() : null).catch(() => null),
      apiGet('/auth/me', token).catch(() => null)
    ])
    if (enriched?.copy) vehicle.ai_description = enriched.copy

    // Photo overlays: post the branded (phone/logo) photos when available. If the
    // dealer has overlays on but this vehicle isn't branded yet, generate now.
    if (Array.isArray(vehicle.branded_image_urls) && vehicle.branded_image_urls.length) {
      vehicle.image_urls = vehicle.branded_image_urls
    } else {
      try {
        btn.textContent = 'Branding photos...'
        const r = await fetch(`${API}/photos/brand/${inventoryId}`, {
          method: 'POST', headers: { Authorization: `Bearer ${token}` }
        })
        if (r.ok) {
          const d = await r.json()
          if (Array.isArray(d.branded_image_urls) && d.branded_image_urls.length) vehicle.image_urls = d.branded_image_urls
        }
      } catch { /* overlays off or unavailable — post the original photos */ }
    }

    btn.textContent = 'Opening Facebook...'
    chrome.storage.local.set({ pendingPost: { vehicle, token, poster } }, () => {
      chrome.tabs.create({ url: 'https://www.facebook.com/marketplace/create/vehicle' })
      window.close()
    })
  } catch (err) {
    console.error('Failed to prepare vehicle data:', err.message)
    btn.classList.remove('posting')
    btn.textContent = 'Post'
    btn.disabled = false
  }
}

function initLoginScreen() {
  $('login-btn').addEventListener('click', async () => {
    const email = $('email').value.trim()
    const password = $('password').value
    if (!email || !password) return
    $('login-btn').disabled = true
    $('login-btn').textContent = 'Signing in...'
    $('login-error').textContent = ''
    try {
      const r = await fetch(`${API}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
      })
      const data = await r.json()
      if (data.error) {
        $('login-error').textContent = data.error
        $('login-btn').disabled = false
        $('login-btn').textContent = 'Sign In'
        return
      }
      chrome.storage.local.set({ token: data.access_token, user: data.user }, () => {
        showInventoryScreen(data.access_token, data.user)
      })
    } catch {
      $('login-error').textContent = 'Connection error. Try again.'
      $('login-btn').disabled = false
      $('login-btn').textContent = 'Sign In'
    }
  })
  $('go-to-register-btn').addEventListener('click', () => setScreen('register'))
}

function initRegisterScreen() {
  $('go-to-login-btn').addEventListener('click', () => setScreen('login'))
  $('submit-register-btn').addEventListener('click', async () => {
    const btn = $('submit-register-btn')
    const errorEl = $('reg-error')
    const successEl = $('reg-success')
    errorEl.textContent = ''
    successEl.textContent = ''
    btn.disabled = true
    btn.textContent = 'Registering...'
    const feedUrl = $('reg-feed').value.trim()
    const payload = {
      accountRole: 'dealer_admin',
      fullName: $('reg-fullname').value.trim(),
      email: $('reg-email').value.trim(),
      password: $('reg-password').value,
      dealershipName: $('reg-dealername').value.trim(),
      websiteUrl: $('reg-website').value.trim(),
      feeds: feedUrl ? [{ type: 'all', url: feedUrl }] : []
    }
    try {
      const r = await fetch(`${API}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      })
      const data = await r.json()
      if (!r.ok) throw new Error(data.error || 'Registration failed')
      successEl.textContent = 'Account created. Sign in to continue.'
      btn.textContent = 'Success!'
      setTimeout(() => setScreen('login'), 1200)
    } catch (err) {
      errorEl.textContent = err.message
      btn.disabled = false
      btn.textContent = 'Submit & Verify Email'
    }
  })
}

let __popupToken = null

document.addEventListener('DOMContentLoaded', () => {
  initLoginScreen()
  initRegisterScreen()
  chrome.storage.local.get(['token', 'user'], ({ token, user }) => {
    __popupToken = token || null
    if (token && user) {
      showInventoryScreen(token, user)
      chrome.runtime.sendMessage({ type: 'FB_SYNC_NOW' })
    } else {
      setScreen('login')
    }
  })
})

// Live-refresh the popup when auth changes in the background — e.g. the dashboard
// bridge just signed us in (passkey login) or the user signed out elsewhere — so the
// open popup updates itself instead of needing a close-and-reopen.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.token) return
  const newTok = changes.token.newValue || null
  if (newTok === __popupToken) return
  __popupToken = newTok
  if (newTok) {
    chrome.storage.local.get(['user'], ({ user }) => {
      showInventoryScreen(newTok, user)
      chrome.runtime.sendMessage({ type: 'FB_SYNC_NOW' })
    })
  } else {
    setScreen('login')
  }
})
