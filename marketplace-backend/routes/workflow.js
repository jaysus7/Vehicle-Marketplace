/**
 * Workflow Engine — Stage 3 (the runner).
 *
 * Listens to the events spine (routes/events.js onEvent bus). On a matching event it
 * instantiates the relevant workflow template and materializes its steps:
 *   • create_task  → a dealer_tasks row (idempotent: adopts an existing matching task
 *                    rather than duplicating, so it coexists with ensureDealTasks and
 *                    takes over gradually — the approved "idempotent dedupe" model)
 *   • system steps → executed in-process (notifications, exceptions, state updates,
 *                    timeline notes; post_ledger/post_commission are no-ops here because
 *                    the delivery path already posts them — see notes below)
 *
 * Ordering: steps with `depends_on` wait. A dependent task is created 'blocked' until
 * its prerequisite tasks are all 'done'; a dependent system step defers until then.
 * reconcileInstance() re-derives instance state from its tasks, so it is safe to call
 * repeatedly (on every task completion) and converges to completion.
 *
 * State is never stored here — the engine observes the SSOT columns and, for
 * update_state steps, writes them directly (logging a timeline note without re-emitting
 * through the bus, to avoid trigger loops).
 */
import { supabaseAdmin } from '../shared.js'
import { requireAuth } from '../middleware.js'
import { onEvent } from './events.js'
import { createNotification } from '../notifications.js'

const GLOBAL = null   // dealership_id null = global default template

// Direct timeline write that does NOT go through the event bus (no re-trigger).
async function logTimeline({ dealershipId, eventName, entityType, entityId, summary, department = null, toState = null, payload = {} }) {
  try {
    await supabaseAdmin.from('events').insert({
      dealership_id: dealershipId, event_name: eventName, entity_type: entityType, entity_id: entityId,
      summary, department, to_state: toState, payload: { ...payload, engine: true },
    })
  } catch (e) { console.warn('[workflow] logTimeline failed:', e.message) }
}

// ── Template matching ───────────────────────────────────────────────────────
// A template's trigger_event is either "event_name" or "event_name:to_state".
// Dealership-specific templates override the global default of the same name.
async function matchTemplates(dealershipId, event) {
  const triggers = [event.event_name]
  if (event.to_state) triggers.push(`${event.event_name}:${event.to_state}`)
  const { data } = await supabaseAdmin.from('workflow_templates')
    .select('*').eq('active', true).in('trigger_event', triggers)
    .or(`dealership_id.eq.${dealershipId},dealership_id.is.null`)
  if (!data?.length) return []
  // Prefer the dealership's own template over the global one when both share a name.
  const byName = new Map()
  for (const t of data) {
    const cur = byName.get(t.name)
    if (!cur || (t.dealership_id && !cur.dealership_id)) byName.set(t.name, t)
  }
  return [...byName.values()]
}

// Resolve the deal / vehicle / customer ids reachable from an event, plus display
// fields used to keep the task board and vehicle timeline aligned.
async function resolveContext(event) {
  const ctx = { dealId: null, inventoryId: null, contactId: null, vin: null, stock: null, contactName: null }
  const did = event.dealership_id
  try {
    if (event.entity_type === 'deal') {
      ctx.dealId = event.entity_id
      const { data: d } = await supabaseAdmin.from('deals').select('contact_id, inventory_id').eq('id', event.entity_id).eq('dealership_id', did).maybeSingle()
      ctx.contactId = d?.contact_id || null; ctx.inventoryId = d?.inventory_id || null
    } else if (event.entity_type === 'customer') {
      ctx.contactId = event.entity_id
    } else if (event.entity_type === 'vehicle') {
      ctx.inventoryId = event.entity_id
    }
    if (ctx.inventoryId) { const { data: v } = await supabaseAdmin.from('inventory').select('vin, stock_number').eq('id', ctx.inventoryId).maybeSingle(); ctx.vin = v?.vin || null; ctx.stock = v?.stock_number || null }
    if (ctx.contactId) { const { data: c } = await supabaseAdmin.from('contacts').select('full_name').eq('id', ctx.contactId).maybeSingle(); ctx.contactName = c?.full_name || null }
  } catch (e) { console.warn('[workflow] resolveContext failed:', e.message) }
  return ctx
}

function instanceEntity(template, ctx, event) {
  if (template.target_entity === 'deal') return { type: 'deal', id: ctx.dealId || event.entity_id }
  if (template.target_entity === 'vehicle') return { type: 'vehicle', id: ctx.inventoryId || event.entity_id }
  return { type: 'customer', id: ctx.contactId || event.entity_id }
}

