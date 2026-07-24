/**
 * Accounting Engine — event-driven, double-entry (Accounting Engine A2).
 *
 *   financial event → Event Listener → Rule Engine → Journal Engine → Ledger
 *
 * The Journal Engine (postJournal) is the ONLY thing allowed to create financial
 * postings. Every entry is balanced (Σdebit = Σcredit) or it is refused. Postings
 * are immutable and cannot enter a locked period — corrections are reversing entries.
 *
 * This runs IN PARALLEL with the legacy single-sided gl_entries posting during
 * rollout: it writes to the new journal_entries/journal_lines substrate only, so
 * there is no double-count and no behavior regression. Reports can cut over to
 * journals once proven.
 *
 * The commission calculation logic is NOT reimplemented here — the existing
 * commissions.js engine (splits, F&I, volume, spiff, clawback, draw) computes the
 * numbers; this engine only turns its result (deal_commissions.total) into journals.
 */
import { supabaseAdmin } from '../shared.js'
import { requireAuth } from '../middleware.js'
import { onEvent } from './events.js'

const n = (v) => { const x = Number(v); return Number.isFinite(x) ? x : 0 }
const round2 = (x) => Math.round((Number(x) || 0) * 100) / 100

// Full automotive chart of accounts. account_key → account spec, created on first
// use when a posting rule references it (so a dealer only grows the accounts they
// actually post to). Categories: asset|liability|equity|income|cogs|expense.
const ACCOUNT_DEFS = {
  // Assets
  cash:                { code: '1000', name: 'Cash / Bank',            category: 'asset' },
  accounts_receivable: { code: '1100', name: 'Accounts Receivable',   category: 'asset' },
  contracts_in_transit:{ code: '1150', name: 'Contracts in Transit',  category: 'asset' },
  inventory:           { code: '1200', name: 'Vehicle Inventory',     category: 'asset' },
  parts_inventory:     { code: '1300', name: 'Parts Inventory',       category: 'asset' },
  recon_wip:           { code: '1400', name: 'Recon Work in Progress',category: 'asset' },
  prepaids:            { code: '1450', name: 'Prepaids',              category: 'asset' },
  fixed_assets:        { code: '1500', name: 'Fixed Assets',          category: 'asset' },
  tax_paid:            { code: '1600', name: 'Sales Tax Paid / ITCs', category: 'asset' },
  // Liabilities
  accounts_payable:    { code: '2000', name: 'Accounts Payable',      category: 'liability' },
  floorplan_payable:   { code: '2100', name: 'Floorplan Payable',     category: 'liability' },
  tax_collected:       { code: '2200', name: 'Sales Tax Payable',     category: 'liability' },
  commission_payable:  { code: '2300', name: 'Commission Payable',    category: 'liability' },
  payroll_payable:     { code: '2400', name: 'Payroll Payable',       category: 'liability' },
  customer_deposits:   { code: '2500', name: 'Customer Deposits',     category: 'liability' },
  // Equity
  retained_earnings:   { code: '3000', name: 'Retained Earnings',     category: 'equity' },
  // Revenue
  vehicle_sales:       { code: '4000', name: 'Vehicle Sales',         category: 'income' },
  fni_income:          { code: '4100', name: 'F&I Revenue',           category: 'income' },
  service_revenue:     { code: '4200', name: 'Service Revenue',       category: 'income' },
  parts_revenue:       { code: '4300', name: 'Parts Revenue',         category: 'income' },
  warranty_revenue:    { code: '4400', name: 'Warranty Revenue',      category: 'income' },
  accessories_income:  { code: '4500', name: 'Accessories Revenue',   category: 'income' },
  // Cost of sales
  cogs:                { code: '5000', name: 'Vehicle COGS',          category: 'cogs' },
  recon_cost:          { code: '5100', name: 'Recon Cost',           category: 'cogs' },
  parts_cost:          { code: '5200', name: 'Parts Cost',           category: 'cogs' },
  warranty_cost:       { code: '5300', name: 'Warranty Cost',        category: 'cogs' },
  // Expenses
  commission_expense:  { code: '6000', name: 'Sales Commissions',     category: 'expense' },
  advertising:         { code: '6100', name: 'Advertising',          category: 'expense' },
  payroll_expense:     { code: '6200', name: 'Payroll',              category: 'expense' },
  rent:                { code: '6300', name: 'Rent',                 category: 'expense' },
  software:            { code: '6400', name: 'Software',             category: 'expense' },
  utilities:           { code: '6500', name: 'Utilities',           category: 'expense' },
  interest:            { code: '6600', name: 'Floorplan Interest',   category: 'expense' },
}
async function resolveAccount(dealershipId, key) {
  const { data } = await supabaseAdmin.from('gl_accounts').select('id').eq('dealership_id', dealershipId).eq('system_key', key).maybeSingle()
  if (data?.id) return data.id
  const def = ACCOUNT_DEFS[key] || { code: null, name: key, category: 'expense' }
  const { data: created } = await supabaseAdmin.from('gl_accounts').insert({ dealership_id: dealershipId, system_key: key, ...def }).select('id').single()
  return created?.id || null
}

