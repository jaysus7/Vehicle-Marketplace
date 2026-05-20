// content.js
// Runs on facebook.com — fills out the Marketplace vehicle listing form

const DELAY = 400 // ms between actions — simulates human speed

// ── Utilities ─────────────────────────────────────

const sleep = ms => new Promise(r => setTimeout(r, ms))

// Find an element by aria-label (most stable FB selector)
function byLabel(label) {
  return document.querySelector(`[aria-label="${label}"]`)
}

// Find an element by placeholder text
function byPlaceholder(text) {
  return document.querySelector(`[placeholder="${text}"]`)
}

// Find a span/div containing exact text
function byText(text) {
  return [...document.querySelectorAll('span, div, label')]
    .find(el => el.textContent.trim() === text)
}

// Simulate human typing into a React-controlled input
async function typeInto(el, value) {
  if (!el) return false
  el.focus()
  await sleep(200)

  // Use clipboard paste approach — fastest and most reliable with React
  const nativeInputSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
  const nativeTextareaSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set

  const setter = el.tagName === 'TEXTAREA' ? nativeTextareaSetter : nativeInputSetter
  if (setter) {
    setter.call(el, value)
  } else {
    el.value = value
  }

  // Fire all events React listens to
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
  el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true }))
  el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }))
  await sleep(200)
  return true
}

// Click a dropdown option by its visible text
async function selectOption(optionText) {
  await sleep(400)
  const option = [...document.querySelectorAll('[role="option"]')]
    .find(el => el.textContent.trim().toLowerCase().includes(optionText.toLowerCase()))
  if (option) {
    option.click()
    await sleep(500)
    return true
  }
  return false
}

// Wait for an element to appear in the DOM
async function waitFor(selectorFn, timeout = 8000) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    const el = selectorFn()
    if (el) return el
    await sleep(300)
  }
  return null
}

// ── Image Upload ──────────────────────────────────

async function uploadImages(imageUrls) {
  if (!imageUrls?.length) return

  // Find the photo upload area
  const uploadArea = await waitFor(() =>
    byLabel('Add photos') ||
    document.querySelector('input[type="file"][accept*="image"]') ||
    byLabel('Upload photos')
  )

  if (!uploadArea) {
    console.warn('Could not find image upload area')
    return
  }

  // Download each image and create File objects
  const files = []
  for (const url of imageUrls.slice(0, 20)) { // FB max 20 images
    try {
      const res = await fetch(url)
      const blob = await res.blob()
      const filename = url.split('/').pop().split('?')[0] || 'vehicle.jpg'
      files.push(new File([blob], filename, { type: blob.type || 'image/jpeg' }))
    } catch (e) {
      console.warn('Failed to fetch image:', url)
    }
  }

  if (!files.length) return

  // Use DataTransfer API to inject files
  const dt = new DataTransfer()
  files.forEach(f => dt.items.add(f))

  // Find the actual file input
  const fileInput = document.querySelector('input[type="file"][accept*="image"]')
  if (fileInput) {
    Object.defineProperty(fileInput, 'files', { value: dt.files, writable: false })
    fileInput.dispatchEvent(new Event('change', { bubbles: true }))
    await sleep(2000) // wait for upload to process
  }
}

// ── Click a radio/checkbox option ────────────────

async function clickOption(labelText) {
  await sleep(300)
  const el = byText(labelText) || byLabel(labelText)
  if (el) {
    el.click()
    await sleep(400)
    return true
  }
  return false
}

// ── Main Form Filler ──────────────────────────────

