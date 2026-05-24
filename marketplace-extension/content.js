// content.js — Vehicle Marketplace
const API = 'https://vehicle-marketplace-s0e4.onrender.com'
const DELAY = 600
const sleep = ms => new Promise(r => setTimeout(r, ms))

// ── Normalization maps ────────────────────────
const MAKE_MAP = {
  'chev': 'Chevrolet', 'chevy': 'Chevrolet', 'gmc': 'GMC',
  'buick': 'Buick', 'cadillac': 'Cadillac', 'ford': 'Ford',
  'dodge': 'Dodge', 'ram': 'Ram', 'chrysler': 'Chrysler',
  'jeep': 'Jeep', 'honda': 'Honda', 'toyota': 'Toyota',
  'nissan': 'Nissan', 'hyundai': 'Hyundai', 'kia': 'Kia',
  'volkswagen': 'Volkswagen', 'vw': 'Volkswagen', 'bmw': 'BMW',
  'mercedes': 'Mercedes-Benz', 'mercedes-benz': 'Mercedes-Benz',
  'audi': 'Audi', 'lexus': 'Lexus', 'acura': 'Acura',
  'infiniti': 'Infiniti', 'lincoln': 'Lincoln', 'mazda': 'Mazda',
  'mitsubishi': 'Mitsubishi', 'subaru': 'Subaru', 'volvo': 'Volvo',
  'tesla': 'Tesla', 'pontiac': 'Pontiac', 'saturn': 'Saturn'
}

const MODEL_MAP = {
  // Chevrolet trucks
  'silverado 1500': 'Silverado 1500',
  'silverado 2500hd': 'Silverado 2500HD',
  'silverado 2500': 'Silverado 2500HD',
  'silverado 3500hd': 'Silverado 3500HD',
  'silverado 3500': 'Silverado 3500HD',
  'silverado': 'Silverado 1500',
  'colorado': 'Colorado',
  // Chevrolet SUVs
  'equinox ev': 'Equinox EV',
  'equinox': 'Equinox',
  'traverse': 'Traverse',
  'tahoe': 'Tahoe',
  'suburban': 'Suburban',
  'blazer ev': 'Blazer EV',
  'blazer': 'Blazer',
  'trailblazer': 'Trailblazer',
  'trax': 'Trax',
  // Chevrolet cars/vans
  'bolt euv': 'Bolt EUV',
  'bolt ev': 'Bolt EV',
  'bolt': 'Bolt EV',
  'camaro': 'Camaro',
  'corvette': 'Corvette',
  'malibu': 'Malibu',
  'spark': 'Spark',
  'sonic': 'Sonic',
  'cruze': 'Cruze',
  'impala': 'Impala',
  'express': 'Express',
  // GMC trucks
  'sierra 1500': 'Sierra 1500',
  'sierra 2500hd': 'Sierra 2500HD',
  'sierra 2500': 'Sierra 2500HD',
  'sierra 3500hd': 'Sierra 3500HD',
  'sierra 3500': 'Sierra 3500HD',
  'sierra': 'Sierra 1500',
  'canyon': 'Canyon',
  'savana': 'Savana',
  // GMC SUVs
  'terrain': 'Terrain',
  'acadia': 'Acadia',
  'yukon xl': 'Yukon XL',
  'yukon': 'Yukon',
  'envoy': 'Envoy',
  // Buick
  'encore gx': 'Encore GX',
  'encore': 'Encore',
  'enclave': 'Enclave',
  'envision': 'Envision',
  'envista': 'Envista',
  'lacrosse': 'LaCrosse',
  'verano': 'Verano',
  'regal': 'Regal',
  'lesabre': 'LeSabre',
  'lucerne': 'Lucerne',
  // Cadillac
  'escalade esv': 'Escalade ESV',
  'escalade': 'Escalade',
  'xt4': 'XT4',
  'xt5': 'XT5',
  'xt6': 'XT6',
  'ct4': 'CT4',
  'ct5': 'CT5',
  'ct6': 'CT6',
  'lyriq': 'LYRIQ',
  'celestiq': 'CELESTIQ',
  'srx': 'SRX',
  'ats': 'ATS',
  'cts': 'CTS',
  'xts': 'XTS'
}

