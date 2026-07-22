/**
 * Dealer Operations expense system — richer than a ledger line. Every expense can
 * be tied to an employee, department, VIN/stock #, repair order, PO, vendor,
 * payment method and receipt, with the GST/HST split out, an approval workflow and
 * a full audit trail. Approved expenses post to the ledger (gl_entries) so the
 * daily reconciliation and P&L include them. Reports answer the operational
 * questions a manager actually asks (recon cost per VIN, spend by vendor, by
 * salesperson, tax owed, outstanding reimbursements, …).
 */
import multer from 'multer'
import { supabaseAdmin } from '../shared.js'
import { requireAuth } from '../middleware.js'

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } })
const isMgr = (req) => ['DEALER_ADMIN', 'OWNER', 'MANAGER', 'ACCOUNTING'].includes(req.profile?.role)
const canApprove = (req) => ['DEALER_ADMIN', 'OWNER', 'MANAGER'].includes(req.profile?.role)   // controller / GM level
const n = (v) => { const x = Number(String(v ?? '').toString().replace(/[^0-9.\-]/g, '')); return Number.isFinite(x) ? x : 0 }
const round2 = (x) => Math.round((Number(x) || 0) * 100) / 100
const today = () => new Date().toISOString().slice(0, 10)
const DEPARTMENTS = ['Sales', 'Service', 'Parts', 'Finance', 'Administration', 'Detail', 'Body Shop']
const CATEGORIES = ['Advertising', 'Reconditioning', 'Detail', 'Fuel', 'Office Supplies', 'Parts', 'Service', 'Travel', 'Meals', 'Training', 'Warranty', 'Floorplan Interest', 'Auction Fees', 'Dealer Trade', 'OMVIC Fees', 'Licensing', 'Safety Inspection', 'Internal Repair Order', 'Demo Vehicle', 'Salesperson Reimbursement', 'Utilities', 'Rent', 'Other']
const PAYMENT_METHODS = ['credit_card', 'debit', 'cash', 'etransfer', 'cheque', 'account']
const STATUSES = ['draft', 'submitted', 'approved', 'rejected', 'paid']
const RECURRENCES = ['weekly', 'monthly', 'quarterly', 'annual']

const stamp = (actor, action, detail) => ({ at: new Date().toISOString(), actor: actor || null, action, detail: detail || null })

// Normalize the writable fields off a request body.
function fieldsFrom(b) {
  const out = {}
  const str = (k, max = 200) => { if (b[k] !== undefined) out[k] = b[k] === null ? null : String(b[k]).trim().slice(0, max) || null }
  str('category', 60); str('department', 40); str('vendor', 120); str('vin', 20); str('stock_number', 40)
  str('repair_order', 40); str('po_number', 40); str('payment_method', 30); str('card_last4', 8)
  str('receipt_url', 500); str('receipt_type', 12); str('recurrence', 20); str('notes', 2000)
  str('employee_name', 120)
  if (b.expense_date !== undefined) out.expense_date = /^\d{4}-\d{2}-\d{2}$/.test(b.expense_date || '') ? b.expense_date : today()
  if (b.amount !== undefined) out.amount = round2(n(b.amount))
  if (b.tax !== undefined) out.tax = round2(n(b.tax))
  if (b.vendor_id !== undefined) out.vendor_id = b.vendor_id || null
  if (b.employee_id !== undefined) out.employee_id = b.employee_id || null
  if (b.gl_account_id !== undefined) out.gl_account_id = b.gl_account_id || null
  if (b.reimbursable !== undefined) out.reimbursable = !!b.reimbursable
  if (b.reimbursed !== undefined) out.reimbursed = !!b.reimbursed
  if (b.recurring !== undefined) out.recurring = !!b.recurring
  if (b.mileage_km !== undefined) out.mileage_km = b.mileage_km === null ? null : n(b.mileage_km)
  if (b.mileage_rate !== undefined) out.mileage_rate = b.mileage_rate === null ? null : n(b.mileage_rate)
  if (out.payment_method && !PAYMENT_METHODS.includes(out.payment_method)) out.payment_method = 'account'
  if (out.recurrence && !RECURRENCES.includes(out.recurrence)) out.recurrence = null
  return out
}