// ── Task creation with dedupe / adoption ────────────────────────────────────
// Returns the task id for a step, creating it only if no equivalent task exists.
async function ensureStepTask(dealershipId, instance, step, ctx) {
  const kind = step.config?.kind || 'Other'
  const title = step.config?.title || step.name
  // Find an existing equivalent task (from ensureDealTasks or a prior run) to adopt.
  let q = supabaseAdmin.from('dealer_tasks').select('id, status, workflow_instance_id').eq('dealership_id', dealershipId).eq('kind', kind).neq('status', 'done')
  if (ctx.dealId) q = q.eq('deal_id', ctx.dealId)
  else if (ctx.inventoryId) q = q.eq('inventory_id', ctx.inventoryId)
  else if (ctx.contactId) q = q.eq('contact_id', ctx.contactId)
  else return null
  const { data: existing } = await q.limit(1).maybeSingle()
  if (existing) {
    // Adopt it into this workflow (attach linkage/department if not already set).
    await supabaseAdmin.from('dealer_tasks').update({
      workflow_instance_id: existing.workflow_instance_id || instance.id,
      workflow_step_id: step.id, department: step.department || null, updated_at: new Date().toISOString(),
    }).eq('id', existing.id)
    return existing.id
  }
  const now = new Date().toISOString()
  const { data: created, error } = await supabaseAdmin.from('dealer_tasks').insert({
    dealership_id: dealershipId, created_by: null, auto: true, status: 'todo',
    title, kind, priority: step.config?.priority || 'normal',
    deal_id: ctx.dealId || null, inventory_id: ctx.inventoryId || null, contact_id: ctx.contactId || null,
    contact_name: ctx.contactName || null, vin: ctx.vin || null, stock_number: ctx.stock || null,
    workflow_instance_id: instance.id, workflow_step_id: step.id, department: step.department || null,
    events: [{ at: now, actor: null, action: 'created', detail: `workflow: ${step.name}` }],
  }).select('id').single()
  if (error) { console.warn('[workflow] ensureStepTask insert failed:', error.message); return null }
  // Notify the assignee-less task's department (best effort).
  createNotification({ dealershipId, type: 'task', title: `New task: ${title}`, body: [kind, ctx.stock || ctx.vin, step.department].filter(Boolean).join(' · '), linkPage: 'taskboard' }).catch(() => {})
  return created.id
}

// ── System action executors ─────────────────────────────────────────────────
async function runSystemStep(dealershipId, instance, step, ctx) {
  const entity = { type: instance.entity_type, id: instance.entity_id }
  switch (step.action_type) {
    case 'update_state': {
      const to = step.config?.to_state
      if (!to) break
      if (entity.type === 'vehicle' && ctx.inventoryId) await supabaseAdmin.from('inventory').update({ status: to }).eq('id', ctx.inventoryId).eq('dealership_id', dealershipId)
      else if (entity.type === 'deal' && ctx.dealId) await supabaseAdmin.from('deals').update({ deal_status: to, updated_at: new Date().toISOString() }).eq('id', ctx.dealId).eq('dealership_id', dealershipId)
      else if (entity.type === 'customer' && ctx.contactId) await supabaseAdmin.from('contacts').update({ status: to, updated_at: new Date().toISOString() }).eq('id', ctx.contactId).eq('dealership_id', dealershipId)
      await logTimeline({ dealershipId, eventName: 'state.updated', entityType: entity.type, entityId: entity.id, summary: `State → ${to}`, department: step.department, toState: to })
      break
    }
    case 'send_notification':
      await createNotification({ dealershipId, type: 'task', title: step.name, body: [ctx.contactName, ctx.stock || ctx.vin].filter(Boolean).join(' · '), linkPage: 'crm' }).catch(() => {})
      break
    case 'create_exception':
      await raiseException(dealershipId, { kind: step.config?.kind || 'workflow', entityType: entity.type, entityId: entity.id, department: step.department, description: step.name })
      break
    case 'request_approval':
      await raiseException(dealershipId, { kind: 'approval_waiting', entityType: entity.type, entityId: entity.id, department: step.department, description: step.name, severity: 'high' })
      break
    // Already posted by the delivery path (dashboard.js postDealToLedger / recomputeDealCommission);
    // re-posting here would double-count, so these are timeline-only in the engine.
    case 'post_ledger':
    case 'post_commission':
    case 'send_sms':
    case 'send_email':
    case 'system_vin_decode':
    case 'system_carfax':
    case 'add_timeline':
    case 'wait':   // timers arrive in Stage 6 (automation/scheduler)
    default:
      await logTimeline({ dealershipId, eventName: `workflow.${step.action_type}`, entityType: entity.type, entityId: entity.id, summary: step.name, department: step.department })
      break
  }
}

