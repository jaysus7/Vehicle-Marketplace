/**
 * Plaid bank feed — phase 3 of the accounting platform. Links a dealership's bank
 * account and pulls daily transactions so reconciliation gets a third cross-check
 * (bank vs recorded deals/deposits/expenses). Config-gated on the Plaid app keys;
 * every route no-ops cleanly until they're set:
 *
 *   PLAID_CLIENT_ID, PLAID_SECRET, PLAID_ENV ('sandbox' | 'development' | 'production')
 *
 * Per-dealer access token lives encrypted in dealer_integrations.credentials_enc
 * (with the transactions-sync cursor); the item/institution/accounts (non-secret)
 * live in lender_code_map. Uses Plaid's REST API directly — no SDK dependency.
 */
import { supabaseAdmin } from '../shared.js'
import { encryptJson, decryptJson } from '../crypto-pii.js'

export const PROVIDER = 'plaid'
export const plaidConfigured = () => !!(process.env.PLAID_CLIENT_ID && process.env.PLAID_SECRET)
const plaidBase = () => {
  const env = String(process.env.PLAID_ENV || 'sandbox').toLowerCase()
  return env === 'production' ? 'https://production.plaid.com' : env === 'development' ? 'https://development.plaid.com' : 'https://sandbox.plaid.com'
}
async function plaidReq(path, body) {
  const r = await fetch(`${plaidBase()}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: process.env.PLAID_CLIENT_ID, secret: process.env.PLAID_SECRET, ...body }),
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(j.error_message || j.error_code || 'Plaid request failed')
  return j
}

export async function createLinkToken(dealershipId) {
  const j = await plaidReq('/link/token/create', {
    client_name: 'MarketSync', language: 'en', country_codes: ['US', 'CA'],
    user: { client_user_id: String(dealershipId) }, products: ['transactions'],
  })
  return j.link_token
}

async function getRow(dealershipId) {
  const { data } = await supabaseAdmin.from('dealer_integrations')
    .select('enabled, status, lender_code_map, credentials_enc').eq('dealership_id', dealershipId).eq('provider', PROVIDER).maybeSingle()
  return data || null
}

// Exchange the public token from Plaid Link and store the item, encrypted.
export async function exchangePublicToken(dealershipId, publicToken) {
  const ex = await plaidReq('/item/public_token/exchange', { public_token: publicToken })
  const accessToken = ex.access_token
  // Label the connection: institution name + accounts.
  let institution_name = null, accounts = []
  try {
    const acc = await plaidReq('/accounts/get', { access_token: accessToken })
    accounts = (acc.accounts || []).map(a => ({ id: a.account_id, name: a.name, mask: a.mask, subtype: a.subtype }))
    const instId = acc.item?.institution_id
    if (instId) {
      try { const inst = await plaidReq('/institutions/get_by_id', { institution_id: instId, country_codes: ['US', 'CA'] }); institution_name = inst.institution?.name || null } catch {}
    }
  } catch {}
  await supabaseAdmin.from('dealer_integrations').upsert({
    dealership_id: dealershipId, provider: PROVIDER, enabled: true, status: 'connected',
    credentials_enc: encryptJson({ access_token: accessToken, cursor: null }),
    lender_code_map: { item_id: ex.item_id || null, institution_name, accounts, connected_at: new Date().toISOString(), last_sync: null },
    last_status_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  }, { onConflict: 'dealership_id,provider' })
  return { institution_name, accounts }
}

export async function plaidStatus(dealershipId) {
  const row = await getRow(dealershipId)
  const m = row?.lender_code_map || {}
  return { connected: !!row?.credentials_enc, enabled: !!row?.enabled, institution_name: m.institution_name || null, accounts: m.accounts || [], last_sync: m.last_sync || null }
}

export async function plaidDisconnect(dealershipId) {
  const row = await getRow(dealershipId)
  const creds = row?.credentials_enc ? decryptJson(row.credentials_enc) : null
  if (creds?.access_token) { try { await plaidReq('/item/remove', { access_token: creds.access_token }) } catch {} }
  await supabaseAdmin.from('dealer_integrations').update({ enabled: false, status: 'disconnected', credentials_enc: null, updated_at: new Date().toISOString() })
    .eq('dealership_id', dealershipId).eq('provider', PROVIDER)
}

// Pull new/changed transactions via /transactions/sync and upsert them. Plaid's
// amount convention: positive = money OUT of the account, negative = money IN — we
// normalise to a `direction` ('in' | 'out') and store the absolute amount.
export async function syncTransactions(dealershipId) {
  const row = await getRow(dealershipId)
  if (!row?.credentials_enc) return { synced: 0 }
  const creds = decryptJson(row.credentials_enc) || {}
  if (!creds.access_token) return { synced: 0 }
  let cursor = creds.cursor || null
  let added = [], modified = [], removed = [], hasMore = true, guard = 0
  while (hasMore && guard++ < 20) {
    const j = await plaidReq('/transactions/sync', { access_token: creds.access_token, cursor: cursor || undefined, count: 500 })
    added = added.concat(j.added || []); modified = modified.concat(j.modified || []); removed = removed.concat(j.removed || [])
    cursor = j.next_cursor; hasMore = !!j.has_more
  }
  const rows = added.concat(modified).map(t => ({
    dealership_id: dealershipId, txn_id: t.transaction_id, account_id: t.account_id,
    name: (t.name || '').slice(0, 200), merchant: (t.merchant_name || null),
    amount: Math.abs(Number(t.amount) || 0), direction: (Number(t.amount) || 0) < 0 ? 'in' : 'out',
    txn_date: t.date, pending: !!t.pending, category: Array.isArray(t.category) ? t.category[0] : (t.personal_finance_category?.primary || null),
  }))
  if (rows.length) await supabaseAdmin.from('bank_transactions').upsert(rows, { onConflict: 'dealership_id,txn_id' })
  for (const r of removed) { if (r.transaction_id) await supabaseAdmin.from('bank_transactions').delete().eq('dealership_id', dealershipId).eq('txn_id', r.transaction_id) }
  await supabaseAdmin.from('dealer_integrations').update({
    credentials_enc: encryptJson({ ...creds, cursor }),
    lender_code_map: { ...(row.lender_code_map || {}), last_sync: new Date().toISOString() }, updated_at: new Date().toISOString(),
  }).eq('dealership_id', dealershipId).eq('provider', PROVIDER)
  return { synced: rows.length, removed: removed.length }
}

// Money in/out from the bank for a given day (used by reconciliation).
export async function bankTotalsForDay(dealershipId, dateStr) {
  const { data } = await supabaseAdmin.from('bank_transactions')
    .select('amount, direction').eq('dealership_id', dealershipId).eq('txn_date', dateStr)
  const rows = data || []
  const round2 = (x) => Math.round((Number(x) || 0) * 100) / 100
  const bank_in = round2(rows.filter(r => r.direction === 'in').reduce((s, r) => s + Number(r.amount), 0))
  const bank_out = round2(rows.filter(r => r.direction === 'out').reduce((s, r) => s + Number(r.amount), 0))
  return { bank_in, bank_out, count: rows.length }
}
