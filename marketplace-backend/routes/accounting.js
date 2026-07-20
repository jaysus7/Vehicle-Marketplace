/**
 * Accounting + daily reconciliation — Phase 2 of the accounting platform.
 *
 * The deal + F&I do the inputting automatically: when a deal is delivered we post
 * its front gross and F&I gross to the ledger, and every online deposit posts to
 * Customer Deposits. The accounting team's job is just to add the day's expenses.
 *
 * A daily reconciliation compares the cash a day's delivered deals should have
 * brought in against what's actually recorded (deposits/down payments), tallies the
 * day's income and expenses, and flags anything off — a delivered deal with no cash
 * recorded, or a variance beyond the store's tolerance. When a day is off it emails
 * the accounting team and the GM/owner. (A bank feed via Plaid slots in here later.)
 *
 * The chart of accounts is fully dealer-customizable; a sensible default set is
 * seeded on first use.
 */
import { supabaseAdmin } from '../shared.js'
import { requireAuth } from '../middleware.js'
import { sendEmail } from '../securityAlerts.js'
import { plaidConfigured, plaidStatus, bankTotalsForDay, syncTransactions } from '../providers/plaid.js'

const isMgr = (req) => ['DEALER_ADMIN', 'OWNER', 'MANAGER'].includes(req.profile?.role)
const n = (v) => { const x = Number(v); return Number.isFinite(x) ? x : 0 }
const round2 = (x) => Math.round((Number(x) || 0) * 100) / 100
const money = (x) => '$' + (Number(x) || 0).toLocaleString('en-US', { maximumFractionDigits: 0 })
const cronOk = (req) => (req.headers['x-cron-secret'] || '').trim() === (process.env.CRON_SECRET || '').trim() && !!process.env.CRON_SECRET
const today = () => new Date().toISOString().slice(0, 10)
const monthBounds = (m) => { const b = m ? new Date(m + '-01T00:00:00Z') : new Date(); const from = new Date(Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), 1)); const to = new Date(Date.UTC(b.getUTCFullYear(), b.getUTCMonth() + 1, 1)); return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) } }

// Sensible default chart, seeded once per dealership. `system_key` marks the
// accounts the auto-posting targets.
const DEFAULT_ACCOUNTS = [
  { code: '4000', name: 'Vehicle Gross', category: 'income', system_key: 'vehicle_sales' },
  { code: '4100', name: 'F&I Income', category: 'income', system_key: 'fni_income' },
  { code: '4900', name: 'Other Income', category: 'income' },
  { code: '2050', name: 'Customer Deposits', category: 'liability', system_key: 'customer_deposits' },
  { code: '5000', name: 'Reconditioning', category: 'expense' },
  { code: '6000', name: 'Advertising', category: 'expense' },
  { code: '6100', name: 'Payroll', category: 'expense' },
  { code: '6200', name: 'Rent', category: 'expense' },
  { code: '6300', name: 'Floorplan Interest', category: 'expense' },
  { code: '6400', name: 'Utilities', category: 'expense' },
  { code: '6900', name: 'Other Expense', category: 'expense' },
  { code: '1000', name: 'Cash / Bank', category: 'asset' },
]

async function ensureChart(dealershipId) {
  const { data: existing } = await supabaseAdmin.from('gl_accounts').select('id').eq('dealership_id', dealershipId).limit(1)
  if (existing && existing.length) return
  await supabaseAdmin.from('gl_accounts').insert(DEFAULT_ACCOUNTS.map(a => ({ ...a, dealership_id: dealershipId })))
}
async function accountByKey(dealershipId, key) {
  const { data } = await supabaseAdmin.from('gl_accounts').select('id').eq('dealership_id', dealershipId).eq('system_key', key).eq('active', true).maybeSingle()
  return data?.id || null
}
function settingsOf(d) {
  const s = (d?.accounting_settings && typeof d.accounting_settings === 'object') ? d.accounting_settings : {}
  return {
    enabled: s.enabled !== false,
    tolerance: n(s.tolerance) || 25,
    accounting_emails: Array.isArray(s.accounting_emails) ? s.accounting_emails : [],
    gm_emails: Array.isArray(s.gm_emails) ? s.gm_emails : [],
    auto_post: s.auto_post !== false,
  }
}