async function raiseException(dealershipId, { kind, entityType, entityId, department = null, description = null, severity = 'medium' }) {
  try {
    await supabaseAdmin.from('exceptions').insert({ dealership_id: dealershipId, kind, entity_type: entityType, entity_id: entityId, department, description, severity })
  } catch (e) {
    // unique partial index dedupes open exceptions — ignore the conflict
    if (!String(e.message || '').includes('duplicate')) console.warn('[workflow] raiseException failed:', e.message)
  }
}

// ── Instantiate a template for an event ─────────────────────────────────────
async function startInstance(template, event, ctx) {
  const did = event.dealership_id
  const ent = instanceEntity(template, ctx, event)
  if (!ent.id) return
  // Dedupe: one running instance per (template, entity).
  const { data: running } = await supabaseAdmin.from('workflow_instances').select('id')
    .eq('workflow_template_id', template.id).eq('entity_type', ent.type).eq('entity_id', ent.id).eq('status', 'running').limit(1).maybeSingle()
  if (running) return
  const { data: instance, error } = await supabaseAdmin.from('workflow_instances').insert({
    dealership_id: did, workflow_template_id: template.id, entity_type: ent.type, entity_id: ent.id,
    status: 'running', context: { dealId: ctx.dealId, inventoryId: ctx.inventoryId, contactId: ctx.contactId, executed_steps: [] },
  }).select('*').single()
  if (error) { console.warn('[workflow] startInstance failed:', error.message); return }

  const { data: steps } = await supabaseAdmin.from('workflow_steps').select('*').eq('workflow_template_id', template.id).order('step_order')
  // First pass: create/adopt all task-steps so dependencies can reference their ids.
  const stepTaskId = {}   // step_order → task id
  for (const s of steps || []) {
    if (s.action_type === 'create_task') {
      const tid = await ensureStepTask(did, instance, s, ctx)
      if (tid) stepTaskId[s.step_order] = tid
    }
  }
  // Wire task dependencies + block tasks whose prerequisites aren't met yet.
  for (const s of steps || []) {
    if (s.action_type !== 'create_task' || !stepTaskId[s.step_order]) continue
    const deps = (s.depends_on || []).map(o => stepTaskId[o]).filter(Boolean)
    for (const dep of deps) {
      await supabaseAdmin.from('task_dependencies').upsert({ task_id: stepTaskId[s.step_order], depends_on_task_id: dep }, { onConflict: 'task_id,depends_on_task_id' })
    }
    if (deps.length) {
      const { data: unmet } = await supabaseAdmin.from('dealer_tasks').select('id').in('id', deps).neq('status', 'done')
      if (unmet?.length) {
        await supabaseAdmin.from('dealer_tasks').update({ status: 'blocked', blocked_reason: 'Waiting on prerequisite tasks' }).eq('id', stepTaskId[s.step_order]).neq('status', 'done')
      }
    }
  }
  await logTimeline({ dealershipId: did, eventName: 'workflow.started', entityType: ent.type, entityId: ent.id, summary: `Workflow started: ${template.name}` })
  // Run system steps whose dependencies are already satisfied (i.e. none, or all done).
  await reconcileInstance(instance.id)
}

