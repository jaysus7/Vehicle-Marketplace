// content.js — | MarketSync
console.log('[MarketSync] content.js loaded on', window.location.href);
const API = 'https://vehicle-marketplace-s0e4.onrender.com';
const DELAY = 800; // Increased to mitigate UI render bottlenecks
const sleep = ms => new Promise(r => setTimeout(r, ms));


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
};

const MODEL_MAP = {
  'silverado 1500': 'Silverado 1500', 'silverado 2500hd': 'Silverado 2500HD',
  'silverado 2500': 'Silverado 2500HD', 'silverado 3500hd': 'Silverado 3500HD',
  'silverado 3500': 'Silverado 3500HD', 'silverado': 'Silverado 1500',
  'colorado': 'Colorado', 'equinox ev': 'Equinox EV', 'equinox': 'Equinox',
  'traverse': 'Traverse', 'tahoe': 'Tahoe', 'suburban': 'Suburban',
  'blazer ev': 'Blazer EV', 'blazer': 'Blazer', 'trailblazer': 'Trailblazer',
  'trax': 'Trax', 'bolt euv': 'Bolt EUV', 'bolt ev': 'Bolt EV',
  'bolt': 'Bolt EV', 'camaro': 'Camaro', 'corvette': 'Corvette',
  'malibu': 'Malibu', 'spark': 'Spark', 'sonic': 'Sonic',
  'cruze': 'Cruze', 'impala': 'Impala', 'express': 'Express',
  'sierra 1500': 'Sierra 1500', 'sierra 2500hd': 'Sierra 2500HD',
  'sierra 2500': 'Sierra 2500HD', 'sierra 3500hd': 'Sierra 3500HD',
  'sierra 3500': 'Sierra 3500HD', 'sierra': 'Sierra 1500',
  'canyon': 'Canyon', 'savana': 'Savana', 'terrain': 'Terrain',
  'acadia': 'Acadia', 'yukon xl': 'Yukon XL', 'yukon': 'Yukon',
  'envoy': 'Envoy', 'encore gx': 'Encore GX', 'encore': 'Encore',
  'enclave': 'Enclave', 'envision': 'Envision', 'envista': 'Envista',
  'lacrosse': 'LaCrosse', 'verano': 'Verano', 'regal': 'Regal',
  'lesabre': 'LeSabre', 'lucerne': 'Lucerne', 'escalade esv': 'Escalade ESV',
  'escalade': 'Escalade', 'xt4': 'XT4', 'xt5': 'XT5', 'xt6': 'XT6',
  'ct4': 'CT4', 'ct5': 'CT5', 'ct6': 'CT6', 'lyriq': 'LYRIQ',
  'celestiq': 'CELESTIQ', 'srx': 'SRX', 'ats': 'ATS', 'cts': 'CTS', 'xts': 'XTS'
};

function normalizeMake(make) {
  if (!make) return make;
  const key = make.toLowerCase().trim();
  return MAKE_MAP[key] || make;
}

function normalizeModel(model) {
  if (!model) return model;
  const key = model.toLowerCase().trim();
  if (MODEL_MAP[key]) return MODEL_MAP[key];
  const sortedKeys = Object.keys(MODEL_MAP).sort((a, b) => b.length - a.length);
  for (const k of sortedKeys) {
    if (key.includes(k)) return MODEL_MAP[k];
  }
  return model;
}

// Dynamic body style selector fallback matrix
function deduceBodyStyle(make, model) {
  const normModel = normalizeModel(model).toLowerCase();
  const normMake = normalizeMake(make).toLowerCase();
  
  if (normModel.includes('silverado') || normModel.includes('sierra') || normModel.includes('colorado') || normModel.includes('canyon')) {
    return 'Truck';
  }
  if (normModel.includes('camaro') || normModel.includes('corvette')) {
    return 'Coupe';
  }
  if (normModel.includes('malibu') || normModel.includes('cruze') || normModel.includes('impala') || normModel.includes('ct4') || normModel.includes('ct5')) {
    return 'Sedan';
  }
  if (normModel.includes('express') || normModel.includes('savana')) {
    return 'Van';
  }
  return 'SUV'; // Fallback default
}

// ── Utilities ─────────────────────────────────
async function waitFor(fn, timeout = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const el = fn();
    if (el) return el;
    await sleep(300);
  }
  return null;
}

function getFormFields() {
  return [...document.querySelectorAll('input[type="text"], input[type="number"], textarea')]
    .filter(el => !el.closest('[aria-hidden="true"]'));
}

async function typeInto(el, value) {
  if (!el) return false;
  el.click();
  el.focus();
  await sleep(200);
  const nativeInputSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
  const nativeTextareaSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
  const setter = el.tagName === 'TEXTAREA' ? nativeTextareaSetter : nativeInputSetter;
  if (setter) setter.call(el, value);
  else el.value = value;
  
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true }));
  el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
  await sleep(400);
  return true;
}

