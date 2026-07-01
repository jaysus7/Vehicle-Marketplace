import express from 'express'
import { stripe, supabaseAdmin, FRONTEND_URL } from '../shared.js'
import { requireAuth } from '../middleware.js'

export function registerRoutes(app) {
  // ── 1. STRIPE WEBHOOK ──
  app.post('/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    const sig = req.headers['stripe-signature']
    let event
    try {
      event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET)
    } catch (err) {
      return res.status(400).send(`Webhook Error: ${err.message}`)
    }

    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object
        const sub = await stripe.subscriptions.retrieve(session.subscription)
        const meta = session.metadata || {}
        const billing = {
          stripe_customer_id: session.customer,
          subscription_id: session.subscription,
          stripe_price_id: sub.items.data[0].price.id,
          billing_status: 'ACTIVE',
          trial_ends_at: null
        }
        if (meta.type === 'solo_rep' && meta.user_id) {
          await supabaseAdmin.from('profiles').update(billing).eq('id', meta.user_id)
        } else {
          await supabaseAdmin.from('dealerships').update(billing).eq('id', meta.dealership_id || session.client_reference_id)
        }
        break;
      }
      case 'customer.subscription.deleted': {
        const subId = event.data.object.id
        const { data: prof } = await supabaseAdmin.from('profiles').select('id').eq('subscription_id', subId).maybeSingle()
        if (prof) {
          await supabaseAdmin.from('profiles').update({ billing_status: 'INACTIVE' }).eq('id', prof.id)
        } else {
          await supabaseAdmin.from('dealerships').update({ billing_status: 'INACTIVE' }).eq('subscription_id', subId)
        }
        break;
      }
      case 'invoice.payment_failed': {
        const invoice = event.data.object
        if (invoice.subscription && invoice.customer) {
          const { data: prof } = await supabaseAdmin.from('profiles').select('id').eq('stripe_customer_id', invoice.customer).maybeSingle()
          if (prof) {
            await supabaseAdmin.from('profiles').update({ billing_status: 'PAST_DUE' }).eq('id', prof.id)
          } else {
            await supabaseAdmin.from('dealerships').update({ billing_status: 'PAST_DUE' }).eq('stripe_customer_id', invoice.customer)
          }
        }
        break;
      }
    }
    res.json({ received: true })
  })

  // ── 8. BILLING ──
  app.post('/billing/checkout', requireAuth, async (req, res) => {
    const isPersonal = req.profile.dealerships?.is_personal === true
    const isSolo = !req.dealershipId || isPersonal

    if (req.profile.role === 'SALES_REP' && req.dealershipId && !isPersonal) {
      return res.status(403).json({ error: 'Sales reps under a dealership do not manage billing.' })
    }

    const existingCustomerId = isSolo
      ? req.profile.stripe_customer_id
      : req.profile.dealerships?.stripe_customer_id

    // Complimentary / comped account: no Stripe customer was ever created, and the
    // account isn't mid-trial either. Nothing to manage — tell the frontend so it can
    // show a friendly message instead of bouncing them into a brand-new checkout.
    const billingStatus = isSolo
      ? req.profile.billing_status
      : req.profile.dealerships?.billing_status
    if (!existingCustomerId && billingStatus !== 'TRIALING') {
      return res.status(200).json({ complimentary: true })
    }

    const priceId = req.body?.priceId || (isSolo
      ? process.env.STRIPE_SOLO_PRICE_ID
      : process.env.STRIPE_DEALER_PRICE_ID)
    if (!priceId) return res.status(500).json({ error: 'Missing Stripe price ID env var' })

    const metadata = isSolo
      ? { type: 'solo_rep', user_id: req.user.id }
      : { type: 'dealership', dealership_id: req.dealershipId }

    const clientRefId = isSolo ? req.user.id : req.dealershipId

    try {
      if (existingCustomerId) {
        try {
          const portalSession = await stripe.billingPortal.sessions.create({
            customer: existingCustomerId,
            return_url: `${FRONTEND_URL}/dashboard.html`
          })
          return res.json({ url: portalSession.url })
        } catch (portalErr) {
          console.warn('Portal initialization bypassed:', portalErr.message)
        }
      }
      // No Stripe-side trial — we self-manage the 7-day no-card trial via billing_status='TRIALING'.
      // By the time the user hits checkout, their trial has either ended or they chose to upgrade early;
      // either way Stripe charges immediately.
      const session = await stripe.checkout.sessions.create({
        payment_method_types: ['card'],
        line_items: [{ price: priceId, quantity: 1 }],
        mode: 'subscription',
        client_reference_id: clientRefId,
        metadata,
        subscription_data: { metadata },
        success_url: `${FRONTEND_URL}/dashboard.html`,
        cancel_url: `${FRONTEND_URL}/dashboard.html`
      })
      res.json({ url: session.url })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  app.post('/billing/portal', requireAuth, async (req, res) => {
    // Don't HTTP-redirect here — fetch() redirects drop the Authorization header,
    // which causes a 401 on the second hop. Just run checkout's handler directly
    // in-process instead, so auth context carries through correctly.
    req.url = '/billing/checkout'
    app._router.handle(req, res)
  })

  app.get('/billing/trial-status', requireAuth, async (req, res) => {
    const isPersonal = req.profile.dealerships?.is_personal === true
    const useProfileBilling = !req.profile.dealership_id || isPersonal
    const status = useProfileBilling
      ? req.profile.billing_status
      : req.profile.dealerships?.billing_status
    const trialEndsAt = useProfileBilling
      ? req.profile.trial_ends_at
      : req.profile.dealerships?.trial_ends_at

    let daysRemaining = null
    if (status === 'TRIALING' && trialEndsAt) {
      const ms = new Date(trialEndsAt).getTime() - Date.now()
      daysRemaining = Math.max(0, Math.ceil(ms / (1000 * 60 * 60 * 24)))
    }

    res.json({
      status: status || null,
      trial_ends_at: trialEndsAt || null,
      days_remaining: daysRemaining,
      is_active: status === 'ACTIVE',
      is_trialing: status === 'TRIALING' && daysRemaining !== null && daysRemaining > 0
    })
  })
}
