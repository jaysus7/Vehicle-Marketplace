const API = 'https://vehicle-marketplace-s0e4.onrender.com'

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

async function apiGet(path, token, timeout = 60000) {
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

    if (r.status === 402) {
      throw new Error('SUBSCRIPTION_REQUIRED')
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
    if (e.name === 'AbortError') throw new Error('Server waking up — click Refresh in a moment')
    throw e
  }
}

function handleSubscriptionGate(token) {
  $('stat-total').textContent = '0'
  $('stat-posted').textContent = 'Locked'
  $('stat-remaining').textContent = 'Locked'

  $('vehicle-list').innerHTML = `
    <div class="empty-state" style="padding: 24px 12px; text-align:center;">
      <div style="color:#ff4d4d; font-size:24px; margin-bottom:8px;">💳</div>
      <p style="font-weight:bold; margin:4px 0; color:#fff;">Subscription Inactive</p>
      <p style="font-size:11px; color:#888; margin-bottom:14px; line-height:1.4;">Please activate your dealership plan to access sync features.</p>
      <button id="ui-manage-billing-btn" style="background:#3b82f6; color:white; border:none; padding:8px 16px; border-radius:4px; cursor:pointer; font-weight:bold; width:85%; font-size:12px;">Manage Account & Billing</button>
    </div>`

  $('ui-manage-billing-btn').addEventListener('click', async () => {
    const btn = $('ui-manage-billing-btn')
    btn.textContent = 'Connecting to Stripe...'
    btn.disabled = true

    try {
      let r = await fetch(`${API}/billing/portal`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      })

      if (r.status === 400 || !r.ok) {
        r = await fetch(`${API}/billing/checkout`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json'
          }
        })
      }

      const data = await r.json()
      if (data.url) chrome.tabs.create({ url: data.url })
      else {
        btn.textContent = 'Error loading gateway'
        btn.disabled = false
      }
    } catch {
      btn.textContent = 'Connection Error'
      btn.disabled = false
    }
  })
}