async function pickDropdown(labelText, value) {
  const lower = labelText.toLowerCase();

  // Ensure any previously-open overlay is dismissed so we don't accidentally
  // type into the prior step's still-visible search input.
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await sleep(400);

  // Helper: verify a candidate combobox is actually labeled `labelText` by checking its
  // aria-label OR a nearby label element. Prevents matching a sibling combobox that just
  // happens to share placeholder text (this was causing Body Style values like "SUV"/"Truck"
  // to land in the Model field when Model selection was still settling).
  const isLabeled = (el) => {
    const aria = (el.getAttribute('aria-label') || '').trim().toLowerCase();
    if (aria === lower) return true;
    if (aria.startsWith(lower)) return true;
    // Walk up looking for a label/span sibling
    let node = el;
    for (let i = 0; i < 4 && node; i++) {
      node = node.parentElement;
      if (!node) break;
      const labelEl = node.querySelector?.('label, span');
      if (labelEl && labelEl.textContent.trim().toLowerCase() === lower) return true;
    }
    return false;
  };

  // Find the dropdown using multiple strategies (FB keeps moving things around)
  const trigger = await waitFor(() => {
    // 1. Exact aria-label match (most reliable when present)
    const byAria = document.querySelector(`[role="combobox"][aria-label="${labelText}" i]`);
    if (byAria) return byAria;

    // 2. Combobox whose own text content is exactly the label (placeholder state)
    const comboboxes = [...document.querySelectorAll('[role="combobox"]')];
    const exact = comboboxes.find(el => el.textContent.trim().toLowerCase() === lower);
    if (exact) return exact;

    // 3. Label-element pattern: a label/span with text "Year" near a combobox
    const labels = [...document.querySelectorAll('label, span')];
    for (const lbl of labels) {
      if (lbl.textContent.trim().toLowerCase() === lower) {
        const combo = lbl.querySelector('[role="combobox"]')
          || lbl.parentElement?.querySelector('[role="combobox"]')
          || lbl.closest('label')?.querySelector('[role="combobox"]');
        // Confirm this combobox really belongs to our label, not a neighbor
        if (combo && isLabeled(combo)) return combo;
      }
    }

    // 4. Loose fallback — combobox text starts with label but isn't enormous,
    //    AND confirmed to actually belong to this label by aria/sibling check.
    return comboboxes.find(el => {
      const txt = el.textContent.trim().toLowerCase();
      return txt.startsWith(lower) && txt.length < lower.length + 30 && isLabeled(el);
    });
  }, 10000);

  if (!trigger) {
    console.warn(`❌ Dropdown not found: ${labelText}`);
    return false;
  }

  trigger.scrollIntoView({ behavior: 'smooth', block: 'center' });
  await sleep(500);
  trigger.click();
  await sleep(1500); // Wait for FB's dropdown overlay to mount

  // Find search input INSIDE a dropdown/overlay container (anchored — not just any visible empty input on page)
  const searchInput = await waitFor(() => {
    const containers = [...document.querySelectorAll('[role="dialog"], [role="listbox"], [role="menu"]')];
    for (const c of containers) {
      if (c.closest('[aria-hidden="true"]')) continue;
      const input = c.querySelector('input:not([type="hidden"])');
      if (input && !input.value && input.offsetParent !== null) return input;
    }
    // Fallback: any empty visible input (older FB DOMs)
    return [...document.querySelectorAll('input')].find(el =>
      el.offsetParent !== null
      && el.type !== 'hidden'
      && !el.closest('[aria-hidden="true"]')
      && !el.value
    );
  }, 4000);

  if (searchInput) {
    searchInput.click();
    searchInput.focus();
    await sleep(300);
    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    if (nativeSetter) nativeSetter.call(searchInput, value);
    else searchInput.value = value;
    searchInput.dispatchEvent(new Event('input', { bubbles: true }));
    searchInput.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(1200);
  }

  const option = await waitFor(() => {
    const targets = [...document.querySelectorAll('[role="option"]')];
    return targets.find(el => el.textContent.trim().toLowerCase() === value.toString().toLowerCase())
        || targets.find(el => el.textContent.trim().toLowerCase().includes(value.toString().toLowerCase()));
  }, 6000);

  if (option) {
    option.click();
    await sleep(800);
    console.log(`✓ ${labelText} set:`, value);
    return true;
  }

  console.warn(`❌ Option not found for ${labelText}:`, value);
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await sleep(400);
  return false;
}

function mapColor(color) {
  if (!color) return 'Black';
  const c = color.toLowerCase();
  if (c.includes('black') || c.includes('midnight') || c.includes('mosaic')) return 'Black';
  if (c.includes('white') || c.includes('ivory') || c.includes('pearl') || c.includes('summit')) return 'White';
  if (c.includes('silver') || c.includes('grey') || c.includes('gray') || c.includes('moonstone') || c.includes('sterling') || c.includes('satin')) return 'Silver';
  if (c.includes('red') || c.includes('crimson') || c.includes('cherry') || c.includes('cayenne')) return 'Red';
  if (c.includes('blue') || c.includes('navy') || c.includes('cobalt') || c.includes('pacific') || c.includes('empire')) return 'Blue';
  if (c.includes('green') || c.includes('forest') || c.includes('sage')) return 'Green';
  if (c.includes('brown') || c.includes('bronze') || c.includes('copper')) return 'Brown';
  if (c.includes('gold') || c.includes('yellow') || c.includes('champagne') || c.includes('harvest')) return 'Gold';
  if (c.includes('orange')) return 'Orange';
  if (c.includes('purple') || c.includes('violet')) return 'Purple';
  if (c.includes('tan') || c.includes('beige') || c.includes('sand') || c.includes('dune')) return 'Tan';
  return 'Other';
}

// ── Status overlay ────────────────────────────
function showStatus(message, type = 'info') {
  let overlay = document.getElementById('wc-status');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'wc-status';
    overlay.style.cssText = `
      position:fixed;bottom:130px;right:20px;background:#1a1a1a;
      color:#fff;padding:12px 18px;border-radius:10px;font-size:13px;
      font-family:-apple-system,sans-serif;z-index:2147483646;
      border:1px solid #333;max-width:280px;
      box-shadow:0 4px 20px rgba(0,0,0,0.4);
    `;
    document.body.appendChild(overlay);
  }
  overlay.style.borderColor = type === 'success' ? '#22c55e' : '#3b82f6';
  overlay.innerHTML = `
    <div style="font-weight:600;margin-bottom:4px">${type === 'success' ? '✅' : '⚙️'} Marketplace Lister</div>
    <div style="color:#aaa">${message}</div>
  `;
}

// ── Photo injection ───────────────────────────
// Locate Facebook's hidden file input. Tries multiple selectors because FB has
// shipped at least three variants over the past year and we can't assume which
// build a given user lands on. Returns null if none mount within the timeout.
function findFileInput() {
  // Most specific first → most permissive last
  const selectors = [
    'input[type="file"][accept*="image"]',
    'input[type="file"][accept*="jpeg"]',
    'input[type="file"][accept*="png"]',
    'input[type="file"][multiple]',
    'input[type="file"]'
  ]
  for (const sel of selectors) {
    const inputs = [...document.querySelectorAll(sel)]
    // Prefer inputs that are inside a labelled "photos"/"media" region
    const inPhotoRegion = inputs.find(input => {
      const region = input.closest('[role="dialog"], [data-pagelet*="photo" i], [aria-label*="photo" i]')
      return !!region
    })
    if (inPhotoRegion) return inPhotoRegion
    if (inputs.length) return inputs[0]
  }
  return null
}

