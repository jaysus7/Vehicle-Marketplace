/**
 * Square deposit connect + inbound payment webhook. Config-gated on the Square app
 * env vars (see providers/square.js) — every route no-ops cleanly until they're set.
 *
 *   GET  /square/config              -> { configured }
 *   GET  /square/connect             -> { url }   (start OAuth; manager only)
 *   GET  /square/callback            -> browser redirect back into the app
 *   GET  /square/status              -> { connected, ready, location_name, currency }
 *   POST /square/disconnect          -> forget the dealer's tokens
 *   POST /square/webhook             -> Square payment.updated -> stamp "deposit paid"
 */
import express from 'express'
import { supabaseAdmin, BACKEND_URL, FRONTEND_URL } from '../shared.js'
import { requireAuth } from '../middleware.js'
import { stampDepositPaid } from './deposits.js'
import {
  squareConfigured, signState, verifyState, squareAuthorizeUrl, squareExchangeCode,
  squareStoreGrant, squareStatus, squareDisconnect, squareGetOrderReference, verifySquareWebhook, PROVIDER,
} from '../providers/square.js'

const isMgr = (req) => ['DEALER_ADMIN', 'OWNER', 'MANAGER'].includes(req.profile?.role)

export function registerSquare(app) {
  app.get('/square/config', requireAuth, (req, res) => res.json({ ok: true, configured: squareConfigured() }))

  app.get('/square/connect', requireAuth, (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership' })
    if (!isMgr(req)) return res.status(403).json({ error: 'Manager access required' })
    if (!squareConfigured()) return res.status(501).json({ error: 'Square isn’t configured on this server yet.' })
    res.json({ url: squareAuthorizeUrl(signState(req.dealershipId)) })
  })

  // Square redirects the browser here (no JWT) — the signed `state` proves the dealership.
  app.get('/square/callback', async (req, res) => {
    const backTo = (ok, msg) => res.redirect(`${FRONTEND_URL}/dashboard.html?integration=square&status=${ok ? 'connected' : 'error'}${msg ? '&msg=' + encodeURIComponent(msg) : ''}`)
    try {
      const { code, state } = req.query
      const dealershipId = verifyState(state)
      if (!dealershipId || !code) return backTo(false, 'Link expired — try connecting again.')
      const grant = await squareExchangeCode(String(code))
      const loc = await squareStoreGrant(dealershipId, grant)
      if (!loc?.id) return backTo(false, 'Connected, but no Square location was found on the account.')
      backTo(true)
    } catch (e) {
      console.error('[square] callback failed:', e.message)
      backTo(false, e.message)
    }
  })

  app.get('/square/status', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership' })
    res.json({ ok: true, configured: squareConfigured(), ...(await squareStatus(req.dealershipId)) })
  })

  app.post('/square/disconnect', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership' })
    if (!isMgr(req)) return res.status(403).json({ error: 'Manager access required' })
    await squareDisconnect(req.dealershipId)
    res.json({ ok: true })
  })

  // Inbound Square webhook (payment.updated). Raw body needed for signature verification.
  app.post('/square/webhook', express.raw({ type: '*/*' }), async (req, res) => {
    const raw = req.body instanceof Buffer ? req.body.toString('utf8') : String(req.body || '')
    const notificationUrl = `${BACKEND_URL}/square/webhook`
    if (!verifySquareWebhook(raw, req.get('x-square-hmacsha256-signature'), notificationUrl)) {
      return res.status(400).send('bad signature')
    }
    let evt = {}
    try { evt = JSON.parse(raw) } catch { return res.status(400).send('bad json') }
    // Ack immediately; process best-effort.
    res.json({ ok: true })
    try {
      if (evt.type !== 'payment.updated' && evt.type !== 'payment.created') return
      const payment = evt.data?.object?.payment
      if (!payment || payment.status !== 'COMPLETED') return
      const merchantId = evt.merchant_id || payment.merchant_id
      const orderId = payment.order_id
      if (!merchantId || !orderId) return
      // Map the Square merchant back to a dealership.
      const { data: row } = await supabaseAdmin.from('dealer_integrations')
        .select('dealership_id, lender_code_map').eq('provider', PROVIDER)
        .contains('lender_code_map', { merchant_id: merchantId }).maybeSingle()
      if (!row?.dealership_id) return
      const ref = await squareGetOrderReference(row.dealership_id, orderId)
      const m = /^dep_([0-9a-f-]{36})$/i.exec(ref?.reference_id || '')
      const contactId = m ? m[1] : null
      const amountCents = payment.amount_money?.amount ?? ref?.total ?? null
      const currency = (payment.amount_money?.currency || ref?.currency || 'usd').toLowerCase()
      await stampDepositPaid({
        dealershipId: row.dealership_id, contactId, amountCents, currency,
        vehicleLabel: 'a vehicle', provider: 'Square', paymentRef: payment.id || null,
      })
    } catch (e) { console.warn('[square] webhook processing failed:', e.message) }
  })
}
