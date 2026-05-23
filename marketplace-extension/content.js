// content.js — Welland Chev Marketplace Lister
const API = 'https://vehicle-marketplace-s0e4.onrender.com'
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
  if (!trigger) { console.warn('Dropdown not found:', labelText); return false }

  trigger.click()
  await sleep(800)

  // If there's a search input inside the dropdown, type to filter
  const searchInput = document.querySelector('[role="listbox"] input, [role="combobox"] input:not([type="hidden"])')
  if (searchInput) {
    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
    if (nativeSetter) nativeSetter.call(searchInput, value)
    searchInput.dispatchEvent(new Event('input', { bubbles: true }))
    searchInput.dispatchEvent(new Event('change', { bubbles: true }))
    await sleep(600)
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
  if (c.includes('black') || c.includes('midnight')) return 'Black'
  if (c.includes('white') || c.includes('ivory') || c.includes('pearl')) return 'White'
  if (c.includes('silver') || c.includes('grey') || c.includes('gray')) return 'Silver'
  if (c.includes('red') || c.includes('crimson')) return 'Red'
  if (c.includes('blue') || c.includes('navy')) return 'Blue'
  if (c.includes('green') || c.includes('forest')) return 'Green'
  if (c.includes('brown') || c.includes('bronze')) return 'Brown'
  if (c.includes('gold') || c.includes('yellow') || c.includes('champagne')) return 'Gold'
  if (c.includes('orange')) return 'Orange'
  if (c.includes('purple') || c.includes('violet')) return 'Purple'
  if (c.includes('tan') || c.includes('beige')) return 'Tan'
  return 'Other'
}