// Inject photos directly into Facebook's hidden file input. The input only mounts
// AFTER the user clicks "Add photos", so we surface it first if missing.
async function injectPhotosIntoInput(imageUrls) {
  console.log('[MarketSync] injectPhotosIntoInput start with', imageUrls.length, 'URLs')

  let fileInput = findFileInput()
  console.log('[MarketSync] initial file input found:', !!fileInput)

  // Input not in DOM yet — click "Add photos" (or any variant) to mount it.
  // Tries permissive selectors because Facebook ships different labels in
  // different builds/locales (e.g. "Add Photos", "Add photo", "Photo · Video", etc).
  if (!fileInput) {
    const findAddBtn = () => {
      // aria-label match (case-insensitive, contains "photo")
      const byAria = [...document.querySelectorAll('[aria-label]')].find(el => {
        const al = (el.getAttribute('aria-label') || '').toLowerCase()
        return al.includes('add') && al.includes('photo')
      })
      if (byAria) return byAria

      // Visible text match — any clickable element whose text says "Add ... photo"
      const candidates = [...document.querySelectorAll('div[role="button"], button, [role="button"]')]
      const byText = candidates.find(el => {
        const t = (el.textContent || '').toLowerCase().trim()
        return t.length < 50 && t.includes('add') && (t.includes('photo') || t.includes('media'))
      })
      if (byText) return byText

      // Last resort — any element with "Add photos" / "Add Photos" / "Photo · Video"
      return candidates.find(el => /add\s*photos?|photo\s*[·•]\s*video/i.test(el.textContent || ''))
    }

    const addBtn = findAddBtn()
    console.log('[MarketSync] Add photos button found:', !!addBtn, addBtn?.getAttribute('aria-label') || addBtn?.textContent?.slice(0, 40))
    if (addBtn) {
      try { addBtn.scrollIntoView({ behavior: 'instant', block: 'center' }) } catch {}
      addBtn.click()
      for (let i = 0; i < 10; i++) {
        await sleep(500);
        fileInput = findFileInput()
        if (fileInput) { console.log('[MarketSync] file input mounted after', (i + 1) * 500, 'ms'); break; }
      }
      // Don't auto-dismiss modals — FB sometimes opens a file picker dialog that
      // we want to KEEP open so the user can pick photos manually if injection fails
      if (!fileInput) fileInput = findFileInput()
    } else {
      console.warn('[MarketSync] No Add photos button found. Available role=button labels:',
        [...document.querySelectorAll('[role="button"][aria-label]')]
          .slice(0, 20)
          .map(el => el.getAttribute('aria-label')))
    }
  }

  if (!fileInput) {
    console.warn('[MarketSync] No file input found. Available inputs:',
      [...document.querySelectorAll('input[type="file"]')].map(i => ({
        accept: i.accept, multiple: i.multiple, name: i.name
      })))
    return false;
  }
  console.log('[MarketSync] using file input:', { accept: fileInput.accept, multiple: fileInput.multiple })

  // Upload only the first 20 photos. Listings sometimes have more, but 20 is all
  // we need (and all we upload) — any extras are intentionally ignored.
  const MAX_PHOTOS = 20
  const files = [];
  let fetchFailures = 0;
  for (let i = 0; i < Math.min(imageUrls.length, MAX_PHOTOS); i++) {
    try {
      const res = await fetch(`${API}/proxy-image?url=${encodeURIComponent(imageUrls[i])}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      if (blob.size < 1000) throw new Error(`blob too small (${blob.size}B — probably an error page)`);
      files.push(new File([blob], `photo_${i + 1}.jpg`, { type: 'image/jpeg' }));
    } catch (e) {
      console.warn(`[MarketSync] photo ${i + 1} fetch failed: ${e.message}`);
      fetchFailures++;
    }
  }
  console.log(`[MarketSync] fetched ${files.length}/${imageUrls.length} photos (${fetchFailures} failed)`)

  if (!files.length) {
    console.warn('[MarketSync] No photos could be downloaded from proxy — check backend /proxy-image endpoint')
    return false;
  }

  const dt = new DataTransfer();
  files.forEach(f => dt.items.add(f));

  const nativeFileSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'files');
  if (nativeFileSetter?.set) {
    nativeFileSetter.set.call(fileInput, dt.files);
  } else {
    Object.defineProperty(fileInput, 'files', { value: dt.files, configurable: true });
  }

  fileInput.dispatchEvent(new Event('change', { bubbles: true }));
  fileInput.dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(2500);

  // Don't trust fileInput.files.length === 0 as failure: FB sometimes clears the
  // input after consuming it. Look for ANY image previews appearing on the page
  // as a more reliable success signal.
  const previewCount = document.querySelectorAll('img[src^="blob:"]').length
  console.log(`[MarketSync] post-inject: input.files=${fileInput.files.length}, blob previews=${previewCount}`)
  if (previewCount > 0 || fileInput.files.length > 0) return true
  return false
}

// ── Photo strip ───────────────────────────────
function showPhotoStrip(allImageUrls, vehicleId) {
  if (!allImageUrls?.length) return;
  // Only the first 20 photos are uploaded, so only preview/inject those.
  const imageUrls = allImageUrls.slice(0, 20);
  document.getElementById('wc-photo-strip')?.remove();

  const uploadZone = document.querySelector('[aria-label="Add photos"]') ||
    ([...document.querySelectorAll('div')].find(el => el.textContent.trim() === 'Add photos'));
  if (uploadZone) {
    uploadZone.style.outline = '3px dashed #3b82f6';
    uploadZone.style.outlineOffset = '4px';
    uploadZone.style.borderRadius = '8px';
  }

  const strip = document.createElement('div');
  strip.id = 'wc-photo-strip';
  strip.style.cssText = `
    position:fixed;bottom:0;left:0;right:0;height:110px;
    background:#111;border-top:2px solid #3b82f6;
    padding:10px 16px;z-index:2147483647;
    display:flex;align-items:center;gap:12px;
    font-family:-apple-system,sans-serif;
    box-shadow:0 -4px 24px rgba(0,0,0,0.6);
  `;

  const label = document.createElement('div');
  label.style.cssText = 'color:#fff;font-size:12px;font-weight:700;white-space:nowrap;min-width:110px;line-height:1.6;';
  label.innerHTML = `📸 ${imageUrls.length} Photos<br><span style="color:#888;font-size:10px;">Click Upload Photos</span>`;
  strip.appendChild(label);

  const row = document.createElement('div');
  row.style.cssText = 'display:flex;gap:8px;overflow-x:auto;flex:1;align-items:center;padding-bottom:4px;';
  imageUrls.forEach((url, i) => {
    const proxySrc = `${API}/proxy-image?url=${encodeURIComponent(url)}`;
    const wrapper = document.createElement('div');
    wrapper.style.cssText = 'position:relative;flex-shrink:0;';
    const img = document.createElement('img');
    img.src = proxySrc;
    img.style.cssText = 'height:80px;width:110px;object-fit:cover;border-radius:8px;border:2px solid #2a2a2a;display:block;';
    const num = document.createElement('div');
    num.style.cssText = 'position:absolute;top:4px;left:4px;background:rgba(0,0,0,0.7);color:#fff;font-size:10px;padding:2px 5px;border-radius:4px;';
    num.textContent = i + 1;
    wrapper.appendChild(img);
    wrapper.appendChild(num);
    row.appendChild(wrapper);
  });
  strip.appendChild(row);

  const uploadBtn = document.createElement('button');
  uploadBtn.textContent = '📁 Upload Photos';
  uploadBtn.style.cssText = 'background:#3b82f6;border:none;color:#fff;padding:8px 12px;border-radius:8px;font-size:12px;font-weight:700;cursor:pointer;white-space:nowrap;flex-shrink:0;';
  uploadBtn.addEventListener('click', async () => {
    uploadBtn.textContent = '⏳ Working...';
    uploadBtn.disabled = true;
    showStatus('Trying to inject photos...', 'info');

    const injected = await injectPhotosIntoInput(imageUrls);
    if (injected) {
      uploadBtn.textContent = '✅ Photos uploaded!';
      uploadBtn.style.background = '#22c55e';
      uploadBtn.style.color = '#000';
      showStatus('✅ Photos uploaded successfully!', 'success');
    } else {
      // Injection failed even after surfacing the file input. Don't bulk-download
      // the user's Mac with 20+ random files — that was the old "stuck at
      // Downloading photos" behavior. Show a clear error + retry button instead.
      uploadBtn.textContent = '⚠️ Retry Upload';
      uploadBtn.style.background = '#ef4444';
      uploadBtn.style.color = '#fff';
      uploadBtn.disabled = false;
      showStatus('Photo upload failed. Click "Add photos" on Facebook to open the upload box, then click Retry Upload.', 'error');
    }
  });
  strip.appendChild(uploadBtn);

  const markPosted = document.createElement('button');
  markPosted.textContent = '✅ Mark Posted';
  markPosted.style.cssText = 'background:#22c55e;border:none;color:#000;padding:8px 12px;border-radius:8px;font-size:12px;font-weight:700;cursor:pointer;white-space:nowrap;flex-shrink:0;';
  markPosted.addEventListener('click', () => {
    // No confirmation popup — auto-detection handles the "post on FB first" case via the
    // URL watcher in the create-page bootstrap. This button is a manual backup.
    markPosted.textContent = 'Saving...';
    markPosted.disabled = true;
    // Only attach the URL if we're actually on the published item page. On the create
    // page this would be .../marketplace/create/vehicle — a useless link. When null,
    // the listing is still marked posted and the auto-detector backfills the real URL.
    const here = window.location.href;
    const fbUrl = here.includes('/marketplace/item/') ? here : null;
    chrome.runtime.sendMessage(
      { type: 'LISTING_POSTED', inventory_id: vehicleId, fb_listing_url: fbUrl },
      (response) => {
        if (response?.success) {
          markPosted.textContent = '✅ Posted!';
          markPosted.style.background = '#166534';
          markPosted.style.color = '#4ade80';
          showStatus('✅ Listing saved to your dashboard.', 'success');
          // Auto-close any open photo lightbox / dialog after a successful post,
          // plus the MarketSync photo strip itself, so the user gets back to a
          // clean view ready for the next listing.
          closePhotoLightboxes()
          setTimeout(() => document.getElementById('wc-photo-strip')?.remove(), 1200)
        } else {
          markPosted.textContent = '⚠️ Save failed — retry';
          markPosted.disabled = false;
          markPosted.style.background = '#ef4444';
          markPosted.style.color = '#fff';
          const err = response?.error || 'unknown error';
          console.error('Mark Posted failed:', response);
          showStatus(`⚠️ Could not save listing: ${err}`, 'info');
        }
      }
    );
  });
  strip.appendChild(markPosted);

  const close = document.createElement('button');
  close.textContent = '✕';
  close.style.cssText = 'background:#1a1a1a;border:1px solid #333;color:#888;padding:8px 12px;border-radius:8px;font-size:12px;cursor:pointer;white-space:nowrap;flex-shrink:0;';
  close.addEventListener('click', () => {
    strip.remove();
    document.getElementById('wc-status')?.remove();
    if (uploadZone) uploadZone.style.outline = '';
  });
  strip.appendChild(close);
  document.body.appendChild(strip);
}

// Close any open photo lightbox / modal on Facebook. Tries three strategies in
// order — Escape key (the cleanest), then "Close" button by aria-label, then
// click outside the dialog area. Safe to call when nothing is open.
function closePhotoLightboxes() {
  const openDialogs = () => [...document.querySelectorAll('[role="dialog"]')].filter(d =>
    d.offsetParent !== null && !d.closest('[aria-hidden="true"]')
  )

  const closeOnce = () => {
    // 1. Escape key — most modals listen for this
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }))
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }))

    // 2. Click any visible Close/X button inside an open dialog
    for (const dlg of openDialogs()) {
      const closeBtn = dlg.querySelector('[aria-label="Close" i], [aria-label*="close" i]')
      if (closeBtn) { closeBtn.click(); continue }
      // Some FB modals use just an X icon — match text "×"/"✕"/"Close" or an aria-label
      const buttons = [...dlg.querySelectorAll('div[role="button"], button, [role="button"]')]
      const xBtn = buttons.find(b => {
        const t = b.textContent.trim()
        const al = (b.getAttribute('aria-label') || '').toLowerCase()
        return t === '×' || t === 'Close' || t === '✕' || al.includes('close')
      })
      if (xBtn) xBtn.click()
    }
  }

  // FB photo lightboxes can take a moment to mount/dismiss, and closing the photo
  // viewer sometimes reveals an underlying dialog. Retry a few passes so the user
  // never has to hit X manually after posting.
  closeOnce()
  let attempts = 0
  const timer = setInterval(() => {
    closeOnce()
    if (!openDialogs().length || ++attempts >= 6) clearInterval(timer)
  }, 350)
}

// ── Main form filler ──────────────────────────
async function fillListingForm(vehicle) {
  const make = normalizeMake(vehicle.make);
  const model = normalizeModel(vehicle.model);
  const bodyStyle = deduceBodyStyle(vehicle.make, vehicle.model);
  
  console.log('🚗 Starting Run:', vehicle.year, make, model, `[Style: ${bodyStyle}]`);
  showStatus('Starting engine execution... please maintain view focus.');
  await sleep(2500);

  // VEHICLE TYPE
  showStatus('Selecting vehicle type...');
  await pickDropdown('Vehicle type', 'Car/Truck');
  await sleep(DELAY);

  // YEAR
  showStatus('Selecting year...');
  await pickDropdown('Year', String(vehicle.year));
  await sleep(DELAY);

  // MAKE
  showStatus('Selecting make...');
  await pickDropdown('Make', make);
  await sleep(2000); // Let Facebook commit Make before Model field activates

  // MODEL — FB renders this AFTER Make commits. Wait longer + use multiple selector strategies
  // (aria-label, parent label text, then textContent) since textContent alone is fragile.
  showStatus('Selecting model (waiting for Facebook to mount field)...');
  await sleep(2500); // Longer wait — Make must finish committing before Model becomes interactive

  const findModelTrigger = () => {
    // Strategy 1: Explicit aria-label (most reliable when present)
    const byAria = document.querySelector(
      '[role="combobox"][aria-label="Model" i], ' +
      '[role="combobox"][aria-label="Vehicle model" i], ' +
      '[role="combobox"][aria-label*="model" i]'
    );
    if (byAria) return byAria;

    // Strategy 2: text input with placeholder/label containing "model"
    const inputByPh = [...document.querySelectorAll('input[type="text"], input:not([type])')]
      .find(el => {
        if (el.offsetParent === null) return false
        const ph = (el.placeholder || '').toLowerCase()
        const al = (el.getAttribute('aria-label') || '').toLowerCase()
        return ph.includes('model') || al.includes('model')
      })
    if (inputByPh) return inputByPh

    // Strategy 3: Label-element pattern. Match labels that contain "model" but
    // NOT "make and model" combined (which is a different field).
    const labels = [...document.querySelectorAll('label, span, div')];
    for (const lbl of labels) {
      const text = lbl.textContent.trim().toLowerCase();
      const isModel = (text === 'model' || text === 'vehicle model')
                   || (text.endsWith(' model') && !text.includes('make'))
      if (!isModel) continue
      // Walk up to find the nearest combobox or text input
      let node = lbl
      for (let i = 0; i < 5 && node; i++) {
        const combo = node.querySelector?.('[role="combobox"], input[type="text"]:not([readonly])')
        if (combo && combo.offsetParent !== null) return combo
        node = node.parentElement
      }
    }

    // Strategy 4: any role=combobox whose visible text equals or starts with "model"
    const placeholderMatch = [...document.querySelectorAll('[role="combobox"]')].find(el => {
      const txt = el.textContent.trim().toLowerCase();
      return txt === 'model' || txt === 'vehicle model' || txt.startsWith('model ')
    });
    if (placeholderMatch) return placeholderMatch

    // Strategy 5 (last resort): the combobox that appears AFTER the Make combobox
    // in the DOM. Make has just been selected so it shows the make name now.
    const allCombos = [...document.querySelectorAll('[role="combobox"]')]
    const makeLower = (make || '').toLowerCase()
    const makeIdx = makeLower
      ? allCombos.findIndex(el => el.textContent.trim().toLowerCase().includes(makeLower))
      : -1
    if (makeIdx >= 0 && allCombos[makeIdx + 1]) {
      const next = allCombos[makeIdx + 1]
      const nextTxt = next.textContent.trim().toLowerCase()
      // Skip if next combobox is clearly something else (Body Style, etc.)
      const knownOthers = ['body style', 'vehicle type', 'transmission', 'fuel type', 'condition', 'exterior color', 'interior color']
      if (!knownOthers.some(k => nextTxt.includes(k))) return next
    }

    return null
  };

  const modelTrigger = await waitFor(findModelTrigger, 15000);

  if (!modelTrigger) {
    console.error('❌ Model dropdown not found after 15s. Fill manually.');
    showStatus('Could not find Model field — fill manually.', 'info');
  } else if (modelTrigger.tagName === 'INPUT' && modelTrigger.getAttribute('role') !== 'combobox') {
    // FB renders Model as a plain free-text input for some makes (no option list).
    // The dropdown dance below would silently fail here, so just type the value.
    modelTrigger.scrollIntoView({ behavior: 'smooth', block: 'center' });
    await sleep(600);
    await typeInto(modelTrigger, model);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await sleep(400);
    console.log('✓ Model typed into free-text field:', model);
  } else {
    modelTrigger.scrollIntoView({ behavior: 'smooth', block: 'center' });
    await sleep(600);
    modelTrigger.click();
    await sleep(2000); // Wait for FB to mount the dropdown overlay

    // Wait for the search input INSIDE the model overlay specifically. Earlier
    // we did a document-wide hunt for "any empty input" — that's how Envision /
    // RAV4 / Forester / Equinox ended up typed into the Body Style overlay's
    // search box when FB hadn't fully closed its previous overlay. Scoping to
    // [role="dialog"] / [role="listbox"] makes us only see the model dropdown.
    const searchInput2 = await waitFor(() => {
      const containers = [...document.querySelectorAll('[role="dialog"], [role="listbox"], [role="menu"]')]
      for (const c of containers) {
        if (c.closest('[aria-hidden="true"]')) continue
        const input = c.querySelector('input:not([type="hidden"])')
        if (input && !input.value && input.offsetParent !== null) return input
      }
      return null
    }, 5000);

    if (searchInput2) {
      searchInput2.click();
      searchInput2.focus();
      await sleep(300);
      const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      if (nativeSetter) nativeSetter.call(searchInput2, model);
      else searchInput2.value = model;
      searchInput2.dispatchEvent(new Event('input', { bubbles: true }));
      searchInput2.dispatchEvent(new Event('change', { bubbles: true }));
      await sleep(1500);
    } else {
      console.warn('Model: no search input found in dropdown overlay');
    }

    // Scope option search to the SAME overlay the search input is in — prevents
    // grabbing a stray option from an unrelated panel (e.g., Body Style).
    const modelOverlay = searchInput2?.closest('[role="dialog"], [role="listbox"], [role="menu"]') || document;
    const modelLower = model.toLowerCase();
    const modelOption = await waitFor(() => {
      const targets = [...modelOverlay.querySelectorAll('[role="option"]')];
      // EXACT match first
      const exact = targets.find(el => el.textContent.trim().toLowerCase() === modelLower);
      if (exact) return exact;
      // Then "starts with" (handles "Envision Avenir" matching "envision")
      const startsWith = targets.find(el => el.textContent.trim().toLowerCase().startsWith(modelLower));
      if (startsWith) return startsWith;
      // Then "contains" — BUT only if the option text is short enough that
      // it can't be a body-style category accidentally containing the model
      // name. Cap at 40 chars so something like "Compact SUVs (5 vehicles)"
      // can't be matched while real model names get through.
      const looseContains = targets.find(el => {
        const t = el.textContent.trim().toLowerCase();
        return t.length < 40 && t.includes(modelLower);
      });
      return looseContains;
    }, 6000);

    if (modelOption) {
      modelOption.click();
      await sleep(1200);
      // Force any leftover overlay to close before Body Style runs
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await sleep(400);
      console.log('✓ Model selected:', model);
    // ── REPLACE this block in content.js (the "free-text fallback" inside the
//    main Model selection, right after the modelOption search) ──
// Old version: `document.querySelector('[role="option"]')` — grabs ANY
// option visible anywhere on the page. New version scopes the search to
// the overlay the text field actually opened.

} else {
  // No matching option in the model overlay. Don't fall back to a generic
  // free-text input — that's how SUV / Truck got dumped into Model. Just
  // log + close the overlay; the verification step below will retry with
  // the same scoped logic, and the user can finish manually if needed.
  console.warn(`❌ No "${model}" option in FB's Model list.`);
  // FB's model search box accepts custom typed values. If we already typed the
  // model into the scoped overlay search input, commit it with Enter rather than
  // discarding it — this fills the field correctly for models not in FB's list.
  if (searchInput2 && searchInput2.value) {
    searchInput2.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
    await sleep(500);
    console.log('✓ Committed custom model value via Enter:', model);
  } else {
    showStatus(`"${model}" wasn't in Facebook's Model list — please type it manually.`, 'info');
  }
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await sleep(400);
}
  }
  // Wait longer for the Model commit so the next combobox lookup doesn't grab the
  // Model field by mistake. 2500ms beats the visual confirmation we observed.
  await sleep(2500);

  // VERIFY the Model field actually shows the model name. If it's empty or contains a
  // body-style value (SUV/Truck/Sedan/etc.), the model selection didn't take — log and
  // continue; this is what was causing "SUV"/"Truck" to leak into Model when Body Style
  // ran next.
 // ── REPLACE this block in content.js (the one that checks bodyStyleVocab) ──
// Old version detected the corruption but never actually fixed it — it just
// opened the dropdown and pressed Escape. This version retries the real
// model search/select sequence.

const modelComboboxNow = document.querySelector('[role="combobox"][aria-label="Model" i], [role="combobox"][aria-label="Vehicle model" i]');
const modelDisplayedNow = (modelComboboxNow?.textContent || '').trim().toLowerCase();
const bodyStyleVocab = ['suv', 'truck', 'sedan', 'coupe', 'hatchback', 'convertible', 'minivan', 'van', 'wagon'];

if (modelComboboxNow && (
  !modelDisplayedNow ||
  bodyStyleVocab.includes(modelDisplayedNow) ||
  modelDisplayedNow === 'model' ||
  modelDisplayedNow === 'vehicle model'
)) {
  console.warn(`⚠️ Model field shows "${modelDisplayedNow || '(empty)'}" instead of "${model}" — retrying selection`);

  modelComboboxNow.scrollIntoView({ behavior: 'smooth', block: 'center' });
  await sleep(500);
  modelComboboxNow.click();
  await sleep(1800); // overlay mount

  // Search input scoped to the open overlay only (not the whole document) —
  // this is what stops us from grabbing a leftover option from another panel.
  const retrySearchInput = await waitFor(() => {
    const containers = [...document.querySelectorAll('[role="dialog"], [role="listbox"], [role="menu"]')];
    for (const c of containers) {
      if (c.closest('[aria-hidden="true"]')) continue;
      const input = c.querySelector('input:not([type="hidden"])');
      if (input && input.offsetParent !== null) return input;
    }
    return null;
  }, 4000);

  if (retrySearchInput) {
    retrySearchInput.click();
    retrySearchInput.focus();
    await sleep(300);
    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    if (nativeSetter) nativeSetter.call(retrySearchInput, model);
    else retrySearchInput.value = model;
    retrySearchInput.dispatchEvent(new Event('input', { bubbles: true }));
    retrySearchInput.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(1500);

    // Option search scoped to the SAME overlay the search input lives in —
    // never falls back to a bare document-wide query() that could click
    // a stray option from an unrelated panel.
    const overlay = retrySearchInput.closest('[role="dialog"], [role="listbox"], [role="menu"]') || document;
    const retryOption = await waitFor(() => {
      const targets = [...overlay.querySelectorAll('[role="option"]')];
      return targets.find(el => el.textContent.trim().toLowerCase() === model.toLowerCase())
          || targets.find(el => el.textContent.trim().toLowerCase().includes(model.toLowerCase()));
    }, 6000);

    if (retryOption) {
      retryOption.click();
      await sleep(1000);
      console.log('✓ Model corrected on retry:', model);
    } else {
      console.error(`❌ Still could not find "${model}" in the Model dropdown after retry. Fill manually.`);
      showStatus(`Could not auto-select model "${model}" — please set it manually.`, 'info');
    }
  } else {
    console.error('❌ Retry: no search input found in Model overlay.');
    showStatus(`Could not auto-select model "${model}" — please set it manually.`, 'info');
  }

  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await sleep(400);
}

  // BODY STYLE (Dynamically determined). The hardened pickDropdown above is now
  // strict about aria-label / sibling-label matching, so it won't accidentally
  // re-target the Model field even if Facebook re-renders the form.
  showStatus(`Selecting body style (${bodyStyle})...`);
  await pickDropdown('Body style', bodyStyle);
  await sleep(DELAY);

  // EXTERIOR COLOR
  showStatus('Selecting exterior color...');
  await pickDropdown('Exterior color', mapColor(vehicle.exterior_color));
  await sleep(DELAY);

  // INTERIOR COLOR
  showStatus('Selecting interior color...');
  await waitFor(() =>
    [...document.querySelectorAll('[role="combobox"]')]
      .find(el => el.textContent.trim().toLowerCase().includes('interior'))
  );
  await pickDropdown('Interior color', mapColor(vehicle.interior_color) || 'Black');
  await sleep(DELAY);

  // VEHICLE CONDITION
  showStatus('Selecting condition...');
  await waitFor(() =>
    [...document.querySelectorAll('[role="combobox"]')]
      .find(el => el.textContent.trim().toLowerCase().includes('condition'))
  );
  // FB Marketplace's vehicle condition uses 5-point labels ("Excellent","Very Good",
  // "Good","Fair","Poor"). Per request, condition is ALWAYS listed as "Good"
  // regardless of the source vehicle's condition value.
  await pickDropdown('Vehicle condition', 'Good');
  await sleep(DELAY);

  // FUEL TYPE
  showStatus('Selecting fuel type...');
  await pickDropdown('Fuel type', vehicle.fuel_type || 'Gasoline');
  await sleep(DELAY);

  // TRANSMISSION
  showStatus('Selecting transmission...');
  await pickDropdown('Transmission', vehicle.transmission || 'Automatic');
  await sleep(DELAY);

  // MILEAGE — use the vehicle's actual kms. Facebook rejects unusually-low values
  // on some categories (delivery/demo cars with 0-5 km look like data errors), so
  // anything under 30 gets bumped to 300 to ensure the listing validates.
  showStatus('Filling mileage...');
  const mileageEl = await waitFor(() =>
    getFormFields().find(f =>
      f.closest('label, div')?.textContent?.includes('Mileage') ||
      f.closest('label, div')?.textContent?.includes('Kilometers')
    )
  );
  const rawMileage = Number(vehicle.mileage) || 0;
  const finalMileage = rawMileage < 30 ? 300 : rawMileage;
  if (mileageEl) await typeInto(mileageEl, String(finalMileage));
  await sleep(DELAY);

  // PRICE
  showStatus('Filling price...');
  const priceEl = await waitFor(() =>
    getFormFields().find(f => f.closest('label, div')?.textContent?.includes('Price'))
  );
  if (priceEl) await typeInto(priceEl, String(Math.round(vehicle.price)));
  await sleep(DELAY);

  // DESCRIPTION
  showStatus('Writing description...');
  const descEl = await waitFor(() => document.querySelector('textarea'));
  if (descEl) {
    // Pull dealership/rep info from the poster profile that popup.js attached.
    const rawDealership = vehicle.poster?.dealership?.name || '';
    const repName = vehicle.poster?.full_name || '';
    const repEmail = vehicle.poster?.email || '';
    const repPhone = vehicle.poster?.phone || '';
    const dealerPhone = vehicle.poster?.dealership?.phone || '';
    const dealerWebsite = vehicle.poster?.dealership?.website_url || '';

    // Personal accounts are auto-named "{Name} — Personal". Show "Dealer" instead
    // (for every account), and always produce a headline — even with no dealership.
    const displayDealership = rawDealership.replace(/\bPersonal\b/gi, 'Dealer');
    const brandName = displayDealership || (repName ? `${repName} — Dealer` : 'Dealer');

    // Marketing headline at the very top — auto-filled from the user's profile so
    // nothing has to be typed manually.
    const headline = `🔥 ${brandName} | Plus HST & Licensing | HOT DEAL! 🔥`;

    const baseDesc = vehicle.ai_description || vehicle.description ||
      `${vehicle.year} ${make} ${model} ${vehicle.trim || ''}. ` +
      `${vehicle.mileage ? vehicle.mileage.toLocaleString() + ' km. ' : ''}` +
      `${vehicle.exterior_color ? vehicle.exterior_color + ' exterior. ' : ''}` +
      `${vehicle.transmission || 'Automatic'} transmission.`;

    // Pricing disclaimer in the body (separate from the headline) so it's explicit.
    const pricingLine = '💲 Price plus applicable tax & licensing.';

    // Contact name: avoid the "Jane Doe — Jane Doe — Dealer" duplication that happens
    // when a personal account's dealership name already starts with the rep's name.
    const isPersonalDealer = displayDealership && repName &&
      displayDealership.toLowerCase().startsWith(repName.toLowerCase());
    const contactName = isPersonalDealer
      ? displayDealership
      : (repName ? (displayDealership ? `${repName} — ${displayDealership}` : repName) : displayDealership);

    // Tracked deep link → logs the click (powers the FB CLICK-THROUGHS metric) then
    // 302s the buyer to this vehicle's detail page on the dealer site. Keyed by the
    // inventory id because the listing row isn't created until after the post goes
    // live. Falls back to the plain website if we somehow lack an id.
    const trackedLink = vehicle.id ? `${API}/r/v/${vehicle.id}?s=fb` : null;

    const contactLines = [
      '',
      '─── CONTACT ───',
      contactName || null,
      repPhone ? `📞 ${repPhone}` : (dealerPhone ? `📞 ${dealerPhone}` : null),
      repEmail ? `✉️ ${repEmail.replace('@', ' [at] ')}` : null,
      trackedLink ? `🌐 Full details & photos: ${trackedLink}`
                  : (dealerWebsite ? `🌐 ${dealerWebsite}` : null)
    ].filter(Boolean);

    const desc = [
      headline,
      '',
      baseDesc,
      '',
      pricingLine,
      contactLines.join('\n')
    ].filter(s => s !== null).join('\n');

    await typeInto(descEl, desc);
  }
  await sleep(DELAY);

  showStatus('✅ Form filled! Click Upload Photos.', 'success');
  showPhotoStrip(vehicle.image_urls || [], vehicle.id);
  console.log('✅ Automated pipeline processing successfully executed.');
}

// ── Boot ──────────────────────────────────────
const isCreatePage = /\/marketplace\/create(\/|\?|$)/i.test(window.location.href);
console.log('[MarketSync] is marketplace create page?', isCreatePage);

if (isCreatePage) {
  chrome.storage.local.get(['pendingPost'], ({ pendingPost }) => {
    console.log('[MarketSync] pendingPost found:', !!pendingPost?.vehicle);
    if (!pendingPost?.vehicle) return;
    chrome.storage.local.remove(['pendingPost']);
    console.log('[MarketSync] ✓ filling form for', pendingPost.vehicle.year, pendingPost.vehicle.make, pendingPost.vehicle.model);
    const vehicleWithPoster = { ...pendingPost.vehicle, poster: pendingPost.poster || null };
    setTimeout(() => fillListingForm(vehicleWithPoster), 2500);

    let autoMarkFired = false;
    const startUrl = window.location.href;
    const watcher = setInterval(() => {
      if (autoMarkFired) { clearInterval(watcher); return; }
      const href = window.location.href;
      if (href !== startUrl && href.includes('/marketplace/item/')) {
        autoMarkFired = true;
        clearInterval(watcher);
        const vehicleId = pendingPost.vehicle.id;
        chrome.runtime.sendMessage(
          { type: 'LISTING_POSTED', inventory_id: vehicleId, fb_listing_url: href },
          (response) => {
            if (response?.success) showStatus('✅ MarketSync: listing auto-saved to dashboard.', 'success');
            else console.warn('Auto-mark posted failed:', response);
          }
        );
      }
    }, 1000);
    setTimeout(() => clearInterval(watcher), 15 * 60 * 1000);
  });
}

// ── FB-side sold detection ───────────────────────────────────────────────────
// When user visits one of their own listing pages and FB shows "Sold", auto-mark
// the corresponding listing as sold in MarketSync. Idempotent server-side.
if (window.location.href.includes('/marketplace/item/')) {
  let alreadyReported = false;

  const checkSold = async () => {
    if (alreadyReported) return;
    const isSold = detectFbSoldBadge();
    if (!isSold) return;

    alreadyReported = true;
    const { token } = await new Promise(r => chrome.storage.local.get(['token'], r));
    if (!token) return;

    try {
      const r = await fetch(`${API}/listings/sync-fb-sold`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ fb_listing_url: window.location.href })
      });
      const data = await r.json().catch(() => ({}));
      if (data.matched) {
        showStatus('✅ MarketSync: synced sold status from Facebook.', 'success');
      }
    } catch (e) {
      console.warn('FB sold sync failed:', e.message);
    }
  };

  // Try a few times — FB renders the badge after initial paint
  setTimeout(checkSold, 2500);
  setTimeout(checkSold, 6000);
  setTimeout(checkSold, 12000);

  // Also watch for the badge appearing later (e.g. user just clicked Mark as sold)
  const observer = new MutationObserver(() => { if (!alreadyReported) checkSold(); });
  observer.observe(document.body, { childList: true, subtree: true });
  // Stop observing after 60s to avoid leaks
  setTimeout(() => observer.disconnect(), 60000);
}

