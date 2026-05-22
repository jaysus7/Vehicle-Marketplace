import express from 'express'
import cors from 'cors'
import ws from 'ws'
import { createClient } from '@supabase/supabase-js'
import 'dotenv/config'

const app = express()
const sleep = ms => new Promise(r => setTimeout(r, ms))

app.use(express.json())
app.use(express.urlencoded({ extended: true }))
app.use(cors({ origin: '*' }))

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { realtime: { transport: ws } }
)

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

      await sleep(200) // be respectful to their API

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

    // Mark vehicles no longer in feed as sold
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

app.listen(3000, () => console.log('API running on port 3000'))