async function loadInventory(token) {
  $('vehicle-list').innerHTML = '<div class="loading">Loading inventory...</div>'

  try {
    const [inventory, listingsRes] = await Promise.all([
  apiGet('/inventory', token),
  apiGet('/listings', token).catch(() => [])
])

    const listings = Array.isArray(listingsRes)
      ? listingsRes
      : (listingsRes && Array.isArray(listingsRes.data) ? listingsRes.data : [])

    // Map inventory_id -> { listingId, vehicle, fbUrl } so posted vehicles stay visible
    // even after their inventory status changes (e.g. dealer feed dropped them).
    const postedMap = new Map()
    for (const l of listings) {
      const invId = l?.inventory_id || l?.inventory?.id
      if (invId && l?.id) postedMap.set(invId, {
        listingId: l.id,
        vehicle: l.inventory || null,
        fbUrl: l.fb_listing_url || null
      })
    }

    // Merged display list: all currently-available inventory + any posted vehicles
    // that have fallen out of available inventory (so user can still Mark Sold).
    const seenIds = new Set(inventory.map(v => v.id))
    const displayList = [...inventory]
    for (const [invId, entry] of postedMap) {
      if (!seenIds.has(invId) && entry.vehicle) {
        displayList.push({ ...entry.vehicle, _outOfStock: true })
      }
    }

    const postedInStock = inventory.filter(v => postedMap.has(v.id)).length
    $('stat-total').textContent = inventory.length
    $('stat-posted').textContent = postedMap.size
    $('stat-remaining').textContent = Math.max(0, inventory.length - postedInStock)

    // Cache the fully-merged dataset so the category-filter buttons can re-render
    // instantly without re-fetching from the API. The active category lives in
    // window.__msActiveCat and the renderer reads it on every paint.
    window.__msInvCache = { inventory, displayList, postedMap, token }

    // Apply the active category filter to the display list before rendering.
    // Category values come from the .cat-btn data-cat attribute: 'all'|'New'|'Used'|'Demo'.
    const activeCat = window.__msActiveCat || 'all'
    const filtered = activeCat === 'all'
      ? displayList
      : displayList.filter(v => {
          // Loose match — feed conditions vary ("New" / "NEW" / "new").
          const c = String(v.condition || '').toLowerCase()
          return c === activeCat.toLowerCase()
        })

    if (!filtered.length) {
      $('vehicle-list').innerHTML = `
        <div class="empty-state" style="padding: 24px 12px; text-align:center;">
          <div class="icon">🚗</div>
          <p>No <strong>${activeCat === 'all' ? '' : activeCat + ' '}</strong>vehicles found.<br>${activeCat === 'all' ? 'Add vehicles in your dashboard.' : 'Try another category.'}</p>
        </div>`
      return
    }

    // "Needs FB cleanup" — vehicles posted on FB but no longer in stock here.
    // Build the banner first so it appears above the list.
    const cleanupNeeded = displayList.filter(v => v._outOfStock && postedMap.has(v.id))
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

    $('vehicle-list').innerHTML = cleanupBanner + filtered.map(v => {
      const entry = postedMap.get(v.id)
      const listingId = entry?.listingId
      const isPosted = !!listingId
      const img = v.image_urls?.[0]
      const thumb = img
        ? `<img class="vehicle-thumb" src="${img}" onerror="this.style.display='none'">`
        : `<div class="vehicle-thumb-placeholder" style="width:52px;height:38px;border-radius:6px;background:#1a1a1a;display:flex;align-items:center;justify-content:center;flex-shrink:0;">🚗</div>`

      const vehName = `${v.year} ${v.make} ${v.model}`
      const fbUrl = entry?.fbUrl || ''
      const openFbBtn = (isPosted && v._outOfStock)
        ? `<button class="open-fb-btn" data-fb-url="${fbUrl}" style="background:#1e3a5f;border:1px solid #3b82f6;color:#93c5fd;padding:5px 10px;border-radius:6px;font-size:11px;font-weight:600;cursor:pointer;white-space:nowrap;flex-shrink:0;margin-bottom:4px;">Open on FB</button>`
        : ''
      // Two sold actions: "I Sold It" (awards points to this rep) vs "Sold by Other" (just clears the listing).
      const actionBtn = isPosted
        ? `<div style="display:flex;flex-direction:column;gap:3px;">
             <button class="sold-by-me-btn"    data-listing-id="${listingId}" data-vehicle-name="${vehName}" style="background:#14532d;border:1px solid #22c55e;color:#86efac;padding:4px 8px;border-radius:6px;font-size:10px;font-weight:700;cursor:pointer;white-space:nowrap;flex-shrink:0;">🤝 I Sold It</button>
             <button class="sold-by-other-btn" data-listing-id="${listingId}" data-vehicle-name="${vehName}" style="background:#3a1a1a;border:1px solid #ef4444;color:#fca5a5;padding:4px 8px;border-radius:6px;font-size:10px;font-weight:600;cursor:pointer;white-space:nowrap;flex-shrink:0;">🔄 Sold by Other</button>
           </div>`
        : `<button class="post-btn" data-id="${v.id}">Post</button>`

      const tagBits = []
      if (isPosted) tagBits.push('<span style="color:#22c55e;font-weight:600;">✓ POSTED</span>')
      if (v._outOfStock) tagBits.push('<span style="color:#fbbf24;font-weight:600;">OUT OF STOCK</span>')
      const tagLine = tagBits.length
        ? `<div style="font-size:10px;margin-bottom:3px;text-align:right;">${tagBits.join(' · ')}</div>`
        : ''

      return `
        <div class="vehicle-item" data-id="${v.id}">
          ${thumb}
          <div class="vehicle-info">
            <div class="vehicle-name">${vehName}</div>
            <div class="vehicle-sub">${v.trim || ''} · ${v.mileage ? v.mileage.toLocaleString() + ' km' : 'N/A'}</div>
          </div>
          <div style="display:flex;flex-direction:column;align-items:flex-end;gap:2px;">
            ${tagLine}
            <div class="vehicle-price">${formatPrice(v.price)}</div>
            ${openFbBtn}
            ${actionBtn}
          </div>
        </div>`
    }).join('')

    document.querySelectorAll('.post-btn').forEach(btn => {
      btn.addEventListener('click', () => postVehicle(btn.dataset.id, token))
    })
    document.querySelectorAll('.sold-by-me-btn').forEach(btn => {
      btn.addEventListener('click', () => markSold(btn.dataset.listingId, btn.dataset.vehicleName, token, 'sold-by-me'))
    })
    document.querySelectorAll('.sold-by-other-btn').forEach(btn => {
      btn.addEventListener('click', () => markSold(btn.dataset.listingId, btn.dataset.vehicleName, token, 'sold-by-other'))
    })
    document.getElementById('cleanup-fb-open-all')?.addEventListener('click', () => {
      // Open each affected FB listing — fall back to user's marketplace selling page if URL missing/invalid
      const isValidListingUrl = url => url && /facebook\.com\/marketplace\/item\//.test(url)
      cleanupNeeded.forEach(v => {
        const entry = postedMap.get(v.id)
        const url = isValidListingUrl(entry?.fbUrl) ? entry.fbUrl : 'https://www.facebook.com/marketplace/you/selling'
        chrome.tabs.create({ url, active: false })
      })
    })
    document.querySelectorAll('.open-fb-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const url = btn.dataset.fbUrl && /facebook\.com\/marketplace\/item\//.test(btn.dataset.fbUrl)
          ? btn.dataset.fbUrl
          : 'https://www.facebook.com/marketplace/you/selling'
        chrome.tabs.create({ url })
      })
    })
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

  // Defensive: never crash popup init if a button is missing from the HTML
  const logoutBtn = $('logout-btn')
  if (logoutBtn) {
    logoutBtn.onclick = () => {
      chrome.storage.local.remove(['token', 'user'], () => location.reload())
    }
  } else {
    console.warn('logout-btn missing from popup.html — sign out unavailable')
  }

  const refreshBtn = $('refresh-btn')
  if (refreshBtn) refreshBtn.onclick = () => loadInventory(token)

  // Category filter (All / New / Used / Demo) — re-renders the cached inventory
  // without re-fetching. Highlights the active button.
  document.querySelectorAll('.cat-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const cat = btn.dataset.cat || 'all'
      window.__msActiveCat = cat
      document.querySelectorAll('.cat-btn').forEach(b => b.classList.toggle('active', b === btn))
      // Re-render from cache. If the cache exists, just call loadInventory; it
      // will use the cached postedMap and re-paint quickly. If no cache yet,
      // loadInventory will fetch fresh.
      loadInventory(token)
    })
  })

  // Premium Sync — extension-side dealer site capture. Shown only when a feed
  // is flagged needs_extension_capture (e.g. Cloudflare blocked us server-side).
  checkExtensionSyncNeeded(token)
}