function detectFbSoldBadge() {
  const isVisible = (el) => {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && !el.closest('[aria-hidden="true"]');
  };

  // PRIMARY signal: the "Mark as available" button.
  // Facebook only renders this on listings you own that are currently marked sold.
  // If we see it, we know definitively the listing is sold.
  const actionables = [...document.querySelectorAll('div[role="button"], button, span, a')];
  for (const el of actionables) {
    const text = el.textContent.trim().toLowerCase();
    if (text === 'mark as available' && isVisible(el)) return true;
  }

  // SECONDARY signal: a "Sold" badge/pill near the title (red/orange text node).
  // Matches the "Sold · 2020 Honda CRV" header in the listing modal.
  const main = document.querySelector('[role="main"]') || document.body;
  const candidates = [...main.querySelectorAll('span, div')];
  for (const el of candidates) {
    const text = el.textContent.trim();
    // Leaf node with exactly "Sold"
    if (text === 'Sold' && el.children.length === 0 && isVisible(el)) return true;
  }

  return false;
}

// ── FB auto-sync: mark Sold / Delete on Facebook ──────────────────────────────
// When a vehicle is sold or deleted in MarketSync, the backend flags its listing
// and background.js opens the FB listing in a background tab. Here we detect that
// this tab was opened for an auto-sync action and perform it (click "Mark as sold"
// or "Delete listing"). Facebook has no API for this, so we drive the real UI.
// All matching is text-based + multi-fallback because FB ships frequent DOM changes.