// ── Re-derive instance state from its tasks; converge toward completion ──────
export async function reconcileInstance(instanceId) {
  try {
    const { data: instance } = await supabaseAdmin.from('workflow_instances').select('*').eq('id', instanceId).maybeSingle()
    if (!instance || instance.status !== 'running') return
    const did = instance.dealership_id
    const { data: steps } = await supabaseAdmin.from('workflow_steps').select('*').eq('workflow_template_id', instance.workflow_template_id).order('step_order')
    const { data: tasks } = await supabaseAdmin.from('dealer_tasks').select('id, status, workflow_step_id').eq('workflow_instance_id', instanceId)
    const taskByStep = new Map((tasks || []).map(t => [t.workflow_step_id, t]))
    const doneStepOrders = new Set()
    const ctx = { dealId: instance.context?.dealId, inventoryId: instance.context?.inventoryId, contactId: instance.context?.contactId }

    // Unblock task-steps whose prerequisites are now all done.
    for (const s of steps || []) {
      if (s.action_type !== 'create_task') continue
      const t = taskByStep.get(s.id)
      if (t?.status === 'done') { doneStepOrders.add(s.step_order); continue }
      if (t?.status === 'blocked') {
        const { data: deps } = await supabaseAdmin.from('task_dependencies').select('depends_on_task_id').eq('task_id', t.id)
        const depIds = (deps || []).map(d => d.depends_on_task_id)
        if (depIds.length) {
          const { data: unmet } = await supabaseAdmin.from('dealer_tasks').select('id').in('id', depIds).neq('status', 'done')
          if (!unmet?.length) await supabaseAdmin.from('dealer_tasks').update({ status: 'todo', blocked_reason: null }).eq('id', t.id)
        } else {
          await supabaseAdmin.from('dealer_tasks').update({ status: 'todo', blocked_reason: null }).eq('id', t.id)
        }
      }
    }

    // Execute system steps whose dependencies (on task-steps) are satisfied, once each.
    const executed = new Set(instance.context?.executed_steps || [])
    const stepByOrder = new Map((steps || []).map(s => [s.step_order, s]))
    let ranSomething = false
    for (const s of steps || []) {
      if (s.action_type === 'create_task' || executed.has(s.step_order)) continue
      const deps = s.depends_on || []
      const depsMet = deps.every(o => {
        const ds = stepByOrder.get(o)
        if (!ds) return true
        if (ds.action_type === 'create_task') return doneStepOrders.has(o)
        return executed.has(o)
      })
      if (!depsMet) continue
      await runSystemStep(did, instance, s, ctx)
      executed.add(s.step_order); ranSomething = true
    }
    if (ranSomething) {
      await supabaseAdmin.from('workflow_instances').update({ context: { ...instance.context, executed_steps: [...executed] } }).eq('id', instanceId)
    }

    // Complete when every task-step is done and every system-step has executed.
    const allTasksDone = (steps || []).filter(s => s.action_type === 'create_task').every(s => doneStepOrders.has(s.step_order))
    const allSystemDone = (steps || []).filter(s => s.action_type !== 'create_task').every(s => executed.has(s.step_order))
    if (allTasksDone && allSystemDone) {
      await supabaseAdmin.from('workflow_instances').update({ status: 'completed', completed_at: new Date().toISOString() }).eq('id', instanceId)
      await logTimeline({ dealershipId: did, eventName: 'workflow.completed', entityType: instance.entity_type, entityId: instance.entity_id, summary: 'Workflow completed' })
    }
  } catch (e) { console.warn('[workflow] reconcileInstance failed:', e.message) }
}

// Called by the task layer whenever a task is marked done.
export async function notifyTaskCompleted(dealershipId, task) {
  if (task?.workflow_instance_id) await reconcileInstance(task.workflow_instance_id)
}
// Called by recon when it bulk-completes get-ready tasks for a vehicle.
export async function reconcileTasksForInventory(dealershipId, inventoryId) {
  try {
    const { data } = await supabaseAdmin.from('dealer_tasks').select('workflow_instance_id')
      .eq('dealership_id', dealershipId).eq('inventory_id', inventoryId).not('workflow_instance_id', 'is', null)
    const ids = [...new Set((data || []).map(t => t.workflow_instance_id).filter(Boolean))]
    for (const id of ids) await reconcileInstance(id)
  } catch (e) { console.warn('[workflow] reconcileTasksForInventory failed:', e.message) }
}

// ── Event subscription ──────────────────────────────────────────────────────
async function handleEvent(event) {
  if (!event?.dealership_id || event.payload?.engine) return   // ignore engine-originated notes
  const templates = await matchTemplates(event.dealership_id, event)
  if (!templates.length) return
  const ctx = await resolveContext(event)
  for (const t of templates) await startInstance(t, event, ctx)
}

// ── HTTP surface (read + manage) ────────────────────────────────────────────
export function registerWorkflow(app) {
  onEvent(handleEvent)   // subscribe the engine to the events bus

  // Running/updated workflow instances for one entity.
  app.get('/workflow/instances/:entityType/:entityId', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.status(403).json({ error: 'no dealership' })
    const { data, error } = await supabaseAdmin.from('workflow_instances').select('*')
      .eq('dealership_id', req.dealershipId).eq('entity_type', req.params.entityType).eq('entity_id', req.params.entityId)
      .order('started_at', { ascending: false }).limit(50)
    if (error) return res.status(500).json({ error: error.message })
    res.json({ instances: data || [] })
  })

  // The manager exception dashboard.
  app.get('/exceptions', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.status(403).json({ error: 'no dealership' })
    let q = supabaseAdmin.from('exceptions').select('*').eq('dealership_id', req.dealershipId).order('created_at', { ascending: false }).limit(500)
    if (req.query.status) q = q.eq('status', req.query.status)
    else q = q.neq('status', 'resolved')
    const { data, error } = await q
    if (error) return res.status(500).json({ error: error.message })
    res.json({ exceptions: data || [] })
  })

  app.post('/exceptions/:id/resolve', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.status(403).json({ error: 'no dealership' })
    const { error } = await supabaseAdmin.from('exceptions')
      .update({ status: 'resolved', resolved_at: new Date().toISOString(), resolved_by: req.user?.id || null })
      .eq('id', req.params.id).eq('dealership_id', req.dealershipId)
    if (error) return res.status(500).json({ error: error.message })
    res.json({ ok: true })
  })
}