function normalizeMake(make) {
  if (!make) return make
  const key = make.toLowerCase().trim()
  return MAKE_MAP[key] || make
}

function normalizeModel(model) {
  if (!model) return model
  const key = model.toLowerCase().trim()
  if (MODEL_MAP[key]) return MODEL_MAP[key]
  // Try partial — longer keys first to avoid short key stealing
  const sortedKeys = Object.keys(MODEL_MAP).sort((a, b) => b.length - a.length)
  for (const k of sortedKeys) {
    if (key.includes(k)) return MODEL_MAP[k]
  }
  return model
}

// ── Utilities ─────────────────────────────────
async function waitFor(fn, timeout = 10000) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    const el = fn()
    if (el) return el
    await sleep(300)
  }
  return null
}

function getFormFields() {
  return [...document.querySelectorAll('input[type="text"], input[type="number"], textarea')]
    .filter(el => !el.closest('[aria-hidden="true"]'))
}

async function typeInto(el, value) {
  if (!el) return false
  el.click()
  el.focus()
  await sleep(200)
  const nativeInputSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
  const nativeTextareaSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
  const setter = el.tagName === 'TEXTAREA' ? nativeTextareaSetter : nativeInputSetter
  if (setter) setter.call(el, value)
  else el.value = value
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
  el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true }))
  el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }))
  await sleep(300)
  return true
}

async function pickDropdown(labelText, value) {
  const trigger = [...document.querySelectorAll('[role="combobox"]')]
    .find(el => el.textContent.trim().toLowerCase().includes(labelText.toLowerCase()))
  if (!trigger) { console.warn('Dropdown not found:', labelText); return false }

  trigger.scrollIntoView({ behavior: 'smooth', block: 'center' })
  await sleep(300)
  trigger.click()
  await sleep(1000)

  const searchInput = [...document.querySelectorAll('input')]
    .find(el => el.offsetParent !== null && el.type !== 'hidden' && !el.closest('[aria-hidden="true"]'))
  if (searchInput) {
    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
    if (nativeSetter) nativeSetter.call(searchInput, value)
    searchInput.dispatchEvent(new Event('input', { bubbles: true }))
    await sleep(800)
  }

  const option = await waitFor(() =>
    [...document.querySelectorAll('[role="option"]')]
      .find(el => el.textContent.trim().toLowerCase() === value.toString().toLowerCase()) ||
    [...document.querySelectorAll('[role="option"]')]
      .find(el => el.textContent.trim().toLowerCase().includes(value.toString().toLowerCase()))
  , 5000)

  if (option) { option.click(); await sleep(600); return true }
  console.warn('Option not found:', labelText, value)
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  await sleep(400)
  return false
}

function mapColor(color) {
  if (!color) return 'Black'
  const c = color.toLowerCase()
  if (c.includes('black') || c.includes('midnight') || c.includes('mosaic')) return 'Black'
  if (c.includes('white') || c.includes('ivory') || c.includes('pearl') || c.includes('summit')) return 'White'
  if (c.includes('silver') || c.includes('grey') || c.includes('gray') || c.includes('moonstone') || c.includes('sterling') || c.includes('satin')) return 'Silver'
  if (c.includes('red') || c.includes('crimson') || c.includes('cherry') || c.includes('cayenne')) return 'Red'
  if (c.includes('blue') || c.includes('navy') || c.includes('cobalt') || c.includes('pacific') || c.includes('empire')) return 'Blue'
  if (c.includes('green') || c.includes('forest') || c.includes('sage')) return 'Green'
  if (c.includes('brown') || c.includes('bronze') || c.includes('copper')) return 'Brown'
  if (c.includes('gold') || c.includes('yellow') || c.includes('champagne') || c.includes('harvest')) return 'Gold'
  if (c.includes('orange')) return 'Orange'
  if (c.includes('purple') || c.includes('violet')) return 'Purple'
  if (c.includes('tan') || c.includes('beige') || c.includes('sand') || c.includes('dune')) return 'Tan'
  return 'Other'
}