function fbItemId(url) {
  const m = String(url || '').match(/\/marketplace\/item\/(\d+)/);
  return m ? m[1] : null;
}

function fbVisible(el) {
  if (!el) return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 && !el.closest('[aria-hidden="true"]');
}

// Find the nearest clickable element whose (own) text matches one of `texts`.
// Matches role=button / button / a / [role=menuitem] and bubbles up to a clickable.
function findClickableByText(texts, { exact = false, root = document } = {}) {
  const wants = texts.map(t => t.toLowerCase());
  const nodes = [...root.querySelectorAll('div[role="button"], button, a[role="button"], a, [role="menuitem"], span')];
  for (const el of nodes) {
    if (!fbVisible(el)) continue;
    const txt = (el.textContent || '').trim().toLowerCase();
    if (!txt || txt.length > 40) continue;
    const hit = exact ? wants.includes(txt) : wants.some(w => txt === w || txt.startsWith(w));
    if (!hit) continue;
    // Bubble up to an actually-clickable ancestor if this is a bare <span>.
    const clickable = el.closest('div[role="button"], button, a[role="button"], a, [role="menuitem"]') || el;
    return clickable;
  }
  return null;
}

// Click a confirmation-dialog button (e.g. the modal that pops after "Delete").
async function clickDialogButton(texts) {
  const dialog = await waitFor(() => document.querySelector('[role="dialog"]'), 4000);
  const root = dialog || document;
  const btn = findClickableByText(texts, { exact: true, root });
  if (btn) { btn.click(); return true; }
  return false;
}

