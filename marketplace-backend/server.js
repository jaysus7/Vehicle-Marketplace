import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import ws from 'ws'
import Stripe from 'stripe'
import { createClient } from '@supabase/supabase-js'

// DIAGNOSTIC ASSERTION LAYER: Explicitly catch missing Render variables before boot
const missingEnvVars = [];
if (!process.env.SUPABASE_URL) missingEnvVars.push('SUPABASE_URL');
if (!process.env.SUPABASE_ANON_KEY) missingEnvVars.push('SUPABASE_ANON_KEY');
if (!process.env.SUPABASE_SERVICE_ROLE_KEY) missingEnvVars.push('SUPABASE_SERVICE_ROLE_KEY');

if (missingEnvVars.length > 0) {
  console.error('❌ CRITICAL CONFIGURATION ERROR: The following environment variables are missing from Render:');
  console.error(JSON.stringify(missingEnvVars, null, 2));
  process.exit(1); // Force a clean operational exit with a descriptive log trail
}

const app = express()
const PORT = process.env.PORT || 10000
const sleep = ms => new Promise(r => setTimeout(r, ms))

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY)

// Standard Public Client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY,
  { realtime: { transport: ws } }
)

// Method A: Elevated Admin Client
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { realtime: { transport: ws } }
)

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
      await supabaseAdmin.from('dealerships').update({
        stripe_customer_id: session.customer,
        subscription_id: session.subscription,
        stripe_price_id: sub.items.data[0].price.id,
        billing_status: 'ACTIVE'
      }).eq('id', session.client_reference_id)
      break;
    }
    case 'customer.subscription.deleted': {
      await supabaseAdmin.from('dealerships')
        .update({ billing_status: 'INACTIVE' })
        .eq('subscription_id', event.data.object.id)
      break;
    }
    case 'invoice.payment_failed': {
      const invoice = event.data.object
      if (invoice.subscription) {
        await supabaseAdmin.from('dealerships')
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

    const { data: profile } = await supabaseAdmin
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
  // Normalize fields coming from either the old or new frontend iterations
  const { 
    accountRole, 
    role,
    fullName, 
    email, 
    password, 
    dealershipName, 
    websiteUrl, 
    website_url,
    feedUrl,
    feeds 
  } = req.body

  try {
    // 1. Resolve variations in role names (UI strings vs raw system enums)
    const rawRole = (accountRole || role || '').toLowerCase()
    const isDealerAdmin = rawRole.includes('admin') || rawRole === 'dealer_admin'
    const targetRole = isDealerAdmin ? 'DEALER_ADMIN' : 'SALES_REP'

    // 2. Safely reconstruct a uniform feed collection array
    let normalizedFeeds = []
    if (Array.isArray(feeds) && feeds.length > 0) {
      normalizedFeeds = feeds
    } else if (feedUrl || req.body.feed_url) {
      normalizedFeeds = [{ url: feedUrl || req.body.feed_url, type: 'All Inventory' }]
    }

    const targetWebsite = websiteUrl || website_url || null
    const legacyFeedUrl = normalizedFeeds.length > 0 ? normalizedFeeds[0].url : null

    // 3. Kick off Supabase Auth Provisioning
    const { data: authData, error: authError } = await supabase.auth.signUp({ email, password })
    if (authError) return res.status(400).json({ error: authError.message })
    const userId = authData.user?.id

    let assignedDealershipId = null

    // 4. Handle Dealership generation safely
    if (isDealerAdmin) {
      const { data: dealer, error: dErr } = await supabaseAdmin
        .from('dealerships')
        .insert({ 
          name: dealershipName || 'New Dealership Workspace', 
          website_url: targetWebsite, 
          feed_url: legacyFeedUrl,
          billing_status: 'TRIAL' 
        })
        .select().single()
        
      if (dErr) return res.status(500).json({ error: dErr.message })
      assignedDealershipId = dealer.id
    }

    // 5. Safely handle relational multiple feed tables if they exist
    if (normalizedFeeds.length > 0) {
      const feedRows = normalizedFeeds.map(f => ({
        dealership_id: assignedDealershipId,
        user_id: userId,
        feed_url: f.url,
        feed_type: f.type || 'All Inventory'
      }))

      // Use a silent catch here to prevent profile registration from breaking if table is missing
      await supabaseAdmin.from('inventory_feeds').insert(feedRows).catch(err => {
        console.warn('Optional inventory_feeds table insertion bypassed:', err.message)
      })
    }

    // 6. Complete profile map execution matching your active database schema
    const { error: profileError } = await supabaseAdmin.from('profiles').upsert({
      id: userId,
      full_name: fullName || 'Team Member',
      dealership_id: assignedDealershipId,
      role: targetRole
    })

    if (profileError) return res.status(500).json({ error: profileError.message })

    res.status(201).json({ message: 'Registration successful', dealership_id: assignedDealershipId })
  } catch (err) {
    console.error('Registration Catch Triggered:', err.message)
    res.status(500).json({ error: err.message })
  }
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
  const { data } = await supabaseAdmin
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
    const { data: currentDealer } = await supabaseAdmin.from('dealerships').select('id').eq('id', targetDealershipId).single()
    if (!currentDealer) return res.status(404).json({ error: 'Target business identity not found.' })

    const { data: feeds } = await supabaseAdmin.from('inventory_feeds').select('feed_url').eq('dealership_id', targetDealershipId)
    if (!feeds || feeds.length === 0) return res.status(404).json({ error: 'No inventory data feeds found for this account.' })

    let totalInserted = 0, totalSkipped = 0, totalVehiclesFound = 0
    const feedVins = []

    console.log(`🔄 Starting inventory batch feed sync for instance ID: ${targetDealershipId}`)

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
          if (error) { console.error('Upsert error for VIN', v.vin, error.message); totalSkipped++ }
          else totalInserted++
        }
      } catch (feedErr) {
        console.error(`Error processing feed ${feed.feed_url}:`, feedErr.message)
      }
    }

    if (feedVins.length > 0) {
      await supabaseAdmin.from('inventory').update({ status: 'sold' })
        .eq('dealership_id', targetDealershipId)
        .eq('status', 'available')
        .not('vin', 'in', `(${feedVins.map(v => `"${v}"`).join(',')})`)
    }

    res.json({ success: true, total_in_feeds: totalVehiclesFound, processed: totalInserted, skipped: totalSkipped, synced_at: new Date().toISOString() })
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