// ── Status overlay ────────────────────────────
function showStatus(message, type = 'info') {
  let overlay = document.getElementById('wc-status')
  if (!overlay) {
    overlay = document.createElement('div')
    overlay.id = 'wc-status'
    overlay.style.cssText = `
      position:fixed;bottom:130px;right:20px;background:#1a1a1a;
      color:#fff;padding:12px 18px;border-radius:10px;font-size:13px;
      font-family:-apple-system,sans-serif;z-index:2147483646;
      border:1px solid #333;max-width:280px;
      box-shadow:0 4px 20px rgba(0,0,0,0.4);
    `
    document.body.appendChild(overlay)
  }
  overlay.style.borderColor = type === 'success' ? '#22c55e' : '#3b82f6'
  overlay.innerHTML = `
    <div style="font-weight:600;margin-bottom:4px">${type === 'success' ? '✅' : '⚙️'} Marketplace Lister</div>
    <div style="color:#aaa">${message}</div>
  `
}

// ── Photo injection ───────────────────────────
async function injectPhotosIntoInput(imageUrls) {
  const fileInput = document.querySelector('input[type="file"][accept*="image"]')
  if (!fileInput) { console.warn('No file input found'); return false }

  const files = []
  for (let i = 0; i < Math.min(imageUrls.length, 20); i++) {
    try {
      const res = await fetch(`${API}/proxy-image?url=${encodeURIComponent(imageUrls[i])}`)
      const blob = await res.blob()
      files.push(new File([blob], `photo_${i + 1}.jpg`, { type: 'image/jpeg' }))
    } catch(e) {
      console.warn('Failed to fetch photo', i + 1)
    }
  }

  if (!files.length) return false

  const dt = new DataTransfer()
  files.forEach(f => dt.items.add(f))

  const nativeFileSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'files')
  if (nativeFileSetter?.set) {
    nativeFileSetter.set.call(fileInput, dt.files)
  } else {
    Object.defineProperty(fileInput, 'files', { value: dt.files, configurable: true })
  }

  fileInput.dispatchEvent(new Event('change', { bubbles: true }))
  fileInput.dispatchEvent(new Event('input', { bubbles: true }))
  await sleep(2000)

  return fileInput.files.length > 0
}

