import { supabaseAdmin } from '../shared.js'
import { requireAuth } from '../middleware.js'
import multer from 'multer'

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 3 * 1024 * 1024 } })

const NHTSA_DECODE = 'https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValuesExtended'
const NHTSA_RECALLS = 'https://api.nhtsa.gov/recalls/recallsByVin'

function requireDealerAdmin(req, res, next) {
  if (!['DEALER_ADMIN', 'DEALER_STAFF', 'SALES_REP'].includes(req.profile?.role)) {
    return res.status(403).json({ error: 'Dealer access required' })
  }
  next()
}

function requireVinSticker(req, res, next) {
  if (!req.dealershipData?.vin_sticker_active) {
    return res.status(403).json({ error: 'VIN Sticker & Brochure add-on not active' })
  }
  next()
}

// ── Helpers ────────────────────────────────────────────────────────────────

function pick(obj, ...keys) {
  for (const k of keys) if (obj[k]) return obj[k]
  return ''
}

async function loadDealershipData(dealershipId) {
  const { data, error } = await supabaseAdmin
    .from('dealerships')
    .select('id, name, website_url, branding, vin_sticker_active')
    .eq('id', dealershipId)
    .single()
  if (error) console.error('[loadDealershipData]', error.message)
  return data
}

function buildWindowStickerHtml(vehicle, dealer, branding, recalls, photoDataUri, logoDataUri) {
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
  *{margin:0;padding:0;box-sizing:border-box;}
  body{font-family:'Arial',Helvetica,sans-serif;width:1056px;height:816px;background:#fff;color:#111;display:flex;flex-direction:column;overflow:hidden;}

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

  .photo{height:180px;background:#0f172a;overflow:hidden;flex-shrink:0;position:relative;}
  .photo img{width:100%;height:100%;object-fit:contain;object-position:center;}
  .photo-none{width:100%;height:100%;display:flex;align-items:center;justify-content:center;color:#94a3b8;font-size:12px;background:#e8ecf0;}

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

    <div class="photo">
      ${photoDataUri
        ? `<img src="${photoDataUri}" alt="Vehicle">`
        : `<div class="photo-none">No Photo Available</div>`}
    </div>

    <div class="ribbon">
      ${[
        ['Stock #',   vehicle.stocknumber || '—'],
        ['Condition', cap(vehicle.condition)],
        ['Mileage',   mileage],
        ['Fuel',      vehicle.fuel_type || '—'],
        ['Doors',     vehicle.doors ? String(vehicle.doors) : '—'],
        ['Seats',     vd.seats || '—'],
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

function buildBrochureHtml(vehicle, dealer, branding, recalls, photosDataUris, logoDataUri) {
  const primary   = branding.primary_color   || '#1a2e4a'
  const secondary = branding.secondary_color || '#c8a84b'
  const vd        = vehicle.vin_data || {}

  const logoSrc  = logoDataUri || branding.logo_url || null
  const logoHtml = logoSrc
    ? `<img src="${logoSrc}" alt="${dealer.name || ''}" style="max-height:50px;max-width:170px;object-fit:contain;display:block;">`
    : `<span style="font-size:16px;font-weight:900;color:${primary};letter-spacing:-.3px;">${dealer.name || 'Your Dealership'}</span>`

  const price     = vehicle.price   ? `$${Number(vehicle.price).toLocaleString()}` : 'Call for Price'
  const mileage   = vehicle.mileage ? `${Number(vehicle.mileage).toLocaleString()} km` : (vehicle.condition === 'new' ? 'New Vehicle' : '—')
  const cap       = s => s ? s.charAt(0).toUpperCase() + s.slice(1) : null
  const vehicleName = [vehicle.year, vehicle.make, vehicle.model].filter(Boolean).join(' ')
  const plantStr  = [vd.plant_city, vd.plant_state, vd.plant_country].filter(Boolean).join(', ') || null

  const getPhoto  = i => photosDataUris?.[i] || null

  // ── Generate sales copy ───────────────────────────────────────────────────
  const condWord  = vehicle.condition === 'new' ? 'brand-new' : vehicle.condition === 'certified' ? 'certified pre-owned' : 'pre-owned'
  const driveStr  = vehicle.drivetrain ? vehicle.drivetrain.replace(/\//g, '/') : null
  const engineStr = vehicle.engine || (vd.horsepower ? `${vd.horsepower} HP engine` : null)

  const introPara = [
    `Introducing the ${vehicleName}${vehicle.trim ? ' ' + vehicle.trim : ''} — a ${condWord} vehicle that combines performance, style, and value in one impressive package.`,
    engineStr ? `Under the hood you'll find a ${engineStr}${driveStr ? ` paired with ${driveStr}` : ''}, delivering a confident and capable driving experience.` : null,
    vehicle.exterior_color ? `Finished in ${vehicle.exterior_color}${vehicle.interior_color ? ` with a ${vehicle.interior_color} interior` : ''}, this ${vehicle.body_style || 'vehicle'} is ready to turn heads wherever you go.` : null,
    vehicle.mileage ? `With ${mileage} on the odometer and ${recalls?.length ? `${recalls.length} outstanding recall${recalls.length > 1 ? 's' : ''} — please ask us about the remedy` : 'no open safety recalls on record'}, you can drive away with confidence.` : null,
  ].filter(Boolean).join(' ')

  const safetyItems = [
    vd.abs === 'Standard' ? 'Anti-Lock Brakes (ABS)' : null,
    vd.esc === 'Standard' ? 'Electronic Stability Control' : null,
    vd.tpms === 'Direct' || vd.tpms === 'Indirect' ? 'Tire Pressure Monitoring' : null,
    vd.forward_collision   && vd.forward_collision !== 'Not Applicable' ? 'Forward Collision Warning' : null,
    vd.lane_departure      && vd.lane_departure !== 'Not Applicable'     ? 'Lane Departure Warning' : null,
    vd.blind_spot_mon      && vd.blind_spot_mon !== 'Not Applicable'     ? 'Blind Spot Monitoring' : null,
    vd.auto_brake          && vd.auto_brake !== 'Not Applicable'         ? 'Automatic Emergency Braking' : null,
    vd.adaptive_cruise     && vd.adaptive_cruise !== 'Not Applicable'    ? 'Adaptive Cruise Control' : null,
    vd.airbag_front        ? `Front Airbags — ${vd.airbag_front}` : null,
    vd.airbag_curtain      ? `Curtain Airbags — ${vd.airbag_curtain}` : null,
  ].filter(Boolean)

  const safetyCopy = safetyItems.length
    ? `${vehicleName} comes equipped with ${safetyItems.slice(0, 3).join(', ')}, and more — so you and your passengers are protected at every turn.`
    : `${vehicleName} is engineered with modern safety systems designed to help protect you and your passengers every time you get behind the wheel.`

  const valueCopy = `Priced at ${price}${vehicle.stocknumber ? ` (Stock #${vehicle.stocknumber})` : ''}, this is an exceptional opportunity${dealer.name ? ` available exclusively at ${dealer.name}` : ''}. ${dealer.website_url ? `Visit us online at ${dealer.website_url} or come in for a test drive today.` : 'Contact us today to schedule a test drive.'}`

  // ── Feature list (from vin_data + description) ────────────────────────────
  const desc      = (vehicle.description || '').toLowerCase()
  const has       = kw => desc.includes(kw)
  const nhtsa     = (val, label) => {
    if (!val) return null
    const v = val.toString().toLowerCase()
    return (v === 'not applicable' || v === 'none' || v === '0') ? null : label
  }

  const allFeatures = [
    vehicle.engine                            && vehicle.engine,
    vehicle.drivetrain                        && `${vehicle.drivetrain} Drivetrain`,
    vehicle.transmission                      && `${vehicle.transmission} Transmission`,
    vd.transmission_speeds                    && `${vd.transmission_speeds}-Speed`,
    vehicle.fuel_type                         && `${vehicle.fuel_type} Fuel`,
    vd.horsepower                             && `${vd.horsepower} HP`,
    nhtsa(vd.turbo, 'Turbocharged'),
    nhtsa(vd.abs, 'ABS Brakes'),
    nhtsa(vd.esc, 'Electronic Stability Control'),
    nhtsa(vd.tpms, 'Tire Pressure Monitoring'),
    nhtsa(vd.forward_collision, 'Forward Collision Warning'),
    nhtsa(vd.lane_departure, 'Lane Departure Warning'),
    nhtsa(vd.blind_spot_mon, 'Blind Spot Monitoring'),
    nhtsa(vd.auto_brake, 'Auto Emergency Braking'),
    nhtsa(vd.adaptive_cruise, 'Adaptive Cruise Control'),
    nhtsa(vd.keyless_ignition, 'Keyless Ignition'),
    has('heated seat')        ? 'Heated Front Seats' : null,
    has('heated steering')    ? 'Heated Steering Wheel' : null,
    has('remote start')       ? 'Remote Start' : null,
    has('sunroof') || has('moonroof') ? 'Sunroof / Moonroof' : null,
    has('panoramic')          ? 'Panoramic Roof' : null,
    has('power liftgate')     ? 'Power Liftgate' : null,
    has('leather')            ? 'Leather Interior' : null,
    has('apple carplay')      ? 'Apple CarPlay®' : null,
    has('android auto')       ? 'Android Auto™' : null,
    has('navigation')         ? 'Built-In Navigation' : null,
    has('bluetooth')          ? 'Bluetooth Connectivity' : null,
    has('backup camera') || has('rear camera') ? 'Rear-View Camera' : null,
    has('wi-fi') || has('hotspot') ? 'Wi-Fi Hotspot' : null,
    has('wireless charg')     ? 'Wireless Charging' : null,
    has('third row') || has('3rd row') ? 'Third-Row Seating' : null,
    vehicle.exterior_color    && `${vehicle.exterior_color} Exterior`,
    vehicle.interior_color    && `${vehicle.interior_color} Interior`,
    vd.seats                  && `${vd.seats} Passenger Capacity`,
    plantStr                  && `Built in ${plantStr}`,
  ].filter(Boolean)

  // Full spec table
  const specRows = [
    ['Year',          vehicle.year],
    ['Make',          vehicle.make],
    ['Model',         vehicle.model],
    ['Trim',          vehicle.trim],
    ['Condition',     cap(vehicle.condition)],
    ['Body Style',    vehicle.body_style],
    ['Doors',         vehicle.doors ? String(vehicle.doors) : null],
    ['Ext. Colour',   vehicle.exterior_color],
    ['Int. Colour',   vehicle.interior_color],
    ['Mileage',       mileage],
    ['Engine',        vehicle.engine],
    ['Horsepower',    vd.horsepower ? `${vd.horsepower} HP` : null],
    ['Fuel Type',     vehicle.fuel_type],
    ['Drivetrain',    vehicle.drivetrain],
    ['Transmission',  vehicle.transmission],
    ['Trans Speeds',  vd.transmission_speeds],
    ['Displacement',  vd.displacement_l ? `${vd.displacement_l}L` : null],
    ['Cylinders',     vd.cylinders],
    ['GVWR',          vd.gvwr],
    ['Curb Weight',   vd.curb_weight_lb ? `${vd.curb_weight_lb} lbs` : null],
    ['Stock #',       vehicle.stocknumber],
    ['VIN',           vehicle.vin],
  ].filter(([, v]) => v)

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8">
<style>
  *{margin:0;padding:0;box-sizing:border-box;}
  body{font-family:'Arial',Helvetica,sans-serif;width:816px;background:#fff;color:#111;margin:0;padding:0;}
  .page{width:816px;min-height:1056px;overflow:hidden;display:flex;flex-direction:column;page-break-after:always;}

  /* ════ PAGE 1 ════ */
  /* Hero photo — full bleed top half */
  .hero{position:relative;height:420px;background:${primary};overflow:hidden;flex-shrink:0;}
  .hero img{width:100%;height:100%;object-fit:cover;object-position:center;}
  .hero-none{width:100%;height:100%;background:linear-gradient(135deg,${primary} 0%,${secondary} 100%);}
  .hero-grad{position:absolute;inset:0;background:linear-gradient(to bottom,rgba(0,0,0,0) 30%,rgba(0,0,0,.75) 100%);}
  /* Dealer bar overlaid top-left of hero */
  .hero-dealer{position:absolute;top:0;left:0;right:0;padding:16px 28px;display:flex;align-items:center;justify-content:space-between;}
  .hero-dealer-badge{background:rgba(0,0,0,.45);backdrop-filter:blur(4px);border-radius:6px;padding:8px 14px;}
  .hero-price-badge{background:${secondary};border-radius:6px;padding:8px 16px;text-align:center;}
  .hero-price-badge .hpb-label{font-size:8px;letter-spacing:2px;text-transform:uppercase;color:rgba(255,255,255,.8);}
  .hero-price-badge .hpb-val{font-size:22px;font-weight:900;color:#fff;line-height:1.1;}
  /* Vehicle name at bottom of hero */
  .hero-name-wrap{position:absolute;bottom:0;left:0;right:0;padding:18px 28px 20px;}
  .hero-tag{font-size:10px;letter-spacing:3px;text-transform:uppercase;color:${secondary};margin-bottom:6px;}
  .hero-title{font-size:36px;font-weight:900;color:#fff;line-height:1;letter-spacing:-.5px;}
  .hero-trim{font-size:15px;color:rgba(255,255,255,.8);margin-top:5px;font-weight:400;}

  /* Spec strip under hero */
  .spec-strip{display:flex;background:${primary};flex-shrink:0;}
  .ss-item{flex:1;padding:9px 10px;border-right:1px solid rgba(255,255,255,.15);text-align:center;}
  .ss-item:last-child{border-right:none;}
  .ss-label{font-size:7.5px;color:rgba(255,255,255,.6);text-transform:uppercase;letter-spacing:.6px;}
  .ss-val{font-size:11px;font-weight:700;color:#fff;margin-top:2px;}

  /* Sales copy section */
  .sales-body{display:flex;flex:1;padding:0;}

  /* Left: intro copy + 3 feature highlights */
  .sales-left{flex:1;padding:20px 22px;border-right:2px solid #f1f5f9;}
  .section-title{font-size:9px;font-weight:800;text-transform:uppercase;letter-spacing:1.5px;color:${secondary};margin-bottom:5px;}
  .intro-para{font-size:11.5px;line-height:1.75;color:#334155;margin-bottom:18px;}

  .highlight-row{display:flex;gap:12px;margin-bottom:18px;}
  .highlight{flex:1;background:#f8fafc;border-top:3px solid ${secondary};border-radius:0 0 6px 6px;padding:12px 10px;}
  .hl-icon{font-size:18px;margin-bottom:5px;}
  .hl-title{font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.5px;color:${primary};margin-bottom:4px;}
  .hl-body{font-size:9.5px;color:#64748b;line-height:1.5;}

  /* Right: second photo + sales blurbs */
  .sales-right{width:260px;display:flex;flex-direction:column;}
  .photo2{height:165px;background:#0f172a;overflow:hidden;flex-shrink:0;}
  .photo2 img{width:100%;height:100%;object-fit:contain;}
  .photo2-none{width:100%;height:100%;display:flex;align-items:center;justify-content:center;background:#0f172a;}
  .sales-right-body{flex:1;padding:14px 16px;display:flex;flex-direction:column;gap:12px;}
  .sr-blurb{}
  .sr-blurb-title{font-size:9px;font-weight:800;text-transform:uppercase;letter-spacing:.8px;color:${primary};border-bottom:1.5px solid ${secondary};padding-bottom:2px;margin-bottom:5px;}
  .sr-blurb-text{font-size:9.5px;line-height:1.6;color:#475569;}

  /* Footer bar page 1 */
  .p1-foot{background:${secondary};padding:8px 28px;display:flex;justify-content:space-between;align-items:center;font-size:9px;color:rgba(255,255,255,.85);flex-shrink:0;}
  .p1-foot b{color:#fff;}

  /* ════ PAGE 2 ════ */
  /* Header */
  .p2-hdr{background:${primary};padding:12px 24px;display:flex;align-items:center;justify-content:space-between;flex-shrink:0;}
  .p2-hdr-name{color:#fff;font-size:14px;font-weight:900;letter-spacing:-.2px;}
  .p2-hdr-sub{color:rgba(255,255,255,.7);font-size:10px;margin-top:1px;}

  /* Photo gallery row */
  .gallery-row{display:grid;grid-template-columns:1fr 1fr 1fr;gap:4px;height:160px;flex-shrink:0;}
  .gp{overflow:hidden;background:#0f172a;display:flex;align-items:center;justify-content:center;}
  .gp img{width:100%;height:100%;object-fit:contain;}
  .gp-none{color:#94a3b8;font-size:10px;}

  /* Body */
  .p2-body{display:flex;flex:1;min-height:0;}
  .p2-left{flex:1;padding:16px 20px;border-right:1px solid #e5e7eb;overflow:hidden;}
  .p2-right{width:230px;padding:14px 16px;display:flex;flex-direction:column;gap:10px;flex-shrink:0;}

  .sec{margin-bottom:14px;}
  .sec-hdr{font-size:8.5px;font-weight:800;text-transform:uppercase;letter-spacing:1.2px;color:${primary};border-bottom:2px solid ${secondary};padding-bottom:2px;margin-bottom:7px;}
  .desc-text{font-size:10.5px;line-height:1.7;color:#475569;}
  .feat-grid{display:grid;grid-template-columns:1fr 1fr;gap:1px;}
  .fi{font-size:9.5px;color:#334155;padding:2.5px 0 2.5px 11px;position:relative;line-height:1.3;}
  .fi::before{content:"&#10003;";position:absolute;left:1px;color:${secondary};font-weight:900;font-size:10px;}
  .spec-grid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:4px;}
  .sg-item{background:#f8fafc;border:1px solid #e2e8f0;border-radius:3px;padding:5px 7px;}
  .sg-label{font-size:7px;color:#94a3b8;text-transform:uppercase;letter-spacing:.4px;}
  .sg-val{font-size:9.5px;font-weight:700;color:#0f172a;margin-top:1px;}

  /* Price card */
  .price-card{background:${primary};color:#fff;border-radius:6px;padding:14px;text-align:center;}
  .prc-lbl{font-size:8px;letter-spacing:2px;text-transform:uppercase;opacity:.65;margin-bottom:2px;}
  .prc-val{font-size:28px;font-weight:900;line-height:1;}
  .prc-sub{font-size:9px;opacity:.7;margin-top:3px;}

  .recall-ok{background:#f0fdf4;border:1px solid #86efac;border-radius:5px;padding:7px 9px;text-align:center;font-size:9.5px;font-weight:700;color:#15803d;}
  .recall-bad{background:#fef2f2;border:1px solid #fca5a5;border-radius:5px;padding:7px 9px;text-align:center;font-size:9px;font-weight:700;color:#dc2626;}

  .contact-card{background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;padding:11px;}
  .cc-name{font-size:13px;font-weight:900;color:${primary};margin-bottom:4px;}
  .cc-line{font-size:9.5px;color:#475569;line-height:1.75;}
  .cc-tag{font-size:9px;font-style:italic;color:#94a3b8;margin-top:5px;}

  .vin-card{background:#f8fafc;border:1px solid #e2e8f0;border-radius:5px;padding:7px;text-align:center;}
  .vin-lbl{font-size:7.5px;color:#94a3b8;text-transform:uppercase;letter-spacing:.5px;}
  .vin-val{font-size:9px;font-weight:700;font-family:monospace;letter-spacing:.5px;word-break:break-all;color:#0f172a;margin-top:2px;line-height:1.3;}

  .p2-foot{background:${primary};padding:7px 24px;display:flex;justify-content:space-between;align-items:center;font-size:8.5px;color:rgba(255,255,255,.75);flex-shrink:0;}
  .p2-foot b{color:#fff;}
</style>
</head>
<body>

<!-- ══════════════ PAGE 1 — COVER ══════════════ -->
<div class="page">

  <!-- Hero photo -->
  <div class="hero">
    ${getPhoto(0) ? `<img src="${getPhoto(0)}" alt="Vehicle">` : `<div class="hero-none"></div>`}
    <div class="hero-grad"></div>
    <!-- Dealer logo top-left, price top-right -->
    <div class="hero-dealer">
      <div class="hero-dealer-badge">${logoHtml}</div>
      <div class="hero-price-badge">
        <div class="hpb-label">Asking Price</div>
        <div class="hpb-val">${price}</div>
      </div>
    </div>
    <!-- Vehicle name bottom-left -->
    <div class="hero-name-wrap">
      ${branding.tagline ? `<div class="hero-tag">${branding.tagline}</div>` : `<div class="hero-tag">${dealer.name || ''}</div>`}
      <div class="hero-title">${vehicleName}</div>
      <div class="hero-trim">${[vehicle.trim, cap(vehicle.condition), mileage].filter(Boolean).join('&nbsp;&nbsp;·&nbsp;&nbsp;')}</div>
    </div>
  </div>

  <!-- Spec strip -->
  <div class="spec-strip">
    ${[
      ['Engine',       vehicle.engine        || '—'],
      ['Drivetrain',   vehicle.drivetrain    || '—'],
      ['Transmission', vehicle.transmission  || '—'],
      ['Fuel Type',    vehicle.fuel_type     || '—'],
      ['Colour',       vehicle.exterior_color || '—'],
      ['Stock #',      vehicle.stocknumber   || '—'],
    ].map(([l,v]) => `<div class="ss-item"><div class="ss-label">${l}</div><div class="ss-val">${v}</div></div>`).join('')}
  </div>

  <!-- Sales body: intro copy left, photo + blurbs right -->
  <div class="sales-body">
    <div class="sales-left">
      <div class="section-title">About This Vehicle</div>
      <div class="intro-para">${introPara}</div>

      <div class="highlight-row">
        <div class="highlight">
          <div class="hl-icon">&#9881;</div>
          <div class="hl-title">Performance</div>
          <div class="hl-body">${engineStr ? `${engineStr}${driveStr ? ` with ${driveStr}` : ''} — built for confident driving in any condition.` : 'Engineered for a smooth, confident drive every time.'}</div>
        </div>
        <div class="highlight">
          <div class="hl-icon">&#10003;</div>
          <div class="hl-title">Safety</div>
          <div class="hl-body">${safetyItems.length ? `Equipped with ${safetyItems.slice(0,2).join(' and ')} for your peace of mind.` : 'Built with modern safety systems to protect you and your passengers.'}</div>
        </div>
        <div class="highlight">
          <div class="hl-icon">&#9733;</div>
          <div class="hl-title">Value</div>
          <div class="hl-body">Priced at ${price} — ${recalls?.length ? 'ask us about the open recall remedy before you drive away.' : 'with no open recalls on record, this is a worry-free purchase.'}</div>
        </div>
      </div>
    </div>

    <div class="sales-right">
      <div class="photo2">
        ${getPhoto(1) ? `<img src="${getPhoto(1)}" alt="Vehicle">` : `<div class="photo2-none"></div>`}
      </div>
      <div class="sales-right-body">
        <div class="sr-blurb">
          <div class="sr-blurb-title">Safety &amp; Confidence</div>
          <div class="sr-blurb-text">${safetyCopy}</div>
        </div>
        <div class="sr-blurb">
          <div class="sr-blurb-title">Visit Us Today</div>
          <div class="sr-blurb-text">${valueCopy}</div>
        </div>
      </div>
    </div>
  </div>

  <div class="p1-foot">
    <span><b>${dealer.name || ''}</b></span>
    <span>${dealer.website_url || ''}</span>
    <span>Stock # <b>${vehicle.stocknumber || '—'}</b></span>
  </div>
</div>

<!-- ══════════════ PAGE 2 — DETAIL ══════════════ -->
<div class="page">

  <div class="p2-hdr">
    <div>
      <div class="p2-hdr-name">${vehicleName}${vehicle.trim ? ' ' + vehicle.trim : ''}</div>
      <div class="p2-hdr-sub">${[cap(vehicle.condition), mileage, price].filter(Boolean).join('&nbsp;&nbsp;·&nbsp;&nbsp;')}</div>
    </div>
    ${logoHtml}
  </div>

  <!-- Photo gallery: up to 3 more photos -->
  <div class="gallery-row">
    ${[1,2,3].map(i => getPhoto(i)
      ? `<div class="gp"><img src="${getPhoto(i)}" alt="Photo ${i+1}"></div>`
      : `<div class="gp"><div class="gp-none"></div></div>`
    ).join('')}
  </div>

  <div class="p2-body">
    <div class="p2-left">

      ${vehicle.description ? `
      <div class="sec">
        <div class="sec-hdr">Vehicle Description</div>
        <div class="desc-text">${vehicle.description.slice(0, 700)}${vehicle.description.length > 700 ? '&hellip;' : ''}</div>
      </div>` : ''}

      <div class="sec">
        <div class="sec-hdr">Features &amp; Equipment</div>
        <div class="feat-grid">
          ${allFeatures.map(f => `<div class="fi">${f}</div>`).join('')}
        </div>
      </div>

      <div class="sec">
        <div class="sec-hdr">Full Specifications</div>
        <div class="spec-grid">
          ${specRows.map(([l,v]) => `<div class="sg-item"><div class="sg-label">${l}</div><div class="sg-val">${v}</div></div>`).join('')}
        </div>
      </div>

    </div>

    <div class="p2-right">
      <div class="price-card">
        <div class="prc-lbl">Asking Price</div>
        <div class="prc-val">${price}</div>
        <div class="prc-sub">${cap(vehicle.condition)} &nbsp;&middot;&nbsp; ${mileage}</div>
      </div>

      ${recalls?.length
        ? `<div class="recall-bad">&#9888; ${recalls.length} Open Recall${recalls.length > 1 ? 's' : ''}<br><span style="font-weight:400;font-size:8.5px;">Ask dealer for remedy details</span></div>`
        : `<div class="recall-ok">&#10003; No Open Recalls on Record</div>`}

      <div class="contact-card">
        <div class="cc-name">${dealer.name || 'Your Dealership'}</div>
        ${dealer.website_url ? `<div class="cc-line">${dealer.website_url}</div>` : ''}
        ${branding.tagline   ? `<div class="cc-tag">&ldquo;${branding.tagline}&rdquo;</div>` : ''}
      </div>

      <div class="vin-card">
        <div class="vin-lbl">Vehicle Identification Number</div>
        <div class="vin-val">${vehicle.vin || 'Not Available'}</div>
      </div>
    </div>
  </div>

  <div class="p2-foot">
    <span>VIN: <b>${vehicle.vin || '&mdash;'}</b></span>
    <span>${dealer.name || ''}</span>
    <span>Generated: <b>${new Date().toLocaleDateString('en-CA')}</b></span>
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
async function imgToDataUri(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) })
    if (!res.ok) return null
    const buf = await res.arrayBuffer()
    const mime = res.headers.get('content-type') || 'image/jpeg'
    return `data:${mime};base64,${Buffer.from(buf).toString('base64')}`
  } catch { return null }
}

async function generatePdf(html, { landscape = false, viewportWidth = 860, viewportHeight = 1100 } = {}) {
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
        args: chromium.args,
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
      launchOpts = { executablePath: exec, args: ['--no-sandbox', '--disable-setuid-sandbox'], headless: 'new' }
    }
    browser = await puppeteer.launch({ ...launchOpts, defaultViewport: { width: viewportWidth, height: viewportHeight } })
    page = await browser.newPage()
    await page.setContent(html, { waitUntil: 'networkidle0' })
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
    const { primary_color, secondary_color, tagline, logo_url } = req.body
    const branding = {}
    if (primary_color !== undefined) branding.primary_color = primary_color
    if (secondary_color !== undefined) branding.secondary_color = secondary_color
    if (tagline !== undefined) branding.tagline = tagline
    if (logo_url !== undefined) branding.logo_url = logo_url

    const { error } = await supabaseAdmin
      .from('dealerships')
      .update({ branding })
      .eq('id', req.dealershipId)
    if (error) return res.status(500).json({ error: error.message })
    res.json({ ok: true })
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

    try {
      const [decodeRes, recallRes] = await Promise.allSettled([
        fetch(`${NHTSA_DECODE}/${encodeURIComponent(vin)}?format=json`).then(r => r.json()),
        fetch(`${NHTSA_RECALLS}?vin=${encodeURIComponent(vin)}`).then(r => r.json()),
      ])

      let decoded = {}
      if (decodeRes.status === 'fulfilled') {
        const r = decodeRes.value?.Results?.[0] || {}
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

      res.json({ decoded, recalls, recall_count: recalls.length })
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
  app.post('/pdf/window-sticker/:vehicleId', requireAuth, requireDealerAdmin, async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership' })

    const dealer = await loadDealershipData(req.dealershipId)
    if (!dealer?.vin_sticker_active) return res.status(403).json({ error: 'VIN Sticker & Brochure add-on not active' })

    const { data: vehicle, error } = await supabaseAdmin
      .from('inventory')
      .select('*')
      .eq('id', req.params.vehicleId)
      .eq('dealership_id', req.dealershipId)
      .single()
    if (error || !vehicle) return res.status(404).json({ error: 'Vehicle not found' })

    // Return cached URL if already generated
    if (vehicle.window_sticker_url && req.query.regen !== '1') {
      return res.json({ url: vehicle.window_sticker_url, cached: true })
    }

    try {
      const branding = dealer.branding || {}
      const [photoDataUri, logoDataUri] = await Promise.all([
        vehicle.image_urls?.[0] ? imgToDataUri(vehicle.image_urls[0]) : Promise.resolve(null),
        branding.logo_url ? imgToDataUri(branding.logo_url) : Promise.resolve(null),
      ])
      const html = buildWindowStickerHtml(vehicle, dealer, branding, vehicle.recalls || [], photoDataUri, logoDataUri)
      const pdf = await generatePdf(html, { landscape: true, viewportWidth: 1100, viewportHeight: 860 })
      const path = `${req.dealershipId}/${vehicle.id}/window-sticker.pdf`
      const url = await uploadPdf(pdf, path)
      await supabaseAdmin.from('inventory').update({ window_sticker_url: url }).eq('id', vehicle.id)
      res.json({ url, cached: false })
    } catch (e) {
      console.error('[window-sticker]', e.message)
      res.status(500).json({ error: e.message })
    }
  })

  // ── Generate brochure ─────────────────────────────────────────────────
  app.post('/pdf/brochure/:vehicleId', requireAuth, requireDealerAdmin, async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership' })

    const dealer = await loadDealershipData(req.dealershipId)
    if (!dealer?.vin_sticker_active) return res.status(403).json({ error: 'VIN Sticker & Brochure add-on not active' })

    const { data: vehicle, error } = await supabaseAdmin
      .from('inventory')
      .select('*')
      .eq('id', req.params.vehicleId)
      .eq('dealership_id', req.dealershipId)
      .single()
    if (error || !vehicle) return res.status(404).json({ error: 'Vehicle not found' })

    if (vehicle.brochure_url && req.query.regen !== '1') {
      return res.json({ url: vehicle.brochure_url, cached: true })
    }

    try {
      const branding = dealer.branding || {}
      const imageUrls = (vehicle.image_urls || []).slice(0, 4)
      const [photosDataUris, logoDataUri] = await Promise.all([
        Promise.all(imageUrls.map(u => imgToDataUri(u))),
        branding.logo_url ? imgToDataUri(branding.logo_url) : Promise.resolve(null),
      ])
      const html = buildBrochureHtml(vehicle, dealer, branding, vehicle.recalls || [], photosDataUris, logoDataUri)
      const pdf = await generatePdf(html, { landscape: false, viewportWidth: 860, viewportHeight: 1100 })
      const path = `${req.dealershipId}/${vehicle.id}/brochure.pdf`
      const url = await uploadPdf(pdf, path)
      await supabaseAdmin.from('inventory').update({ brochure_url: url }).eq('id', vehicle.id)
      res.json({ url, cached: false })
    } catch (e) {
      console.error('[brochure]', e.message)
      res.status(500).json({ error: e.message })
    }
  })

  // ── Clear cached PDFs when vehicle is sold/deleted ────────────────────
  app.delete('/pdf/cache/:vehicleId', requireAuth, requireDealerAdmin, async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership' })
    const vehicleId = req.params.vehicleId
    await Promise.allSettled([
      supabaseAdmin.storage.from('vehicle-pdfs').remove([`${req.dealershipId}/${vehicleId}/window-sticker.pdf`]),
      supabaseAdmin.storage.from('vehicle-pdfs').remove([`${req.dealershipId}/${vehicleId}/brochure.pdf`]),
      supabaseAdmin.from('inventory').update({ window_sticker_url: null, brochure_url: null }).eq('id', vehicleId).eq('dealership_id', req.dealershipId),
    ])
    res.json({ ok: true })
  })
}