// Post an approved expense to the ledger so reconciliation / P&L see it.
async function postToLedger(exp) {
  try {
    const { data } = await supabaseAdmin.from('gl_entries').insert({
      dealership_id: exp.dealership_id, entry_date: exp.expense_date,
      account_id: exp.gl_account_id || null,
      description: [exp.vendor, exp.category].filter(Boolean).join(' · ').slice(0, 200) || 'Expense',
      amount: Math.abs(Number(exp.amount) || 0), direction: 'out', source: 'expense',
    }).select('id').single()
    return data?.id || null
  } catch { return null }
}
async function unpostLedger(id) { if (id) { try { await supabaseAdmin.from('gl_entries').delete().eq('id', id).eq('source', 'expense') } catch {} } }

export function registerExpenses(app) {
  const guard = (req, res) => { if (!req.dealershipId) { res.status(400).json({ error: 'No dealership' }); return false } if (!isMgr(req)) { res.status(403).json({ error: 'Manager access required' }); return false } return true }

  // Static option lists for the form (categories, departments, etc.).
  app.get('/expenses/options', requireAuth, async (req, res) => {
    if (!guard(req, res)) return
    res.json({ ok: true, departments: DEPARTMENTS, categories: CATEGORIES, payment_methods: PAYMENT_METHODS, recurrences: RECURRENCES, statuses: STATUSES })
  })

  // ── Vendors ──────────────────────────────────────────────────────────────────
  app.get('/expense-vendors', requireAuth, async (req, res) => {
    if (!guard(req, res)) return
    const { data } = await supabaseAdmin.from('expense_vendors').select('*').eq('dealership_id', req.dealershipId).order('name', { ascending: true })
    res.json({ ok: true, vendors: data || [] })
  })
  app.post('/expense-vendors', requireAuth, async (req, res) => {
    if (!guard(req, res)) return
    const name = String(req.body?.name || '').trim().slice(0, 120)
    if (!name) return res.status(400).json({ error: 'Vendor name required' })
    const { data, error } = await supabaseAdmin.from('expense_vendors').insert({
      dealership_id: req.dealershipId, name, contact: String(req.body?.contact || '').slice(0, 200) || null, notes: String(req.body?.notes || '').slice(0, 500) || null,
    }).select().single()
    if (error) return res.status(500).json({ error: error.message })
    res.json({ ok: true, vendor: data })
  })
  app.delete('/expense-vendors/:id', requireAuth, async (req, res) => {
    if (!guard(req, res)) return
    await supabaseAdmin.from('expense_vendors').delete().eq('id', req.params.id).eq('dealership_id', req.dealershipId)
    res.json({ ok: true })
  })

  // ── Receipt upload (image or PDF) → storage, returns a URL ────────────────────
  app.post('/expenses/upload-receipt', requireAuth, upload.single('file'), async (req, res) => {
    if (!guard(req, res)) return
    if (!req.file) return res.status(400).json({ error: 'No file' })
    const mime = req.file.mimetype || ''
    const isPdf = mime === 'application/pdf'
    const ext = isPdf ? 'pdf' : (mime.split('/')[1] || 'jpg').replace('jpeg', 'jpg')
    if (!isPdf && !mime.startsWith('image/')) return res.status(400).json({ error: 'Upload an image or PDF' })
    const path = `${req.dealershipId}/expenses/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`
    const { error } = await supabaseAdmin.storage.from('vehicle-pdfs').upload(path, req.file.buffer, { contentType: mime, upsert: true })
    if (error) return res.status(500).json({ error: 'Upload failed' })
    const { data: { publicUrl } } = supabaseAdmin.storage.from('vehicle-pdfs').getPublicUrl(path)
    res.json({ ok: true, url: publicUrl, type: isPdf ? 'pdf' : 'image' })
  })

  // ── List with filters + search ────────────────────────────────────────────────
  app.get('/expenses', requireAuth, async (req, res) => {
    if (!guard(req, res)) return
    const q = req.query
    let query = supabaseAdmin.from('expenses').select('*').eq('dealership_id', req.dealershipId)
    if (q.from) query = query.gte('expense_date', String(q.from))
    if (q.to) query = query.lte('expense_date', String(q.to))
    if (q.category) query = query.eq('category', String(q.category))
    if (q.department) query = query.eq('department', String(q.department))
    if (q.status) query = query.eq('status', String(q.status))
    if (q.vin) query = query.ilike('vin', `%${String(q.vin)}%`)
    if (q.stock_number) query = query.ilike('stock_number', `%${String(q.stock_number)}%`)
    if (q.employee_id) query = query.eq('employee_id', String(q.employee_id))
    if (q.vendor) query = query.ilike('vendor', `%${String(q.vendor)}%`)
    if (q.payment_method) query = query.eq('payment_method', String(q.payment_method))
    if (q.reimbursable === '1') query = query.eq('reimbursable', true)
    if (q.outstanding === '1') { query = query.eq('reimbursable', true).eq('reimbursed', false) }
    if (q.q) query = query.or(`vendor.ilike.%${String(q.q)}%,notes.ilike.%${String(q.q)}%,category.ilike.%${String(q.q)}%,vin.ilike.%${String(q.q)}%,stock_number.ilike.%${String(q.q)}%`)
    query = query.order('expense_date', { ascending: false }).order('created_at', { ascending: false }).limit(Math.min(2000, parseInt(q.limit) || 500))
    const { data, error } = await query
    if (error) return res.status(500).json({ error: error.message })
    const rows = data || []
    const sum = round2(rows.reduce((s, e) => s + (Number(e.amount) || 0), 0))
    res.json({ ok: true, expenses: rows, sum, count: rows.length })
  })

  // ── CSV export (registered before /:id so 'export.csv' isn't read as an id) ─────
  app.get('/expenses/export.csv', requireAuth, async (req, res) => {
    if (!guard(req, res)) return
    const q = req.query
    let query = supabaseAdmin.from('expenses').select('*').eq('dealership_id', req.dealershipId)
    if (q.from) query = query.gte('expense_date', String(q.from))
    if (q.to) query = query.lte('expense_date', String(q.to))
    if (q.department) query = query.eq('department', String(q.department))
    if (q.category) query = query.eq('category', String(q.category))
    if (q.status) query = query.eq('status', String(q.status))
    if (q.vin) query = query.ilike('vin', `%${String(q.vin)}%`)
    if (q.employee_id) query = query.eq('employee_id', String(q.employee_id))
    const { data } = await query.order('expense_date', { ascending: false }).limit(10000)
    const cols = ['expense_date', 'vendor', 'category', 'department', 'employee_name', 'vin', 'stock_number', 'repair_order', 'po_number', 'payment_method', 'card_last4', 'subtotal', 'tax', 'amount', 'status', 'reimbursable', 'reimbursed', 'notes']
    const escc = (v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s }
    const lines = [cols.join(','), ...(data || []).map(r => cols.map(c => escc(r[c])).join(','))]
    res.setHeader('Content-Type', 'text/csv')
    res.setHeader('Content-Disposition', `attachment; filename="expenses-${today()}.csv"`)
    res.send(lines.join('\n'))
  })

  app.get('/expenses/:id', requireAuth, async (req, res) => {
    if (!guard(req, res)) return
    const { data } = await supabaseAdmin.from('expenses').select('*').eq('id', req.params.id).eq('dealership_id', req.dealershipId).maybeSingle()
    if (!data) return res.status(404).json({ error: 'Not found' })
    res.json({ ok: true, expense: data })
  })

  // ── Create ────────────────────────────────────────────────────────────────────
  app.post('/expenses', requireAuth, async (req, res) => {
    if (!guard(req, res)) return
    const f = fieldsFrom(req.body || {})
    // Mileage reimbursement: km × rate → amount when no explicit amount was entered.
    if ((!f.amount || f.amount === 0) && f.mileage_km && f.mileage_rate) { f.amount = round2(f.mileage_km * f.mileage_rate); f.reimbursable = true }
    f.subtotal = round2((f.amount || 0) - (f.tax || 0))
    const wantApproved = canApprove(req) && req.body?.status === 'approved'
    const row = {
      dealership_id: req.dealershipId, created_by: req.user?.id || null,
      ...f, status: wantApproved ? 'approved' : (STATUSES.includes(req.body?.status) ? req.body.status : 'submitted'),
      events: [stamp(req.user?.id, 'created', null)],
    }
    if (wantApproved) { row.approved_by = req.user?.id || null; row.approved_at = new Date().toISOString(); row.events.push(stamp(req.user?.id, 'approved', null)) }
    const { data, error } = await supabaseAdmin.from('expenses').insert(row).select().single()
    if (error) return res.status(500).json({ error: error.message })
    if (data.status === 'approved') { const glId = await postToLedger(data); if (glId) await supabaseAdmin.from('expenses').update({ posted: true, gl_entry_id: glId }).eq('id', data.id) }
    res.json({ ok: true, expense: data })
  })

  // ── Edit ──────────────────────────────────────────────────────────────────────
  app.put('/expenses/:id', requireAuth, async (req, res) => {
    if (!guard(req, res)) return
    const { data: cur } = await supabaseAdmin.from('expenses').select('*').eq('id', req.params.id).eq('dealership_id', req.dealershipId).maybeSingle()
    if (!cur) return res.status(404).json({ error: 'Not found' })
    if (cur.status === 'approved' && !canApprove(req)) return res.status(403).json({ error: 'Approved expenses can only be edited by a manager' })
    const f = fieldsFrom(req.body || {})
    if (f.amount !== undefined || f.tax !== undefined) f.subtotal = round2((f.amount ?? cur.amount) - (f.tax ?? cur.tax))
    const changed = Object.keys(f).filter(k => JSON.stringify(f[k]) !== JSON.stringify(cur[k]))
    const events = Array.isArray(cur.events) ? cur.events.slice(-49) : []
    events.push(stamp(req.user?.id, 'edited', changed.join(', ') || null))
    const { data, error } = await supabaseAdmin.from('expenses').update({ ...f, events, updated_at: new Date().toISOString() }).eq('id', req.params.id).eq('dealership_id', req.dealershipId).select().single()
    if (error) return res.status(500).json({ error: error.message })
    // Keep the posted ledger line in sync if amount/date/account changed on an approved expense.
    if (data.posted && data.gl_entry_id) { await supabaseAdmin.from('gl_entries').update({ entry_date: data.expense_date, amount: Math.abs(Number(data.amount) || 0), account_id: data.gl_account_id || null, description: [data.vendor, data.category].filter(Boolean).join(' · ').slice(0, 200) || 'Expense' }).eq('id', data.gl_entry_id) }
    res.json({ ok: true, expense: data })
  })

  app.delete('/expenses/:id', requireAuth, async (req, res) => {
    if (!guard(req, res)) return
    const { data: cur } = await supabaseAdmin.from('expenses').select('id, gl_entry_id, posted').eq('id', req.params.id).eq('dealership_id', req.dealershipId).maybeSingle()
    if (!cur) return res.json({ ok: true })
    if (cur.posted) await unpostLedger(cur.gl_entry_id)
    await supabaseAdmin.from('expenses').delete().eq('id', req.params.id).eq('dealership_id', req.dealershipId)
    res.json({ ok: true })
  })

  // ── Approval workflow ──────────────────────────────────────────────────────────
  app.post('/expenses/:id/approve', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership' })
    if (!canApprove(req)) return res.status(403).json({ error: 'Approver access required' })
    const { data: cur } = await supabaseAdmin.from('expenses').select('*').eq('id', req.params.id).eq('dealership_id', req.dealershipId).maybeSingle()
    if (!cur) return res.status(404).json({ error: 'Not found' })
    const events = (Array.isArray(cur.events) ? cur.events.slice(-49) : []); events.push(stamp(req.user?.id, 'approved', String(req.body?.note || '').slice(0, 200) || null))
    let glId = cur.gl_entry_id
    if (!cur.posted) glId = await postToLedger(cur)
    const { data, error } = await supabaseAdmin.from('expenses').update({ status: 'approved', approved_by: req.user?.id || null, approved_at: new Date().toISOString(), approver_note: String(req.body?.note || '').slice(0, 200) || null, posted: !!glId, gl_entry_id: glId, events, updated_at: new Date().toISOString() }).eq('id', req.params.id).select().single()
    if (error) return res.status(500).json({ error: error.message })
    res.json({ ok: true, expense: data })
  })
  app.post('/expenses/:id/reject', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership' })
    if (!canApprove(req)) return res.status(403).json({ error: 'Approver access required' })
    const { data: cur } = await supabaseAdmin.from('expenses').select('*').eq('id', req.params.id).eq('dealership_id', req.dealershipId).maybeSingle()
    if (!cur) return res.status(404).json({ error: 'Not found' })
    if (cur.posted) await unpostLedger(cur.gl_entry_id)
    const events = (Array.isArray(cur.events) ? cur.events.slice(-49) : []); events.push(stamp(req.user?.id, 'rejected', String(req.body?.note || '').slice(0, 200) || null))
    const { data, error } = await supabaseAdmin.from('expenses').update({ status: 'rejected', approver_note: String(req.body?.note || '').slice(0, 200) || null, posted: false, gl_entry_id: null, events, updated_at: new Date().toISOString() }).eq('id', req.params.id).select().single()
    if (error) return res.status(500).json({ error: error.message })
    res.json({ ok: true, expense: data })
  })
  // Mark a reimbursable expense as paid out to the employee.
  app.post('/expenses/:id/mark-reimbursed', requireAuth, async (req, res) => {
    if (!guard(req, res)) return
    const { data: cur } = await supabaseAdmin.from('expenses').select('events').eq('id', req.params.id).eq('dealership_id', req.dealershipId).maybeSingle()
    if (!cur) return res.status(404).json({ error: 'Not found' })
    const events = (Array.isArray(cur.events) ? cur.events.slice(-49) : []); events.push(stamp(req.user?.id, 'reimbursed', null))
    const { data, error } = await supabaseAdmin.from('expenses').update({ reimbursed: true, events, updated_at: new Date().toISOString() }).eq('id', req.params.id).eq('dealership_id', req.dealershipId).select().single()
    if (error) return res.status(500).json({ error: error.message })
    res.json({ ok: true, expense: data })
  })

  // ── Reports ────────────────────────────────────────────────────────────────────
  // type: department | employee | vin | vendor | category | reimbursements | tax | payment
  app.get('/expenses/report/:type', requireAuth, async (req, res) => {
    if (!guard(req, res)) return
    const type = req.params.type
    const from = String(req.query.from || (today().slice(0, 7) + '-01'))
    const to = String(req.query.to || today())
    let query = supabaseAdmin.from('expenses').select('*').eq('dealership_id', req.dealershipId).gte('expense_date', from).lte('expense_date', to)
    // For most reports, only count approved/paid spend; reimbursements report is by request.
    if (type !== 'reimbursements') query = query.in('status', ['approved', 'paid', 'submitted'])
    const { data } = await query.limit(5000)
    const rows = data || []
    const bucket = (keyFn, extra) => {
      const m = new Map()
      for (const e of rows) {
        const key = keyFn(e); if (key == null || key === '') continue
        const cur = m.get(key) || { key, total: 0, count: 0, tax: 0, ...(extra ? extra() : {}) }
        cur.total = round2(cur.total + (Number(e.amount) || 0)); cur.count++; cur.tax = round2(cur.tax + (Number(e.tax) || 0))
        if (extra) extra(cur, e)
        m.set(key, cur)
      }
      return [...m.values()].sort((a, b) => b.total - a.total)
    }
    let result
    if (type === 'department') result = bucket(e => e.department || 'Unassigned')
    else if (type === 'employee') result = bucket(e => e.employee_name || 'Unassigned')
    else if (type === 'vin') result = bucket(e => e.vin || null).map(r => ({ ...r, stock: (rows.find(e => e.vin === r.key) || {}).stock_number || null }))
    else if (type === 'vendor') result = bucket(e => e.vendor || 'Unknown')
    else if (type === 'category') result = bucket(e => e.category || 'Uncategorized')
    else if (type === 'payment') result = bucket(e => e.payment_method || 'Unknown')
    else if (type === 'tax') {
      const totalTax = round2(rows.reduce((s, e) => s + (Number(e.tax) || 0), 0))
      const totalSpend = round2(rows.reduce((s, e) => s + (Number(e.amount) || 0), 0))
      result = { total_tax: totalTax, total_spend: totalSpend, taxable_base: round2(totalSpend - totalTax), by_category: bucket(e => e.category || 'Uncategorized') }
    } else if (type === 'reimbursements') {
      const outstanding = rows.filter(e => e.reimbursable && !e.reimbursed)
      result = { outstanding_total: round2(outstanding.reduce((s, e) => s + (Number(e.amount) || 0), 0)), by_employee: (() => { const m = new Map(); for (const e of outstanding) { const k = e.employee_name || 'Unassigned'; const c = m.get(k) || { key: k, total: 0, count: 0 }; c.total = round2(c.total + (Number(e.amount) || 0)); c.count++; m.set(k, c) } return [...m.values()].sort((a, b) => b.total - a.total) })() }
    } else return res.status(400).json({ error: 'Unknown report type' })
    res.json({ ok: true, type, from, to, result })
  })
}
