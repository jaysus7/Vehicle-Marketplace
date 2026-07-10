import { supabaseAdmin } from '../shared.js'
import { requireAuth } from '../middleware.js'
import { createNotification } from '../notifications.js'
import { fetchOemWindowStickerPdf } from '../utils/oemWindowSticker.js'
import { fetchOemBrochurePdf } from '../utils/oemBrochure.js'
import { brandVehiclePhotos } from '../utils/photoOverlay.js'
import { fontFaceCss } from '../utils/brochureFonts.js'
import { recordUsage, marketcheckAllowed, recordMarketcheckCall } from '../usage.js'
import { marketcheckEnabled, marketcheckDecodeVin } from '../marketcheck.js'
import multer from 'multer'

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 3 * 1024 * 1024 } })

const NHTSA_DECODE = 'https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValuesExtended'
const NHTSA_RECALLS = 'https://api.nhtsa.gov/recalls/recallsByVin'

function requireDealerAdmin(req, res, next) {
  if (!['DEALER_ADMIN', 'DEALER_STAFF', 'SALES_REP', 'MANAGER', 'OWNER'].includes(req.profile?.role)) {
    return res.status(403).json({ error: 'Dealer access required' })
  }
  next()
}

const OWNER_EMAIL = (process.env.OWNER_EMAIL || 'massiejay@gmail.com').toLowerCase()

// Entitlements:
//  • The VIN decoder + factory (OEM) window stickers/brochures are part of the
//    Inventory Intelligence tier.
//  • The generated/branded MarketSync sticker and AI-written brochure require AI Boost.
function hasAiBoost(dealer, email) {
  if ((email || '').toLowerCase() === OWNER_EMAIL) return true
  return !!dealer?.ai_boost_active
}
function hasInvIntel(dealer, email) {
  if ((email || '').toLowerCase() === OWNER_EMAIL) return true
  return !!dealer?.inv_intel_active
}

// ── Helpers ────────────────────────────────────────────────────────────────

function pick(obj, ...keys) {
  for (const k of keys) if (obj[k]) return obj[k]
  return ''
}

async function loadDealershipData(dealershipId) {
  const { data, error } = await supabaseAdmin
    .from('dealerships')
    .select('id, name, website_url, branding, vin_sticker_active, ai_boost_active, inv_intel_active')
    .eq('id', dealershipId)
    .single()
  if (error) console.error('[loadDealershipData]', error.message)
  return data
}

// Short AI "why buy this" line for the branded window sticker (AI Boost).
async function buildStickerBlurb(vehicle) {
  if (!process.env.ANTHROPIC_API_KEY) return null
  try {
    const Anthropic = (await import('@anthropic-ai/sdk')).default
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
    const label = [vehicle.year, vehicle.make, vehicle.model, vehicle.trim].filter(Boolean).join(' ')
    const prompt = `Write ONE punchy sentence (max 22 words) for a car-dealership window sticker highlighting why this vehicle is a great buy. No markdown, no quotes, no emojis.
Vehicle: ${label}${vehicle.mileage ? `, ${Number(vehicle.mileage).toLocaleString()} km` : ''}${vehicle.price ? `, $${Number(vehicle.price).toLocaleString()}` : ''}.
Notable: ${(vehicle.description || '').slice(0, 400) || 'well-equipped'}.`
    const msg = await Promise.race([
      anthropic.messages.create({ model: 'claude-haiku-4-5-20251001', max_tokens: 80, messages: [{ role: 'user', content: prompt }] }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('ai timeout')), 15000)),
    ])
    return (msg?.content?.[0]?.text || '').trim().replace(/^["']|["']$/g, '') || null
  } catch { return null }
}

