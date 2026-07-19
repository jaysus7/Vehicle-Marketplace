/**
 * Online deposits (Stripe Connect) — lets a dealer take a real, refundable
 * "Reserve this vehicle" deposit on their public MarketSync site, paid straight
 * into the dealer's OWN Stripe account (separate from the MarketSync subscription).
 *
 * Fund flow: destination charge. The platform (MarketSync) creates the Checkout
 * Session and routes funds to the dealer's connected account via transfer_data +
 * on_behalf_of, with the platform liable for negatives (controller.losses.payments
 * = application). We take no application fee today.
 *
 * Storage: the connected-account id + status + deposit config live in the existing
 * dealer_integrations row (provider 'stripe_deposits') — no schema change needed.
 * The account id is not a secret, so it lives in lender_code_map.
 */
import { stripe, supabaseAdmin, FRONTEND_URL } from '../shared.js'
import { requireAuth } from '../middleware.js'
import { createNotification } from '../notifications.js'
import { findOrCreateContact } from './crm.js'

const PROVIDER = 'stripe_deposits'
const isMgr = (req) => ['DEALER_ADMIN', 'OWNER', 'MANAGER'].includes(req.profile?.role)
export const stripeDepositsConfigured = () => !!process.env.STRIPE_SECRET_KEY
const clampAmount = (n) => Math.min(100000, Math.max(1, Math.round(Number(n) || 0)))
const currencyFor = (country) => /(^ca$|canada)/i.test(String(country || '')) ? 'cad' : 'usd'

async function getRow(dealershipId) {
  const { data } = await supabaseAdmin.from('dealer_integrations')
    .select('enabled, status, lender_code_map').eq('dealership_id', dealershipId).eq('provider', PROVIDER).maybeSingle()
  return data || null
}
async function saveRow(dealershipId, patch) {
  await supabaseAdmin.from('dealer_integrations').upsert({
    dealership_id: dealershipId, provider: PROVIDER, updated_at: new Date().toISOString(), ...patch,
  }, { onConflict: 'dealership_id,provider' })
}

// Public helper: is this dealer set up to take deposits, and for how much?
export async function depositConfigForSite(dealershipId) {
  const row = await getRow(dealershipId)
  const m = row?.lender_code_map || {}
  const ready = !!(row?.enabled && m.account_id && m.charges_enabled)
  return ready ? { enabled: true, amount: clampAmount(m.deposit_amount || 500), currency: m.currency || 'usd' } : { enabled: false }
}

