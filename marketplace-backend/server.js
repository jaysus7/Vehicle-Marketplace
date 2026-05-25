import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import ws from 'ws'
import Stripe from 'stripe'
import { createClient } from '@supabase/supabase-js'

const app = express()
const PORT = process.env.PORT || 10000
const sleep = ms => new Promise(r => setTimeout(r, ms))

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY)
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { realtime: { transport: ws } }
)

app.use(cors({ origin: '*' }))

// ── 1. STRIPE WEBHOOK (Must be evaluated before express.json() parser parsing) ──
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
      await supabase.from('dealerships').update({
        stripe_customer_id: session.customer,
        subscription_id: session.subscription,
        stripe_price_id: sub.items.data[0].price.id,
        billing_status: 'ACTIVE'
      }).eq('id', session.client_reference_id)
      break;
    }
    case 'customer.subscription.deleted': {
      await supabase.from('dealerships')
        .update({ billing_status: 'INACTIVE' })
        .eq('subscription_id', event.data.object.id)
      break;
    }
    case 'invoice.payment_failed': {
      const invoice = event.data.object
      if (invoice.subscription) {
        await supabase.from('dealerships')
          .update({ billing_status: 'PAST_DUE' })
          .eq('stripe_customer_id', invoice.customer)
      }
      break;
    }
  }
  res.json({ received: true })
})

app.use(express.json())
app.use(express.urlencoded({ extended: true }))

