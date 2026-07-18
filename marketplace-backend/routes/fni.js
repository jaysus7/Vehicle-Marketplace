// FNI Deals worklist. Pushed/pending deals live here until delivery. The F&I
// manager works each deal (credit app + products), hits Approve to capture the
// get-ready details — which creates the Cleanup card and emails the teams — then
// marks Delivered, which closes the deal out and drops it off the list.
import { supabaseAdmin } from '../shared.js'
import { requireAuth } from '../middleware.js'
import { sendEmail } from '../securityAlerts.js'
import { ensureGetReadyCard } from './recon.js'

const MGR = ['DEALER_ADMIN', 'OWNER', 'MANAGER']
const isMgr = (req) => MGR.includes(req.profile?.role)
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export function registerFni(app) {
  // Worklist: every deal that isn't delivered yet, newest first.
  app.get('/fni/deals', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership associated' })
    if (!isMgr(req)) return res.status(403).json({ error: 'Manager access required' })
    const { data: deals, error } = await supabaseAdmin.from('deals')
      .select('id, deal_number, contact_id, inventory_id, deal_status, delivery_date, delivery_time, fni_products, notes, approved_at, created_by, created_at, selling_price')
      .eq('dealership_id', req.dealershipId)
      .neq('deal_status', 'delivered')
      .order('created_at', { ascending: false })
      .limit(500)
    if (error) return res.status(500).json({ error: error.message })

    const contactIds = [...new Set((deals || []).map(d => d.contact_id).filter(Boolean))]
    const invIds = [...new Set((deals || []).map(d => d.inventory_id).filter(Boolean))]
    const repIds = [...new Set((deals || []).map(d => d.created_by).filter(Boolean))]
    const [contacts, inv, reps, dealer] = await Promise.all([
      contactIds.length ? supabaseAdmin.from('contacts').select('id, full_name, first_name, last_name').in('id', contactIds) : Promise.resolve({ data: [] }),
      invIds.length ? supabaseAdmin.from('inventory').select('id, year, make, model, trim, stocknumber').in('id', invIds) : Promise.resolve({ data: [] }),
      repIds.length ? supabaseAdmin.from('profiles').select('id, full_name, display_name').in('id', repIds) : Promise.resolve({ data: [] }),
      supabaseAdmin.from('dealerships').select('cleanup_notify_emails').eq('id', req.dealershipId).maybeSingle(),
    ])
    const cById = Object.fromEntries((contacts.data || []).map(c => [c.id, c.full_name || [c.first_name, c.last_name].filter(Boolean).join(' ') || '—']))
    const iById = Object.fromEntries((inv.data || []).map(v => [v.id, { label: [v.year, v.make, v.model, v.trim].filter(Boolean).join(' ') || 'Vehicle', stock: v.stocknumber }]))
    const rById = Object.fromEntries((reps.data || []).map(r => [r.id, r.display_name || r.full_name || '—']))

    const rows = (deals || []).map(d => ({
      id: d.id, deal_number: d.deal_number || null, deal_status: d.deal_status || null,
      customer: d.contact_id ? (cById[d.contact_id] || '—') : '—',
      vehicle: d.inventory_id ? (iById[d.inventory_id]?.label || 'Vehicle') : 'Vehicle',
      stocknumber: d.inventory_id ? (iById[d.inventory_id]?.stock || null) : null,
      salesperson: d.created_by ? (rById[d.created_by] || null) : null,
      delivery_date: d.delivery_date || null, delivery_time: d.delivery_time || null,
      fni_products: d.fni_products || null, notes: d.notes || null,
      approved_at: d.approved_at || null, selling_price: d.selling_price || null,
      contact_id: d.contact_id || null, inventory_id: d.inventory_id || null,
    }))
    res.json({ deals: rows, cleanup_notify_emails: dealer.data?.cleanup_notify_emails || '' })
  })

  // Deep F&I performance report over a time window (7/30/90/365 days). Deals are
  // cohorted by created_at. F&I gross is the sum of each deal's fni_items prices
  // (the products the F&I office sold); penetration is which products attach and
  // how often. Everything is computed in-process from one bulk fetch + one name
  // lookup so the endpoint stays a couple of round-trips regardless of volume.
  app.get('/fni/reports', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership associated' })
    if (!isMgr(req)) return res.status(403).json({ error: 'Manager access required' })
    const allowed = [7, 30, 90, 365]
    let days = parseInt(req.query.days, 10)
    if (!allowed.includes(days)) days = 30
    const since = new Date(Date.now() - days * 86400000)
    const sinceIso = since.toISOString()

    const { data: deals, error } = await supabaseAdmin.from('deals')
      .select('id, deal_status, created_by, fni_manager, fni_items, addons, fni_products, fni_commission, selling_price, created_at, approved_at, credit_app_at, delivered_at, sold_at')
      .eq('dealership_id', req.dealershipId)
      .gte('created_at', sinceIso)
      .order('created_at', { ascending: false })
      .limit(4000)
    if (error) return res.status(500).json({ error: error.message })
    const list = deals || []

    // Resolve salesperson (created_by) display names in one query.
    const repIds = [...new Set(list.map(d => d.created_by).filter(Boolean))]
    const { data: reps } = repIds.length
      ? await supabaseAdmin.from('profiles').select('id, full_name, display_name').in('id', repIds)
      : { data: [] }
    const rById = Object.fromEntries((reps || []).map(r => [r.id, r.display_name || r.full_name || '—']))

    const num = (v) => {
      if (typeof v === 'number') return isFinite(v) ? v : 0
      const n = parseFloat(String(v == null ? '' : v).replace(/[^0-9.\-]/g, ''))
      return isFinite(n) ? n : 0
    }
    // Products + their $ for a deal. fni_items is [{name, price}]; addons may carry
    // priced F&I add-ons too. fni_products is a free-text fallback (name only, $0)
    // used only when a deal has no structured items.
    const dealProducts = (d) => {
      const out = []
      const scan = (arr) => {
        for (const it of (Array.isArray(arr) ? arr : [])) {
          if (it == null) continue
          const name = String((typeof it === 'object' ? (it.name ?? it.label ?? it.product ?? it.type) : it) || '').trim()
          if (!name) continue
          const price = typeof it === 'object' ? num(it.price ?? it.amount ?? it.cost ?? it.total) : 0
          out.push({ name, price })
        }
      }
      scan(d.fni_items)
      scan(d.addons)
      if (!out.length && typeof d.fni_products === 'string' && d.fni_products.trim()) {
        for (const nm of d.fni_products.split(/[\n,;]+/).map(s => s.trim()).filter(Boolean)) out.push({ name: nm, price: 0 })
      }
      return out
    }
    const gross = (d) => dealProducts(d).reduce((s, p) => s + p.price, 0)
    const isUnit = (d) => d.deal_status === 'sold' || d.deal_status === 'delivered'
    const round2 = (n) => Math.round(n * 100) / 100

    // Status counts.
    const statuses = ['working', 'pending_credit', 'sold', 'delivered']
    const byStatus = Object.fromEntries(statuses.map(s => [s, 0]))
    for (const d of list) if (d.deal_status in byStatus) byStatus[d.deal_status]++
    const deliveredCount = byStatus.delivered
    const unitCount = list.filter(isUnit).length

    // Totals + PVR (per-vehicle-retail = F&I gross ÷ sold/delivered units).
    let totalGross = 0, totalCommission = 0, dealsWithProduct = 0
    for (const d of list) {
      totalGross += gross(d)
      totalCommission += num(d.fni_commission)
      if (dealProducts(d).length) dealsWithProduct++
    }
    const dealCount = list.length
    const pvr = unitCount ? totalGross / unitCount : 0
    const avgGross = dealCount ? totalGross / dealCount : 0

    // Product penetration: attach rate + $ per product, ranked.
    const prodMap = new Map()
    for (const d of list) {
      const seen = new Set()
      for (const p of dealProducts(d)) {
        const key = p.name
        let e = prodMap.get(key)
        if (!e) { e = { product: key, deals: 0, total: 0 }; prodMap.set(key, e) }
        e.total += p.price
        if (!seen.has(key)) { e.deals++; seen.add(key) } // count each deal once per product
      }
    }
    const products = [...prodMap.values()]
      .map(e => ({ product: e.product, deals: e.deals, penetration: dealCount ? round2((e.deals / dealCount) * 100) : 0, total: round2(e.total), avg: e.deals ? round2(e.total / e.deals) : 0 }))
      .sort((a, b) => b.deals - a.deals || b.total - a.total)
      .slice(0, 30)

    // Per-salesperson (created_by) and per-F&I-manager (fni_manager) breakdowns.
    const groupBy = (keyFn, labelFn) => {
      const m = new Map()
      for (const d of list) {
        const key = keyFn(d)
        if (key == null || key === '') continue
        let e = m.get(key)
        if (!e) { e = { key, deals: 0, units: 0, gross: 0, withProduct: 0 }; m.set(key, e) }
        e.deals++
        if (isUnit(d)) e.units++
        e.gross += gross(d)
        if (dealProducts(d).length) e.withProduct++
      }
      return [...m.values()]
        .map(e => ({
          name: labelFn(e.key), deals: e.deals, units: e.units,
          gross: round2(e.gross),
          pvr: e.units ? round2(e.gross / e.units) : 0,
          avg_gross: e.deals ? round2(e.gross / e.deals) : 0,
          attach_rate: e.deals ? round2((e.withProduct / e.deals) * 100) : 0,
        }))
        .sort((a, b) => b.gross - a.gross)
    }
    const perSalesperson = groupBy(d => d.created_by, k => rById[k] || '—')
    const perFniManager = groupBy(d => (typeof d.fni_manager === 'string' ? d.fni_manager.trim() : d.fni_manager), k => String(k))

    // Delivery turnaround (days) on delivered deals with the relevant timestamps.
    const dayDiffs = { approve: [], credit: [] }
    for (const d of list) {
      if (d.deal_status !== 'delivered' || !d.delivered_at) continue
      const del = new Date(d.delivered_at).getTime()
      if (d.approved_at) { const a = new Date(d.approved_at).getTime(); if (isFinite(a) && del >= a) dayDiffs.approve.push((del - a) / 86400000) }
      if (d.credit_app_at) { const c = new Date(d.credit_app_at).getTime(); if (isFinite(c) && del >= c) dayDiffs.credit.push((del - c) / 86400000) }
    }
    const avg = (arr) => arr.length ? round2(arr.reduce((s, n) => s + n, 0) / arr.length) : null
    const turnaround = {
      approved_to_delivered_days: avg(dayDiffs.approve),
      approved_to_delivered_n: dayDiffs.approve.length,
      credit_to_delivered_days: avg(dayDiffs.credit),
      credit_to_delivered_n: dayDiffs.credit.length,
    }

    // Weekly trend (Monday-anchored buckets) of deal count + F&I gross.
    const weekKey = (iso) => {
      const dt = new Date(iso)
      const day = (dt.getUTCDay() + 6) % 7 // 0 = Monday
      const monday = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate() - day))
      return monday.toISOString().slice(0, 10)
    }
    const weekMap = new Map()
    for (const d of list) {
      if (!d.created_at) continue
      const wk = weekKey(d.created_at)
      let e = weekMap.get(wk)
      if (!e) { e = { week: wk, deals: 0, gross: 0, units: 0 }; weekMap.set(wk, e) }
      e.deals++
      e.gross += gross(d)
      if (isUnit(d)) e.units++
    }
    const weekly = [...weekMap.values()].map(e => ({ ...e, gross: round2(e.gross) })).sort((a, b) => a.week.localeCompare(b.week))

    res.json({
      days, since: sinceIso,
      deal_count: dealCount,
      unit_count: unitCount,
      delivered_count: deliveredCount,
      by_status: byStatus,
      total_gross: round2(totalGross),
      total_commission: round2(totalCommission),
      pvr: round2(pvr),
      avg_gross: round2(avgGross),
      deals_with_product: dealsWithProduct,
      overall_attach_rate: dealCount ? round2((dealsWithProduct / dealCount) * 100) : 0,
      products,
      per_salesperson: perSalesperson,
      per_fni_manager: perFniManager,
      turnaround,
      weekly,
    })
  })

  // Approve → save get-ready details, create/refresh the Cleanup card, email teams.
  app.post('/fni/deals/:id/approve', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership associated' })
    if (!isMgr(req)) return res.status(403).json({ error: 'Manager access required' })
    const b = req.body || {}
    const { data: deal } = await supabaseAdmin.from('deals')
      .select('id, inventory_id, contact_id, created_by, deal_number')
      .eq('id', req.params.id).eq('dealership_id', req.dealershipId).maybeSingle()
    if (!deal) return res.status(404).json({ error: 'Deal not found' })

    const now = new Date().toISOString()
    const delivery_date = b.delivery_date || null
    const delivery_time = b.delivery_time || null
    const fni_products = typeof b.fni_products === 'string' ? b.fni_products.slice(0, 2000) : null
    const notes = typeof b.notes === 'string' ? b.notes.slice(0, 2000) : null

    // The approve dialog can attach a stocked vehicle for deals that were desked
    // without one — required for the car to reach Cleanup. Validate it's ours.
    let invId = deal.inventory_id || null
    const pickedInv = typeof b.inventory_id === 'string' ? b.inventory_id.trim() : ''
    if (pickedInv && pickedInv !== invId) {
      const { data: veh } = await supabaseAdmin.from('inventory')
        .select('id').eq('id', pickedInv).eq('dealership_id', req.dealershipId).maybeSingle()
      if (veh) invId = veh.id
    }

    await supabaseAdmin.from('deals')
      .update({ delivery_date, delivery_time, fni_products, notes, approved_at: now, updated_at: now,
        ...(invId && invId !== deal.inventory_id ? { inventory_id: invId } : {}) })
      .eq('id', deal.id).eq('dealership_id', req.dealershipId)

    // Combine date + time into the Cleanup card's delivery timestamp.
    let delivery_at = null
    if (delivery_date) { const d = new Date(`${delivery_date}T${delivery_time || '09:00'}`); if (!isNaN(d)) delivery_at = d.toISOString() }

    // Create or refresh the Cleanup (recon) card for the vehicle.
    if (invId) {
      await ensureGetReadyCard(req.dealershipId, {
        inventoryId: invId, dealId: deal.id, deliveryAt: delivery_at,
        salespersonId: deal.created_by || null, fniProducts: fni_products, notes,
      })
    }

    // Best-effort notification email to managers + salesperson + cleanup/service.
    sendGetReadyEmails(req.dealershipId, deal, { delivery_date, delivery_time, fni_products, notes })
      .catch(e => console.warn('[fni] get-ready email failed:', e.message))

    // `cleanup` tells the UI whether a Cleanup/get-ready card was actually created —
    // it can only happen when the deal is linked to a stocked vehicle.
    res.json({ ok: true, approved_at: now, cleanup: !!invId })
  })

  // Delivered → deal delivered, vehicle sold, customer marked delivered; off the list.
  app.post('/fni/deals/:id/delivered', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership associated' })
    if (!isMgr(req)) return res.status(403).json({ error: 'Manager access required' })
    const { data: deal } = await supabaseAdmin.from('deals')
      .select('id, inventory_id, contact_id').eq('id', req.params.id).eq('dealership_id', req.dealershipId).maybeSingle()
    if (!deal) return res.status(404).json({ error: 'Deal not found' })
    const now = new Date().toISOString()
    await supabaseAdmin.from('deals').update({ deal_status: 'delivered', delivered_at: now, updated_at: now })
      .eq('id', deal.id).eq('dealership_id', req.dealershipId)
    if (deal.inventory_id) await supabaseAdmin.from('inventory').update({ status: 'sold', sold_at: now })
      .eq('id', deal.inventory_id).eq('dealership_id', req.dealershipId)
    if (deal.contact_id) await supabaseAdmin.from('contacts').update({ status: 'delivered', updated_at: now })
      .eq('id', deal.contact_id).eq('dealership_id', req.dealershipId)
    res.json({ ok: true })
  })

  // Cleanup/service notification recipients (external addresses, comma/newline sep).
  app.put('/fni/settings', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership associated' })
    if (!isMgr(req)) return res.status(403).json({ error: 'Manager access required' })
    const emails = typeof req.body?.cleanup_notify_emails === 'string' ? req.body.cleanup_notify_emails.slice(0, 1000) : ''
    const { error } = await supabaseAdmin.from('dealerships').update({ cleanup_notify_emails: emails }).eq('id', req.dealershipId)
    if (error) return res.status(500).json({ error: error.message })
    res.json({ ok: true })
  })
}

