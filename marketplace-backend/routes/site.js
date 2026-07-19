import dns from 'node:dns/promises'
import Anthropic from '@anthropic-ai/sdk'
import { supabaseAdmin, resend, EMAIL_FROM } from '../shared.js'
import { requireAuth } from '../middleware.js'
import { findOrCreateContact } from './crm.js'
import { enqueueForTrigger } from './automation.js'
import { routeAndNotifyLead } from '../lead-routing.js'
import { createNotification } from '../notifications.js'
import { aiAllowed, recordUsage } from '../usage.js'
import { rateLimit, getClientIp } from '../security.js'
import { depositConfigForSite } from './deposits.js'

const SITE_ADMINS = ['DEALER_ADMIN', 'OWNER', 'MANAGER']
const isSiteAdmin = (req) => SITE_ADMINS.includes(req.profile?.role)
const slugOk = (s) => /^[a-z0-9]([a-z0-9-]{1,38})[a-z0-9]$/.test(s)   // 3–40, no leading/trailing dash
// The host a dealer points their custom domain's CNAME at (the static-site domain,
// or the Cloudflare-for-SaaS CNAME target once that's set up).
const SITE_HOST = (process.env.SITE_DOMAIN_TARGET || 'marketsync.link').replace(/^https?:\/\//, '').replace(/\/.*$/, '')
const domainOk = (s) => /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/.test(s)   // basic FQDN

// ── Cloudflare for SaaS (Custom Hostnames) — auto-provisions a TLS cert per domain.
// Inert until CF_API_TOKEN + CF_ZONE_ID are set on the backend; falls back to a
// plain DNS check when not configured.
const CF_ENABLED = !!(process.env.CF_API_TOKEN && process.env.CF_ZONE_ID)
async function cfApi(path, method = 'GET', body) {
  const r = await fetch(`https://api.cloudflare.com/client/v4/zones/${process.env.CF_ZONE_ID}${path}`, {
    method, headers: { Authorization: `Bearer ${process.env.CF_API_TOKEN}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  const j = await r.json().catch(() => ({}))
  return { ok: r.ok && j.success !== false, result: j.result, errors: j.errors }
}
// Register a custom hostname (idempotent-ish) → returns the CF hostname id.
async function cfCreateHostname(domain) {
  const { ok, result } = await cfApi('/custom_hostnames', 'POST', { hostname: domain, ssl: { method: 'http', type: 'dv', settings: { min_tls_version: '1.2' } } })
  return ok ? (result?.id || null) : null
}
async function cfDeleteHostname(id) { if (id) { try { await cfApi(`/custom_hostnames/${id}`, 'DELETE') } catch {} } }
async function cfHostnameActive(id) {
  if (!id) return false
  const { ok, result } = await cfApi(`/custom_hostnames/${id}`)
  return ok && result?.status === 'active' && (result?.ssl?.status === 'active')
}

// Only expose safe, public-facing vehicle fields (no internal/source data).
// Derive a vehicle's public market status from the inventory flag + the pipeline
// stage of any lead attached to it. Delivered (or manually sold) → off the lot;
// a live deal (sold/fni/turnover, not yet delivered) → sale pending; demo units →
// demo; everything else → in stock.
function marketStatus(v, contactStage) {
  const s = String(v.status || '').toLowerCase()
  const stage = String(contactStage || '').toLowerCase()
  if (s === 'sold' || stage === 'delivered') return 'delivered'
  if (s === 'pending' || stage === 'sold' || stage === 'fni' || stage === 'turnover') return 'pending'
  if (String(v.condition || '').toLowerCase() === 'demo') return 'demo'
  return 'available'
}
function publicVehicle(v) {
  // Only surface docs that already exist — factory (oem) or a sticker/brochure the
  // dealer generated (gen). The public site never generates or decodes anything.
  const recallCount = Array.isArray(v.recalls) ? v.recalls.length : 0
  return {
    id: v.id, year: v.year, make: v.make, model: v.model, trim: v.trim,
    price: v.price, mileage: v.mileage, condition: v.condition,
    exterior_color: v.exterior_color, interior_color: v.interior_color,
    drivetrain: v.drivetrain, fuel_type: v.fuel_type, transmission: v.transmission,
    engine: v.engine, body_style: v.body_style, doors: v.doors,
    stocknumber: v.stocknumber, vin: v.vin,
    image_urls: Array.isArray(v.image_urls) ? v.image_urls : [],
    // Prefer the AI sales pitch when present, else the plain feed description.
    description: v.sales_pitch || v.description || null,
    specs_manual: v.specs_manual && typeof v.specs_manual === 'object' ? v.specs_manual : null,
    carfax_url: v.carfax_url || null,
    window_sticker_url: v.window_sticker_oem_url || v.window_sticker_gen_url || v.window_sticker_url || null,
    brochure_url: v.brochure_oem_url || v.brochure_gen_url || v.brochure_url || null,
    recall_count: recallCount,
    market_status: v._market_status || marketStatus(v),
    // Deep spec sheet (NHTSA decode) for the brochure-style detail layout.
    vin_data: v.vin_data && typeof v.vin_data === 'object' ? v.vin_data : null,
  }
}
function publicRep(p) {
  return {
    name: p.display_name || p.full_name || null,
    title: ({ OWNER: 'Owner', DEALER_ADMIN: 'General Manager', MANAGER: 'Sales Manager', SALES_REP: 'Sales' }[p.role] || 'Sales'),
    // Department header on the public Team page — merges cleanly with dealer-added staff.
    department: ({ OWNER: 'Management', DEALER_ADMIN: 'Management', MANAGER: 'Management', SALES_REP: 'Sales' }[p.role] || 'Sales'),
    photo: p.avatar_url || null,
    phone: p.phone || null,
    bio: p.bio || null,
  }
}

const slugify = (s) => String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)

// Custom pages the dealer adds (About, Financing info, etc.) — title + HTML body.
function cleanPages(arr) {
  if (!Array.isArray(arr)) return []
  const seen = new Set()
  return arr.slice(0, 20).map(p => {
    const title = String(p.title || '').trim().slice(0, 80)
    let slug = slugify(p.slug || title)
    while (slug && seen.has(slug)) slug += '-1'
    seen.add(slug)
    const kind = ['content', 'model', 'incentive'].includes(p.kind) ? p.kind : 'content'
    return {
      // Stable id so the menu-order list can reference a page across saves.
      id: p.id ? String(p.id).slice(0, 40) : ('pg' + Math.random().toString(36).slice(2, 9)),
      slug, title, body_html: String(p.body_html || '').slice(0, 40000), nav: p.nav !== false, kind,
      // Optional dropdown group in the top nav (e.g. "New Vehicles", "Offers").
      menu: p.menu ? String(p.menu).slice(0, 40) : null,
      make: p.make ? String(p.make).slice(0, 40) : null,
      model: p.model ? String(p.model).slice(0, 60) : null,
      // Per-page brand accent (hex) + nav icon (emoji/short glyph) — #28.
      accent: /^#[0-9a-fA-F]{6}$/.test(String(p.accent || '')) ? String(p.accent) : null,
      icon: p.icon ? String(p.icon).slice(0, 8) : null,
      // Per-page SEO: unique title, meta description and focus keyword. Blank = the
      // public site derives them from the page's own content at render time.
      seo_title: p.seo_title ? String(p.seo_title).slice(0, 120) : null,
      seo_description: p.seo_description ? String(p.seo_description).slice(0, 320) : null,
      seo_keyword: p.seo_keyword ? String(p.seo_keyword).slice(0, 80) : null,
      // Full section builder per page (hero, CTAs, inventory…) — same as the home page.
      sections: Array.isArray(p.sections) ? cleanSections(p.sections) : [],
    }
  }).filter(p => p.title && p.slug)
}

// Explicit nav ordering: an array of tokens ("b:inventory", "p:<pageId>").
function cleanMenuOrder(arr) {
  if (!Array.isArray(arr)) return []
  const seen = new Set(), out = []
  for (const t of arr) { const s = String(t || '').trim().slice(0, 60); if (s && /^[bp]:/.test(s) && !seen.has(s)) { seen.add(s); out.push(s) } }
  return out.slice(0, 60)
}

// The franchise brands a dealer sells new (drives the Build & Price make list).
function cleanMakes(arr) {
  if (!Array.isArray(arr)) return []
  const seen = new Set(), out = []
  for (const m of arr) { const s = String(m || '').trim().slice(0, 40); const k = s.toLowerCase(); if (s && !seen.has(k)) { seen.add(k); out.push(s) } }
  return out.slice(0, 20)
}
// Built-in pages that ship with every site (Inventory, Build & Price, Value Trade,
// Financing, Team, Contact). The dealer can rename or switch each off from the page
// builder; unset = on, so existing dealers keep them all.
const BUILTIN_KEYS = ['inventory', 'build', 'trade', 'finance', 'team', 'contact']
const BUILTIN_DEFAULTS = { inventory: 'Inventory', build: 'Build & Price', trade: 'Value Trade', finance: 'Financing', team: 'Team', contact: 'Contact' }
function cleanBuiltins(obj) {
  const src = (obj && typeof obj === 'object') ? obj : {}
  const out = {}
  for (const k of BUILTIN_KEYS) {
    const v = (src[k] && typeof src[k] === 'object') ? src[k] : {}
    out[k] = {
      enabled: v.enabled !== false,   // default ON
      label: (v.label ? String(v.label).trim().slice(0, 40) : '') || BUILTIN_DEFAULTS[k],
      // Optional dropdown group in the nav (e.g. put Value Trade + Financing under "Finance").
      menu: v.menu ? String(v.menu).trim().slice(0, 40) : null,
      // Dealer-defined intro sections (hero/SEO) rendered above the built-in's functional content.
      sections: Array.isArray(v.sections) ? cleanSections(v.sections) : [],
    }
  }
  return out
}

// Dealer staff shown on the Team page, grouped by department with a job label.
const STAFF_DEPTS = ['Management', 'Sales', 'Finance', 'Service', 'Parts', 'Admin', 'Reception', 'Other']
function cleanStaff(arr) {
  if (!Array.isArray(arr)) return []
  return arr.slice(0, 80).map(m => ({
    name: String(m.name || '').trim().slice(0, 80),
    title: String(m.title || '').trim().slice(0, 60) || null,
    department: STAFF_DEPTS.includes(m.department) ? m.department : 'Sales',
    photo: m.photo ? String(m.photo).slice(0, 500) : null,
    phone: String(m.phone || '').trim().slice(0, 40) || null,
    email: String(m.email || '').trim().slice(0, 160) || null,
  })).filter(m => m.name)
}

// The section palette for the page builder. Each is dealership-aware on render.
const SECTION_TYPES = ['hero', 'feature_cards', 'featured_inventory', 'inventory_grid', 'text_image', 'body_style', 'payment_calc', 'ad_banner', 'finance_cta', 'trade_cta', 'service_cta', 'staff', 'reviews', 'faq', 'cta_banner', 'gallery', 'map', 'contact', 'html']
function cleanSections(arr) {
  if (!Array.isArray(arr)) return []
  return arr.slice(0, 40).map((s, i) => {
    let settings = (s.settings && typeof s.settings === 'object') ? s.settings : {}
    try { if (JSON.stringify(settings).length > 12000) settings = {} } catch { settings = {} }
    return {
      id: String(s.id || `s${i}_${Math.random().toString(36).slice(2, 7)}`),
      type: SECTION_TYPES.includes(s.type) ? s.type : 'html',
      settings,
    }
  })
}
const TYPOGRAPHY = ['modern', 'luxury', 'bold', 'corporate', 'minimal']

// Placed widgets: where they can go and their shape.
const WIDGET_SLOTS = ['top_banner', 'hero_below', 'above_inventory', 'below_inventory', 'above_footer']
function cleanWidgets(arr) {
  if (!Array.isArray(arr)) return []
  return arr.slice(0, 40).map((w, i) => ({
    id: String(w.id || `w${i}_${Math.random().toString(36).slice(2, 7)}`),
    slot: WIDGET_SLOTS.includes(w.slot) ? w.slot : 'below_inventory',
    title: (w.title == null ? '' : String(w.title)).slice(0, 120) || null,
    html: (w.html == null ? '' : String(w.html)).slice(0, 20000),
    height: Math.min(2000, Math.max(60, parseInt(w.height) || 400)),
  })).filter(w => w.html.trim())
}

// The site's content bundle from the dealership's branding jsonb.
function siteContent(d) {
  const b = d.branding || {}
  return {
    name: d.name,
    slug: d.site_slug || null,
    custom_domain: d.custom_domain || null,
    logo_url: b.logo_url || null,
    primary_color: b.primary_color || '#1e3a8a',
    secondary_color: b.secondary_color || '#0f172a',
    tagline: b.tagline || null,
    hero_url: b.hero_url || null,
    about: b.about || null,
    hours: b.hours || null,
    phone: b.phone || null,
    email: b.email || null,
    address: b.address || null,
    city: d.city || null, province: d.province || null, postal_code: d.postal_code || null,
    website_url: d.website_url || null,
    photo_background_url: d.photo_background_url || null,
    facebook_url: b.facebook_url || null,
    instagram_url: b.instagram_url || null,
    // SEO: page title, meta description, keywords, and social-share (OG) image.
    seo_title: b.seo_title || null,
    seo_description: b.seo_description || null,
    seo_keywords: b.seo_keywords || null,
    seo_image: b.seo_image || null,
    // Dealer-controlled custom code: global vendor scripts injected into <head>
    // (analytics, chat, Keyloop tags) + placed embed widgets rendered in slots.
    head_html: b.site_head_html || null,
    widgets: cleanWidgets(b.site_widgets),
    pages: cleanPages(b.site_pages),
    // Dealer-managed staff for the Team page (managers, sales, service, admin…).
    staff: cleanStaff(b.site_team),
    // Franchise brands sold new — the Build & Price make list (empty = auto-detect).
    build_makes: cleanMakes(b.build_makes),
    // Built-in page on/off + custom nav labels.
    builtins: cleanBuiltins(b.site_builtins),
    // Explicit nav order across built-ins + custom pages.
    menu_order: Array.isArray(b.site_menu_order) ? b.site_menu_order : [],
    // Page builder: ordered sections + global styling.
    sections: cleanSections(b.site_sections),
    typography: TYPOGRAPHY.includes(b.typography) ? b.typography : 'modern',
    // Optional dealer-chosen Google Fonts (override the typography preset).
    heading_font: b.heading_font || null,
    body_font: b.body_font || null,
    // When on, heroes use real inventory photos instead of the generated gradient art.
    hero_photos: !!b.hero_photos,
    accent_color: b.accent_color || null,
    // AI sales concierge chat bubble on the public site (dealer opt-in).
    sales_chat: !!b.site_sales_chat,
    // AI concierge tuning: dealer knowledge base, custom instructions, disclaimer.
    chat_kb: b.site_chat_kb || null,
    chat_instructions: b.site_chat_instructions || null,
    chat_disclaimer: b.site_chat_disclaimer || null,
  }
}

const SITE_COLS = 'id, name, branding, site_published, site_slug, custom_domain, city, province, postal_code, website_url, photo_background_url'
async function buildSiteResponse(d) {
  const [{ data: inv }, { data: team }, { data: interests }] = await Promise.all([
    supabaseAdmin.from('inventory')
      .select('id, year, make, model, trim, price, mileage, condition, exterior_color, interior_color, drivetrain, fuel_type, transmission, engine, body_style, doors, stocknumber, vin, image_urls, description, carfax_url, window_sticker_url, window_sticker_oem_url, window_sticker_gen_url, brochure_url, brochure_oem_url, brochure_gen_url, recalls, vin_data, sales_pitch, specs_manual, status, created_at')
      .eq('dealership_id', d.id).is('archived_at', null).neq('status', 'sold')
      .or('awaiting_possession.is.null,awaiting_possession.eq.false')   // hide acquired trades until possession (#16)
      .order('created_at', { ascending: false }).limit(600),
    supabaseAdmin.from('profiles')
      .select('full_name, display_name, avatar_url, phone, role, hide_on_site, bio')
      .eq('dealership_id', d.id),
    // Pipeline stage of any contact tied to a vehicle → drives the vehicle's status.
    supabaseAdmin.from('contacts')
      .select('interest_inventory_id, status')
      .eq('dealership_id', d.id).not('interest_inventory_id', 'is', null),
  ])
  const stageByVeh = {}
  const RANK = { delivered: 4, sold: 3, fni: 3, turnover: 3 }
  for (const c of (interests || [])) {
    const s = String(c.status || '').toLowerCase(); const r = RANK[s]; if (!r) continue
    const cur = stageByVeh[c.interest_inventory_id]
    if (!cur || r > cur.r) stageByVeh[c.interest_inventory_id] = { s, r }
  }
  const vehicles = (inv || [])
    .map(v => ({ ...v, _market_status: marketStatus(v, stageByVeh[v.id]?.s) }))
    .filter(v => v._market_status !== 'delivered')
    .map(publicVehicle)
  const roster = (team || []).filter(p => !p.hide_on_site && (p.display_name || p.full_name)).map(publicRep)
  const deposits = await depositConfigForSite(d.id).catch(() => ({ enabled: false }))
  return { site: siteContent(d), vehicles, team: roster, count: vehicles.length, deposits }
}

export function registerSite(app) {
  // ── PUBLIC: a dealer's live site data by slug (no auth) ────────────────────
  app.get('/site/:slug', async (req, res) => {
    const slug = String(req.params.slug || '').toLowerCase().trim()
    if (!slug) return res.status(404).json({ error: 'Not found' })
    const { data: d } = await supabaseAdmin.from('dealerships').select(SITE_COLS).ilike('site_slug', slug).maybeSingle()
    if (!d || !d.site_published) return res.status(404).json({ error: 'Site not found' })
    res.json(await buildSiteResponse(d))
  })

  // ── PUBLIC: resolve a dealer's site by its custom domain (Host header) ──────
  app.get('/site-by-domain', async (req, res) => {
    const host = String(req.query.host || '').toLowerCase().trim().replace(/^www\./, '').replace(/:\d+$/, '')
    if (!host) return res.status(404).json({ error: 'Not found' })
    const { data: d } = await supabaseAdmin.from('dealerships').select(SITE_COLS)
      .or(`custom_domain.ilike.${host},custom_domain.ilike.www.${host}`).maybeSingle()
    if (!d || !d.site_published) return res.status(404).json({ error: 'Site not found' })
    res.json(await buildSiteResponse(d))
  })

  // ── Trade-in ballpark (zero-cost heuristic) ────────────────────────────────
  // A rough, dependency-free trade-in range so a rep has a number to quote back
  // FAST when a website trade lead lands — NOT a real appraisal. The one-click
  // MarketCheck appraisal (POST /ai/appraise) replaces it with live comps.
  // Never surfaced on the public site; used only in the rep's alert + CRM note.
  const LUX_MAKES = new Set(['bmw', 'mercedes', 'mercedes-benz', 'audi', 'lexus', 'acura', 'infiniti', 'cadillac', 'lincoln', 'porsche', 'land rover', 'range rover', 'jaguar', 'volvo', 'tesla', 'genesis', 'maserati', 'bentley'])
  const TRUCK_RE = /silverado|sierra|f-?150|f-?250|f-?350|\bram\b|ram\s?1500|tundra|titan|tahoe|suburban|yukon|expedition|sequoia|super\s?duty|colorado|canyon|ranger|tacoma|frontier/i
  const numish = (v) => { const n = Number(String(v ?? '').replace(/[^0-9.]/g, '')); return Number.isFinite(n) && n > 0 ? n : null }
  function heuristicTradeRange({ year, make, model, mileage }) {
    const now = new Date().getFullYear()
    const yr = numish(year)
    if (!yr || yr < 1990 || yr > now + 1) return null
    const age = Math.max(0, now - yr)
    const mk = String(make || '').toLowerCase().trim()
    const md = String(model || '')
    // Baseline original transaction price by segment.
    let base = 34000
    if (LUX_MAKES.has(mk)) base = 58000
    else if (TRUCK_RE.test(md) || TRUCK_RE.test(mk)) base = 52000
    // Depreciation: ~16% year one, ~11%/yr after, with a residual floor.
    let val = base
    for (let i = 0; i < age; i++) val *= (i === 0 ? 0.84 : 0.89)
    val = Math.max(val, base * 0.09)
    // Mileage vs an expected ~18k/yr; ~$0.06 per unit over/under, asymmetric + capped.
    const mi = numish(mileage)
    if (mi != null) {
      const expected = Math.max(age, 1) * 18000
      const delta = (expected - mi) * 0.06
      val = Math.max(base * 0.06, val + Math.max(-val * 0.35, Math.min(val * 0.25, delta)))
    }
    const lo = Math.round((val * 0.88) / 250) * 250
    const hi = Math.round((val * 1.12) / 250) * 250
    if (hi <= 0 || lo <= 0) return null
    return { low: lo, high: hi }
  }
  // Pull whatever the trade shell captured into a vehicle-ish shape (keys vary by form).
  function tradeVehicleFromFields(fields) {
    if (!fields || typeof fields !== 'object') return {}
    const pick = (...names) => {
      for (const [k, v] of Object.entries(fields)) {
        const key = k.toLowerCase().replace(/[^a-z]/g, '')
        if (names.includes(key) && v != null && String(v).trim()) return String(v).trim()
      }
      return null
    }
    return {
      year: pick('year', 'vehicleyear'),
      make: pick('make', 'vehiclemake'),
      model: pick('model', 'vehiclemodel'),
      trim: pick('trim', 'vehicletrim', 'series'),
      mileage: pick('mileage', 'kilometers', 'kilometres', 'km', 'miles', 'odometer'),
    }
  }

  // ── PUBLIC: capture a lead from the site → lands in the CRM ─────────────────
  app.post('/site/:slug/lead', async (req, res) => {
    const slug = String(req.params.slug || '').toLowerCase().trim()
    const { data: d } = await supabaseAdmin.from('dealerships')
      .select('id, site_published').ilike('site_slug', slug).maybeSingle()
    if (!d || !d.site_published) return res.status(404).json({ error: 'Site not found' })
    const b = req.body || {}
    const name = String(b.name || '').trim().slice(0, 120)
    const email = String(b.email || '').trim().slice(0, 160)
    const phone = String(b.phone || '').trim().slice(0, 40)
    const message = String(b.message || '').trim().slice(0, 2000)
    if (!name && !email && !phone) return res.status(400).json({ error: 'Enter a name, phone, or email' })

    // Which shell form: general Inquiry, Trade-In quote, or Credit Application.
    const FORMS = { trade: 'Trade-In', credit: 'Credit Application', inquiry: 'Website', build: 'Build & Price', chat: 'Website Chat', reserve: 'Reserve / Deposit', payment: 'Payment Quote' }
    const source = FORMS[String(b.form_type || '').toLowerCase()] || 'Website'
    // Fold any extra shell fields (trade vehicle, employment, etc.) into the comments.
    let comments = message
    if (b.fields && typeof b.fields === 'object') {
      const extra = Object.entries(b.fields)
        .filter(([, v]) => v != null && String(v).trim())
        .map(([k, v]) => `${k}: ${String(v).slice(0, 200)}`).join('\n').slice(0, 3000)
      if (extra) comments = [message, `— ${source} details —`, extra].filter(Boolean).join('\n')
    }

    let inventory_id = null
    if (b.vehicle_id) {
      const { data: v } = await supabaseAdmin.from('inventory').select('id, dealership_id').eq('id', b.vehicle_id).maybeSingle()
      if (v && v.dealership_id === d.id) inventory_id = v.id
    }
    try {
      const { data: lead } = await supabaseAdmin.from('leads').insert({
        dealership_id: d.id, name: name || null, email: email || null, phone: phone || null,
        comments: comments || null, source, inventory_id,
      }).select('id').single()
      const contactId = await findOrCreateContact({ dealershipId: d.id, name, email, phone, source: 'Website' })
      if (contactId && lead?.id) await supabaseAdmin.from('leads').update({ contact_id: contactId }).eq('id', lead.id)
      if (contactId) {
        // Auto-assign + notify, then kick off the speed-to-lead sequence with the routed rep.
        const routed = await routeAndNotifyLead(d.id, { contactId, vehicleId: inventory_id || null, name, source: source })
        enqueueForTrigger(d.id, 'internet_lead', { contactId, vehicleId: inventory_id || null, repId: routed?.assignee || null })

        // Trade-in leads: hand the rep an instant ballpark range so they have an
        // answer to quote back — internal only, never shown on the site. They can
        // one-click the full MarketCheck appraisal from the CRM for a firm number.
        if (String(b.form_type || '').toLowerCase() === 'trade') {
          const tv = tradeVehicleFromFields(b.fields)
          const range = heuristicTradeRange(tv)
          if (range) {
            const veh = [tv.year, tv.make, tv.model, tv.trim].filter(Boolean).join(' ').trim() || 'their trade'
            const fmt = (n) => '$' + Math.round(n).toLocaleString('en-US')
            const rangeStr = `${fmt(range.low)}–${fmt(range.high)}`
            // Timeline note on the contact (internal), so the range is in the CRM record.
            try {
              await supabaseAdmin.from('communications').insert({
                dealership_id: d.id, contact_id: contactId, channel: 'note', direction: 'internal',
                subject: 'Trade-in ballpark (auto)',
                body: `Rough trade range for ${veh}: ${rangeStr}. Estimate only — run the full appraisal for a firm number.`,
                meta: { kind: 'trade_ballpark', low: range.low, high: range.high, vehicle: tv },
              })
              await supabaseAdmin.from('contacts')
                .update({ last_activity_at: new Date().toISOString(), updated_at: new Date().toISOString() })
                .eq('id', contactId)
            } catch (err) { console.warn('[site] trade note failed:', err.message) }
            // Alert the assigned rep with the number front-and-centre.
            await createNotification({
              dealershipId: d.id, type: 'new_lead',
              title: `Trade lead${name ? ': ' + name : ''} — approx ${rangeStr}`,
              body: `${veh}. Ballpark only — open the contact and run the full appraisal for a firm offer.`,
              linkPage: 'crm', targetUserId: routed?.assignee || null,
            })
          }
        }

        // Digital-retailing credit application → seed a DRAFT in the F&I credit
        // pipeline (no SIN collected online — soft/pre-approval), with consent stamped.
        const formType = String(b.form_type || '').toLowerCase()
        if (formType === 'credit') {
          try {
            const f = b.fields || {}
            const parts = String(name || '').trim().split(/\s+/)
            const incomeM = parseFloat(String(f['Monthly income'] || '').replace(/[^0-9.]/g, '')) || null
            await supabaseAdmin.from('credit_applications').insert({
              dealership_id: d.id, contact_id: contactId, status: 'draft',
              applicant: {
                first: parts[0] || null, last: parts.slice(1).join(' ') || null, email: email || null, phone: phone || null,
                address: { street: f.Address || null },
                employment: { employer: f.Employer || null, occupation: f['Job title'] || null, income_monthly: incomeM },
              },
              vehicle: inventory_id ? { inventory_id } : (f['Vehicle of interest'] ? { note: f['Vehicle of interest'] } : {}),
              financing: f['Credit tier'] ? { credit_tier: f['Credit tier'] } : {},
              consent: !!b.consent, consent_at: b.consent ? new Date().toISOString() : null,
              consent_ip: b.consent ? getClientIp(req) : null, consent_method: b.consent ? 'e-sign' : null,
            })
          } catch (err) { console.warn('[site] credit draft failed:', err.message) }
        }

        // AI website chat → save the full transcript on the customer record so the
        // rep can read exactly what the concierge said. Shows as a "View AI
        // conversation" link on the contact's timeline.
        if (formType === 'chat' && Array.isArray(b.chat_transcript) && b.chat_transcript.length) {
          try {
            const tx = b.chat_transcript
              .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
              .slice(-60).map(m => ({ role: m.role, content: m.content.trim().slice(0, 2000) }))
            if (tx.length) {
              await supabaseAdmin.from('communications').insert({
                dealership_id: d.id, contact_id: contactId, channel: 'chat', direction: 'in',
                subject: 'Website AI chat',
                body: `AI website chat — ${tx.length} message${tx.length === 1 ? '' : 's'}. Open to read the full conversation.`,
                meta: { kind: 'ai_chat', source: 'website', transcript: tx },
              })
            }
          } catch (err) { console.warn('[site] chat transcript save failed:', err.message) }
        }

        // High-intent alerts for reserve / deposit requests.
        if (formType === 'reserve') {
          await createNotification({
            dealershipId: d.id, type: 'new_lead',
            title: `Reserve request${name ? ': ' + name : ''}`,
            body: `A shopper wants to reserve a vehicle online — follow up fast to take the deposit.`,
            linkPage: 'crm', targetUserId: routed?.assignee || null,
          })
        }
      }
      res.json({ ok: true })
    } catch (e) { res.status(500).json({ error: e.message }) }
  })

  // ── PUBLIC: native appointment booking (test drive / consult) ───────────────
  // Shopper picks a date + time on the dealer site → lands on the dealer's CRM
  // calendar as an appointment, routed + assigned to a rep, with a video-meeting
  // link, and emails the customer + the assigned rep + the store.
  app.post('/site/:slug/book', rateLimit('sitebook', 12, 60000), async (req, res) => {
    const slug = String(req.params.slug || '').toLowerCase().trim()
    const { data: d } = await supabaseAdmin.from('dealerships').select('id, name, branding, site_published, city, province').ilike('site_slug', slug).maybeSingle()
    if (!d || !d.site_published) return res.status(404).json({ error: 'Site not found' })
    const b = req.body || {}
    const name = String(b.name || '').trim().slice(0, 120)
    const email = String(b.email || '').trim().slice(0, 160)
    const phone = String(b.phone || '').trim().slice(0, 40)
    const notes = String(b.notes || b.message || '').trim().slice(0, 1000)
    if (!name || (!email && !phone)) return res.status(400).json({ error: 'Add your name and an email or phone.' })
    const when = new Date(b.when)
    if (isNaN(when.getTime())) return res.status(400).json({ error: 'Pick a valid date and time.' })
    if (when.getTime() < Date.now() + 15 * 60 * 1000) return res.status(400).json({ error: 'Please choose a time at least 15 minutes out.' })
    if (when.getTime() > Date.now() + 120 * 86400000) return res.status(400).json({ error: 'Please choose a time within the next few months.' })
    const durationMin = 30
    const kind = String(b.kind || 'Test drive').slice(0, 40)

    let inventory_id = null, vehicleLabel = ''
    if (b.vehicle_id) {
      const { data: v } = await supabaseAdmin.from('inventory').select('id, dealership_id, year, make, model, trim').eq('id', b.vehicle_id).maybeSingle()
      if (v && v.dealership_id === d.id) { inventory_id = v.id; vehicleLabel = [v.year, v.make, v.model, v.trim].filter(Boolean).join(' ') }
    }
    const endAt = new Date(when.getTime() + durationMin * 60000)
    const whenLabel = (() => { try { return new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short', timeZone: b.tz || 'America/Toronto' }).format(when) } catch { return when.toISOString() } })()
    const rand = Math.random().toString(36).slice(2, 8)
    const meetUrl = `https://meet.jit.si/${(d.name || 'dealer').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'dealer'}-${rand}`

    try {
      const { data: lead } = await supabaseAdmin.from('leads').insert({
        dealership_id: d.id, name: name || null, email: email || null, phone: phone || null,
        comments: `${kind} booked for ${whenLabel}${vehicleLabel ? ' — ' + vehicleLabel : ''}${notes ? ' · ' + notes : ''}`, source: 'Website', inventory_id,
      }).select('id').single()
      const contactId = await findOrCreateContact({ dealershipId: d.id, name, email, phone, source: 'Website' })
      if (contactId && lead?.id) await supabaseAdmin.from('leads').update({ contact_id: contactId }).eq('id', lead.id)
      const routed = await routeAndNotifyLead(d.id, { contactId, vehicleId: inventory_id || null, name, source: 'Website' })
      const repId = routed?.assignee || null
      await supabaseAdmin.from('contacts').update({ status: 'appointment', updated_at: new Date().toISOString() }).eq('id', contactId)
      await supabaseAdmin.from('crm_tasks').insert({
        dealership_id: d.id, contact_id: contactId, assigned_to: repId, created_by: repId,
        title: `${kind} — ${name}${vehicleLabel ? ' — ' + vehicleLabel : ''}`, type: 'appointment', due_at: when.toISOString(),
      })
      await supabaseAdmin.from('communications').insert({
        dealership_id: d.id, contact_id: contactId, channel: 'note', direction: 'internal',
        subject: `${kind} booked`, body: `${whenLabel} (${durationMin} min)${vehicleLabel ? '\nVehicle: ' + vehicleLabel : ''}\nVideo: ${meetUrl}${notes ? '\nNotes: ' + notes : ''}`,
        meta: { kind: 'appointment', meet_url: meetUrl, when: when.toISOString(), duration_min: durationMin },
      })
      enqueueForTrigger(d.id, 'appointment_booked', { contactId, vehicleId: inventory_id || null, repId })
      await createNotification({
        dealershipId: d.id, type: 'new_lead', title: `📅 ${kind} booked — ${name}`,
        body: `${whenLabel}${vehicleLabel ? ' · ' + vehicleLabel : ''}. Confirm with the customer.`, linkPage: 'appointments', targetUserId: repId,
      })

      // Emails: customer + assigned rep + the store's general inbox.
      if (resend) {
        const gS = when.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''), gE = endAt.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
        const gcal = `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent(kind + ' — ' + d.name)}&dates=${gS}/${gE}&details=${encodeURIComponent((vehicleLabel ? vehicleLabel + '\n' : '') + 'Join: ' + meetUrl)}`
        const btn = (h, l, bg) => `<a href="${h}" style="display:inline-block;background:${bg};color:#fff;text-decoration:none;font-weight:700;font-size:14px;padding:10px 18px;border-radius:8px;margin:4px 6px 4px 0">${l}</a>`
        const shell = (heading, intro) => `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:520px;margin:0 auto"><div style="background:#1e3a8a;color:#fff;padding:16px 20px;border-radius:12px 12px 0 0"><div style="font-size:19px;font-weight:800">${heading}</div></div><div style="border:1px solid #e2e8f0;border-top:0;border-radius:0 0 12px 12px;padding:20px"><p style="font-size:15px;color:#0f172a;margin:0 0 12px">${intro}</p><table style="width:100%;font-size:14px;color:#334155"><tr><td style="padding:6px 0;color:#64748b;width:90px">When</td><td style="padding:6px 0;font-weight:700">${whenLabel}</td></tr>${vehicleLabel ? `<tr><td style="padding:6px 0;color:#64748b">Vehicle</td><td style="padding:6px 0">${vehicleLabel}</td></tr>` : ''}<tr><td style="padding:6px 0;color:#64748b">Video</td><td style="padding:6px 0"><a href="${meetUrl}" style="color:#1e3a8a;font-weight:700">${meetUrl}</a></td></tr></table><div style="margin-top:16px">${btn(meetUrl, '▶ Join', '#16a34a')}${btn(gcal, '+ Add to calendar', '#1e3a8a')}</div></div></div>`
        if (email) resend.emails.send({ from: EMAIL_FROM, to: email, subject: `Your ${kind.toLowerCase()} at ${d.name} — ${whenLabel}`, html: shell(`${kind} confirmed`, `Thanks ${name.split(' ')[0] || ''}! We've got you down for a ${kind.toLowerCase()}. See you then.`) }).catch(() => {})
        const inboxes = new Set()
        const house = d.branding?.email || d.automation_settings?.house_email
        if (house) inboxes.add(String(house).toLowerCase())
        if (repId) { const { data: rp } = await supabaseAdmin.from('profiles').select('email').eq('id', repId).maybeSingle(); if (rp?.email) inboxes.add(rp.email.toLowerCase()) }
        for (const to of inboxes) resend.emails.send({ from: EMAIL_FROM, to, subject: `New ${kind.toLowerCase()} booked — ${name} — ${whenLabel}`, html: shell(`New ${kind.toLowerCase()} booked`, `${name} booked a ${kind.toLowerCase()}${vehicleLabel ? ` for the ${vehicleLabel}` : ''}. It's on the calendar.${notes ? `<br><br><b>Notes:</b> ${notes}` : ''}`) }).catch(() => {})
      }
      res.json({ ok: true, when: when.toISOString(), meet_url: meetUrl })
    } catch (e) {
      console.warn('[site] booking failed:', e.message)
      res.status(500).json({ error: 'Could not book that time — please try again.' })
    }
  })

  // ── PUBLIC: AI sales concierge chat for a dealer's website ─────────────────
  // Answers shopper questions strictly from THIS dealer's live inventory + info,
  // nudges toward a test drive / financing / trade, and hands off to the lead form
  // for contact capture. Rate-limited per IP + gated on the dealer's AI budget and
  // an opt-in toggle so it can never run up cost silently.
  const CHAT_FALLBACK = "I can't chat live right now, but leave your name and number and a product advisor will get right back to you."
  app.post('/site/:slug/chat', rateLimit('sitechat', 20, 60000), async (req, res) => {
    const slug = String(req.params.slug || '').toLowerCase().trim()
    const { data: d } = await supabaseAdmin.from('dealerships').select(SITE_COLS).ilike('site_slug', slug).maybeSingle()
    if (!d || !d.site_published) return res.status(404).json({ error: 'Site not found' })
    const b = d.branding || {}
    if (!b.site_sales_chat) return res.status(403).json({ error: 'Chat is not enabled for this site.' })

    // Graceful degrade: no key or over budget → tell the widget to show the form.
    if (!process.env.ANTHROPIC_API_KEY || !(await aiAllowed(d.id, false))) {
      return res.json({ reply: CHAT_FALLBACK, capture: true })
    }

    const raw = Array.isArray(req.body?.messages) ? req.body.messages : []
    const messages = raw
      .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
      .slice(-8)
      .map(m => ({ role: m.role, content: m.content.trim().slice(0, 1000) }))
    if (!messages.length || messages[messages.length - 1].role !== 'user') return res.status(400).json({ error: 'Send a message.' })

    // Live inventory the concierge answers from (scoped to this dealer, on-lot only).
    const { data: inv } = await supabaseAdmin.from('inventory')
      .select('year, make, model, trim, price, mileage, condition, exterior_color, drivetrain, fuel_type, body_style, stocknumber')
      .eq('dealership_id', d.id).is('archived_at', null).neq('status', 'sold')
      .or('awaiting_possession.is.null,awaiting_possession.eq.false')
      .order('price', { ascending: true }).limit(400)
    const list = inv || []
    const money = n => n ? '$' + Number(n).toLocaleString('en-US') : 'call for price'
    const lines = list.slice(0, 60).map(v => `- ${[v.year, v.make, v.model, v.trim].filter(Boolean).join(' ')} · ${money(v.price)}${v.mileage ? ' · ' + Number(v.mileage).toLocaleString('en-US') + ' km/mi' : ''}${v.exterior_color ? ' · ' + v.exterior_color : ''}${v.condition ? ' · ' + v.condition : ''}${v.stocknumber ? ' · #' + v.stocknumber : ''}`).join('\n')
    const makeCounts = {}
    for (const v of list) { const k = v.make || 'Other'; makeCounts[k] = (makeCounts[k] || 0) + 1 }
    const byMake = Object.entries(makeCounts).sort((a, c) => c[1] - a[1]).slice(0, 10).map(([m, n]) => `${m} (${n})`).join(', ')
    const bi = cleanBuiltins(b.site_builtins)
    const can = (k) => !bi[k] || bi[k].enabled !== false
    const loc = [d.city, d.province].filter(Boolean).join(', ')
    const facts = [
      `Dealership: ${d.name}${loc ? ` — ${loc}` : ''}.`,
      b.phone ? `Phone: ${b.phone}.` : '',
      b.address ? `Address: ${b.address}.` : '',
      b.hours ? `Hours: ${String(b.hours).slice(0, 300)}.` : '',
      `Vehicles in stock: ${list.length}. By make: ${byMake || 'n/a'}.`,
      `Financing available: ${can('finance') ? 'yes' : 'ask'}. Trade-in appraisals: ${can('trade') ? 'yes' : 'ask'}.`,
    ].filter(Boolean).join('\n')

    // Dealership-level AI persona + knowledge base (set in Settings → AI) layer on top
    // of the per-site chat knobs. Fetched separately so they never ride SITE_COLS into
    // the public site JSON.
    const { data: aiCfg } = await supabaseAdmin.from('dealerships')
      .select('ai_customer_style, ai_knowledge, ai_knowledge_name').eq('id', d.id).maybeSingle()
    const kb = [String(b.site_chat_kb || '').trim(), String(aiCfg?.ai_knowledge || '').trim()].filter(Boolean).join('\n\n').slice(0, 12000)
    const instr = [String(aiCfg?.ai_customer_style || '').trim(), String(b.site_chat_instructions || '').trim()].filter(Boolean).join('\n\n').slice(0, 4000)
    const disclaimer = String(b.site_chat_disclaimer || '').trim().slice(0, 600)
    const system = `You are the friendly online sales concierge for ${d.name}, a car dealership${loc ? ` in ${loc}` : ''}. Help shoppers find a vehicle, answer questions about the inventory below, and guide them toward the next step: booking a test drive, getting pre-approved for financing, or valuing their trade. Be warm, concise (2–4 sentences), and never pushy.

RULES:
- Only discuss vehicles from the INVENTORY list. Never invent stock, prices, VINs, or specs. If something isn't listed, say you'll have an advisor confirm and offer to take their info.
- Quote prices exactly as listed; if a unit shows "call for price", invite them to enquire.
- When the shopper shows buying intent (a specific vehicle, financing, a test drive, a trade value), invite them to leave their name and phone/email so a product advisor can follow up, and end that message with the token [CAPTURE].
- Keep it about ${d.name}. Don't mention other dealers or that you are an AI model. Today: ${new Date().toISOString().slice(0, 10)}.${instr ? `

DEALER INSTRUCTIONS (how this dealership wants you to answer — follow these, but never break the RULES above):
${instr}` : ''}${kb ? `

DEALER KNOWLEDGE BASE (dealer-provided facts about this store — policies, financing, warranty, hours, staff, FAQs. Prefer these answers over guessing; if something isn't here or in inventory, offer to have an advisor confirm):
${kb}` : ''}${disclaimer ? `

DISCLAIMER: If the shopper asks about pricing accuracy, availability guarantees, legal/financing terms, or when you're unsure, include this dealer disclaimer naturally: "${disclaimer}"` : ''}

DEALERSHIP FACTS:
${facts}

INVENTORY (${list.length} in stock):
${lines || '(no vehicles listed right now)'}`

    try {
      const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
      const response = await Promise.race([
        anthropic.messages.create({ model: 'claude-haiku-4-5-20251001', max_tokens: 400, system, messages }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('ai timeout')), 20000)),
      ])
      let reply = (response?.content || []).filter(x => x.type === 'text').map(x => x.text).join('\n').trim()
      const capture = /\[CAPTURE\]/i.test(reply)
      reply = reply.replace(/\[CAPTURE\]/ig, '').trim()
      if (!reply) return res.json({ reply: CHAT_FALLBACK, capture: true })
      recordUsage(d.id, { ai: 1 })
      res.json({ reply, capture })
    } catch (e) {
      res.json({ reply: CHAT_FALLBACK, capture: true })
    }
  })

  // ── ADMIN: read the site config (slug, published, content) ─────────────────
  app.get('/dealership/site', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership' })
    const { data: d } = await supabaseAdmin.from('dealerships')
      .select('name, branding, site_slug, site_published, custom_domain, custom_domain_verified, city, province, postal_code, website_url').eq('id', req.dealershipId).single()
    res.json({
      site_slug: d.site_slug || null,
      site_published: !!d.site_published,
      custom_domain: d.custom_domain || null,
      custom_domain_verified: !!d.custom_domain_verified,
      domain_target: SITE_HOST,   // where the dealer points their CNAME
      can_manage: isSiteAdmin(req),
      content: siteContent(d),
    })
  })

  // ── ADMIN: update slug / publish / site content ────────────────────────────
  app.put('/dealership/site', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership' })
    if (!isSiteAdmin(req)) return res.status(403).json({ error: 'Manager access required' })
    const b = req.body || {}
    const update = {}

    if (b.site_slug !== undefined) {
      const slug = String(b.site_slug || '').toLowerCase().trim()
      if (slug) {
        if (!slugOk(slug)) return res.status(400).json({ error: 'Use 3–40 letters, numbers or dashes (no leading/trailing dash).' })
        const { data: taken } = await supabaseAdmin.from('dealerships')
          .select('id').ilike('site_slug', slug).neq('id', req.dealershipId).maybeSingle()
        if (taken) return res.status(409).json({ error: 'That address is already taken — try another.' })
        update.site_slug = slug
      } else update.site_slug = null
    }
    if (b.site_published !== undefined) update.site_published = !!b.site_published

    if (b.custom_domain !== undefined) {
      const dom = String(b.custom_domain || '').toLowerCase().trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '')
      const { data: cur } = await supabaseAdmin.from('dealerships').select('custom_domain, custom_domain_cf_id').eq('id', req.dealershipId).single()
      if (dom) {
        if (!domainOk(dom)) return res.status(400).json({ error: 'Enter a valid domain like yourdealership.com or www.yourdealership.com (no http:// or paths).' })
        const bare = dom.replace(/^www\./, '')
        const { data: taken } = await supabaseAdmin.from('dealerships').select('id')
          .or(`custom_domain.ilike.${bare},custom_domain.ilike.www.${bare}`).neq('id', req.dealershipId).maybeSingle()
        if (taken) return res.status(409).json({ error: 'That domain is already connected to another account.' })
        update.custom_domain = dom
        update.custom_domain_verified = false
        update.custom_domain_added_at = new Date().toISOString()
        if (CF_ENABLED && dom !== cur?.custom_domain) {
          await cfDeleteHostname(cur?.custom_domain_cf_id)
          update.custom_domain_cf_id = await cfCreateHostname(dom)   // provisions the TLS cert
        }
      } else {
        if (CF_ENABLED) await cfDeleteHostname(cur?.custom_domain_cf_id)
        update.custom_domain = null; update.custom_domain_verified = false; update.custom_domain_cf_id = null
      }
    }

    // Merge site content into the shared branding jsonb (don't wipe sticker fields).
    const contentKeys = ['tagline', 'about', 'hours', 'phone', 'email', 'address', 'hero_url', 'primary_color', 'secondary_color', 'accent_color', 'facebook_url', 'instagram_url', 'typography', 'heading_font', 'body_font', 'hero_photos', 'seo_title', 'seo_description', 'seo_keywords', 'seo_image']
    const touchesContent = contentKeys.some(k => b[k] !== undefined) || b.head_html !== undefined || b.widgets !== undefined || b.pages !== undefined || b.sections !== undefined || b.staff !== undefined || b.build_makes !== undefined || b.builtins !== undefined || b.menu_order !== undefined || b.sales_chat !== undefined || b.chat_kb !== undefined || b.chat_instructions !== undefined || b.chat_disclaimer !== undefined
    if (touchesContent) {
      const { data: cur } = await supabaseAdmin.from('dealerships').select('branding').eq('id', req.dealershipId).single()
      const branding = { ...(cur?.branding || {}) }
      for (const k of contentKeys) if (b[k] !== undefined) branding[k] = b[k] === '' ? null : b[k]
      if (b.sales_chat !== undefined) branding.site_sales_chat = !!b.sales_chat
      if (b.chat_kb !== undefined) branding.site_chat_kb = String(b.chat_kb || '').slice(0, 12000) || null
      if (b.chat_instructions !== undefined) branding.site_chat_instructions = String(b.chat_instructions || '').slice(0, 4000) || null
      if (b.chat_disclaimer !== undefined) branding.site_chat_disclaimer = String(b.chat_disclaimer || '').slice(0, 600) || null
      if (b.head_html !== undefined) branding.site_head_html = String(b.head_html || '').slice(0, 20000) || null
      if (b.widgets !== undefined) branding.site_widgets = cleanWidgets(b.widgets)
      if (b.pages !== undefined) branding.site_pages = cleanPages(b.pages)
      if (b.staff !== undefined) branding.site_team = cleanStaff(b.staff)
      if (b.build_makes !== undefined) branding.build_makes = cleanMakes(b.build_makes)
      if (b.builtins !== undefined) branding.site_builtins = cleanBuiltins(b.builtins)
      if (b.menu_order !== undefined) branding.site_menu_order = cleanMenuOrder(b.menu_order)
      if (b.sections !== undefined) branding.site_sections = cleanSections(b.sections)
      if (b.typography !== undefined) branding.typography = TYPOGRAPHY.includes(b.typography) ? b.typography : 'modern'
      update.branding = branding
    }

    if (!Object.keys(update).length) return res.json({ ok: true })
    const { error } = await supabaseAdmin.from('dealerships').update(update).eq('id', req.dealershipId)
    if (error) return res.status(500).json({ error: error.message })
    res.json({ ok: true, site_slug: update.site_slug, site_published: update.site_published, custom_domain: update.custom_domain, domain_target: SITE_HOST })
  })

  // ── ADMIN: check whether the dealer's custom domain now points at us ─────────
  app.post('/dealership/site/verify-domain', requireAuth, async (req, res) => {
    if (!isSiteAdmin(req)) return res.status(403).json({ error: 'Manager access required' })
    const { data: d } = await supabaseAdmin.from('dealerships').select('custom_domain, custom_domain_cf_id').eq('id', req.dealershipId).single()
    const dom = d?.custom_domain
    if (!dom) return res.status(400).json({ error: 'Add a domain first.' })
    let ok = false
    if (CF_ENABLED) {
      // Cloudflare tells us authoritatively when the hostname + cert are live.
      let cfId = d.custom_domain_cf_id
      if (!cfId) { cfId = await cfCreateHostname(dom); if (cfId) await supabaseAdmin.from('dealerships').update({ custom_domain_cf_id: cfId }).eq('id', req.dealershipId) }
      ok = await cfHostnameActive(cfId)
    } else {
      const bare = dom.replace(/^www\./, '')
      for (const n of [dom, bare, 'www.' + bare]) {
        try { const c = await dns.resolveCname(n); if (c.some(x => x.toLowerCase().includes(SITE_HOST))) { ok = true; break } } catch {}
      }
      if (!ok) {
        try {
          const [ourA, theirA] = await Promise.all([dns.resolve4(SITE_HOST).catch(() => []), dns.resolve4(dom).catch(() => [])])
          if (theirA.length && theirA.some(ip => ourA.includes(ip))) ok = true
        } catch {}
      }
    }
    await supabaseAdmin.from('dealerships').update({ custom_domain_verified: ok }).eq('id', req.dealershipId)
    res.json({ verified: ok, domain: dom, target: SITE_HOST, message: ok ? 'Connected! Your domain is live with a secure certificate.' : 'Not live yet — DNS/SSL can take a few minutes to an hour after you add the record. Try again shortly.' })
  })
}