// Open Facebook's overflow / "More" menu on a listing so menu items become reachable.
async function openFbOverflowMenu() {
  const labels = ['more', 'more options', 'actions', 'menu', 'see options'];
  // aria-label based (most reliable for the "⋯" icon button)
  const byAria = [...document.querySelectorAll('div[role="button"], button')].find(el => {
    const a = (el.getAttribute('aria-label') || '').toLowerCase();
    return fbVisible(el) && labels.some(l => a === l || a.includes(l));
  });
  const trigger = byAria || findClickableByText(['more', 'more options'], { root: document });
  if (!trigger) return false;
  trigger.click();
  await sleep(900);
  return true;
}

async function fbMarkAsSold() {
  // 1) direct button
  let btn = findClickableByText(['mark as sold'], {});
  // 2) fall back to the overflow menu
  if (!btn) { await openFbOverflowMenu(); btn = findClickableByText(['mark as sold'], {}); }
  if (!btn) return false;
  btn.click();
  await sleep(1200);
  // Some builds show a confirm dialog; click it if present (harmless if not).
  await clickDialogButton(['mark as sold', 'confirm', 'ok']);
  // Verify FB now shows the sold state.
  const ok = await waitFor(() => detectFbSoldBadge() ? true : null, 9000);
  return !!ok;
}

