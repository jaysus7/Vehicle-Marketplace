import express from 'express'
import cors from 'cors'
import ws from 'ws'
import { createClient } from '@supabase/supabase-js'
import Stripe from 'stripe'
import 'dotenv/config'

// Initialize single Express server instance
const app = express()
const sleep = ms => new Promise(r => setTimeout(r, ms))

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY)

// Initialize Supabase Client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { realtime: { transport: ws } }
)

// Enable Cross-Origin Resource Sharing globally
app.use(cors({ origin: '*' }))

/**
 * ── 1. STRIPE WEBHOOK ROUTE ───────────────────────────────────────────
 * This MUST consume the raw buffer stream before global parsers intercept it.
 */
app.post('/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature']
  let event

  try {
    event = stripe.webhooks.constructEvent(
      req.body, 
      sig, 
      process.env.STRIPE_WEBHOOK_SECRET
    )
  } catch (err) {
    console.error(`❌ Stripe Webhook Signature Verification Failed: ${err.message}`)
    return res.status(400).send(`Webhook Verification Error: ${err.message}`)
  }

  const session = event.data.object

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const dealershipId = session.client_reference_id
        const stripeCustomerId = session.customer
        const subscriptionId = session.subscription

        const subscription = await stripe.subscriptions.retrieve(subscriptionId)
        const stripePriceId = subscription.items.data[0].price.id

        // Map subscription back to Supabase dealerships metadata table
        const { error } = await supabase
          .from('dealerships')
          .update({
            stripe_customer_id: stripeCustomerId,
            subscription_id: subscriptionId,
            stripe_price_id: stripePriceId,
            billing_status: 'ACTIVE'
          })
          .eq('id', dealershipId)

        if (error) throw error
        console.log(`✅ Dealership ${dealershipId} successfully set to ACTIVE.`)
        break
      }
        
      case 'customer.subscription.updated': {
        const statusMap = {
          active: 'ACTIVE',
          trialing: 'TRIALING',
          past_due: 'PAST_DUE',
          unpaid: 'INACTIVE',
          canceled: 'CANCELED'
        }

        const { error } = await supabase
          .from('dealerships')
          .update({
            billing_status: statusMap[session.status] || 'INACTIVE',
            stripe_price_id: session.items.data[0].price.id
          })
          .eq('subscription_id', session.id)

        if (error) throw error
        console.log(`🔄 Subscription ${session.id} status synchronized to database.`)
        break
      }
        
      case 'customer.subscription.deleted': {
        const { error } = await supabase
          .from('dealerships')
          .update({ billing_status: 'CANCELED' })
          .eq('subscription_id', session.id)

        if (error) throw error
        console.log(`🛑 Subscription ${session.id} canceled. Access revoked.`)
        break
      }
    }
  } catch (dbError) {
    console.error(`❌ Database Synchronization Failure during Webhook processing:`, dbError.message)
    return res.status(500).json({ error: 'Database update failed' })
  }

  res.json({ received: true })
})

// ── 2. GLOBAL ROUTE BODY PARSERS ─────────────────────────────────────
// Invoked only for endpoints declared downstream of this marker position
app.use(express.json())
app.use(express.urlencoded({ extended: true }))

// ============================================
// AUTH MIDDLEWARE
// ============================================
async function requireAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '')
  if (!token) return res.status(401).json({ error: 'No token provided' })
  const { data: { user }, error } = await supabase.auth.getUser(token)
  if (error || !user) return res.status(401).json({ error: 'Invalid token', detail: error?.message })
  const { data: profile } = await supabase
    .from('profiles')
    .select('*, dealerships(*)')
    .eq('id', user.id)
    .single()
  
  if (!profile) return res.status(403).json({ error: 'Profile identity could not be verified' })
  
  // Multi-tenant Subscription Check Gate
  const billingStatus = profile.dealerships?.billing_status
  if (billingStatus !== 'ACTIVE' && billingStatus !== 'TRIALING') {
    return res.status(402).json({ error: 'Payment Required', detail: 'Dealership subscription is inactive.' })
  }

  req.user = user
  req.profile = profile
  next()
}

