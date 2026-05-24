const API = 'https://vehicle-marketplace-s0e4.onrender.com'

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
    } catch (e) {
      $('login-error').textContent = 'Connection error. Try again.'
      $('login-btn').disabled = false
      $('login-btn').textContent = 'Sign In'
    }
  })

  // Allow Enter key to submit
  $('password').addEventListener('keydown', e => {
    if (e.key === 'Enter') $('login-btn').click()
  })
}

// ── Inventory Screen ──────────────────────────────
async function showInventoryScreen(token, user) {
  $('login-screen').style.display = 'none'
  $('inventory-screen').style.display = 'block'

  try {
    // Load profile
    const profile = await apiGet('/auth/me', token)
    $('header-name').textContent = profile.full_name || user.email
    $('header-dealer').textContent = profile.dealership?.name || ''
    
    // Load inventory
    await loadInventory(token)
  } catch (e) {
    if (e.message === 'SUBSCRIPTION_REQUIRED') {
      handleSubscriptionGate(token)
    } else {
      $('vehicle-list').innerHTML = `<div class="loading">⚠️ ${e.message || 'Error initializing screen.'}</div>`
    }
  }

  // Logout
  $('logout-btn').addEventListener('click', () => {
    chrome.storage.local.remove(['token', 'user'], () => {
      location.reload()
    })
  })

  // Refresh
  $('refresh-btn').addEventListener('click', () => loadInventory(token))
}

async function loadInventory(token) {
  $('vehicle-list').innerHTML = '<div class="loading">Loading inventory...</div>'

  try {
    const [inventory, listingsRes] = await Promise.all([
      apiGet('/inventory', token),
      apiGet('/listings', token)
    ])

    const listings = Array.isArray(listingsRes) ? listingsRes : []
    const postedVinSet = new Set(listings.map(l => l.inventory?.vin).filter(Boolean))

    $('stat-total').textContent = inventory.length
    $('stat-posted').textContent = postedVinSet.size
    $('stat-remaining').textContent = inventory.length - postedVinSet.size

    if (!inventory.length) {
      $('vehicle-list').innerHTML = `
        <div class="empty-state">
          <div class="icon">🚗</div>
          <p>No inventory found.<br>Add vehicles in your dashboard.</p>
        </div>`
      return
    }

    $('vehicle-list').innerHTML = inventory.map(v => {
      const isPosted = postedVinSet.has(v.vin)
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

    // Attach post button listeners
    document.querySelectorAll('.post-btn:not(.posted)').forEach(btn => {
      btn.addEventListener('click', () => postVehicle(btn.dataset.id, token))
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
      <p style="font-weight: bold; margin: 4px 0; color: #333;">Subscription Inactive</p>
      <p style="font-size: 11px; color: #666; margin-bottom: 14px; line-height: 1.4;">Please activate your dealership plan to access sync features.</p>
      <button id="ui-manage-billing-btn" style="background: #635bff; color: white; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer; font-weight: bold; width: 85%; font-size: 12px;">
        Manage Account & Billing
      </button>
    </div>`

  $('ui-manage-billing-btn').addEventListener('click', async () => {
    const btn = $('ui-manage-billing-btn')
    btn.textContent = 'Connecting to Stripe...'
    btn.disabled = true

    try {
      // 1. Try fetching Customer Billing Portal session link
      let r = await fetch(`${API}/billing/portal`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` }
      })
      
      // 2. If 400 is returned, user lacks a stripe_customer_id profile. Drop back to fresh checkout path.
      if (r.status === 400 || !r.ok) {
        r = await fetch(`${API}/billing/checkout`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}` }
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
  })
}

// ── Post to Facebook ──────────────────────────────
async function postVehicle(inventoryId, token) {
  const btn = document.querySelector(`.post-btn[data-id="${inventoryId}"]`)
  btn.classList.add('posting')
  btn.textContent = 'Opening...'
  btn.disabled = true

  const vehicle = await apiGet(`/inventory/${inventoryId}`, token)

  // Pre-download all photos immediately so they're ready in Downloads
  if (vehicle.image_urls?.length) {
    vehicle.image_urls.forEach((url, i) => {
      const a = document.createElement('a')
      a.href = `${API}/proxy-image?url=${encodeURIComponent(url)}`
      a.download = `${vehicle.year}_${vehicle.make}_${vehicle.model}_photo_${i + 1}.jpg`
        .replace(/\s+/g, '_')
      document.body.appendChild(a)
      setTimeout(() => { a.click(); document.body.removeChild(a) }, i * 400)
    })
  }
}