async function checkExtensionSyncNeeded(token) {
  try {
    const r = await fetch(`${API}/inventory-feeds`, {
      headers: { 'Authorization': `Bearer ${token}` }
    })
    if (!r.ok) return
    const feeds = await r.json()
    // Any feed that's never been captured OR was flagged as needing extension help
    const candidates = (feeds || []).filter(f =>
      f.platform === 'extension_capture'
      || f.platform === 'needs_extension_capture'
      || (f.feed_url && f.last_extension_sync_at === null && !f.platform)
    )
    if (!candidates.length) return

    const bar = $('premium-sync-bar')
    if (!bar) return
    bar.style.display = 'block'

    // The popup's ONLY job for Cloudflare dealers is the one-time "Enable one-click
    // capture" grant (Chrome requires the host-permission request to come from an
    // extension UI with a user gesture). The instructions, Pull Inventory button,
    // and progress all live on the dashboard now.
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

// kind = 'sold-by-me' (this rep closed the deal → 500 pts) | 'sold-by-other' (no points)
async function markSold(listingId, vehicleName, token, kind) {
  const isMine = kind === 'sold-by-me'
  const msg = isMine
    ? `You sold "${vehicleName}"? This credits you with the sale (500 pts).`
    : `Mark "${vehicleName}" sold by someone else? It'll be cleared but no points are awarded.`
  if (!confirm(msg)) return
  try {
    const r = await fetch(`${API}/listings/${listingId}/${kind}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` }
    })
    const data = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(data.error || 'Failed to mark sold')
    loadInventory(token)
  } catch (err) {
    alert(`Could not mark sold: ${err.message}`)
  }
}

async function postVehicle(inventoryId, token) {
  const btn = document.querySelector(`.post-btn[data-id="${inventoryId}"]`)
  if (!btn) return

  btn.classList.add('posting')
  btn.textContent = 'Opening...'
  btn.disabled = true

  try {
    const vehicle = await apiGet(`/inventory/${inventoryId}`, token)
    // Pull the rep's profile so we can stamp contact info on the FB description
    let poster = null
    try { poster = await apiGet('/auth/me', token) } catch {}

    // Photos are injected on the FB page by content.js (with a download fallback if injection fails).
    // No need to pre-download here.

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

  $('go-to-register-btn').addEventListener('click', () => {
    setScreen('register')
  })
}

function initRegisterScreen() {
  $('go-to-login-btn').addEventListener('click', () => {
    setScreen('login')
  })

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

document.addEventListener('DOMContentLoaded', () => {
  initLoginScreen()
  initRegisterScreen()

  chrome.storage.local.get(['token', 'user'], ({ token, user }) => {
    if (token && user) {
      showInventoryScreen(token, user)
    } else {
      setScreen('login')
    }
  })
})