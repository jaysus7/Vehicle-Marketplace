/**
 * Outbound syndication — publishes each dealer's live inventory as a standardized
 * feed that classifieds ingest (AutoTrader / Trader.ca / Kijiji Autos / Google
 * vehicle listings). Most platforms onboard a dealer by pulling a feed URL on a
 * schedule, so this needs no partner API keys: the dealer copies their feed URL
 * into the platform's dealer portal (or hands it to their account rep).
 *
 * Feeds are public (the inventory is already public on the dealer's site) and only
 * serve when the site is published. CSV for spreadsheet/most aggregators; XML for
 * platforms that want a structured feed.
 */
import { supabaseAdmin, CANONICAL_FRONTEND } from '../shared.js'
import { requireAuth } from '../middleware.js'

const API_BASE = (process.env.PUBLIC_API_URL || process.env.API_URL || '').replace(/\/+$/, '')
const isMgr = (req) => ['DEALER_ADMIN', 'OWNER', 'MANAGER'].includes(req.profile?.role)
const currencyFor = (country) => /(^ca$|canada)/i.test(String(country || '')) ? 'CAD' : 'USD'

// The dealer's public site base — custom domain if set, else marketsync.link/<slug>.
function siteBaseFor(d) {
  if (d.custom_domain) return `https://${String(d.custom_domain).replace(/^https?:\/\//, '').replace(/\/.*$/, '')}`
  return `${CANONICAL_FRONTEND}/${d.site_slug}`
}
// Absolute base for the feed URLs themselves (so the dashboard can show/copy them).
function feedBase(req) {
  if (API_BASE) return API_BASE
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0]
  return `${proto}://${req.get('host')}`
}

const SYND_COLS = 'id, year, make, model, trim, price, mileage, condition, exterior_color, interior_color, drivetrain, fuel_type, transmission, engine, body_style, doors, stocknumber, vin, image_urls, description, carfax_url, status, archived_at, awaiting_possession'

async function loadDealerBySlug(slug) {
  const { data } = await supabaseAdmin.from('dealerships')
    .select('id, name, site_slug, site_published, custom_domain, city, province, postal_code, country, branding')
    .ilike('site_slug', String(slug || '').toLowerCase().trim()).maybeSingle()
  return data || null
}
async function loadVehicles(dealershipId) {
  const { data } = await supabaseAdmin.from('inventory').select(SYND_COLS)
    .eq('dealership_id', dealershipId).is('archived_at', null).neq('status', 'sold')
    .or('awaiting_possession.is.null,awaiting_possession.eq.false')
    .order('created_at', { ascending: false }).limit(1000)
  return data || []
}