// ── Auto-posting (called from the deal + deposit flows) ──────────────────────
// Post a delivered deal's front gross + F&I gross to the ledger. Idempotent: it
// clears any prior deal/F&I entries for the deal first.
export async function postDealToLedger(dealershipId, dealId) {
  try {
    const { data: deal } = await supabaseAdmin.from('deals')
      .select('id, selling_price, cost, fni_items, delivered_at, deal_status').eq('id', dealId).eq('dealership_id', dealershipId).maybeSingle()
    if (!deal) return
    const { data: dlr } = await supabaseAdmin.from('dealerships').select('accounting_settings, cost_tracking_enabled').eq('id', dealershipId).maybeSingle()
    if (!settingsOf(dlr).auto_post) return
    await ensureChart(dealershipId)
    const date = (deal.delivered_at || new Date().toISOString()).slice(0, 10)
    const price = n(deal.selling_price)
    const frontGross = dlr?.cost_tracking_enabled && deal.cost != null ? Math.max(0, price - n(deal.cost)) : price
    const fniGross = (Array.isArray(deal.fni_items) ? deal.fni_items : []).reduce((s, x) => s + n(x?.price), 0)
    await supabaseAdmin.from('gl_entries').delete().eq('dealership_id', dealershipId).eq('ref_deal_id', dealId).in('source', ['deal', 'fni'])
    const rows = []
    const vAcct = await accountByKey(dealershipId, 'vehicle_sales')
    const fAcct = await accountByKey(dealershipId, 'fni_income')
    if (frontGross > 0) rows.push({ dealership_id: dealershipId, entry_date: date, account_id: vAcct, description: 'Vehicle gross (delivered deal)', amount: round2(frontGross), direction: 'in', source: 'deal', ref_deal_id: dealId })
    if (fniGross > 0) rows.push({ dealership_id: dealershipId, entry_date: date, account_id: fAcct, description: 'F&I income (delivered deal)', amount: round2(fniGross), direction: 'in', source: 'fni', ref_deal_id: dealId })
    if (rows.length) await supabaseAdmin.from('gl_entries').insert(rows)
  } catch (e) { console.warn('[accounting] postDealToLedger failed:', e.message) }
}

// Post an online deposit. Idempotent on the payment ref.
export async function postDepositToLedger(dealershipId, { contactId, amountCents, ref, date }) {
  try {
    const { data: dlr } = await supabaseAdmin.from('dealerships').select('accounting_settings').eq('id', dealershipId).maybeSingle()
    if (!settingsOf(dlr).auto_post) return
    if (ref) { const { data: dup } = await supabaseAdmin.from('gl_entries').select('id').eq('dealership_id', dealershipId).eq('ref', String(ref)).limit(1); if (dup && dup.length) return }
    await ensureChart(dealershipId)
    const acct = await accountByKey(dealershipId, 'customer_deposits')
    await supabaseAdmin.from('gl_entries').insert({
      dealership_id: dealershipId, entry_date: (date || new Date().toISOString()).slice(0, 10), account_id: acct,
      description: 'Online deposit received', amount: round2((n(amountCents)) / 100), direction: 'in', source: 'deposit',
      ref: ref ? String(ref) : null, meta: { contact_id: contactId || null },
    })
  } catch (e) { console.warn('[accounting] postDepositToLedger failed:', e.message) }
}