// Email the get-ready request to managers + the salesperson + the configured
// cleanup/service addresses. Staff emails come from profiles.business_email.
async function sendGetReadyEmails(dealershipId, deal, info) {
  const { data: dealer } = await supabaseAdmin.from('dealerships')
    .select('name, cleanup_notify_emails').eq('id', dealershipId).maybeSingle()
  const { data: mgrs } = await supabaseAdmin.from('profiles')
    .select('business_email').eq('dealership_id', dealershipId).in('role', MGR)
  const recips = new Set()
  for (const m of (mgrs || [])) if (m.business_email) recips.add(m.business_email.trim())
  if (deal.created_by) {
    const { data: sp } = await supabaseAdmin.from('profiles').select('business_email').eq('id', deal.created_by).maybeSingle()
    if (sp?.business_email) recips.add(sp.business_email.trim())
  }
  for (const e of String(dealer?.cleanup_notify_emails || '').split(/[,\n;]+/).map(s => s.trim()).filter(Boolean)) recips.add(e)
  if (!recips.size) return

  let vehLabel = 'Vehicle', custLabel = ''
  if (deal.inventory_id) {
    const { data: v } = await supabaseAdmin.from('inventory').select('year, make, model, trim, stocknumber').eq('id', deal.inventory_id).maybeSingle()
    if (v) vehLabel = [v.year, v.make, v.model, v.trim].filter(Boolean).join(' ') + (v.stocknumber ? ` (#${v.stocknumber})` : '')
  }
  if (deal.contact_id) {
    const { data: c } = await supabaseAdmin.from('contacts').select('full_name').eq('id', deal.contact_id).maybeSingle()
    custLabel = c?.full_name || ''
  }
  const when = info.delivery_date ? `${info.delivery_date}${info.delivery_time ? ' at ' + info.delivery_time : ''}` : 'TBD'
  const subject = `Get ready: ${vehLabel} — delivery ${when}`
  const html = `<div style="font-family:Arial,sans-serif;font-size:14px;color:#111">
    <h2 style="margin:0 0 10px">Get-ready request</h2>
    <p style="margin:0 0 10px"><b>Vehicle:</b> ${esc(vehLabel)}<br>
    ${custLabel ? `<b>Customer:</b> ${esc(custLabel)}<br>` : ''}
    <b>Delivery:</b> ${esc(when)}<br>
    ${deal.deal_number ? `<b>Deal #:</b> ${esc(String(deal.deal_number))}<br>` : ''}</p>
    ${info.fni_products ? `<p style="margin:0 0 10px"><b>F&amp;I products to install:</b><br>${esc(info.fni_products).replace(/\n/g, '<br>')}</p>` : ''}
    ${info.notes ? `<p style="margin:0 0 10px"><b>Special notes:</b><br>${esc(info.notes).replace(/\n/g, '<br>')}</p>` : ''}
    <p style="color:#666;font-size:12px;margin-top:16px">${esc(dealer?.name || 'Dealership')} · sent by MarketSync</p>
  </div>`
  const text = `Get-ready request\nVehicle: ${vehLabel}\n${custLabel ? 'Customer: ' + custLabel + '\n' : ''}Delivery: ${when}\n${deal.deal_number ? 'Deal #: ' + deal.deal_number + '\n' : ''}${info.fni_products ? 'F&I products: ' + info.fni_products + '\n' : ''}${info.notes ? 'Notes: ' + info.notes + '\n' : ''}`
  await sendEmail({ to: [...recips].join(','), subject, html, text })
}
