/**
 * Deep reporting suite (managers). Every figure is computed from data MarketSync
 * already captures — deals, leads, contacts, communications, tasks, trade
 * appraisals and service appointments — so nothing here is modelled or faked.
 *
 * One endpoint per report, all range-parameterised (?range=30|90|180|365). The
 * Reports hub in the dashboard loads each on demand.
 *
 *   /reports/sales        units, revenue, deal-type + finance mix, monthly trend, by rep
 *   /reports/fni          F&I penetration, product mix, F&I revenue, by F&I manager
 *   /reports/leads        source performance + funnel + speed-to-lead
 *   /reports/reps         per-rep scorecard (leads, units, revenue, appraisals, activity)
 *   /reports/appraisals   trade appraisals booked / acquired / spread, by rep
 *   /reports/service      service appointments, types, sales↔service crossover
 *   /reports/activity     communications by channel + follow-up completion
 *   /reports/customers    customer base: new, sales vs service, consent, top sources
 */
import { supabaseAdmin } from '../shared.js'
import { requireAuth } from '../middleware.js'

const isMgr = (req) => ['DEALER_ADMIN', 'OWNER', 'MANAGER'].includes(req.profile?.role)
const WON = ['sold', 'fni', 'delivered']
const rangeDays = (q) => ({ '30': 30, '90': 90, '180': 180, '365': 365 }[String(q.range || '90')] || 90)
const money = (n) => Math.round(Number(n) || 0)
const sum = (arr, f) => arr.reduce((s, x) => s + (Number(f(x)) || 0), 0)
const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0)

