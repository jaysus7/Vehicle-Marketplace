import { supabaseAdmin, browserFetch } from '../shared.js'
import { requireAuth } from '../middleware.js'
import { runInventorySync, syncProgress } from '../sync/engine.js'
import multer from 'multer'

// Vehicle-photo uploads: in-memory, 12MB/file, up to 30 at once.
const photoUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 12 * 1024 * 1024, files: 30 } })
const INV_MANAGERS = ['DEALER_ADMIN', 'OWNER', 'MANAGER']
const canManageInventory = (req) => INV_MANAGERS.includes(req.profile?.role)
const numOrNull = (x) => { const n = Number(x); return Number.isFinite(n) ? n : null }
// Pull the storage object path back out of a public vehicle-photos URL (for deletes).
function photoStoragePath(url) {
  const m = String(url || '').match(/\/vehicle-photos\/(.+)$/)
  return m ? decodeURIComponent(m[1].split('?')[0]) : null
}

// Pull the Carfax report link the dealer already embeds on a listing page (their
// paid Carfax badge). Returns the best-matching absolute carfax URL, or null.
function extractCarfaxLink(html, vin) {
  const hrefs = [...html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)].map(m => m[1].replace(/&amp;/g, '&'))
  const carfax = hrefs.filter(u =>
    /carfax/i.test(u) && /^https?:\/\//i.test(u) && !/\.(png|jpe?g|svg|gif|css|js)(\?|#|$)/i.test(u))
  if (!carfax.length) return null
  const vinU = (vin || '').toUpperCase()
  const score = u => (vinU && u.toUpperCase().includes(vinU) ? 10 : 0) + (/vhr|report|vehicle-history/i.test(u) ? 3 : 0)
  return carfax.sort((a, b) => score(b) - score(a))[0]
}