// ============================================
// AUTH ROUTES
// ============================================
app.post('/auth/login', async (req, res) => {
  const { email, password } = req.body
  const { data, error } = await supabase.auth.signInWithPassword({ email, password })
  if (error) return res.status(401).json({ error: error.message })
  res.json({ access_token: data.session.access_token, user: { id: data.user.id, email: data.user.email } })
})

app.post('/auth/logout', requireAuth, async (req, res) => {
  await supabase.auth.signOut()
  res.json({ success: true })
})

app.get('/auth/me', requireAuth, async (req, res) => {
  res.json({
    id: req.user.id,
    email: req.user.email,
    full_name: req.profile.full_name,
    role: req.profile.role,
    dealership: req.profile.dealerships
  })
})

// ============================================
// DEBUG
// ============================================
app.get('/debug', requireAuth, async (req, res) => {
  res.json({
    user_id: req.user.id,
    profile: req.profile,
    dealership_id: req.profile?.dealership_id
  })
})

// ============================================
// INVENTORY ROUTES
// ============================================
app.get('/inventory', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('inventory')
    .select('*')
    .eq('dealership_id', req.profile.dealership_id)
    .eq('status', 'available')
    .order('created_at', { ascending: false })
  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})

app.get('/inventory/:id', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('inventory')
    .select('*')
    .eq('id', req.params.id)
    .eq('dealership_id', req.profile.dealership_id)
    .single()
  if (error) return res.status(404).json({ error: 'Not found' })
  res.json(data)
})

// ============================================
// LISTINGS ROUTES
// ============================================
app.post('/listings', requireAuth, async (req, res) => {
  const { inventory_id, fb_listing_id, fb_listing_url } = req.body
  const { data, error } = await supabase
    .from('listings')
    .insert({ inventory_id, posted_by: req.user.id, fb_listing_id, fb_listing_url, status: 'posted', posted_at: new Date().toISOString() })
    .select()
    .single()
  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})

app.patch('/listings/:id/delete', requireAuth, async (req, res) => {
  const { error } = await supabase
    .from('listings')
    .update({ status: 'deleted', deleted_at: new Date().toISOString() })
    .eq('id', req.params.id)
  if (error) return res.status(500).json({ error: error.message })
  res.json({ success: true })
})

app.get('/listings', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('listings')
    .select('*, inventory(*)')
    .eq('status', 'posted')
    .order('posted_at', { ascending: false })
  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})

// ============================================
// ADMIN
// ============================================
app.post('/admin/users/invite', requireAuth, async (req, res) => {
  if (req.profile.role !== 'admin') return res.status(403).json({ error: 'Admins only' })
  const { email, full_name, role = 'user' } = req.body
  const { data: newUser, error: authError } = await supabase.auth.admin.createUser({
    email,
    password: Math.random().toString(36).slice(-10),
    email_confirm: true
  })
  if (authError) return res.status(500).json({ error: authError.message })
  const { error: profileError } = await supabase
    .from('profiles')
    .update({ dealership_id: req.profile.dealership_id, full_name, role })
    .eq('id', newUser.user.id)
  if (profileError) return res.status(500).json({ error: profileError.message })
  res.json({ success: true, user_id: newUser.user.id })
})

// ============================================
// STRIPE CHECKOUT ROUTE
// ============================================
app.post('/billing/checkout', requireAuth, async (req, res) => {
  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
      mode: 'subscription',
      client_reference_id: req.profile.dealership_id,
      success_url: `${process.env.FRONTEND_URL}/dashboard?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.FRONTEND_URL}/billing`,
    })
    res.json({ url: session.url })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ============================================
// IMAGE PROXY
// ============================================
app.get('/proxy-image', async (req, res) => {
  const { url } = req.query
  if (!url) return res.status(400).json({ error: 'No URL provided' })
  try {
    const response = await fetch(url)
    const buffer = await response.arrayBuffer()
    const contentType = response.headers.get('content-type') || 'image/jpeg'
    res.set({
      'Content-Type': contentType,
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=3600'
    })
    res.send(Buffer.from(buffer))
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch image' })
  }
})

// ============================================
// INVENTORY SYNC
// ============================================
const FEED_URL = 'https://www.wellandchev.com/wp-content/uploads/data/inventory.json'
const DEALERSHIP_ID = '8ee9c3cf-5c2c-498b-b796-3b33360290d1'

