// ─────────────────────────────────────────────────────────────────────────────
// New-lead routing + notifications.
//   • Classifies a lead as new / used from the vehicle of interest.
//   • Auto-assigns to a randomly-picked salesperson on the matching team.
//   • Notifies the assigned rep + the right managers (GSM + team manager), or —
//     if the dealer flips routing to "all" — every manager (and optionally reps).
// Config lives on dealerships.lead_routing:
//   { mode: 'targeted'|'all', notify_reps: bool, notify_managers: bool, notify_all_sales: bool }
// ─────────────────────────────────────────────────────────────────────────────
import { supabaseAdmin } from './shared.js'
import { createNotifications } from './notifications.js'

const MANAGER_ROLES = ['OWNER', 'DEALER_ADMIN', 'MANAGER']
const pickRandom = (arr) => (arr.length ? arr[Math.floor(Math.random() * arr.length)] : null)

export async function routeAndNotifyLead(dealershipId, { contactId, vehicleId, name, source, leadTypeHint } = {}) {
  try {
    if (!dealershipId || !contactId) return null

    // 1. Classify the lead from the vehicle of interest (new/demo → new, else used).
    let leadType = leadTypeHint || null
    if (!leadType && vehicleId) {
      const { data: v } = await supabaseAdmin.from('inventory').select('condition').eq('id', vehicleId).maybeSingle()
      const cond = String(v?.condition || '').toLowerCase()
      leadType = (cond === 'new' || cond === 'demo') ? 'new' : (cond ? 'used' : null)
    }

    // 2. Routing config + active roster.
    const { data: dealer } = await supabaseAdmin.from('dealerships').select('lead_routing').eq('id', dealershipId).maybeSingle()
    const cfg = (dealer?.lead_routing && typeof dealer.lead_routing === 'object') ? dealer.lead_routing : {}
    const mode = cfg.mode === 'all' ? 'all' : 'targeted'
    const notifyReps = cfg.notify_reps !== false
    const notifyManagers = cfg.notify_managers !== false
    const { data: staff } = await supabaseAdmin.from('profiles')
      .select('id, full_name, display_name, role, sales_team, mgr_role, active').eq('dealership_id', dealershipId)
    const people = (staff || []).filter(p => p.active !== false)
    const managers = people.filter(p => MANAGER_ROLES.includes(p.role))
    const reps = people.filter(p => p.role === 'SALES_REP')

    // 3. Pick the assignee — random within the matching team when targeted.
    let eligible = reps
    if (mode === 'targeted' && leadType) {
      const teamReps = reps.filter(p => p.sales_team === leadType || p.sales_team === 'both')
      if (teamReps.length) eligible = teamReps
    }
    const assignee = pickRandom(eligible)

    // 4. Assign the contact (only if it doesn't already have a rep).
    if (assignee) {
      const { data: c } = await supabaseAdmin.from('contacts').select('assigned_rep').eq('id', contactId).maybeSingle()
      if (c && !c.assigned_rep) await supabaseAdmin.from('contacts').update({ assigned_rep: assignee.id }).eq('id', contactId)
    }

    // 5. Work out who gets notified.
    const recips = new Set()
    if (notifyReps && assignee) recips.add(assignee.id)
    if (notifyManagers) {
      if (mode === 'all') {
        managers.forEach(m => recips.add(m.id))
        if (cfg.notify_all_sales) reps.forEach(r => recips.add(r.id))
      } else {
        managers.filter(m => m.mgr_role === 'gsm').forEach(m => recips.add(m.id))
        const teamMgrRole = leadType === 'new' ? 'new_mgr' : leadType === 'used' ? 'used_mgr' : null
        if (teamMgrRole) managers.filter(m => m.mgr_role === teamMgrRole).forEach(m => recips.add(m.id))
        // No scoped managers configured → fall back to all managers so nothing slips.
        if (!managers.some(m => recips.has(m.id))) managers.forEach(m => recips.add(m.id))
      }
    }

    // 6. Write the in-app notifications.
    const label = leadType ? `${leadType} lead` : 'lead'
    const title = `New ${label}${name ? ': ' + name : ''}`
    const assignedName = assignee ? (assignee.display_name || assignee.full_name || 'a rep') : null
    const body = assignedName ? `Assigned to ${assignedName}.${source ? ' Source: ' + source : ''}` : (source ? `Source: ${source}` : 'New lead in the CRM.')
    const rows = [...recips].map(uid => ({ dealership_id: dealershipId, type: 'new_lead', title, body, link_page: 'leads', target_user_id: uid, read: false }))
    if (rows.length) await createNotifications(rows)

    // 7. Drop a speed-to-lead task so the lead is actionable, not just a ping.
    //    Assigned to the routed rep (or the GSM if none), due within the hour.
    //    Deduped: skip if the contact already has an open call/follow-up task.
    try {
      const { data: openTask } = await supabaseAdmin.from('crm_tasks')
        .select('id').eq('contact_id', contactId).eq('done', false).in('type', ['call', 'followup']).limit(1)
      if (!openTask || !openTask.length) {
        const gsm = managers.find(m => m.mgr_role === 'gsm') || managers[0] || null
        const taskOwner = assignee?.id || gsm?.id || null
        const due = new Date(Date.now() + 60 * 60 * 1000)   // 1 hour → speed to lead
        await supabaseAdmin.from('crm_tasks').insert({
          dealership_id: dealershipId, contact_id: contactId, assigned_to: taskOwner,
          title: `Respond to new lead${name ? ': ' + name : ''}`, type: 'call', due_at: due.toISOString(),
        })
      }
    } catch (e) { console.warn('[lead-routing] task create failed:', e.message) }

    return { assignee: assignee?.id || null, leadType, notified: rows.length }
  } catch (e) { console.warn('[lead-routing] failed:', e.message); return null }
}
