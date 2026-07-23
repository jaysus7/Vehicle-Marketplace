/**
 * Events layer — the single unified activity spine (Stage 2 of the Workflow Engine).
 *
 * Every meaningful state change in the system emits ONE row to `events` via
 * emitEvent(). That row is simultaneously (a) the machine signal the workflow
 * engine listens to and (b) the human line the Timeline screen renders. There is
 * no separate activity-log table — one log, per the design law.
 *
 * emitEvent is intentionally non-throwing: a failed event write must never break
 * the business action that triggered it (e.g. a deal still gets marked sold even
 * if the timeline insert hiccups). Failures are logged, not propagated.
 */
import { supabaseAdmin } from '../shared.js'
import { requireAuth } from '../middleware.js'

// In-process event bus. The workflow engine subscribes via onEvent() at startup;
// this keeps events.js free of any import of the engine (no circular dependency).
// Subscribers run detached and errors are swallowed so a slow/broken subscriber can
// never block or fail the business action that emitted the event.
const subscribers = []
export function onEvent(fn) { if (typeof fn === 'function') subscribers.push(fn) }
function dispatch(event) {
  for (const fn of subscribers) {
    Promise.resolve().then(() => fn(event)).catch(err => console.error('[events] subscriber failed:', err?.message || err))
  }
}

/**
 * Write one event to the unified spine. Returns the row, or null on any failure.
 * @param {object} e
 * @param {string} e.dealershipId
 * @param {string} e.eventName    machine name, e.g. 'deal.status_changed'
 * @param {string} e.entityType   customer|vehicle|deal|task|appraisal|...
 * @param {string} e.entityId
 * @param {string} [e.summary]    human line for the timeline, e.g. 'Deposit paid — $500'
 * @param {string} [e.fromState]
 * @param {string} [e.toState]
 * @param {string} [e.department]
 * @param {object} [e.payload]
 * @param {string} [e.createdBy]
 */
export async function emitEvent({
  dealershipId, eventName, entityType, entityId,
  summary = null, fromState = null, toState = null,
  department = null, payload = {}, createdBy = null,
}) {
  if (!dealershipId || !eventName || !entityType || !entityId) return null
  try {
    const { data, error } = await supabaseAdmin.from('events').insert({
      dealership_id: dealershipId,
      event_name: eventName,
      summary,
      entity_type: entityType,
      entity_id: entityId,
      from_state: fromState,
      to_state: toState,
      department,
      payload: payload || {},
      created_by: createdBy,
    }).select().single()
    if (error) throw error
    dispatch(data)   // fan out to the workflow engine (detached, non-blocking)
    return data
  } catch (err) {
    console.error('[events] emitEvent failed:', err?.message || err)
    return null
  }
}

/**
 * Gather the set of related entity ids whose events belong on one timeline.
 * All ids are uuids (globally unique) so a single entity_id IN (...) query is safe
 * across entity types.
 *  - deal      → the deal + its buyer contact + its vehicle
 *  - customer  → the contact + its deals + those deals' vehicles
 *  - vehicle   → the vehicle + deals for it + those deals' buyers
 */
async function relatedEntityIds(dealershipId, entityType, entityId) {
  const ids = new Set([entityId])
  try {
    if (entityType === 'deal') {
      const { data: d } = await supabaseAdmin.from('deals')
        .select('contact_id, inventory_id').eq('id', entityId).eq('dealership_id', dealershipId).maybeSingle()
      if (d?.contact_id) ids.add(d.contact_id)
      if (d?.inventory_id) ids.add(d.inventory_id)
    } else if (entityType === 'customer') {
      const { data: deals } = await supabaseAdmin.from('deals')
        .select('id, inventory_id').eq('contact_id', entityId).eq('dealership_id', dealershipId).limit(200)
      for (const d of deals || []) { ids.add(d.id); if (d.inventory_id) ids.add(d.inventory_id) }
    } else if (entityType === 'vehicle') {
      const { data: deals } = await supabaseAdmin.from('deals')
        .select('id, contact_id').eq('inventory_id', entityId).eq('dealership_id', dealershipId).limit(200)
      for (const d of deals || []) { ids.add(d.id); if (d.contact_id) ids.add(d.contact_id) }
    }
  } catch (err) {
    console.error('[events] relatedEntityIds failed:', err?.message || err)
  }
  return [...ids]
}

export function registerEvents(app) {
  // Flat event feed for a dealership (newest first). Optional ?entity_type & ?event_name filters.
  app.get('/events', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.status(403).json({ error: 'no dealership' })
    let q = supabaseAdmin.from('events').select('*')
      .eq('dealership_id', req.dealershipId).order('created_at', { ascending: false })
      .limit(Math.min(Number(req.query.limit) || 100, 500))
    if (req.query.entity_type) q = q.eq('entity_type', req.query.entity_type)
    if (req.query.event_name) q = q.eq('event_name', req.query.event_name)
    const { data, error } = await q
    if (error) return res.status(500).json({ error: error.message })
    res.json({ events: data || [] })
  })

  // Unified timeline for one entity + its related records (merged, newest first).
  app.get('/timeline/:entityType/:entityId', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.status(403).json({ error: 'no dealership' })
    const { entityType, entityId } = req.params
    const ids = await relatedEntityIds(req.dealershipId, entityType, entityId)
    const { data, error } = await supabaseAdmin.from('events').select('*')
      .eq('dealership_id', req.dealershipId).in('entity_id', ids)
      .order('created_at', { ascending: false })
      .limit(Math.min(Number(req.query.limit) || 200, 500))
    if (error) return res.status(500).json({ error: error.message })
    res.json({ timeline: data || [], entity_ids: ids })
  })
}