// ── Photo strip ───────────────────────────────
function showPhotoStrip(imageUrls, vehicleId) {
  if (!imageUrls?.length) return
  document.getElementById('wc-photo-strip')?.remove()

  const uploadZone = document.querySelector('[aria-label="Add photos"]') ||
    [...document.querySelectorAll('div')].find(el => el.textContent.trim() === 'Add photos')
  if (uploadZone) {
    uploadZone.style.outline = '3px dashed #3b82f6'
    uploadZone.style.outlineOffset = '4px'
    uploadZone.style.borderRadius = '8px'
  }

  const strip = document.createElement('div')
  strip.id = 'wc-photo-strip'
  strip.style.cssText = `
    position:fixed;bottom:0;left:0;right:0;height:110px;
    background:#111;border-top:2px solid #3b82f6;
    padding:10px 16px;z-index:2147483647;
    display:flex;align-items:center;gap:12px;
    font-family:-apple-system,sans-serif;
    box-shadow:0 -4px 24px rgba(0,0,0,0.6);
  `

  const label = document.createElement('div')
  label.style.cssText = 'color:#fff;font-size:12px;font-weight:700;white-space:nowrap;min-width:110px;line-height:1.6;'
  label.innerHTML = `📸 ${imageUrls.length} Photos<br><span style="color:#888;font-size:10px;">Click Upload Photos</span>`
  strip.appendChild(label)

  const row = document.createElement('div')
  row.style.cssText = 'display:flex;gap:8px;overflow-x:auto;flex:1;align-items:center;padding-bottom:4px;'
  imageUrls.forEach((url, i) => {
    const proxySrc = `${API}/proxy-image?url=${encodeURIComponent(url)}`
    const wrapper = document.createElement('div')
    wrapper.style.cssText = 'position:relative;flex-shrink:0;'
    const img = document.createElement('img')
    img.src = proxySrc
    img.style.cssText = 'height:80px;width:110px;object-fit:cover;border-radius:8px;border:2px solid #2a2a2a;display:block;'
    const num = document.createElement('div')
    num.style.cssText = 'position:absolute;top:4px;left:4px;background:rgba(0,0,0,0.7);color:#fff;font-size:10px;padding:2px 5px;border-radius:4px;'
    num.textContent = i + 1
    wrapper.appendChild(img)
    wrapper.appendChild(num)
    row.appendChild(wrapper)
  })
  strip.appendChild(row)

  const uploadBtn = document.createElement('button')
  uploadBtn.textContent = '📁 Upload Photos'
  uploadBtn.style.cssText = 'background:#3b82f6;border:none;color:#fff;padding:8px 12px;border-radius:8px;font-size:12px;font-weight:700;cursor:pointer;white-space:nowrap;flex-shrink:0;'
  uploadBtn.addEventListener('click', async () => {
    uploadBtn.textContent = '⏳ Working...'
    uploadBtn.disabled = true
    showStatus('Trying to inject photos...', 'info')

    const injected = await injectPhotosIntoInput(imageUrls)
    if (injected) {
      uploadBtn.textContent = '✅ Photos uploaded!'
      uploadBtn.style.background = '#22c55e'
      uploadBtn.style.color = '#000'
      showStatus('✅ Photos uploaded successfully!', 'success')
    } else {
      showStatus('Downloading photos...', 'info')
      const objectUrls = []
      let downloaded = 0
      for (let i = 0; i < imageUrls.length; i++) {
        try {
          const res = await fetch(`${API}/proxy-image?url=${encodeURIComponent(imageUrls[i])}`)
          const blob = await res.blob()
          const objectUrl = URL.createObjectURL(blob)
          objectUrls.push(objectUrl)
          const a = document.createElement('a')
          a.href = objectUrl
          a.download = `WellandChev_${String(i + 1).padStart(2, '0')}.jpg`
          document.body.appendChild(a)
          a.click()
          document.body.removeChild(a)
          downloaded++
          uploadBtn.textContent = `⬇ ${downloaded}/${imageUrls.length}`
          await sleep(300)
        } catch(e) { console.warn('Download failed', i + 1) }
      }
      uploadBtn.textContent = `✅ ${downloaded} downloaded — Select in Add Photos`
      uploadBtn.style.background = '#22c55e'
      uploadBtn.style.color = '#000'
      await sleep(500)
      const addBtn = document.querySelector('[aria-label="Add photos"]') ||
        [...document.querySelectorAll('div[role="button"]')].find(el => el.textContent.trim() === 'Add photos')
      if (addBtn) addBtn.click()
      setTimeout(() => objectUrls.forEach(u => URL.revokeObjectURL(u)), 180000)
    }
  })
  strip.appendChild(uploadBtn)

  const markPosted = document.createElement('button')
  markPosted.textContent = '✅ Mark Posted'
  markPosted.style.cssText = 'background:#22c55e;border:none;color:#000;padding:8px 12px;border-radius:8px;font-size:12px;font-weight:700;cursor:pointer;white-space:nowrap;flex-shrink:0;'
  markPosted.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'LISTING_POSTED', inventory_id: vehicleId, fb_listing_url: window.location.href })
    markPosted.textContent = '✅ Posted!'
    markPosted.disabled = true
    markPosted.style.background = '#166534'
    markPosted.style.color = '#4ade80'
  })
  strip.appendChild(markPosted)

  const close = document.createElement('button')
  close.textContent = '✕'
  close.style.cssText = 'background:#1a1a1a;border:1px solid #333;color:#888;padding:8px 12px;border-radius:8px;font-size:12px;cursor:pointer;white-space:nowrap;flex-shrink:0;'
  close.addEventListener('click', () => {
    strip.remove()
    document.getElementById('wc-status')?.remove()
    if (uploadZone) uploadZone.style.outline = ''
  })
  strip.appendChild(close)
  document.body.appendChild(strip)
}

