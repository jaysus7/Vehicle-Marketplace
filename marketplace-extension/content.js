// content.js
const DELAY = 600
const sleep = ms => new Promise(r => setTimeout(r, ms))

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
  if (!trigger) {
    console.warn('Dropdown not found:', labelText)
    return false
  }
  trigger.click()
  await sleep(800)
  const option = await waitFor(() =>
    [...document.querySelectorAll('[role="option"]')]
      .find(el => el.textContent.trim().toLowerCase() === value.toString().toLowerCase()) ||
    [...document.querySelectorAll('[role="option"]')]
      .find(el => el.textContent.trim().toLowerCase().includes(value.toString().toLowerCase()))
  , 5000)
  if (option) {
    option.click()
    await sleep(600)
    return true
  }
  console.warn('Option not found:', labelText, value)
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  await sleep(400)
  return false
}

function mapColor(color) {
  if (!color) return 'Black'
  const c = color.toLowerCase()
  if (c.includes('black') || c.includes('midnight')) return 'Black'
  if (c.includes('white') || c.includes('ivory') || c.includes('pearl')) return 'White'
  if (c.includes('silver') || c.includes('grey') || c.includes('gray')) return 'Silver'
  if (c.includes('red') || c.includes('crimson') || c.includes('burgundy')) return 'Red'
  if (c.includes('blue') || c.includes('navy') || c.includes('cobalt')) return 'Blue'
  if (c.includes('green') || c.includes('forest') || c.includes('olive')) return 'Green'
  if (c.includes('brown') || c.includes('bronze') || c.includes('copper')) return 'Brown'
  if (c.includes('gold') || c.includes('yellow') || c.includes('champagne')) return 'Gold'
  if (c.includes('orange')) return 'Orange'
  if (c.includes('purple') || c.includes('violet')) return 'Purple'
  if (c.includes('tan') || c.includes('beige') || c.includes('sand')) return 'Tan'
  return 'Other'
}

function mapBodyStyle(model) {
  const m = model?.toLowerCase() || ''
  if (['silverado','sierra','ram','f-150','f150','tundra','ranger','colorado','canyon','tacoma','titan','frontier'].some(t => m.includes(t))) return 'Truck'
  if (['equinox','traverse','tahoe','suburban','blazer','trax','trailblazer','terrain','enclave','acadia','yukon','expedition','explorer','escape','edge','pilot','crv','rav4','highlander','4runner'].some(t => m.includes(t))) return 'SUV'
  if (['express','transit','odyssey','sienna','caravan'].some(t => m.includes(t))) return 'Minivan'
  if (['camaro','mustang','corvette','challenger'].some(t => m.includes(t))) return 'Coupe'
  return 'Sedan'
}

