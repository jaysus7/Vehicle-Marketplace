// ─────────────────────────────────────────────────────────────────────────────
// Equity / Lease Pull-Ahead engine (v1).
//   • Lease facts live on customer_ownership_tracking.
//   • Estimated wholesale value + lease payoff computed from a transparent, tunable
//     model (no external book feed yet — approximate, clearly labelled).
//   • "Equity Radar" tiers customers by pull-ahead opportunity.
//   • Pull-ahead action enqueues an 'equity' automation message THROUGH the
//     compliance kill-switch layer (never a raw insert) + a high-priority task.
// ─────────────────────────────────────────────────────────────────────────────
import { supabaseAdmin } from '../shared.js'
import { requireAuth } from '../middleware.js'
import { enqueueForTrigger } from './automation.js'

const isMgr = (req) => ['DEALER_ADMIN', 'OWNER', 'MANAGER'].includes(req.profile?.role)
const OPEN_DEAL = new Set(['appointment', 'sold', 'fni', 'turnover'])
const num = (x) => { const n = Number(x); return Number.isFinite(n) ? n : null }
const US_STATES = new Set(['al', 'ak', 'az', 'ar', 'ca', 'co', 'ct', 'de', 'fl', 'ga', 'hi', 'id', 'il', 'in', 'ia', 'ks', 'ky', 'la', 'me', 'md', 'ma', 'mi', 'mn', 'ms', 'mo', 'mt', 'ne', 'nv', 'nh', 'nj', 'nm', 'ny', 'nc', 'nd', 'oh', 'ok', 'or', 'pa', 'ri', 'sc', 'sd', 'tn', 'tx', 'ut', 'vt', 'va', 'wa', 'wv', 'wi', 'wy'])
// US dealers work in miles; Canadian dealers in km. Drives the default mileage
// allowance and the unit label everywhere.
function regionOf(dealer) {
  const c = String(dealer?.country || '').toLowerCase(), p = String(dealer?.province || '').toLowerCase()
  if (/(^us$|usa|united states|america)/.test(c) || US_STATES.has(p)) return 'US'
  return 'CA'
}

// Dealer-tunable equity assumptions (stored in dealerships.automation_settings.equity).
function equitySettings(dealer) {
  const e = (dealer?.automation_settings && dealer.automation_settings.equity) || {}
  const region = regionOf(dealer)
  const defAllow = region === 'US' ? 15000 : 20000   // 15k mi / yr US, 20k km / yr Canada
  return {
    region, unit: region === 'US' ? 'mi' : 'km',
    annual_km_allowance: Number.isFinite(e.annual_km_allowance) ? e.annual_km_allowance : defAllow,
    wholesale_haircut: Number.isFinite(e.wholesale_haircut) ? e.wholesale_haircut : 0.12,   // retail → wholesale spread
    equity_min: Number.isFinite(e.equity_min) ? e.equity_min : 500,
    high_equity: Number.isFinite(e.high_equity) ? e.high_equity : 1000,
    months_window: Number.isFinite(e.months_window) ? e.months_window : 6,
    // Finance/cash depreciation: how fast a purchased vehicle sheds value per month
    // (0.015 ≈ 18%/yr). Drives the current-value estimate for retail deals.
    depreciation_per_month: Number.isFinite(e.depreciation_per_month) ? e.depreciation_per_month : 0.015,
    // Assumed financing for the upgrade worksheet's replacement payment (clearly an estimate).
    default_apr: Number.isFinite(e.default_apr) ? e.default_apr : 6.9,
    default_term_months: Number.isFinite(e.default_term_months) ? e.default_term_months : 60,
    default_down: Number.isFinite(e.default_down) ? e.default_down : 0,
  }
}

// Standard amortized monthly payment.
function monthlyPayment(principal, apr, term) {
  if (!(principal > 0) || !(term > 0)) return 0
  const r = (Number(apr) || 0) / 100 / 12
  if (r === 0) return Math.round(principal / term)
  return Math.round(principal * r / (1 - Math.pow(1 + r, -term)))
}
const eqLc = (x) => String(x || '').trim().toLowerCase()