async function fillListingForm(vehicle) {
  console.log('🚗 Starting to fill listing for:', vehicle.year, vehicle.make, vehicle.model)

  showStatus('Starting... please don\'t click anything')
  await sleep(2000) // wait for FB page to fully render

  // ── PRICE ──
  showStatus('Filling price...')
  const priceEl = await waitFor(() =>
    byLabel('Price') ||
    byPlaceholder('Price')
  )
  await typeInto(priceEl, String(Math.round(vehicle.price)))
  await sleep(DELAY)

  // ── VEHICLE TYPE (Cars/Trucks) ──
  showStatus('Selecting vehicle type...')
  const typeEl = await waitFor(() =>
    byLabel('Vehicle type') ||
    byLabel('Type')
  )
  if (typeEl) {
    typeEl.click()
    await sleep(500)
    // Try to select appropriate type
    if (['truck', 'pickup'].some(t => vehicle.model?.toLowerCase().includes(t))) {
      await selectOption('Truck')
    } else if (['suv', 'crossover'].some(t => vehicle.model?.toLowerCase().includes(t))) {
      await selectOption('SUV')
    } else {
      await selectOption('Sedan')
    }
  }
  await sleep(DELAY)

  // ── YEAR ──
  showStatus('Filling year...')
  const yearEl = await waitFor(() =>
    byLabel('Year') ||
    byPlaceholder('Year')
  )
  if (yearEl) {
    yearEl.click()
    await sleep(400)
    await typeInto(yearEl, String(vehicle.year))
    await sleep(400)
    await selectOption(String(vehicle.year))
  }
  await sleep(DELAY)

  // ── MAKE ──
  showStatus('Filling make...')
  const makeEl = await waitFor(() =>
    byLabel('Make') ||
    byPlaceholder('Make')
  )
  if (makeEl) {
    makeEl.click()
    await sleep(400)
    await typeInto(makeEl, vehicle.make)
    await sleep(600)
    await selectOption(vehicle.make)
  }
  await sleep(DELAY)

  // ── MODEL ──
  showStatus('Filling model...')
  const modelEl = await waitFor(() =>
    byLabel('Model') ||
    byPlaceholder('Model')
  )
  if (modelEl) {
    modelEl.click()
    await sleep(400)
    await typeInto(modelEl, vehicle.model)
    await sleep(600)
    await selectOption(vehicle.model)
  }
  await sleep(DELAY)

  // ── MILEAGE ──
  showStatus('Filling mileage...')
  const mileageEl = await waitFor(() =>
    byLabel('Mileage') ||
    byPlaceholder('Mileage') ||
    byLabel('Kilometers')
  )
  if (mileageEl) {
    await typeInto(mileageEl, String(vehicle.mileage || 0))
  }
  await sleep(DELAY)

  // ── EXTERIOR COLOR ──
  showStatus('Selecting color...')
  const colorEl = await waitFor(() =>
    byLabel('Exterior color') ||
    byLabel('Color')
  )
  if (colorEl) {
    colorEl.click()
    await sleep(500)
    await selectOption(vehicle.exterior_color || 'Black')
  }
  await sleep(DELAY)

  // ── TRANSMISSION ──
  showStatus('Selecting transmission...')
  const transEl = await waitFor(() =>
    byLabel('Transmission') ||
    byLabel('Transmission type')
  )
  if (transEl) {
    transEl.click()
    await sleep(500)
    await selectOption(vehicle.transmission || 'Automatic')
  }
  await sleep(DELAY)

  // ── FUEL TYPE ──
  showStatus('Selecting fuel type...')
  const fuelEl = await waitFor(() =>
    byLabel('Fuel type') ||
    byLabel('Fuel')
  )
  if (fuelEl) {
    fuelEl.click()
    await sleep(500)
    await selectOption(vehicle.fuel_type || 'Gasoline')
  }
  await sleep(DELAY)

  // ── DESCRIPTION ──
  showStatus('Writing description...')
  const descEl = await waitFor(() =>
    byLabel('Description') ||
    byPlaceholder('Description') ||
    document.querySelector('textarea')
  )
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

  // ── IMAGES ──
  showStatus('Uploading photos...')
  await uploadImages(vehicle.image_urls)

  // ── DONE ──
  showStatus('✅ Form filled! Review and click Publish.', 'success')
  console.log('✅ Form fill complete')

  // Notify background to record the listing
  chrome.runtime.sendMessage({
    type: 'LISTING_POSTED',
    inventory_id: vehicle.id,
    fb_listing_url: window.location.href
  })
}

// ── Status Overlay ────────────────────────────────

function showStatus(message, type = 'info') {
  let overlay = document.getElementById('wc-status')
  if (!overlay) {
    overlay = document.createElement('div')
    overlay.id = 'wc-status'
    overlay.style.cssText = `
      position: fixed;
      bottom: 20px;
      right: 20px;
      background: #1a1a1a;
      color: #fff;
      padding: 12px 18px;
      border-radius: 10px;
      font-size: 13px;
      font-family: -apple-system, sans-serif;
      z-index: 999999;
      border: 1px solid #333;
      max-width: 280px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.4);
    `
    document.body.appendChild(overlay)
  }

  overlay.style.borderColor = type === 'success' ? '#22c55e' : '#3b82f6'
  overlay.innerHTML = `
    <div style="font-weight:600;margin-bottom:4px">
      ${type === 'success' ? '✅' : '⚙️'} Marketplace Lister
    </div>
    <div style="color:#aaa">${message}</div>
  `
}

// ── Boot ─────────────────────────────────────────

// Only run on the create vehicle listing page
if (window.location.href.includes('/marketplace/create/vehicle') ||
    window.location.href.includes('/marketplace/create/')) {

  chrome.storage.local.get(['pendingPost'], ({ pendingPost }) => {
    if (!pendingPost?.vehicle) return

    // Clear the pending post so it doesn't re-trigger
    chrome.storage.local.remove(['pendingPost'])

    // Wait a moment for FB to render, then fill the form
    setTimeout(() => fillListingForm(pendingPost.vehicle), 2500)
  })
}