// ── Daily reconciliation ─────────────────────────────────────────────────────
async function reconcileDay(dealershipId, dateStr, { alert = false } = {}) {
  const date = dateStr || today()
  const dayEnd = new Date(new Date(date + 'T00:00:00Z').getTime() + 86400000).toISOString().slice(0, 10)
  const { data: dlr } = await supabaseAdmin.from('dealerships').select('accounting_settings, name').eq('id', dealershipId).maybeSingle()
  const st = settingsOf(dlr)
  const [{ data: delivered }, { data: entries }] = await Promise.all([
    supabaseAdmin.from('deals').select('id, deal_number, selling_price, down_payment, deposit_amount, delivered_at')
      .eq('dealership_id', dealershipId).gte('delivered_at', date).lt('delivered_at', dayEnd),
    supabaseAdmin.from('gl_entries').select('amount, direction, source').eq('dealership_id', dealershipId).eq('entry_date', date),
  ])
  const dd = delivered || []
  const expected_cash = round2(dd.reduce((s, d) => s + n(d.down_payment) + n(d.deposit_amount), 0))
  const recorded_cash = round2((entries || []).filter(e => e.source === 'deposit').reduce((s, e) => s + n(e.amount), 0))
  const income_posted = round2((entries || []).filter(e => e.source === 'deal' || e.source === 'fni').reduce((s, e) => s + n(e.amount), 0))
  const expenses_total = round2((entries || []).filter(e => e.direction === 'out').reduce((s, e) => s + n(e.amount), 0))
  const missing = dd.filter(d => (n(d.down_payment) + n(d.deposit_amount)) === 0)
  const deals_missing_cash = missing.length
  const variance = round2(expected_cash - recorded_cash)

  // Bank cross-check (Plaid) when connected: does money into the bank that day match
  // the cash we recorded (deposits)?
  let bank = null, bank_total = null, bank_variance = 0
  if (plaidConfigured()) {
    const bstat = await plaidStatus(dealershipId).catch(() => ({ connected: false }))
    if (bstat.connected) {
      bank = await bankTotalsForDay(dealershipId, date).catch(() => null)
      if (bank) { bank_total = round2(bank.bank_in - bank.bank_out); bank_variance = round2(bank.bank_in - recorded_cash) }
    }
  }
  const bankOff = bank && Math.abs(bank_variance) > st.tolerance
  const status = (deals_missing_cash > 0 || Math.abs(variance) > st.tolerance || bankOff) ? 'off' : 'balanced'
  const note = deals_missing_cash > 0 ? `${deals_missing_cash} delivered deal(s) have no deposit or down payment recorded.`
    : Math.abs(variance) > st.tolerance ? `Expected cash-in ${money(expected_cash)} vs recorded ${money(recorded_cash)} (off by ${money(variance)}).`
    : bankOff ? `Bank shows ${money(bank.bank_in)} in but ${money(recorded_cash)} was recorded (off by ${money(bank_variance)}).`
    : 'Balanced.'
  const detail = {
    tolerance: st.tolerance,
    missing_deals: missing.map(d => ({ deal_number: d.deal_number, id: d.id })),
    bank: bank ? { bank_in: bank.bank_in, bank_out: bank.bank_out, variance: bank_variance, count: bank.count } : null,
    note,
  }
  const { data: prior } = await supabaseAdmin.from('reconciliations').select('id, alerted').eq('dealership_id', dealershipId).eq('recon_date', date).maybeSingle()
  const row = {
    dealership_id: dealershipId, recon_date: date, expected_cash, recorded_cash, expenses_total, income_posted,
    variance, deals_delivered: dd.length, deals_missing_cash, status, detail, bank_total, ran_at: new Date().toISOString(),
  }
  if (prior) await supabaseAdmin.from('reconciliations').update(row).eq('id', prior.id)
  else await supabaseAdmin.from('reconciliations').insert(row)

  // Email the accounting team + GM/owner when a day is off (once per day).
  let emailed = false
  if (alert && status === 'off' && !prior?.alerted) {
    const to = [...new Set([...st.accounting_emails, ...st.gm_emails])].filter(Boolean)
    if (to.length) {
      const html = `<p><strong>${(dlr?.name || 'Your dealership')}</strong> — the books for <strong>${date}</strong> don't reconcile.</p>
        <ul>
          <li>Delivered deals: ${dd.length}${deals_missing_cash ? ` — <strong>${deals_missing_cash} with no cash recorded</strong>` : ''}</li>
          <li>Expected cash-in: ${money(expected_cash)} · Recorded: ${money(recorded_cash)} · Variance: <strong>${money(variance)}</strong></li>
          <li>Income posted: ${money(income_posted)} · Expenses: ${money(expenses_total)}</li>
          ${bank ? `<li>Bank in: ${money(bank.bank_in)} · Bank out: ${money(bank.bank_out)} · vs recorded: <strong>${money(bank_variance)}</strong></li>` : ''}
        </ul>
        <p>${detail.note}</p><p>Open MarketSync → Accounting to review and close the day.</p>`
      try { await sendEmail({ to, subject: `⚠️ Books don't reconcile — ${date}`, html, text: detail.note }); emailed = true } catch (e) { console.warn('[accounting] alert email failed:', e.message) }
    }
    await supabaseAdmin.from('reconciliations').update({ alerted: emailed || false }).eq('dealership_id', dealershipId).eq('recon_date', date)
  }
  return { ...row, emailed }
}

