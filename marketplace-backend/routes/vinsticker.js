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

function buildWindowStickerHtml(vehicle, dealer, branding, recalls) {
  const primary = branding.primary_color || '#1a2e4a'
  const secondary = branding.secondary_color || '#c8a84b'
  const logoHtml = branding.logo_url
    ? `<img src="${branding.logo_url}" alt="Dealer Logo" style="max-height:70px;max-width:220px;object-fit:contain;">`
    : `<span style="font-size:22px;font-weight:800;color:${primary};">${dealer.name || 'Your Dealership'}</span>`

  const features = buildFeatureList(vehicle)
  const recallBadge = recalls?.length
    ? `<div style="background:#dc2626;color:#fff;padding:8px 16px;border-radius:6px;font-size:13px;font-weight:700;margin-top:8px;">⚠ ${recalls.length} Open Recall${recalls.length > 1 ? 's' : ''} — See dealer for details</div>`
    : `<div style="background:#16a34a;color:#fff;padding:8px 16px;border-radius:6px;font-size:13px;font-weight:700;margin-top:8px;">✓ No Open Recalls</div>`

  const price = vehicle.price ? `$${Number(vehicle.price).toLocaleString()}` : 'Contact for Price'
  const mileage = vehicle.mileage ? `${Number(vehicle.mileage).toLocaleString()} km` : '—'

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: Arial, Helvetica, sans-serif; width: 816px; background: #fff; color: #1a1a1a; }
  .header { background: ${primary}; color: #fff; padding: 18px 28px; display: flex; align-items: center; justify-content: space-between; }
  .header-logo { }
  .header-title { text-align: right; }
  .header-title h1 { font-size: 13px; letter-spacing: 2px; text-transform: uppercase; opacity: 0.8; }
  .header-title h2 { font-size: 22px; font-weight: 800; }
  .vehicle-name { background: ${secondary}; color: #fff; text-align: center; padding: 14px; font-size: 20px; font-weight: 800; letter-spacing: 0.5px; }
  .main { display: flex; gap: 0; padding: 0; }
  .left { flex: 1; padding: 20px 24px; border-right: 2px solid #e5e7eb; }
  .right { width: 260px; padding: 20px 20px; }
  .photo-box { width: 100%; aspect-ratio: 16/9; background: #f3f4f6; border-radius: 8px; overflow: hidden; margin-bottom: 16px; }
  .photo-box img { width: 100%; height: 100%; object-fit: cover; }
  .photo-placeholder { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; color: #9ca3af; font-size: 14px; }
  .specs-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin-bottom: 16px; }
  .spec { background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 6px; padding: 8px 10px; }
  .spec-label { font-size: 10px; color: #6b7280; text-transform: uppercase; letter-spacing: 0.5px; }
  .spec-value { font-size: 13px; font-weight: 700; color: #111; margin-top: 2px; }
  .section-title { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 1px; color: ${primary}; border-bottom: 2px solid ${secondary}; padding-bottom: 4px; margin-bottom: 10px; }
  .feature-list { list-style: none; }
  .feature-list li { font-size: 12px; padding: 3px 0; color: #374151; display: flex; align-items: flex-start; gap: 6px; }
  .feature-list li::before { content: "✓"; color: ${secondary}; font-weight: 700; flex-shrink: 0; }
  .price-box { background: ${primary}; color: #fff; border-radius: 10px; padding: 16px; text-align: center; margin-bottom: 14px; }
  .price-label { font-size: 10px; letter-spacing: 1.5px; text-transform: uppercase; opacity: 0.75; }
  .price-value { font-size: 28px; font-weight: 900; line-height: 1.1; margin-top: 2px; }
  .vin-box { background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; padding: 10px; margin-bottom: 12px; text-align: center; }
  .vin-label { font-size: 10px; color: #6b7280; text-transform: uppercase; letter-spacing: 0.5px; }
  .vin-value { font-size: 11px; font-weight: 700; font-family: monospace; margin-top: 2px; letter-spacing: 1px; word-break: break-all; }
  .footer { background: ${primary}; color: rgba(255,255,255,0.9); padding: 12px 28px; display: flex; align-items: center; justify-content: space-between; font-size: 11px; }
  .footer strong { color: #fff; }
</style>
</head>
<body>
<div class="header">
  <div class="header-logo">${logoHtml}</div>
  <div class="header-title">
    <h1>Vehicle Information</h1>
    <h2>Window Sticker</h2>
  </div>
</div>

<div class="vehicle-name">${vehicle.year} ${vehicle.make} ${vehicle.model}${vehicle.trim ? ' ' + vehicle.trim : ''}</div>

<div class="main">
  <div class="left">
    <div class="photo-box">
      ${vehicle.image_urls?.[0]
        ? `<img src="${vehicle.image_urls[0]}" alt="Vehicle Photo">`
        : `<div class="photo-placeholder">No Photo Available</div>`}
    </div>

    <div class="specs-grid">
      ${[
        ['Year', vehicle.year],
        ['Make', vehicle.make],
        ['Model', vehicle.model],
        ['Trim', vehicle.trim || '—'],
        ['Condition', vehicle.condition ? (vehicle.condition.charAt(0).toUpperCase() + vehicle.condition.slice(1)) : '—'],
        ['Mileage', mileage],
        ['Body Style', vehicle.body_style || vehicle.bodystyle || '—'],
        ['Fuel Type', vehicle.fuel_type || vehicle.fueltype || '—'],
        ['Drivetrain', vehicle.drivetrain || '—'],
        ['Transmission', vehicle.transmission || '—'],
        ['Ext. Colour', vehicle.exterior_color || '—'],
        ['Int. Colour', vehicle.interior_color || '—'],
      ].map(([label, value]) => `
        <div class="spec">
          <div class="spec-label">${label}</div>
          <div class="spec-value">${value || '—'}</div>
        </div>`).join('')}
    </div>

    <div class="section-title">Standard Features</div>
    <ul class="feature-list">
      ${features.map(f => `<li>${f}</li>`).join('')}
    </ul>
  </div>

  <div class="right">
    <div class="price-box">
      <div class="price-label">Asking Price</div>
      <div class="price-value">${price}</div>
    </div>

    <div class="vin-box">
      <div class="vin-label">VIN</div>
      <div class="vin-value">${vehicle.vin || 'Not Available'}</div>
    </div>

    ${recallBadge}

    ${recalls?.length ? `
    <div style="margin-top:12px;">
      <div class="section-title">Recall Details</div>
      ${recalls.slice(0, 3).map(r => `
        <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:6px;padding:8px;margin-bottom:6px;font-size:11px;">
          <div style="font-weight:700;color:#dc2626;">${r.Component || 'Component'}</div>
          <div style="color:#374151;margin-top:2px;">${(r.Summary || r.Consequence || '').slice(0, 120)}${(r.Summary || '').length > 120 ? '…' : ''}</div>
        </div>`).join('')}
    </div>` : ''}

    <div style="margin-top:16px;">
      <div class="section-title">Contact Us</div>
      <div style="font-size:12px;line-height:1.8;color:#374151;">
        ${dealer.name ? `<div style="font-weight:700;">${dealer.name}</div>` : ''}
        ${dealer.phone ? `<div>📞 ${dealer.phone}</div>` : ''}
        ${dealer.website_url ? `<div>🌐 ${dealer.website_url}</div>` : ''}
        ${dealer.address ? `<div>📍 ${dealer.address}${dealer.city ? ', ' + dealer.city : ''}${dealer.province ? ', ' + dealer.province : ''}</div>` : ''}
        ${branding.tagline ? `<div style="margin-top:8px;font-style:italic;color:#6b7280;">"${branding.tagline}"</div>` : ''}
      </div>
    </div>
  </div>
</div>

<div class="footer">
  <span>Stock #: <strong>${vehicle.stocknumber || '—'}</strong></span>
  <span>${dealer.name || ''}</span>
  <span>Generated ${new Date().toLocaleDateString('en-CA')}</span>
</div>
</body>
</html>`
}

function buildBrochureHtml(vehicle, dealer, branding, recalls) {
  const primary = branding.primary_color || '#1a2e4a'
  const secondary = branding.secondary_color || '#c8a84b'
  const logoHtml = branding.logo_url
    ? `<img src="${branding.logo_url}" alt="Dealer Logo" style="max-height:60px;max-width:200px;object-fit:contain;">`
    : `<span style="font-size:20px;font-weight:800;color:#fff;">${dealer.name || 'Your Dealership'}</span>`

  const price = vehicle.price ? `$${Number(vehicle.price).toLocaleString()}` : 'Contact for Price'
  const mileage = vehicle.mileage ? `${Number(vehicle.mileage).toLocaleString()} km` : '—'
  const features = buildFeatureList(vehicle)
  const photos = (vehicle.image_urls || []).slice(0, 4)

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: Arial, Helvetica, sans-serif; width: 816px; background: #fff; color: #1a1a1a; }

  /* PAGE 1 */
  .page { width: 816px; min-height: 1056px; position: relative; overflow: hidden; page-break-after: always; }

  /* Hero */
  .hero { position: relative; height: 420px; background: ${primary}; overflow: hidden; }
  .hero-img { width: 100%; height: 100%; object-fit: cover; opacity: 0.85; }
  .hero-overlay { position: absolute; inset: 0; background: linear-gradient(to bottom, rgba(0,0,0,0.1) 0%, rgba(0,0,0,0.65) 100%); }
  .hero-content { position: absolute; bottom: 0; left: 0; right: 0; padding: 24px 32px; color: #fff; }
  .hero-tagline { font-size: 12px; letter-spacing: 3px; text-transform: uppercase; color: ${secondary}; margin-bottom: 6px; }
  .hero-name { font-size: 32px; font-weight: 900; line-height: 1.1; }
  .hero-sub { font-size: 16px; opacity: 0.85; margin-top: 4px; }

  /* Header strip */
  .header-strip { background: ${secondary}; display: flex; align-items: center; justify-content: space-between; padding: 10px 32px; }
  .header-strip .price { font-size: 22px; font-weight: 900; color: #fff; }
  .header-strip .mileage { font-size: 14px; color: rgba(255,255,255,0.9); font-weight: 600; }

  /* Specs row */
  .specs-row { display: flex; gap: 0; border-bottom: 1px solid #e5e7eb; }
  .spec-item { flex: 1; padding: 12px 16px; border-right: 1px solid #e5e7eb; text-align: center; }
  .spec-item:last-child { border-right: none; }
  .spec-label { font-size: 9px; color: #9ca3af; text-transform: uppercase; letter-spacing: 0.5px; }
  .spec-value { font-size: 13px; font-weight: 700; color: #111; margin-top: 3px; }

  /* Gallery */
  .gallery { display: grid; grid-template-columns: 1fr 1fr; gap: 4px; padding: 16px 24px; }
  .gallery img { width: 100%; aspect-ratio: 16/9; object-fit: cover; border-radius: 6px; }
  .gallery-placeholder { width: 100%; aspect-ratio: 16/9; background: #f3f4f6; border-radius: 6px; display: flex; align-items: center; justify-content: center; color: #9ca3af; font-size: 12px; }

  /* PAGE 2 */
  .page2-header { background: ${primary}; padding: 16px 32px; display: flex; align-items: center; justify-content: space-between; }
  .page2-header-title { color: #fff; font-size: 16px; font-weight: 700; }
  .content-grid { display: flex; gap: 0; }
  .content-left { flex: 1; padding: 24px 28px; border-right: 2px solid #e5e7eb; }
  .content-right { width: 260px; padding: 24px 20px; }
  .section-title { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 1px; color: ${primary}; border-bottom: 2px solid ${secondary}; padding-bottom: 4px; margin-bottom: 12px; margin-top: 20px; }
  .section-title:first-child { margin-top: 0; }
  .feature-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 4px; }
  .feature-item { font-size: 11px; padding: 4px 0; color: #374151; display: flex; align-items: flex-start; gap: 5px; }
  .feature-item::before { content: "✓"; color: ${secondary}; font-weight: 700; flex-shrink: 0; }
  .description { font-size: 12px; line-height: 1.7; color: #374151; }
  .price-card { background: ${primary}; color: #fff; border-radius: 10px; padding: 20px; text-align: center; margin-bottom: 16px; }
  .price-card-label { font-size: 10px; letter-spacing: 1.5px; text-transform: uppercase; opacity: 0.7; }
  .price-card-value { font-size: 30px; font-weight: 900; margin-top: 4px; }
  .contact-block { background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; padding: 14px; font-size: 12px; line-height: 2; }
  .contact-block .name { font-size: 14px; font-weight: 800; color: ${primary}; }
  .recall-warn { background: #fef2f2; border: 1px solid #fecaca; border-radius: 8px; padding: 10px 12px; font-size: 11px; margin-bottom: 12px; }
  .recall-warn-title { font-weight: 700; color: #dc2626; margin-bottom: 4px; }
  .recall-ok { background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 8px; padding: 10px 12px; font-size: 11px; margin-bottom: 12px; color: #15803d; font-weight: 700; }
  .footer { background: ${primary}; color: rgba(255,255,255,0.8); padding: 10px 32px; display: flex; justify-content: space-between; font-size: 10px; }
</style>
</head>
<body>

<!-- PAGE 1 -->
<div class="page">
  <div class="hero">
    ${photos[0]
      ? `<img class="hero-img" src="${photos[0]}" alt="Vehicle">`
      : `<div style="width:100%;height:100%;background:linear-gradient(135deg,${primary},${secondary});"></div>`}
    <div class="hero-overlay"></div>
    <div class="hero-content">
      ${branding.tagline ? `<div class="hero-tagline">${branding.tagline}</div>` : ''}
      <div class="hero-name">${vehicle.year} ${vehicle.make} ${vehicle.model}</div>
      <div class="hero-sub">${vehicle.trim || ''} ${vehicle.condition ? '· ' + vehicle.condition.charAt(0).toUpperCase() + vehicle.condition.slice(1) : ''}</div>
    </div>
  </div>

  <div class="header-strip">
    ${logoHtml}
    <div style="text-align:center;">
      <div class="price">${price}</div>
      ${vehicle.mileage ? `<div class="mileage">${mileage}</div>` : ''}
    </div>
    <div style="color:#fff;font-size:12px;text-align:right;">
      ${dealer.phone ? `<div>📞 ${dealer.phone}</div>` : ''}
      ${dealer.website_url ? `<div>🌐 ${dealer.website_url}</div>` : ''}
    </div>
  </div>

  <div class="specs-row">
    ${[
      ['Year', vehicle.year],
      ['Drivetrain', vehicle.drivetrain || '—'],
      ['Fuel Type', vehicle.fuel_type || vehicle.fueltype || '—'],
      ['Trans.', vehicle.transmission || '—'],
      ['Colour', vehicle.exterior_color || '—'],
      ['Stock #', vehicle.stocknumber || '—'],
    ].map(([label, value]) => `
      <div class="spec-item">
        <div class="spec-label">${label}</div>
        <div class="spec-value">${value}</div>
      </div>`).join('')}
  </div>

  <div class="gallery">
    ${[0, 1, 2, 3].map(i => photos[i]
      ? `<img src="${photos[i]}" alt="Photo ${i + 1}">`
      : `<div class="gallery-placeholder">Photo ${i + 1}</div>`
    ).join('')}
  </div>
</div>

<!-- PAGE 2 -->
<div class="page">
  <div class="page2-header">
    ${logoHtml}
    <div class="page2-header-title">${vehicle.year} ${vehicle.make} ${vehicle.model}${vehicle.trim ? ' ' + vehicle.trim : ''}</div>
  </div>

  <div class="content-grid">
    <div class="content-left">
      ${vehicle.description ? `
        <div class="section-title">About This Vehicle</div>
        <div class="description">${vehicle.description.slice(0, 600)}${vehicle.description.length > 600 ? '…' : ''}</div>
      ` : ''}

      <div class="section-title">Features & Equipment</div>
      <div class="feature-grid">
        ${features.map(f => `<div class="feature-item">${f}</div>`).join('')}
      </div>

      <div class="section-title">Full Specifications</div>
      <div class="feature-grid">
        ${[
          ['Engine', vehicle.engine || vehicle.engine_displacement || null],
          ['Cylinders', vehicle.cylinders || null],
          ['Displacement', vehicle.displacement || null],
          ['Body Style', vehicle.body_style || vehicle.bodystyle || null],
          ['Doors', vehicle.doors || null],
          ['Seats', vehicle.seats || null],
          ['GVWR', vehicle.gvwr || null],
          ['Plant City', vehicle.plant_city || null],
        ].filter(([, v]) => v).map(([label, value]) => `
          <div class="feature-item" style="flex-direction:column;gap:0;">
            <span style="font-size:9px;color:#9ca3af;text-transform:uppercase;">${label}</span>
            <span style="font-size:12px;font-weight:700;">${value}</span>
          </div>`).join('')}
      </div>
    </div>

    <div class="content-right">
      <div class="price-card">
        <div class="price-card-label">Asking Price</div>
        <div class="price-card-value">${price}</div>
        ${vehicle.mileage ? `<div style="opacity:0.75;font-size:12px;margin-top:4px;">${mileage}</div>` : ''}
      </div>

      ${recalls?.length
        ? `<div class="recall-warn">
            <div class="recall-warn-title">⚠ ${recalls.length} Open Recall${recalls.length > 1 ? 's' : ''}</div>
            <div>See dealer for recall information and remedies.</div>
          </div>`
        : `<div class="recall-ok">✓ No Open Recalls on Record</div>`}

      <div class="section-title">Contact Us</div>
      <div class="contact-block">
        ${dealer.name ? `<div class="name">${dealer.name}</div>` : ''}
        ${dealer.address ? `<div>📍 ${dealer.address}</div>` : ''}
        ${dealer.city ? `<div>${dealer.city}${dealer.province ? ', ' + dealer.province : ''}${dealer.postal_code ? ' ' + dealer.postal_code : ''}</div>` : ''}
        ${dealer.phone ? `<div>📞 ${dealer.phone}</div>` : ''}
        ${dealer.website_url ? `<div>🌐 ${dealer.website_url}</div>` : ''}
        ${branding.tagline ? `<div style="margin-top:8px;font-style:italic;color:#6b7280;">"${branding.tagline}"</div>` : ''}
      </div>

      <div class="section-title" style="margin-top:16px;">VIN</div>
      <div style="font-family:monospace;font-size:11px;word-break:break-all;background:#f9fafb;border:1px solid #e5e7eb;border-radius:6px;padding:8px;letter-spacing:1px;">${vehicle.vin || 'Not Available'}</div>
    </div>
  </div>

  <div class="footer">
    <span>${dealer.name || ''} · Stock #${vehicle.stocknumber || '—'}</span>
    <span>VIN: ${vehicle.vin || '—'}</span>
    <span>Generated ${new Date().toLocaleDateString('en-CA')}</span>
  </div>
</div>

</body>
</html>`
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
    // Only update columns that exist in the inventory table
    if (decoded.year) update.year = decoded.year
    if (decoded.make) update.make = decoded.make
    if (decoded.model) update.model = decoded.model
    if (decoded.trim) update.trim = decoded.trim
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
      const html = buildWindowStickerHtml(vehicle, dealer, dealer.branding || {}, vehicle.recalls || [])
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
      const html = buildBrochureHtml(vehicle, dealer, dealer.branding || {}, vehicle.recalls || [])
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