async function fbDeleteListing() {
  // 1) direct delete button
  let btn = findClickableByText(['delete listing', 'delete'], {});
  // 2) fall back to overflow menu
  if (!btn) { await openFbOverflowMenu(); btn = findClickableByText(['delete listing', 'delete'], {}); }
  if (!btn) return false;
  btn.click();
  await sleep(1000);
  // Confirmation modal — the final destructive "Delete" button.
  const confirmed = await clickDialogButton(['delete', 'delete listing', 'confirm']);
  await sleep(1500);
  // Success heuristics: confirm clicked, or the listing controls are gone /
  // FB shows an "isn't available" message after deletion.
  if (confirmed) return true;
  const gone = !findClickableByText(['delete listing', 'delete'], {});
  const unavailable = /isn't available|no longer available|this content isn't/i.test(document.body.innerText || '');
  return gone || unavailable;
}

// Is the user even logged into Facebook on this tab? If not, bail WITHOUT
// reporting failure, so we don't burn the listing's retry budget — we'll just
// try again on the next poll once they're logged in.
function fbLoggedOut() {
  if (/\/login\b/.test(location.pathname)) return true;
  if (document.querySelector('input[name="email"]') && document.querySelector('input[name="pass"]')) return true;
  return false;
}

(async function runFbAutoSync() {
  const itemId = fbItemId(location.href);
  if (!itemId) return;

  const { fbSyncQueue } = await new Promise(r => chrome.storage.local.get(['fbSyncQueue'], r));
  const entry = fbSyncQueue && fbSyncQueue[itemId];
  if (!entry || !entry.action) return;  // this tab wasn't opened for an auto-sync

  // Let FB hydrate the listing UI first.
  await sleep(3000);
  if (fbLoggedOut()) {
    console.warn('[MarketSync] FB auto-sync skipped — not logged into Facebook.');
    return; // no report → no attempt burned
  }

  showStatus(entry.action === 'delete'
    ? 'Removing this listing from Facebook…'
    : 'Marking this listing Sold on Facebook…');

  let ok = false;
  try {
    ok = entry.action === 'delete' ? await fbDeleteListing() : await fbMarkAsSold();
  } catch (e) {
    console.warn('[MarketSync] FB auto-sync error:', e.message);
    ok = false;
  }

  showStatus(ok
    ? (entry.action === 'delete' ? 'Listing removed from Facebook.' : 'Listing marked Sold on Facebook.')
    : 'Could not finish on Facebook — will retry later.', ok ? 'success' : 'info');

  // Report outcome so background can hit the backend + (on success) close this tab.
  chrome.runtime.sendMessage({
    type: 'FB_SYNC_REPORT',
    listingId: entry.listingId,
    itemId,
    ok
  });
})();