function mapBodyStyle(model) {
  const m = model?.toLowerCase() || ''
  if (['silverado','sierra','ram','f-150','f150','tundra','ranger','colorado','canyon','tacoma','titan','frontier','1500','2500','3500'].some(t => m.includes(t))) return 'Truck'
  if (['equinox','traverse','tahoe','suburban','blazer','trax','trailblazer','terrain','enclave','acadia','yukon','expedition','explorer','escape','edge','pilot','crv','rav4','highlander','4runner','pathfinder','murano','rogue','cx-5','tucson','santa fe','sportage','sorento','telluride','palisade','atlas','tiguan','forester','outback','ascent'].some(t => m.includes(t))) return 'SUV'
  if (['express','transit','odyssey','sienna','caravan','grand caravan','pacifica'].some(t => m.includes(t))) return 'Minivan'
  if (['camaro','mustang','corvette','challenger','charger'].some(t => m.includes(t))) return 'Coupe'
  if (['bolt','spark','sonic','cruze','malibu','impala','ioniq','leaf','model 3','model s','sentra','corolla','civic','accord','camry','altima','maxima'].some(t => m.includes(t))) return 'Sedan'
  return 'SUV' // default to SUV since most Welland inventory is trucks/SUVs
}

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
  label.innerHTML = `📸 ${imageUrls.length} Photo${imageUrls.length > 1 ? 's' : ''}<br><span style="color:#22c55e;font-size:11px;font-weight:400;">Click photo to copy</span><br><span style="color:#888;font-size:10px;">or click "Add photos" → select all</span>`
  strip.appendChild(label)

  const row = document.createElement('div')
  row.style.cssText = 'display:flex;gap:8px;overflow-x:auto;flex:1;align-items:center;padding-bottom:4px;'

  imageUrls.forEach((url, i) => {
    const proxySrc = `${API}/proxy-image?url=${encodeURIComponent(url)}`
    const wrapper = document.createElement('div')
    wrapper.style.cssText = 'position:relative;flex-shrink:0;'

    const img = document.createElement('img')
    img.src = proxySrc
    img.style.cssText = `
      height:80px;width:110px;object-fit:cover;
      border-radius:8px;cursor:pointer;
      border:2px solid #2a2a2a;display:block;
      transition:border-color 0.2s;
    `

    const num = document.createElement('div')
    num.style.cssText = `
      position:absolute;top:4px;left:4px;background:rgba(0,0,0,0.7);
      color:#fff;font-size:10px;padding:2px 5px;border-radius:4px;
    `
    num.textContent = i + 1

    img.addEventListener('mouseenter', () => img.style.borderColor = '#3b82f6')
    img.addEventListener('mouseleave', () => img.style.borderColor = '#2a2a2a')
    img.addEventListener('click', async () => {
      try {
        const res = await fetch(proxySrc)
        const blob = await res.blob()
        await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })])
        img.style.borderColor = '#22c55e'
        num.textContent = '📋'
        setTimeout(() => { img.style.borderColor = '#2a2a2a'; num.textContent = i + 1 }, 1500)
        showStatus('Photo copied! Click upload zone and press Cmd+V.', 'info')
      } catch(e) {
        showStatus('Click "Add photos" and select manually.', 'info')
      }
    })

    wrapper.appendChild(img)
    wrapper.appendChild(num)
    row.appendChild(wrapper)
  })

  strip.appendChild(row)

  const markPosted = document.createElement('button')
  markPosted.textContent = '✅ Mark Posted'
  markPosted.style.cssText = `
    background:#22c55e;border:none;color:#000;
    padding:8px 12px;border-radius:8px;font-size:12px;font-weight:700;
    cursor:pointer;white-space:nowrap;flex-shrink:0;
  `
  markPosted.addEventListener('click', () => {
    chrome.runtime.sendMessage({
      type: 'LISTING_POSTED',
      inventory_id: vehicleId,
      fb_listing_url: window.location.href
    })
    markPosted.textContent = '✅ Posted!'
    markPosted.disabled = true
    markPosted.style.background = '#166534'
    markPosted.style.color = '#4ade80'
  })
  const uploadBtn = document.createElement('button')
  uploadBtn.textContent = '📁 Upload Photos'
  uploadBtn.style.cssText = `
    background:#3b82f6;border:none;color:#fff;
    padding:8px 12px;border-radius:8px;font-size:12px;font-weight:700;
    cursor:pointer;white-space:nowrap;flex-shrink:0;
  `
  uploadBtn.addEventListener('click', async () => {
    uploadBtn.textContent = '⬇ Downloading...'
    uploadBtn.disabled = true
    uploadBtn.style.background = '#1e3a5f'

    // Download all photos using chrome.downloads directly
    const downloadIds = []
    for (let i = 0; i < imageUrls.length; i++) {
      const url = `${API}/proxy-image?url=${encodeURIComponent(imageUrls[i])}`
      const filename = `WellandChev_Temp/photo_${i + 1}.jpg`
      await new Promise(resolve => {
        chrome.downloads.download({ url, filename, saveAs: false }, id => {
          if (id) downloadIds.push(id)
          resolve()
        })
      })
      await sleep(200)
    }

    uploadBtn.textContent = `✅ ${downloadIds.length} photos in Downloads/WellandChev_Temp`
    uploadBtn.style.background = '#22c55e'
    uploadBtn.style.color = '#000'

    // Auto-click Facebook's Add Photos button
    await sleep(500)
    const addPhotosBtn = document.querySelector('[aria-label="Add photos"]') ||
      [...document.querySelectorAll('div[role="button"]')]
        .find(el => el.textContent.trim() === 'Add photos')
    if (addPhotosBtn) addPhotosBtn.click()

    // Auto-delete after 2 minutes
    setTimeout(() => {
      downloadIds.forEach(id => {
        chrome.downloads.removeFile(id, () => chrome.downloads.erase({ id }))
      })
      uploadBtn.textContent = '🗑 Temp photos deleted'
      uploadBtn.style.background = '#1a1a1a'
      uploadBtn.style.color = '#666'
    }, 120000)
  })

  strip.appendChild(uploadBtn)

  const close = document.createElement('button')
  close.textContent = '✕'
  close.style.cssText = `
    background:#1a1a1a;border:1px solid #333;color:#888;
    padding:8px 12px;border-radius:8px;font-size:12px;
    cursor:pointer;white-space:nowrap;flex-shrink:0;
  `
  close.addEventListener('click', () => {
    strip.remove()
    document.getElementById('wc-status')?.remove()
    if (uploadZone) uploadZone.style.outline = ''
  })
  strip.appendChild(close)

  document.body.appendChild(strip) // ← THIS was missing before
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

    // After clicking, look for any input that appeared (search box inside dropdown)
    const searchInput = await waitFor(() =>
      [...document.querySelectorAll('input')]
        .find(el => el.offsetParent !== null && el.type !== 'hidden' && el.value === '')
    , 3000)

    if (searchInput) {
      const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
      if (nativeSetter) nativeSetter.call(searchInput, vehicle.make)
      searchInput.dispatchEvent(new Event('input', { bubbles: true }))
      searchInput.dispatchEvent(new Event('change', { bubbles: true }))
      await sleep(800)
    }

    const makeOption = await waitFor(() =>
      [...document.querySelectorAll('[role="option"]')]
        .find(el => el.textContent.trim().toLowerCase() === vehicle.make.toLowerCase()) ||
      [...document.querySelectorAll('[role="option"]')]
        .find(el => el.textContent.trim().toLowerCase().includes(vehicle.make.toLowerCase()))
    , 5000)

    if (makeOption) {
      makeOption.click()
      await sleep(600)
      console.log('✓ Make selected:', vehicle.make)
    } else {
      console.warn('Make option not found:', vehicle.make)
    }
  }
  await sleep(2000)

  showStatus('Selecting model...')
  const modelTrigger = await waitFor(() =>
    [...document.querySelectorAll('[role="combobox"]')]
      .find(el => el.textContent.trim().toLowerCase() === 'model' ||
                  el.textContent.trim().toLowerCase().startsWith('model'))
  , 8000)

  if (modelTrigger) {
    modelTrigger.scrollIntoView({ behavior: 'smooth', block: 'center' })
    await sleep(500)
    modelTrigger.click()
    await sleep(1000)

    const searchInput2 = await waitFor(() =>
      [...document.querySelectorAll('input')]
        .find(el => el.offsetParent !== null && el.type !== 'hidden' && el.value === '')
    , 3000)

    if (searchInput2) {
      const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
      if (nativeSetter) nativeSetter.call(searchInput2, vehicle.model)
      searchInput2.dispatchEvent(new Event('input', { bubbles: true }))
      searchInput2.dispatchEvent(new Event('change', { bubbles: true }))
      await sleep(800)
    }

    const modelOption = await waitFor(() =>
      [...document.querySelectorAll('[role="option"]')]
        .find(el => el.textContent.trim().toLowerCase() === vehicle.model.toLowerCase()) ||
      [...document.querySelectorAll('[role="option"]')]
        .find(el => el.textContent.trim().toLowerCase().includes(vehicle.model.toLowerCase()))
    , 5000)

    if (modelOption) {
      modelOption.click()
      await sleep(600)
      console.log('✓ Model selected:', vehicle.model)
    } else {
      console.warn('Model option not found:', vehicle.model)
      // Fall back to text input if it exists
      const modelTextField = getFormFields()
        .find(f => f.closest('label, div')?.textContent?.includes('Model'))
      if (modelTextField) {
        await typeInto(modelTextField, vehicle.model)
        await sleep(500)
        const opt = document.querySelector('[role="option"]')
        if (opt) { opt.click(); await sleep(400) }
      }
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

  showStatus('✅ Form filled! Add photos then click Next.', 'success')
  showPhotoStrip(vehicle.image_urls || [], vehicle.id)
  console.log('✅ Done')
}

if (window.location.href.includes('/marketplace/create/vehicle') ||
    window.location.href.includes('/marketplace/create/')) {
  chrome.storage.local.get(['pendingPost'], ({ pendingPost }) => {
    if (!pendingPost?.vehicle) return
    chrome.storage.local.remove(['pendingPost'])
    setTimeout(() => fillListingForm(pendingPost.vehicle), 2500)
  })
}
