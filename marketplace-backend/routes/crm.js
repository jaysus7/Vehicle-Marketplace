import { supabaseAdmin, resend, EMAIL_FROM } from '../shared.js'
import { requireAuth } from '../middleware.js'
import { enqueueForTrigger, markDelivered, freezeSequences } from './automation.js'
import { emitWebhook } from '../webhooks.js'
import multer from 'multer'

// CRM attachments: photos, videos and files reps attach to a customer. In-memory,
// 60 MB/file (room for a short phone video), up to 10 at once.
const attachUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 60 * 1024 * 1024, files: 10 } })
const attachKind = (mime) => /^image\//.test(mime) ? 'image' : /^video\//.test(mime) ? 'video' : 'file'

const DEALER_LEVEL = ['DEALER_ADMIN', 'OWNER', 'MANAGER']
const isDealerLevel = (req) => DEALER_LEVEL.includes(req.profile?.role)
const digits = (s) => String(s || '').replace(/\D/g, '')

const CONTACT_STATUSES = ['uncontacted', 'contacted', 'appointment', 'sold', 'fni', 'turnover', 'delivered', 'followup', 'lost']

// Map an incoming body to a writable contacts patch (shared by create + update).
// Only assigns keys the caller actually sent, so PATCH-style updates don't wipe
// fields. Trims/normalises identity + contact fields.
function contactPatchFromBody(b) {
  const p = {}
  const txt = (k, src = k) => { if (b[src] !== undefined) p[k] = b[src] === '' ? null : String(b[src]).trim() }
  txt('contact_type'); txt('full_name'); txt('first_name'); txt('middle_name'); txt('last_name'); txt('suffix')
  txt('company_name'); txt('address'); txt('city'); txt('province'); txt('postal_code'); txt('country')
  txt('phone_home'); txt('phone_mobile'); txt('phone_work'); txt('dl_number'); txt('source'); txt('notes')
  if (b.email !== undefined) p.email = b.email ? String(b.email).trim().toLowerCase() : null
  if (b.phone !== undefined) p.phone = b.phone ? String(b.phone).trim() : null
  if (b.birthday !== undefined) p.birthday = b.birthday || null
  if (b.dl_expiry !== undefined) p.dl_expiry = b.dl_expiry || null
  if (b.status !== undefined) p.status = CONTACT_STATUSES.includes(b.status) ? b.status : 'uncontacted'
  if (b.sold_source !== undefined) p.sold_source = b.sold_source ? String(b.sold_source).slice(0, 60) : null
  if (b.assigned_rep !== undefined) p.assigned_rep = b.assigned_rep || null
  if (b.tags !== undefined) p.tags = Array.isArray(b.tags) ? b.tags : []
  if (b.consent_email !== undefined) p.consent_email = !!b.consent_email
  if (b.consent_sms !== undefined) p.consent_sms = !!b.consent_sms
  if (b.dnc !== undefined) p.dnc = !!b.dnc
  if (b.trade_vehicle !== undefined) p.trade_vehicle = (b.trade_vehicle && typeof b.trade_vehicle === 'object') ? b.trade_vehicle : null
  if (b.interest_vehicle !== undefined) p.interest_vehicle = (b.interest_vehicle && typeof b.interest_vehicle === 'object') ? b.interest_vehicle : null
  if (b.interest_inventory_id !== undefined) p.interest_inventory_id = b.interest_inventory_id || null
  // Keep a sensible display name if only first/last were sent.
  if (p.full_name === undefined && (p.first_name || p.last_name)) {
    p.full_name = [p.first_name, p.middle_name, p.last_name].filter(Boolean).join(' ').trim() || null
  }
  if (p.contact_type === 'company' && !p.full_name && b.company_name) p.full_name = String(b.company_name).trim()
  return p
}