function mapFuel(fuel) {
  if (!fuel) return 'Gasoline'
  const f = fuel.toLowerCase()
  if (f.includes('electric')) return 'Electric'
  if (f.includes('hybrid')) return 'Hybrid'
  if (f.includes('diesel')) return 'Diesel'
  return 'Gasoline'
}

function buildDescription(vehicle) {
  const features = vehicle.searchablesarray?.slice(0, 8).join(', ') || ''
  return [
    `${vehicle.year} ${vehicle.make} ${vehicle.model} ${vehicle.trim || ''}`.trim(),
    vehicle.mileage ? `${Number(vehicle.mileage).toLocaleString()} km` : null,
    vehicle.exteriorcolor ? `${vehicle.exteriorcolor} exterior` : null,
    vehicle.transmission ? `${vehicle.transmission} transmission` : null,
    vehicle.drivetrain || null,
    features ? `Features: ${features}` : null,
    `Stock #${vehicle.stocknumber}`,
    'Contact Welland Chev for more info! (905) 735-3690'
  ].filter(Boolean).join('. ')
}

async function fetchVehiclePhotos(stocknumber) {
  try {
    const res = await fetch(`https://yippi.uxauto.agency/inventory-by-stock/${stocknumber}`)
    const data = await res.json()
    if (data.result !== 'Success' || !data.records?.length) return []
    return (data.records[0].images || []).map(img => img.url).filter(Boolean)
  } catch (e) {
    console.warn('Photo fetch failed for stock#', stocknumber, e.message)
    return []
  }
}

app.get('/sync', async (req, res) => {
  const secret = req.query.secret
  if (secret !== process.env.SYNC_SECRET && process.env.SYNC_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  try {
    console.log('🔄 Starting inventory sync...')
    const feedRes = await fetch(`${FEED_URL}?v=${Date.now()}`)
    const data = await feedRes.json()
    const vehicles = data.vehicles || []
    console.log(`📦 Found ${vehicles.length} vehicles in feed`)

    let inserted = 0
    let skipped = 0

    for (const v of vehicles) {
      if (!v.onweb) { skipped++; continue }
      if (v.nonvehicle) { skipped++; continue }

      await sleep(200)

      const imageUrls = await fetchVehiclePhotos(v.stocknumber)

      const record = {
        dealership_id: DEALERSHIP_ID,
        vin: v.vin,
        year: parseInt(v.year),
        make: v.make,
        model: v.model,
        trim: v.trim || null,
        price: v.saleprice || v.price || 0,
        mileage: v.mileage || 0,
        exterior_color: v.exteriorcolor || null,
        interior_color: null,
        transmission: v.transmission || null,
        fuel_type: mapFuel(v.fueltype),
        description: buildDescription(v),
        image_urls: imageUrls,
        source_url: `https://www.wellandchev.com/inventory/${v.stocknumber}`,
        status: v.salepending ? 'pending' : 'available',
        last_synced_at: new Date().toISOString()
      }

      const { error } = await supabase
        .from('inventory')
        .upsert(record, { onConflict: 'vin' })
        .select('id')

      if (error) {
        console.error('Upsert error for VIN', v.vin, error.message)
        skipped++
      } else {
        inserted++
      }
    }

    const feedVins = vehicles.map(v => v.vin).filter(Boolean)
    if (feedVins.length > 0) {
      const { error: soldError } = await supabase
        .from('inventory')
        .update({ status: 'sold' })
        .eq('dealership_id', DEALERSHIP_ID)
        .eq('status', 'available')
        .not('vin', 'in', `(${feedVins.map(v => `"${v}"`).join(',')})`)
      if (soldError) console.error('Error marking sold:', soldError.message)
    }

    const result = {
      success: true,
      total_in_feed: vehicles.length,
      processed: inserted,
      skipped,
      synced_at: new Date().toISOString()
    }
    console.log('✅ Sync complete:', result)
    res.json(result)

  } catch (e) {
    console.error('Sync failed:', e.message)
    res.status(500).json({ error: e.message })
  }
})

// Unified entry listener
const PORT = process.env.PORT || 3000
app.listen(PORT, () => console.log(`🚀 Automated Unified API running on port ${PORT}`))