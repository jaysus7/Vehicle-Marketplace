import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import ws from 'ws'
import Stripe from 'stripe'
import { createClient } from '@supabase/supabase-js'

const missingEnvVars = [];
if (!process.env.SUPABASE_URL) missingEnvVars.push('SUPABASE_URL');
if (!process.env.SUPABASE_ANON_KEY) missingEnvVars.push('SUPABASE_ANON_KEY');
if (!process.env.SUPABASE_SERVICE_ROLE_KEY) missingEnvVars.push('SUPABASE_SERVICE_ROLE_KEY');

if (missingEnvVars.length > 0) {
  console.error('❌ CRITICAL CONFIGURATION ERROR: Missing Render Environment Keys:');
  console.error(JSON.stringify(missingEnvVars, null, 2));
  process.exit(1);
}

const app = express()
const PORT = process.env.PORT || 10000
const sleep = ms => new Promise(r => setTimeout(r, ms))
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY)

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, { realtime: { transport: ws } })
const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { realtime: { transport: ws } })

app.use(cors({ origin: '*' }))

// ── 1. STRIPE WEBHOOK (SECURE SUBSCRIPTION PARSING) ──
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
      await supabaseAdmin.from('dealerships').update({
        stripe_customer_id: session.customer,
        subscription_id: session.subscription,
        stripe_price_id: sub.items.data[0].price.id,
        billing_status: 'ACTIVE'
      }).eq('id', session.client_reference_id)
      break;
    }
    case 'customer.subscription.deleted': {
      await supabaseAdmin.from('dealerships').update({ billing_status: 'INACTIVE' }).eq('subscription_id', event.data.object.id)
      break;
    }
    case 'invoice.payment_failed': {
      const invoice = event.data.object
      if (invoice.subscription) {
        await supabaseAdmin.from('dealerships').update({ billing_status: 'PAST_DUE' }).eq('stripe_customer_id', invoice.customer)
      }
      break;
    }
  }
  res.json({ received: true })
})

app.use(express.json())
app.use(express.urlencoded({ extended: true }))

// ── 2. SECURE AUTHENTICATION MIDDLEWARE ──
async function requireAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '')
  if (!token) return res.status(401).json({ error: 'No token provided' })

  try {
    // Natively verify token against Supabase Auth Engine
    const { data: { user }, error } = await supabase.auth.getUser(token)
    if (error || !user) return res.status(401).json({ error: 'AUTH_EXPIRED — please sign in again' })

    const { data: profile } = await supabaseAdmin
      .from('profiles')
      .select('*, dealerships(*)')
      .eq('id', user.id)
      .single()

    if (!profile) return res.status(401).json({ error: 'Profile not found' })

    // Strict Billing Gate Enforcement
    const status = profile.dealerships?.billing_status
    if (status === 'INACTIVE' || status === 'PAST_DUE') {
      return res.status(402).json({ error: 'SUBSCRIPTION_REQUIRED' })
    }

    req.user = user
    req.profile = profile
    req.dealershipId = profile.dealership_id
    next()
  } catch (err) {
    return res.status(500).json({ error: 'Internal server authorization error' })
  }
}

