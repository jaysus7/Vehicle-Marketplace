/**
 * Outbound webhooks — the "glue" layer. A dealer configures a URL (Settings →
 * Integrations → Webhooks / Zapier) and MarketSync POSTs signed events to it
 * (lead.created, deal.sold, deal.delivered, …), so they can pipe MarketSync into
 * Zapier / Make / QuickBooks / a spreadsheet / anything — no partner approval needed.
 *
 * Config lives on dealer_integrations(provider='webhook'):
 *   lender_code_map = { url, events: [] }   (non-secret; empty events = all)
 *   credentials_enc = { secret }            (optional HMAC signing secret, encrypted)
 *
 * Fire-and-forget: never throws, short timeout, so it can't slow or break a request.
 */
import crypto from 'node:crypto'
import { supabaseAdmin } from './shared.js'
import { decryptJson } from './crypto-pii.js'

export const WEBHOOK_EVENTS = [
  'lead.created', 'deal.sold', 'deal.delivered', 'appointment.booked', 'test.ping',
]

export async function emitWebhook(dealershipId, event, data) {
  try {
    if (!dealershipId || !event) return
    const { data: row } = await supabaseAdmin.from('dealer_integrations')
      .select('enabled, credentials_enc, lender_code_map')
      .eq('dealership_id', dealershipId).eq('provider', 'webhook').maybeSingle()
    if (!row || !row.enabled) return
    const cfg = row.lender_code_map || {}
    const url = cfg.url
    if (!url || !/^https?:\/\//i.test(url)) return
    const events = Array.isArray(cfg.events) ? cfg.events : []
    if (events.length && !events.includes(event)) return   // subscribed to a subset only

    const body = JSON.stringify({ event, dealership_id: dealershipId, at: new Date().toISOString(), data: data || {} })
    const headers = { 'Content-Type': 'application/json', 'X-MarketSync-Event': event }
    if (row.credentials_enc) {
      const secret = decryptJson(row.credentials_enc)?.secret
      if (secret) headers['X-MarketSync-Signature'] = 'sha256=' + crypto.createHmac('sha256', String(secret)).update(body).digest('hex')
    }
    await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(8000) }).catch(() => {})
  } catch (e) { console.warn('[webhook] emit failed:', e.message) }
}
