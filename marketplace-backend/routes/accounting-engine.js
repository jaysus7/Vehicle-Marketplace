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

// account_key → default account spec (created on first use if the chart lacks it).
const ACCOUNT_DEFS = {
  vehicle_sales:       { code: '4000', name: 'Vehicle Gross',        category: 'income' },
  fni_income:          { code: '4100', name: 'F&I Income',           category: 'income' },
  tax_collected:       { code: '2100', name: 'Sales Tax Collected',  category: 'liability' },
  customer_deposits:   { code: '2050', name: 'Customer Deposits',    category: 'liability' },
  accounts_receivable: { code: '1200', name: 'Accounts Receivable',  category: 'asset' },
  cogs:                { code: '5100', name: 'Cost of Goods Sold',   category: 'expense' },
  inventory:           { code: '1400', name: 'Vehicle Inventory',    category: 'asset' },
  commission_expense:  { code: '6110', name: 'Sales Commissions',    category: 'expense' },
  commission_payable:  { code: '2150', name: 'Commission Payable',   category: 'liability' },
  cash:                { code: '1000', name: 'Cash / Bank',          category: 'asset' },
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
    const [{ data: accts }, { data: lines }] = await Promise.all([
      supabaseAdmin.from('gl_accounts').select('id, name, code, category').eq('dealership_id', req.dealershipId),
      supabaseAdmin.from('journal_lines').select('account_id, debit, credit').eq('dealership_id', req.dealershipId),
    ])
    const acc = Object.fromEntries((accts || []).map(a => [a.id, { ...a, debit: 0, credit: 0 }]))
    for (const l of lines || []) { const a = acc[l.account_id]; if (!a) continue; a.debit += n(l.debit); a.credit += n(l.credit) }
    const rows = Object.values(acc).map(a => ({ ...a, debit: round2(a.debit), credit: round2(a.credit), balance: round2(a.debit - a.credit) })).filter(a => a.debit || a.credit)
    const totDr = round2(rows.reduce((s, r) => s + r.debit, 0))
    const totCr = round2(rows.reduce((s, r) => s + r.credit, 0))
    res.json({ rows, total_debit: totDr, total_credit: totCr, balanced: totDr === totCr })
  })
}
