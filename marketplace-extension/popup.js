const API = 'https://vehicle-marketplace-x0e4.onrender.com'

// ── Helpers ──────────────────────────────────────
const $ = id => document.getElementById(id)

async function apiGet(path, token, timeout = 60000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  try {
    const r = await fetch(`${API}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal
    })
    clearTimeout(timer)
    
    // ── AUTH & BILLING STATUS INTERCEPTS ──
    if (r.status === 401) {
      chrome.storage.local.remove(['token', 'user'])
      throw new Error('AUTH_EXPIRED — please sign in again')
    }
    if (r.status === 402) {
      throw new Error('SUBSCRIPTION_REQUIRED')
    }

    // ── HARDENED CONTENT-TYPE VALIDATION OVERHEAD ──
    const contentType = r.headers.get('content-type')
    if (!contentType || !contentType.includes('application/json')) {
      const textFallback = await r.text()
      console.error('Non-JSON response intercept context:', textFallback)
      throw new Error(`Server status [${r.status}]. Service winding up — click Refresh again in a moment.`)
    }
    
    return r.json()
  } catch (e) {
    clearTimeout(timer)
    if (e.name === 'AbortError') throw new Error('Server waking up — click Refresh in a moment')
    throw e
  }
}

async function apiPost(path, body, token) {
  const r = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body)
  })
  return r.json()
}

function formatPrice(p) {
  if (!p) return 'N/A'
  return '$' + Number(p).toLocaleString()
}

// ── Boot ─────────────────────────────────────────
chrome.storage.local.get(['token', 'user'], ({ token, user }) => {
  if (token && user) {
    showInventoryScreen(token, user)
  } else {
    showLoginScreen()
  }
})

// ── Login ─────────────────────────────────────────
function showLoginScreen() {
  $('login-screen').style.display = 'block'
  $('inventory-screen').style.display = 'none'

  // Handle Extension Direct Login Flow
  $('login-btn').onclick = async () => {
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
    } catch (e) {
      $('login-error').textContent = 'Connection error. Try again.'
      $('login-btn').disabled = false
      $('login-btn').textContent = 'Sign In'
    }
  }

  // Link out to hosted Render Registration flow via Chrome Tab API
  $('register-btn').onclick = () => {
    chrome.tabs.create({ url: 'https://vehicle-marketplace-frontend-stts.onrender.com/register.html' })
  }
}

// ── Inventory Screen ──────────────────────────────
async function showInventoryScreen(token, user) {
  $('login-screen').style.display = 'none'
  $('inventory-screen').style.display = 'block'

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
      console.warn('Non-blocking profile load error:', err.message)
      if (err.message === 'SUBSCRIPTION_REQUIRED') handleSubscriptionGate(token)
    })

  $('logout-btn').onclick = () => {
    chrome.storage.local.remove(['token', 'user'], () => {
      location.reload()
    })
  }

  $('refresh-btn').onclick = () => loadInventory(token)
}

async function loadInventory(token) {
  $('vehicle-list').innerHTML = '<div class="loading">Loading inventory...</div>'

  try {
    const [inventory, listingsRes] = await Promise.all([
      apiGet('/inventory', token),
      apiGet('/listings', token)
    ])

    const listings = Array.isArray(listingsRes) 
      ? listingsRes 
      : (listingsRes && Array.isArray(listingsRes.data) ? listingsRes.data : [])
    
    const postedIdSet = new Set(
      listings.map(l => {
        if (!l) return null
        return l.inventory_id || l.vehicle_id || (l.inventory && l.inventory.id)
      }).filter(Boolean)
    )

    $('stat-total').textContent = inventory.length
    $('stat-posted').textContent = postedIdSet.size
    $('stat-remaining').textContent = inventory.length - postedIdSet.size

    if (!inventory.length) {
      $('vehicle-list').innerHTML = `
        <div class="empty-state">
          <div class="icon">🚗</div>
          <p>No inventory found.<br>Add vehicles in your dashboard.</p>
        </div>`
      return
    }

    $('vehicle-list').innerHTML = inventory.map(v => {
      const isPosted = postedIdSet.has(v.id)
      const img = v.image_urls?.[0]
      const thumb = img
        ? `<img class="vehicle-thumb" src="${img}" onerror="this.style.display='none'">`
        : `<div class="vehicle-thumb-placeholder">🚗</div>`

      return `
        <div class="vehicle-item" data-id="${v.id}">
          ${thumb}
          <div class="vehicle-info">
            <div class="vehicle-name">${v.year} ${v.make} ${v.model}</div>
            <div class="vehicle-sub">${v.trim || ''} · ${v.mileage ? v.mileage.toLocaleString() + ' km' : 'N/A'}</div>
          </div>
          <div>
            <div class="vehicle-price">${formatPrice(v.price)}</div>
            <button class="post-btn ${isPosted ? 'posted' : ''}"
              data-id="${v.id}"
              data-vin="${v.vin || ''}"
              ${isPosted ? 'disabled' : ''}>
              ${isPosted ? '✓ Posted' : 'Post'}
            </button>
          </div>
        </div>`
    }).join('')

    document.querySelectorAll('.post-btn:not(.posted)').forEach(btn => {
      btn.onclick = () => postVehicle(btn.dataset.id, token)
    })

  } catch (e) {
    if (e.message === 'SUBSCRIPTION_REQUIRED') {
      handleSubscriptionGate(token)
    } else {
      $('vehicle-list').innerHTML = `<div class="loading">⚠️ ${e.message || 'Error loading inventory.'}<br><br>Click Refresh to try again.</div>`
    }
  }
}

// ── Subscription Gate Handler ─────────────────────
function handleSubscriptionGate(token) {
  $('stat-total').textContent = '0'
  $('stat-posted').textContent = 'Locked'
  $('stat-remaining').textContent = 'Locked'

  $('vehicle-list').innerHTML = `
    <div class="empty-state" style="padding: 24px 12px;">
      <div class="icon" style="color: #ff4d4d; font-size: 24px; margin-bottom: 8px;">💳</div>
      <p style="font-weight: bold; margin: 4px 0; color: #fff;">Subscription Inactive</p>
      <p style="font-size: 11px; color: #888; margin-bottom: 14px; line-height: 1.4;">Please activate your dealership plan to access sync features.</p>
      <button id="ui-manage-billing-btn" style="background: #3b82f6; color: white; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer; font-weight: bold; width: 85%; font-size: 12px;">
        Manage Account & Billing
      </button>
    </div>`

  $('ui-manage-billing-btn').onclick = async () => {
    const btn = $('ui-manage-billing-btn')
    btn.textContent = 'Connecting to Stripe...'
    btn.disabled = true

    try {
      let r = await fetch(`${API}/billing/portal`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
      })
      
      if (r.status === 400 || !r.ok) {
        r = await fetch(`${API}/billing/checkout`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
        })
      }

      const data = await r.json()
      if (data.url) {
        chrome.tabs.create({ url: data.url })
      } else {
        btn.textContent = 'Error loading gateway'
        btn.disabled = false
      }
    } catch (err) {
      btn.textContent = 'Connection Error'
      btn.disabled = false
    }
  }
}

// ── Post to Facebook ──────────────────────────────
async function postVehicle(inventoryId, token) {
  const btn = document.querySelector(`.post-btn[data-id="${inventoryId}"]`)
  btn.classList.add('posting')
  btn.textContent = 'Opening...'
  btn.disabled = true

  try {
    const vehicle = await apiGet(`/inventory/${inventoryId}`, token)

    if (vehicle.image_urls?.length) {
      vehicle.image_urls.forEach((url, i) => {
        const a = document.createElement('a')
        a.href = `${API}/proxy-image?url=${encodeURIComponent(url)}`
        a.download = `${vehicle.year}_${vehicle.make}_${vehicle.model}_photo_${i + 1}.jpg`.replace(/\s+/g, '_')
        document.body.appendChild(a)
        setTimeout(() => { a.click(); document.body.removeChild(a) }, i * 400)
      })
    }

    chrome.storage.local.set({ pendingPost: { vehicle, token } }, () => {
      chrome.tabs.create({ url: 'https://www.facebook.com/marketplace/create/vehicle' })
      window.close()
    })
  } catch (err) {
    console.error('Failed to prepare vehicle data for posting sequence:', err.message)
    btn.classList.remove('posting')
    btn.textContent = 'Post'
    btn.disabled = false
  }
}