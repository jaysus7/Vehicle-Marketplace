import express from 'express';
import cors from 'cors';
import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-base-js'; // Use your exact project import statement

const app = express();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

app.use(cors({ origin: '*' }));

// Webhook parser must run BEFORE standard express.json() middleware
app.post('/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;
      await supabase
        .from('dealerships')
        .update({
          stripe_customer_id: session.customer,
          subscription_id: session.subscription,
          billing_status: 'ACTIVE'
        })
        .eq('id', session.client_reference_id);
      break;
    }
    case 'customer.subscription.deleted': {
      const subscription = event.data.object;
      await supabase
        .from('dealerships')
        .update({ billing_status: 'INACTIVE' })
        .eq('subscription_id', subscription.id);
      break;
    }
    case 'invoice.payment_failed': {
      const invoice = event.data.object;
      if (invoice.subscription) {
        await supabase
          .from('dealerships')
          .update({ billing_status: 'PAST_DUE' })
          .eq('stripe_customer_id', invoice.customer);
      }
      break;
    }
  }
  res.json({ received: true });
});

// Regular JSON Body Middleware for endpoints below
app.use(express.json());

// Placeholder Auth Middleware—verify this matches your JWT decryption signature exactly
async function requireAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'Missing token' });
    const token = authHeader.split(' ')[1];
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) return res.status(401).json({ error: 'Unauthorized' });
    
    const { data: profile } = await supabase
      .from('profiles')
      .select('*, dealerships(*)')
      .eq('id', user.id)
      .single();

    req.profile = profile;
    next();
  } catch (e) {
    res.status(401).json({ error: 'Unauthorized exception' });
  }
}

// POST /billing/checkout
app.post('/billing/checkout', requireAuth, async (req, res) => {
  try {
    const profile = req.profile;
    if (!profile?.dealership_id) return res.status(400).json({ error: 'No dealership profile linked' });

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
      mode: 'subscription',
      client_reference_id: profile.dealership_id,
      success_url: `${process.env.FRONTEND_URL || 'http://localhost:5173'}/dashboard?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.FRONTEND_URL || 'http://localhost:5173'}/dashboard`,
    });

    res.json({ url: session.url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /billing/portal
app.post('/billing/portal', requireAuth, async (req, res) => {
  try {
    const dealership = req.profile?.dealerships;
    if (!dealership || !dealership.stripe_customer_id) {
      return res.status(400).json({ error: 'No billing footprint found.' });
    }
    const session = await stripe.billingPortal.sessions.create({
      customer: dealership.stripe_customer_id,
      return_url: `${process.env.FRONTEND_URL || 'http://localhost:5173'}/dashboard`,
    });
    res.json({ url: session.url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));