async function periodLocked(dealershipId, dateStr) {
  const period = String(dateStr).slice(0, 7)
  const { data } = await supabaseAdmin.from('accounting_periods').select('status').eq('dealership_id', dealershipId).eq('period', period).maybeSingle()
  return data?.status === 'locked'
}

// ── Journal Engine — the ONLY writer of financial postings ───────────────────
export async function postJournal(dealershipId, { source, eventName, reference, entryDate, workflowInstanceId = null, memo = null, refs = {}, lines }) {
  if (!dealershipId || !Array.isArray(lines) || !lines.length) return null
  const date = (entryDate || new Date().toISOString()).slice(0, 10)
  const totDr = round2(lines.reduce((s, l) => s + n(l.debit), 0))
  const totCr = round2(lines.reduce((s, l) => s + n(l.credit), 0))
  if (totDr !== totCr) { console.error(`[accounting-engine] REFUSED unbalanced ${eventName}: DR ${totDr} != CR ${totCr}`); return null }
  if (totDr === 0) return null
  if (await periodLocked(dealershipId, date)) { console.warn(`[accounting-engine] period locked — skip ${eventName} ${reference}`); return null }
  // Idempotent: one entry per (source, reference, event).
  if (reference) {
    const { data: dup } = await supabaseAdmin.from('journal_entries').select('id')
      .eq('dealership_id', dealershipId).eq('source', source).eq('reference', String(reference)).eq('event_name', eventName).limit(1)
    if (dup && dup.length) return dup[0].id
  }
  const { data: entry, error } = await supabaseAdmin.from('journal_entries').insert({
    dealership_id: dealershipId, entry_date: date, reference: reference ? String(reference) : null,
    source, event_name: eventName, workflow_instance_id: workflowInstanceId, memo,
  }).select('id').single()
  if (error) { console.error('[accounting-engine] entry insert failed:', error.message); return null }
  const lineRows = []
  for (const l of lines) {
    if (!n(l.debit) && !n(l.credit)) continue
    const acct = await resolveAccount(dealershipId, l.account_key)
    if (!acct) continue
    lineRows.push({ journal_entry_id: entry.id, dealership_id: dealershipId, account_id: acct, debit: round2(l.debit), credit: round2(l.credit), department: l.department || null, memo: l.desc || null, ...refs })
  }
  if (lineRows.length) await supabaseAdmin.from('journal_lines').insert(lineRows)
  return entry.id
}

// ── Rule Engine — post an event by the dealership's (or default) posting rule ─
export async function postByRule(dealershipId, eventName, ctx = {}) {
  const { data: rules } = await supabaseAdmin.from('accounting_rules').select('*')
    .eq('event_name', eventName).eq('active', true).or(`dealership_id.eq.${dealershipId},dealership_id.is.null`)
  if (!rules?.length) return null
  const rule = rules.find(r => r.dealership_id === dealershipId) || rules.find(r => !r.dealership_id)
  if (!rule) return null
  const amt = (token) => n(ctx[token])
  const lines = (rule.lines || []).map(l => ({
    account_key: l.account_key, desc: l.desc, department: l.department || null,
    debit: l.side === 'debit' ? amt(l.source) : 0, credit: l.side === 'credit' ? amt(l.source) : 0,
  })).filter(l => n(l.debit) || n(l.credit))
  if (!lines.length) return null
  return postJournal(dealershipId, {
    source: ctx.__source || eventName, eventName, reference: ctx.__reference, entryDate: ctx.__date,
    workflowInstanceId: ctx.__wf || null, refs: ctx.__refs || {}, lines,
  })
}

