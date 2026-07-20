/**
 * Plaid connect + sync routes (accounting → Bank account). Config-gated on the
 * Plaid app keys; every route no-ops cleanly until they're set.
 *
 *   GET  /plaid/config        -> { configured }
 *   POST /plaid/link-token    -> { link_token }   (opens Plaid Link on the client)
 *   POST /plaid/exchange      -> stores the linked item
 *   GET  /plaid/status        -> { connected, institution_name, accounts, last_sync }
 *   POST /plaid/sync          -> pull latest transactions now
 *   POST /plaid/disconnect    -> forget the item
 *   GET  /plaid/transactions  -> recent transactions (for the Bank account view)
 */
import { supabaseAdmin } from '../shared.js'
import { requireAuth } from '../middleware.js'
import {
  plaidConfigured, createLinkToken, exchangePublicToken, plaidStatus, plaidDisconnect, syncTransactions,
} from '../providers/plaid.js'

const isMgr = (req) => ['DEALER_ADMIN', 'OWNER', 'MANAGER'].includes(req.profile?.role)

export function registerPlaid(app) {
  app.get('/plaid/config', requireAuth, (req, res) => res.json({ ok: true, configured: plaidConfigured() }))

  app.post('/plaid/link-token', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership' })
    if (!isMgr(req)) return res.status(403).json({ error: 'Manager access required' })
    if (!plaidConfigured()) return res.status(501).json({ error: 'Bank linking isn’t configured on this server yet.' })
    try { res.json({ ok: true, link_token: await createLinkToken(req.dealershipId) }) }
    catch (e) { res.status(400).json({ error: e.message || 'Could not start bank linking.' }) }
  })

  app.post('/plaid/exchange', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership' })
    if (!isMgr(req)) return res.status(403).json({ error: 'Manager access required' })
    const publicToken = String(req.body?.public_token || '')
    if (!publicToken) return res.status(400).json({ error: 'public_token required' })
    try {
      const info = await exchangePublicToken(req.dealershipId, publicToken)
      syncTransactions(req.dealershipId).catch(() => {})   // first pull in the background
      res.json({ ok: true, ...info })
    } catch (e) { res.status(400).json({ error: e.message || 'Could not link the bank.' }) }
  })

  app.get('/plaid/status', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership' })
    res.json({ ok: true, configured: plaidConfigured(), ...(await plaidStatus(req.dealershipId)) })
  })

  app.post('/plaid/sync', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership' })
    if (!isMgr(req)) return res.status(403).json({ error: 'Manager access required' })
    try { res.json({ ok: true, ...(await syncTransactions(req.dealershipId)) }) }
    catch (e) { res.status(400).json({ error: e.message || 'Sync failed.' }) }
  })

  app.post('/plaid/disconnect', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership' })
    if (!isMgr(req)) return res.status(403).json({ error: 'Manager access required' })
    await plaidDisconnect(req.dealershipId)
    res.json({ ok: true })
  })

  app.get('/plaid/transactions', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership' })
    if (!isMgr(req)) return res.status(403).json({ error: 'Manager access required' })
    const { data } = await supabaseAdmin.from('bank_transactions').select('*')
      .eq('dealership_id', req.dealershipId).order('txn_date', { ascending: false }).limit(100)
    res.json({ ok: true, transactions: data || [] })
  })
}
