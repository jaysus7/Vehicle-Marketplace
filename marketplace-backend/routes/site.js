import { supabaseAdmin } from '../shared.js'
import { requireAuth } from '../middleware.js'
import { findOrCreateContact } from './crm.js'

const SITE_ADMINS = ['DEALER_ADMIN', 'OWNER', 'MANAGER']
const isSiteAdmin = (req) => SITE_ADMINS.includes(req.profile?.role)
const slugOk = (s) => /^[a-z0-9]([a-z0-9-]{1,38})[a-z0-9]$/.test(s)   // 3–40, no leading/trailing dash

// Only expose safe, public-facing vehicle fields (no internal/source data).
function publicVehicle(v) {
  return {
    id: v.id, year: v.year, make: v.make, model: v.model, trim: v.trim,
    price: v.price, mileage: v.mileage, condition: v.condition,
    exterior_color: v.exterior_color, interior_color: v.interior_color,
    drivetrain: v.drivetrain, fuel_type: v.fuel_type, transmission: v.transmission,
    engine: v.engine, body_style: v.body_style, doors: v.doors,
    stocknumber: v.stocknumber, vin: v.vin,
    image_urls: Array.isArray(v.image_urls) ? v.image_urls : [],
    description: v.description || null,
  }
}
function publicRep(p) {
  return {
    name: p.display_name || p.full_name || null,
    title: ({ OWNER: 'Owner', DEALER_ADMIN: 'General Manager', MANAGER: 'Sales Manager', SALES_REP: 'Sales' }[p.role] || 'Sales'),
    photo: p.avatar_url || null,
    phone: p.phone || null,
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
      slug, title, body_html: String(p.body_html || '').slice(0, 40000), nav: p.nav !== false, kind,
      make: p.make ? String(p.make).slice(0, 40) : null,
      model: p.model ? String(p.model).slice(0, 60) : null,
    }
  }).filter(p => p.title && p.slug)
}

// The section palette for the page builder. Each is dealership-aware on render.
const SECTION_TYPES = ['hero', 'featured_inventory', 'inventory_grid', 'finance_cta', 'trade_cta', 'service_cta', 'staff', 'reviews', 'faq', 'cta_banner', 'gallery', 'map', 'contact', 'html']
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
    facebook_url: b.facebook_url || null,
    instagram_url: b.instagram_url || null,
    // Dealer-controlled custom code: global vendor scripts injected into <head>
    // (analytics, chat, Keyloop tags) + placed embed widgets rendered in slots.
    head_html: b.site_head_html || null,
    widgets: cleanWidgets(b.site_widgets),
    pages: cleanPages(b.site_pages),
    // Page builder: ordered sections + global styling.
    sections: cleanSections(b.site_sections),
    typography: TYPOGRAPHY.includes(b.typography) ? b.typography : 'modern',
    accent_color: b.accent_color || null,
  }
}

export function registerSite(app) {
  // ── PUBLIC: a dealer's live site data (no auth) ────────────────────────────
  app.get('/site/:slug', async (req, res) => {
    const slug = String(req.params.slug || '').toLowerCase().trim()
    if (!slug) return res.status(404).json({ error: 'Not found' })
    const { data: d } = await supabaseAdmin.from('dealerships')
      .select('id, name, branding, site_published, city, province, postal_code, website_url')
      .ilike('site_slug', slug).maybeSingle()
    if (!d || !d.site_published) return res.status(404).json({ error: 'Site not found' })

    const [{ data: inv }, { data: team }] = await Promise.all([
      supabaseAdmin.from('inventory')
        .select('id, year, make, model, trim, price, mileage, condition, exterior_color, interior_color, drivetrain, fuel_type, transmission, engine, body_style, doors, stocknumber, vin, image_urls, description, created_at')
        .eq('dealership_id', d.id).is('archived_at', null).eq('status', 'available')
        .order('created_at', { ascending: false }).limit(600),
      supabaseAdmin.from('profiles')
        .select('full_name, display_name, avatar_url, phone, role, hide_on_site')
        .eq('dealership_id', d.id),
    ])
    const vehicles = (inv || []).map(publicVehicle)
    const roster = (team || []).filter(p => !p.hide_on_site && (p.display_name || p.full_name)).map(publicRep)
    res.json({ site: siteContent(d), vehicles, team: roster, count: vehicles.length })
  })

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
    const FORMS = { trade: 'Trade-In', credit: 'Credit Application', inquiry: 'Website' }
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
      res.json({ ok: true })
    } catch (e) { res.status(500).json({ error: e.message }) }
  })

  // ── ADMIN: read the site config (slug, published, content) ─────────────────
  app.get('/dealership/site', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership' })
    const { data: d } = await supabaseAdmin.from('dealerships')
      .select('name, branding, site_slug, site_published, city, province, postal_code, website_url').eq('id', req.dealershipId).single()
    res.json({
      site_slug: d.site_slug || null,
      site_published: !!d.site_published,
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

    // Merge site content into the shared branding jsonb (don't wipe sticker fields).
    const contentKeys = ['tagline', 'about', 'hours', 'phone', 'email', 'address', 'hero_url', 'primary_color', 'secondary_color', 'accent_color', 'facebook_url', 'instagram_url', 'typography']
    const touchesContent = contentKeys.some(k => b[k] !== undefined) || b.head_html !== undefined || b.widgets !== undefined || b.pages !== undefined || b.sections !== undefined
    if (touchesContent) {
      const { data: cur } = await supabaseAdmin.from('dealerships').select('branding').eq('id', req.dealershipId).single()
      const branding = { ...(cur?.branding || {}) }
      for (const k of contentKeys) if (b[k] !== undefined) branding[k] = b[k] === '' ? null : b[k]
      if (b.head_html !== undefined) branding.site_head_html = String(b.head_html || '').slice(0, 20000) || null
      if (b.widgets !== undefined) branding.site_widgets = cleanWidgets(b.widgets)
      if (b.pages !== undefined) branding.site_pages = cleanPages(b.pages)
      if (b.sections !== undefined) branding.site_sections = cleanSections(b.sections)
      if (b.typography !== undefined) branding.typography = TYPOGRAPHY.includes(b.typography) ? b.typography : 'modern'
      update.branding = branding
    }

    if (!Object.keys(update).length) return res.json({ ok: true })
    const { error } = await supabaseAdmin.from('dealerships').update(update).eq('id', req.dealershipId)
    if (error) return res.status(500).json({ error: error.message })
    res.json({ ok: true, site_slug: update.site_slug, site_published: update.site_published })
  })
}