// ── Context builders (compute amount tokens from real records) ───────────────
async function postDealDelivered(dealershipId, dealId) {
  const { data: deal } = await supabaseAdmin.from('deals')
    .select('id, deal_number, selling_price, cost, fni_items, tax_amount, delivered_at, inventory_id, contact_id')
    .eq('id', dealId).eq('dealership_id', dealershipId).maybeSingle()
  if (!deal) return
  const { data: dlr } = await supabaseAdmin.from('dealerships').select('accounting_settings, cost_tracking_enabled').eq('id', dealershipId).maybeSingle()
  if (dlr?.accounting_settings?.auto_post === false) return
  const price = n(deal.selling_price)
  const fniGross = (Array.isArray(deal.fni_items) ? deal.fni_items : []).reduce((s, x) => s + n(x?.price), 0)
  const tax = n(deal.tax_amount)
  const cost = (dlr?.cost_tracking_enabled && deal.cost != null) ? n(deal.cost) : 0
  const arTotal = round2(price + fniGross + tax)
  const refs = { ref_deal_id: deal.id, ref_vehicle_id: deal.inventory_id || null, ref_contact_id: deal.contact_id || null }
  await postByRule(dealershipId, 'vehicle_delivered', {
    ar_total: arTotal, selling_price: price, fni_gross: fniGross, tax, cost,
    __source: 'deal', __reference: deal.id, __date: (deal.delivered_at || new Date().toISOString()).slice(0, 10), __refs: refs,
  })
}

async function postCommissionCalculated(dealershipId, dealId) {
  const { data: lines } = await supabaseAdmin.from('deal_commissions')
    .select('total, status, period').eq('dealership_id', dealershipId).eq('deal_id', dealId)
  const active = (lines || []).filter(l => l.status !== 'clawed_back')
  const total = round2(active.reduce((s, l) => s + n(l.total), 0))
  if (total <= 0) return
  const date = active[0]?.period || new Date().toISOString().slice(0, 10)
  await postByRule(dealershipId, 'commission_calculated', {
    commission_total: total, __source: 'commission', __reference: dealId, __date: date, __refs: { ref_deal_id: dealId },
  })
}

// ── Event Listener — subscribes to the bus; maps events → posting rules ──────
async function onFinancialEvent(event) {
  if (!event?.dealership_id || event.payload?.engine) return
  const did = event.dealership_id
  try {
    if (event.event_name === 'deal.status_changed' && event.to_state === 'delivered') {
      await postDealDelivered(did, event.entity_id)
    } else if (event.event_name === 'commission.calculated') {
      await postCommissionCalculated(did, event.payload?.deal_id || event.entity_id)
    } else if (event.event_name === 'deposit.paid') {
      const cents = n(event.payload?.amount_cents)
      if (cents > 0) await postByRule(did, 'deposit_received', {
        deposit_amount: round2(cents / 100), __source: 'deposit',
        __reference: event.payload?.payment_ref || event.entity_id, __date: event.created_at,
        __refs: { ref_contact_id: event.entity_id },
      })
    }
  } catch (e) { console.warn('[accounting-engine] listener failed:', e.message) }
}