// Find an existing contact by email (then phone) within the dealership, or create
// one. Shared so leads + appraisals auto-populate the CRM — the whole point of
// owning it: every touchpoint lands on one customer record, no double entry.
// Best-effort: returns a contact id or null, never throws into the caller.
export async function findOrCreateContact({ dealershipId, name, email, phone, repId, source }) {
  if (!dealershipId) return null
  const em = String(email || '').trim().toLowerCase() || null
  const phd = digits(phone) || null
  try {
    let found = null
    if (em) {
      const { data } = await supabaseAdmin.from('contacts')
        .select('id').eq('dealership_id', dealershipId).ilike('email', em).limit(1).maybeSingle()
      found = data || null
    }
    if (!found && phd) {
      // Match on phone digits (stored phone may be formatted).
      const { data } = await supabaseAdmin.from('contacts')
        .select('id, phone').eq('dealership_id', dealershipId).limit(50)
      found = (data || []).find(c => digits(c.phone) === phd) || null
    }
    if (found) {
      await supabaseAdmin.from('contacts')
        .update({ last_activity_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq('id', found.id)
      return found.id
    }
    if (!em && !phd && !String(name || '').trim()) return null   // nothing to key on
    const { data: ins } = await supabaseAdmin.from('contacts').insert({
      dealership_id: dealershipId,
      full_name: String(name || '').trim() || 'Unknown',
      email: em, phone: String(phone || '').trim() || null,
      assigned_rep: repId || null, created_by: repId || null,
      source: source || 'Lead', status: 'uncontacted',
      last_activity_at: new Date().toISOString(),
    }).select('id').single()
    return ins?.id || null
  } catch (e) { console.warn('[crm] findOrCreateContact failed:', e.message); return null }
}

// Log a timeline entry against a contact (and bump its last_activity_at).
async function logComm({ dealershipId, contactId, channel, direction, subject, body, repId, meta }) {
  if (!dealershipId || !contactId) return null
  try {
    const { data } = await supabaseAdmin.from('communications').insert({
      dealership_id: dealershipId, contact_id: contactId,
      channel: channel || 'note', direction: direction || 'internal',
      subject: subject || null, body: body || null, rep_id: repId || null,
      meta: meta || null,
    }).select('*').single()
    await supabaseAdmin.from('contacts')
      .update({ last_activity_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('id', contactId)
    return data || null
  } catch (e) { console.warn('[crm] logComm failed:', e.message); return null }
}

// Keep CRM follow-ups and the task list in sync (#24): moving a contact to the
// "Follow-up" stage auto-opens a follow-up task (due next day) for its rep, unless
// one is already open. So a follow-up always shows up as an actionable task.
async function ensureFollowupTask(dealershipId, contact, actingUserId) {
  try {
    if (!dealershipId || !contact?.id) return
    const { data: open } = await supabaseAdmin.from('crm_tasks')
      .select('id').eq('contact_id', contact.id).eq('type', 'followup').eq('done', false).limit(1)
    if (open && open.length) return   // already has an open follow-up
    const due = new Date(); due.setDate(due.getDate() + 1); due.setHours(9, 0, 0, 0)
    const who = contact.name ? ` — ${contact.name}` : ''
    await supabaseAdmin.from('crm_tasks').insert({
      dealership_id: dealershipId, contact_id: contact.id,
      assigned_to: contact.assigned_rep || actingUserId || null,
      created_by: actingUserId || null,
      title: `Follow up${who}`, type: 'followup', due_at: due.toISOString(),
    })
  } catch (e) { console.warn('[crm] ensureFollowupTask failed:', e.message) }
}

export function registerCrm(app) {
  // ── Contacts list / search ────────────────────────────────────────────────
  // Browsing scope: reps see only contacts they own/created; managers see all and
  // can filter "by rep". SEARCH is different — ANYONE searching spans the whole
  // dealership (so a rep can find any customer by name/email/phone), because a
  // customer may have been entered by another rep.
  app.get('/crm/contacts', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.json({ contacts: [], can_see_all: false })
    // Strip PostgREST-significant chars so a comma/paren in the query can't break the or() filter.
    const q = String(req.query.q || '').trim().replace(/[(),]/g, ' ').trim()
    const status = String(req.query.status || '').trim()
    const repFilter = String(req.query.rep || '').trim()
    const scopeAll = String(req.query.scope || '').trim() === 'all'   // "Search Customers" = whole dealership
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit) || 200))
    const dealer = isDealerLevel(req)
    const searching = q.length > 0
    let query = supabaseAdmin.from('contacts')
      .select('id, full_name, email, phone, phone_mobile, assigned_rep, source, sold_source, status, tags, dnc, last_activity_at, created_at')
      .eq('dealership_id', req.dealershipId)
      .order('last_activity_at', { ascending: false, nullsFirst: false })
      .limit(limit)
    // Ownership scope applies only while BROWSING (no search) and NOT in the all-
    // customers "Search Customers" view. Search and scope=all see the whole store.
    if (!dealer && !searching && !scopeAll) query = query.or(`assigned_rep.eq.${req.user.id},created_by.eq.${req.user.id}`)
    // "By rep" filter — managers only (a rep can't browse another rep's whole book).
    if (repFilter && dealer) query = query.eq('assigned_rep', repFilter)
    if (status) { const list = status.split(',').map(s => s.trim()).filter(Boolean); query = list.length > 1 ? query.in('status', list) : query.eq('status', list[0]) }
    if (q) query = query.or(`full_name.ilike.%${q}%,email.ilike.%${q}%,phone.ilike.%${q}%,phone_mobile.ilike.%${q}%,company_name.ilike.%${q}%`)
    const { data, error } = await query
    if (error) return res.status(500).json({ error: error.message })

    const repIds = [...new Set((data || []).map(c => c.assigned_rep).filter(Boolean))]
    let reps = {}
    if (repIds.length) {
      const { data: rp } = await supabaseAdmin.from('profiles').select('id, full_name, display_name').in('id', repIds)
      reps = Object.fromEntries((rp || []).map(r => [r.id, r.full_name || r.display_name || '—']))
    }
    const contacts = (data || []).map(c => ({ ...c, rep_name: reps[c.assigned_rep] || null }))
    res.json({ contacts, can_see_all: dealer, searching })
  })

  // ── Create a contact manually ─────────────────────────────────────────────
  app.post('/crm/contacts', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership' })
    const b = req.body || {}
    const patch = contactPatchFromBody(b)
    // Primary phone falls back to whichever line was provided so quick-actions work.
    if (patch.phone == null) patch.phone = patch.phone_mobile || patch.phone_home || patch.phone_work || null
    const hasName = patch.full_name || patch.company_name || b.company_name
    if (!hasName && !patch.email && !patch.phone) return res.status(400).json({ error: 'Enter a name, phone, or email' })
    const { data, error } = await supabaseAdmin.from('contacts').insert({
      dealership_id: req.dealershipId,
      ...patch,
      full_name: patch.full_name || (b.company_name ? String(b.company_name).trim() : null) || 'Unknown',
      assigned_rep: patch.assigned_rep || b.assigned_rep || req.user.id,
      source: patch.source || 'Manual',
      status: patch.status || 'uncontacted',
      created_by: req.user.id,
      last_activity_at: new Date().toISOString(),
    }).select('*').single()
    if (error) return res.status(500).json({ error: error.message })
    res.json({ ok: true, contact: data })
  })

  // ── Contact detail: profile + unified timeline + open tasks ────────────────
  app.get('/crm/contacts/:id', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership' })
    const { data: contact } = await supabaseAdmin.from('contacts')
      .select('*').eq('id', req.params.id).eq('dealership_id', req.dealershipId).maybeSingle()
    if (!contact) return res.status(404).json({ error: 'Contact not found' })

    const [{ data: comms }, { data: leads }, { data: appraisals }, { data: tasks }, { data: attachments }, { data: deal }] = await Promise.all([
      supabaseAdmin.from('communications').select('*').eq('contact_id', contact.id).order('occurred_at', { ascending: false }).limit(200),
      supabaseAdmin.from('leads').select('id, comments, source, status, inventory_id, created_by, created_at').eq('contact_id', contact.id).order('created_at', { ascending: false }),
      supabaseAdmin.from('trade_appraisals').select('id, year, make, model, trim, vin, suggested_offer, currency, created_by, created_at').eq('contact_id', contact.id).order('created_at', { ascending: false }),
      supabaseAdmin.from('crm_tasks').select('*').eq('contact_id', contact.id).order('due_at', { ascending: true, nullsFirst: false }),
      supabaseAdmin.from('crm_attachments').select('id, url, filename, content_type, size, kind, uploaded_by, created_at').eq('contact_id', contact.id).order('created_at', { ascending: false }).then(r => r, () => ({ data: [] })),
      // A worked deal for this customer (if any) — powers the "View deal / Desk a deal" button.
      supabaseAdmin.from('deals').select('deal_number, deal_status').eq('contact_id', contact.id).eq('dealership_id', req.dealershipId).maybeSingle().then(r => r, () => ({ data: null })),
    ])

    // Resolve vehicle labels for pinned leads.
    const invIds = [...new Set((leads || []).map(l => l.inventory_id).filter(Boolean))]
    let vehicles = {}
    if (invIds.length) {
      const { data: inv } = await supabaseAdmin.from('inventory').select('id, year, make, model, trim, price, stocknumber').in('id', invIds)
      vehicles = Object.fromEntries((inv || []).map(v => [v.id, v]))
    }
    // Rep names across everything.
    const repIds = [...new Set([contact.assigned_rep, ...(comms || []).map(c => c.rep_id), ...(tasks || []).map(t => t.assigned_to)].filter(Boolean))]
    let reps = {}
    if (repIds.length) {
      const { data: rp } = await supabaseAdmin.from('profiles').select('id, full_name, display_name').in('id', repIds)
      reps = Object.fromEntries((rp || []).map(r => [r.id, r.full_name || r.display_name || '—']))
    }

    // Merge into one time-ordered timeline.
    const timeline = []
    for (const c of (comms || [])) timeline.push({ kind: 'comm', at: c.occurred_at, channel: c.channel, direction: c.direction, subject: c.subject, body: c.body, rep: reps[c.rep_id] || null, meta: c.meta })
    for (const l of (leads || [])) {
      const v = vehicles[l.inventory_id]
      timeline.push({ kind: 'lead', at: l.created_at, source: l.source, status: l.status, body: l.comments,
        vehicle: v ? [v.year, v.make, v.model, v.trim].filter(Boolean).join(' ') : null, rep: reps[l.created_by] || null })
    }
    for (const a of (appraisals || [])) timeline.push({ kind: 'appraisal', at: a.created_at,
      vehicle: [a.year, a.make, a.model, a.trim].filter(Boolean).join(' '), offer: a.suggested_offer, currency: a.currency,
      appraisal_id: a.id, rep: reps[a.created_by] || null })
    timeline.sort((x, y) => new Date(y.at) - new Date(x.at))

    // Resolve the "new car of interest" label from our stock, if pinned.
    let interest_vehicle_label = null
    if (contact.interest_inventory_id) {
      const { data: iv } = await supabaseAdmin.from('inventory')
        .select('year, make, model, trim, price, stocknumber').eq('id', contact.interest_inventory_id).maybeSingle()
      if (iv) interest_vehicle_label = { label: [iv.year, iv.make, iv.model, iv.trim].filter(Boolean).join(' '), price: iv.price, stocknumber: iv.stocknumber }
    } else if (contact.interest_vehicle) {
      const v = contact.interest_vehicle
      interest_vehicle_label = { label: [v.year, v.make, v.model, v.trim].filter(Boolean).join(' ') || null }
    }

    res.json({
      contact: { ...contact, rep_name: reps[contact.assigned_rep] || null, interest_vehicle_label },
      timeline,
      tasks: (tasks || []).map(t => ({ ...t, assignee_name: reps[t.assigned_to] || null })),
      attachments: attachments || [],
      deal: deal || null,
      can_see_all: isDealerLevel(req),
    })
  })

  // ── Attachments: reps attach photos / videos / files to a customer ─────────
  app.post('/crm/contacts/:id/attachments', requireAuth, attachUpload.array('files', 10), async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership' })
    const { data: contact } = await supabaseAdmin.from('contacts')
      .select('id').eq('id', req.params.id).eq('dealership_id', req.dealershipId).maybeSingle()
    if (!contact) return res.status(404).json({ error: 'Contact not found' })
    const files = req.files || []
    if (!files.length) return res.status(400).json({ error: 'No files uploaded' })
    const saved = []
    for (const f of files) {
      const safe = (f.originalname || 'file').replace(/[^\w.\-]+/g, '_').slice(-80)
      const path = `${req.dealershipId}/${contact.id}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safe}`
      const { error: upErr } = await supabaseAdmin.storage.from('crm-attachments')
        .upload(path, f.buffer, { contentType: f.mimetype || 'application/octet-stream', upsert: false })
      if (upErr) { console.warn('[crm-attach] upload failed:', upErr.message); continue }
      const { data: { publicUrl } } = supabaseAdmin.storage.from('crm-attachments').getPublicUrl(path)
      const { data: row } = await supabaseAdmin.from('crm_attachments').insert({
        dealership_id: req.dealershipId, contact_id: contact.id, uploaded_by: req.user.id,
        url: publicUrl, path, filename: f.originalname || safe, content_type: f.mimetype || null,
        size: f.size || null, kind: attachKind(f.mimetype || ''),
      }).select('id, url, filename, content_type, size, kind, uploaded_by, created_at').single()
      if (row) saved.push(row)
    }
    if (!saved.length) return res.status(500).json({ error: 'Upload failed' })
    res.json({ ok: true, attachments: saved })
  })

  app.delete('/crm/attachments/:id', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership' })
    const { data: att } = await supabaseAdmin.from('crm_attachments')
      .select('id, path').eq('id', req.params.id).eq('dealership_id', req.dealershipId).maybeSingle()
    if (!att) return res.status(404).json({ error: 'Attachment not found' })
    try { if (att.path) await supabaseAdmin.storage.from('crm-attachments').remove([att.path]) } catch (e) { console.warn('[crm-attach] remove failed:', e.message) }
    await supabaseAdmin.from('crm_attachments').delete().eq('id', att.id).eq('dealership_id', req.dealershipId)
    res.json({ ok: true })
  })

  // ── Update a contact ──────────────────────────────────────────────────────
  app.put('/crm/contacts/:id', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership' })
    // Grab the prior status so we can fire automation only on a real transition.
    const { data: before } = await supabaseAdmin.from('contacts')
      .select('status, sold_at').eq('id', req.params.id).eq('dealership_id', req.dealershipId).maybeSingle()
    const patch = { ...contactPatchFromBody(req.body || {}), updated_at: new Date().toISOString() }
    // Stamp the moment a deal is first marked won, so sales reports are period-bound.
    const WON = ['sold', 'fni', 'delivered']
    if (patch.status && WON.includes(patch.status) && !before?.sold_at) patch.sold_at = new Date().toISOString()
    const { data, error } = await supabaseAdmin.from('contacts')
      .update(patch).eq('id', req.params.id).eq('dealership_id', req.dealershipId).select('*').maybeSingle()
    if (error) return res.status(500).json({ error: error.message })
    if (!data) return res.status(404).json({ error: 'Contact not found' })
    // Pipeline-stage automation triggers (fire-and-forget, only on change).
    if (patch.status && patch.status !== before?.status) {
      const vehicleId = data.interest_inventory_id || null
      if (patch.status === 'delivered') markDelivered(req.dealershipId, data.id, vehicleId, data.assigned_rep)
      else if (patch.status === 'appointment') { enqueueForTrigger(req.dealershipId, 'appointment_booked', { contactId: data.id, vehicleId, repId: data.assigned_rep }); emitWebhook(req.dealershipId, 'appointment.booked', { contact_id: data.id, vehicle_id: vehicleId, assigned_to: data.assigned_rep || null }) }
      else if (patch.status === 'followup') ensureFollowupTask(req.dealershipId, data, req.user.id)
    }
    res.json({ ok: true, contact: data })
  })

  // ── Dealership rep roster (for the "assigned to" picker) ──────────────────
  app.get('/crm/reps', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.json({ reps: [] })
    const { data } = await supabaseAdmin.from('profiles')
      .select('id, full_name, display_name, role').eq('dealership_id', req.dealershipId)
    const reps = (data || []).map(r => ({ id: r.id, name: r.full_name || r.display_name || '—', role: r.role }))
      .sort((a, b) => a.name.localeCompare(b.name))
    res.json({ reps })
  })

  // ── Log an activity (note / call / text / email logged manually) ──────────
  app.post('/crm/contacts/:id/log', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership' })
    const { data: contact } = await supabaseAdmin.from('contacts')
      .select('id').eq('id', req.params.id).eq('dealership_id', req.dealershipId).maybeSingle()
    if (!contact) return res.status(404).json({ error: 'Contact not found' })
    const b = req.body || {}
    const channel = ['note', 'call', 'sms', 'email'].includes(b.channel) ? b.channel : 'note'
    const direction = ['in', 'out', 'internal'].includes(b.direction) ? b.direction : (channel === 'note' ? 'internal' : 'out')
    const comm = await logComm({
      dealershipId: req.dealershipId, contactId: contact.id, channel, direction,
      subject: b.subject || null, body: b.body || null, repId: req.user.id, meta: b.meta || null,
    })
    // A logged inbound reply (call/text/email from the customer) freezes automation.
    if (direction === 'in' && channel !== 'note') freezeSequences(contact.id, 'customer_replied')
    res.json({ ok: true, comm })
  })

  // ── Send an email to the contact via Resend, and log it ───────────────────
  // Real outbound (they already run Resend). Respects consent + DNC.
  app.post('/crm/contacts/:id/email', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership' })
    const { data: contact } = await supabaseAdmin.from('contacts')
      .select('*').eq('id', req.params.id).eq('dealership_id', req.dealershipId).maybeSingle()
    if (!contact) return res.status(404).json({ error: 'Contact not found' })
    if (!contact.email) return res.status(400).json({ error: 'Contact has no email address' })
    if (contact.dnc || contact.consent_email === false) return res.status(403).json({ error: 'Contact has opted out of email' })
    if (!resend) return res.status(503).json({ error: 'Email is not configured' })
    const subject = String(req.body?.subject || '').trim()
    const body = String(req.body?.body || '').trim()
    if (!subject || !body) return res.status(400).json({ error: 'Subject and message are required' })
    const { data: rep } = await supabaseAdmin.from('profiles').select('full_name, display_name, email_signature, email_reply_to').eq('id', req.user.id).maybeSingle()
    const repName = rep?.full_name || rep?.display_name || null
    // Signature: the rep's saved signature (Settings) if present, else just their name.
    // Reply-to: their chosen reply address (personal inbox) if set, else their login email —
    // so the customer's reply lands with the rep, not the shared MarketSync address.
    const sig = (rep?.email_signature || '').trim()
    const sigHtml = sig ? sig.replace(/\n/g, '<br>') : (repName || '')
    const replyTo = (rep?.email_reply_to || '').trim() || req.user.email || undefined
    try {
      const html = body.replace(/\n/g, '<br>')
      await resend.emails.send({
        from: EMAIL_FROM, to: contact.email, subject,
        html: `<div style="font-family:-apple-system,Segoe UI,Arial,sans-serif;color:#0f172a;line-height:1.5">${html}${sigHtml ? `<br><br>—<br>${sigHtml}` : ''}</div>`,
        reply_to: replyTo,
      })
      const comm = await logComm({
        dealershipId: req.dealershipId, contactId: contact.id, channel: 'email', direction: 'out',
        subject, body, repId: req.user.id, meta: { to: contact.email },
      })
      res.json({ ok: true, comm })
    } catch (e) { res.status(500).json({ error: e.message }) }
  })

  // ── Tasks: my queue ───────────────────────────────────────────────────────
  app.get('/crm/tasks', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.json({ tasks: [] })
    const scope = String(req.query.scope || 'open')   // open | all
    let query = supabaseAdmin.from('crm_tasks')
      .select('id, contact_id, assigned_to, title, type, due_at, done, done_at, created_at')
      .eq('dealership_id', req.dealershipId)
      .order('due_at', { ascending: true, nullsFirst: false }).limit(300)
    if (!isDealerLevel(req)) query = query.eq('assigned_to', req.user.id)
    if (scope === 'open') query = query.eq('done', false)
    const { data, error } = await query
    if (error) return res.status(500).json({ error: error.message })
    // Attach contact names for the queue view.
    const cids = [...new Set((data || []).map(t => t.contact_id).filter(Boolean))]
    let names = {}
    if (cids.length) {
      const { data: cs } = await supabaseAdmin.from('contacts').select('id, full_name').in('id', cids)
      names = Object.fromEntries((cs || []).map(c => [c.id, c.full_name]))
    }
    res.json({ tasks: (data || []).map(t => ({ ...t, contact_name: names[t.contact_id] || null })) })
  })

  // ── Tasks: create ─────────────────────────────────────────────────────────
  app.post('/crm/tasks', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership' })
    const b = req.body || {}
    const title = String(b.title || '').trim()
    if (!title) return res.status(400).json({ error: 'Task title is required' })
    const { data, error } = await supabaseAdmin.from('crm_tasks').insert({
      dealership_id: req.dealershipId,
      contact_id: b.contact_id || null,
      assigned_to: b.assigned_to || req.user.id,
      created_by: req.user.id,
      title, type: ['call', 'text', 'email', 'followup', 'appointment', 'other'].includes(b.type) ? b.type : 'followup',
      due_at: b.due_at || null,
    }).select('*').single()
    if (error) return res.status(500).json({ error: error.message })
    res.json({ ok: true, task: data })
  })

  // ── Tasks: update / complete ──────────────────────────────────────────────
  app.put('/crm/tasks/:id', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership' })
    const b = req.body || {}
    const patch = {}
    if (b.title !== undefined) patch.title = String(b.title).trim()
    if (b.type !== undefined) patch.type = b.type
    if (b.due_at !== undefined) patch.due_at = b.due_at || null
    if (b.assigned_to !== undefined) patch.assigned_to = b.assigned_to || null
    if (b.done !== undefined) { patch.done = !!b.done; patch.done_at = b.done ? new Date().toISOString() : null }
    const { data, error } = await supabaseAdmin.from('crm_tasks')
      .update(patch).eq('id', req.params.id).eq('dealership_id', req.dealershipId).select('*').maybeSingle()
    if (error) return res.status(500).json({ error: error.message })
    if (!data) return res.status(404).json({ error: 'Task not found' })
    res.json({ ok: true, task: data })
  })

  // ── CRM + Lead insights (#21) and sales-lead reports (#22) ─────────────────
  // Managers get the whole team; reps get their own book. One roll-up call powers
  // the Insights tab: lead volume + sources, pipeline funnel, rep leaderboard,
  // conversion, and open/overdue tasks — all over a selectable date range.
  app.get('/crm/insights', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.json({ ok: true, empty: true })
    const isMgr = isDealerLevel(req)
    const days = ({ '7': 7, '30': 30, '90': 90, '365': 365 }[String(req.query.range || '30')]) || 30
    const startIso = new Date(Date.now() - days * 86400000).toISOString()
    const prevStartIso = new Date(Date.now() - days * 2 * 86400000).toISOString()

    // Roster for names + leaderboard.
    const { data: staff } = await supabaseAdmin.from('profiles')
      .select('id, full_name, display_name, role').eq('dealership_id', req.dealershipId)
    const nameOf = (id) => { const p = (staff || []).find(s => s.id === id); return p ? (p.full_name || p.display_name || '—') : '—' }

    // Leads over the (double) window so we can compute a trend.
    let lq = supabaseAdmin.from('leads')
      .select('id, source, status, created_by, created_at, contact_id')
      .eq('dealership_id', req.dealershipId).gte('created_at', prevStartIso).limit(10000)
    if (!isMgr) lq = lq.eq('created_by', req.user.id)
    const { data: leadRows } = await lq
    const inWindow = (r) => r.created_at >= startIso
    const cur = (leadRows || []).filter(inWindow)
    const prev = (leadRows || []).filter(r => !inWindow(r))

    const tally = (rows, key, fallback) => {
      const m = {}
      for (const r of rows) { const k = (r[key] || fallback || 'Unknown'); m[k] = (m[k] || 0) + 1 }
      return Object.entries(m).map(([k, v]) => ({ key: k, count: v })).sort((a, b) => b.count - a.count)
    }
    const bySource = tally(cur, 'source', 'Website')
    const perRep = isMgr
      ? tally(cur, 'created_by').map(x => ({ rep_id: x.key, name: nameOf(x.key), count: x.count }))
      : []

    // Pipeline funnel from contacts (current book, not range-bound — it's a snapshot).
    let cq = supabaseAdmin.from('contacts')
      .select('status, assigned_rep, created_at').eq('dealership_id', req.dealershipId).limit(20000)
    if (!isMgr) cq = cq.eq('assigned_rep', req.user.id)
    const { data: contactRows } = await cq
    const funnelOrder = ['uncontacted', 'contacted', 'appointment', 'sold', 'fni', 'delivered', 'followup', 'lost']
    const funnelMap = {}
    for (const c of (contactRows || [])) { const s = c.status || 'uncontacted'; funnelMap[s] = (funnelMap[s] || 0) + 1 }
    const funnel = funnelOrder.map(s => ({ status: s, count: funnelMap[s] || 0 }))
    const totalContacts = (contactRows || []).length
    const wonContacts = (contactRows || []).filter(c => ['sold', 'fni', 'delivered'].includes(c.status)).length
    const conversionPct = totalContacts ? Math.round((wonContacts / totalContacts) * 1000) / 10 : 0

    // Tasks: open, overdue, due today.
    let tq = supabaseAdmin.from('crm_tasks')
      .select('assigned_to, due_at, done').eq('dealership_id', req.dealershipId).eq('done', false).limit(20000)
    if (!isMgr) tq = tq.eq('assigned_to', req.user.id)
    const { data: taskRows } = await tq
    const now = Date.now(); const endToday = new Date(); endToday.setHours(23, 59, 59, 999)
    const openTasks = (taskRows || []).length
    const overdueTasks = (taskRows || []).filter(t => t.due_at && new Date(t.due_at).getTime() < now).length
    const dueTodayTasks = (taskRows || []).filter(t => t.due_at && new Date(t.due_at).getTime() >= now && new Date(t.due_at).getTime() <= endToday.getTime()).length

    res.json({
      ok: true, range_days: days, is_manager: isMgr,
      leads: {
        total: cur.length, prev_total: prev.length,
        trend_pct: prev.length ? Math.round(((cur.length - prev.length) / prev.length) * 100) : (cur.length ? 100 : 0),
        by_source: bySource, per_rep: perRep,
      },
      pipeline: { funnel, total_contacts: totalContacts, won: wonContacts, conversion_pct: conversionPct },
      tasks: { open: openTasks, overdue: overdueTasks, due_today: dueTodayTasks },
    })
  })
}
