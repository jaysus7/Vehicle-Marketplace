// content.js — | MarketSync
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
async function injectPhotosIntoInput(imageUrls) {
  const fileInput = document.querySelector('input[type="file"][accept*="image"]');
  if (!fileInput) { console.warn('No file input found'); return false; }

  const files = [];
  for (let i = 0; i < Math.min(imageUrls.length, 20); i++) {
    try {
      const res = await fetch(`${API}/proxy-image?url=${encodeURIComponent(imageUrls[i])}`);
      const blob = await res.blob();
      files.push(new File([blob], `photo_${i + 1}.jpg`, { type: 'image/jpeg' }));
    } catch(e) {
      console.warn('Failed to fetch photo', i + 1);
    }
  }

  if (!files.length) return false;

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
  await sleep(2000);

  return fileInput.files.length > 0;
}

// ── Photo strip ───────────────────────────────
function showPhotoStrip(imageUrls, vehicleId) {
  if (!imageUrls?.length) return;
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
      showStatus('Downloading photos...', 'info');
      const objectUrls = [];
      let downloaded = 0;
      for (let i = 0; i < imageUrls.length; i++) {
        try {
          const res = await fetch(`${API}/proxy-image?url=${encodeURIComponent(imageUrls[i])}`);
          const blob = await res.blob();
          const objectUrl = URL.createObjectURL(blob);
          objectUrls.push(objectUrl);
          const a = document.createElement('a')
          a.href = objectUrl;
          a.download = `WellandChev_${String(i + 1).padStart(2, '0')}.jpg`;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          downloaded++;
          uploadBtn.textContent = `⬇ ${downloaded}/${imageUrls.length}`;
          await sleep(300);
        } catch(e) { console.warn('Download failed', i + 1); }
      }
      uploadBtn.textContent = `✅ ${downloaded} downloaded — Select in Add Photos`;
      uploadBtn.style.background = '#22c55e';
      uploadBtn.style.color = '#000';
      await sleep(500);
      const addBtn = document.querySelector('[aria-label="Add photos"]') ||
        [...document.querySelectorAll('div[role="button"]')].find(el => el.textContent.trim() === 'Add photos');
      if (addBtn) addBtn.click();
      setTimeout(() => objectUrls.forEach(u => URL.revokeObjectURL(u)), 180000);
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
    chrome.runtime.sendMessage(
      { type: 'LISTING_POSTED', inventory_id: vehicleId, fb_listing_url: window.location.href },
      (response) => {
        if (response?.success) {
          markPosted.textContent = '✅ Posted!';
          markPosted.style.background = '#166534';
          markPosted.style.color = '#4ade80';
          showStatus('✅ Listing saved to your dashboard.', 'success');
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
    // 1. Explicit aria-label (most reliable when present)
    const byAria = document.querySelector('[role="combobox"][aria-label="Model" i], [role="combobox"][aria-label="Vehicle model" i]');
    if (byAria) return byAria;

    // 2. Label-element pattern: a <label>/<span> with text "Model" near the combobox
    const labels = [...document.querySelectorAll('label, span')];
    for (const lbl of labels) {
      const text = lbl.textContent.trim().toLowerCase();
      if (text === 'model' || text === 'vehicle model') {
        const combo = lbl.querySelector('[role="combobox"]')
          || lbl.parentElement?.querySelector('[role="combobox"]')
          || lbl.closest('label')?.querySelector('[role="combobox"]');
        if (combo) return combo;
      }
    }

    // 3. Combobox whose own text equals "Model" (placeholder state). Use strict equality only —
    //    Make combobox now shows its value, so it won't match.
    return [...document.querySelectorAll('[role="combobox"]')].find(el => {
      const txt = el.textContent.trim().toLowerCase();
      return txt === 'model' || txt === 'vehicle model';
    });
  };

  const modelTrigger = await waitFor(findModelTrigger, 15000);

  if (!modelTrigger) {
    console.error('❌ Model dropdown not found after 15s. Fill manually.');
    showStatus('Could not find Model field — fill manually.', 'info');
  } else {
    modelTrigger.scrollIntoView({ behavior: 'smooth', block: 'center' });
    await sleep(600);
    modelTrigger.click();
    await sleep(2000); // Wait for FB to mount the dropdown overlay

    // Wait for the search input INSIDE the overlay (only matches empty inputs)
    const searchInput2 = await waitFor(() =>
      [...document.querySelectorAll('input')]
        .find(el => el.offsetParent !== null
                  && el.type !== 'hidden'
                  && !el.closest('[aria-hidden="true"]')
                  && !el.value)
    , 5000);

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

    const modelOption = await waitFor(() => {
      const targets = [...document.querySelectorAll('[role="option"]')];
      return targets.find(el => el.textContent.trim().toLowerCase() === model.toLowerCase())
          || targets.find(el => el.textContent.trim().toLowerCase().includes(model.toLowerCase()));
    }, 6000);

    if (modelOption) {
      modelOption.click();
      await sleep(1200);
      // Force any leftover overlay to close before Body Style runs
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await sleep(400);
      console.log('✓ Model selected:', model);
    } else {
      console.warn('Model dropdown opened but no matching option found. Trying free-text fallback.');
      const modelTextField = getFormFields().find(f => f.closest('label, div')?.textContent?.includes('Model'));
      if (modelTextField) {
        await typeInto(modelTextField, model);
        await sleep(600);
        const opt = document.querySelector('[role="option"]');
        if (opt) { opt.click(); await sleep(500); }
      }
    }
  }
  // Wait longer for the Model commit so the next combobox lookup doesn't grab the
  // Model field by mistake. 2500ms beats the visual confirmation we observed.
  await sleep(2500);

  // VERIFY the Model field actually shows the model name. If it's empty or contains a
  // body-style value (SUV/Truck/Sedan/etc.), the model selection didn't take — log and
  // continue; this is what was causing "SUV"/"Truck" to leak into Model when Body Style
  // ran next.
  const modelComboboxNow = document.querySelector('[role="combobox"][aria-label="Model" i], [role="combobox"][aria-label="Vehicle model" i]');
  const modelDisplayedNow = (modelComboboxNow?.textContent || '').trim().toLowerCase();
  const bodyStyleVocab = ['suv', 'truck', 'sedan', 'coupe', 'hatchback', 'convertible', 'minivan', 'van', 'wagon'];
  if (modelDisplayedNow && bodyStyleVocab.includes(modelDisplayedNow)) {
    console.warn(`⚠️ Model field shows body-style value "${modelDisplayedNow}" — clearing and retrying`);
    // Click the combobox to reopen, clear it via Escape + clearing search
    try {
      modelComboboxNow.click();
      await sleep(1200);
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await sleep(400);
    } catch {}
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
  await pickDropdown('Vehicle condition', vehicle.condition || 'Good');
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
    const baseDesc = vehicle.ai_description || vehicle.description ||
      `${vehicle.year} ${make} ${model} ${vehicle.trim || ''}. ` +
      `${vehicle.mileage ? vehicle.mileage.toLocaleString() + ' km. ' : ''}` +
      `${vehicle.exterior_color ? vehicle.exterior_color + ' exterior. ' : ''}` +
      `${vehicle.transmission || 'Automatic'} transmission.`;

    // Append rep + dealership contact block (poster comes from popup.js pendingPost)
    const dealershipName = vehicle.poster?.dealership?.name || '';
    const repName = vehicle.poster?.full_name || '';
    const repEmail = vehicle.poster?.email || '';
    const repPhone = vehicle.poster?.phone || '';
    const dealerPhone = vehicle.poster?.dealership?.phone || '';
    const dealerWebsite = vehicle.poster?.dealership?.website_url || '';

    const contactLines = [
      '',
      '─── CONTACT ───',
      repName ? `${repName}${dealershipName ? ` — ${dealershipName}` : ''}` : dealershipName,
      repPhone ? `📞 ${repPhone}` : (dealerPhone ? `📞 ${dealerPhone}` : null),
      repEmail ? `✉️ ${repEmail}` : null,
      dealerWebsite ? `🌐 ${dealerWebsite}` : null
    ].filter(Boolean);

    const desc = baseDesc + '\n\n' + contactLines.join('\n');
    await typeInto(descEl, desc);
  }
  await sleep(DELAY);

  showStatus('✅ Form filled! Click Upload Photos.', 'success');
  showPhotoStrip(vehicle.image_urls || [], vehicle.id);
  console.log('✅ Automated pipeline processing successfully executed.');
}

// ── Boot ──────────────────────────────────────
if (window.location.href.includes('/marketplace/create/vehicle') ||
    window.location.href.includes('/marketplace/create/')) {
  chrome.storage.local.get(['pendingPost'], ({ pendingPost }) => {
    if (!pendingPost?.vehicle) return;
    chrome.storage.local.remove(['pendingPost']);
    // Attach poster profile so fillListingForm can stamp rep contact info
    const vehicleWithPoster = { ...pendingPost.vehicle, poster: pendingPost.poster || null };
    setTimeout(() => fillListingForm(vehicleWithPoster), 2500);

    // Watch for the URL to change to /marketplace/item/... — that means FB published the listing
    // and we can auto-mark posted without the user needing to click anything.
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
    // Stop watching after 15 min (user probably gave up or closed tab)
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