async function roster(dealershipId) {
  const { data } = await supabaseAdmin.from('profiles').select('id, full_name, display_name, role, active').eq('dealership_id', dealershipId)
  const map = {}; for (const p of (data || [])) map[p.id] = p.full_name || p.display_name || '—'
  return { list: data || [], nameOf: (id) => (id && map[id]) || 'Unassigned' }
}
async function costEnabled(dealershipId) {
  const { data } = await supabaseAdmin.from('dealerships').select('cost_tracking_enabled').eq('id', dealershipId).maybeSingle()
  return !!data?.cost_tracking_enabled
}
const monthKey = (iso) => { const d = new Date(iso); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}` }
function lastMonths(n) {
  const out = []; const d = new Date()
  for (let i = n - 1; i >= 0; i--) { const t = new Date(d.getFullYear(), d.getMonth() - i, 1); out.push(`${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}`) }
  return out
}

export function registerReports(app) {
  const guard = (req, res) => { if (!req.dealershipId) { res.status(400).json({ error: 'No dealership' }); return false } if (!isMgr(req)) { res.status(403).json({ error: 'Manager access required' }); return false } return true }

  // ── Sales performance ────────────────────────────────────────────────────────
  app.get('/reports/sales', requireAuth, async (req, res) => {
    if (!guard(req, res)) return
    const days = rangeDays(req.query); const startIso = new Date(Date.now() - days * 86400000).toISOString()
    const { nameOf } = await roster(req.dealershipId)
    const costOn = await costEnabled(req.dealershipId)
    const { data: deals } = await supabaseAdmin.from('deals')
      .select('selling_price, cost, deal_type, sale_type, finance_company, program, deal_status, sold_at, delivered_at, created_at, created_by, vehicle_commission, fni_commission, term, apr')
      .eq('dealership_id', req.dealershipId).in('deal_status', WON).gte('sold_at', startIso).limit(20000)
    const rows = deals || []
    const units = rows.length
    const revenue = sum(rows, x => x.selling_price)
    // Front gross = selling price − vehicle cost, over deals that actually have a cost.
    const grossRows = costOn ? rows.filter(r => Number(r.cost) > 0) : []
    const totalGross = sum(grossRows, r => (Number(r.selling_price) || 0) - (Number(r.cost) || 0))
    const grouped = (key, label) => {
      const m = {}; for (const r of rows) { const k = (r[key] || 'Unspecified'); m[k] = m[k] || { units: 0, revenue: 0 }; m[k].units++; m[k].revenue += Number(r.selling_price) || 0 }
      return Object.entries(m).sort((a, b) => b[1].units - a[1].units).map(([k, v]) => ({ [label]: k, units: v.units, revenue: money(v.revenue) }))
    }
    const trendMonths = lastMonths(6)
    const trendM = Object.fromEntries(trendMonths.map(m => [m, { units: 0, revenue: 0 }]))
    for (const r of rows) { const k = monthKey(r.sold_at || r.created_at); if (trendM[k]) { trendM[k].units++; trendM[k].revenue += Number(r.selling_price) || 0 } }
    const byRep = {}
    for (const r of rows) { const k = r.created_by || 'unassigned'; byRep[k] = byRep[k] || { units: 0, revenue: 0, comm: 0, gross: 0 }; byRep[k].units++; byRep[k].revenue += Number(r.selling_price) || 0; byRep[k].comm += (Number(r.vehicle_commission) || 0) + (Number(r.fni_commission) || 0); if (costOn && Number(r.cost) > 0) byRep[k].gross += (Number(r.selling_price) || 0) - (Number(r.cost) || 0) }
    res.json({
      ok: true, range_days: days,
      summary: {
        units, delivered: rows.filter(r => r.deal_status === 'delivered').length,
        revenue: money(revenue), avg_price: units ? money(revenue / units) : 0,
        avg_term: units ? Math.round(sum(rows, x => x.term) / units) : 0,
        avg_apr: units ? Math.round((sum(rows, x => x.apr) / units) * 100) / 100 : 0,
        ...(costOn ? { front_gross: money(totalGross), avg_gross: grossRows.length ? money(totalGross / grossRows.length) : 0, units_costed: grossRows.length } : {}),
      },
      by_deal_type: grouped('deal_type', 'type'),
      by_sale_type: grouped('sale_type', 'type'),
      by_finance_company: grouped('finance_company', 'lender').slice(0, 12),
      trend: trendMonths.map(m => ({ month: m, units: trendM[m].units, revenue: money(trendM[m].revenue) })),
      by_rep: Object.entries(byRep).sort((a, b) => b[1].units - a[1].units).map(([id, v]) => ({ rep: id === 'unassigned' ? 'Unassigned' : nameOf(id), units: v.units, revenue: money(v.revenue), ...(costOn ? { gross: money(v.gross) } : {}), commission: money(v.comm) })),
    })
  })

  // ── F&I performance ──────────────────────────────────────────────────────────
  app.get('/reports/fni', requireAuth, async (req, res) => {
    if (!guard(req, res)) return
    const days = rangeDays(req.query); const startIso = new Date(Date.now() - days * 86400000).toISOString()
    const { data: deals } = await supabaseAdmin.from('deals')
      .select('fni_products, fni_items, fni_commission, fni_manager, deal_status, sold_at, created_at')
      .eq('dealership_id', req.dealershipId).in('deal_status', WON).gte('sold_at', startIso).limit(20000)
    const rows = deals || []
    const units = rows.length
    const withFni = rows.filter(r => (Array.isArray(r.fni_items) && r.fni_items.length) || (r.fni_products && String(r.fni_products).trim()))
    // F&I revenue from the itemised products on the deal.
    let fniRevenue = 0; const products = {}
    for (const r of rows) {
      const items = Array.isArray(r.fni_items) ? r.fni_items : []
      for (const it of items) { const p = Number(it?.price) || 0; fniRevenue += p; const nm = String(it?.name || 'Product').trim().slice(0, 40); products[nm] = products[nm] || { count: 0, revenue: 0 }; products[nm].count++; products[nm].revenue += p }
      // Fall back to comma-separated product names when no itemised prices.
      if (!items.length && r.fni_products) for (const nm of String(r.fni_products).split(/[,;]/).map(s => s.trim()).filter(Boolean)) { const k = nm.slice(0, 40); products[k] = products[k] || { count: 0, revenue: 0 }; products[k].count++ }
    }
    const byMgr = {}
    for (const r of rows) { const k = (r.fni_manager || 'Unassigned').trim(); byMgr[k] = byMgr[k] || { deals: 0, commission: 0 }; byMgr[k].deals++; byMgr[k].commission += Number(r.fni_commission) || 0 }
    res.json({
      ok: true, range_days: days,
      summary: {
        deals: units, deals_with_fni: withFni.length, penetration_pct: pct(withFni.length, units),
        fni_revenue: money(fniRevenue), avg_fni_per_deal: units ? money(fniRevenue / units) : 0,
        avg_products_per_deal: units ? Math.round((sum(rows, r => Array.isArray(r.fni_items) ? r.fni_items.length : 0) / units) * 10) / 10 : 0,
      },
      product_mix: Object.entries(products).sort((a, b) => b[1].count - a[1].count).slice(0, 20).map(([name, v]) => ({ product: name, count: v.count, revenue: money(v.revenue) })),
      by_fni_manager: Object.entries(byMgr).sort((a, b) => b[1].deals - a[1].deals).map(([mgr, v]) => ({ manager: mgr, deals: v.deals, commission: money(v.commission) })),
    })
  })

  // ── Lead source performance + funnel + speed-to-lead ─────────────────────────
  app.get('/reports/leads', requireAuth, async (req, res) => {
    if (!guard(req, res)) return
    const days = rangeDays(req.query); const startIso = new Date(Date.now() - days * 86400000).toISOString()
    const [{ data: leads }, { data: contacts }] = await Promise.all([
      supabaseAdmin.from('leads').select('source, created_at, contact_id').eq('dealership_id', req.dealershipId).gte('created_at', startIso).limit(50000),
      supabaseAdmin.from('contacts').select('id, status, source, sold_source').eq('dealership_id', req.dealershipId).limit(50000),
    ])
    const cById = Object.fromEntries((contacts || []).map(c => [c.id, c]))
    const L = leads || []
    // Source table: leads, and how many of those lead-contacts are now sold.
    const bySource = {}
    for (const l of L) {
      const k = (l.source || 'Unknown').trim() || 'Unknown'
      bySource[k] = bySource[k] || { leads: 0, sold: 0, contactIds: new Set() }
      bySource[k].leads++
      if (l.contact_id) bySource[k].contactIds.add(l.contact_id)
    }
    for (const k of Object.keys(bySource)) {
      let sold = 0; for (const cid of bySource[k].contactIds) { const c = cById[cid]; if (c && WON.includes(c.status)) sold++ }
      bySource[k].sold = sold
    }
    // Funnel over the lead-contacts in range.
    const leadContactIds = [...new Set(L.map(l => l.contact_id).filter(Boolean))]
    const funnelStatuses = { new: 0, contacted: 0, appointment: 0, sold: 0 }
    for (const cid of leadContactIds) {
      const c = cById[cid]; if (!c) { funnelStatuses.new++; continue }
      if (WON.includes(c.status)) funnelStatuses.sold++
      else if (c.status === 'appointment') funnelStatuses.appointment++
      else if (c.status === 'contacted') funnelStatuses.contacted++
      else funnelStatuses.new++
    }
    // Speed-to-lead: median minutes from first lead to first outbound comm.
    const firstLead = {}
    for (const l of L) { if (!l.contact_id) continue; const t = new Date(l.created_at).getTime(); if (!firstLead[l.contact_id] || t < firstLead[l.contact_id]) firstLead[l.contact_id] = t }
    const ids = Object.keys(firstLead)
    const firstTouch = {}
    for (let i = 0; i < ids.length; i += 500) {
      const { data: comms } = await supabaseAdmin.from('communications').select('contact_id, occurred_at, created_at, direction')
        .eq('dealership_id', req.dealershipId).in('contact_id', ids.slice(i, i + 500)).in('direction', ['out', 'outbound']).limit(50000)
      for (const c of (comms || [])) { const t = new Date(c.occurred_at || c.created_at).getTime(); if (!Number.isFinite(t)) continue; if (!firstTouch[c.contact_id] || t < firstTouch[c.contact_id]) firstTouch[c.contact_id] = t }
    }
    const times = []
    let under5 = 0
    for (const cid of ids) { const lt = firstLead[cid], ft = firstTouch[cid]; if (ft && lt && ft >= lt) { const m = (ft - lt) / 60000; times.push(m); if (m <= 5) under5++ } }
    times.sort((a, b) => a - b)
    res.json({
      ok: true, range_days: days,
      summary: { total_leads: L.length, responded: times.length, under_5min_pct: pct(under5, times.length), median_response_min: times.length ? Math.round(times[Math.floor(times.length / 2)]) : null },
      funnel: funnelStatuses,
      by_source: Object.entries(bySource).sort((a, b) => b[1].leads - a[1].leads).map(([source, v]) => ({ source, leads: v.leads, sold: v.sold, conversion_pct: pct(v.sold, v.leads) })).slice(0, 25),
    })
  })

  // ── Per-rep scorecard ────────────────────────────────────────────────────────
  app.get('/reports/reps', requireAuth, async (req, res) => {
    if (!guard(req, res)) return
    const did = req.dealershipId
    const days = rangeDays(req.query); const startIso = new Date(Date.now() - days * 86400000).toISOString()
    const { list } = await roster(did)
    const costOn = await costEnabled(did)
    const reps = {}
    for (const p of list) if (p.active !== false && p.id) reps[p.id] = { rep: p.full_name || p.display_name || '—', role: p.role, leads: 0, units: 0, revenue: 0, gross: 0, appraisals: 0, tasks_done: 0, activities: 0 }
    const bump = (id, k, n = 1) => { if (reps[id]) reps[id][k] += n }
    const [{ data: contacts }, { data: deals }, { data: apprs }, { data: tasks }, { data: comms }] = await Promise.all([
      supabaseAdmin.from('contacts').select('assigned_rep, created_at').eq('dealership_id', did).gte('created_at', startIso).limit(50000),
      supabaseAdmin.from('deals').select('created_by, selling_price, cost, deal_status, sold_at').eq('dealership_id', did).in('deal_status', WON).gte('sold_at', startIso).limit(20000),
      supabaseAdmin.from('trade_appraisals').select('created_by, created_at').eq('dealership_id', did).gte('created_at', startIso).limit(20000),
      supabaseAdmin.from('crm_tasks').select('assigned_to, done, done_at').eq('dealership_id', did).eq('done', true).gte('done_at', startIso).limit(50000),
      supabaseAdmin.from('communications').select('rep_id, occurred_at, created_at').eq('dealership_id', did).gte('created_at', startIso).limit(50000),
    ])
    for (const c of (contacts || [])) bump(c.assigned_rep, 'leads')
    for (const d of (deals || [])) { bump(d.created_by, 'units'); bump(d.created_by, 'revenue', Number(d.selling_price) || 0); if (costOn && Number(d.cost) > 0) bump(d.created_by, 'gross', (Number(d.selling_price) || 0) - (Number(d.cost) || 0)) }
    for (const a of (apprs || [])) bump(a.created_by, 'appraisals')
    for (const t of (tasks || [])) bump(t.assigned_to, 'tasks_done')
    for (const m of (comms || [])) bump(m.rep_id, 'activities')
    const out = Object.values(reps).map(r => { const o = { ...r, revenue: money(r.revenue), gross: money(r.gross), close_rate_pct: pct(r.units, r.leads) }; if (!costOn) delete o.gross; return o })
      .sort((a, b) => b.units - a.units || b.revenue - a.revenue)
    res.json({ ok: true, range_days: days, reps: out })
  })

  // ── Trade appraisals ─────────────────────────────────────────────────────────
  app.get('/reports/appraisals', requireAuth, async (req, res) => {
    if (!guard(req, res)) return
    const days = rangeDays(req.query); const startIso = new Date(Date.now() - days * 86400000).toISOString()
    const { nameOf } = await roster(req.dealershipId)
    const { data: apprs } = await supabaseAdmin.from('trade_appraisals')
      .select('created_by, created_at, acquired_at, suggested_offer, currency').eq('dealership_id', req.dealershipId).gte('created_at', startIso).limit(20000)
    const rows = apprs || []
    const acquired = rows.filter(r => r.acquired_at)
    const byRep = {}
    for (const r of rows) { const k = r.created_by || 'unassigned'; byRep[k] = byRep[k] || { appraised: 0, acquired: 0, offer: 0 }; byRep[k].appraised++; if (r.acquired_at) byRep[k].acquired++; byRep[k].offer += Number(r.suggested_offer) || 0 }
    res.json({
      ok: true, range_days: days,
      summary: { appraised: rows.length, acquired: acquired.length, acquisition_rate_pct: pct(acquired.length, rows.length), avg_offer: rows.length ? money(sum(rows, r => r.suggested_offer) / rows.length) : 0 },
      by_rep: Object.entries(byRep).sort((a, b) => b[1].appraised - a[1].appraised).map(([id, v]) => ({ rep: id === 'unassigned' ? 'Unassigned' : nameOf(id), appraised: v.appraised, acquired: v.acquired, acquisition_rate_pct: pct(v.acquired, v.appraised), avg_offer: v.appraised ? money(v.offer / v.appraised) : 0 })),
    })
  })

  // ── Service department ───────────────────────────────────────────────────────
  app.get('/reports/service', requireAuth, async (req, res) => {
    if (!guard(req, res)) return
    const did = req.dealershipId
    const days = rangeDays(req.query); const startIso = new Date(Date.now() - days * 86400000).toISOString()
    const [{ data: appts }, { data: svcContacts }, { count: totalContacts }] = await Promise.all([
      supabaseAdmin.from('crm_tasks').select('service_type, done, due_at, created_at').eq('dealership_id', did).eq('category', 'service').gte('created_at', startIso).limit(20000),
      supabaseAdmin.from('contacts').select('id, status, service_customer').eq('dealership_id', did).eq('service_customer', true).limit(50000),
      supabaseAdmin.from('contacts').select('id', { count: 'exact', head: true }).eq('dealership_id', did),
    ])
    const rows = appts || []
    const types = {}
    for (const r of rows) { const k = (r.service_type || 'Service').trim(); types[k] = (types[k] || 0) + 1 }
    // Crossover: service customers who are also sales customers (a sales status).
    const both = (svcContacts || []).filter(c => WON.includes(c.status) || ['contacted', 'appointment', 'negotiating', 'working'].includes(c.status)).length
    res.json({
      ok: true, range_days: days,
      summary: {
        booked: rows.length, completed: rows.filter(r => r.done).length, upcoming: rows.filter(r => !r.done).length,
        service_customers: (svcContacts || []).length, sales_and_service: both, total_customers: totalContacts || 0,
      },
      by_type: Object.entries(types).sort((a, b) => b[1] - a[1]).map(([type, count]) => ({ type, count })),
    })
  })

  // ── Activity / productivity ──────────────────────────────────────────────────
  app.get('/reports/activity', requireAuth, async (req, res) => {
    if (!guard(req, res)) return
    const did = req.dealershipId
    const days = rangeDays(req.query); const startIso = new Date(Date.now() - days * 86400000).toISOString()
    const { nameOf } = await roster(did)
    const [{ data: comms }, { data: tasksCreated }, { data: tasksDone }] = await Promise.all([
      supabaseAdmin.from('communications').select('channel, direction, rep_id, occurred_at, created_at').eq('dealership_id', did).gte('created_at', startIso).limit(80000),
      supabaseAdmin.from('crm_tasks').select('id').eq('dealership_id', did).gte('created_at', startIso).limit(80000),
      supabaseAdmin.from('crm_tasks').select('id').eq('dealership_id', did).eq('done', true).gte('done_at', startIso).limit(80000),
    ])
    const byChannel = {}, byRep = {}
    for (const c of (comms || [])) {
      const ch = (c.channel || 'other'); byChannel[ch] = (byChannel[ch] || 0) + 1
      const rk = c.rep_id || 'unassigned'; byRep[rk] = (byRep[rk] || 0) + 1
    }
    res.json({
      ok: true, range_days: days,
      summary: { total_activities: (comms || []).length, tasks_created: (tasksCreated || []).length, tasks_completed: (tasksDone || []).length },
      by_channel: Object.entries(byChannel).sort((a, b) => b[1] - a[1]).map(([channel, count]) => ({ channel, count })),
      by_rep: Object.entries(byRep).sort((a, b) => b[1] - a[1]).slice(0, 20).map(([id, count]) => ({ rep: id === 'unassigned' ? 'Unassigned' : nameOf(id), activities: count })),
    })
  })

  // ── Customer base ────────────────────────────────────────────────────────────
  app.get('/reports/customers', requireAuth, async (req, res) => {
    if (!guard(req, res)) return
    const did = req.dealershipId
    const days = rangeDays(req.query); const startIso = new Date(Date.now() - days * 86400000).toISOString()
    const { data: contacts } = await supabaseAdmin.from('contacts')
      .select('status, source, service_customer, consent_email, consent_sms, created_at').eq('dealership_id', did).limit(80000)
    const rows = contacts || []
    const salesSet = new Set([...WON, 'contacted', 'appointment', 'negotiating', 'working'])
    const isSales = c => salesSet.has(c.status)
    const svc = rows.filter(c => c.service_customer)
    const sales = rows.filter(isSales)
    const both = rows.filter(c => c.service_customer && isSales)
    const sources = {}
    for (const c of rows) { const k = (c.source || 'Unknown').trim() || 'Unknown'; sources[k] = (sources[k] || 0) + 1 }
    res.json({
      ok: true, range_days: days,
      summary: {
        total: rows.length, new_in_range: rows.filter(c => c.created_at >= startIso).length,
        sales_customers: sales.length, service_customers: svc.length, sales_and_service: both.length,
        email_opt_in: rows.filter(c => c.consent_email !== false).length, sms_opt_in: rows.filter(c => c.consent_sms !== false).length,
      },
      top_sources: Object.entries(sources).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([source, count]) => ({ source, count })),
    })
  })
}