// ── Main form filler ──────────────────────────
async function fillListingForm(vehicle) {
  const make = normalizeMake(vehicle.make)
  const model = normalizeModel(vehicle.model)
  console.log('🚗 Starting:', vehicle.year, make, model)
  showStatus('Starting... please don\'t click anything')
  await sleep(2500)

  // VEHICLE TYPE — always Car/Truck
  showStatus('Selecting vehicle type...')
  await pickDropdown('Vehicle type', 'Car/Truck')
  await sleep(DELAY)

  // YEAR
  showStatus('Selecting year...')
  await pickDropdown('Year', String(vehicle.year))
  await sleep(DELAY)

  // MAKE
  showStatus('Selecting make...')
  const makeTrigger = await waitFor(() =>
    [...document.querySelectorAll('[role="combobox"]')]
      .find(el => el.textContent.trim().toLowerCase() === 'make' ||
                  el.textContent.trim().toLowerCase().startsWith('make'))
  , 10000)

  if (makeTrigger) {
    makeTrigger.scrollIntoView({ behavior: 'smooth', block: 'center' })
    await sleep(500)
    makeTrigger.click()
    await sleep(1000)
    const searchInput = [...document.querySelectorAll('input')]
      .find(el => el.offsetParent !== null && el.type !== 'hidden' && !el.closest('[aria-hidden="true"]'))
    if (searchInput) {
      const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
      if (nativeSetter) nativeSetter.call(searchInput, make)
      searchInput.dispatchEvent(new Event('input', { bubbles: true }))
      await sleep(800)
    }
    const makeOption = await waitFor(() =>
      [...document.querySelectorAll('[role="option"]')]
        .find(el => el.textContent.trim().toLowerCase() === make.toLowerCase()) ||
      [...document.querySelectorAll('[role="option"]')]
        .find(el => el.textContent.trim().toLowerCase().includes(make.toLowerCase()))
    , 5000)
    if (makeOption) { makeOption.click(); await sleep(1000); console.log('✓ Make:', make) }
  }
  await sleep(1200)

  // MODEL
showStatus('Selecting model...')

async function selectMarketplaceOption(label, value, timeout = 8000) {
  const combobox = await waitFor(() =>
    [...document.querySelectorAll('[role="combobox"]')]
      .find(el => {
        const txt = el.textContent.trim().toLowerCase()
        return txt === label.toLowerCase() || txt.startsWith(label.toLowerCase())
      }),
    timeout
  )

  if (!combobox) {
    console.warn(`${label} combobox not found`)
    return false
  }

  combobox.scrollIntoView({ behavior: 'smooth', block: 'center' })
  await sleep(500)

  combobox.click()
  await sleep(1200)

  const searchInput = await waitFor(() =>
    [...document.querySelectorAll('input')]
      .find(el =>
        el.offsetParent !== null &&
        el.type !== 'hidden' &&
        !el.closest('[aria-hidden="true"]')
      ),
    4000
  )

  if (!searchInput) {
    console.warn(`${label} search input not found`)
    return false
  }

  searchInput.focus()

  const nativeSetter =
    Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value'
    )?.set

  if (nativeSetter) {
    nativeSetter.call(searchInput, value)
  } else {
    searchInput.value = value
  }

  searchInput.dispatchEvent(
    new Event('input', { bubbles: true })
  )

  await sleep(1500)

  let options = [...document.querySelectorAll('[role="option"]')]
    .filter(el => el.offsetParent !== null)

  console.log('MODEL OPTIONS:', options.map(o => o.textContent.trim()))

  // EXACT MATCH FIRST
  let option = options.find(el =>
    el.textContent.trim().toLowerCase() === value.toLowerCase()
  )

  // STARTS WITH SECOND
  if (!option) {
    option = options.find(el =>
      el.textContent.trim().toLowerCase().startsWith(value.toLowerCase())
    )
  }

  // CONTAINS LAST
  if (!option) {
    option = options.find(el =>
      el.textContent.trim().toLowerCase().includes(value.toLowerCase())
    )
  }

  if (!option) {
    console.warn(`${label} option not found:`, value)

    document.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true
      })
    )

    return false
  }

  option.scrollIntoView({ block: 'center' })
  await sleep(300)

  option.click()

  await sleep(1200)

  console.log(`✓ ${label}:`, value)

  return true
}

