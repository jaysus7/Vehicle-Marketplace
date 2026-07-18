/**
 * Accounting sync — books a sold/delivered deal into the dealer's connected accounting
 * system (QuickBooks Online or Xero) as a sales receipt / invoice.
 *
 * Safety by design:
 *  - Opt-in per dealer: only runs when the connector's lender_code_map.autosync === true
 *    (connecting for read/verify never writes to the books until they turn this on).
 *  - Idempotent: a deal is booked at most once (deals.accounting_synced_at guards it).
 *  - Fire-and-forget: never throws into the delivery flow — a books error can't block a sale.
 */
import { supabaseAdmin } from '../shared.js'
import { decryptJson, encryptJson } from '../crypto-pii.js'
import { qboEnsureToken, qboCreateSalesReceipt } from './quickbooks.js'
import { oauthEnsureToken, xeroCreateInvoice } from './oauth.js'

// Which accounting provider is connected AND opted in to auto-sync, if any.
async function pickAccountingProvider(dealershipId) {
  const { data: rows } = await supabaseAdmin.from('dealer_integrations')
    .select('provider, enabled, credentials_enc, lender_code_map')
    .eq('dealership_id', dealershipId).in('provider', ['quickbooks', 'xero'])
  for (const r of (rows || [])) {
    if (r.enabled && r.credentials_enc && r.lender_code_map?.autosync === true) return r
  }
  return null
}

export async function syncDealToAccounting(dealershipId, dealId) {
  try {
    if (!dealershipId || !dealId) return
    const row = await pickAccountingProvider(dealershipId)
    if (!row) return   // nothing connected + opted in — nothing to do

    const { data: deal } = await supabaseAdmin.from('deals')
      .select('id, deal_number, total_price, selling_price, contact_id, accounting_synced_at')
      .eq('id', dealId).eq('dealership_id', dealershipId).maybeSingle()
    if (!deal || deal.accounting_synced_at) return   // gone, or already booked

    const amount = Number(deal.total_price) || Number(deal.selling_price) || 0
    if (!(amount > 0)) return

    let customerName = 'Customer'
    if (deal.contact_id) {
      const { data: c } = await supabaseAdmin.from('contacts').select('full_name, first_name, last_name').eq('id', deal.contact_id).maybeSingle()
      customerName = c?.full_name || [c?.first_name, c?.last_name].filter(Boolean).join(' ') || 'Customer'
    }
    const memo = `MarketSync deal #${deal.deal_number || deal.id}`

    let ref = null
    if (row.provider === 'quickbooks') {
      const ensured = await qboEnsureToken(decryptJson(row.credentials_enc))
      if (ensured.refreshed) await persistCreds(dealershipId, 'quickbooks', ensured.creds)
      ref = await qboCreateSalesReceipt(
        { customerName, amount, memo, docNumber: deal.deal_number },
        { accessToken: ensured.creds.access_token, realmId: row.lender_code_map?.realm_id },
      )
    } else if (row.provider === 'xero') {
      const ensured = await oauthEnsureToken('xero', decryptJson(row.credentials_enc))
      if (ensured.refreshed) await persistCreds(dealershipId, 'xero', ensured.creds)
      ref = await xeroCreateInvoice(
        { customerName, amount, memo },
        { accessToken: ensured.creds.access_token, tenantId: row.lender_code_map?.tenant_id },
      )
    }

    await supabaseAdmin.from('deals').update({
      accounting_synced_at: new Date().toISOString(), accounting_ref: ref, accounting_provider: row.provider,
    }).eq('id', dealId).eq('dealership_id', dealershipId)
  } catch (e) {
    console.warn('[accounting] sync failed:', e.message)
  }
}

async function persistCreds(dealershipId, provider, creds) {
  await supabaseAdmin.from('dealer_integrations')
    .update({ credentials_enc: encryptJson(creds), updated_at: new Date().toISOString() })
    .eq('dealership_id', dealershipId).eq('provider', provider)
}
