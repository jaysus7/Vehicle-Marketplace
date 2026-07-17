/**
 * Vehicle history — Carfax deep-link + stored reports (VHR / lien / valuation).
 *
 * Manual today: deep-link the dealer to Carfax with the VIN, then attach the PDF (or a
 * link) here so it's stored on the vehicle / deal / customer and re-viewable. A live
 * CarfaxCanadaProvider drops in behind providers/history.js later. Files go in the
 * existing vehicle-pdfs bucket under a history/ prefix.
 */
import multer from 'multer'
import { supabaseAdmin } from '../shared.js'
import { requireAuth } from '../middleware.js'
import { carfaxDeepLink } from '../providers/history.js'

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 1 } })
const str = (v) => { const s = (v == null ? '' : String(v)).trim(); return s || null }
const REPORT_TYPES = ['vhr', 'lien', 'valuation', 'other']

export function registerHistory(app) {
  // Carfax (or other) deep-link for a VIN — where to pull the report.
  app.get('/history/link', requireAuth, async (req, res) => {
    const vin = str(req.query.vin)
    const country = String(req.query.country || 'CA').toUpperCase() === 'US' ? 'US' : 'CA'
    res.json({ ok: true, url: carfaxDeepLink(vin, country) })
  })

  // List stored reports for a vehicle / deal / customer / VIN.
  app.get('/history', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.json({ reports: [] })
    let q = supabaseAdmin.from('vehicle_history_reports')
      .select('id, vin, provider, report_type, external_url, file_url, summary, pulled_by, created_at')
      .eq('dealership_id', req.dealershipId).order('created_at', { ascending: false }).limit(50)
    const inv = str(req.query.inventory_id), vin = str(req.query.vin), contact = str(req.query.contact_id), deal = str(req.query.deal_id)
    if (inv) q = q.eq('inventory_id', inv)
    else if (deal) q = q.eq('deal_id', deal)
    else if (contact) q = q.eq('contact_id', contact)
    else if (vin) q = q.ilike('vin', vin)
    else return res.json({ reports: [] })   // require a scope
    const { data } = await q
    res.json({ ok: true, reports: data || [] })
  })

  // Save a report — an attached PDF (multipart 'file') and/or an external link.
  app.post('/history', requireAuth, upload.single('file'), async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership' })
    const b = req.body || {}
    const vin = str(b.vin)
    const external_url = str(b.external_url)
    const f = req.file
    if (!f && !external_url) return res.status(400).json({ error: 'Attach a file or provide a report link.' })

    let file_url = null, file_path = null
    if (f) {
      const safe = (f.originalname || 'report.pdf').replace(/[^\w.\-]+/g, '_').slice(-80)
      file_path = `history/${req.dealershipId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safe}`
      const { error: upErr } = await supabaseAdmin.storage.from('vehicle-pdfs')
        .upload(file_path, f.buffer, { contentType: f.mimetype || 'application/pdf', upsert: false })
      if (upErr) { console.warn('[history] upload failed:', upErr.message); return res.status(500).json({ error: 'Upload failed' }) }
      file_url = supabaseAdmin.storage.from('vehicle-pdfs').getPublicUrl(file_path).data.publicUrl
    }

    const row = {
      dealership_id: req.dealershipId,
      inventory_id: str(b.inventory_id), contact_id: str(b.contact_id), deal_id: str(b.deal_id),
      vin, provider: str(b.provider) || 'carfax',
      report_type: REPORT_TYPES.includes(b.report_type) ? b.report_type : 'vhr',
      external_url, file_url, file_path,
      summary: (() => { try { return b.summary ? JSON.parse(b.summary) : null } catch { return null } })(),
      pulled_by: req.user?.id || null,
    }
    const { data, error } = await supabaseAdmin.from('vehicle_history_reports').insert(row)
      .select('id, vin, provider, report_type, external_url, file_url, summary, pulled_by, created_at').single()
    if (error) { console.error('[history] save failed:', error.message); return res.status(500).json({ error: 'Save failed' }) }
    res.json({ ok: true, report: data })
  })

  // Delete a stored report (and its file).
  app.delete('/history/:id', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership' })
    const { data: r } = await supabaseAdmin.from('vehicle_history_reports')
      .select('id, file_path').eq('id', req.params.id).eq('dealership_id', req.dealershipId).maybeSingle()
    if (!r) return res.status(404).json({ error: 'Not found' })
    try { if (r.file_path) await supabaseAdmin.storage.from('vehicle-pdfs').remove([r.file_path]) } catch (e) { console.warn('[history] remove failed:', e.message) }
    await supabaseAdmin.from('vehicle_history_reports').delete().eq('id', r.id).eq('dealership_id', req.dealershipId)
    res.json({ ok: true })
  })
}
