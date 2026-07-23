/**
 * Dealer Task Management — the shared operational board that replaces whiteboards,
 * sticky notes and group texts. Detail, fuel, plates, safety, photos, order parts,
 * book transport, deliver… Each task has an assignee, due date, priority, status,
 * notes, photos, and can link to a VIN/stock # and a customer. Assigning a task
 * notifies the person. Distinct from CRM follow-up tasks (sales-cadence on a
 * contact); this is get-the-car-ready operations across every department.
 */
import multer from 'multer'
import { supabaseAdmin } from '../shared.js'
import { requireAuth } from '../middleware.js'
import { createNotification } from '../notifications.js'
import { RECON_STAGES, KIND_TO_STAGE, ensureReconCard } from './recon.js'
import { notifyTaskCompleted } from './workflow.js'

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } })
const KINDS = ['Detail', 'Fuel', 'Plates', 'Safety', 'Wash', 'Photos', 'Parts', 'Transport', 'Call', 'Deliver', 'Other']
const PRIORITIES = ['low', 'normal', 'high', 'urgent']
const STATUSES = ['todo', 'in_progress', 'blocked', 'done']
const today = () => new Date().toISOString().slice(0, 10)
const stamp = (actor, action, detail) => ({ at: new Date().toISOString(), actor: actor || null, action, detail: detail || null })

// Anyone in a dealership can use the board — it's shared ops. Managers see/assign
// everything; a rep or detailer sees the board too (they need their own tasks).
const inDealer = (req) => !!req.dealershipId

// Match a task's VIN/stock to an inventory unit (so it can join the Cleanup board).
async function resolveInventory(dealershipId, { vin, stock_number }) {
  if (!vin && !stock_number) return null
  try {
    let q = supabaseAdmin.from('inventory').select('id').eq('dealership_id', dealershipId).is('archived_at', null)
    if (vin && stock_number) q = q.or(`vin.eq.${vin},stocknumber.eq.${stock_number}`)
    else if (vin) q = q.eq('vin', vin)
    else q = q.eq('stocknumber', stock_number)
    const { data } = await q.limit(1).maybeSingle()
    return data?.id || null
  } catch { return null }
}

// When a get-ready task is completed, advance the car's Cleanup stage to match
// (forward only) — e.g. finishing "Detail" moves the unit to the Detail stage.
async function syncTaskToRecon(dealershipId, task, actorId) {
  const target = task?.inventory_id && KIND_TO_STAGE[task.kind]
  if (!target) return
  try {
    await ensureReconCard(dealershipId, task.inventory_id)
    const { data: card } = await supabaseAdmin.from('recon').select('stage').eq('dealership_id', dealershipId).eq('inventory_id', task.inventory_id).maybeSingle()
    const curIdx = RECON_STAGES.indexOf(card?.stage || 'arrived')
    const tgtIdx = RECON_STAGES.indexOf(target)
    if (tgtIdx > curIdx) {
      const now = new Date().toISOString()
      await supabaseAdmin.from('recon').update({ stage: target, stage_since: now, updated_at: now, done_at: target === 'frontline' ? now : null })
        .eq('dealership_id', dealershipId).eq('inventory_id', task.inventory_id)
    }
  } catch (e) { console.warn('[dealer-tasks] syncTaskToRecon failed:', e.message) }
}

// The standard get-ready checklist auto-created when a deal is sold/desked.
const DEAL_TASK_TEMPLATE = [
  { kind: 'Safety', title: 'Safety inspection', priority: 'high' },
  { kind: 'Detail', title: 'Detail vehicle', priority: 'normal' },
  { kind: 'Fuel', title: 'Fuel vehicle', priority: 'normal' },
  { kind: 'Plates', title: 'Install licence plates', priority: 'normal' },
  { kind: 'Photos', title: 'Take delivery photos', priority: 'low' },
  { kind: 'Deliver', title: 'Deliver vehicle', priority: 'high' },
]

// Auto-create the prep task set for a sold deal — once per deal (deduped on
// deal_id). Linked to the VIN/stock and customer so the board and the vehicle
// timeline line up. Safe to call on every deal save; it no-ops after the first.
export async function ensureDealTasks(dealershipId, { dealId, inventoryId = null, contactId = null, createdBy = null, dueDate = null } = {}) {
  if (!dealershipId || !dealId) return
  try {
    const { data: existing } = await supabaseAdmin.from('dealer_tasks').select('id').eq('dealership_id', dealershipId).eq('deal_id', dealId).limit(1)
    if (existing && existing.length) return   // already generated
    let vin = null, stock = null, contact_name = null
    if (inventoryId) { const { data: v } = await supabaseAdmin.from('inventory').select('vin, stock_number').eq('id', inventoryId).maybeSingle(); vin = v?.vin || null; stock = v?.stock_number || null }
    if (contactId) { const { data: c } = await supabaseAdmin.from('contacts').select('full_name').eq('id', contactId).maybeSingle(); contact_name = c?.full_name || null }
    const now = new Date().toISOString()
    const rows = DEAL_TASK_TEMPLATE.map(t => ({
      dealership_id: dealershipId, created_by: createdBy, deal_id: dealId, auto: true,
      title: t.title, kind: t.kind, priority: t.priority, status: 'todo',
      due_date: dueDate || null, vin, stock_number: stock, inventory_id: inventoryId || null, contact_id: contactId, contact_name,
      events: [{ at: now, actor: createdBy, action: 'created', detail: 'auto (desked deal)' }],
    }))
    await supabaseAdmin.from('dealer_tasks').insert(rows)
  } catch (e) { console.warn('[dealer-tasks] ensureDealTasks failed:', e.message) }
}