// Suggest a replacement unit from live inventory: same model → same make → anything,
// preferring new + newest year. Powers the "put them in this one" side of the worksheet.
async function findReplacement(dealershipId, cur) {
  const { data } = await supabaseAdmin.from('inventory')
    .select('id, year, make, model, trim, price, vin, condition, status, image_urls, mileage')
    .eq('dealership_id', dealershipId).is('archived_at', null)
  let list = (data || []).filter(v => eqLc(v.status || 'available') === 'available' && Number(v.price) > 0)
  if (cur?.id) list = list.filter(v => v.id !== cur.id)
  if (cur?.make) {
    const sameModel = list.filter(v => eqLc(v.make) === eqLc(cur.make) && eqLc(v.model) === eqLc(cur.model))
    const sameMake = list.filter(v => eqLc(v.make) === eqLc(cur.make))
    list = sameModel.length ? sameModel : (sameMake.length ? sameMake : list)
  }
  list.sort((a, b) => (eqLc(b.condition) === 'new' ? 1 : 0) - (eqLc(a.condition) === 'new' ? 1 : 0) || (b.year || 0) - (a.year || 0) || (a.price || 0) - (b.price || 0))
  return list[0] || null
}

// Transparent lease math. Everything here is an ESTIMATE until a desk/lender confirms.
function computeLease(o, s) {
  const deliv = o.delivery_date ? new Date(o.delivery_date) : null
  const now = new Date()
  const monthsInto = deliv ? Math.max(0, Math.round((now - deliv) / (30.44 * 86400000))) : 0
  const term = num(o.lease_term_months) || 0
  const monthsRemaining = term ? Math.max(0, term - monthsInto) : null
  const annualKm = num(o.annual_km_allowance) || s.annual_km_allowance
  const estMileage = (num(o.delivery_mileage) || 0) + Math.round(annualKm * (monthsInto / 12))
  const residual = num(o.residual_value) || 0
  const payment = num(o.monthly_payment) || 0
  // Current retail ≈ residual grown back by the depreciation that hasn't happened yet.
  const retailEst = residual ? Math.round(residual * (1 + 0.015 * (monthsRemaining || 0))) : (num(o.estimated_value) || 0)
  const wholesaleEst = Math.round(retailEst * (1 - s.wholesale_haircut))
  // Early lease payoff ≈ residual buyout + remaining rent (conservative → fewer false positives).
  const payoffEst = o.payoff_amount != null ? num(o.payoff_amount) : Math.round(residual + (monthsRemaining || 0) * payment)
  const equity = (wholesaleEst || 0) - (payoffEst || 0)
  let tier = '📈 Strategy Target'
  if (equity > s.high_equity && monthsRemaining != null && monthsRemaining <= 9) tier = '🔥 High Equity Pull-Ahead'
  else if (monthsRemaining != null && monthsRemaining <= s.months_window) tier = '⏳ Lease Maturity Window'
  return { monthsInto, monthsRemaining, estMileage, retailEst, wholesaleEst, payoffEst, equity, tier }
}
// Remaining balance on an amortized loan after k payments.
function amortBalance(P, apr, term, k) {
  if (!(P > 0) || !(term > 0)) return 0
  const r = (Number(apr) || 0) / 100 / 12
  k = Math.max(0, Math.min(term, k))
  if (r === 0) return Math.max(0, Math.round(P * (term - k) / term))
  const factor = Math.pow(1 + r, term)
  return Math.max(0, Math.round(P * (factor - Math.pow(1 + r, k)) / (factor - 1)))
}
function monthsSince(deliveryDate) {
  const d = deliveryDate ? new Date(deliveryDate) : null
  return d ? Math.max(0, Math.round((Date.now() - d) / (30.44 * 86400000))) : 0
}
function depreciatedValue(basis, s, monthsInto) {
  const dep = Math.min(0.8, (s.depreciation_per_month || 0.015) * monthsInto)
  return basis ? Math.round(basis * (1 - dep)) : 0
}
// Retail finance: equity = today's wholesale − remaining loan balance.
function computeFinance(o, s) {
  const monthsInto = monthsSince(o.delivery_date)
  const term = num(o.lease_term_months) || 0            // loan term (shared column)
  const monthsRemaining = term ? Math.max(0, term - monthsInto) : null
  const annualKm = num(o.annual_km_allowance) || s.annual_km_allowance
  const estMileage = (num(o.delivery_mileage) || 0) + Math.round(annualKm * (monthsInto / 12))
  const basis = num(o.purchase_price) || num(o.msrp) || 0
  const retailEst = basis ? depreciatedValue(basis, s, monthsInto) : (num(o.estimated_value) || 0)
  const wholesaleEst = Math.round(retailEst * (1 - s.wholesale_haircut))
  const payoffEst = o.payoff_amount != null
    ? num(o.payoff_amount)
    : amortBalance(num(o.loan_amount) || basis, num(o.loan_apr) || 0, term, monthsInto)
  const equity = (wholesaleEst || 0) - (payoffEst || 0)
  let tier = '📈 Strategy Target'
  if (equity > s.high_equity) tier = '🔥 High Equity Upgrade'
  else if (monthsRemaining != null && monthsRemaining <= s.months_window) tier = '⏳ Loan Maturing'
  return { monthsInto, monthsRemaining, estMileage, retailEst, wholesaleEst, payoffEst, equity, tier }
}
// Paid cash / owns outright: no payoff, so wholesale value is pure equity.
function computeCash(o, s) {
  const monthsInto = monthsSince(o.delivery_date)
  const annualKm = num(o.annual_km_allowance) || s.annual_km_allowance
  const estMileage = (num(o.delivery_mileage) || 0) + Math.round(annualKm * (monthsInto / 12))
  const basis = num(o.purchase_price) || num(o.msrp) || 0
  const retailEst = basis ? depreciatedValue(basis, s, monthsInto) : (num(o.estimated_value) || 0)
  const wholesaleEst = Math.round(retailEst * (1 - s.wholesale_haircut))
  const equity = wholesaleEst
  return { monthsInto, monthsRemaining: null, estMileage, retailEst, wholesaleEst, payoffEst: 0, equity, tier: equity > s.high_equity ? '🔥 High Equity Upgrade' : '📈 Strategy Target' }
}
function dealTypeOf(o) {
  const dt = eqLc(o.deal_type)
  if (dt === 'finance' || dt === 'cash' || dt === 'lease') return dt
  return o.is_leased ? 'lease' : 'finance'   // legacy rows: is_leased drove everything
}
// Dispatch to the right equity model for this deal.
function computeDeal(o, s) {
  const t = dealTypeOf(o)
  const calc = t === 'lease' ? computeLease(o, s) : t === 'cash' ? computeCash(o, s) : computeFinance(o, s)
  return { ...calc, deal_type: t }
}
// A row has enough entered to bother estimating (avoids empty records on the radar).
function hasDealData(o) {
  return [o.lease_term_months, o.monthly_payment, o.residual_value, o.loan_amount, o.purchase_price, o.payoff_amount, o.msrp, o.estimated_value].some(v => num(v) != null && num(v) !== 0)
}
// Radar filter: in positive equity, or a lease/loan nearing maturity.
function inRadar(c, s) {
  return (c.equity >= s.equity_min)
    || (c.monthsRemaining != null && c.monthsRemaining > 0 && c.monthsRemaining <= s.months_window)
}