// ── 2. FORTIFIED AUTHENTICATION MIDDLEWARE ──
async function requireAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '')
  if (!token) return res.status(401).json({ error: 'No token provided' })

  try {
    const { data: { user }, error } = await supabase.auth.getUser(token)
    if (error || !user) return res.status(401).json({ error: 'Invalid token' })

    const { data: profile } = await supabase
      .from('profiles')
      .select('*, dealerships(*)')
      .eq('id', user.id)
      .single()

    if (!profile) return res.status(401).json({ error: 'Profile not found' })

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

// ── 3. SUBSCRIPTION PIPELINE & AUTH ROUTES ──
app.post('/auth/login', async (req, res) => {
  const { email, password } = req.body
  const { data, error } = await supabase.auth.signInWithPassword({ email, password })
  if (error) return res.status(401).json({ error: error.message })
  res.json({
    access_token: data.session.access_token,
    user: { id: data.user.id, email: data.user.email }
  })
})

app.post('/auth/register', async (req, res) => {
  const { email, password, fullName, dealershipName, websiteUrl, feedUrl } = req.body

  try {
    const { data: authData, error: authError } = await supabase.auth.signUp({ email, password })
    if (authError) return res.status(400).json({ error: authError.message })

    const { data: dealer, error: dErr } = await supabase
      .from('dealerships')
      .insert({ 
        name: dealershipName, 
        website_url: websiteUrl || null, 
        feed_url: feedUrl || null, 
        billing_status: 'TRIAL' 
      })
      .select().single()
      
    if (dErr) return res.status(500).json({ error: dErr.message })

    await supabase.from('profiles').upsert({
      id: authData.user.id,
      full_name: fullName,
      dealership_id: dealer.id,
      role: 'DEALER_ADMIN'
    })

    res.status(201).json({ message: 'Registration successful', dealer })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
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

app.post('/auth/logout', requireAuth, async (req, res) => {
  await supabase.auth.signOut()
  res.json({ success: true })
})

app.put('/profile/update', requireAuth, async (req, res) => {
  const { websiteUrl, fullName } = req.body
  if (websiteUrl) await supabase.from('dealerships').update({ website_url: websiteUrl }).eq('id', req.dealershipId)
  if (fullName) await supabase.from('profiles').update({ full_name: fullName }).eq('id', req.user.id)
  res.json({ message: 'Updated' })
})

// ── 4. TEAM MANAGEMENT SYSTEM ──
app.post('/admin/users/invite', requireAuth, async (req, res) => {
  if (req.profile.role !== 'DEALER_ADMIN') return res.status(403).json({ error: 'Admins only' })
  const { email, full_name, role = 'user' } = req.body
  const { data: newUser, error: authError } = await supabase.auth.admin.createUser({
    email,
    password: Math.random().toString(36).slice(-10),
    email_confirm: true
  })
  if (authError) return res.status(500).json({ error: authError.message })
  await supabase.from('profiles').upsert({
    id: newUser.user.id,
    dealership_id: req.dealershipId,
    full_name,
    role
  })
  res.json({ success: true, user_id: newUser.user.id })
})

// ── 5. CORE INVENTORY SECURE LOOKUPS ──
app.get('/inventory', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('inventory')
    .select('*')
    .eq('dealership_id', req.dealershipId)
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
    .eq('dealership_id', req.dealershipId)
    .single()
  if (error) return res.status(404).json({ error: 'Not found' })
  res.json(data)
})

// ── 6. MARKETING ASSET SYNC LOGIC ──
app.post('/listings', requireAuth, async (req, res) => {
  const { inventory_id, fb_listing_id, fb_listing_url } = req.body
  const { data, error } = await supabase
    .from('listings')
    .insert({ inventory_id, posted_by: req.user.id, fb_listing_id, fb_listing_url, status: 'posted', posted_at: new Date().toISOString() })
    .select().single()
  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})

app.get('/listings', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('listings')
    .select('*, inventory!inner(*)')
    .eq('inventory.dealership_id', req.dealershipId)
    .eq('status', 'posted')
    .order('posted_at', { ascending: false })
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

// ── 7. MULTI-TIER SUBSCRIPTION BILLING MANAGEMENT ──
app.post('/billing/checkout', requireAuth, async (req, res) => {
  const { priceId } = req.body
  const validPrices = [process.env.STRIPE_DEALER_PRICE_ID, process.env.STRIPE_SOLO_PRICE_ID]
  if (!validPrices.includes(priceId)) return res.status(400).json({ error: 'Invalid price identifier selection' })

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      mode: 'subscription',
      client_reference_id: req.dealershipId,
      success_url: `${process.env.FRONTEND_URL}/dashboard`,
      cancel_url: `${process.env.FRONTEND_URL}/upgrade`,
    })
    res.json({ url: session.url })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.get('/dealership/team-insights', requireAuth, async (req, res) => {
  if (req.profile.role !== 'DEALER_ADMIN') return res.status(403).json({ error: 'Admins only' })
  const { data } = await supabase
    .from('profiles')
    .select('full_name, id')
    .eq('dealership_id', req.dealershipId)
  res.json(data)
})

// ── 8. BROWSER DOWNLOAD PHOTO PROXY LAYER ──
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

// ── 9. SYSTEM ENGINE: CRON-READY VEHICLE DATA SYNC ──
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
    console.warn('Photo fetch failed for stock#', stocknumber, e.message)
    return []
  }
}

app.get('/sync', async (req, res) => {
  const secret = req.query.secret
  if (secret !== process.env.SYNC_SECRET && process.env.SYNC_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  
  const targetDealershipId = req.query.dealership_id
  if (!targetDealershipId) return res.status(400).json({ error: 'Missing target dealership parameter' })

  try {
    const { data: currentDealer } = await supabase.from('dealerships').select('feed_url').eq('id', targetDealershipId).single()
    const activeFeedUrl = currentDealer?.feed_url
    if (!activeFeedUrl) return res.status(404).json({ error: 'No inventory feed url configured for this business identity.' })

    console.log(`🔄 Starting inventory sync for instance ID: ${targetDealershipId}`)
    const feedRes = await fetch(`${activeFeedUrl}?v=${Date.now()}`)
    const data = await feedRes.json()
    const vehicles = data.vehicles || []
    console.log(`📦 Found ${vehicles.length} vehicles in target feed`)

    let inserted = 0, skipped = 0

    for (const v of vehicles) {
      if (!v.onweb || v.nonvehicle) { skipped++; continue }
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
        source_url: `${activeFeedUrl.split('/wp-content')[0]}/inventory/${v.stocknumber}`,
        status: v.salepending ? 'pending' : 'available',
        last_synced_at: new Date().toISOString()
      }
      const { error } = await supabase.from('inventory').upsert(record, { onConflict: 'vin' }).select('id')
      if (error) { console.error('Upsert error for VIN', v.vin, error.message); skipped++ }
      else inserted++
    }

    const feedVins = vehicles.map(v => v.vin).filter(Boolean)
    if (feedVins.length > 0) {
      await supabase.from('inventory').update({ status: 'sold' })
        .eq('dealership_id', targetDealershipId)
        .eq('status', 'available')
        .not('vin', 'in', `(${feedVins.map(v => `"${v}"`).join(',')})`)
    }

    res.json({ success: true, total_in_feed: vehicles.length, processed: inserted, skipped, synced_at: new Date().toISOString() })
  } catch (e) {
    console.error('Sync execution crashed:', e.message)
    res.status(500).json({ error: e.message })
  }
})

// ── 10. DIAGNOSTIC RUNTIME ENVIRONMENT LAYER ──
app.get('/debug', requireAuth, async (req, res) => {
  res.json({ user_id: req.user.id, profile: req.profile, dealership_id: req.dealershipId })
})

app.listen(PORT, () => console.log(`🚀 Automated marketplace sync ecosystem operational on port ${PORT}`))