export function registerRoutes(app) {
  // ── Manual inventory: dealers load their own units (source of truth) ────────
  // Managed units are marked source='manual' so the nightly FEED archiver never
  // touches them. This is the "we host your inventory" path — photos + all.

  // Create a vehicle
  app.post('/inventory', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership' })
    if (!canManageInventory(req)) return res.status(403).json({ error: 'Manager access required' })
    const b = req.body || {}
    const make = String(b.make || '').trim(), model = String(b.model || '').trim()
    if (!make || !model) return res.status(400).json({ error: 'Make and model are required' })
    const mileage = numOrNull(b.mileage)
    const row = {
      dealership_id: req.dealershipId, source: 'manual', status: 'available',
      vin: b.vin ? String(b.vin).trim().toUpperCase().slice(0, 17) : null,
      year: parseInt(b.year) || null, make, model, trim: (b.trim || '').trim() || null,
      price: numOrNull(b.price), mileage: mileage != null ? Math.round(mileage) : null,
      condition: b.condition || 'used', stocknumber: (b.stocknumber || '').trim() || null,
      exterior_color: b.exterior_color || null, interior_color: b.interior_color || null,
      transmission: b.transmission || null, fuel_type: b.fuel_type || null,
      drivetrain: b.drivetrain || null, engine: b.engine || null, body_style: b.body_style || null,
      doors: numOrNull(b.doors), description: b.description || null,
      image_urls: Array.isArray(b.image_urls) ? b.image_urls : [],
      lot_date: new Date().toISOString(),
    }
    const { data, error } = await supabaseAdmin.from('inventory').insert(row).select('*').single()
    if (error) return res.status(500).json({ error: error.message })
    res.json({ ok: true, vehicle: data })
  })

  // Edit a vehicle (any owned unit — manual or synced)
  app.put('/inventory/:id', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership' })
    if (!canManageInventory(req)) return res.status(403).json({ error: 'Manager access required' })
    const b = req.body || {}
    const patch = {}
    for (const f of ['make', 'model', 'trim', 'condition', 'stocknumber', 'exterior_color', 'interior_color', 'transmission', 'fuel_type', 'drivetrain', 'engine', 'body_style', 'description']) {
      if (b[f] !== undefined) patch[f] = b[f] === '' ? null : b[f]
    }
    if (b.vin !== undefined) patch.vin = b.vin ? String(b.vin).trim().toUpperCase().slice(0, 17) : null
    if (b.year !== undefined) patch.year = parseInt(b.year) || null
    if (b.price !== undefined) patch.price = numOrNull(b.price)
    if (b.mileage !== undefined) { const m = numOrNull(b.mileage); patch.mileage = m != null ? Math.round(m) : null }
    if (b.doors !== undefined) patch.doors = numOrNull(b.doors)
    if (Array.isArray(b.image_urls)) patch.image_urls = b.image_urls
    if (b.status !== undefined && ['available', 'sold', 'pending'].includes(b.status)) {
      patch.status = b.status
      if (b.status === 'available') patch.archived_at = null
    }
    const { data, error } = await supabaseAdmin.from('inventory')
      .update(patch).eq('id', req.params.id).eq('dealership_id', req.dealershipId).select('*').maybeSingle()
    if (error) return res.status(500).json({ error: error.message })
    if (!data) return res.status(404).json({ error: 'Vehicle not found' })
    res.json({ ok: true, vehicle: data })
  })

  // Delete a vehicle (and its uploaded photos)
  app.delete('/inventory/:id', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership' })
    if (!canManageInventory(req)) return res.status(403).json({ error: 'Manager access required' })
    const { data: v } = await supabaseAdmin.from('inventory')
      .select('id, image_urls').eq('id', req.params.id).eq('dealership_id', req.dealershipId).maybeSingle()
    if (!v) return res.status(404).json({ error: 'Vehicle not found' })
    try {
      const paths = (v.image_urls || []).map(photoStoragePath).filter(Boolean)
      if (paths.length) await supabaseAdmin.storage.from('vehicle-photos').remove(paths)
    } catch (e) { console.warn('[inv] photo cleanup failed:', e.message) }
    const { error } = await supabaseAdmin.from('inventory').delete().eq('id', req.params.id).eq('dealership_id', req.dealershipId)
    if (error) return res.status(500).json({ error: error.message })
    res.json({ ok: true })
  })

  // Upload photos (multipart) → Supabase Storage → append to image_urls
  app.post('/inventory/:id/photos', requireAuth, photoUpload.array('photos', 30), async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership' })
    if (!canManageInventory(req)) return res.status(403).json({ error: 'Manager access required' })
    const { data: v } = await supabaseAdmin.from('inventory')
      .select('id, image_urls').eq('id', req.params.id).eq('dealership_id', req.dealershipId).maybeSingle()
    if (!v) return res.status(404).json({ error: 'Vehicle not found' })
    const files = req.files || []
    if (!files.length) return res.status(400).json({ error: 'No photos uploaded' })
    const urls = [...(v.image_urls || [])]
    for (const f of files) {
      const ext = (f.mimetype.split('/')[1] || 'jpg').replace('jpeg', 'jpg')
      const path = `${req.dealershipId}/${req.params.id}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`
      const { error: upErr } = await supabaseAdmin.storage.from('vehicle-photos')
        .upload(path, f.buffer, { contentType: f.mimetype, upsert: false })
      if (upErr) { console.warn('[inv-photo] upload failed:', upErr.message); continue }
      const { data: { publicUrl } } = supabaseAdmin.storage.from('vehicle-photos').getPublicUrl(path)
      urls.push(publicUrl)
    }
    const { data, error } = await supabaseAdmin.from('inventory')
      .update({ image_urls: urls }).eq('id', req.params.id).eq('dealership_id', req.dealershipId).select('image_urls').single()
    if (error) return res.status(500).json({ error: error.message })
    res.json({ ok: true, image_urls: data.image_urls })
  })

  // Set the full photo order / removal (client sends the desired image_urls array).
  // Any uploaded photo dropped from the list is also deleted from storage.
  app.put('/inventory/:id/photos', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership' })
    if (!canManageInventory(req)) return res.status(403).json({ error: 'Manager access required' })
    const nextUrls = Array.isArray(req.body?.image_urls) ? req.body.image_urls : null
    if (!nextUrls) return res.status(400).json({ error: 'image_urls array required' })
    const { data: v } = await supabaseAdmin.from('inventory')
      .select('id, image_urls').eq('id', req.params.id).eq('dealership_id', req.dealershipId).maybeSingle()
    if (!v) return res.status(404).json({ error: 'Vehicle not found' })
    const removed = (v.image_urls || []).filter(u => !nextUrls.includes(u))
    try {
      const paths = removed.map(photoStoragePath).filter(Boolean)
      if (paths.length) await supabaseAdmin.storage.from('vehicle-photos').remove(paths)
    } catch (e) { console.warn('[inv] photo remove failed:', e.message) }
    const { data, error } = await supabaseAdmin.from('inventory')
      .update({ image_urls: nextUrls }).eq('id', req.params.id).eq('dealership_id', req.dealershipId).select('image_urls').single()
    if (error) return res.status(500).json({ error: error.message })
    res.json({ ok: true, image_urls: data.image_urls })
  })

  // GET /inventory/:id/carfax — resolve the Carfax report link for a vehicle by
  // scraping the badge off its source listing page (cached after first hit).
  app.get('/inventory/:id/carfax', requireAuth, async (req, res) => {
    const { data: v } = await supabaseAdmin.from('inventory')
      .select('id, vin, source_url, carfax_url')
      .eq('id', req.params.id).eq('dealership_id', req.dealershipId).maybeSingle()
    if (!v) return res.status(404).json({ error: 'Not found' })
    if (v.carfax_url) return res.json({ url: v.carfax_url, source: 'cached' })

    let found = null
    if (v.source_url) {
      try {
        const r = await browserFetch(v.source_url)
        if (r.ok) found = extractCarfaxLink(await r.text(), v.vin)
      } catch { /* fall through to fallback */ }
    }
    if (found) {
      await supabaseAdmin.from('inventory').update({ carfax_url: found }).eq('id', v.id)
      return res.json({ url: found, source: 'website' })
    }
    // No badge found on the page — fall back to a Carfax Canada VIN search.
    const fallback = v.vin
      ? `https://www.carfax.ca/vehicle-history-reports?vin=${encodeURIComponent(v.vin)}`
      : 'https://www.carfax.ca/'
    res.json({ url: fallback, source: 'fallback' })
  })

  // ── 6. INVENTORY ──
  app.get('/inventory', requireAuth, async (req, res) => {
    const { data, error } = await supabaseAdmin
      .from('inventory')
      .select('*')
      .eq('dealership_id', req.dealershipId)
      .eq('status', 'available')
      .order('created_at', { ascending: false })
    if (error) return res.status(500).json({ error: error.message })
    res.json(data)
  })

  app.get('/inventory/all', requireAuth, async (req, res) => {
    // Show the live lot, plus recently-sold units for 2 weeks (as "sold"), then hide
    // them. Older archived history stays in the DB for analytics until the 1-year purge.
    const cutoff = new Date(Date.now() - 14 * 86400000).toISOString()
    const { data, error } = await supabaseAdmin
      .from('inventory')
      .select('id, vin, year, make, model, trim, price, mileage, condition, exterior_color, interior_color, body_style, fuel_type, drivetrain, transmission, engine, doors, status, archived_at, image_urls, source_url, source, description, stocknumber, last_synced_at, window_sticker_url, window_sticker_oem_url, window_sticker_gen_url, brochure_url, brochure_oem_url, brochure_gen_url, recalls, recalls_checked_at, vin_data')
      .eq('dealership_id', req.dealershipId)
      // Live units (archived_at IS NULL) OR anything archived within the last 2 weeks.
      .or(`archived_at.is.null,archived_at.gte.${cutoff}`)
      .order('created_at', { ascending: false })
    if (error) return res.status(500).json({ error: error.message })

    const rows = (data || []).filter(v => {
      // Feed-flagged sold units (archived_at null, status 'sold') only linger 2 weeks too,
      // measured from their last feed appearance.
      if (v.status === 'sold' && !v.archived_at) return v.last_synced_at >= cutoff
      return true
    }).map(v => (v.status === 'archived' ? { ...v, status: 'sold' } : v))  // show archived as Sold
    res.json(rows)
  })

  app.get('/inventory/:id', requireAuth, async (req, res) => {
    const { data, error } = await supabaseAdmin
      .from('inventory')
      .select('*')
      .eq('id', req.params.id)
      .eq('dealership_id', req.dealershipId)
      .single()
    if (error) return res.status(404).json({ error: 'Not found' })
    res.json(data)
  })

  // Lightweight progress poll for the dashboard Sync button. Returns the live
  // percentage/phase of an in-flight sync for the caller's dealership, or idle.
  app.get('/inventory/sync/progress', requireAuth, (req, res) => {
    if (!req.dealershipId) return res.json({ phase: 'idle', pct: 0 })
    res.json(syncProgress.get(req.dealershipId) || { phase: 'idle', pct: 0 })
  })

  app.post('/inventory/sync', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership associated with this account' })
    try {
      const result = await runInventorySync(req.dealershipId)
      if (!result.success) return res.status(400).json(result)
      res.json(result)
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  // ── 11. DIAGNOSTICS ──
  app.get('/debug', requireAuth, async (req, res) => {
    res.json({ user_id: req.user.id, profile: req.profile, dealership_id: req.dealershipId })
  })
}