function buildWindowStickerHtml(vehicle, dealer, branding, recalls, photoDataUris, logoDataUri, blurb) {
  const photoDataUri = Array.isArray(photoDataUris) ? photoDataUris[0] : photoDataUris
  const allPhotos = (Array.isArray(photoDataUris) ? photoDataUris : [photoDataUri]).filter(Boolean)
  const primary   = branding.primary_color   || '#003087'
  const secondary = branding.secondary_color || '#c9a84c'

  const logoSrc  = logoDataUri || branding.logo_url || null
  const logoHtml = logoSrc
    ? `<img src="${logoSrc}" alt="${dealer.name || ''}" style="max-height:48px;max-width:170px;object-fit:contain;display:block;">`
    : `<span style="font-size:15px;font-weight:900;color:#fff;letter-spacing:-.3px;">${dealer.name || 'Your Dealership'}</span>`

  const price     = vehicle.price   ? `$${Number(vehicle.price).toLocaleString()}` : 'Call for Price'
  const mileage   = vehicle.mileage ? `${Number(vehicle.mileage).toLocaleString()} km` : (vehicle.condition === 'new' ? 'New Vehicle' : '—')
  const cap       = s => s ? s.charAt(0).toUpperCase() + s.slice(1) : '—'
  const vehicleName = [vehicle.year, vehicle.make, vehicle.model, vehicle.trim].filter(Boolean).join(' ')
  const basePrice = vehicle.price ? Number(vehicle.price) : null

  // ── Extended VIN data ─────────────────────────────────────────────────────
  const vd = vehicle.vin_data || {}
  const plantStr = [vd.plant_city, vd.plant_state, vd.plant_country].filter(Boolean).join(', ') || null

  // Derive doors / seats from body style when the inventory record doesn't have them
  const bodyLower = (vehicle.body_style || vd.body_style || '').toLowerCase()
  const derivedDoors = vehicle.doors || vd.doors ||
    (/crew cab|quad cab|double cab|extended cab|4-door|4 door|sedan|suv|crossover|van|wagon/i.test(bodyLower) ? 4
    : /regular cab|2-door|2 door|coupe|convertible/i.test(bodyLower) ? 2
    : null)
  const derivedSeats = vd.seats ||
    (/van|full.size van|passenger van/i.test(bodyLower) ? '7-8'
    : /crew cab|quad cab|double cab/i.test(bodyLower) ? '5-6'
    : /regular cab/i.test(bodyLower) ? '3'
    : /coupe|convertible/i.test(bodyLower) ? '4'
    : null)

  // ── Feature columns — blend description keywords WITH NHTSA vin_data ──────
  const desc = (vehicle.description || '').toLowerCase()
  const has  = kw => desc.includes(kw)
  // Helper: format NHTSA yes/no/standard values into human-readable
  const nhtsa = (val, label) => {
    if (!val) return null
    const v = val.toString().toLowerCase()
    if (v === 'not applicable' || v === 'none') return null
    if (v === 'yes' || v === 'standard') return label
    if (v === 'optional') return `${label} (Optional)`
    return label
  }

  const featureCols = [
    {
      title: 'Performance & Mechanical',
      items: [
        vehicle.engine                                   && vehicle.engine,
        vehicle.drivetrain                               && `${vehicle.drivetrain} Drivetrain`,
        vehicle.transmission                             && `${vehicle.transmission} Transmission`,
        vd.transmission_speeds                           && `${vd.transmission_speeds}-Speed Transmission`,
        vehicle.fuel_type                                && `${vehicle.fuel_type} Fuel`,
        vd.fuel_injection                                && `${vd.fuel_injection} Fuel Injection`,
        nhtsa(vd.turbo, 'Turbocharged'),
        vd.horsepower                                    && `${vd.horsepower} Horsepower`,
        vd.displacement_cc                               && `${vd.displacement_cc}cc Displacement`,
        vd.gvwr                                          && `GVWR: ${vd.gvwr}`,
        has('tow') || has('trailer')                     ? 'Towing Package' : null,
        has('awd') || has('4wd') || has('four-wheel')    ? 'Four-Wheel / AWD Capable' : null,
      ].filter(Boolean),
    },
    {
      title: 'Comfort & Convenience',
      items: [
        has('heated seat')                               ? 'Heated Front Seats' : null,
        has('ventilated')                                ? 'Ventilated Seats' : null,
        has('heated steering')                           ? 'Heated Steering Wheel' : null,
        has('remote start')                              ? 'Remote Vehicle Start' : null,
        (has('keyless') || nhtsa(vd.keyless_ignition, 'x')) ? 'Keyless Entry / Push-Button Start' : null,
        has('sunroof') || has('moonroof')                ? 'Power Sunroof / Moonroof' : null,
        has('panoramic')                                 ? 'Panoramic Roof' : null,
        has('power liftgate')                            ? 'Power Liftgate' : null,
        has('leather')                                   ? 'Leather-Appointed Seating' : null,
        has('third row') || has('3rd row')               ? 'Third-Row Seating' : null,
        has('wireless charg')                            ? 'Wireless Charging Pad' : null,
        vd.seat_rows                                     && `${vd.seat_rows} Row Seating`,
        vd.seats                                         && `${vd.seats} Passenger Capacity`,
        vehicle.interior_color                           && `${vehicle.interior_color} Interior`,
        vehicle.exterior_color                           && `${vehicle.exterior_color} Exterior`,
      ].filter(Boolean),
    },
    {
      title: 'Safety & Security',
      items: [
        has('backup camera') || has('rear camera') || has('rearview') ? 'Rear-View Camera' : null,
        nhtsa(vd.blind_spot_mon, 'Blind Spot Monitoring'),
        nhtsa(vd.lane_departure, 'Lane Departure Warning'),
        nhtsa(vd.lane_keep, 'Lane Keep Assist'),
        nhtsa(vd.forward_collision, 'Forward Collision Warning'),
        nhtsa(vd.auto_brake, 'Automatic Emergency Braking'),
        nhtsa(vd.adaptive_cruise, 'Adaptive Cruise Control'),
        nhtsa(vd.adaptive_headlights, 'Adaptive Headlights'),
        nhtsa(vd.abs, 'Anti-Lock Brakes (ABS)'),
        nhtsa(vd.esc, 'Electronic Stability Control'),
        nhtsa(vd.tpms, 'Tire Pressure Monitoring (TPMS)'),
        vd.airbag_front   && `Front Airbags: ${vd.airbag_front}`,
        vd.airbag_side    && `Side Airbags: ${vd.airbag_side}`,
        vd.airbag_curtain && `Curtain Airbags: ${vd.airbag_curtain}`,
        vd.airbag_knee    && `Knee Airbags: ${vd.airbag_knee}`,
        has('park assist') || has('parking sensor')      ? 'Parking Sensors / Assist' : null,
        has('360') || has('surround')                    ? '360° Surround-View Camera' : null,
      ].filter(Boolean),
    },
    {
      title: 'Technology & Connectivity',
      items: [
        has('apple carplay')                             ? 'Apple CarPlay®' : null,
        has('android auto')                              ? 'Android Auto™' : null,
        has('navigation') || has('nav system')           ? 'Built-In Navigation' : null,
        has('bluetooth')                                 ? 'Bluetooth Connectivity' : null,
        has('wi-fi') || has('wifi') || has('hotspot')    ? 'Built-In Wi-Fi Hotspot' : null,
        has('onstar')                                    ? 'OnStar Connected Services' : null,
        has('bose') || has('harman') || has('jbl')       ? 'Premium Audio System' : null,
        has('usb')                                       ? 'USB Charging Ports' : null,
        has('digital cluster') || has('digital dash')    ? 'Digital Instrument Cluster' : null,
        has('heads-up') || has('hud')                    ? 'Heads-Up Display' : null,
        vd.sae_automation                                && `SAE Automation Level: ${vd.sae_automation}`,
      ].filter(Boolean),
    },
  ]

  featureCols.forEach(col => {
    if (!col.items.length) col.items.push('See dealer for full equipment details')
  })

  const colHtml = featureCols.map(col => `
    <div class="fcol">
      <div class="col-hdr">${col.title}</div>
      ${col.items.map(item => `<div class="fi">${item}</div>`).join('')}
    </div>`).join('')

  // ── Build data grid (only if vin_data exists) ─────────────────────────────
  const buildRows = [
    ['Manufacturer',    vd.manufacturer],
    ['Vehicle Type',    vd.vehicle_type],
    ['Series',          vd.series],
    ['Built In',        plantStr],
    ['Plant',           vd.plant_company],
    ['Engine Model',    vd.engine_model],
    ['Engine Mfr',      vd.engine_manufacturer],
    ['Engine Config',   vd.engine_config],
    ['Valve Train',     vd.valve_train],
    ['Displacement',    vd.displacement_l ? `${vd.displacement_l}L / ${vd.displacement_cc || '—'}cc` : null],
    ['Cylinders',       vd.cylinders],
    ['Horsepower',      vd.horsepower ? `${vd.horsepower} HP` : null],
    ['Alt Fuel',        vd.fuel_type_secondary],
    ['Electrification', vd.electrification],
    ['Wheel Base',      vd.wheel_base],
    ['Wheel Size (F)',  vd.wheel_size_front],
    ['Wheel Size (R)',  vd.wheel_size_rear],
    ['Wheels',          vd.wheels],
    ['Axles',           vd.axles],
    ['Windows',         vd.windows],
    ['Curb Weight',     vd.curb_weight_lb ? `${vd.curb_weight_lb} lbs` : null],
    ['Brakes',          vd.brake_system],
    ['Steering',        vd.steering_location],
  ].filter(([, v]) => v)

  const buildDataHtml = buildRows.length ? `
    <div class="build-section">
      <div class="build-hdr">Vehicle Build Data (NHTSA)</div>
      <div class="build-grid">
        ${buildRows.map(([l, v]) => `
          <div class="build-cell">
            <div class="bc-label">${l}</div>
            <div class="bc-val">${v}</div>
          </div>`).join('')}
      </div>
    </div>` : ''

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8">
<style>
  ${fontFaceCss()}
  *{margin:0;padding:0;box-sizing:border-box;}
  body{font-family:'Arimo','Arial',Helvetica,sans-serif;width:1056px;height:816px;background:#fff;color:#111;display:flex;flex-direction:column;overflow:hidden;}

  /* ── HEADER ── */
  .top-hdr{background:${primary};display:flex;align-items:stretch;height:60px;flex-shrink:0;}
  .logo-cell{padding:0 18px;display:flex;align-items:center;min-width:190px;border-right:1px solid rgba(255,255,255,.2);}
  .name-cell{flex:1;padding:0 16px;display:flex;flex-direction:column;justify-content:center;border-right:1px solid rgba(255,255,255,.2);}
  .name-label{font-size:7.5px;letter-spacing:3px;text-transform:uppercase;color:rgba(255,255,255,.55);margin-bottom:3px;}
  .name-val{font-size:20px;font-weight:900;color:#fff;line-height:1;letter-spacing:-.4px;}
  .meta-cell{padding:0 14px;display:flex;flex-direction:column;justify-content:center;gap:2px;border-right:1px solid rgba(255,255,255,.2);min-width:200px;}
  .meta-row{font-size:8.5px;color:rgba(255,255,255,.7);display:flex;gap:4px;align-items:baseline;}
  .meta-row b{color:#fff;font-size:9px;}
  .eng-cell{padding:0 14px;display:flex;flex-direction:column;justify-content:center;gap:2px;min-width:220px;}
  .eng-row{font-size:8.5px;color:rgba(255,255,255,.7);display:flex;gap:4px;align-items:baseline;}
  .eng-row b{color:#fff;font-size:9px;}

  .accent-bar{background:${secondary};height:5px;flex-shrink:0;}

  /* ── MAIN LAYOUT ── */
  .main{display:flex;flex:1;min-height:0;}

  /* LEFT = photo + ribbon + columns + build data */
  .left{flex:1;display:flex;flex-direction:column;min-width:0;border-right:2px solid ${primary};}

  .photo{background:#0f172a;overflow:hidden;flex-shrink:0;position:relative;}
  .photo-row{display:flex;height:180px;gap:2px;background:#0f172a;}
  .photo-row img{flex:1;min-width:0;object-fit:cover;object-position:center;}
  .photo-none{width:100%;height:180px;display:flex;align-items:center;justify-content:center;color:#94a3b8;font-size:12px;background:#e8ecf0;}

  .ribbon{display:flex;background:#f0f4f8;border-bottom:1px solid #d1dae3;flex-shrink:0;}
  .rc{flex:1;padding:5px 8px;border-right:1px solid #d1dae3;text-align:center;}
  .rc:last-child{border-right:none;}
  .rl{font-size:7px;color:#94a3b8;text-transform:uppercase;letter-spacing:.6px;}
  .rv{font-size:10px;font-weight:700;color:#0f172a;margin-top:1px;line-height:1.2;}

  /* 4 feature columns */
  .cols{display:flex;flex:1;padding:8px 6px 0;gap:6px;min-height:0;}
  .fcol{flex:1;min-width:0;overflow:hidden;}
  .col-hdr{font-size:7.5px;font-weight:800;text-transform:uppercase;letter-spacing:.8px;color:${primary};border-bottom:2px solid ${secondary};padding-bottom:2px;margin-bottom:5px;}
  .fi{font-size:9px;color:#1e293b;padding:2px 0 2px 10px;position:relative;line-height:1.3;}
  .fi::before{content:"•";position:absolute;left:1px;color:${secondary};font-weight:900;font-size:10px;line-height:1.3;}

  /* Build data section */
  .build-section{background:#f8fafc;border-top:1.5px solid ${secondary};padding:5px 8px;flex-shrink:0;}
  .build-hdr{font-size:7px;font-weight:800;text-transform:uppercase;letter-spacing:1.2px;color:${primary};margin-bottom:4px;}
  .build-grid{display:grid;grid-template-columns:repeat(6,1fr);gap:3px 8px;}
  .build-cell{}
  .bc-label{font-size:6.5px;color:#94a3b8;text-transform:uppercase;letter-spacing:.4px;}
  .bc-val{font-size:8px;font-weight:700;color:#0f172a;line-height:1.25;}

  /* RIGHT = price panel */
  .right{width:210px;display:flex;flex-direction:column;flex-shrink:0;}

  .price-hdr{background:${primary};color:#fff;padding:10px 13px 8px;text-align:center;}
  .ph-lbl{font-size:7.5px;letter-spacing:2px;text-transform:uppercase;opacity:.65;margin-bottom:2px;}
  .ph-val{font-size:30px;font-weight:900;line-height:1;}
  .ph-sub{font-size:8.5px;opacity:.7;margin-top:3px;}

  .price-break{padding:9px 13px;border-bottom:1px solid #e2e8f0;}
  .pb-row{display:flex;justify-content:space-between;font-size:9px;padding:2.5px 0;color:#64748b;}
  .pb-row b{color:#1e293b;font-weight:700;}
  .pb-total{display:flex;justify-content:space-between;font-size:10.5px;font-weight:800;color:${primary};border-top:2px solid ${secondary};margin-top:5px;padding-top:5px;}

  .vin-blk{padding:8px 13px;border-bottom:1px solid #e2e8f0;text-align:center;}
  .vin-lbl{font-size:7px;color:#94a3b8;text-transform:uppercase;letter-spacing:.5px;}
  .vin-val{font-size:8.5px;font-weight:700;font-family:monospace;letter-spacing:.5px;word-break:break-all;color:#0f172a;margin-top:2px;line-height:1.3;}

  .recall-blk{padding:7px 13px;border-bottom:1px solid #e2e8f0;}
  .r-ok{background:#f0fdf4;border:1px solid #86efac;border-radius:4px;padding:6px 8px;text-align:center;font-size:9px;font-weight:700;color:#15803d;}
  .r-bad{background:#fef2f2;border:1px solid #fca5a5;border-radius:4px;padding:6px 8px;text-align:center;font-size:9px;font-weight:700;color:#dc2626;}
  .r-note{font-size:7.5px;font-weight:400;display:block;margin-top:2px;}

  .dealer-blk{padding:9px 13px;flex:1;}
  .d-name{font-size:12px;font-weight:900;color:${primary};margin-bottom:4px;}
  .d-line{font-size:8.5px;color:#475569;line-height:1.75;}
  .d-tag{font-size:8px;font-style:italic;color:#94a3b8;margin-top:5px;}

  .stock-bar{background:${secondary};color:#fff;font-size:8.5px;font-weight:800;padding:5px 13px;text-align:center;letter-spacing:.5px;}

  /* ── FOOTER ── */
  .footer{background:${primary};color:rgba(255,255,255,.75);padding:0 20px;display:flex;justify-content:space-between;align-items:center;font-size:8.5px;height:33px;flex-shrink:0;}
  .footer b{color:#fff;}
</style>
</head>
<body>

<!-- HEADER -->
<div class="top-hdr">
  <div class="logo-cell">${logoHtml}</div>
  <div class="name-cell">
    <div class="name-label">Monroney Label &nbsp;&middot;&nbsp; Vehicle Information</div>
    <div class="name-val">${vehicleName || 'Vehicle Details'}</div>
  </div>
  <div class="meta-cell">
    ${vehicle.exterior_color ? `<div class="meta-row"><span>Exterior:</span><b>${vehicle.exterior_color}</b></div>` : ''}
    ${vehicle.interior_color ? `<div class="meta-row"><span>Interior:</span><b>${vehicle.interior_color}</b></div>` : ''}
    ${vehicle.body_style     ? `<div class="meta-row"><span>Body:</span><b>${vehicle.body_style}</b></div>` : ''}
    ${plantStr               ? `<div class="meta-row"><span>Built In:</span><b>${plantStr}</b></div>` : ''}
  </div>
  <div class="eng-cell">
    ${vehicle.engine       ? `<div class="eng-row"><span>Engine:</span><b>${vehicle.engine}</b></div>` : ''}
    ${vehicle.transmission ? `<div class="eng-row"><span>Trans:</span><b>${vehicle.transmission}</b></div>` : ''}
    ${vehicle.drivetrain   ? `<div class="eng-row"><span>Drive:</span><b>${vehicle.drivetrain}</b></div>` : ''}
    ${vd.horsepower        ? `<div class="eng-row"><span>Power:</span><b>${vd.horsepower} HP</b></div>` : ''}
  </div>
</div>
<div class="accent-bar"></div>

<!-- MAIN -->
<div class="main">

  <!-- LEFT PANEL -->
  <div class="left">

    ${allPhotos.length
      ? `<div class="photo-row">${allPhotos.slice(0, 4).map((src, i) => `<img src="${src}" alt="Vehicle photo ${i + 1}">`).join('')}</div>`
      : `<div class="photo-none">No Photo Available</div>`}

    <div class="ribbon">
      ${[
        ['Stock #',   vehicle.stocknumber || '—'],
        ['Condition', cap(vehicle.condition)],
        ['Mileage',   mileage],
        ['Fuel',      vehicle.fuel_type || '—'],
        ['Doors',     derivedDoors ? String(derivedDoors) : '—'],
        ['Seats',     derivedSeats ? String(derivedSeats) : '—'],
        ['GVWR',      vd.gvwr || '—'],
        ['Year',      String(vehicle.year || '—')],
      ].map(([l,v]) => `<div class="rc"><div class="rl">${l}</div><div class="rv">${v}</div></div>`).join('')}
    </div>

    <div class="cols">${colHtml}</div>

    ${buildDataHtml}

  </div>

  <!-- RIGHT PANEL -->
  <div class="right">
    <div class="price-hdr">
      <div class="ph-lbl">Total Asking Price</div>
      <div class="ph-val">${price}</div>
      <div class="ph-sub">${cap(vehicle.condition)} &nbsp;&middot;&nbsp; ${mileage}</div>
    </div>

    <div class="price-break">
      ${basePrice !== null ? `
      <div class="pb-row"><span>Base Vehicle Price</span><b>$${basePrice.toLocaleString()}</b></div>
      <div class="pb-row"><span>Options / Packages</span><b>Included</b></div>
      <div class="pb-row"><span>Destination &amp; Delivery</span><b>See Dealer</b></div>
      <div class="pb-total"><span>TOTAL PRICE</span><span>${price}</span></div>
      ` : `<div class="pb-row"><span>Contact dealer for pricing.</span></div>`}
    </div>

    ${blurb ? `<div style="margin-top:10px;padding:10px 12px;border-left:3px solid ${secondary};background:rgba(0,0,0,.035);font-size:12px;font-style:italic;color:#333;line-height:1.4;">${blurb}</div>` : ''}

    <div class="vin-blk">
      <div class="vin-lbl">Vehicle Identification Number</div>
      <div class="vin-val">${vehicle.vin || 'Not Available'}</div>
    </div>

    <div class="recall-blk">
      ${recalls?.length
        ? `<div class="r-bad">⚠ ${recalls.length} Open Recall${recalls.length > 1 ? 's' : ''}<span class="r-note">Contact dealer for remedy</span></div>`
        : `<div class="r-ok">&#10003; No Open Recalls on Record</div>`}
    </div>

    <div class="dealer-blk">
      <div class="d-name">${dealer.name || 'Your Dealership'}</div>
      ${dealer.website_url ? `<div class="d-line">${dealer.website_url}</div>` : ''}
      ${branding.tagline   ? `<div class="d-tag">&ldquo;${branding.tagline}&rdquo;</div>` : ''}
    </div>

    <div class="stock-bar">Stock # ${vehicle.stocknumber || '&mdash;'}</div>
  </div>

</div>

<!-- FOOTER -->
<div class="footer">
  <span>VIN: <b>${vehicle.vin || '&mdash;'}</b></span>
  <span>${dealer.name || ''} &nbsp;&middot;&nbsp; ${dealer.website_url || ''}</span>
  <span>Generated: <b>${new Date().toLocaleDateString('en-CA')}</b></span>
</div>

</body></html>`
}

// ── Model research (cached per model) ─────────────────────────────────────────
// Full trim / package / MSRP / fuel-economy / lifestyle breakdown for a
// year+make+model, researched once via Claude and cached in vehicle_model_specs.
// Every future brochure for the SAME model reuses the cache → near-zero AI cost
// after the first. Returns the parsed object, or null when unavailable.
async function getModelSpecs(vehicle, dealer) {
  const isUS = /^(US|USA|UNITED STATES)$/.test((dealer?.country || '').trim().toUpperCase())
  const country = isUS ? 'US' : 'CA'
  const cur = isUS ? 'USD' : 'CAD'
  const sig = [vehicle.year, vehicle.make, vehicle.model, country]
    .map(s => String(s ?? '').toLowerCase().trim()).join('|')

  // Cache hit — model specs are static for a given model-year, so keep ~1 year.
  try {
    const { data: hit } = await supabaseAdmin
      .from('vehicle_model_specs').select('data, generated_at').eq('signature', sig).maybeSingle()
    if (hit && (Date.now() - new Date(hit.generated_at)) < 365 * 86400000) return hit.data
  } catch { /* table not provisioned yet — fall through to live research */ }

  if (!process.env.ANTHROPIC_API_KEY) return null

  try {
    const Anthropic = (await import('@anthropic-ai/sdk')).default
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
    const prompt = `You are an automotive product specialist. Research the ${vehicle.year} ${vehicle.make} ${vehicle.model} for the ${isUS ? 'United States' : 'Canadian'} market and return ONLY valid JSON (no markdown) with this exact shape:
{
  "model_intro": "2-4 sentences introducing this model line and what sets it apart",
  "lifestyle": "1-2 sentences describing the ideal owner and how they'll use it",
  "trims": [ { "name": "trim name", "msrp": "from $XX,XXX ${cur} (approx.)", "summary": "1 sentence", "features": ["3-6 headline features this trim adds"] } ],
  "packages": [ { "name": "option/package name", "detail": "what it includes", "availability": "which trims it's offered on" } ],
  "fuel_economy": {
    "note": "one short line naming the powertrain these ratings are for",
    "gas": { "city_l100": number|null, "hwy_l100": number|null, "combined_l100": number|null, "city_mpg": number|null, "hwy_mpg": number|null, "combined_mpg": number|null },
    "electric": { "range_km": number|null, "range_mi": number|null, "kwh": number|null }
  }
}
Rules:
- List EVERY trim offered for this model-year (e.g. WT, LT, Z71, Trail Boss…), ascending, each with approximate MSRP in ${cur}. Always mark pricing "(approx.)".
- List the notable option PACKAGES buyers can add and which trims they're on.
- Give official-style combined/city/highway fuel economy in BOTH L/100km AND US MPG (convert if only one is published). For an EV, fill "electric" (range in km and miles, battery kWh) and leave the gas figures null.
- Be accurate; give the closest realistic manufacturer values and keep "(approx.)". NEVER invent trims that don't exist for this make/model. Keep every string tight for print.`
    const call = anthropic.messages.create({ model: 'claude-sonnet-4-6', max_tokens: 2400, messages: [{ role: 'user', content: prompt }] })
    const message = await Promise.race([call, new Promise((_, r) => setTimeout(() => r(new Error('specs timeout')), 55000))])
    let text = (message?.content?.[0]?.text || '').trim().replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/```\s*$/, '').trim()
    const a = text.indexOf('{'), b = text.lastIndexOf('}')
    if (a >= 0 && b > a) text = text.slice(a, b + 1)
    const parsed = JSON.parse(text)
    supabaseAdmin.from('vehicle_model_specs')
      .upsert({ signature: sig, data: parsed, generated_at: new Date().toISOString() })
      .then(() => {}).catch(() => {})
    return parsed
  } catch (e) {
    console.warn('[brochure] model specs failed:', e.message)
    return null
  }
}

// ── Per-vehicle cover copy (cheap, per unit) ──────────────────────────────────
// Cover headline/subhead + two highlight paragraphs about THIS specific unit.
// Always returns something (templated fallback) so the brochure never blocks.
async function generateVehicleHighlight(vehicle, dealer) {
  const name = [vehicle.year, vehicle.make, vehicle.model].filter(Boolean).join(' ')
  const trim = vehicle.trim || ''
  const isUS = /^(US|USA|UNITED STATES)$/.test((dealer?.country || '').trim().toUpperCase())
  const distUnit = isUS ? 'mi' : 'km'
  const price = vehicle.price ? `$${Number(vehicle.price).toLocaleString()}` : 'Call for price'
  const fallback = {
    headline: (`The ${[vehicle.make, vehicle.model].filter(Boolean).join(' ')}`.trim()) || name,
    cover_subhead: `The ${name}${trim ? ' ' + trim : ''} — engineered for the way you drive.`,
    highlight: [
      `This ${name}${trim ? ' ' + trim : ''}${vehicle.exterior_color ? `, finished in ${vehicle.exterior_color}` : ''}${vehicle.interior_color ? ` with a ${vehicle.interior_color} interior` : ''}, is ready to make every drive feel special.`,
      `Priced at ${price}${vehicle.stocknumber ? ` (Stock #${vehicle.stocknumber})` : ''}, it's an exceptional opportunity${dealer?.name ? ` at ${dealer.name}` : ''}. Visit us and take it for a test drive.`,
    ],
  }
  if (!process.env.ANTHROPIC_API_KEY) return fallback
  try {
    const Anthropic = (await import('@anthropic-ai/sdk')).default
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
    const prompt = `Write printed-brochure cover copy for this specific vehicle. Return ONLY JSON: {"headline":"max 8 words","cover_subhead":"one benefit sentence","highlight":["~50 words on THIS vehicle & its ${trim || 'trim'}, colour and standout features","~45 words on value + an invitation to visit ${dealer?.name || 'the dealership'}"]}. Warm, confident ${isUS ? 'American' : 'Canadian'} English.
VEHICLE: ${name} ${trim} · ${price} · ${vehicle.mileage ? Number(vehicle.mileage).toLocaleString() + ' ' + distUnit : 'brand new'} · ${vehicle.engine || ''} · ${vehicle.drivetrain || ''} · ${vehicle.exterior_color || ''}/${vehicle.interior_color || ''}
Notes: ${(vehicle.description || '').slice(0, 400)}`
    const call = anthropic.messages.create({ model: 'claude-haiku-4-5-20251001', max_tokens: 550, messages: [{ role: 'user', content: prompt }] })
    const message = await Promise.race([call, new Promise((_, r) => setTimeout(() => r(new Error('hl timeout')), 30000))])
    let text = (message?.content?.[0]?.text || '').trim().replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/```\s*$/, '').trim()
    const a = text.indexOf('{'), b = text.lastIndexOf('}')
    if (a >= 0 && b > a) text = text.slice(a, b + 1)
    const p = JSON.parse(text)
    return {
      headline: p.headline || fallback.headline,
      cover_subhead: p.cover_subhead || fallback.cover_subhead,
      highlight: Array.isArray(p.highlight) && p.highlight.length ? p.highlight.slice(0, 2) : fallback.highlight,
    }
  } catch (e) {
    console.warn('[brochure] highlight failed:', e.message)
    return fallback
  }
}

// ── Full spec brochure ────────────────────────────────────────────────────────
// Page 1 cover · Page 2 the build (as-configured spec sheet + full decoded VIN +
// fuel economy) · Page 3 this-vehicle highlight · Page 4 every trim w/ MSRP +
// features (this one highlighted) · Page 5 packages & options · Page 6 dealership.
// `copy` = { headline, cover_subhead, highlight, specs } (specs may be null).
function buildBrochureHtml(vehicle, dealer, branding, recalls, photosDataUris, logoDataUri, copy) {
  const primary   = branding.primary_color   || '#1a2e4a'
  const secondary = branding.secondary_color || '#c8a84b'
  const esc = s => String(s == null ? '' : s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))

  const isUS = /^(US|USA|UNITED STATES)$/.test((dealer?.country || '').trim().toUpperCase())
  const distUnit = isUS ? 'mi' : 'km'
  const vehicleName = [vehicle.year, vehicle.make, vehicle.model].filter(Boolean).join(' ')
  const trim   = vehicle.trim || ''
  const price  = vehicle.price ? `$${Number(vehicle.price).toLocaleString()}` : 'Call for Price'
  const mileage = vehicle.mileage ? `${Number(vehicle.mileage).toLocaleString()} ${distUnit}`
    : (vehicle.condition === 'new' ? 'Brand New' : '—')
  const photo0 = photosDataUris?.[0] || null
  const photo1 = photosDataUris?.[1] || photosDataUris?.[0] || null

  const logoSrc = logoDataUri || branding.logo_url || null
  const logoImg = (h) => logoSrc
    ? `<img src="${logoSrc}" alt="${esc(dealer.name || '')}" style="max-height:${h}px;max-width:${h * 3.4}px;object-fit:contain;display:block;">`
    : `<span style="font-size:${Math.round(h * 0.42)}px;font-weight:900;color:${primary};">${esc(dealer.name || 'Your Dealership')}</span>`

  const c = copy || {}
  const specs = c.specs || null
  const highlight = (Array.isArray(c.highlight) ? c.highlight : []).slice(0, 2)

  const specTile = (label, val) => val ? `
    <div class="spec-tile"><div class="st-label">${esc(label)}</div><div class="st-val">${esc(val)}</div></div>` : ''

  // ── Which listed trim IS this vehicle, and its MSRP ──
  const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '')
  const myNorm = norm(trim)
  const specTrims = Array.isArray(specs?.trims) ? specs.trims : []
  const trimMatches = (t) => { const n = norm(t.name); return myNorm && n && (n.includes(myNorm) || myNorm.includes(n)) }
  const myTrimObj = specTrims.find(trimMatches) || null
  const msrp = myTrimObj?.msrp || null

  // ── Decoded VIN spec sheet (core fields + every populated NHTSA field) ──
  const VIN_LABELS = {
    abs: 'ABS', esc: 'Stability Control', gvwr: 'GVWR', tpms: 'Tire Pressure Monitor',
    series: 'Series', turbo: 'Turbocharged', axles: 'Axles', seats: 'Seats', wheels: 'Wheels',
    windows: 'Windows', cylinders: 'Cylinders', lane_keep: 'Lane Keep Assist', seat_rows: 'Seat Rows',
    auto_brake: 'Automatic Emergency Braking', brake_desc: 'Brakes', horsepower: 'Horsepower',
    plant_city: 'Assembly City', wheel_base: 'Wheelbase', airbag_knee: 'Knee Airbags',
    airbag_side: 'Side Airbags', plant_state: 'Assembly State/Prov.', valve_train: 'Valve Train',
    airbag_front: 'Front Airbags', brake_system: 'Brake System', engine_model: 'Engine Model',
    manufacturer: 'Manufacturer', vehicle_type: 'Vehicle Type', adaptive_beam: 'Adaptive Driving Beam',
    engine_config: 'Engine Configuration', airbag_curtain: 'Curtain Airbags', blind_spot_mon: 'Blind Spot Monitor',
    curb_weight_lb: 'Curb Weight (lb)', displacement_l: 'Displacement (L)', fuel_injection: 'Fuel Injection',
    lane_departure: 'Lane Departure Warning', sae_automation: 'Driving Automation', adaptive_cruise: 'Adaptive Cruise',
    displacement_cc: 'Displacement (cc)', electrification: 'Electrification', wheel_size_rear: 'Rear Wheel Size',
    keyless_ignition: 'Keyless Ignition', wheel_size_front: 'Front Wheel Size', blind_spot_interv: 'Blind Spot Intervention',
    forward_collision: 'Forward Collision Warning', steering_location: 'Steering', adaptive_headlights: 'Adaptive Headlights',
    engine_manufacturer: 'Engine Manufacturer', fuel_type_secondary: 'Secondary Fuel', transmission_speeds: 'Transmission Speeds',
    plant_country: 'Assembly Country',
  }
  const SKIP = new Set(['decoded_at', 'decode_error', 'plant_company'])
  const humanize = k => k.replace(/_/g, ' ').replace(/\b\w/g, ch => ch.toUpperCase())
  const specMap = new Map()
  const addSpec = (label, val) => {
    if (val == null) return
    const s = String(val).trim()
    if (!s || /^(not applicable|n\/?a|null|none)$/i.test(s)) return
    if (!specMap.has(label)) specMap.set(label, s)
  }
  addSpec('Year', vehicle.year); addSpec('Make', vehicle.make); addSpec('Model', vehicle.model)
  addSpec('Trim', trim); addSpec('Body Style', vehicle.body_style); addSpec('Drivetrain', vehicle.drivetrain)
  addSpec('Transmission', vehicle.transmission); addSpec('Engine', vehicle.engine)
  addSpec('Fuel Type', vehicle.fuel_type); addSpec('Doors', vehicle.doors)
  addSpec('Exterior Colour', vehicle.exterior_color); addSpec('Interior Colour', vehicle.interior_color)
  addSpec('Mileage', vehicle.mileage ? `${Number(vehicle.mileage).toLocaleString()} ${distUnit}` : null)
  const vd = vehicle.vin_data || {}
  for (const [k, v] of Object.entries(vd)) { if (!SKIP.has(k)) addSpec(VIN_LABELS[k] || humanize(k), v) }
  const specSheet = [...specMap.entries()]
    .map(([l, v]) => `<div class="sp"><span class="sp-l">${esc(l)}</span><span class="sp-v">${esc(v)}</span></div>`).join('')

  // ── Fuel economy (dual units, ordered by market) ──
  const feHtml = (() => {
    const fe = specs?.fuel_economy; if (!fe) return ''
    const g = fe.gas || {}, e = fe.electric || {}
    const dual = (l100, mpg) => {
      const met = l100 != null ? `${l100} L/100km` : '—', imp = mpg != null ? `${mpg} MPG` : '—'
      return { big: isUS ? imp : met, small: isUS ? met : imp }
    }
    const cell = (label, big, small) => `<div class="fe-cell"><div class="fe-lbl">${esc(label)}</div><div class="fe-big">${esc(big)}</div><div class="fe-sm">${esc(small)}</div></div>`
    let cells = ''
    if (e && (e.range_km != null || e.range_mi != null)) {
      const km = e.range_km != null ? `${e.range_km} km` : '—', mi = e.range_mi != null ? `${e.range_mi} mi` : '—'
      cells += cell('Electric Range', isUS ? mi : km, isUS ? km : mi)
      if (e.kwh != null) cells += cell('Battery', `${e.kwh} kWh`, ' ')
    } else {
      for (const [lab, l100, mpg] of [['City', g.city_l100, g.city_mpg], ['Highway', g.hwy_l100, g.hwy_mpg], ['Combined', g.combined_l100, g.combined_mpg]]) {
        if (l100 == null && mpg == null) continue
        const d = dual(l100, mpg); cells += cell(lab, d.big, d.small)
      }
    }
    if (!cells) return ''
    return `<div class="fe"><div class="fe-title">Fuel Economy${fe.note ? ` <span class="fe-note">— ${esc(fe.note)}</span>` : ''}</div><div class="fe-grid">${cells}</div><div class="fe-foot">Shown in ${isUS ? 'MPG · L/100km' : 'L/100km · MPG'}. Manufacturer estimates — actual mileage varies.</div></div>`
  })()

  // ── Trims (every trim, MSRP + features, this one highlighted) ──
  const trimsHtml = specTrims.map(t => {
    const mine = trimMatches(t)
    const feats = Array.isArray(t.features) ? t.features.slice(0, 7) : []
    return `<div class="trimcard${mine ? ' mine' : ''}">
      <div class="trimcard-h"><h3>${esc(t.name || '')}</h3>${mine ? '<span class="trim-badge">YOUR TRIM</span>' : ''}${t.msrp ? `<span class="trim-msrp">${esc(t.msrp)}</span>` : ''}</div>
      ${t.summary ? `<p class="trim-sum">${esc(t.summary)}</p>` : ''}
      ${feats.length ? `<ul class="trim-feats">${feats.map(f => `<li>${esc(f)}</li>`).join('')}</ul>` : ''}
    </div>`
  }).join('')

  // ── Packages & options ──
  const pkgs = Array.isArray(specs?.packages) ? specs.packages : []
  const pkgsHtml = pkgs.map(p => `<div class="pkg">
    <div class="pkg-h"><h4>${esc(p.name || '')}</h4>${p.availability ? `<span class="pkg-av">${esc(p.availability)}</span>` : ''}</div>
    ${p.detail ? `<p>${esc(p.detail)}</p>` : ''}</div>`).join('')

  // Dealership contact lines (guard every optional branding field).
  const contactLines = [
    branding.address ? `<div class="d-line">${esc(branding.address)}</div>` : '',
    branding.phone ? `<div class="d-line"><b>${esc(branding.phone)}</b></div>` : '',
    dealer.website_url ? `<div class="d-line">${esc(dealer.website_url)}</div>` : '',
    branding.hours ? `<div class="d-line" style="margin-top:10px;">${esc(branding.hours)}</div>` : '',
  ].filter(Boolean).join('')

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><style>
  ${fontFaceCss()}
  *{margin:0;padding:0;box-sizing:border-box;overflow-wrap:break-word;word-break:break-word;}
  body{font-family:'Tinos','Georgia','Times New Roman',serif;width:816px;background:#fff;color:#1f2937;}
  .page{width:816px;min-height:1056px;position:relative;page-break-after:always;display:flex;flex-direction:column;}
  .page:last-child{page-break-after:auto;}
  .sans{font-family:'Arimo','Arial',Helvetica,sans-serif;}
  .eyebrow{font-family:'Arimo','Arial',sans-serif;font-size:13px;letter-spacing:5px;text-transform:uppercase;color:${secondary};font-weight:700;}

  /* PAGE 1 — COVER */
  .cover-top{padding:40px 56px 0;display:flex;align-items:center;justify-content:space-between;}
  .cover-hero{margin:26px 0 0;height:440px;background:${primary};}
  .cover-hero img{width:100%;height:100%;object-fit:cover;}
  .cover-hero .noimg{width:100%;height:100%;background:linear-gradient(135deg,${primary},${secondary});}
  .cover-body{flex:1;padding:34px 56px 0;}
  .cover-headline{font-size:44px;line-height:1.08;font-weight:900;color:${primary};letter-spacing:-1px;margin:12px 0 14px;}
  .cover-sub{font-size:20px;line-height:1.5;color:#4b5563;font-style:italic;}
  .cover-foot{margin-top:auto;background:${primary};padding:24px 56px;display:flex;align-items:center;justify-content:space-between;}
  .cover-name{color:#fff;font-size:25px;font-weight:900;font-family:'Arimo','Arial',sans-serif;}
  .cover-trim{color:rgba(255,255,255,.75);font-size:15px;font-family:'Arimo','Arial',sans-serif;margin-top:3px;}
  .cover-prices{display:flex;gap:10px;}
  .cover-price{background:${secondary};color:#fff;border-radius:8px;padding:12px 22px;text-align:center;}
  .cover-price.msrp{background:rgba(255,255,255,.14);}
  .cover-price .lbl{font-family:'Arimo','Arial',sans-serif;font-size:10px;letter-spacing:2px;text-transform:uppercase;opacity:.85;}
  .cover-price .val{font-size:26px;font-weight:900;line-height:1.15;}

  /* SHARED interior header */
  .ihdr{background:${primary};padding:32px 56px;}
  .ihdr .eyebrow{color:${secondary};}
  .ihdr h2{font-family:'Arimo','Arial',sans-serif;color:#fff;font-size:32px;font-weight:900;margin-top:8px;letter-spacing:-.5px;}
  .icontent{flex:1;padding:32px 56px 40px;}

  /* PAGE 2 — the build */
  .spec-row{display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-bottom:26px;}
  .spec-tile{background:#f8fafc;border:1px solid #e5e7eb;border-top:4px solid ${secondary};border-radius:6px;padding:14px 12px;text-align:center;}
  .st-label{font-family:'Arimo','Arial',sans-serif;font-size:10px;letter-spacing:1px;text-transform:uppercase;color:#94a3b8;}
  .st-val{font-family:'Arimo','Arial',sans-serif;font-size:17px;font-weight:800;color:${primary};margin-top:5px;line-height:1.2;}
  .sect-lbl{font-family:'Arimo','Arial',sans-serif;font-size:12px;font-weight:800;letter-spacing:2px;text-transform:uppercase;color:${secondary};margin:22px 0 12px;}
  .fe{background:${primary};border-radius:8px;padding:18px 22px;margin-bottom:8px;}
  .fe-title{font-family:'Arimo','Arial',sans-serif;color:#fff;font-size:16px;font-weight:800;margin-bottom:12px;}
  .fe-note{color:${secondary};font-weight:600;font-size:13px;}
  .fe-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;}
  .fe-cell{background:rgba(255,255,255,.08);border-radius:6px;padding:12px;text-align:center;}
  .fe-lbl{font-family:'Arimo','Arial',sans-serif;font-size:10px;letter-spacing:1px;text-transform:uppercase;color:rgba(255,255,255,.65);}
  .fe-big{font-family:'Arimo','Arial',sans-serif;font-size:20px;font-weight:900;color:#fff;margin-top:4px;}
  .fe-sm{font-family:'Arimo','Arial',sans-serif;font-size:12px;color:${secondary};margin-top:2px;}
  .fe-foot{font-family:'Arimo','Arial',sans-serif;font-size:10px;color:rgba(255,255,255,.6);margin-top:10px;}
  .specsheet{columns:2;column-gap:36px;}
  .sp{display:flex;justify-content:space-between;gap:12px;padding:6px 0;border-bottom:1px solid #eef1f5;break-inside:avoid;}
  .sp-l{font-family:'Arimo','Arial',sans-serif;font-size:12.5px;color:#64748b;}
  .sp-v{font-family:'Arimo','Arial',sans-serif;font-size:12.5px;font-weight:700;color:${primary};text-align:right;}

  /* PAGE 3 — this vehicle */
  .hl-photo{height:300px;background:${primary};margin-bottom:28px;border-radius:8px;overflow:hidden;}
  .hl-photo img{width:100%;height:100%;object-fit:cover;}
  .hl-para{font-size:19px;line-height:1.8;color:#374151;margin-bottom:20px;}

  /* PAGE 4 — trims */
  .lineup-intro{font-size:17px;line-height:1.7;color:#374151;margin-bottom:8px;}
  .lifestyle{font-size:15px;line-height:1.6;color:#6b7280;font-style:italic;margin-bottom:22px;}
  .trimcard{border:1px solid #e5e7eb;border-left:4px solid #e5e7eb;border-radius:6px;padding:14px 18px;margin-bottom:14px;break-inside:avoid;}
  .trimcard.mine{border-color:${secondary};border-left-color:${secondary};background:${secondary}0f;}
  .trimcard-h{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:6px;}
  .trimcard h3{font-family:'Arimo','Arial',sans-serif;font-size:20px;font-weight:800;color:${primary};}
  .trim-msrp{font-family:'Arimo','Arial',sans-serif;font-size:14px;font-weight:800;color:${primary};margin-left:auto;}
  .trim-badge{font-family:'Arimo','Arial',sans-serif;font-size:10px;font-weight:800;letter-spacing:1px;background:${secondary};color:#fff;padding:2px 8px;border-radius:99px;}
  .trim-sum{font-size:15px;line-height:1.55;color:#4b5563;margin-bottom:6px;}
  .trim-feats{list-style:none;display:grid;grid-template-columns:1fr 1fr;gap:2px 18px;}
  .trim-feats li{font-family:'Arimo','Arial',sans-serif;font-size:12.5px;color:#374151;padding-left:14px;position:relative;line-height:1.5;}
  .trim-feats li:before{content:'✓';position:absolute;left:0;color:${secondary};font-weight:900;}

  /* PAGE 5 — packages */
  .pkg{border-top:2px solid #eee;padding:13px 0;break-inside:avoid;}
  .pkg:first-child{border-top:3px solid ${secondary};}
  .pkg-h{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;}
  .pkg h4{font-family:'Arimo','Arial',sans-serif;font-size:17px;font-weight:800;color:${primary};}
  .pkg-av{font-family:'Arimo','Arial',sans-serif;font-size:11px;color:#94a3b8;margin-left:auto;}
  .pkg p{font-size:14.5px;line-height:1.55;color:#4b5563;margin-top:4px;}

  /* PAGE 6 — dealership */
  .d-page{align-items:stretch;}
  .d-hero{background:${primary};flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:60px;}
  .d-logo{background:#fff;border-radius:12px;padding:26px 34px;margin-bottom:34px;}
  .d-name{color:#fff;font-size:40px;font-weight:900;font-family:'Arimo','Arial',sans-serif;letter-spacing:-.5px;}
  .d-tag{color:${secondary};font-size:20px;font-style:italic;margin-top:14px;max-width:560px;}
  .d-contact{background:#fff;padding:46px 56px;text-align:center;}
  .d-contact .eyebrow{display:block;margin-bottom:16px;}
  .d-line{font-family:'Arimo','Arial',sans-serif;font-size:19px;line-height:1.9;color:#374151;}
  .d-cta{margin-top:26px;background:${secondary};color:#fff;font-family:'Arimo','Arial',sans-serif;font-size:20px;font-weight:800;padding:16px 0;border-radius:8px;}
  .d-vin{font-family:'Arimo','Arial',sans-serif;font-size:12px;color:#9ca3af;margin-top:22px;letter-spacing:.5px;}
</style></head><body>

<!-- PAGE 1 — COVER -->
<div class="page">
  <div class="cover-top">${logoImg(52)}<span class="eyebrow">Vehicle Brochure</span></div>
  <div class="cover-hero">${photo0 ? `<img src="${photo0}">` : `<div class="noimg"></div>`}</div>
  <div class="cover-body">
    <span class="eyebrow">${esc(vehicle.condition === 'new' ? 'New Arrival' : 'Featured Vehicle')}</span>
    <div class="cover-headline">${esc(c.headline || vehicleName)}</div>
    <div class="cover-sub">${esc(c.cover_subhead || '')}</div>
  </div>
  <div class="cover-foot">
    <div><div class="cover-name">${esc(vehicleName)}</div>${trim ? `<div class="cover-trim">${esc(trim)}</div>` : ''}</div>
    <div class="cover-prices">
      ${msrp ? `<div class="cover-price msrp"><div class="lbl">MSRP</div><div class="val">${esc(String(msrp).replace(/\s*\(approx\.?\)/i, ''))}</div></div>` : ''}
      <div class="cover-price"><div class="lbl">Our Price</div><div class="val">${esc(price)}</div></div>
    </div>
  </div>
</div>

<!-- PAGE 2 — THE BUILD (as configured) -->
<div class="page">
  <div class="ihdr"><span class="eyebrow">The Build</span><h2>Your ${esc(vehicleName)}${trim ? ' ' + esc(trim) : ''}</h2></div>
  <div class="icontent">
    <div class="spec-row">
      ${specTile('Our Price', price)}
      ${msrp ? specTile('MSRP', String(msrp).replace(/\s*\(approx\.?\)/i, '')) : specTile('Mileage', mileage)}
      ${specTile(vehicle.vin_data?.electrification ? 'Powertrain' : 'Drivetrain', vehicle.vin_data?.electrification || vehicle.drivetrain)}
    </div>
    ${feHtml}
    <div class="sect-lbl">Full Specifications — As Decoded from the VIN</div>
    <div class="specsheet">${specSheet}</div>
  </div>
</div>

<!-- PAGE 3 — THIS VEHICLE -->
<div class="page">
  <div class="ihdr"><span class="eyebrow">Your Vehicle</span><h2>${esc(vehicleName)}${trim ? ' ' + esc(trim) : ''}</h2></div>
  <div class="icontent">
    <div class="hl-photo">${photo1 ? `<img src="${photo1}">` : ''}</div>
    ${highlight.map(p => `<p class="hl-para">${esc(p)}</p>`).join('')}
  </div>
</div>

${specTrims.length ? `
<!-- PAGE 4 — MODELS & TRIMS -->
<div class="page">
  <div class="ihdr"><span class="eyebrow">The Lineup</span><h2>${esc([vehicle.make, vehicle.model].filter(Boolean).join(' '))} — Models &amp; Trims</h2></div>
  <div class="icontent">
    ${specs?.model_intro ? `<p class="lineup-intro">${esc(specs.model_intro)}</p>` : ''}
    ${specs?.lifestyle ? `<p class="lifestyle">${esc(specs.lifestyle)}</p>` : ''}
    ${trimsHtml}
  </div>
</div>` : ''}

${pkgs.length ? `
<!-- PAGE 5 — PACKAGES & OPTIONS -->
<div class="page">
  <div class="ihdr"><span class="eyebrow">Packages &amp; Options</span><h2>Available on the ${esc([vehicle.make, vehicle.model].filter(Boolean).join(' '))}</h2></div>
  <div class="icontent">
    ${pkgsHtml}
  </div>
</div>` : ''}

<!-- PAGE 6 — DEALERSHIP -->
<div class="page d-page">
  <div class="d-hero">
    ${logoSrc ? `<div class="d-logo">${logoImg(70)}</div>` : ''}
    <div class="d-name">${esc(dealer.name || 'Your Dealership')}</div>
    ${branding.tagline ? `<div class="d-tag">&ldquo;${esc(branding.tagline)}&rdquo;</div>` : ''}
  </div>
  <div class="d-contact">
    <span class="eyebrow">Visit Us Today</span>
    ${contactLines || `<div class="d-line">Contact us to book your test drive.</div>`}
    <div class="d-cta">Book Your Test Drive</div>
    <div class="d-vin">${esc(vehicleName)}${trim ? ' ' + esc(trim) : ''}${vehicle.stocknumber ? ' · Stock #' + esc(vehicle.stocknumber) : ''}${vehicle.vin ? ' · VIN ' + esc(vehicle.vin) : ''}</div>
  </div>
</div>

</body></html>`
}

function buildFeatureList(vehicle) {
  const features = []
  if (vehicle.drivetrain) features.push(`${vehicle.drivetrain} Drivetrain`)
  if (vehicle.transmission) features.push(`${vehicle.transmission} Transmission`)
  if (vehicle.fuel_type || vehicle.fueltype) features.push(`${vehicle.fuel_type || vehicle.fueltype} Engine`)
  if (vehicle.exterior_color) features.push(`${vehicle.exterior_color} Exterior`)
  if (vehicle.interior_color) features.push(`${vehicle.interior_color} Interior`)
  if (vehicle.body_style || vehicle.bodystyle) features.push(`${vehicle.body_style || vehicle.bodystyle} Body`)
  if (vehicle.engine) features.push(vehicle.engine)

  // Parse free-text features from description if available
  const featureKeywords = [
    'heated seats', 'heated steering', 'sunroof', 'moonroof', 'panoramic',
    'navigation', 'backup camera', 'blind spot', 'lane departure', 'adaptive cruise',
    'apple carplay', 'android auto', 'bluetooth', 'remote start', 'keyless entry',
    'leather', 'alloy wheels', 'third row', 'tow package', 'lift kit',
    'power liftgate', 'wireless charging', 'bose', 'harman', '360 camera',
  ]
  if (vehicle.description) {
    const desc = vehicle.description.toLowerCase()
    for (const kw of featureKeywords) {
      if (desc.includes(kw) && !features.some(f => f.toLowerCase().includes(kw))) {
        features.push(kw.replace(/\b\w/g, c => c.toUpperCase()))
      }
    }
  }

  return features.length ? features : ['See dealer for full equipment list']
}

// Fetch an image URL and return a base64 data URI so Puppeteer can render it
async function imgToDataUri(url, { maxWidth = 800, quality = 72 } = {}) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) })
    if (!res.ok) return null
    const buf = Buffer.from(await res.arrayBuffer())
    try {
      const sharp = (await import('sharp')).default
      const webp = await sharp(buf)
        .resize({ width: maxWidth, withoutEnlargement: true })
        .webp({ quality })
        .toBuffer()
      return `data:image/webp;base64,${webp.toString('base64')}`
    } catch {
      // sharp unavailable or unsupported format — fall back to raw
      const mime = res.headers.get('content-type') || 'image/jpeg'
      return `data:${mime};base64,${buf.toString('base64')}`
    }
  } catch { return null }
}

const EXTRA_CHROMIUM_ARGS = [
  '--disable-dev-shm-usage',  // prevents OOM on containers with small /dev/shm
  '--disable-gpu',
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-extensions',
  '--single-process',         // reduces memory on low-RAM instances
]

async function generatePdf(html, { landscape = false, viewportWidth = 860, viewportHeight = 1100, timeoutMs = 90000 } = {}) {
  // Dynamic import to avoid memory cost when not in use
  const puppeteer = (await import('puppeteer-core')).default
  let browser, page
  try {
    const isRender = process.env.NODE_ENV === 'production' || process.env.RENDER
    let launchOpts
    if (isRender) {
      const chromium = (await import('@sparticuz/chromium')).default
      launchOpts = {
        executablePath: await chromium.executablePath(),
        args: [...new Set([...chromium.args, ...EXTRA_CHROMIUM_ARGS])],
        headless: chromium.headless,
      }
    } else {
      const candidates = [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/usr/bin/google-chrome',
        '/usr/bin/chromium-browser',
      ]
      const fs = await import('fs')
      const exec = candidates.find(p => { try { fs.statSync(p); return true } catch { return false } })
      if (!exec) throw new Error('No local Chrome found')
      launchOpts = { executablePath: exec, args: EXTRA_CHROMIUM_ARGS, headless: 'new' }
    }
    browser = await puppeteer.launch({ ...launchOpts, defaultViewport: { width: viewportWidth, height: viewportHeight } })
    page = await browser.newPage()
    page.setDefaultNavigationTimeout(timeoutMs)
    await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: timeoutMs })
    // Wait for the inlined @font-face fonts to finish loading so text is measured
    // and painted with the right metrics (otherwise a fallback face can flash in).
    await page.evaluate(() => document.fonts && document.fonts.ready).catch(() => {})
    const pdf = await page.pdf({ format: 'Letter', landscape, printBackground: true, margin: { top: 0, bottom: 0, left: 0, right: 0 } })
    return pdf
  } finally {
    if (page) await page.close().catch(() => {})
    if (browser) await browser.close().catch(() => {})
  }
}

async function uploadPdf(buffer, path) {
  const { error } = await supabaseAdmin.storage.from('vehicle-pdfs').upload(path, buffer, {
    contentType: 'application/pdf', upsert: true,
  })
  if (error) throw new Error(error.message)
  const { data: { publicUrl } } = supabaseAdmin.storage.from('vehicle-pdfs').getPublicUrl(path)
  return publicUrl
}

// ── Route registration ──────────────────────────────────────────────────────

export function registerRoutes(app) {

  // ── Branding: GET ──────────────────────────────────────────────────────
  app.get('/branding', requireAuth, requireDealerAdmin, async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership' })
    const { data, error } = await supabaseAdmin
      .from('dealerships')
      .select('name, website_url, branding, vin_sticker_active')
      .eq('id', req.dealershipId)
      .single()
    if (error) return res.status(500).json({ error: error.message })
    res.json(data)
  })

  // ── Branding: PUT ──────────────────────────────────────────────────────
  app.put('/branding', requireAuth, requireDealerAdmin, async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership' })
    const b = req.body || {}
    // Merge onto existing branding so a partial save never wipes other fields.
    const { data: current } = await supabaseAdmin
      .from('dealerships').select('branding').eq('id', req.dealershipId).single()
    const branding = { ...(current?.branding || {}) }
    for (const k of ['primary_color', 'secondary_color', 'tagline', 'logo_url',
                     'overlay_enabled', 'overlay_phone', 'overlay_position', 'overlay_logo']) {
      if (b[k] !== undefined) branding[k] = b[k]
    }

    const { error } = await supabaseAdmin
      .from('dealerships')
      .update({ branding })
      .eq('id', req.dealershipId)
    if (error) return res.status(500).json({ error: error.message })
    res.json({ ok: true, branding })
  })

  // ── Brand a vehicle's photos (phone/logo overlay) ──────────────────────
  app.post('/photos/brand/:vehicleId', requireAuth, requireDealerAdmin, async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership' })
    const { data: vehicle, error } = await supabaseAdmin
      .from('inventory')
      .select('id, image_urls, branded_image_urls')
      .eq('id', req.params.vehicleId).eq('dealership_id', req.dealershipId).single()
    if (error || !vehicle) return res.status(404).json({ error: 'Vehicle not found' })

    const dealer = await loadDealershipData(req.dealershipId)
    if (!dealer?.branding?.overlay_enabled) {
      return res.status(400).json({ error: 'Photo overlays are turned off. Enable them in Branding first.' })
    }
    try {
      const urls = await brandVehiclePhotos({ ...vehicle, id: vehicle.id }, { id: req.dealershipId, branding: dealer.branding }, { force: req.query.regen === '1' })
      if (!urls) return res.status(422).json({ error: 'Could not brand these photos (no usable images or overlay disabled).' })
      res.json({ branded_image_urls: urls })
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  // ── Branding logo upload ───────────────────────────────────────────────
  app.post('/branding/logo', requireAuth, requireDealerAdmin, upload.single('logo'), async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership' })
    if (!req.file) return res.status(400).json({ error: 'No file' })
    const ext = req.file.mimetype.split('/')[1]?.replace('jpeg', 'jpg') || 'png'
    const path = `${req.dealershipId}/logo.${ext}`
    const { error } = await supabaseAdmin.storage.from('dealer-branding').upload(path, req.file.buffer, {
      contentType: req.file.mimetype, upsert: true,
    })
    if (error) return res.status(500).json({ error: error.message })
    const { data: { publicUrl } } = supabaseAdmin.storage.from('dealer-branding').getPublicUrl(path)

    // Persist to branding jsonb
    const { data: current } = await supabaseAdmin.from('dealerships').select('branding').eq('id', req.dealershipId).single()
    const merged = { ...(current?.branding || {}), logo_url: publicUrl }
    await supabaseAdmin.from('dealerships').update({ branding: merged }).eq('id', req.dealershipId)

    res.json({ url: publicUrl })
  })

  // ── VIN decode ────────────────────────────────────────────────────────
  app.get('/vin/decode/:vin', requireAuth, requireDealerAdmin, async (req, res) => {
    const vin = (req.params.vin || '').trim().toUpperCase()
    if (!vin || vin.length < 11) return res.status(400).json({ error: 'Invalid VIN' })

    // VIN decoder is part of the Inventory Intelligence tier.
    const dealer = await loadDealershipData(req.dealershipId)
    if (!hasInvIntel(dealer, req.user.email)) {
      return res.status(403).json({ error: 'The VIN decoder is part of Inventory Intelligence' })
    }

    try {
      const [decodeRes, recallRes] = await Promise.allSettled([
        fetch(`${NHTSA_DECODE}/${encodeURIComponent(vin)}?format=json`).then(r => r.json()),
        fetch(`${NHTSA_RECALLS}?vin=${encodeURIComponent(vin)}`).then(r => r.json()),
      ])

      let decoded = {}
      let allFields = []
      if (decodeRes.status === 'fulfilled') {
        const r = decodeRes.value?.Results?.[0] || {}
        // Full deep-dive: every non-empty NHTSA field, as label/value pairs, so the
        // modal can show ALL of it (not just the curated subset). Noise keys dropped.
        const NOISE = /^(ErrorCode|ErrorText|AdditionalErrorText|SuggestedVIN|PossibleValues|VIN|VehicleDescriptor|NCSABodyType|NCSAMake|NCSAModel|NCSAMapExcApprovedBy|NCSAMapExcApprovedOn|NCSANote|NCSAMappingException)$/
        allFields = Object.entries(r)
          .filter(([k, v]) => v != null && String(v).trim() !== '' && String(v).trim() !== 'Not Applicable' && String(v).trim() !== '0' && !NOISE.test(k))
          .map(([k, v]) => ({ label: k.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/_/g, ' ').trim(), value: String(v).trim() }))
        const nv = v => (v && v !== 'Not Applicable' && v !== '0' && v.trim() !== '') ? v.trim() : null
        const ni = v => { const n = parseInt(v); return isNaN(n) ? null : n }
        const nf = v => { const n = parseFloat(v); return isNaN(n) ? null : n }

        // Build engine string
        const dispL = nf(r.DisplacementL)
        const cyls  = nv(r.EngineCylinders)
        const engineStr = [
          dispL    ? `${dispL}L`                             : null,
          cyls     ? `${cyls}-cyl`                           : null,
          nv(r.EngineConfiguration),
          nv(r.ValveTrainDesign),
          nv(r.Turbo) === 'Yes' ? 'Turbocharged'            : null,
          nv(r.EngineHP) ? `${nv(r.EngineHP)} HP`           : null,
        ].filter(Boolean).join(' ') || null

        decoded = {
          vin,
          // Core inventory fields
          year:         nv(r.ModelYear),
          make:         nv(r.Make),
          model:        nv(r.Model),
          trim:         nv(r.Trim),
          body_style:   nv(r.BodyClass),
          doors:        ni(r.Doors),
          fuel_type:    nv(r.FuelTypePrimary),
          drivetrain:   nv(r.DriveType),
          transmission: nv(r.TransmissionStyle),
          engine:       engineStr,
          // Extended VIN data (stored in vin_data jsonb)
          vin_data: {
            // Identity
            manufacturer:        nv(r.Manufacturer),
            vehicle_type:        nv(r.VehicleType),
            series:              nv(r.Series) || nv(r.Series2),
            // Assembly plant
            plant_city:          nv(r.PlantCity),
            plant_state:         nv(r.PlantState),
            plant_country:       nv(r.PlantCountry),
            plant_company:       nv(r.PlantCompanyName),
            // Engine details
            engine_model:        nv(r.EngineModel),
            engine_manufacturer: nv(r.EngineManufacturer),
            engine_config:       nv(r.EngineConfiguration),
            valve_train:         nv(r.ValveTrainDesign),
            displacement_l:      dispL,
            displacement_cc:     nf(r.DisplacementCC),
            cylinders:           nv(r.EngineCylinders),
            horsepower:          nv(r.EngineHP),
            turbo:               nv(r.Turbo),
            fuel_type_secondary: nv(r.FuelTypeSecondary),
            fuel_injection:      nv(r.FuelDeliveryFuelInjectionType),
            electrification:     nv(r.ElectrificationLevel),
            // Transmission
            transmission_speeds: nv(r.TransmissionSpeed),
            // Chassis & body
            wheel_base:          nv(r.WheelBaseLong) || nv(r.WheelBaseShort),
            wheel_size_front:    nv(r.WheelSizeFront),
            wheel_size_rear:     nv(r.WheelSizeRear),
            wheels:              nv(r.Wheels),
            axles:               nv(r.Axles),
            windows:             nv(r.Windows),
            seat_rows:           nv(r.SeatRows),
            seats:               nv(r.Seats),
            // Weight / capacity
            gvwr:                nv(r.GVWR),
            curb_weight_lb:      nv(r.CurbWeightLB),
            // Brakes / steering
            brake_system:        nv(r.BrakeSystemType),
            brake_desc:          nv(r.BrakeSystemDesc),
            steering_location:   nv(r.SteeringLocation),
            // Safety systems
            abs:                 nv(r.ABS),
            esc:                 nv(r.ESC),
            tpms:                nv(r.TPMS),
            forward_collision:   nv(r.ForwardCollisionWarning),
            lane_departure:      nv(r.LaneDepartureWarning),
            lane_keep:           nv(r.LaneKeepSystem),
            blind_spot_mon:      nv(r.BlindSpotMon),
            blind_spot_interv:   nv(r.BlindSpotIntervention),
            adaptive_cruise:     nv(r.AdaptiveCruiseControl),
            auto_brake:          nv(r.AutomaticEmergencyBraking) || nv(r.RearAutomaticEmergencyBraking),
            adaptive_headlights: nv(r.AdaptiveHeadlights),
            adaptive_beam:       nv(r.AdaptiveDrivingBeam),
            // Airbags
            airbag_front:        nv(r.AirBagLocFront),
            airbag_side:         nv(r.AirBagLocSide),
            airbag_curtain:      nv(r.AirBagLocCurtain),
            airbag_knee:         nv(r.AirBagLocKnee),
            // Keyless / automation
            keyless_ignition:    nv(r.KeylessIgnition),
            sae_automation:      nv(r.SAEAutomationLevel_To),
            // Error
            decode_error:        r.ErrorCode === '0' ? null : nv(r.ErrorText),
          },
        }
      }

      let recalls = []
      if (recallRes.status === 'fulfilled') {
        recalls = (recallRes.value?.results || []).map(r => ({
          id: r.NHTSACampaignNumber,
          Component: r.Component,
          Summary: r.Summary,
          Consequence: r.Consequence,
          Remedy: r.Remedy,
          ReportReceivedDate: r.ReportReceivedDate,
        }))
      }

      // Enrich with MarketCheck neovin specs (fuel economy, MSRP, factory options)
      // when live data is available — a metered + capped call, gracefully skipped
      // if over cap or unavailable. Richer paid fields are prepended so they show
      // first in the modal's full field list.
      try {
        const isOwner = (req.user.email || '').toLowerCase() === (process.env.OWNER_EMAIL || 'massiejay@gmail.com').toLowerCase()
        if (marketcheckEnabled() && vin.length === 17 && await marketcheckAllowed(req.dealershipId, isOwner)) {
          const specs = await marketcheckDecodeVin(vin)
          await recordMarketcheckCall(req.dealershipId)
          if (specs && typeof specs === 'object') {
            const extra = []
            const push = (label, val) => { if (val != null && String(val).trim() !== '') extra.push({ label, value: String(val).trim() }) }
            push('City MPG', specs.city_mpg ?? specs.epa_city_mpg)
            push('Highway MPG', specs.highway_mpg ?? specs.epa_highway_mpg)
            push('Combined MPG', specs.combined_mpg ?? specs.epa_combined_mpg)
            push('MSRP', specs.msrp != null ? '$' + Number(specs.msrp).toLocaleString() : null)
            push('Body Subtype', specs.body_subtype)
            push('Drivetrain (MarketCheck)', specs.drivetrain)
            const opts = specs.options ?? specs.high_value_features ?? specs.installed_options
            if (Array.isArray(opts) && opts.length) push('Factory options', opts.map(o => o?.name || o).filter(Boolean).slice(0, 30).join(', '))
            else if (typeof opts === 'string') push('Factory options', opts)
            if (extra.length) allFields = extra.concat(allFields)
          }
        }
      } catch { /* enrichment is a bonus — never fail the decode for it */ }

      res.json({ decoded, recalls, recall_count: recalls.length, all_fields: allFields })
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  // ── Apply VIN decode to inventory vehicle ─────────────────────────────
  app.post('/vin/apply/:vehicleId', requireAuth, requireDealerAdmin, async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership' })
    const { decoded, recalls } = req.body
    if (!decoded) return res.status(400).json({ error: 'No decoded data' })

    const update = {}
    if (decoded.year)         update.year = decoded.year
    if (decoded.make)         update.make = decoded.make
    if (decoded.model)        update.model = decoded.model
    if (decoded.trim)         update.trim = decoded.trim
    if (decoded.body_style)   update.body_style = decoded.body_style
    if (decoded.fuel_type)    update.fuel_type = decoded.fuel_type
    if (decoded.drivetrain)   update.drivetrain = decoded.drivetrain
    if (decoded.transmission) update.transmission = decoded.transmission
    if (decoded.engine)       update.engine = decoded.engine
    if (decoded.doors)        update.doors = decoded.doors
    if (decoded.vin_data)     update.vin_data = decoded.vin_data
    if (recalls) {
      update.recalls = recalls
      update.recalls_checked_at = new Date().toISOString()
    }

    const { error } = await supabaseAdmin
      .from('inventory')
      .update(update)
      .eq('id', req.params.vehicleId)
      .eq('dealership_id', req.dealershipId)
    if (error) return res.status(500).json({ error: error.message })
    res.json({ ok: true, updated: Object.keys(update) })
  })

  // ── Generate window sticker ───────────────────────────────────────────
  // ── OEM docs by VIN (Appraisal page — no inventory vehicle needed) ────────
  // Fetch the authentic factory window sticker / brochure for a decoded VIN.
  // OEM only (no AI-generated variant). Inventory Intelligence add-on.
  app.post('/vin/oem-window-sticker', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership' })
    const dealer = await loadDealershipData(req.dealershipId)
    if (!hasInvIntel(dealer, req.user.email)) return res.status(403).json({ error: 'Factory window stickers are part of Inventory Intelligence' })
    const vin = String(req.body?.vin || '').trim().toUpperCase()
    if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) return res.status(400).json({ error: 'Enter a valid 17-character VIN' })
    try {
      const oem = await fetchOemWindowStickerPdf({ vin, make: req.body?.make || null }).catch(() => null)
      if (!oem) return res.status(404).json({ error: 'no_oem', message: 'No factory (OEM) window sticker is available for this VIN.' })
      const url = await uploadPdf(oem.buffer, `${req.dealershipId}/appraisal/${vin}-window-sticker-oem.pdf`)
      res.json({ url })
    } catch (e) { res.status(500).json({ error: e.message }) }
  })

  app.post('/vin/oem-brochure', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership' })
    const dealer = await loadDealershipData(req.dealershipId)
    if (!hasInvIntel(dealer, req.user.email)) return res.status(403).json({ error: 'Factory brochures are part of Inventory Intelligence' })
    const vin = String(req.body?.vin || '').trim().toUpperCase()
    if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) return res.status(400).json({ error: 'Enter a valid 17-character VIN' })
    try {
      const oem = await fetchOemBrochurePdf({ vin, make: req.body?.make, model: req.body?.model, year: req.body?.year }).catch(() => null)
      if (!oem) return res.status(404).json({ error: 'no_oem', message: 'No factory (OEM) brochure is available for this vehicle (on file up to 2023).' })
      const url = await uploadPdf(oem.buffer, `${req.dealershipId}/appraisal/${vin}-brochure-oem.pdf`)
      res.json({ url })
    } catch (e) { res.status(500).json({ error: e.message }) }
  })

  app.post('/pdf/window-sticker/:vehicleId', requireAuth, requireDealerAdmin, async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership' })

    const dealer = await loadDealershipData(req.dealershipId)
    // VIN decoder + factory OEM stickers are part of Inventory Intelligence.
    if (!hasInvIntel(dealer, req.user.email)) {
      return res.status(403).json({ error: 'The VIN decoder & window stickers are part of Inventory Intelligence' })
    }
    // The generated (branded) MarketSync sticker additionally needs AI Boost.
    // Anything that isn't an explicit OEM pull is the AI-generated variant.
    if (req.query.source !== 'oem' && !hasAiBoost(dealer, req.user.email)) {
      return res.status(403).json({ error: 'Generating a branded sticker requires AI Boost' })
    }

    const { data: vehicle, error } = await supabaseAdmin
      .from('inventory')
      .select('*')
      .eq('id', req.params.vehicleId)
      .eq('dealership_id', req.dealershipId)
      .single()
    if (error || !vehicle) return res.status(404).json({ error: 'Vehicle not found' })

    // OEM and AI-generated stickers are independent documents with independent
    // caches — pulling one never overwrites the other.
    const variant = req.query.source === 'oem' ? 'oem' : 'generated'
    const col = variant === 'oem' ? 'window_sticker_oem_url' : 'window_sticker_gen_url'
    const path = `${req.dealershipId}/${vehicle.id}/window-sticker-${variant}.pdf`

    // Serve this variant from its own cache.
    if (vehicle[col] && req.query.regen !== '1') {
      return res.json({ url: vehicle[col], source: variant, cached: true })
    }

    // OEM: fetch the authentic factory sticker (synchronous). No fallback — the
    // AI-generated sticker is a separate button with its own cache.
    if (variant === 'oem') {
      const oem = await fetchOemWindowStickerPdf(vehicle).catch(() => null)
      if (!oem) return res.status(404).json({ error: 'no_oem', message: 'No factory (OEM) window sticker is available for this VIN.' })
      const url = await uploadPdf(oem.buffer, path)
      await supabaseAdmin.from('inventory')
        .update({ window_sticker_oem_url: url, window_sticker_url: url, window_sticker_source: 'oem' })
        .eq('id', vehicle.id)
      return res.json({ url, source: 'oem', cached: false })
    }

    // AI-generated (branded) — build in the background to avoid platform timeout.
    res.json({ status: 'generating' })

    ;(async () => {
      const deadline = setTimeout(() => {
        console.error('[window-sticker background] hard timeout — killed after 110s')
      }, 110000)
      try {
        const vName = [vehicle.year, vehicle.make, vehicle.model, vehicle.trim].filter(Boolean).join(' ')
        const branding = dealer.branding || {}
        // Images are resized to WebP by imgToDataUri to keep HTML payload small
        const imageUrls = (vehicle.image_urls || []).slice(0, 2)
        const [photoDataUris, logoDataUri] = await Promise.all([
          Promise.all(imageUrls.map(u => imgToDataUri(u))),
          branding.logo_url ? imgToDataUri(branding.logo_url) : Promise.resolve(null),
        ])
        // AI enhancement (AI Boost): a one-line "why buy this" on the branded sticker.
        const stickerBlurb = await buildStickerBlurb(vehicle)
        if (stickerBlurb) recordUsage(req.dealershipId, { ai: 1 })
        const html = buildWindowStickerHtml(vehicle, dealer, branding, vehicle.recalls || [], photoDataUris.filter(Boolean), logoDataUri, stickerBlurb)
        const pdf = await generatePdf(html, { landscape: true, viewportWidth: 1100, viewportHeight: 860, timeoutMs: 90000 })
        const url = await uploadPdf(pdf, path)
        await supabaseAdmin.from('inventory')
          .update({ window_sticker_gen_url: url, window_sticker_url: url, window_sticker_source: 'generated' })
          .eq('id', vehicle.id)
        // Surface a clickable notification linking straight to the finished PDF.
        await createNotification({
          dealershipId: req.dealershipId,
          type: 'window_sticker',
          title: 'Window sticker ready',
          body: `Your window sticker for the ${vName} is ready to view or print.`,
          linkUrl: url,
        })
      } catch (e) {
        console.error('[window-sticker background]', e.message)
      } finally {
        clearTimeout(deadline)
      }
    })()
  })

  // ── Poll window sticker status ────────────────────────────────────────
  app.get('/pdf/window-sticker/:vehicleId/status', requireAuth, requireDealerAdmin, async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership' })
    const variant = req.query.source === 'oem' ? 'oem' : 'generated'
    const col = variant === 'oem' ? 'window_sticker_oem_url' : 'window_sticker_gen_url'
    const { data: vehicle } = await supabaseAdmin
      .from('inventory')
      .select(col)
      .eq('id', req.params.vehicleId)
      .eq('dealership_id', req.dealershipId)
      .single()
    if (vehicle?.[col]) return res.json({ status: 'ready', url: vehicle[col], source: variant })
    return res.json({ status: 'generating' })
  })

  // ── Generate brochure ─────────────────────────────────────────────────
  app.post('/pdf/brochure/:vehicleId', requireAuth, requireDealerAdmin, async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership' })

    const dealer = await loadDealershipData(req.dealershipId)
    // Entitlements mirror the window sticker: the factory (OEM) brochure is part of
    // Inventory Intelligence; the branded/AI-written dealer brochure needs AI Boost.
    const wantsOem = req.query.source === 'oem'
    if (wantsOem) {
      if (!hasInvIntel(dealer, req.user.email)) {
        return res.status(403).json({ error: 'The OEM brochure is part of Inventory Intelligence' })
      }
    } else if (!hasAiBoost(dealer, req.user.email)) {
      return res.status(403).json({ error: 'The dealer brochure requires AI Boost' })
    }

    const { data: vehicle, error } = await supabaseAdmin
      .from('inventory')
      .select('*')
      .eq('id', req.params.vehicleId)
      .eq('dealership_id', req.dealershipId)
      .single()
    if (error || !vehicle) return res.status(404).json({ error: 'Vehicle not found' })

    // OEM and AI-generated brochures are independent documents with independent
    // caches — pulling one never overwrites the other.
    const variant = wantsOem ? 'oem' : 'generated'
    const col = variant === 'oem' ? 'brochure_oem_url' : 'brochure_gen_url'
    const path = `${req.dealershipId}/${vehicle.id}/brochure-${variant}.pdf`

    if (vehicle[col] && req.query.regen !== '1') {
      return res.json({ url: vehicle[col], source: variant, cached: true })
    }

    // OEM: fetch the authentic manufacturer brochure (Auto-Brochures, up to 2023).
    if (variant === 'oem') {
      const oem = await fetchOemBrochurePdf(vehicle).catch(() => null)
      if (!oem) {
        return res.status(404).json({ error: 'no_oem', message: 'No manufacturer brochure is available for this vehicle (factory brochures are on file up to 2023).' })
      }
      const url = await uploadPdf(oem.buffer, path)
      await supabaseAdmin.from('inventory').update({ brochure_oem_url: url, brochure_url: url, brochure_source: 'oem' }).eq('id', vehicle.id)
      return res.json({ url, source: 'oem', cached: false })
    }

    // AI-written dealer brochure — build in the background to avoid platform timeout.
    res.json({ status: 'generating' })

    ;(async () => {
      const deadline = setTimeout(() => {
        console.error('[brochure background] hard timeout — killed after 110s')
      }, 110000)
      try {
        const branding = dealer.branding || {}
        // Images are resized to WebP by imgToDataUri to keep HTML payload small
        const imageUrls = (vehicle.image_urls || []).slice(0, 2)
        const [photosDataUris, logoDataUri] = await Promise.all([
          Promise.all(imageUrls.map(u => imgToDataUri(u))),
          branding.logo_url ? imgToDataUri(branding.logo_url) : Promise.resolve(null),
        ])
        // Model research (trims · MSRP · packages · fuel economy · lifestyle) is cached
        // per model — so repeat brochures for the same model cost $0. The per-vehicle
        // cover copy is a cheap separate call.
        const [specs, highlight] = await Promise.all([
          getModelSpecs(vehicle, dealer),
          generateVehicleHighlight(vehicle, dealer),
        ])
        recordUsage(req.dealershipId, { ai: specs ? 2 : 1 })   // AI-written copy (AI Boost)
        const html = buildBrochureHtml(vehicle, dealer, branding, vehicle.recalls || [], photosDataUris.filter(Boolean), logoDataUri, { ...highlight, specs })
        const pdf = await generatePdf(html, { landscape: false, viewportWidth: 860, viewportHeight: 1100, timeoutMs: 90000 })
        const url = await uploadPdf(pdf, path)
        await supabaseAdmin.from('inventory').update({ brochure_gen_url: url, brochure_url: url, brochure_source: 'generated' }).eq('id', vehicle.id)
        // Surface a clickable notification linking straight to the finished PDF.
        const vName = [vehicle.year, vehicle.make, vehicle.model, vehicle.trim].filter(Boolean).join(' ')
        await createNotification({
          dealershipId: req.dealershipId,
          type: 'brochure',
          title: 'Brochure ready',
          body: `Your full-spec brochure for the ${vName} is ready to view or print.`,
          linkUrl: url,
        })
      } catch (e) {
        console.error('[brochure background]', e.message)
      } finally {
        clearTimeout(deadline)
      }
    })()
  })

  // ── Poll brochure status ──────────────────────────────────────────────
  app.get('/pdf/brochure/:vehicleId/status', requireAuth, requireDealerAdmin, async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership' })
    const variant = req.query.source === 'oem' ? 'oem' : 'generated'
    const col = variant === 'oem' ? 'brochure_oem_url' : 'brochure_gen_url'
    const { data: vehicle } = await supabaseAdmin
      .from('inventory')
      .select(col)
      .eq('id', req.params.vehicleId)
      .eq('dealership_id', req.dealershipId)
      .single()
    if (vehicle?.[col]) return res.json({ status: 'ready', url: vehicle[col], source: variant })
    return res.json({ status: 'generating' })
  })

  // ── Clear cached PDFs when vehicle is sold/deleted ────────────────────
  app.delete('/pdf/cache/:vehicleId', requireAuth, requireDealerAdmin, async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership' })
    const vehicleId = req.params.vehicleId
    const base = `${req.dealershipId}/${vehicleId}`
    await Promise.allSettled([
      supabaseAdmin.storage.from('vehicle-pdfs').remove([
        `${base}/window-sticker.pdf`, `${base}/window-sticker-oem.pdf`, `${base}/window-sticker-generated.pdf`,
        `${base}/brochure.pdf`, `${base}/brochure-oem.pdf`, `${base}/brochure-generated.pdf`,
      ]),
      supabaseAdmin.from('inventory').update({
        window_sticker_url: null, window_sticker_source: null, window_sticker_oem_url: null, window_sticker_gen_url: null,
        brochure_url: null, brochure_source: null, brochure_oem_url: null, brochure_gen_url: null,
      }).eq('id', vehicleId).eq('dealership_id', req.dealershipId),
    ])
    res.json({ ok: true })
  })
}
