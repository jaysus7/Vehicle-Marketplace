import 'dotenv/config'; 
import express from 'express';
import cors from 'cors';
import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

const app = express();
const PORT = process.env.PORT || 10000;

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

app.use(cors());

// ── 1. STRIPE WEBHOOK LAYER (Must be parsed as raw raw bytes) ─────
app.post('/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error(`❌ Webhook signature verification failed: ${err.message}`);
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

// Standard JSON body parsing middleware for all normal application endpoints below
app.use(express.json());

// ── 2. FORTIFIED AUTH & SUBSCRIPTION GATE MIDDLEWARE ──────────────
async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid token' });
  }

  const token = authHeader.split(' ')[1];

  try {
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) {
      return res.status(401).json({ error: 'Invalid token' });
    }

    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('*, dealerships(*)')
      .eq('id', user.id)
      .single();

    if (profileError || !profile) {
      return res.status(401).json({ error: 'Profile not found' });
    }

    // ── SUBSCRIPTION REINFORCEMENT GATEWAY ──
    const billingStatus = profile.dealerships?.billing_status;
    if (billingStatus === 'INACTIVE' || billingStatus === 'PAST_DUE') {
      return res.status(402).json({ error: 'SUBSCRIPTION_REQUIRED' });
    }

    req.user = user;
    req.profile = profile;
    req.dealershipId = profile.dealership_id;
    next();
  } catch (err) {
    return res.status(500).json({ error: 'Internal auth error' });
  }
}

// ── 3. CORE SECURE DATA ROUTE SYSTEM ─────────────────────────────

// Auth context route
app.get('/auth/me', requireAuth, (req, res) => {
  res.json(req.profile);
});

// Fetch complete fleet inventory
app.get('/inventory', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('inventory')
      .select('*')
      .eq('dealership_id', req.dealershipId)
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Single asset target lookup
app.get('/inventory/:id', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('inventory')
      .select('*')
      .eq('id', req.params.id)
      .eq('dealership_id', req.dealershipId)
      .single();

    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Vehicle not found' });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /listings
app.get('/listings', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('listings')
      .select('id, dealership_id, inventory_id, fb_listing_id, fb_listing_url') // Clean, unjoined selection
      .eq('dealership_id', req.dealershipId);

    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /listings
app.post('/listings', requireAuth, async (req, res) => {
  const { inventory_id, fb_listing_id, fb_listing_url } = req.body;

  if (!inventory_id) {
    return res.status(400).json({ error: 'Missing inventory_id' });
  }

  try {
    const { data, error } = await supabase
      .from('listings')
      .insert([
        {
          dealership_id: req.dealershipId, // Ensure this matches your database column name exactly
          inventory_id,
          fb_listing_id,
          fb_listing_url,
          posted_by: req.user.id
        }
      ])
      .select();

    if (error) throw error;
    res.status(201).json(data[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── 4. SUBSCRIPTION BILLING MANAGMENT LINKS ──────────────────────

// Open checkout link
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

// Customer billing self-serve portal
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

// ── 5. BROWSER DOWNLOAD PHOTO PROXY LAYER (Unprotected public route) ──
app.get('/proxy-image', async (req, res) => {
  const imageUrl = req.query.url;
  if (!imageUrl) return res.status(400).send('Missing url parameter');

  try {
    const response = await fetch(imageUrl);
    if (!response.ok) throw new Error('Failed to fetch image');

    const contentType = response.headers.get('content-type');
    if (contentType) res.setHeader('Content-Type', contentType);

    const arrayBuffer = await response.arrayBuffer();
    res.send(Buffer.from(arrayBuffer));
  } catch (err) {
    res.status(500).send('Error proxying image');
  }
});

// ── 6. INSTANCE RUNTIME INITIALIZATION ────────────────────────────
app.listen(PORT, () => console.log(`🚀 Production ecosystem server live on port ${PORT}`));