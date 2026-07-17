import { supabaseAdmin, resend, EMAIL_FROM } from '../shared.js'
import { requireAuth } from '../middleware.js'
import { findOrCreateContact } from './crm.js'
import { routeAndNotifyLead } from '../lead-routing.js'

const xmlEsc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]))

// ── CSV import/export (#19) — dependency-free, RFC-4180-ish ──────────────────
const LEAD_CSV_COLS = ['name', 'email', 'phone', 'source', 'status', 'comments', 'vehicle', 'rep', 'created_at']
function csvCell(v) {
  const s = v == null ? '' : String(v)
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
}
function toCsv(rows) {
  const head = LEAD_CSV_COLS.join(',')
  const body = rows.map(r => LEAD_CSV_COLS.map(c => csvCell(r[c])).join(',')).join('\n')
  return head + '\n' + body + '\n'
}
function parseCsv(text) {
  const rows = []
  let row = [], cell = '', i = 0, q = false
  const s = String(text).replace(/^﻿/, '')   // strip BOM
  while (i < s.length) {
    const ch = s[i]
    if (q) {
      if (ch === '"') { if (s[i + 1] === '"') { cell += '"'; i += 2; continue } q = false; i++; continue }
      cell += ch; i++; continue
    }
    if (ch === '"') { q = true; i++; continue }
    if (ch === ',') { row.push(cell); cell = ''; i++; continue }
    if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++
      row.push(cell); rows.push(row); row = []; cell = ''; i++; continue
    }
    cell += ch; i++
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row) }
  return rows.filter(r => r.length && r.some(c => String(c).trim() !== ''))
}

// Build a standard ADF (Auto-lead Data Format) XML document that any dealer CRM
// can ingest. https://www.adfxml.info/
function buildAdf(lead, vehicle, dealerName, rep) {
  const now = new Date().toISOString()
  const nameParts = String(lead.name || 'Unknown').trim()
  // Salesperson attribution: most CRMs (VinSolutions, DealerSocket, Elead) read the
  // assigned rep from a <salesperson> contact inside <vendor>. We also append it to
  // the comments so it's visible even on parsers that ignore the element.
  const repName = rep && rep.name ? String(rep.name).trim() : ''
  const salespersonXml = repName ? `
      <contact>
        <name part="full" type="individual">${xmlEsc(repName)}</name>
        ${rep.email ? `<email>${xmlEsc(rep.email)}</email>` : ''}
        ${rep.phone ? `<phone type="voice">${xmlEsc(rep.phone)}</phone>` : ''}
      </contact>` : ''
  const veh = vehicle ? `
    <vehicle interest="buy" status="${xmlEsc((vehicle.condition || 'used').toLowerCase())}">
      ${vehicle.year ? `<year>${xmlEsc(vehicle.year)}</year>` : ''}
      ${vehicle.make ? `<make>${xmlEsc(vehicle.make)}</make>` : ''}
      ${vehicle.model ? `<model>${xmlEsc(vehicle.model)}</model>` : ''}
      ${vehicle.trim ? `<trim>${xmlEsc(vehicle.trim)}</trim>` : ''}
      ${vehicle.vin ? `<vin>${xmlEsc(vehicle.vin)}</vin>` : ''}
      ${vehicle.stocknumber ? `<stock>${xmlEsc(vehicle.stocknumber)}</stock>` : ''}
      ${vehicle.price ? `<price type="asking" currency="CAD">${xmlEsc(vehicle.price)}</price>` : ''}
    </vehicle>` : ''

  return `<?xml version="1.0" encoding="UTF-8"?>
<?adf version="1.0"?>
<adf>
  <prospect status="new">
    <requestdate>${now}</requestdate>${veh}
    <customer>
      <contact>
        <name part="full" type="individual">${xmlEsc(nameParts)}</name>
        ${lead.email ? `<email>${xmlEsc(lead.email)}</email>` : ''}
        ${lead.phone ? `<phone type="voice" time="nopreference">${xmlEsc(lead.phone)}</phone>` : ''}
      </contact>
      <comments>${xmlEsc([lead.comments, repName ? `Salesperson: ${repName}` : ''].filter(Boolean).join(' — '))}</comments>
    </customer>
    <vendor>
      <vendorname>${xmlEsc(dealerName || 'Dealership')}</vendorname>${salespersonXml}
    </vendor>
    <provider>
      <name part="full">MarketSync</name>
      <service>Facebook Marketplace</service>
    </provider>
  </prospect>
</adf>`
}