// Called from the single Stripe webhook (billing.js) for deposit Checkout Sessions.
export async function handleDepositCheckout(session) {
  const meta = session.metadata || {}
  if (meta.kind !== 'deposit' || !meta.dealership_id) return
  const paid = session.payment_status === 'paid' || session.status === 'complete'
  if (!paid) return
  const amountStr = session.amount_total != null ? '$' + (session.amount_total / 100).toLocaleString('en-US') : 'a deposit'
  const vehicle = meta.vehicle_label || 'a vehicle'
  // Stamp the contact + timeline so the deposit shows on the customer record.
  if (meta.contact_id) {
    try {
      await supabaseAdmin.from('communications').insert({
        dealership_id: meta.dealership_id, contact_id: meta.contact_id, channel: 'note', direction: 'internal',
        subject: 'Online deposit received',
        body: `Paid ${amountStr} to reserve ${vehicle} via the website.`,
        meta: { kind: 'deposit_paid', amount_total: session.amount_total, currency: session.currency, vehicle, payment_intent: session.payment_intent || null },
      })
      // Tag the contact "Deposit" so the CRM/website "Paid" surfaces it, and bump activity.
      const { data: c } = await supabaseAdmin.from('contacts').select('tags').eq('id', meta.contact_id).maybeSingle()
      const tags = Array.isArray(c?.tags) ? c.tags : []
      if (!tags.includes('Deposit')) tags.push('Deposit')
      await supabaseAdmin.from('contacts').update({ tags, last_activity_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', meta.contact_id)
    } catch (e) { console.warn('[deposits] stamp contact failed:', e.message) }
  }
  if (meta.lead_id) {
    try { await supabaseAdmin.from('leads').update({ comments: `💳 Deposit paid online (${amountStr}) to reserve ${vehicle}.` }).eq('id', meta.lead_id) } catch {}
  }
  await createNotification({
    dealershipId: meta.dealership_id, type: 'new_lead',
    title: `💳 Deposit received — ${amountStr}`,
    body: `A shopper paid ${amountStr} online to reserve ${vehicle}. Confirm the hold and follow up.`,
    linkPage: 'crm', targetUserId: meta.rep_id || null,
  })
}

export function registerDeposits(app) {
  // ── Dealer status: connected? charges enabled? current deposit config. ───────
  app.get('/deposits/config', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership' })
    if (!isMgr(req)) return res.status(403).json({ error: 'Manager access required' })
    if (!stripeDepositsConfigured()) return res.json({ available: false })
    const row = await getRow(req.dealershipId)
    const m = row?.lender_code_map || {}
    res.json({
      available: true,
      connected: !!m.account_id,
      charges_enabled: !!m.charges_enabled,
      enabled: !!row?.enabled,
      deposit_amount: clampAmount(m.deposit_amount || 500),
      currency: m.currency || 'usd',
    })
  })

  // ── Start / resume Connect onboarding → returns a Stripe-hosted onboarding URL.
  app.post('/deposits/connect', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership' })
    if (!isMgr(req)) return res.status(403).json({ error: 'Manager access required' })
    if (!stripeDepositsConfigured()) return res.status(503).json({ error: 'Online deposits aren’t enabled on this MarketSync account yet.' })
    try {
      const row = await getRow(req.dealershipId)
      let m = row?.lender_code_map || {}
      let accountId = m.account_id
      if (!accountId) {
        const { data: dealer } = await supabaseAdmin.from('dealerships').select('country, branding, name').eq('id', req.dealershipId).maybeSingle()
        const currency = currencyFor(dealer?.country)
        // v1 accounts with controller properties (no legacy `type`): platform liable,
        // Stripe collects requirements, Express-style dashboard for the dealer.
        const account = await stripe.accounts.create({
          country: currency === 'cad' ? 'CA' : 'US',
          email: dealer?.branding?.email || undefined,
          business_profile: { name: dealer?.name || undefined },
          controller: {
            losses: { payments: 'application' },
            fees: { payer: 'application' },
            stripe_dashboard: { type: 'express' },
            requirement_collection: 'stripe',
          },
          capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
          metadata: { dealership_id: req.dealershipId },
        })
        accountId = account.id
        m = { ...m, account_id: accountId, currency, charges_enabled: false }
        await saveRow(req.dealershipId, { status: 'onboarding', lender_code_map: m })
      }
      const link = await stripe.accountLinks.create({
        account: accountId,
        refresh_url: `${FRONTEND_URL}/dashboard.html?integration=stripe_deposits&status=refresh`,
        return_url: `${FRONTEND_URL}/dashboard.html?integration=stripe_deposits&status=return`,
        type: 'account_onboarding',
      })
      res.json({ url: link.url })
    } catch (e) {
      console.error('[deposits] connect failed:', e.message)
      res.status(400).json({ error: e.message || 'Could not start Stripe onboarding.' })
    }
  })

  // ── Re-check account status with Stripe (call after returning from onboarding).
  app.post('/deposits/refresh', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership' })
    if (!isMgr(req)) return res.status(403).json({ error: 'Manager access required' })
    const row = await getRow(req.dealershipId)
    const m = row?.lender_code_map || {}
    if (!m.account_id) return res.status(400).json({ error: 'Connect your Stripe account first.' })
    try {
      const acct = await stripe.accounts.retrieve(m.account_id)
      const charges_enabled = !!acct.charges_enabled
      await saveRow(req.dealershipId, { status: charges_enabled ? 'connected' : 'onboarding', lender_code_map: { ...m, charges_enabled } })
      res.json({ ok: true, charges_enabled })
    } catch (e) { res.status(400).json({ error: e.message || 'Could not check your Stripe account.' }) }
  })

  // ── Save deposit config: on/off + amount. ────────────────────────────────────
  app.put('/deposits/config', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership' })
    if (!isMgr(req)) return res.status(403).json({ error: 'Manager access required' })
    const row = await getRow(req.dealershipId)
    const m = row?.lender_code_map || {}
    if (!m.account_id) return res.status(400).json({ error: 'Connect your Stripe account first.' })
    const b = req.body || {}
    const patch = { lender_code_map: { ...m } }
    if (b.deposit_amount !== undefined) patch.lender_code_map.deposit_amount = clampAmount(b.deposit_amount)
    if (b.enabled !== undefined) patch.enabled = !!b.enabled && !!m.charges_enabled
    await saveRow(req.dealershipId, patch)
    res.json({ ok: true, deposit_amount: patch.lender_code_map.deposit_amount ?? clampAmount(m.deposit_amount || 500), enabled: patch.enabled ?? !!row?.enabled })
  })

  // ── Disconnect (keeps the Stripe account itself; just unlinks it here). ───────
  app.delete('/deposits/config', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership' })
    if (!isMgr(req)) return res.status(403).json({ error: 'Manager access required' })
    await supabaseAdmin.from('dealer_integrations').delete().eq('dealership_id', req.dealershipId).eq('provider', PROVIDER)
    res.json({ ok: true })
  })

  // ── PUBLIC: shopper pays a deposit to reserve a vehicle → Checkout Session. ──
  app.post('/site/:slug/deposit', async (req, res) => {
    const slug = String(req.params.slug || '').toLowerCase().trim()
    const { data: d } = await supabaseAdmin.from('dealerships').select('id, name, country, site_published').ilike('site_slug', slug).maybeSingle()
    if (!d || !d.site_published) return res.status(404).json({ error: 'Site not found' })
    const cfg = await depositConfigForSite(d.id)
    if (!cfg.enabled) return res.status(400).json({ error: 'Online deposits aren’t available right now.' })
    const row = await getRow(d.id)
    const accountId = row?.lender_code_map?.account_id
    if (!accountId) return res.status(400).json({ error: 'Online deposits aren’t available right now.' })

    const b = req.body || {}
    const name = String(b.name || '').trim().slice(0, 120)
    const email = String(b.email || '').trim().slice(0, 160)
    const phone = String(b.phone || '').trim().slice(0, 40)
    if (!email && !phone) return res.status(400).json({ error: 'Enter an email or phone so we can reach you.' })
    // Return here after Checkout (the shopper's current site page).
    const rawReturn = String(b.return_url || '').trim()
    const backBase = /^https?:\/\//i.test(rawReturn) ? rawReturn.split('#')[0].split('?')[0] : `${FRONTEND_URL}/`

    // Which vehicle (optional) — for the receipt line + rep follow-up.
    let inventory_id = null, vehicleLabel = 'a vehicle'
    if (b.vehicle_id) {
      const { data: v } = await supabaseAdmin.from('inventory').select('id, dealership_id, year, make, model, trim').eq('id', b.vehicle_id).maybeSingle()
      if (v && v.dealership_id === d.id) { inventory_id = v.id; vehicleLabel = [v.year, v.make, v.model, v.trim].filter(Boolean).join(' ') || vehicleLabel }
    }

    try {
      // Capture the intent as a lead + contact up front so it's in the CRM even if
      // the shopper abandons Checkout; the webhook stamps "paid" on success.
      const { data: lead } = await supabaseAdmin.from('leads').insert({
        dealership_id: d.id, name: name || null, email: email || null, phone: phone || null,
        comments: `Wants to reserve ${vehicleLabel} with an online deposit.`, source: 'Reserve / Deposit', inventory_id,
      }).select('id').single()
      const contactId = await findOrCreateContact({ dealershipId: d.id, name, email, phone, source: 'Website' })
      if (contactId && lead?.id) await supabaseAdmin.from('leads').update({ contact_id: contactId }).eq('id', lead.id)

      const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        line_items: [{
          price_data: {
            currency: cfg.currency,
            product_data: { name: `Refundable deposit — ${vehicleLabel}`, description: `Holds ${vehicleLabel} at ${d.name}. Refundable per dealership policy.` },
            unit_amount: cfg.amount * 100,
          },
          quantity: 1,
        }],
        payment_intent_data: {
          on_behalf_of: accountId,
          transfer_data: { destination: accountId },
          description: `Website reserve deposit — ${vehicleLabel} — ${d.name}`,
        },
        customer_email: email || undefined,
        success_url: `${backBase}?deposit=success`,
        cancel_url: `${backBase}?deposit=cancelled`,
        metadata: {
          kind: 'deposit', dealership_id: d.id, contact_id: contactId || '', lead_id: lead?.id || '',
          vehicle_id: inventory_id || '', vehicle_label: vehicleLabel,
        },
      })
      res.json({ url: session.url })
    } catch (e) {
      console.error('[deposits] checkout failed:', e.message)
      res.status(400).json({ error: 'Could not start the deposit checkout. Please try again.' })
    }
  })
}