// ── 3. AUTHENTICATION ENDPOINTS ──
app.post('/auth/login', async (req, res) => {
  const { email, password } = req.body
  const { data, error } = await supabase.auth.signInWithPassword({ email, password })
  if (error) return res.status(401).json({ error: error.message })
  res.json({
    access_token: data.session.access_token,
    user: { id: data.user.id, email: data.user.email }
  })
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

// ── 4. PROFILE & METADATA MANAGEMENT (EMAIL/PASSWORD/DEALERSHIP) ──
app.put('/profile/update', requireAuth, async (req, res) => {
  const { fullName, email, password, dealershipName, websiteUrl } = req.body

  try {
    const authUpdates = {}
    if (email) authUpdates.email = email
    if (password) authUpdates.password = password

    // Securely update primary credentials via the admin auth utility
    if (Object.keys(authUpdates).length > 0) {
      const { error: authError } = await supabaseAdmin.auth.admin.updateUserById(req.user.id, authUpdates)
      if (authError) throw authError
    }

    if (fullName) {
      const { error: profileError } = await supabaseAdmin.from('profiles').update({ full_name: fullName }).eq('id', req.user.id)
      if (profileError) throw profileError
    }

    if (req.dealershipId && (dealershipName || websiteUrl)) {
      const dealerUpdates = {}
      if (dealershipName) dealerUpdates.name = dealershipName
      if (websiteUrl) dealerUpdates.website_url = websiteUrl

      const { error: dealerError } = await supabaseAdmin.from('dealerships').update(dealerUpdates).eq('id', req.dealershipId)
      if (dealerError) throw dealerError
    }

    res.json({ message: 'Workspace identity updated successfully' })
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

// ── 5. TEAM MANAGEMENT SYSTEM ──
app.post('/admin/users/invite', requireAuth, async (req, res) => {
  if (req.profile.role !== 'DEALER_ADMIN') return res.status(403).json({ error: 'Admins only' })
  const { email, full_name, role = 'SALES_REP' } = req.body
  const { data: newUser, error: authError } = await supabase.auth.admin.createUser({
    email,
    password: Math.random().toString(36).slice(-10),
    email_confirm: true
  })
  if (authError) return res.status(500).json({ error: authError.message })
  await supabaseAdmin.from('profiles').upsert({ id: newUser.user.id, dealership_id: req.dealershipId, full_name, role })
  res.json({ success: true, user_id: newUser.user.id })
})

// ── 6. CORE INVENTORY SECURE LOOKUPS ──
app.get('/inventory', requireAuth, async (req, res) => {
  const { data, error } = await supabaseAdmin.from('inventory').select('*').eq('dealership_id', req.dealershipId).eq('status', 'available').order('created_at', { ascending: false })
  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})

app.get('/inventory/:id', requireAuth, async (req, res) => {
  const { data, error } = await supabaseAdmin.from('inventory').select('*').eq('id', req.params.id).eq('dealership_id', req.dealershipId).single()
  if (error) return res.status(404).json({ error: 'Not found' })
  res.json(data)
})

// ── 7. MARKETING ASSET SYNC LOGIC ──
app.post('/listings', requireAuth, async (req, res) => {
  const { inventory_id, fb_listing_id, fb_listing_url } = req.body
  const { data, error } = await supabaseAdmin.from('listings').insert({ inventory_id, posted_by: req.user.id, fb_listing_id, fb_listing_url, status: 'posted', posted_at: new Date().toISOString() }).select().single()
  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})

app.get('/listings', requireAuth, async (req, res) => {
  const { data, error } = await supabaseAdmin.from('listings').select('*, inventory!inner(*)').eq('inventory.dealership_id', req.dealershipId).eq('status', 'posted').order('posted_at', { ascending: false })
  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})

app.patch('/listings/:id/delete', requireAuth, async (req, res) => {
  const { error } = await supabaseAdmin.from('listings').update({ status: 'deleted', deleted_at: new Date().toISOString() }).eq('id', req.params.id)
  if (error) return res.status(500).json({ error: error.message })
  res.json({ success: true })
})

// ── 8. UNIFIED BILLING ENGINE ──
app.post('/billing/checkout', requireAuth, async (req, res) => {
  const priceId = req.body.priceId || process.env.STRIPE_DEALER_PRICE_ID
  try {
    if (req.profile.dealerships?.stripe_customer_id) {
      try {
        const portalSession = await stripe.billingPortal.sessions.create({ customer: req.profile.dealerships.stripe_customer_id, return_url: `${process.env.FRONTEND_URL}/dashboard` })
        return res.json({ url: portalSession.url })
      } catch (portalErr) {
        console.warn('Portal initialization bypassed:', portalErr.message)
      }
    }
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      mode: 'subscription',
      client_reference_id: req.dealershipId,
      success_url: `${process.env.FRONTEND_URL}/dashboard`,
      cancel_url: `${process.env.FRONTEND_URL}/dashboard`
    })
    res.json({ url: session.url })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.post('/billing/portal', requireAuth, async (req, res) => {
  res.redirect(307, '/billing/checkout')
})

// ── 9. BROWSER DOWNLOAD PHOTO PROXY LAYER ──
app.get('/proxy-image', async (req, res) => {
  const { url } = req.query
  if (!url) return res.status(400).json({ error: 'No URL provided' })
  try {
    const response = await fetch(url)
    const buffer = await response.arrayBuffer()
    const contentType = response.headers.get('content-type') || 'image/jpeg'
    res.set({ 'Content-Type': contentType, 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=3600' })
    res.send(Buffer.from(buffer))
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch image' })
  }
})

// ── 10. SYSTEM ENGINE: VEHICLE DATA SYNC ──
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
    'Contact Dealership for tracking availability.'
  ].filter(Boolean).join('. ')
}

async function fetchVehiclePhotos(stocknumber) {
  try {
    const res = await fetch(`https://yippi.uxauto.agency/inventory-by-stock/${stocknumber}`)
    const data = await res.json()
    if (data.result !== 'Success' || !data.records?.length) return []
    return (data.records[0].images || []).map(img => img.url).filter(Boolean)
  } catch (e) {
    return []
  }
}

app.get('/sync', async (req, res) => {
  const secret = req.query.secret
  if (secret !== process.env.SYNC_SECRET && process.env.SYNC_SECRET) return res.status(401).json({ error: 'Unauthorized' })
  
  const targetDealershipId = req.query.dealership_id
  if (!targetDealershipId) return res.status(400).json({ error: 'Missing target dealership parameter' })

  try {
    const { data: currentDealer } = await supabaseAdmin.from('dealerships').select('id').eq('id', targetDealershipId).single()
    if (!currentDealer) return res.status(404).json({ error: 'Target business identity not found.' })

    const { data: feeds } = await supabaseAdmin.from('inventory_feeds').select('feed_url').eq('dealership_id', targetDealershipId)
    if (!feeds || feeds.length === 0) return res.status(404).json({ error: 'No inventory data feeds found for this account.' })

    let totalInserted = 0, totalSkipped = 0, totalVehiclesFound = 0
    const feedVins = []

    for (const feed of feeds) {
      try {
        const feedRes = await fetch(`${feed.feed_url}?v=${Date.now()}`)
        const data = await feedRes.json()
        const vehicles = data.vehicles || []
        totalVehiclesFound += vehicles.length

        for (const v of vehicles) {
          if (!v.onweb || v.nonvehicle) { totalSkipped++; continue }
          if (v.vin) feedVins.push(v.vin)
          
          await sleep(200)
          const imageUrls = await fetchVehiclePhotos(v.stocknumber)
          const record = {
            dealership_id: targetDealershipId,
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
            source_url: `${feed.feed_url.split('/wp-content')[0]}/inventory/${v.stocknumber}`,
            status: v.salepending ? 'pending' : 'available',
            last_synced_at: new Date().toISOString()
          }
          const { error } = await supabaseAdmin.from('inventory').upsert(record, { onConflict: 'vin' })
          if (error) totalSkipped++
          else totalInserted++
        }
      } catch (feedErr) {
        console.error(feedErr.message)
      }
    }

    if (feedVins.length > 0) {
      await supabaseAdmin.from('inventory').update({ status: 'sold' }).eq('dealership_id', targetDealershipId).eq('status', 'available').not('vin', 'in', `(${feedVins.map(v => `"${v}"`).join(',')})`)
    }

    res.json({ success: true, total_in_feeds: totalVehiclesFound, processed: totalInserted, skipped: totalSkipped, synced_at: new Date().toISOString() })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ── 11. DIAGNOSTIC LAYER ──
app.get('/debug', requireAuth, async (req, res) => {
  res.json({ user_id: req.user.id, profile: req.profile, dealership_id: req.dealershipId })
})

app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Secure Marketplace engine live on port ${PORT}`))