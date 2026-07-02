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
  const primary = branding.primary_color || '#1a2e4a'
  const secondary = branding.secondary_color || '#c8a84b'

  const logoSrc = logoDataUri || branding.logo_url || null
  const logoHtml = logoSrc
    ? `<img src="${logoSrc}" alt="${dealer.name || ''}" style="max-height:56px;max-width:200px;object-fit:contain;display:block;">`
    : `<span style="font-size:18px;font-weight:900;color:#fff;letter-spacing:-0.5px;">${dealer.name || 'Your Dealership'}</span>`

  const photoHtml = photoDataUri
    ? `<img src="${photoDataUri}" style="width:100%;height:100%;object-fit:cover;" alt="Vehicle">`
    : `<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;background:#e5e7eb;color:#9ca3af;font-size:13px;">No Photo Available</div>`

  const features = buildFeatureList(vehicle)
  const price = vehicle.price ? `$${Number(vehicle.price).toLocaleString()}` : 'Call for Price'
  const mileage = vehicle.mileage ? `${Number(vehicle.mileage).toLocaleString()} km` : vehicle.condition === 'new' ? 'New' : '—'
  const cap = s => s ? s.charAt(0).toUpperCase() + s.slice(1) : '—'

  const specs = [
    ['Year',         vehicle.year         || '—'],
    ['Make',         vehicle.make         || '—'],
    ['Model',        vehicle.model        || '—'],
    ['Trim',         vehicle.trim         || '—'],
    ['Condition',    cap(vehicle.condition)],
    ['Mileage',      mileage],
    ['Body Style',   vehicle.body_style   || '—'],
    ['Fuel Type',    vehicle.fuel_type    || '—'],
    ['Drivetrain',   vehicle.drivetrain   || '—'],
    ['Transmission', vehicle.transmission || '—'],
    ['Engine',       vehicle.engine       || '—'],
    ['Doors',        vehicle.doors        ? String(vehicle.doors) : '—'],
    ['Ext. Colour',  vehicle.exterior_color || '—'],
    ['Int. Colour',  vehicle.interior_color || '—'],
  ]

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8">
<style>
  *{margin:0;padding:0;box-sizing:border-box;}
  body{font-family:'Arial',Helvetica,sans-serif;width:816px;background:#fff;color:#111;}
  /* ── Header ── */
  .hdr{background:${primary};display:flex;align-items:center;justify-content:space-between;padding:14px 24px;}
  .hdr-right{text-align:right;color:#fff;}
  .hdr-right .label{font-size:10px;letter-spacing:2.5px;text-transform:uppercase;opacity:.7;}
  .hdr-right .title{font-size:20px;font-weight:900;letter-spacing:-.5px;}
  /* ── Title bar ── */
  .title-bar{background:${secondary};padding:10px 24px;display:flex;align-items:center;justify-content:space-between;}
  .title-bar .vname{font-size:18px;font-weight:900;color:#fff;letter-spacing:-.3px;}
  .title-bar .stock{font-size:11px;color:rgba(255,255,255,.8);font-weight:600;}
  /* ── Body ── */
  .body{display:flex;}
  /* LEFT column */
  .left{flex:1;padding:18px 20px;border-right:1px solid #e5e7eb;}
  .photo{width:100%;aspect-ratio:16/9;background:#f1f5f9;border-radius:6px;overflow:hidden;margin-bottom:14px;}
  .specs-grid{display:grid;grid-template-columns:1fr 1fr;gap:5px;margin-bottom:14px;}
  .spec{background:#f8fafc;border:1px solid #e2e8f0;border-radius:5px;padding:7px 10px;}
  .spec .slabel{font-size:9px;color:#94a3b8;text-transform:uppercase;letter-spacing:.6px;}
  .spec .sval{font-size:12px;font-weight:700;color:#0f172a;margin-top:1px;}
  /* Features */
  .sec-title{font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:1.2px;color:${primary};border-bottom:2px solid ${secondary};padding-bottom:3px;margin-bottom:8px;}
  .feat-grid{display:grid;grid-template-columns:1fr 1fr;gap:0;}
  .feat-item{font-size:11px;color:#334155;padding:3px 0;display:flex;gap:5px;align-items:flex-start;}
  .feat-item::before{content:"✓";color:${secondary};font-weight:800;flex-shrink:0;font-size:10px;}
  /* RIGHT column */
  .right{width:230px;padding:18px 16px;display:flex;flex-direction:column;gap:12px;}
  .price-card{background:${primary};color:#fff;border-radius:8px;padding:14px;text-align:center;}
  .price-card .plabel{font-size:9px;letter-spacing:2px;text-transform:uppercase;opacity:.7;}
  .price-card .pval{font-size:26px;font-weight:900;line-height:1.1;margin-top:2px;}
  .price-card .pmile{font-size:11px;opacity:.8;margin-top:3px;}
  .vin-card{background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;padding:10px;text-align:center;}
  .vin-card .vlabel{font-size:9px;color:#94a3b8;text-transform:uppercase;letter-spacing:.5px;}
  .vin-card .vval{font-size:10px;font-weight:700;font-family:monospace;letter-spacing:.8px;word-break:break-all;margin-top:2px;color:#0f172a;}
  .recall-ok{background:#f0fdf4;border:1px solid #86efac;border-radius:6px;padding:8px 10px;text-align:center;font-size:11px;font-weight:700;color:#15803d;}
  .recall-bad{background:#fef2f2;border:1px solid #fca5a5;border-radius:6px;padding:8px 10px;text-align:center;font-size:11px;font-weight:700;color:#dc2626;}
  .recall-detail{background:#fef2f2;border:1px solid #fca5a5;border-radius:5px;padding:7px 9px;font-size:10px;color:#374151;margin-top:4px;}
  .recall-detail b{color:#dc2626;display:block;}
  .contact-card{background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;padding:10px;}
  .contact-card .cname{font-size:13px;font-weight:800;color:${primary};margin-bottom:4px;}
  .contact-card .cline{font-size:11px;color:#475569;line-height:1.7;}
  .tagline{font-size:10px;font-style:italic;color:#94a3b8;margin-top:6px;text-align:center;}
  /* Footer */
  .footer{background:${primary};color:rgba(255,255,255,.85);padding:9px 24px;display:flex;justify-content:space-between;font-size:10px;margin-top:auto;}
  .footer b{color:#fff;}
</style>
</head>
<body>

<div class="hdr">
  <div>${logoHtml}</div>
  <div class="hdr-right">
    <div class="label">Vehicle Information</div>
    <div class="title">Window Sticker</div>
  </div>
</div>

<div class="title-bar">
  <div class="vname">${vehicle.year || ''} ${vehicle.make || ''} ${vehicle.model || ''}${vehicle.trim ? ' ' + vehicle.trim : ''}</div>
  <div class="stock">Stock&nbsp;#&nbsp;${vehicle.stocknumber || '—'}</div>
</div>

<div class="body">
  <div class="left">
    <div class="photo">${photoHtml}</div>

    <div class="specs-grid">
      ${specs.map(([l, v]) => `<div class="spec"><div class="slabel">${l}</div><div class="sval">${v}</div></div>`).join('')}
    </div>

    <div class="sec-title">Features &amp; Equipment</div>
    <div class="feat-grid">
      ${features.map(f => `<div class="feat-item">${f}</div>`).join('')}
    </div>

    ${vehicle.description ? `
    <div class="sec-title" style="margin-top:12px;">Vehicle Description</div>
    <div style="font-size:11px;line-height:1.65;color:#475569;">${vehicle.description.slice(0, 400)}${vehicle.description.length > 400 ? '…' : ''}</div>
    ` : ''}
  </div>

  <div class="right">
    <div class="price-card">
      <div class="plabel">Asking Price</div>
      <div class="pval">${price}</div>
      <div class="pmile">${mileage}</div>
    </div>

    <div class="vin-card">
      <div class="vlabel">Vehicle Identification Number</div>
      <div class="vval">${vehicle.vin || 'Not Available'}</div>
    </div>

    ${recalls?.length
      ? `<div class="recall-bad">⚠ ${recalls.length} Open Recall${recalls.length > 1 ? 's' : ''} — See Dealer</div>
         ${recalls.slice(0, 2).map(r => `<div class="recall-detail"><b>${r.Component || 'Component'}</b>${(r.Summary || r.Consequence || '').slice(0, 100)}…</div>`).join('')}`
      : `<div class="recall-ok">✓ No Open Recalls on Record</div>`}

    <div class="contact-card">
      <div class="cname">${dealer.name || 'Your Dealership'}</div>
      ${dealer.website_url ? `<div class="cline">🌐 ${dealer.website_url}</div>` : ''}
      ${branding.tagline ? `<div class="tagline">"${branding.tagline}"</div>` : ''}
    </div>
  </div>
</div>

<div class="footer">
  <span>Stock #: <b>${vehicle.stocknumber || '—'}</b></span>
  <span>${dealer.name || ''}</span>
  <span>Generated ${new Date().toLocaleDateString('en-CA')}</span>
</div>
</body></html>`
}

function buildBrochureHtml(vehicle, dealer, branding, recalls, photosDataUris, logoDataUri) {
  const primary = branding.primary_color || '#1a2e4a'
  const secondary = branding.secondary_color || '#c8a84b'

  const logoSrc = logoDataUri || branding.logo_url || null
  const logoHtml = logoSrc
    ? `<img src="${logoSrc}" alt="${dealer.name || ''}" style="max-height:52px;max-width:180px;object-fit:contain;display:block;">`
    : `<span style="font-size:17px;font-weight:900;color:#fff;">${dealer.name || 'Your Dealership'}</span>`

  const price = vehicle.price ? `$${Number(vehicle.price).toLocaleString()}` : 'Call for Price'
  const mileage = vehicle.mileage ? `${Number(vehicle.mileage).toLocaleString()} km` : vehicle.condition === 'new' ? 'New' : '—'
  const features = buildFeatureList(vehicle)
  const cap = s => s ? s.charAt(0).toUpperCase() + s.slice(1) : null

  // Use pre-fetched base64 uris; fallback to raw URLs (may not render in Puppeteer)
  const rawPhotos = (vehicle.image_urls || []).slice(0, 4)
  const getPhoto = i => photosDataUris?.[i] || rawPhotos[i] || null

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8">
<style>
  *{margin:0;padding:0;box-sizing:border-box;}
  body{font-family:'Arial',Helvetica,sans-serif;width:816px;background:#fff;color:#111;}
  .page{width:816px;min-height:1056px;position:relative;display:flex;flex-direction:column;page-break-after:always;}

  /* ── PAGE 1 ── */
  .hero{position:relative;height:400px;background:${primary};overflow:hidden;flex-shrink:0;}
  .hero img{width:100%;height:100%;object-fit:cover;}
  .hero-grad{position:absolute;inset:0;background:linear-gradient(to bottom,rgba(0,0,0,.05) 0%,rgba(0,0,0,.72) 100%);}
  .hero-content{position:absolute;bottom:0;left:0;right:0;padding:22px 30px;color:#fff;}
  .hero-accent{font-size:11px;letter-spacing:3px;text-transform:uppercase;color:${secondary};margin-bottom:5px;}
  .hero-name{font-size:30px;font-weight:900;line-height:1.05;}
  .hero-sub{font-size:15px;opacity:.85;margin-top:3px;}

  .strip{background:${secondary};display:flex;align-items:center;justify-content:space-between;padding:10px 30px;flex-shrink:0;}
  .strip .logo-area{}
  .strip .price-area{text-align:center;color:#fff;}
  .strip .price-area .pv{font-size:22px;font-weight:900;}
  .strip .price-area .mv{font-size:12px;opacity:.85;}
  .strip .contact-area{text-align:right;color:rgba(255,255,255,.9);font-size:11px;line-height:1.7;}

  .specbar{display:flex;border-bottom:1px solid #e5e7eb;flex-shrink:0;}
  .sb-item{flex:1;padding:10px 12px;border-right:1px solid #e5e7eb;text-align:center;}
  .sb-item:last-child{border-right:none;}
  .sb-label{font-size:8px;color:#94a3b8;text-transform:uppercase;letter-spacing:.5px;}
  .sb-val{font-size:12px;font-weight:700;color:#0f172a;margin-top:2px;}

  .gallery{display:grid;grid-template-columns:1fr 1fr;gap:6px;padding:14px 20px;flex:1;}
  .gallery .gp{border-radius:6px;overflow:hidden;aspect-ratio:16/9;background:#f1f5f9;display:flex;align-items:center;justify-content:center;color:#9ca3af;font-size:12px;}
  .gallery img{width:100%;height:100%;object-fit:cover;}

  .p1-footer{background:${primary};padding:9px 30px;display:flex;justify-content:space-between;font-size:10px;color:rgba(255,255,255,.8);}
  .p1-footer b{color:#fff;}

  /* ── PAGE 2 ── */
  .p2-hdr{background:${primary};padding:14px 28px;display:flex;align-items:center;justify-content:space-between;flex-shrink:0;}
  .p2-hdr-title{color:#fff;font-size:15px;font-weight:700;}
  .p2-body{display:flex;flex:1;}
  .p2-left{flex:1;padding:20px 24px;border-right:1px solid #e5e7eb;}
  .p2-right{width:240px;padding:20px 18px;display:flex;flex-direction:column;gap:12px;}

  .sec{margin-bottom:16px;}
  .sec-hdr{font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:1.2px;color:${primary};border-bottom:2px solid ${secondary};padding-bottom:3px;margin-bottom:8px;}
  .desc{font-size:11px;line-height:1.7;color:#475569;}
  .feat-grid{display:grid;grid-template-columns:1fr 1fr;gap:2px;}
  .fi{font-size:11px;color:#334155;padding:3px 0;display:flex;gap:5px;align-items:flex-start;}
  .fi::before{content:"✓";color:${secondary};font-weight:800;flex-shrink:0;font-size:10px;}
  .full-specs{display:grid;grid-template-columns:1fr 1fr;gap:5px;}
  .fs-item{background:#f8fafc;border:1px solid #e2e8f0;border-radius:4px;padding:6px 8px;}
  .fs-label{font-size:8px;color:#94a3b8;text-transform:uppercase;letter-spacing:.5px;}
  .fs-val{font-size:11px;font-weight:700;color:#0f172a;margin-top:1px;}

  .price-card{background:${primary};color:#fff;border-radius:8px;padding:16px;text-align:center;}
  .pc-label{font-size:9px;letter-spacing:2px;text-transform:uppercase;opacity:.7;}
  .pc-val{font-size:28px;font-weight:900;line-height:1.1;margin-top:2px;}
  .pc-mile{font-size:11px;opacity:.75;margin-top:3px;}

  .recall-ok{background:#f0fdf4;border:1px solid #86efac;border-radius:6px;padding:8px 10px;text-align:center;font-size:11px;font-weight:700;color:#15803d;}
  .recall-bad{background:#fef2f2;border:1px solid #fca5a5;border-radius:6px;padding:8px 10px;font-size:11px;}
  .recall-bad b{display:block;color:#dc2626;font-size:12px;margin-bottom:2px;}

  .contact-card{background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;padding:12px;}
  .cc-name{font-size:14px;font-weight:800;color:${primary};margin-bottom:5px;}
  .cc-line{font-size:11px;color:#475569;line-height:1.8;}
  .cc-tagline{font-size:10px;font-style:italic;color:#94a3b8;margin-top:8px;}

  .vin-box{background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;padding:8px;text-align:center;}
  .vin-label{font-size:9px;color:#94a3b8;text-transform:uppercase;letter-spacing:.5px;}
  .vin-val{font-size:10px;font-weight:700;font-family:monospace;letter-spacing:.8px;word-break:break-all;margin-top:2px;}

  .p2-footer{background:${primary};padding:9px 28px;display:flex;justify-content:space-between;font-size:10px;color:rgba(255,255,255,.8);flex-shrink:0;margin-top:auto;}
  .p2-footer b{color:#fff;}
</style>
</head>
<body>

<!-- ══ PAGE 1 ══ -->
<div class="page">
  <div class="hero">
    ${getPhoto(0) ? `<img src="${getPhoto(0)}" alt="Vehicle">` : `<div style="width:100%;height:100%;background:linear-gradient(135deg,${primary} 0%,${secondary} 100%);"></div>`}
    <div class="hero-grad"></div>
    <div class="hero-content">
      ${branding.tagline ? `<div class="hero-accent">${branding.tagline}</div>` : ''}
      <div class="hero-name">${vehicle.year || ''} ${vehicle.make || ''} ${vehicle.model || ''}</div>
      <div class="hero-sub">${[vehicle.trim, cap(vehicle.condition)].filter(Boolean).join(' · ')}</div>
    </div>
  </div>

  <div class="strip">
    <div class="logo-area">${logoHtml}</div>
    <div class="price-area">
      <div class="pv">${price}</div>
      <div class="mv">${mileage}</div>
    </div>
    <div class="contact-area">
      ${dealer.website_url ? `<div>🌐 ${dealer.website_url}</div>` : ''}
      <div>${dealer.name || ''}</div>
    </div>
  </div>

  <div class="specbar">
    ${[
      ['Drivetrain',   vehicle.drivetrain   || '—'],
      ['Fuel Type',    vehicle.fuel_type    || '—'],
      ['Transmission', vehicle.transmission || '—'],
      ['Body Style',   vehicle.body_style   || '—'],
      ['Ext. Colour',  vehicle.exterior_color || '—'],
      ['Stock #',      vehicle.stocknumber  || '—'],
    ].map(([l,v]) => `<div class="sb-item"><div class="sb-label">${l}</div><div class="sb-val">${v}</div></div>`).join('')}
  </div>

  <div class="gallery">
    ${[0,1,2,3].map(i => getPhoto(i)
      ? `<div class="gp"><img src="${getPhoto(i)}" alt="Photo ${i+1}"></div>`
      : `<div class="gp">Photo ${i+1}</div>`
    ).join('')}
  </div>

  <div class="p1-footer">
    <span>Stock #: <b>${vehicle.stocknumber || '—'}</b></span>
    <span>${dealer.name || ''}</span>
    <span>Generated ${new Date().toLocaleDateString('en-CA')}</span>
  </div>
</div>

<!-- ══ PAGE 2 ══ -->
<div class="page">
  <div class="p2-hdr">
    ${logoHtml}
    <div class="p2-hdr-title">${vehicle.year || ''} ${vehicle.make || ''} ${vehicle.model || ''}${vehicle.trim ? ' — ' + vehicle.trim : ''}</div>
  </div>

  <div class="p2-body">
    <div class="p2-left">
      ${vehicle.description ? `
      <div class="sec">
        <div class="sec-hdr">About This Vehicle</div>
        <div class="desc">${vehicle.description.slice(0, 650)}${vehicle.description.length > 650 ? '…' : ''}</div>
      </div>` : ''}

      <div class="sec">
        <div class="sec-hdr">Features &amp; Equipment</div>
        <div class="feat-grid">
          ${features.map(f => `<div class="fi">${f}</div>`).join('')}
        </div>
      </div>

      ${[
        ['Engine',       vehicle.engine],
        ['Body Style',   vehicle.body_style],
        ['Doors',        vehicle.doors ? String(vehicle.doors) : null],
        ['Int. Colour',  vehicle.interior_color],
        ['Condition',    cap(vehicle.condition)],
        ['VIN',          vehicle.vin],
      ].filter(([,v]) => v).length ? `
      <div class="sec">
        <div class="sec-hdr">Full Specifications</div>
        <div class="full-specs">
          ${[
            ['Engine',       vehicle.engine],
            ['Body Style',   vehicle.body_style],
            ['Doors',        vehicle.doors ? String(vehicle.doors) : null],
            ['Int. Colour',  vehicle.interior_color],
            ['Condition',    cap(vehicle.condition)],
          ].filter(([,v]) => v).map(([l,v]) => `
          <div class="fs-item"><div class="fs-label">${l}</div><div class="fs-val">${v}</div></div>`).join('')}
        </div>
      </div>` : ''}
    </div>

    <div class="p2-right">
      <div class="price-card">
        <div class="pc-label">Asking Price</div>
        <div class="pc-val">${price}</div>
        <div class="pc-mile">${mileage}</div>
      </div>

      ${recalls?.length
        ? `<div class="recall-bad"><b>⚠ ${recalls.length} Open Recall${recalls.length > 1 ? 's' : ''}</b>See dealer for details &amp; remedy.</div>`
        : `<div class="recall-ok">✓ No Open Recalls on Record</div>`}

      <div class="contact-card">
        <div class="cc-name">${dealer.name || 'Your Dealership'}</div>
        ${dealer.website_url ? `<div class="cc-line">🌐 ${dealer.website_url}</div>` : ''}
        ${branding.tagline ? `<div class="cc-tagline">"${branding.tagline}"</div>` : ''}
      </div>

      <div class="vin-box">
        <div class="vin-label">VIN</div>
        <div class="vin-val">${vehicle.vin || 'Not Available'}</div>
      </div>
    </div>
  </div>

  <div class="p2-footer">
    <span>Stock #: <b>${vehicle.stocknumber || '—'}</b></span>
    <span>VIN: ${vehicle.vin || '—'}</span>
    <span>Generated ${new Date().toLocaleDateString('en-CA')}</span>
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

async function generatePdf(html) {
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
    browser = await puppeteer.launch({ ...launchOpts, defaultViewport: { width: 816, height: 1056 } })
    page = await browser.newPage()
    await page.setContent(html, { waitUntil: 'networkidle0' })
    const pdf = await page.pdf({ format: 'Letter', printBackground: true, margin: { top: 0, bottom: 0, left: 0, right: 0 } })
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
        decoded = {
          vin,
          year: r.ModelYear || null,
          make: r.Make || null,
          model: r.Model || null,
          trim: r.Trim || null,
          body_style: r.BodyClass || null,
          doors: r.Doors || null,
          fuel_type: r.FuelTypePrimary || null,
          drivetrain: r.DriveType || null,
          transmission: r.TransmissionStyle || null,
          engine: r.DisplacementL ? `${r.DisplacementL}L ${r.EngineCylinders ? r.EngineCylinders + '-cyl' : ''}`.trim() : null,
          cylinders: r.EngineCylinders || null,
          displacement: r.DisplacementL ? `${r.DisplacementL}L` : null,
          plant_city: r.PlantCity || null,
          plant_country: r.PlantCountry || null,
          gvwr: r.GVWR || null,
          error_code: r.ErrorCode === '0' ? null : r.ErrorText || null,
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
    if (decoded.year) update.year = decoded.year
    if (decoded.make) update.make = decoded.make
    if (decoded.model) update.model = decoded.model
    if (decoded.trim) update.trim = decoded.trim
    if (decoded.body_style) update.body_style = decoded.body_style
    if (decoded.fuel_type) update.fuel_type = decoded.fuel_type
    if (decoded.drivetrain) update.drivetrain = decoded.drivetrain
    if (decoded.transmission) update.transmission = decoded.transmission
    if (decoded.engine) update.engine = decoded.engine
    if (decoded.doors) update.doors = decoded.doors
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
      const pdf = await generatePdf(html)
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
      const imageUrls = (vehicle.image_urls || []).slice(0, 2)
      const [photosDataUris, logoDataUri] = await Promise.all([
        Promise.all(imageUrls.map(u => imgToDataUri(u))),
        branding.logo_url ? imgToDataUri(branding.logo_url) : Promise.resolve(null),
      ])
      const html = buildBrochureHtml(vehicle, dealer, branding, vehicle.recalls || [], photosDataUris, logoDataUri)
      const pdf = await generatePdf(html)
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