// ── HTTP surface — journals + trial balance (reports read from the ledger) ───
export function registerAccountingEngine(app) {
  onEvent(onFinancialEvent)   // subscribe the accounting engine to the events bus

  app.get('/accounting/journal', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.status(403).json({ error: 'no dealership' })
    const { data: entries } = await supabaseAdmin.from('journal_entries').select('*')
      .eq('dealership_id', req.dealershipId).order('entry_date', { ascending: false }).order('created_at', { ascending: false }).limit(200)
    const ids = (entries || []).map(e => e.id)
    let lines = []
    if (ids.length) { const { data } = await supabaseAdmin.from('journal_lines').select('*').in('journal_entry_id', ids); lines = data || [] }
    const byEntry = {}
    for (const l of lines) (byEntry[l.journal_entry_id] ||= []).push(l)
    res.json({ entries: (entries || []).map(e => ({ ...e, lines: byEntry[e.id] || [] })) })
  })

  // Trial balance — computed purely from journal_lines (never edited balances).
  app.get('/accounting/trial-balance', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.status(403).json({ error: 'no dealership' })
    const acc = await accountBalances(req.dealershipId, req.query)
    const rows = acc.filter(a => a.debit || a.credit)
    const totDr = round2(rows.reduce((s, r) => s + r.debit, 0))
    const totCr = round2(rows.reduce((s, r) => s + r.credit, 0))
    res.json({ rows, total_debit: totDr, total_credit: totCr, balanced: totDr === totCr })
  })

  // Income statement — revenue − COGS − expense (from journals, optional date range).
  app.get('/accounting/income-statement', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.status(403).json({ error: 'no dealership' })
    const acc = await accountBalances(req.dealershipId, req.query)
    const bucket = (cat) => acc.filter(a => a.category === cat)
    const creditBal = (rows) => round2(rows.reduce((s, a) => s + (a.credit - a.debit), 0))
    const debitBal = (rows) => round2(rows.reduce((s, a) => s + (a.debit - a.credit), 0))
    const revenue = creditBal(bucket('income'))
    const cogs = debitBal(bucket('cogs'))
    const expense = debitBal(bucket('expense'))
    const grossProfit = round2(revenue - cogs)
    const netIncome = round2(grossProfit - expense)
    res.json({
      revenue, cogs, gross_profit: grossProfit, expense, net_income: netIncome,
      revenue_lines: bucket('income').map(a => ({ ...a, amount: round2(a.credit - a.debit) })).filter(a => a.amount),
      cogs_lines: bucket('cogs').map(a => ({ ...a, amount: round2(a.debit - a.credit) })).filter(a => a.amount),
      expense_lines: bucket('expense').map(a => ({ ...a, amount: round2(a.debit - a.credit) })).filter(a => a.amount),
    })
  })

  // Balance sheet — assets = liabilities + equity + net income (from journals).
  app.get('/accounting/balance-sheet', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.status(403).json({ error: 'no dealership' })
    const acc = await accountBalances(req.dealershipId, {})   // balance sheet is cumulative
    const bucket = (cat) => acc.filter(a => a.category === cat)
    const debitBal = (rows) => round2(rows.reduce((s, a) => s + (a.debit - a.credit), 0))
    const creditBal = (rows) => round2(rows.reduce((s, a) => s + (a.credit - a.debit), 0))
    const assets = debitBal(bucket('asset'))
    const liabilities = creditBal(bucket('liability'))
    const equityBase = creditBal(bucket('equity'))
    const netIncome = round2(creditBal(bucket('income')) - debitBal(bucket('cogs')) - debitBal(bucket('expense')))
    const equity = round2(equityBase + netIncome)
    res.json({
      assets, liabilities, equity, net_income: netIncome,
      balanced: assets === round2(liabilities + equity),
      asset_lines: bucket('asset').map(a => ({ ...a, amount: round2(a.debit - a.credit) })).filter(a => a.amount),
      liability_lines: bucket('liability').map(a => ({ ...a, amount: round2(a.credit - a.debit) })).filter(a => a.amount),
      equity_lines: bucket('equity').map(a => ({ ...a, amount: round2(a.credit - a.debit) })).filter(a => a.amount),
    })
  })
}

// Per-account debit/credit totals from journal_lines (optional ?from & ?to on entry_date).
async function accountBalances(dealershipId, query = {}) {
  const { data: accts } = await supabaseAdmin.from('gl_accounts').select('id, name, code, category').eq('dealership_id', dealershipId)
  // Date filter joins through journal_entries.entry_date when a range is given.
  let entryIds = null
  if (query.from || query.to) {
    let eq = supabaseAdmin.from('journal_entries').select('id').eq('dealership_id', dealershipId)
    if (query.from) eq = eq.gte('entry_date', String(query.from))
    if (query.to) eq = eq.lt('entry_date', String(query.to))
    const { data: entries } = await eq.limit(100000)
    entryIds = (entries || []).map(e => e.id)
    if (!entryIds.length) return (accts || []).map(a => ({ ...a, debit: 0, credit: 0 }))
  }
  let lq = supabaseAdmin.from('journal_lines').select('account_id, debit, credit').eq('dealership_id', dealershipId)
  if (entryIds) lq = lq.in('journal_entry_id', entryIds)
  const { data: lines } = await lq.limit(100000)
  const acc = Object.fromEntries((accts || []).map(a => [a.id, { ...a, debit: 0, credit: 0 }]))
  for (const l of lines || []) { const a = acc[l.account_id]; if (!a) continue; a.debit += n(l.debit); a.credit += n(l.credit) }
  return Object.values(acc).map(a => ({ ...a, debit: round2(a.debit), credit: round2(a.credit) }))
}