export function registerLeads(app) {
  // List leads for the dealership (reps see their own; dealer-level sees all).
  app.get('/leads', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.json({ leads: [], crm_adf_email: null })
    const dealerLevel = ['DEALER_ADMIN', 'OWNER', 'MANAGER'].includes(req.profile.role)
    let q = supabaseAdmin.from('leads')
      .select('id, name, email, phone, comments, source, status, adf_sent_at, adf_error, inventory_id, contact_id, created_by, created_at, responded_at, responded_by')
      .eq('dealership_id', req.dealershipId)
      .order('created_at', { ascending: false })
      .limit(300)
    if (!dealerLevel) {
      // A rep sees leads they logged OR leads whose linked contact is assigned to
      // them — the latter covers website leads auto-routed to the rep, which have
      // no created_by (nobody keyed them in) but do own the contact.
      const { data: mine } = await supabaseAdmin.from('contacts')
        .select('id').eq('dealership_id', req.dealershipId).eq('assigned_rep', req.user.id).limit(2000)
      const ids = (mine || []).map(c => c.id)
      q = ids.length
        ? q.or(`created_by.eq.${req.user.id},contact_id.in.(${ids.join(',')})`)
        : q.eq('created_by', req.user.id)
    }
    const { data, error } = await q
    if (error) return res.status(500).json({ error: error.message })

    // Who owns each lead: prefer the linked contact's assigned rep (the routed
    // owner the notification announced), falling back to whoever keyed it in. This
    // keeps the list in step with the "Assigned to …" alert for website leads.
    const contactIds = [...new Set((data || []).map(l => l.contact_id).filter(Boolean))]
    let assignedByContact = {}
    if (contactIds.length) {
      const { data: cs } = await supabaseAdmin.from('contacts').select('id, assigned_rep').in('id', contactIds)
      assignedByContact = Object.fromEntries((cs || []).map(c => [c.id, c.assigned_rep]).filter(([, r]) => r))
    }
    const repIds = [...new Set([...(data || []).map(l => l.created_by), ...(data || []).map(l => l.responded_by), ...Object.values(assignedByContact)].filter(Boolean))]
    let repNames = {}
    if (repIds.length) {
      const { data: reps } = await supabaseAdmin
        .from('profiles').select('id, full_name, display_name').in('id', repIds)
      repNames = Object.fromEntries((reps || []).map(r => [r.id, r.full_name || r.display_name || '—']))
    }
    const leads = (data || []).map(l => {
      const ownerId = assignedByContact[l.contact_id] || l.created_by || null
      return { ...l, rep: ownerId ? (repNames[ownerId] || null) : null, owner_id: ownerId, responded_by_name: l.responded_by ? (repNames[l.responded_by] || null) : null }
    })

    const { data: dealer } = await supabaseAdmin
      .from('dealerships').select('crm_adf_email').eq('id', req.dealershipId).maybeSingle()

    // Managers/dealer-admins can reassign leads — hand the roster to the picker.
    let reps = []
    if (dealerLevel) {
      const { data: r } = await supabaseAdmin
        .from('profiles').select('id, full_name, display_name').eq('dealership_id', req.dealershipId)
      reps = (r || []).map(p => ({ id: p.id, name: p.display_name || p.full_name || '—' }))
    }
    res.json({ leads, crm_adf_email: dealer?.crm_adf_email || null, can_configure: dealerLevel, can_reassign: dealerLevel, reps })
  })

  // Reassign a lead to a different salesperson (manager/dealer-admin only). Ownership
  // lives on the linked contact's assigned_rep — the same field the routing + list use.
  app.put('/leads/:id/assign', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership associated' })
    if (!['DEALER_ADMIN', 'OWNER', 'MANAGER'].includes(req.profile.role)) {
      return res.status(403).json({ error: 'Manager access required' })
    }
    const repId = req.body?.rep_id || null
    const { data: lead } = await supabaseAdmin.from('leads')
      .select('id, contact_id').eq('id', req.params.id).eq('dealership_id', req.dealershipId).maybeSingle()
    if (!lead) return res.status(404).json({ error: 'Lead not found' })
    if (!lead.contact_id) return res.status(400).json({ error: 'This lead has no linked contact to reassign.' })
    const { error } = await supabaseAdmin.from('contacts')
      .update({ assigned_rep: repId }).eq('id', lead.contact_id).eq('dealership_id', req.dealershipId)
    if (error) return res.status(500).json({ error: error.message })
    res.json({ ok: true })
  })

  // Mark a lead as answered — stops the speed-to-lead clock. First response wins
  // (idempotent: a second call won't overwrite the original answer time). Any user in
  // the dealership can answer; we record who did for the per-rep report.
  app.post('/leads/:id/answered', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership associated' })
    const { data: lead } = await supabaseAdmin.from('leads')
      .select('id, responded_at, created_at').eq('id', req.params.id).eq('dealership_id', req.dealershipId).maybeSingle()
    if (!lead) return res.status(404).json({ error: 'Lead not found' })
    if (lead.responded_at) return res.json({ ok: true, responded_at: lead.responded_at, already: true })
    const now = new Date().toISOString()
    const { error } = await supabaseAdmin.from('leads')
      .update({ responded_at: now, responded_by: req.user.id }).eq('id', lead.id).eq('dealership_id', req.dealershipId)
    if (error) return res.status(500).json({ error: error.message })
    const seconds = Math.max(0, Math.round((new Date(now) - new Date(lead.created_at)) / 1000))
    res.json({ ok: true, responded_at: now, response_seconds: seconds })
  })

  // Speed-to-lead reporting (manager/dealer-admin). Aggregates time-to-answer over a
  // window: overall median/avg, how many were answered inside 5/15/60 min, still-open
  // count, and a per-responder breakdown. All timing is created_at → responded_at.
  app.get('/leads/response-metrics', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership associated' })
    if (!['DEALER_ADMIN', 'OWNER', 'MANAGER'].includes(req.profile.role)) {
      return res.status(403).json({ error: 'Manager access required' })
    }
    const days = Math.min(365, Math.max(1, parseInt(req.query.days) || 30))
    const since = new Date(Date.now() - days * 86400000).toISOString()
    const { data, error } = await supabaseAdmin.from('leads')
      .select('created_at, responded_at, responded_by')
      .eq('dealership_id', req.dealershipId).gte('created_at', since).limit(10000)
    if (error) return res.status(500).json({ error: error.message })
    const rows = data || []
    const answered = rows.filter(l => l.responded_at)
    const secs = answered.map(l => Math.max(0, Math.round((new Date(l.responded_at) - new Date(l.created_at)) / 1000))).sort((a, b) => a - b)
    const median = secs.length ? (secs.length % 2 ? secs[(secs.length - 1) / 2] : Math.round((secs[secs.length / 2 - 1] + secs[secs.length / 2]) / 2)) : null
    const avg = secs.length ? Math.round(secs.reduce((a, b) => a + b, 0) / secs.length) : null
    const within = (n) => secs.filter(s => s <= n).length
    // Per-responder answered counts + median.
    const byRep = {}
    for (const l of answered) {
      const k = l.responded_by || 'unknown'
      const s = Math.max(0, Math.round((new Date(l.responded_at) - new Date(l.created_at)) / 1000))
      ;(byRep[k] = byRep[k] || []).push(s)
    }
    const repIds = Object.keys(byRep).filter(k => k !== 'unknown')
    let repNames = {}
    if (repIds.length) {
      const { data: reps } = await supabaseAdmin.from('profiles').select('id, full_name, display_name').in('id', repIds)
      repNames = Object.fromEntries((reps || []).map(r => [r.id, r.full_name || r.display_name || '—']))
    }
    const per_rep = Object.entries(byRep).map(([k, arr]) => {
      const sorted = arr.sort((a, b) => a - b)
      const med = sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : Math.round((sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2)
      return { rep: k === 'unknown' ? 'Unknown' : (repNames[k] || '—'), answered: arr.length, median_seconds: med }
    }).sort((a, b) => a.median_seconds - b.median_seconds)
    res.json({
      days, total: rows.length, answered: answered.length, unanswered: rows.length - answered.length,
      median_seconds: median, avg_seconds: avg,
      within_5min: within(300), within_15min: within(900), within_60min: within(3600),
      per_rep,
    })
  })

  // Export leads as CSV. Reps get their own; dealer-level gets the whole team.
  app.get('/leads/export.csv', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership' })
    const dealerLevel = ['DEALER_ADMIN', 'OWNER', 'MANAGER'].includes(req.profile.role)
    let q = supabaseAdmin.from('leads')
      .select('name, email, phone, source, status, comments, inventory_id, contact_id, created_by, created_at')
      .eq('dealership_id', req.dealershipId).order('created_at', { ascending: false }).limit(5000)
    if (!dealerLevel) q = q.eq('created_by', req.user.id)
    const { data, error } = await q
    if (error) return res.status(500).json({ error: error.message })
    // Resolve vehicle labels + rep names in bulk. Owner = contact's assigned rep
    // (the routed owner) with the keyed-in creator as a fallback.
    const invIds = [...new Set((data || []).map(l => l.inventory_id).filter(Boolean))]
    const contactIds = [...new Set((data || []).map(l => l.contact_id).filter(Boolean))]
    let assignedByContact = {}
    if (contactIds.length) {
      const { data: cs } = await supabaseAdmin.from('contacts').select('id, assigned_rep').in('id', contactIds)
      assignedByContact = Object.fromEntries((cs || []).map(c => [c.id, c.assigned_rep]).filter(([, r]) => r))
    }
    const repIds = [...new Set([...(data || []).map(l => l.created_by), ...Object.values(assignedByContact)].filter(Boolean))]
    let veh = {}, reps = {}
    if (invIds.length) {
      const { data: iv } = await supabaseAdmin.from('inventory').select('id, year, make, model, trim').in('id', invIds)
      veh = Object.fromEntries((iv || []).map(v => [v.id, [v.year, v.make, v.model, v.trim].filter(Boolean).join(' ')]))
    }
    if (repIds.length) {
      const { data: rp } = await supabaseAdmin.from('profiles').select('id, full_name, display_name').in('id', repIds)
      reps = Object.fromEntries((rp || []).map(r => [r.id, r.full_name || r.display_name || '']))
    }
    const rows = (data || []).map(l => ({
      name: l.name, email: l.email, phone: l.phone, source: l.source, status: l.status,
      comments: l.comments, vehicle: veh[l.inventory_id] || '',
      rep: reps[assignedByContact[l.contact_id] || l.created_by] || '',
      created_at: l.created_at,
    }))
    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="leads-${new Date().toISOString().slice(0, 10)}.csv"`)
    res.send(toCsv(rows))
  })

  // Import leads from CSV (manager only). Matches header names to fields; each row
  // becomes a lead + CRM contact (deduped) and is routed/notified like a normal lead.
  app.post('/leads/import', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership' })
    if (!['DEALER_ADMIN', 'OWNER', 'MANAGER'].includes(req.profile.role)) return res.status(403).json({ error: 'Manager access required' })
    const csv = String(req.body?.csv || '')
    if (!csv.trim()) return res.status(400).json({ error: 'Empty file' })
    const rows = parseCsv(csv)
    if (rows.length < 2) return res.status(400).json({ error: 'No data rows found' })
    const header = rows[0].map(h => String(h).trim().toLowerCase().replace(/\s+/g, '_'))
    const idx = (name) => header.indexOf(name)
    const iName = idx('name'), iEmail = idx('email'), iPhone = idx('phone'), iSource = idx('source'), iComments = idx('comments'), iStatus = idx('status')
    if (iName < 0 && iEmail < 0 && iPhone < 0) return res.status(400).json({ error: 'CSV needs at least a name, email, or phone column' })
    let created = 0, skipped = 0
    const errors = []
    for (let r = 1; r < rows.length; r++) {
      const cells = rows[r]
      const get = (i) => (i >= 0 && i < cells.length ? String(cells[i]).trim() : '')
      const name = get(iName).slice(0, 120), email = get(iEmail).slice(0, 160), phone = get(iPhone).slice(0, 40)
      if (!name && !email && !phone) { skipped++; continue }
      try {
        const { data: lead, error } = await supabaseAdmin.from('leads').insert({
          dealership_id: req.dealershipId, created_by: req.user.id,
          name: name || null, email: email || null, phone: phone || null,
          comments: get(iComments).slice(0, 2000) || null,
          source: get(iSource).slice(0, 80) || 'Import',
          status: get(iStatus).slice(0, 40) || null,
        }).select('id').single()
        if (error) { errors.push(`Row ${r + 1}: ${error.message}`); continue }
        const contactId = await findOrCreateContact({
          dealershipId: req.dealershipId, name, email, phone, repId: req.user.id, source: get(iSource) || 'Import',
        })
        if (contactId && lead?.id) {
          await supabaseAdmin.from('leads').update({ contact_id: contactId }).eq('id', lead.id)
          routeAndNotifyLead(req.dealershipId, { contactId, vehicleId: null, name, source: get(iSource) || 'Import' })
        }
        created++
      } catch (e) { errors.push(`Row ${r + 1}: ${e.message}`) }
    }
    res.json({ ok: true, created, skipped, errors: errors.slice(0, 20) })
  })

  // Capture a lead and (if a CRM address is set) deliver it as ADF XML by email.
  app.post('/leads', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership' })
    const { name, email, phone, comments, inventory_id, source } = req.body || {}
    if (!name && !email && !phone) return res.status(400).json({ error: 'Enter at least a name, phone, or email' })

    // Attach the vehicle of interest when one is chosen (verify it's ours).
    let vehicle = null
    if (inventory_id) {
      const { data: v } = await supabaseAdmin
        .from('inventory').select('id, year, make, model, trim, vin, stocknumber, price, condition, dealership_id')
        .eq('id', inventory_id).maybeSingle()
      if (v && v.dealership_id === req.dealershipId) vehicle = v
    }

    const { data: lead, error } = await supabaseAdmin
      .from('leads')
      .insert({
        dealership_id: req.dealershipId,
        created_by: req.user.id,
        inventory_id: vehicle?.id || null,
        name: name || null, email: email || null, phone: phone || null,
        comments: comments || null, source: source || 'Facebook Marketplace',
      })
      .select().single()
    if (error) return res.status(500).json({ error: error.message })

    // Land this lead on a unified CRM contact (dedupe by email/phone) so the
    // built-in CRM stays populated automatically — no double entry.
    try {
      const contactId = await findOrCreateContact({
        dealershipId: req.dealershipId, name: lead.name, email: lead.email,
        phone: lead.phone, repId: req.user.id, source: lead.source,
      })
      if (contactId) {
        await supabaseAdmin.from('leads').update({ contact_id: contactId }).eq('id', lead.id)
        // Auto-assign to the right team + notify management (fire-and-forget).
        routeAndNotifyLead(req.dealershipId, { contactId, vehicleId: vehicle?.id || null, name: lead.name, source: lead.source })
      }
    } catch (e) { console.warn('[leads] contact link failed:', e.message) }

    // Deliver to the CRM via ADF email when configured.
    const { data: dealer } = await supabaseAdmin
      .from('dealerships').select('name, crm_adf_email').eq('id', req.dealershipId).maybeSingle()
    // The salesperson who logged the lead — attached to the ADF for CRM attribution.
    const { data: repProfile } = await supabaseAdmin
      .from('profiles').select('full_name, display_name, phone').eq('id', req.user.id).maybeSingle()
    const rep = {
      name: repProfile?.full_name || repProfile?.display_name || '',
      email: req.user?.email || '',
      phone: repProfile?.phone || '',
    }
    let delivered = false
    if (dealer?.crm_adf_email && resend) {
      const adf = buildAdf(lead, vehicle, dealer.name, rep)
      try {
        await resend.emails.send({
          from: EMAIL_FROM,
          to: dealer.crm_adf_email,
          subject: `ADF Lead${vehicle ? ' — ' + [vehicle.year, vehicle.make, vehicle.model].filter(Boolean).join(' ') : ''}`,
          text: adf,
          attachments: [{ filename: 'lead.adf.xml', content: Buffer.from(adf).toString('base64') }],
        })
        await supabaseAdmin.from('leads').update({ adf_sent_at: new Date().toISOString(), status: 'sent' }).eq('id', lead.id)
        delivered = true
      } catch (e) {
        await supabaseAdmin.from('leads').update({ adf_error: e.message }).eq('id', lead.id)
      }
    }
    res.json({ ok: true, lead, delivered, crm_configured: !!dealer?.crm_adf_email })
  })

  // Dealer admins set/clear the CRM's ADF intake email.
  // Light read of just the CRM/DMS (ADF) connection — used by the Settings page.
  app.get('/leads/crm-email', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.json({ crm_adf_email: null, can_configure: false })
    const { data: dealer } = await supabaseAdmin
      .from('dealerships').select('crm_adf_email').eq('id', req.dealershipId).maybeSingle()
    res.json({ crm_adf_email: dealer?.crm_adf_email || null, can_configure: ['DEALER_ADMIN', 'OWNER', 'MANAGER'].includes(req.profile.role) })
  })

  // Lead routing config (auto-assignment + who gets notified).
  app.get('/leads/routing', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.json({ routing: {}, can_manage: false })
    const { data: d } = await supabaseAdmin.from('dealerships').select('lead_routing').eq('id', req.dealershipId).maybeSingle()
    const r = (d?.lead_routing && typeof d.lead_routing === 'object') ? d.lead_routing : {}
    res.json({ routing: { mode: r.mode === 'all' ? 'all' : 'targeted', notify_reps: r.notify_reps !== false, notify_managers: r.notify_managers !== false, notify_all_sales: !!r.notify_all_sales }, can_manage: ['DEALER_ADMIN', 'OWNER', 'MANAGER'].includes(req.profile.role) })
  })
  app.put('/leads/routing', requireAuth, async (req, res) => {
    if (!['DEALER_ADMIN', 'OWNER', 'MANAGER'].includes(req.profile.role)) return res.status(403).json({ error: 'Manager access required' })
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership' })
    const b = req.body || {}
    const routing = { mode: b.mode === 'all' ? 'all' : 'targeted', notify_reps: b.notify_reps !== false, notify_managers: b.notify_managers !== false, notify_all_sales: !!b.notify_all_sales }
    const { error } = await supabaseAdmin.from('dealerships').update({ lead_routing: routing }).eq('id', req.dealershipId)
    if (error) return res.status(500).json({ error: error.message })
    res.json({ ok: true, routing })
  })

  app.put('/leads/crm-email', requireAuth, async (req, res) => {
    if (!['DEALER_ADMIN', 'OWNER', 'MANAGER'].includes(req.profile.role)) {
      return res.status(403).json({ error: 'Dealer admin required' })
    }
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership' })
    const email = String(req.body?.crm_adf_email || '').trim() || null
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'Invalid email' })
    const { error } = await supabaseAdmin
      .from('dealerships').update({ crm_adf_email: email }).eq('id', req.dealershipId)
    if (error) return res.status(500).json({ error: error.message })
    res.json({ ok: true, crm_adf_email: email })
  })

  // Re-send a lead's ADF (e.g. after fixing the CRM address).
  app.post('/leads/:id/resend', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership' })
    const { data: lead } = await supabaseAdmin
      .from('leads').select('*').eq('id', req.params.id).eq('dealership_id', req.dealershipId).maybeSingle()
    if (!lead) return res.status(404).json({ error: 'Lead not found' })
    const { data: dealer } = await supabaseAdmin
      .from('dealerships').select('name, crm_adf_email').eq('id', req.dealershipId).maybeSingle()
    if (!dealer?.crm_adf_email) return res.status(400).json({ error: 'Set your CRM ADF email first' })
    if (!resend) return res.status(503).json({ error: 'Email not configured' })

    let vehicle = null
    if (lead.inventory_id) {
      const { data: v } = await supabaseAdmin.from('inventory')
        .select('id, year, make, model, trim, vin, stocknumber, price, condition').eq('id', lead.inventory_id).maybeSingle()
      vehicle = v || null
    }
    const adf = buildAdf(lead, vehicle, dealer.name)
    try {
      await resend.emails.send({
        from: EMAIL_FROM, to: dealer.crm_adf_email,
        subject: `ADF Lead (resend)${vehicle ? ' — ' + [vehicle.year, vehicle.make, vehicle.model].filter(Boolean).join(' ') : ''}`,
        text: adf,
        attachments: [{ filename: 'lead.adf.xml', content: Buffer.from(adf).toString('base64') }],
      })
      await supabaseAdmin.from('leads').update({ adf_sent_at: new Date().toISOString(), status: 'sent', adf_error: null }).eq('id', lead.id)
      res.json({ ok: true })
    } catch (e) {
      await supabaseAdmin.from('leads').update({ adf_error: e.message }).eq('id', lead.id)
      res.status(500).json({ error: e.message })
    }
  })
}
