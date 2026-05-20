// content.js
// Runs on facebook.com — fills out the Marketplace vehicle listing form

const DELAY = 400;
const sleep = ms => new Promise(r => setTimeout(r, ms));

function byLabel(label) {
  return document.querySelector(`[aria-label="${label}"]`);
}

function byPlaceholder(text) {
  return document.querySelector(`[placeholder="${text}"]`);
}

// Aggressive tree search for obfuscated structural inputs
function findInputByVisualLabel(labelText) {
  const labelEl = [...document.querySelectorAll('span, label, div')]
    .find(el => el.textContent.trim() === labelText);
  if (!labelEl) return null;
  
  const container = labelEl.closest('div[role="none"]') || labelEl.parentElement;
  return container.querySelector('input, textarea, div[role="combobox"]');
}

// Fast React-compatible input setter
async function typeInto(el, value) {
  if (!el) return false;
  el.focus();
  await sleep(200);

  const nativeInputSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
  const nativeTextareaSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
  const setter = el.tagName === 'TEXTAREA' ? nativeTextareaSetter : nativeInputSetter;

  if (setter) {
    setter.call(el, value);
  } else {
    el.value = value;
  }

  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true }));
  el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
  await sleep(250);
  return true;
}

async function selectOption(optionText) {
  await sleep(500);
  const option = [...document.querySelectorAll('[role="option"], div[role="listbox"] div, div[role="menuitem"]')]
    .find(el => el.textContent.trim().toLowerCase().includes(optionText.toLowerCase()));
  if (option) {
    option.click();
    await sleep(600);
    return true;
  }
  return false;
}

async function waitFor(selectorFn, timeout = 12000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const el = selectorFn();
    if (el) return el;
    await sleep(400);
  }
  return null;
}

async function uploadImages(imageUrls) {
  if (!imageUrls?.length) return;
  console.log("📸 Processing image payloads:", imageUrls);

  const files = [];
  for (const url of imageUrls.slice(0, 20)) {
    try {
      const res = await fetch(url);
      const blob = await res.blob();
      const filename = url.split('/').pop().split('?')[0] || 'vehicle.jpg';
      files.push(new File([blob], filename, { type: blob.type || 'image/jpeg' }));
    } catch (e) {
      console.warn('❌ Failed to fetch image target:', url);
    }
  }

  if (!files.length) return;

  const dt = new DataTransfer();
  files.forEach(f => dt.items.add(f));

  const fileInput = await waitFor(() => document.querySelector('input[type="file"][accept*="image"]'));
  if (fileInput) {
    Object.defineProperty(fileInput, 'files', { value: dt.files, writable: false });
    fileInput.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(3000);
  }
}

