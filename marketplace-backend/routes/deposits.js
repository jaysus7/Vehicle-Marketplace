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
import { squareStatus, squareCreateDepositLink } from '../providers/square.js'
import { postDepositToLedger } from './accounting.js'
import { emitEvent } from './events.js'

const PROVIDER = 'stripe_deposits'
const isMgr = (req) => ['DEALER_ADMIN', 'OWNER', 'MANAGER'].includes(req.profile?.role)
export const stripeDepositsConfigured = () => !!process.env.STRIPE_SECRET_KEY
const clampAmount = (n) => Math.min(100000, Math.max(1, Math.round(Number(n) || 0)))
const currencyFor = (country) => /(^ca$|canada)/i.test(String(country || '')) ? 'cad' : 'usd'
const isCanada = (country) => /(^ca$|canada)/i.test(String(country || ''))

// Bank-transfer deposits (opt-in). Lower fees than cards: Canadian dealers get
// pre-authorized debit (acss_debit, the Interac/PAD bank rail); US dealers get ACH
// (us_bank_account). We ADD it alongside card; if the connected account hasn't
// enabled that method, Stripe rejects the session and we transparently retry
// card-only, so a deposit link can never fail because of this option.
function depositMethodTypes(country, acceptBank) {
  if (!acceptBank) return ['card']
  return isCanada(country) ? ['card', 'acss_debit'] : ['card', 'us_bank_account']
}
// Create a deposit Checkout Session, degrading to card-only if the bank method is
// unavailable on the connected account.
async function createDepositSession(params, methodTypes) {
  try {
    return await stripe.checkout.sessions.create({ ...params, payment_method_types: methodTypes })
  } catch (e) {
    if (methodTypes.length > 1) {
      return await stripe.checkout.sessions.create({ ...params, payment_method_types: ['card'] })
    }
    throw e
  }
}

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
// Shared "a deposit was paid" side-effects, provider-agnostic: timeline note on the
// customer record, a "Deposit" tag (so the CRM/website "Paid" surfaces it), an optional
// lead note, and a rep notification. Used by both the Stripe and Square deposit flows.
export async function stampDepositPaid({ dealershipId, contactId, leadId, amountCents, currency, vehicleLabel, provider, paymentRef, repId }) {
  if (!dealershipId) return
  const amountStr = amountCents != null ? '$' + (amountCents / 100).toLocaleString('en-US') : 'a deposit'
  const vehicle = vehicleLabel || 'a vehicle'
  if (contactId) {
    try {
      await supabaseAdmin.from('communications').insert({
        dealership_id: dealershipId, contact_id: contactId, channel: 'note', direction: 'internal',
        subject: 'Deposit received',
        body: `Paid ${amountStr} to reserve ${vehicle}${provider ? ` (via ${provider})` : ''}.`,
        meta: { kind: 'deposit_paid', amount_total: amountCents, currency, vehicle, provider: provider || 'stripe', payment_ref: paymentRef || null },
      })
      const { data: c } = await supabaseAdmin.from('contacts').select('tags').eq('id', contactId).maybeSingle()
      const tags = Array.isArray(c?.tags) ? c.tags : []
      if (!tags.includes('Deposit')) tags.push('Deposit')
      await supabaseAdmin.from('contacts').update({ tags, last_activity_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', contactId)
    } catch (e) { console.warn('[deposits] stamp contact failed:', e.message) }
  }
  if (leadId) {
    try { await supabaseAdmin.from('leads').update({ comments: `💳 Deposit paid (${amountStr}) to reserve ${vehicle}.` }).eq('id', leadId) } catch {}
  }
  await createNotification({
    dealershipId, type: 'new_lead',
    title: `💳 Deposit received — ${amountStr}`,
    body: `${amountStr} paid to reserve ${vehicle}. Confirm the hold and follow up.`,
    linkPage: 'crm', targetUserId: repId || null,
  })
  // Post the deposit to the accounting ledger (idempotent on the payment ref).
  postDepositToLedger(dealershipId, { contactId, amountCents, ref: paymentRef, date: new Date().toISOString() })
  // Emit to the unified activity spine (timeline + workflow trigger).
  if (contactId) {
    emitEvent({
      dealershipId, eventName: 'deposit.paid', entityType: 'customer', entityId: contactId,
      summary: `Deposit paid — ${amountStr}`, department: 'Accounting', createdBy: repId || null,
      payload: { amount_cents: amountCents, currency, vehicle, provider: provider || 'stripe', payment_ref: paymentRef || null, lead_id: leadId || null },
    })
  }
}

export async function handleDepositCheckout(session) {
  const meta = session.metadata || {}
  if (meta.kind !== 'deposit' || !meta.dealership_id) return
  const paid = session.payment_status === 'paid' || session.status === 'complete'
  if (!paid) return
  await stampDepositPaid({
    dealershipId: meta.dealership_id, contactId: meta.contact_id || null, leadId: meta.lead_id || null,
    amountCents: session.amount_total, currency: session.currency, vehicleLabel: meta.vehicle_label,
    provider: 'Stripe', paymentRef: session.payment_intent || null, repId: meta.rep_id || null,
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
      accept_bank: !!m.accept_bank,
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
    if (b.accept_bank !== undefined) patch.lender_code_map.accept_bank = !!b.accept_bank
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

      const session = await createDepositSession({
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
      }, depositMethodTypes(d.country, row?.lender_code_map?.accept_bank))
      res.json({ url: session.url })
    } catch (e) {
      console.error('[deposits] checkout failed:', e.message)
      res.status(400).json({ error: 'Could not start the deposit checkout. Please try again.' })
    }
  })

  // In-deal deposit — a rep generates a real deposit payment link for a customer as
  // part of desking a deal. Same destination-charge flow as the website route, but
  // authenticated and tied to an existing CRM contact (and optional vehicle). The
  // link is sent to / opened for the customer; the shared webhook stamps it paid.
  app.post('/deposits/checkout', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership' })
    const b = req.body || {}
    const contactId = String(b.contact_id || '')
    if (!contactId) return res.status(400).json({ error: 'contact_id required' })
    const { data: contact } = await supabaseAdmin.from('contacts')
      .select('id, full_name, email, phone').eq('id', contactId).eq('dealership_id', req.dealershipId).maybeSingle()
    if (!contact) return res.status(404).json({ error: 'Customer not found' })

    // Which payout rail is this dealer set up on? Prefer Stripe; fall back to Square.
    const row = await getRow(req.dealershipId)
    const m = row?.lender_code_map || {}
    const stripeReady = stripeDepositsConfigured() && row?.enabled && m.account_id && m.charges_enabled
    const sq = await squareStatus(req.dealershipId)

    let inventory_id = null, vehicleLabel = 'a vehicle'
    if (b.vehicle_id) {
      const { data: v } = await supabaseAdmin.from('inventory').select('id, dealership_id, year, make, model, trim').eq('id', b.vehicle_id).maybeSingle()
      if (v && v.dealership_id === req.dealershipId) { inventory_id = v.id; vehicleLabel = [v.year, v.make, v.model, v.trim].filter(Boolean).join(' ') || vehicleLabel }
    }
    const { data: dealer } = await supabaseAdmin.from('dealerships').select('name, country').eq('id', req.dealershipId).maybeSingle()
    const dealerName = dealer?.name || 'the dealership'

    // Square path — used when the dealer connected Square (and Stripe deposits isn't ready).
    if (!stripeReady && sq.ready) {
      const amount = clampAmount(b.amount || 500)
      try {
        const link = await squareCreateDepositLink({
          dealershipId: req.dealershipId, amount,
          description: `Deposit — ${vehicleLabel} — ${dealerName}`,
          buyerEmail: contact.email || undefined, reference: `dep_${contactId}`,
          redirectUrl: `${FRONTEND_URL}/dashboard.html?deposit=success`,
        })
        if (!link.url) throw new Error('Square did not return a link.')
        return res.json({ ok: true, url: link.url, amount, currency: link.currency, provider: 'square' })
      } catch (e) {
        console.error('[deposits] square link failed:', e.message)
        return res.status(400).json({ error: e.message || 'Could not create the Square deposit link.' })
      }
    }

    if (!stripeReady) {
      return res.status(400).json({ error: 'Connect a payouts account (Stripe or Square) in Settings → Deposits before collecting a deposit.' })
    }
    const accountId = m.account_id
    const amount = clampAmount(b.amount || m.deposit_amount || 500)
    const currency = m.currency || 'usd'
    try {
      const session = await createDepositSession({
        mode: 'payment',
        line_items: [{
          price_data: {
            currency,
            product_data: { name: `Deposit — ${vehicleLabel}`, description: `Holds ${vehicleLabel} at ${dealerName}. Refundable per dealership policy.` },
            unit_amount: amount * 100,
          },
          quantity: 1,
        }],
        payment_intent_data: {
          on_behalf_of: accountId,
          transfer_data: { destination: accountId },
          description: `Deal deposit — ${vehicleLabel} — ${dealerName}`,
        },
        customer_email: contact.email || undefined,
        success_url: `${FRONTEND_URL}/dashboard.html?deposit=success`,
        cancel_url: `${FRONTEND_URL}/dashboard.html?deposit=cancelled`,
        metadata: {
          kind: 'deposit', dealership_id: req.dealershipId, contact_id: contactId,
          vehicle_id: inventory_id || '', vehicle_label: vehicleLabel, source: 'deal_desk',
        },
      }, depositMethodTypes(dealer?.country, m.accept_bank))
      res.json({ ok: true, url: session.url, amount, currency })
    } catch (e) {
      console.error('[deposits] deal checkout failed:', e.message)
      res.status(400).json({ error: 'Could not create the deposit link. Please try again.' })
    }
  })
}