export function registerAccounting(app) {
  const guard = (req, res) => { if (!req.dealershipId) { res.status(400).json({ error: 'No dealership' }); return false } if (!isMgr(req)) { res.status(403).json({ error: 'Manager access required' }); return false } return true }

  // ── Chart of accounts ───────────────────────────────────────────────────────
  app.get('/accounting/accounts', requireAuth, async (req, res) => {
    if (!guard(req, res)) return
    await ensureChart(req.dealershipId)
    const { data } = await supabaseAdmin.from('gl_accounts').select('*').eq('dealership_id', req.dealershipId).order('code', { ascending: true })
    res.json({ ok: true, accounts: data || [] })
  })
  app.post('/accounting/accounts', requireAuth, async (req, res) => {
    if (!guard(req, res)) return
    const name = String(req.body?.name || '').trim().slice(0, 80)
    const category = String(req.body?.category || '').toLowerCase()
    if (!name || !['income', 'expense', 'asset', 'liability', 'equity'].includes(category)) return res.status(400).json({ error: 'name and a valid category required' })
    const { data, error } = await supabaseAdmin.from('gl_accounts').insert({ dealership_id: req.dealershipId, name, category, code: String(req.body?.code || '').slice(0, 20) || null }).select().single()
    if (error) return res.status(500).json({ error: error.message })
    res.json({ ok: true, account: data })
  })
  app.put('/accounting/accounts/:id', requireAuth, async (req, res) => {
    if (!guard(req, res)) return
    const patch = {}
    if (req.body?.name !== undefined) patch.name = String(req.body.name || '').trim().slice(0, 80)
    if (req.body?.code !== undefined) patch.code = String(req.body.code || '').slice(0, 20) || null
    if (req.body?.category !== undefined) patch.category = String(req.body.category).toLowerCase()
    if (req.body?.active !== undefined) patch.active = !!req.body.active
    const { data, error } = await supabaseAdmin.from('gl_accounts').update(patch).eq('id', req.params.id).eq('dealership_id', req.dealershipId).select().maybeSingle()
    if (error) return res.status(500).json({ error: error.message })
    res.json({ ok: true, account: data })
  })
  app.delete('/accounting/accounts/:id', requireAuth, async (req, res) => {
    if (!guard(req, res)) return
    // Don't hard-delete an account that has entries — deactivate it instead.
    const { data: used } = await supabaseAdmin.from('gl_entries').select('id').eq('account_id', req.params.id).limit(1)
    if (used && used.length) { await supabaseAdmin.from('gl_accounts').update({ active: false }).eq('id', req.params.id).eq('dealership_id', req.dealershipId); return res.json({ ok: true, deactivated: true }) }
    await supabaseAdmin.from('gl_accounts').delete().eq('id', req.params.id).eq('dealership_id', req.dealershipId)
    res.json({ ok: true })
  })

  // ── Ledger entries ───────────────────────────────────────────────────────────
  app.get('/accounting/entries', requireAuth, async (req, res) => {
    if (!guard(req, res)) return
    const from = String(req.query.from || today())
    const to = String(req.query.to || from)
    const toEnd = new Date(new Date(to + 'T00:00:00Z').getTime() + 86400000).toISOString().slice(0, 10)
    const { data } = await supabaseAdmin.from('gl_entries').select('*').eq('dealership_id', req.dealershipId).gte('entry_date', from).lt('entry_date', toEnd).order('entry_date', { ascending: false }).order('created_at', { ascending: false }).limit(2000)
    res.json({ ok: true, entries: data || [] })
  })
  app.post('/accounting/entries', requireAuth, async (req, res) => {
    if (!guard(req, res)) return
    const amount = round2(req.body?.amount)
    const direction = req.body?.direction === 'in' ? 'in' : 'out'   // accounting mostly adds expenses (out)
    if (!amount) return res.status(400).json({ error: 'amount required' })
    const { data, error } = await supabaseAdmin.from('gl_entries').insert({
      dealership_id: req.dealershipId, entry_date: String(req.body?.entry_date || today()).slice(0, 10),
      account_id: req.body?.account_id || null, description: String(req.body?.description || '').slice(0, 200) || null,
      amount: Math.abs(amount), direction, source: 'manual', created_by: req.user?.id || null,
    }).select().single()
    if (error) return res.status(500).json({ error: error.message })
    res.json({ ok: true, entry: data })
  })
  app.delete('/accounting/entries/:id', requireAuth, async (req, res) => {
    if (!guard(req, res)) return
    // Only manual entries can be removed here; auto-posted deal/deposit lines are managed by the system.
    await supabaseAdmin.from('gl_entries').delete().eq('id', req.params.id).eq('dealership_id', req.dealershipId).eq('source', 'manual')
    res.json({ ok: true })
  })

  // ── Reconciliation ───────────────────────────────────────────────────────────
  app.post('/accounting/reconcile', requireAuth, async (req, res) => {
    if (!guard(req, res)) return
    const snap = await reconcileDay(req.dealershipId, String(req.body?.date || today()), { alert: !!req.body?.alert })
    res.json({ ok: true, reconciliation: snap })
  })
  app.get('/accounting/reconciliations', requireAuth, async (req, res) => {
    if (!guard(req, res)) return
    const { from, to } = monthBounds(req.query.month)
    const { data } = await supabaseAdmin.from('reconciliations').select('*').eq('dealership_id', req.dealershipId).gte('recon_date', from).lt('recon_date', to).order('recon_date', { ascending: false })
    res.json({ ok: true, reconciliations: data || [] })
  })

  // ── Reports / insights (P&L-lite for the month) ──────────────────────────────
  app.get('/accounting/report', requireAuth, async (req, res) => {
    if (!guard(req, res)) return
    await ensureChart(req.dealershipId)
    const { from, to } = monthBounds(req.query.month)
    const [{ data: entries }, { data: accounts }] = await Promise.all([
      supabaseAdmin.from('gl_entries').select('account_id, amount, direction, source').eq('dealership_id', req.dealershipId).gte('entry_date', from).lt('entry_date', to),
      supabaseAdmin.from('gl_accounts').select('id, name, category').eq('dealership_id', req.dealershipId),
    ])
    const acct = Object.fromEntries((accounts || []).map(a => [a.id, a]))
    const byAccount = {}
    let income = 0, expense = 0
    for (const e of (entries || [])) {
      const a = acct[e.account_id] || { name: 'Unassigned', category: e.direction === 'out' ? 'expense' : 'income' }
      const key = e.account_id || 'unassigned'
      byAccount[key] = byAccount[key] || { name: a.name, category: a.category, total: 0 }
      byAccount[key].total = round2(byAccount[key].total + n(e.amount))
      if (a.category === 'expense' || e.direction === 'out') expense = round2(expense + n(e.amount))
      else if (a.category === 'income') income = round2(income + n(e.amount))
    }
    const lines = Object.values(byAccount).sort((a, b) => b.total - a.total)
    res.json({ ok: true, month: from.slice(0, 7), income, expense, net: round2(income - expense), income_lines: lines.filter(l => l.category === 'income'), expense_lines: lines.filter(l => l.category === 'expense'), other_lines: lines.filter(l => !['income', 'expense'].includes(l.category)) })
  })

  // ── Settings ──────────────────────────────────────────────────────────────────
  app.get('/accounting/settings', requireAuth, async (req, res) => {
    if (!guard(req, res)) return
    const { data } = await supabaseAdmin.from('dealerships').select('accounting_settings').eq('id', req.dealershipId).maybeSingle()
    res.json({ ok: true, settings: settingsOf(data) })
  })
  app.put('/accounting/settings', requireAuth, async (req, res) => {
    if (!guard(req, res)) return
    const b = req.body || {}
    const parseEmails = (v) => (Array.isArray(v) ? v : String(v || '').split(/[,\s]+/)).map(s => String(s).trim().toLowerCase()).filter(e => /.+@.+\..+/.test(e)).slice(0, 20)
    const next = {
      enabled: b.enabled !== false,
      tolerance: Math.max(0, n(b.tolerance) || 25),
      accounting_emails: parseEmails(b.accounting_emails),
      gm_emails: parseEmails(b.gm_emails),
      auto_post: b.auto_post !== false,
    }
    await supabaseAdmin.from('dealerships').update({ accounting_settings: next }).eq('id', req.dealershipId)
    res.json({ ok: true, settings: next })
  })

  // ── Cron: reconcile yesterday for every dealership, alert on anything off ─────
  app.post('/cron/accounting-reconcile', async (req, res) => {
    if (!cronOk(req)) return res.status(401).json({ error: 'unauthorized' })
    const y = new Date(Date.now() - 86400000).toISOString().slice(0, 10)
    const { data: dealers } = await supabaseAdmin.from('dealerships').select('id, accounting_settings')
    let ran = 0, off = 0
    for (const d of (dealers || [])) {
      if (!settingsOf(d).enabled) continue
      // Pull the latest bank transactions first (if the dealer linked a bank), so the
      // reconciliation sees today's activity.
      if (plaidConfigured()) { try { await syncTransactions(d.id) } catch {} }
      const snap = await reconcileDay(d.id, y, { alert: true }); ran++
      if (snap.status === 'off') off++
    }
    res.json({ ok: true, date: y, ran, off })
  })
}