// One normalized listing row shared by both CSV and XML renderers.
function toListing(v, d, base, currency) {
  const imgs = Array.isArray(v.image_urls) ? v.image_urls.filter(Boolean) : []
  const condition = /new/i.test(v.condition || '') ? 'New' : 'Used'
  return {
    id: v.vin || v.stocknumber || v.id,
    vin: v.vin || '',
    stock_number: v.stocknumber || '',
    year: v.year || '',
    make: v.make || '',
    model: v.model || '',
    trim: v.trim || '',
    price: v.price != null ? Math.round(Number(v.price)) : '',
    currency,
    mileage: v.mileage != null ? Math.round(Number(v.mileage)) : '',
    condition,
    body_type: v.body_style || '',
    drivetrain: v.drivetrain || '',
    fuel_type: v.fuel_type || '',
    transmission: v.transmission || '',
    engine: v.engine || '',
    exterior_color: v.exterior_color || '',
    interior_color: v.interior_color || '',
    doors: v.doors || '',
    description: (v.description || '').replace(/\s+/g, ' ').trim().slice(0, 5000),
    image_url: imgs[0] || '',
    additional_image_urls: imgs.slice(1, 20).join('|'),
    vehicle_url: `${base}#inventory`,
    carfax_url: v.carfax_url || '',
    dealer_name: d.name || '',
    city: d.city || '',
    province: d.province || '',
    postal_code: d.postal_code || '',
  }
}
const CSV_FIELDS = ['id', 'vin', 'stock_number', 'year', 'make', 'model', 'trim', 'price', 'currency', 'mileage', 'condition', 'body_type', 'drivetrain', 'fuel_type', 'transmission', 'engine', 'exterior_color', 'interior_color', 'doors', 'description', 'image_url', 'additional_image_urls', 'vehicle_url', 'carfax_url', 'dealer_name', 'city', 'province', 'postal_code']
const csvCell = (v) => { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s }
const xmlEsc = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export function registerSyndication(app) {
  // ── PUBLIC: CSV feed (spreadsheet + most aggregators). ───────────────────────
  app.get('/syndication/:slug/inventory.csv', async (req, res) => {
    const d = await loadDealerBySlug(req.params.slug)
    if (!d || !d.site_published) return res.status(404).type('text/plain').send('Feed not available')
    const currency = currencyFor(d.country)
    const base = siteBaseFor(d)
    const rows = (await loadVehicles(d.id)).map(v => toListing(v, d, base, currency))
    const lines = [CSV_FIELDS.join(',')]
    for (const r of rows) lines.push(CSV_FIELDS.map(f => csvCell(r[f])).join(','))
    res.set('Content-Type', 'text/csv; charset=utf-8')
    res.set('Cache-Control', 'public, max-age=1800')   // 30-min cache; platforms poll infrequently
    res.set('Content-Disposition', `inline; filename="${d.site_slug}-inventory.csv"`)
    res.send(lines.join('\n'))
  })

  // ── PUBLIC: XML feed (platforms that want a structured pull). ────────────────
  app.get('/syndication/:slug/inventory.xml', async (req, res) => {
    const d = await loadDealerBySlug(req.params.slug)
    if (!d || !d.site_published) return res.status(404).type('text/plain').send('Feed not available')
    const currency = currencyFor(d.country)
    const base = siteBaseFor(d)
    const rows = (await loadVehicles(d.id)).map(v => toListing(v, d, base, currency))
    const body = rows.map(r => {
      const fields = CSV_FIELDS.filter(f => f !== 'additional_image_urls').map(f => `      <${f}>${xmlEsc(r[f])}</${f}>`).join('\n')
      const imgs = String(r.additional_image_urls || '').split('|').filter(Boolean)
      const imgXml = [r.image_url, ...imgs].filter(Boolean).map(u => `      <image>${xmlEsc(u)}</image>`).join('\n')
      return `    <vehicle>\n${fields}\n${imgXml}\n    </vehicle>`
    }).join('\n')
    res.set('Content-Type', 'application/xml; charset=utf-8')
    res.set('Cache-Control', 'public, max-age=1800')
    res.send(`<?xml version="1.0" encoding="UTF-8"?>\n<listings dealer="${xmlEsc(d.name)}" generated="${new Date().toISOString()}" count="${rows.length}">\n${body}\n</listings>`)
  })

  // ── ADMIN: the dealer's feed URLs + a live count, for the Syndication card. ──
  app.get('/syndication/config', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership' })
    if (!isMgr(req)) return res.status(403).json({ error: 'Manager access required' })
    const { data: d } = await supabaseAdmin.from('dealerships')
      .select('site_slug, site_published, country').eq('id', req.dealershipId).maybeSingle()
    if (!d?.site_slug || !d.site_published) {
      return res.json({ ready: false, reason: d?.site_slug ? 'Publish your website to turn the feed on.' : 'Set up your website address first (Website settings).' })
    }
    const { count } = await supabaseAdmin.from('inventory').select('id', { count: 'exact', head: true })
      .eq('dealership_id', req.dealershipId).is('archived_at', null).neq('status', 'sold')
      .or('awaiting_possession.is.null,awaiting_possession.eq.false')
    const b = feedBase(req)
    res.json({
      ready: true,
      vehicle_count: count || 0,
      currency: currencyFor(d.country),
      csv_url: `${b}/syndication/${d.site_slug}/inventory.csv`,
      xml_url: `${b}/syndication/${d.site_slug}/inventory.xml`,
    })
  })
}