function showStatus(message, type = 'info') {
  let overlay = document.getElementById('wc-status')
  if (!overlay) {
    overlay = document.createElement('div')
    overlay.id = 'wc-status'
    overlay.style.cssText = `
      position:fixed;bottom:20px;right:220px;background:#1a1a1a;
      color:#fff;padding:12px 18px;border-radius:10px;font-size:13px;
      font-family:-apple-system,sans-serif;z-index:999999;
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

const API = 'https://vehicle-marketplace-s0e4.onrender.com'

function proxyUrl(url) {
  return `${API}/proxy-image?url=${encodeURIComponent(url)}`
}

async function preparePhotosForDrop(imageUrls) {
  if (!imageUrls?.length) return []
  const proxied = []
  for (const url of imageUrls.slice(0, 20)) {
    try {
      const res = await fetch(proxyUrl(url))
      const blob = await res.blob()
      const objectUrl = URL.createObjectURL(blob)
      proxied.push({ objectUrl, original: url })
    } catch (e) {
      console.warn('Proxy failed for:', url)
    }
  }
  return proxied
}

function showUploadGuide(proxiedPhotos) {
  const uploadZone = document.querySelector('[aria-label="Add photos"]') ||
    [...document.querySelectorAll('div')].find(el => el.textContent.trim() === 'Add photos')

  if (uploadZone) {
    uploadZone.style.outline = '3px dashed #3b82f6'
    uploadZone.style.outlineOffset = '4px'
    uploadZone.style.borderRadius = '8px'
  }

  if (!document.getElementById('wc-style')) {
    const style = document.createElement('style')
    style.id = 'wc-style'
    style.textContent = `
      @keyframes wc-pulse {
        0%, 100% { outline-color: #3b82f6; }
        50% { outline-color: #22c55e; }
      }
    `
    document.head.appendChild(style)
  }

  if (uploadZone) uploadZone.style.animation = 'wc-pulse 1.5s ease-in-out infinite'

  // Build draggable photo strip
  document.getElementById('wc-photo-strip')?.remove()
  const strip = document.createElement('div')
  strip.id = 'wc-photo-strip'
  strip.style.cssText = `
    position:fixed;bottom:0;left:0;right:0;
    background:#1a1a1a;border-top:1px solid #2a2a2a;
    padding:10px 16px;z-index:999999;
    display:flex;align-items:center;gap:10px;
    font-family:-apple-system,sans-serif;
    box-shadow:0 -4px 20px rgba(0,0,0,0.4);
  `

  const label = document.createElement('div')
  label.style.cssText = 'color:#fff;font-size:12px;font-weight:600;white-space:nowrap;min-width:120px;'
  label.innerHTML = `📸 Drag photos<br><span style="color:#888;font-weight:400">into upload zone ↑</span>`
  strip.appendChild(label)

  const photoRow = document.createElement('div')
  photoRow.style.cssText = 'display:flex;gap:8px;overflow-x:auto;flex:1;'

  proxiedPhotos.forEach(({ objectUrl }, i) => {
    const img = document.createElement('img')
    img.src = objectUrl
    img.draggable = true
    img.title = `Drag photo ${i + 1} into the upload zone`
    img.style.cssText = `
      height:60px;width:80px;object-fit:cover;border-radius:6px;
      cursor:grab;border:2px solid #2a2a2a;flex-shrink:0;
    `

    img.addEventListener('dragstart', e => {
      // Set the image URL as drag data
      e.dataTransfer.setData('text/uri-list', objectUrl)
      e.dataTransfer.setData('text/plain', objectUrl)
      img.style.opacity = '0.5'
      if (uploadZone) uploadZone.style.outlineColor = '#22c55e'
    })

    img.addEventListener('dragend', () => {
      img.style.opacity = '1'
      if (uploadZone) uploadZone.style.outlineColor = '#3b82f6'
    })

    photoRow.appendChild(img)
  })

  strip.appendChild(photoRow)

  const closeBtn = document.createElement('button')
  closeBtn.textContent = '✕'
  closeBtn.style.cssText = `
    background:none;border:1px solid #333;color:#888;
    padding:6px 10px;border-radius:6px;font-size:13px;
    cursor:pointer;flex-shrink:0;
  `
  closeBtn.addEventListener('click', () => {
    strip.remove()
    if (uploadZone) { uploadZone.style.outline = ''; uploadZone.style.animation = '' }
  })
  strip.appendChild(closeBtn)

  document.body.appendChild(strip)
}

async function fillListingForm(vehicle) {
  console.log('🚗 Starting:', vehicle.year, vehicle.make, vehicle.model)
  showStatus('Starting... please don\'t click anything')
  await sleep(2500)

  const bodyStyle = mapBodyStyle(vehicle.model)

  showStatus('Selecting vehicle type...')
  await pickDropdown('Vehicle type', bodyStyle)
  await sleep(DELAY)

  showStatus('Selecting year...')
  await pickDropdown('Year', String(vehicle.year))
  await sleep(DELAY)

  showStatus('Selecting make...')
  await pickDropdown('Make', vehicle.make)
  await sleep(1500)

  showStatus('Selecting model...')
  await waitFor(() =>
    [...document.querySelectorAll('[role="combobox"]')]
      .find(el => el.textContent.trim().toLowerCase().includes('model')) ||
    getFormFields().find(f => f.closest('label, div')?.textContent?.includes('Model'))
  )
  await sleep(500)
  const modelCombo = [...document.querySelectorAll('[role="combobox"]')]
    .find(el => el.textContent.trim().toLowerCase().includes('model'))
  if (modelCombo) {
    await pickDropdown('Model', vehicle.model)
  } else {
    const modelEl = getFormFields().find(f => f.closest('label, div')?.textContent?.includes('Model'))
    if (modelEl) {
      await typeInto(modelEl, vehicle.model)
      await sleep(500)
      const opt = document.querySelector('[role="option"]')
      if (opt) { opt.click(); await sleep(400) }
    }
  }
  await sleep(1000)

  showStatus('Selecting body style...')
  await pickDropdown('Body style', bodyStyle)
  await sleep(DELAY)

  showStatus('Selecting exterior color...')
  await pickDropdown('Exterior color', mapColor(vehicle.exterior_color))
  await sleep(DELAY)

  showStatus('Selecting interior color...')
  await waitFor(() =>
    [...document.querySelectorAll('[role="combobox"]')]
      .find(el => el.textContent.trim().toLowerCase().includes('interior'))
  )
  await pickDropdown('Interior color', mapColor(vehicle.interior_color) || 'Black')
  await sleep(DELAY)

  showStatus('Selecting condition...')
  await waitFor(() =>
    [...document.querySelectorAll('[role="combobox"]')]
      .find(el => el.textContent.trim().toLowerCase().includes('condition'))
  )
  await pickDropdown('Vehicle condition', 'Good')
  await sleep(DELAY)

  showStatus('Selecting fuel type...')
  await pickDropdown('Fuel type', vehicle.fuel_type || 'Gasoline')
  await sleep(DELAY)

  showStatus('Selecting transmission...')
  await pickDropdown('Transmission', vehicle.transmission || 'Automatic')
  await sleep(DELAY)

  showStatus('Filling mileage...')
  const mileageEl = await waitFor(() =>
    getFormFields().find(f =>
      f.closest('label, div')?.textContent?.includes('Mileage') ||
      f.closest('label, div')?.textContent?.includes('Kilometers')
    )
  )
  if (mileageEl) await typeInto(mileageEl, String(vehicle.mileage || 0))
  await sleep(DELAY)

  showStatus('Filling price...')
  const priceEl = await waitFor(() =>
    getFormFields().find(f => f.closest('label, div')?.textContent?.includes('Price'))
  )
  if (priceEl) await typeInto(priceEl, String(Math.round(vehicle.price)))
  await sleep(DELAY)

  showStatus('Writing description...')
  const descEl = await waitFor(() => document.querySelector('textarea'))
  if (descEl) {
    const desc = vehicle.ai_description || vehicle.description ||
      `${vehicle.year} ${vehicle.make} ${vehicle.model} ${vehicle.trim || ''}. ` +
      `${vehicle.mileage ? vehicle.mileage.toLocaleString() + ' km. ' : ''}` +
      `${vehicle.exterior_color ? vehicle.exterior_color + ' exterior. ' : ''}` +
      `${vehicle.transmission || 'Automatic'} transmission. ` +
      `Contact Welland Chev for more info!`
    await typeInto(descEl, desc)
  }
  await sleep(DELAY)

  showStatus('✅ Form filled! Check the download banner.', 'success')
  autoDownloadPhotos(vehicle.image_urls || [])
  showUploadGuide(vehicle.image_urls || [])
  console.log('✅ Done')

  chrome.runtime.sendMessage({
    type: 'LISTING_POSTED',
    inventory_id: vehicle.id,
    fb_listing_url: window.location.href
  })
}

if (window.location.href.includes('/marketplace/create/vehicle') ||
    window.location.href.includes('/marketplace/create/')) {
  chrome.storage.local.get(['pendingPost'], ({ pendingPost }) => {
    if (!pendingPost?.vehicle) return
    chrome.storage.local.remove(['pendingPost'])
    setTimeout(() => fillListingForm(pendingPost.vehicle), 2500)
  })
}