async function fillListingForm(vehicle) {
  console.log('🚗 Starting engine injection sequence for:', vehicle.year, vehicle.make, vehicle.model);
  showStatus("Starting vehicle data sync... do not click away");
  await sleep(3000);

  // 1. PRICE
  showStatus('Syncing Price field...');
  const priceEl = await waitFor(() => 
    findInputByVisualLabel('Price') || 
    byLabel('Price') || 
    byPlaceholder('Price') ||
    document.querySelector('div[aria-label="Price"] input') ||
    Array.from(document.querySelectorAll('input')).find(i => i.placeholder?.includes('$'))
  );
  if (priceEl) {
    await typeInto(priceEl, String(Math.round(vehicle.price)));
    console.log("✅ Price Injected");
  } else {
    console.error("❌ Failed to resolve Price input container node.");
  }
  await sleep(DELAY);

  // 2. VEHICLE TYPE
  showStatus('Selecting Type selection...');
  const typeEl = await waitFor(() => byLabel('Vehicle type') || byLabel('Type') || findInputByVisualLabel('Vehicle type'));
  if (typeEl) {
    typeEl.click();
    await sleep(600);
    const modelLower = (vehicle.model || '').toLowerCase();
    if (['truck', 'pickup', 'silverado', 'sierra', 'ram', 'f-150', 'tundra'].some(t => modelLower.includes(t))) {
      await selectOption('Truck');
    } else if (['suv', 'equinox', 'traverse', 'tahoe', 'suburban', 'blazer', 'trax'].some(t => modelLower.includes(t))) {
      await selectOption('SUV');
    } else {
      await selectOption('Sedan');
    }
  }
  await sleep(DELAY);

  // 3. YEAR
  showStatus('Injecting Year configuration...');
  const yearEl = await waitFor(() => findInputByVisualLabel('Year') || byLabel('Year') || byPlaceholder('Year'));
  if (yearEl) {
    yearEl.click();
    await sleep(500);
    await typeInto(yearEl, String(vehicle.year));
    await selectOption(String(vehicle.year));
  }
  await sleep(DELAY);

  // 4. MAKE
  showStatus('Injecting Make properties...');
  const makeEl = await waitFor(() => findInputByVisualLabel('Make') || byLabel('Make') || byPlaceholder('Make'));
  if (makeEl) {
    makeEl.click();
    await sleep(500);
    await typeInto(makeEl, vehicle.make);
    await selectOption(vehicle.make);
  }
  await sleep(DELAY);

  // 5. MODEL
  showStatus('Injecting Model details...');
  const modelEl = await waitFor(() => findInputByVisualLabel('Model') || byLabel('Model') || byPlaceholder('Model'));
  if (modelEl) {
    modelEl.click();
    await sleep(500);
    await typeInto(modelEl, vehicle.model);
    await selectOption(vehicle.model);
  }
  await sleep(DELAY);

  // 6. MILEAGE
  showStatus('Syncing Mileage reading...');
  const mileageEl = await waitFor(() => findInputByVisualLabel('Mileage') || byLabel('Mileage') || byPlaceholder('Mileage') || byLabel('Kilometers'));
  if (mileageEl) {
    await typeInto(mileageEl, String(vehicle.mileage || 0));
  }
  await sleep(DELAY);

  // 7. COLOR
  showStatus('Selecting color profile...');
  const colorEl = await waitFor(() => byLabel('Exterior color') || byLabel('Color') || findInputByVisualLabel('Exterior color'));
  if (colorEl) {
    colorEl.click();
    await selectOption(vehicle.exterior_color || 'Black');
  }
  await sleep(DELAY);

  // 8. TRANSMISSION
  showStatus('Setting transmission configuration...');
  const transEl = await waitFor(() => byLabel('Transmission') || byLabel('Transmission type') || findInputByVisualLabel('Transmission'));
  if (transEl) {
    transEl.click();
    await selectOption(vehicle.transmission || 'Automatic');
  }
  await sleep(DELAY);

  // 9. DESCRIPTION
  showStatus('Formatting Description...');
  const descEl = await waitFor(() =>
    document.querySelector('textarea[aria-label="Description"]') ||
    document.querySelector('div[aria-label="Description"] textarea') ||
    byLabel('Description') ||
    byPlaceholder('Description') ||
    document.querySelector('textarea')
  );
  if (descEl) {
    const desc = vehicle.ai_description || vehicle.description ||
      `${vehicle.year} ${vehicle.make} ${vehicle.model}.\n` +
      `Mileage: ${vehicle.mileage ? vehicle.mileage.toLocaleString() + ' km.\n' : 'N/A\n'}` +
      `Contact Welland Chev for details!`;
    await typeInto(descEl, desc);
    console.log("✅ Description Injected");
  }
  await sleep(DELAY);

  // 10. IMAGES
  showStatus('Uploading photos...');
  await uploadImages(vehicle.image_urls);

  showStatus('✅ Form filled! Review and click Publish.', 'success');
  console.log('✅ Field mapping automation complete.');

  chrome.runtime.sendMessage({
    type: 'LISTING_POSTED',
    inventory_id: vehicle.id,
    fb_listing_url: window.location.href
  });
}

function showStatus(message, type = 'info') {
  let overlay = document.getElementById('wc-status');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'wc-status';
    overlay.style.cssText = `
      position: fixed;
      bottom: 24px;
      right: 24px;
      background: #121212;
      color: #ffffff;
      padding: 14px 20px;
      border-radius: 12px;
      font-size: 13px;
      font-family: -apple-system, sans-serif;
      z-index: 2147483647;
      border: 1px solid #2a2a2a;
      max-width: 300px;
      box-shadow: 0 12px 32px rgba(0,0,0,0.5);
    `;
    document.body.appendChild(overlay);
  }
  overlay.style.borderColor = type === 'success' ? '#22c55e' : '#3b82f6';
  overlay.innerHTML = `
    <div style="font-weight:700;margin-bottom:4px;display:flex;align-items:center;gap:6px;">
      <span style="color:${type === 'success' ? '#22c55e' : '#3b82f6'}">${type === 'success' ? '●' : '⚙️'}</span> Welland Chev Lister
    </div>
    <div style="color:#b3b3b3;line-height:1.4;">${message}</div>
  `;
}

// ── Global Initializer ──
if (window.location.href.includes('facebook.com/marketplace')) {
  chrome.storage.local.get(['pendingPost'], ({ pendingPost }) => {
    if (pendingPost && pendingPost.vehicle) {
      const targetVehicle = pendingPost.vehicle;
      chrome.storage.local.remove(['pendingPost'], () => {
        if (document.readyState === 'complete' || document.readyState === 'interactive') {
          setTimeout(() => fillListingForm(targetVehicle).catch(console.error), 3500);
        } else {
          window.addEventListener('DOMContentLoaded', () => {
            setTimeout(() => fillListingForm(targetVehicle).catch(console.error), 3500);
          });
        }
      });
    }
  });
}