// wait for Facebook to refresh models after make
await sleep(2500)

const modelSuccess = await selectMarketplaceOption('Model', model)

if (!modelSuccess) {
  console.warn('Primary model selection failed:', model)

  // fallback attempt removing trim words
  const simplifiedModel = model
    .replace(/1500|2500hd|3500hd|awd|fwd|4wd/gi, '')
    .trim()

  if (simplifiedModel !== model) {
    console.log('Trying simplified model:', simplifiedModel)

    await selectMarketplaceOption('Model', simplifiedModel)
  }
}

  // BODY STYLE
  showStatus('Selecting body style...')
  await pickDropdown('Body style', 'SUV')
  await sleep(DELAY)

  // EXTERIOR COLOR
  showStatus('Selecting exterior color...')
  await pickDropdown('Exterior color', mapColor(vehicle.exterior_color))
  await sleep(DELAY)

  // INTERIOR COLOR
  showStatus('Selecting interior color...')
  await waitFor(() =>
    [...document.querySelectorAll('[role="combobox"]')]
      .find(el => el.textContent.trim().toLowerCase().includes('interior'))
  )
  await pickDropdown('Interior color', mapColor(vehicle.interior_color) || 'Black')
  await sleep(DELAY)

  // VEHICLE CONDITION
  showStatus('Selecting condition...')
  await waitFor(() =>
    [...document.querySelectorAll('[role="combobox"]')]
      .find(el => el.textContent.trim().toLowerCase().includes('condition'))
  )
  await pickDropdown('Vehicle condition', 'Good')
  await sleep(DELAY)

  // FUEL TYPE
  showStatus('Selecting fuel type...')
  await pickDropdown('Fuel type', vehicle.fuel_type || 'Gasoline')
  await sleep(DELAY)

  // TRANSMISSION
  showStatus('Selecting transmission...')
  await pickDropdown('Transmission', vehicle.transmission || 'Automatic')
  await sleep(DELAY)

  // MILEAGE
  showStatus('Filling mileage...')
  const mileageEl = await waitFor(() =>
    getFormFields().find(f =>
      f.closest('label, div')?.textContent?.includes('Mileage') ||
      f.closest('label, div')?.textContent?.includes('Kilometers')
    )
  )
  if (mileageEl) await typeInto(mileageEl, String(vehicle.mileage || 0))
  await sleep(DELAY)

  // PRICE
  showStatus('Filling price...')
  const priceEl = await waitFor(() =>
    getFormFields().find(f => f.closest('label, div')?.textContent?.includes('Price'))
  )
  if (priceEl) await typeInto(priceEl, String(Math.round(vehicle.price)))
  await sleep(DELAY)

  // DESCRIPTION
  showStatus('Writing description...')
  const descEl = await waitFor(() => document.querySelector('textarea'))
  if (descEl) {
    const desc = vehicle.ai_description || vehicle.description ||
      `${vehicle.year} ${make} ${model} ${vehicle.trim || ''}. ` +
      `${vehicle.mileage ? vehicle.mileage.toLocaleString() + ' km. ' : ''}` +
      `${vehicle.exterior_color ? vehicle.exterior_color + ' exterior. ' : ''}` +
      `${vehicle.transmission || 'Automatic'} transmission. ` +
      `Contact Welland Chev for more info!`
    await typeInto(descEl, desc)
  }
  await sleep(DELAY)

  showStatus('✅ Form filled! Click Upload Photos.', 'success')
  showPhotoStrip(vehicle.image_urls || [], vehicle.id)
  console.log('✅ Done')
}

// ── Boot ──────────────────────────────────────
if (window.location.href.includes('/marketplace/create/vehicle') ||
    window.location.href.includes('/marketplace/create/')) {
  chrome.storage.local.get(['pendingPost'], ({ pendingPost }) => {
    if (!pendingPost?.vehicle) return
    chrome.storage.local.remove(['pendingPost'])
    setTimeout(() => fillListingForm(pendingPost.vehicle), 2500)
  })
}