async function loadLeasedRows(dealershipId, onlyLeased) {
  let q = supabaseAdmin.from('customer_ownership_tracking').select('*').eq('dealership_id', dealershipId).eq('vehicle_status', 'delivered')
  if (onlyLeased) q = q.eq('is_leased', true)
  const { data: rows } = await q
  const list = rows || []
  const cIds = [...new Set(list.map(r => r.customer_id).filter(Boolean))]
  const vIds = [...new Set(list.map(r => r.vehicle_id).filter(Boolean))]
  const [{ data: contacts }, { data: vehs }] = await Promise.all([
    cIds.length ? supabaseAdmin.from('contacts').select('id, full_name, first_name, last_name, phone, email, assigned_rep, status, opt_out, dnc').in('id', cIds) : Promise.resolve({ data: [] }),
    vIds.length ? supabaseAdmin.from('inventory').select('id, year, make, model, trim, vin').in('id', vIds) : Promise.resolve({ data: [] }),
  ])
  const cById = Object.fromEntries((contacts || []).map(c => [c.id, c]))
  const vById = Object.fromEntries((vehs || []).map(v => [v.id, v]))
  return list.map(o => ({ o, c: cById[o.customer_id] || null, v: vById[o.vehicle_id] || null }))
}

export function registerEquity(app) {
  const cronOk = (req) => (req.headers['x-cron-secret'] || '').trim() === (process.env.CRON_SECRET || '').trim() && !!process.env.CRON_SECRET

  // ── Settings ───────────────────────────────────────────────────────────────
  app.get('/equity/settings', requireAuth, async (req, res) => {
    if (!isMgr(req)) return res.status(403).json({ error: 'Manager access required' })
    const { data: d } = await supabaseAdmin.from('dealerships').select('automation_settings, province, country').eq('id', req.dealershipId).maybeSingle()
    res.json({ settings: equitySettings(d) })
  })
  app.put('/equity/settings', requireAuth, async (req, res) => {
    if (!isMgr(req)) return res.status(403).json({ error: 'Manager access required' })
    const b = req.body || {}
    const { data: cur } = await supabaseAdmin.from('dealerships').select('automation_settings, province, country').eq('id', req.dealershipId).maybeSingle()
    const as = { ...(cur?.automation_settings || {}) }
    const e = { ...(as.equity || {}) }
    if (b.annual_km_allowance !== undefined) e.annual_km_allowance = Math.max(0, parseInt(b.annual_km_allowance) || 20000)
    if (b.wholesale_haircut !== undefined) e.wholesale_haircut = Math.max(0, Math.min(0.5, Number(b.wholesale_haircut) || 0.12))
    if (b.equity_min !== undefined) e.equity_min = Math.max(0, parseInt(b.equity_min) || 0)
    if (b.high_equity !== undefined) e.high_equity = Math.max(0, parseInt(b.high_equity) || 0)
    if (b.months_window !== undefined) e.months_window = Math.max(1, Math.min(24, parseInt(b.months_window) || 6))
    if (b.default_apr !== undefined) e.default_apr = Math.max(0, Math.min(35, Number(b.default_apr) || 0))
    if (b.default_term_months !== undefined) e.default_term_months = Math.max(12, Math.min(96, parseInt(b.default_term_months) || 60))
    if (b.default_down !== undefined) e.default_down = Math.max(0, parseInt(b.default_down) || 0)
    if (b.depreciation_per_month !== undefined) e.depreciation_per_month = Math.max(0, Math.min(0.1, Number(b.depreciation_per_month) || 0.015))
    as.equity = e
    await supabaseAdmin.from('dealerships').update({ automation_settings: as }).eq('id', req.dealershipId)
    res.json({ ok: true, settings: equitySettings({ automation_settings: as, province: cur?.province, country: cur?.country }) })
  })

  // ── Delivered customers — enter/edit lease details ──────────────────────────
  app.get('/equity/leases', requireAuth, async (req, res) => {
    if (!isMgr(req)) return res.status(403).json({ error: 'Manager access required' })
    const { data: d } = await supabaseAdmin.from('dealerships').select('automation_settings, province, country').eq('id', req.dealershipId).maybeSingle()
    const s = equitySettings(d)
    const rows = await loadLeasedRows(req.dealershipId, false)
    const out = rows.map(({ o, c, v }) => ({
      id: o.id, customer_id: o.customer_id, vehicle_id: o.vehicle_id || null,
      name: c?.full_name || [c?.first_name, c?.last_name].filter(Boolean).join(' ') || 'Unknown',
      vehicle: v ? [v.year, v.make, v.model, v.trim].filter(Boolean).join(' ') : '—', vin: v?.vin || null,
      delivery_date: o.delivery_date, is_leased: !!o.is_leased, deal_type: dealTypeOf(o),
      lease_term_months: o.lease_term_months, monthly_payment: o.monthly_payment, residual_value: o.residual_value,
      loan_apr: o.loan_apr, loan_amount: o.loan_amount, purchase_price: o.purchase_price,
      delivery_mileage: o.delivery_mileage, annual_km_allowance: o.annual_km_allowance, payoff_amount: o.payoff_amount,
      ...(hasDealData(o) ? computeDeal(o, s) : {}),
    }))
    res.json({ leases: out })
  })
  app.put('/equity/lease/:id', requireAuth, async (req, res) => {
    if (!isMgr(req)) return res.status(403).json({ error: 'Manager access required' })
    const b = req.body || {}, patch = { updated_at: new Date().toISOString() }
    if (b.vehicle_id !== undefined) {
      if (b.vehicle_id === '' || b.vehicle_id === null) patch.vehicle_id = null
      else {
        // Only allow linking a vehicle this dealership actually owns.
        const { data: veh } = await supabaseAdmin.from('inventory').select('id').eq('id', b.vehicle_id).eq('dealership_id', req.dealershipId).maybeSingle()
        if (!veh) return res.status(400).json({ error: 'Vehicle not found in your inventory' })
        patch.vehicle_id = b.vehicle_id
      }
    }
    if (b.deal_type !== undefined) {
      const dt = eqLc(b.deal_type)
      patch.deal_type = ['lease', 'finance', 'cash'].includes(dt) ? dt : 'finance'
      patch.is_leased = patch.deal_type === 'lease'   // keep the legacy flag in sync
    } else if (b.is_leased !== undefined) {
      patch.is_leased = !!b.is_leased
      patch.deal_type = b.is_leased ? 'lease' : 'finance'
    }
    for (const k of ['lease_term_months', 'delivery_mileage', 'annual_km_allowance']) if (b[k] !== undefined) patch[k] = b[k] === '' ? null : (parseInt(b[k]) || null)
    for (const k of ['monthly_payment', 'residual_value', 'msrp', 'payoff_amount', 'loan_apr', 'loan_amount', 'purchase_price']) if (b[k] !== undefined) patch[k] = b[k] === '' ? null : num(b[k])
    if (b.payoff_amount !== undefined) patch.payoff_estimated = !(b.payoff_amount !== '' && b.payoff_amount != null)
    const { data, error } = await supabaseAdmin.from('customer_ownership_tracking').update(patch).eq('id', req.params.id).eq('dealership_id', req.dealershipId).select('*').maybeSingle()
    if (error) return res.status(500).json({ error: error.message })
    if (!data) return res.status(404).json({ error: 'Record not found' })
    // Refresh the cached estimate immediately.
    const { data: dl } = await supabaseAdmin.from('dealerships').select('automation_settings, province, country').eq('id', req.dealershipId).maybeSingle()
    const calc = computeDeal(data, equitySettings(dl))
    await supabaseAdmin.from('customer_ownership_tracking').update({ estimated_value: calc.wholesaleEst || null, estimated_value_at: new Date().toISOString() }).eq('id', data.id)
    res.json({ ok: true, calc })
  })

  // ── Lease details for one delivered customer (CRM shortcut) ─────────────────
  app.get('/equity/lease/by-contact/:contactId', requireAuth, async (req, res) => {
    if (!isMgr(req)) return res.status(403).json({ error: 'Manager access required' })
    const { data: d } = await supabaseAdmin.from('dealerships').select('automation_settings, province, country').eq('id', req.dealershipId).maybeSingle()
    const s = equitySettings(d)
    // Newest delivered record for this customer.
    const { data: rows } = await supabaseAdmin.from('customer_ownership_tracking')
      .select('*').eq('dealership_id', req.dealershipId).eq('customer_id', req.params.contactId)
      .eq('vehicle_status', 'delivered').order('delivery_date', { ascending: false }).limit(1)
    const o = (rows || [])[0]
    if (!o) return res.json({ lease: null, settings: s })
    let vehicle = '—', vin = null
    if (o.vehicle_id) {
      const { data: v } = await supabaseAdmin.from('inventory').select('year, make, model, trim, vin').eq('id', o.vehicle_id).maybeSingle()
      if (v) { vehicle = [v.year, v.make, v.model, v.trim].filter(Boolean).join(' '); vin = v.vin || null }
    }
    res.json({
      settings: s,
      lease: {
        id: o.id, customer_id: o.customer_id, vehicle_id: o.vehicle_id || null, vehicle, vin,
        delivery_date: o.delivery_date, is_leased: !!o.is_leased, deal_type: dealTypeOf(o),
        lease_term_months: o.lease_term_months, monthly_payment: o.monthly_payment, residual_value: o.residual_value,
        loan_apr: o.loan_apr, loan_amount: o.loan_amount, purchase_price: o.purchase_price,
        delivery_mileage: o.delivery_mileage, annual_km_allowance: o.annual_km_allowance, payoff_amount: o.payoff_amount,
        ...(hasDealData(o) ? computeDeal(o, s) : {}),
      },
    })
  })

  // ── Upgrade worksheet — the AutoAlert-style deal sheet for one customer ──────
  app.get('/equity/worksheet/:id', requireAuth, async (req, res) => {
    if (!isMgr(req)) return res.status(403).json({ error: 'Manager access required' })
    const { data: d } = await supabaseAdmin.from('dealerships').select('automation_settings, province, country').eq('id', req.dealershipId).maybeSingle()
    const s = equitySettings(d)
    const { data: o } = await supabaseAdmin.from('customer_ownership_tracking').select('*').eq('id', req.params.id).eq('dealership_id', req.dealershipId).maybeSingle()
    if (!o) return res.status(404).json({ error: 'Record not found' })
    const { data: c } = await supabaseAdmin.from('contacts').select('id, full_name, first_name, last_name, phone, email, assigned_rep, status, opt_out, dnc').eq('id', o.customer_id).maybeSingle()
    let cur = null
    if (o.vehicle_id) {
      const { data: v } = await supabaseAdmin.from('inventory').select('id, year, make, model, trim, vin, price, mileage, image_urls, condition').eq('id', o.vehicle_id).maybeSingle()
      cur = v || null
    }
    const calc = computeDeal(o, s)
    const curPayment = num(o.monthly_payment) || 0
    // Replacement suggestion + estimated payment (equity applied as cash down).
    const rep = await findReplacement(req.dealershipId, cur)
    let replacement = null
    if (rep) {
      const price = num(rep.price) || 0
      const principal = Math.max(0, price - Math.max(0, calc.equity) - (s.default_down || 0))
      const newPayment = monthlyPayment(principal, s.default_apr, s.default_term_months)
      replacement = {
        id: rep.id, vehicle: [rep.year, rep.make, rep.model, rep.trim].filter(Boolean).join(' '),
        vin: rep.vin || null, price, condition: rep.condition || null,
        image: (Array.isArray(rep.image_urls) ? rep.image_urls[0] : null) || null,
        equity_applied: Math.max(0, calc.equity), down: s.default_down || 0, financed: principal,
        est_payment: newPayment, term: s.default_term_months, apr: s.default_apr,
        payment_delta: curPayment ? newPayment - curPayment : null,
      }
    }
    res.json({
      settings: s,
      customer: {
        id: c?.id, name: c?.full_name || [c?.first_name, c?.last_name].filter(Boolean).join(' ') || 'Unknown',
        phone: c?.phone || null, email: c?.email || null, assigned_rep: c?.assigned_rep || null,
        reachable: c ? (!c.opt_out && !c.dnc) : false,
      },
      current: {
        ownership_id: o.id,
        vehicle: cur ? [cur.year, cur.make, cur.model, cur.trim].filter(Boolean).join(' ') : (o.vehicle_id ? '—' : 'No vehicle linked'),
        vin: cur?.vin || null, image: (Array.isArray(cur?.image_urls) ? cur.image_urls[0] : null) || null,
        is_leased: !!o.is_leased, deal_type: calc.deal_type, monthly_payment: curPayment,
        term: num(o.lease_term_months), months_into: calc.monthsInto, months_remaining: calc.monthsRemaining,
        delivery_mileage: num(o.delivery_mileage), est_mileage: calc.estMileage,
        residual: num(o.residual_value), payoff: calc.payoffEst, wholesale: calc.wholesaleEst,
        equity: calc.equity, tier: calc.tier,
      },
      replacement,
    })
  })

  // ── Equity radar (the tiered opportunity list) ──────────────────────────────
  app.get('/equity/radar', requireAuth, async (req, res) => {
    if (!isMgr(req)) return res.status(403).json({ error: 'Manager access required' })
    const { data: d } = await supabaseAdmin.from('dealerships').select('automation_settings, province, country').eq('id', req.dealershipId).maybeSingle()
    const s = equitySettings(d)
    const rows = await loadLeasedRows(req.dealershipId, false)
    const items = []
    for (const { o, c, v } of rows) {
      if (!c) continue
      if (!hasDealData(o)) continue                                        // nothing entered yet
      if (OPEN_DEAL.has(String(c.status || '').toLowerCase())) continue   // kill switch: skip live deals
      const calc = computeDeal(o, s)
      if (!(calc.wholesaleEst > 0)) continue                              // no value basis to estimate from
      if (!inRadar(calc, s)) continue
      items.push({
        id: o.id, customer_id: o.customer_id, name: c.full_name || [c.first_name, c.last_name].filter(Boolean).join(' ') || 'Unknown',
        phone: c.phone || null, assigned_rep: c.assigned_rep || null, reachable: !c.opt_out && !c.dnc,
        vehicle: v ? [v.year, v.make, v.model].filter(Boolean).join(' ') : '—', vin: v?.vin || null,
        deal_type: calc.deal_type,
        months_remaining: calc.monthsRemaining, est_mileage: calc.estMileage, wholesale: calc.wholesaleEst, payoff: calc.payoffEst,
        equity: calc.equity, tier: calc.tier,
      })
    }
    items.sort((a, b) => b.equity - a.equity || (a.months_remaining ?? 99) - (b.months_remaining ?? 99))
    res.json({ radar: items, settings: s })
  })

  // ── Start a pull-ahead (compliant enqueue + high-priority task) ─────────────
  app.post('/equity/pull-ahead/:id', requireAuth, async (req, res) => {
    if (!isMgr(req)) return res.status(403).json({ error: 'Manager access required' })
    const { data: o } = await supabaseAdmin.from('customer_ownership_tracking').select('*').eq('id', req.params.id).eq('dealership_id', req.dealershipId).maybeSingle()
    if (!o) return res.status(404).json({ error: 'Record not found' })
    const { data: c } = await supabaseAdmin.from('contacts').select('id, assigned_rep, full_name').eq('id', o.customer_id).maybeSingle()
    if (!c) return res.status(404).json({ error: 'Customer not found' })
    // Enqueue through the automation layer so kill switches (opt-out, ownership, live deal) apply.
    await enqueueForTrigger(req.dealershipId, 'equity', { contactId: c.id, vehicleId: o.vehicle_id || null, repId: c.assigned_rep || req.user.id })
    // High-priority task for the rep.
    await supabaseAdmin.from('crm_tasks').insert({
      dealership_id: req.dealershipId, contact_id: c.id, assigned_to: c.assigned_rep || req.user.id, created_by: req.user.id,
      title: `🔥 Pull-ahead: ${c.full_name || 'customer'} — run equity numbers`, type: 'pull_ahead',
      due_at: new Date(Date.now() + 86400000).toISOString(),
    })
    res.json({ ok: true })
  })

  // ── Cron: refresh estimated values (approx wholesale) for all leased rows ────
  app.post('/cron/equity-revalue', async (req, res) => {
    if (!cronOk(req)) return res.status(401).json({ error: 'unauthorized' })
    const { data: dealers } = await supabaseAdmin.from('dealerships').select('id, automation_settings, province, country')
    let updated = 0
    for (const d of (dealers || [])) {
      const s = equitySettings(d)
      const { data: rows } = await supabaseAdmin.from('customer_ownership_tracking').select('*').eq('dealership_id', d.id).eq('vehicle_status', 'delivered')
      for (const o of (rows || [])) {
        if (!hasDealData(o)) continue
        const calc = computeDeal(o, s)
        const patch = { estimated_value: calc.wholesaleEst || null, estimated_value_at: new Date().toISOString() }
        if (o.payoff_estimated) patch.payoff_amount = calc.payoffEst || null
        await supabaseAdmin.from('customer_ownership_tracking').update(patch).eq('id', o.id); updated++
      }
    }
    res.json({ ok: true, updated })
  })
}