function fieldsFrom(b) {
  const out = {}
  const str = (k, max = 200) => { if (b[k] !== undefined) out[k] = b[k] === null ? null : String(b[k]).trim().slice(0, max) || null }
  str('title', 200); str('notes', 4000); str('vin', 20); str('stock_number', 40); str('contact_name', 120); str('assignee_name', 120)
  if (b.kind !== undefined) out.kind = KINDS.includes(b.kind) ? b.kind : (String(b.kind || '').slice(0, 40) || null)
  if (b.priority !== undefined) out.priority = PRIORITIES.includes(b.priority) ? b.priority : 'normal'
  if (b.status !== undefined) out.status = STATUSES.includes(b.status) ? b.status : 'todo'
  if (b.due_date !== undefined) out.due_date = /^\d{4}-\d{2}-\d{2}$/.test(b.due_date || '') ? b.due_date : null
  if (b.assignee_id !== undefined) out.assignee_id = b.assignee_id || null
  if (b.contact_id !== undefined) out.contact_id = b.contact_id || null
  if (Array.isArray(b.photos)) out.photos = b.photos.filter(u => typeof u === 'string').slice(0, 20)
  return out
}

export function registerDealerTasks(app) {
  const guard = (req, res) => { if (!inDealer(req)) { res.status(400).json({ error: 'No dealership' }); return false } return true }

  app.get('/dealer-tasks/options', requireAuth, async (req, res) => {
    if (!guard(req, res)) return
    res.json({ ok: true, kinds: KINDS, priorities: PRIORITIES, statuses: STATUSES })
  })

  // List with filters. `mine=1` limits to the caller; otherwise the whole board.
  app.get('/dealer-tasks', requireAuth, async (req, res) => {
    if (!guard(req, res)) return
    const q = req.query
    let query = supabaseAdmin.from('dealer_tasks').select('*').eq('dealership_id', req.dealershipId)
    if (q.status) query = query.eq('status', String(q.status))
    if (q.assignee_id) query = query.eq('assignee_id', String(q.assignee_id))
    if (q.mine === '1') query = query.eq('assignee_id', req.user.id)
    if (q.kind) query = query.eq('kind', String(q.kind))
    if (q.priority) query = query.eq('priority', String(q.priority))
    // Entity filters — power the Operations "Next Action" panel for one record.
    if (q.deal_id) query = query.eq('deal_id', String(q.deal_id))
    if (q.inventory_id) query = query.eq('inventory_id', String(q.inventory_id))
    if (q.contact_id) query = query.eq('contact_id', String(q.contact_id))
    if (q.vin) query = query.ilike('vin', `%${String(q.vin)}%`)
    if (q.q) query = query.or(`title.ilike.%${String(q.q)}%,notes.ilike.%${String(q.q)}%,vin.ilike.%${String(q.q)}%,stock_number.ilike.%${String(q.q)}%,contact_name.ilike.%${String(q.q)}%`)
    // Open first (todo/in_progress/blocked), newest due first; done last.
    query = query.order('status', { ascending: true }).order('due_date', { ascending: true, nullsFirst: false }).order('created_at', { ascending: false }).limit(1000)
    const { data, error } = await query
    if (error) return res.status(500).json({ error: error.message })
    res.json({ ok: true, tasks: data || [] })
  })

  // Quick counts for the dashboard "Today's priorities" / nav badge.
  app.get('/dealer-tasks/summary', requireAuth, async (req, res) => {
    if (!guard(req, res)) return
    const { data } = await supabaseAdmin.from('dealer_tasks').select('status, due_date, assignee_id').eq('dealership_id', req.dealershipId).neq('status', 'done').limit(2000)
    const rows = data || []; const t = today()
    res.json({ ok: true,
      open: rows.length,
      overdue: rows.filter(r => r.due_date && r.due_date < t).length,
      due_today: rows.filter(r => r.due_date === t).length,
      mine_open: rows.filter(r => r.assignee_id === req.user.id).length,
    })
  })

  app.post('/dealer-tasks/upload-photo', requireAuth, upload.single('file'), async (req, res) => {
    if (!guard(req, res)) return
    if (!req.file || !(req.file.mimetype || '').startsWith('image/')) return res.status(400).json({ error: 'Upload an image' })
    const ext = (req.file.mimetype.split('/')[1] || 'jpg').replace('jpeg', 'jpg')
    const path = `${req.dealershipId}/tasks/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`
    const { error } = await supabaseAdmin.storage.from('vehicle-pdfs').upload(path, req.file.buffer, { contentType: req.file.mimetype, upsert: true })
    if (error) return res.status(500).json({ error: 'Upload failed' })
    const { data: { publicUrl } } = supabaseAdmin.storage.from('vehicle-pdfs').getPublicUrl(path)
    res.json({ ok: true, url: publicUrl })
  })

  app.get('/dealer-tasks/:id', requireAuth, async (req, res) => {
    if (!guard(req, res)) return
    const { data } = await supabaseAdmin.from('dealer_tasks').select('*').eq('id', req.params.id).eq('dealership_id', req.dealershipId).maybeSingle()
    if (!data) return res.status(404).json({ error: 'Not found' })
    res.json({ ok: true, task: data })
  })

  app.post('/dealer-tasks', requireAuth, async (req, res) => {
    if (!guard(req, res)) return
    const f = fieldsFrom(req.body || {})
    if (!f.title) return res.status(400).json({ error: 'Title required' })
    // Every task must be tied to a vehicle (VIN and/or stock #) and a customer.
    if (!f.vin && !f.stock_number) return res.status(400).json({ error: 'Add a VIN or stock number so the task is tied to a vehicle.' })
    if (!f.contact_id && !f.contact_name) return res.status(400).json({ error: 'Add the customer this task is for.' })
    // Link to an inventory unit when the VIN/stock matches, and put it on the Cleanup board.
    f.inventory_id = await resolveInventory(req.dealershipId, f)
    const row = { dealership_id: req.dealershipId, created_by: req.user?.id || null, ...f, events: [stamp(req.user?.id, 'created', null)] }
    const { data, error } = await supabaseAdmin.from('dealer_tasks').insert(row).select().single()
    if (error) return res.status(500).json({ error: error.message })
    if (data.inventory_id) { await ensureReconCard(req.dealershipId, data.inventory_id); if (data.status === 'done') await syncTaskToRecon(req.dealershipId, data, req.user?.id) }
    if (data.assignee_id && data.assignee_id !== req.user?.id) {
      await createNotification({ dealershipId: req.dealershipId, type: 'task', title: `New task: ${data.title}`, body: [data.kind, data.stock_number || data.vin, data.due_date ? 'due ' + data.due_date : ''].filter(Boolean).join(' · '), linkPage: 'taskboard', targetUserId: data.assignee_id })
    }
    res.json({ ok: true, task: data })
  })

  app.put('/dealer-tasks/:id', requireAuth, async (req, res) => {
    if (!guard(req, res)) return
    const { data: cur } = await supabaseAdmin.from('dealer_tasks').select('*').eq('id', req.params.id).eq('dealership_id', req.dealershipId).maybeSingle()
    if (!cur) return res.status(404).json({ error: 'Not found' })
    const f = fieldsFrom(req.body || {})
    // Re-link to inventory if the VIN/stock changed.
    if (f.vin !== undefined || f.stock_number !== undefined) {
      f.inventory_id = await resolveInventory(req.dealershipId, { vin: f.vin ?? cur.vin, stock_number: f.stock_number ?? cur.stock_number })
    }
    const events = (Array.isArray(cur.events) ? cur.events.slice(-49) : [])
    const patch = { ...f, updated_at: new Date().toISOString() }
    const nowDone = f.status === 'done' && cur.status !== 'done'
    // Completing the task stamps who/when.
    if (nowDone) { patch.completed_at = new Date().toISOString(); patch.completed_by = req.user?.id || null; events.push(stamp(req.user?.id, 'completed', null)) }
    else if (f.status && f.status !== cur.status) events.push(stamp(req.user?.id, 'status', f.status))
    else events.push(stamp(req.user?.id, 'edited', null))
    patch.events = events
    const { data, error } = await supabaseAdmin.from('dealer_tasks').update(patch).eq('id', req.params.id).eq('dealership_id', req.dealershipId).select().single()
    if (error) return res.status(500).json({ error: error.message })
    // Two-way Cleanup sync: completing a get-ready task advances the car's stage.
    if (nowDone) await syncTaskToRecon(req.dealershipId, data, req.user?.id)
    // Advance any workflow this task belongs to (unblock dependents, complete instance).
    if (nowDone) notifyTaskCompleted(req.dealershipId, data).catch(() => {})
    // Notify a newly-assigned person.
    if (f.assignee_id && f.assignee_id !== cur.assignee_id && f.assignee_id !== req.user?.id) {
      await createNotification({ dealershipId: req.dealershipId, type: 'task', title: `Task assigned: ${data.title}`, body: [data.kind, data.stock_number || data.vin].filter(Boolean).join(' · '), linkPage: 'taskboard', targetUserId: f.assignee_id })
    }
    res.json({ ok: true, task: data })
  })

  app.delete('/dealer-tasks/:id', requireAuth, async (req, res) => {
    if (!guard(req, res)) return
    await supabaseAdmin.from('dealer_tasks').delete().eq('id', req.params.id).eq('dealership_id', req.dealershipId)
    res.json({ ok: true })
  })
}
