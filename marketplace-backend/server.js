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
      const meta = session.metadata || {}
      const billing = {
        stripe_customer_id: session.customer,
        subscription_id: session.subscription,
        stripe_price_id: sub.items.data[0].price.id,
        billing_status: 'ACTIVE'
      }
      if (meta.type === 'solo_rep' && meta.user_id) {
        await supabaseAdmin.from('profiles').update(billing).eq('id', meta.user_id)
      } else {
        // Default: dealership. Either via metadata.dealership_id or legacy client_reference_id
        await supabaseAdmin.from('dealerships').update(billing).eq('id', meta.dealership_id || session.client_reference_id)
      }
      break;
    }
    case 'customer.subscription.deleted': {
      const subId = event.data.object.id
      // Try profile first (solo rep), fall back to dealership
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

    const { data: profile, error: profileError } = await supabaseAdmin
      .from('profiles')
      .select('*, dealerships(*)')
      .eq('id', user.id)
      .single()

    if (profileError || !profile) return res.status(401).json({ error: 'Profile not found' })

    // Billing routes need auth but must bypass the subscription gate
    // (otherwise inactive users can't reach checkout to start a subscription)
    if (!req.path.startsWith('/billing')) {
      // Dealer admins + dealer reps are gated by the dealership's status.
      // Solo reps (no dealership) are gated by their own profile.billing_status.
      const status = profile.dealership_id
        ? profile.dealerships?.billing_status
        : profile.billing_status

      if (status === 'INACTIVE' || status === 'PAST_DUE') {
        return res.status(402).json({ error: 'SUBSCRIPTION_REQUIRED' })
      }
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
  // Record the login event (fire-and-forget; do not block the response if it fails)
  supabaseAdmin.from('logins').insert({ user_id: data.user.id }).then(({ error: logErr }) => {
    if (logErr) console.warn('Failed to log login event:', logErr.message)
  })
  res.json({
    access_token: data.session.access_token,
    user: { id: data.user.id, email: data.user.email }
  })
})

app.post('/auth/register', async (req, res) => {
  const { accountRole, fullName, email, password, dealershipName, websiteUrl, feeds } = req.body

  if (!email || !password || !fullName || !accountRole) {
    return res.status(400).json({ error: 'Missing required registration fields' })
  }
  if (accountRole === 'dealer_admin' && !dealershipName) {
    return res.status(400).json({ error: 'Dealership name required for admin accounts' })
  }

  let createdUserId = null
  let createdDealershipId = null

  try {
    const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
      email,
      password,
      email_confirm: true
    })
    if (authError) throw authError
    createdUserId = authData.user.id

    if (accountRole === 'dealer_admin') {
      const { data: dealership, error: dealerError } = await supabaseAdmin
        .from('dealerships')
        .insert({
          name: dealershipName,
          website_url: websiteUrl || null,
          billing_status: 'INACTIVE'
        })
        .select()
        .single()
      if (dealerError) throw dealerError
      createdDealershipId = dealership.id

      const { error: profileError } = await supabaseAdmin
        .from('profiles')
        .insert({
          id: createdUserId,
          dealership_id: createdDealershipId,
          full_name: fullName,
          role: 'DEALER_ADMIN',
          account_role: accountRole,
          price_tier: 'DEALER'
        })
      if (profileError) throw profileError

      if (Array.isArray(feeds) && feeds.length > 0) {
        const feedRows = feeds
          .filter(f => f && f.url)
          .map(f => ({
            dealership_id: createdDealershipId,
            user_id: createdUserId,
            feed_url: f.url,
            feed_type: f.type || 'all'
          }))
        if (feedRows.length > 0) {
          const { error: feedError } = await supabaseAdmin.from('inventory_feeds').insert(feedRows)
          if (feedError) throw feedError
        }
      }
    } else {
      const { error: profileError } = await supabaseAdmin
        .from('profiles')
        .insert({
          id: createdUserId,
          dealership_id: null,
          full_name: fullName,
          role: 'SALES_REP',
          account_role: accountRole,
          price_tier: 'SOLO_INDIVIDUAL'
        })
      if (profileError) throw profileError
    }

    res.json({ success: true, user_id: createdUserId })
  } catch (err) {
    if (createdDealershipId) {
      await supabaseAdmin.from('dealerships').delete().eq('id', createdDealershipId)
    }
    if (createdUserId) {
      await supabaseAdmin.auth.admin.deleteUser(createdUserId)
    }
    res.status(400).json({ error: err.message || 'Registration failed' })
  }
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
app.get('/dealership/team', requireAuth, async (req, res) => {
  if (req.profile.role !== 'DEALER_ADMIN' && req.profile.role !== 'OWNER') return res.status(403).json({ error: 'Admins only' })
  if (!req.dealershipId) return res.json([])

  const { data: members, error } = await supabaseAdmin
    .from('profiles')
    .select('id, full_name, role, account_role, created_at')
    .eq('dealership_id', req.dealershipId)
    .order('created_at', { ascending: true })
  if (error) return res.status(500).json({ error: error.message })

  // Stitch in auth emails, listing counts, and recent login activity
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
  const enriched = await Promise.all(members.map(async (m) => {
    const { data: authUser } = await supabaseAdmin.auth.admin.getUserById(m.id).catch(() => ({ data: null }))
    const { count: listingsCount } = await supabaseAdmin
      .from('listings').select('id', { count: 'exact', head: true })
      .eq('posted_by', m.id).eq('status', 'posted')
    const { count: loginsCount } = await supabaseAdmin
      .from('logins').select('id', { count: 'exact', head: true })
      .eq('user_id', m.id).gte('created_at', thirtyDaysAgo)
    return {
      id: m.id,
      full_name: m.full_name,
      role: m.role,
      account_role: m.account_role,
      email: authUser?.user?.email || null,
      listings_posted: listingsCount || 0,
      logins_30d: loginsCount || 0,
      created_at: m.created_at
    }
  }))

  res.json(enriched)
})

app.post('/admin/users/invite', requireAuth, async (req, res) => {
  if (req.profile.role !== 'DEALER_ADMIN' && req.profile.role !== 'OWNER') return res.status(403).json({ error: 'Admins only' })
  if (!req.dealershipId) return res.status(400).json({ error: 'No dealership associated with this admin account' })

  const { email, full_name, password } = req.body || {}
  if (!email || !full_name) return res.status(400).json({ error: 'email and full_name required' })

  const tempPassword = password || Math.random().toString(36).slice(-12)

  const { data: newUser, error: authError } = await supabaseAdmin.auth.admin.createUser({
    email,
    password: tempPassword,
    email_confirm: true
  })
  if (authError) return res.status(500).json({ error: authError.message })

  const { error: profileError } = await supabaseAdmin.from('profiles').insert({
    id: newUser.user.id,
    dealership_id: req.dealershipId,
    full_name,
    role: 'SALES_REP',
    account_role: 'sales_rep'
  })
  if (profileError) {
    await supabaseAdmin.auth.admin.deleteUser(newUser.user.id)
    return res.status(500).json({ error: profileError.message })
  }

  res.json({
    success: true,
    user_id: newUser.user.id,
    email,
    temp_password: tempPassword
  })
})

// Per-user listing stats (current user)
app.get('/me/stats', requireAuth, async (req, res) => {
  const stats = await buildUserStats(req.user.id)
  res.json(stats)
})

// Top-of-dashboard insights — scoped by role
app.get('/dashboard/insights', requireAuth, async (req, res) => {
  const isAdmin = req.profile.role === 'DEALER_ADMIN' || req.profile.role === 'OWNER'
  const now = new Date()
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString()
  // Start of this week (Monday 00:00 local UTC)
  const day = now.getUTCDay() || 7   // Sun=0 -> 7 so Monday=1
  const startOfWeek = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (day - 1))).toISOString()

  try {
    // Inventory synced — dealership-wide, any status (the actual "synced" count)
    let inventorySynced = 0
    if (req.dealershipId) {
      const { count } = await supabaseAdmin
        .from('inventory')
        .select('id', { count: 'exact', head: true })
        .eq('dealership_id', req.dealershipId)
      inventorySynced = count || 0
    }

    // Listings posted — admin sees dealership-wide, rep sees personal
    let listingsPosted = 0
    let soldThisMonth = 0
    if (isAdmin && req.dealershipId) {
      const { data: allListings } = await supabaseAdmin
        .from('listings')
        .select('id, status, deleted_at, inventory!inner(dealership_id)')
        .eq('inventory.dealership_id', req.dealershipId)
      listingsPosted = allListings?.length || 0
      soldThisMonth = (allListings || []).filter(l => l.status === 'sold' && l.deleted_at && l.deleted_at >= thirtyDaysAgo).length
    } else {
      const { count: total } = await supabaseAdmin
        .from('listings').select('id', { count: 'exact', head: true }).eq('posted_by', req.user.id)
      const { count: sold } = await supabaseAdmin
        .from('listings').select('id', { count: 'exact', head: true })
        .eq('posted_by', req.user.id).eq('status', 'sold').gte('deleted_at', thirtyDaysAgo)
      listingsPosted = total || 0
      soldThisMonth = sold || 0
    }

    // Personal activity — distinct days logged in this week
    const { data: weekLogins } = await supabaseAdmin
      .from('logins')
      .select('created_at')
      .eq('user_id', req.user.id)
      .gte('created_at', startOfWeek)
    const distinctDays = new Set((weekLogins || []).map(l => l.created_at.slice(0, 10)))

    res.json({
      inventory_synced: inventorySynced,
      listings_posted: listingsPosted,
      sold_this_month: soldThisMonth,
      active_days_this_week: distinctDays.size,
      scope: isAdmin ? 'dealership' : 'personal'
    })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// Admin drill-down — stats for a specific rep in this dealership
app.get('/dealership/team/:userId/stats', requireAuth, async (req, res) => {
  if (req.profile.role !== 'DEALER_ADMIN' && req.profile.role !== 'OWNER') return res.status(403).json({ error: 'Admins only' })

  // Verify target is in this dealership
  const { data: target } = await supabaseAdmin
    .from('profiles')
    .select('id, full_name, role, dealership_id, created_at')
    .eq('id', req.params.userId)
    .single()
  if (!target || target.dealership_id !== req.dealershipId) {
    return res.status(404).json({ error: 'User not found in your dealership' })
  }

  const { data: authUser } = await supabaseAdmin.auth.admin.getUserById(req.params.userId).catch(() => ({ data: null }))
  const stats = await buildUserStats(req.params.userId)
  res.json({
    profile: {
      id: target.id,
      full_name: target.full_name,
      email: authUser?.user?.email || null,
      role: target.role,
      joined_at: target.created_at
    },
    ...stats
  })
})

async function buildUserStats(userId) {
  // Counts
  const countOf = async (status) => {
    let q = supabaseAdmin.from('listings').select('id', { count: 'exact', head: true }).eq('posted_by', userId)
    if (status) q = q.eq('status', status)
    const { count } = await q
    return count || 0
  }
  const [total, active, sold, deleted] = await Promise.all([
    countOf(null),
    countOf('posted'),
    countOf('sold'),
    countOf('deleted')
  ])

  // Most recent listings (up to 10)
  const { data: recent } = await supabaseAdmin
    .from('listings')
    .select('id, status, posted_at, fb_listing_url, inventory!inner(id, year, make, model, trim, price, image_urls)')
    .eq('posted_by', userId)
    .order('posted_at', { ascending: false })
    .limit(10)

  return {
    totals: { total, active, sold, deleted },
    recent: (recent || []).map(l => ({
      listing_id: l.id,
      status: l.status,
      posted_at: l.posted_at,
      fb_listing_url: l.fb_listing_url,
      vehicle: l.inventory
    }))
  }
}

app.delete('/admin/users/:id', requireAuth, async (req, res) => {
  if (req.profile.role !== 'DEALER_ADMIN' && req.profile.role !== 'OWNER') return res.status(403).json({ error: 'Admins only' })
  if (req.params.id === req.user.id) return res.status(400).json({ error: 'Cannot remove yourself' })

  // Verify the target belongs to the same dealership
  const { data: target } = await supabaseAdmin
    .from('profiles')
    .select('id, dealership_id, role')
    .eq('id', req.params.id)
    .single()
  if (!target || target.dealership_id !== req.dealershipId) {
    return res.status(404).json({ error: 'User not found in your dealership' })
  }
  if (target.role === 'DEALER_ADMIN' || target.role === 'OWNER') {
    return res.status(403).json({ error: 'Cannot remove an admin/owner from the dashboard' })
  }

  await supabaseAdmin.from('profiles').delete().eq('id', req.params.id)
  await supabaseAdmin.auth.admin.deleteUser(req.params.id)
  res.json({ success: true })
})

// ── 6. CORE INVENTORY SECURE LOOKUPS ──
app.get('/inventory', requireAuth, async (req, res) => {
  const { data, error } = await supabaseAdmin.from('inventory').select('*').eq('dealership_id', req.dealershipId).eq('status', 'available').order('created_at', { ascending: false })
  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})

app.get('/inventory/all', requireAuth, async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('inventory')
    .select('id, vin, year, make, model, trim, price, mileage, exterior_color, status, image_urls, last_synced_at')
    .eq('dealership_id', req.dealershipId)
    .order('created_at', { ascending: false })
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

app.post('/listings/:id/sold', requireAuth, async (req, res) => {
  // Verify the listing belongs to a vehicle in this dealership
  const { data: listing, error: lookupErr } = await supabaseAdmin
    .from('listings')
    .select('id, inventory_id, inventory!inner(dealership_id)')
    .eq('id', req.params.id)
    .single()
  if (lookupErr || !listing) return res.status(404).json({ error: 'Listing not found' })
  if (listing.inventory.dealership_id !== req.dealershipId) return res.status(403).json({ error: 'Not your dealership' })

  const now = new Date().toISOString()
  const { error: listingErr } = await supabaseAdmin
    .from('listings')
    .update({ status: 'sold', deleted_at: now })
    .eq('id', req.params.id)
  if (listingErr) return res.status(500).json({ error: listingErr.message })

  const { error: invErr } = await supabaseAdmin
    .from('inventory')
    .update({ status: 'sold' })
    .eq('id', listing.inventory_id)
  if (invErr) return res.status(500).json({ error: invErr.message })

  res.json({ success: true })
})

// ── 8. UNIFIED BILLING ENGINE ──
app.post('/billing/checkout', requireAuth, async (req, res) => {
  // Dealer reps don't have their own billing — they're covered by the dealer's subscription.
  if (req.profile.role === 'SALES_REP' && req.dealershipId) {
    return res.status(403).json({ error: 'Sales reps under a dealership do not manage billing — your subscription is tied to the dealership account.' })
  }

  const isSolo = !req.dealershipId
  const priceId = req.body?.priceId || (isSolo ? process.env.STRIPE_SOLO_PRICE_ID : process.env.STRIPE_DEALER_PRICE_ID)
  if (!priceId) return res.status(500).json({ error: `Missing Stripe price ID env var (${isSolo ? 'STRIPE_SOLO_PRICE_ID' : 'STRIPE_DEALER_PRICE_ID'})` })

  const existingCustomerId = isSolo
    ? req.profile.stripe_customer_id
    : req.profile.dealerships?.stripe_customer_id

  const metadata = isSolo
    ? { type: 'solo_rep', user_id: req.user.id }
    : { type: 'dealership', dealership_id: req.dealershipId }

  const clientRefId = isSolo ? req.user.id : req.dealershipId

  try {
    if (existingCustomerId) {
      try {
        const portalSession = await stripe.billingPortal.sessions.create({ customer: existingCustomerId, return_url: `${process.env.FRONTEND_URL}/dashboard` })
        return res.json({ url: portalSession.url })
      } catch (portalErr) {
        console.warn('Portal initialization bypassed:', portalErr.message)
      }
    }
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      mode: 'subscription',
      client_reference_id: clientRefId,
      metadata,
      subscription_data: { metadata },
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
  const features = vehicle.searchablesarray?.slice(0, 15).join(' • ') || ''

  const tags = []
  if (vehicle.condition) tags.push(vehicle.condition.toUpperCase())
  if (vehicle.certified) tags.push('CERTIFIED PRE-OWNED')
  if (vehicle.demo) tags.push('DEMO')
  if (vehicle.salepending) tags.push('SALE PENDING')

  const headline = `${vehicle.year} ${vehicle.make} ${vehicle.model} ${vehicle.trim || ''}`.trim()
  const tagLine = tags.length ? `${tags.join(' • ')}` : null

  const specs = [
    vehicle.mileage ? `${Number(vehicle.mileage).toLocaleString()} km` : null,
    vehicle.exteriorcolor ? `${vehicle.exteriorcolor} exterior` : null,
    vehicle.interiorcolor ? `${vehicle.interiorcolor} interior` : null,
    vehicle.bodystyle || null,
    vehicle.engine || null,
    vehicle.drivetrain || null,
    vehicle.transmission ? `${vehicle.transmission} transmission` : null,
    vehicle.fueltype ? `${vehicle.fueltype} fuel` : null
  ].filter(Boolean)

  const sections = [
    tagLine ? `${tagLine}\n${headline}` : headline,
    specs.length ? specs.join(' • ') : null,
    features ? `FEATURES:\n${features}` : null,
    `Stock #${vehicle.stocknumber}`
  ].filter(Boolean)

  return sections.join('\n\n')
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

// Resolve any dealer-provided URL (public page or direct JSON) into a fetchable JSON feed URL
// and infer the inventory subset from path keywords.
function normalizeFeedUrl(input) {
  if (!input) return null
  let url
  try { url = new URL(input.trim()) } catch { return null }

  const path = url.pathname.toLowerCase()
  let detectedType = null
  if (path.includes('/new-inventory')) detectedType = 'new'
  else if (path.includes('/used-inventory')) detectedType = 'used'
  else if (path.includes('/demo-inventory')) detectedType = 'demo'
  else if (path.includes('/fleet')) detectedType = 'fleet'

  if (path.endsWith('.json')) return { jsonUrl: url.toString(), detectedType }

  // LeadBox convention — every LBX dealer site exposes the full inventory here
  return { jsonUrl: `${url.origin}/wp-content/uploads/data/inventory.json`, detectedType }
}

function matchesFeedType(v, feedType) {
  if (!feedType || feedType === 'all' || feedType === 'fleet') return true
  if (feedType === 'new') return v.condition === 'New' && !v.demo
  if (feedType === 'used') return v.condition === 'Used'
  if (feedType === 'demo') return v.demo === true
  return true
}

async function runInventorySync(dealershipId) {
  const { data: feeds } = await supabaseAdmin.from('inventory_feeds').select('feed_url, feed_type').eq('dealership_id', dealershipId)
  if (!feeds || feeds.length === 0) return { success: false, error: 'No inventory feeds configured for this dealership.' }

  let totalInserted = 0, totalSkipped = 0, totalVehiclesFound = 0
  const feedVins = []

  // Dedupe by URL — if the dealer has multiple feeds (new/used/demo) pointing at the same JSON,
  // we only need to fetch the JSON once and apply each filter against the cached vehicles list.
  const jsonCache = new Map()

  for (const feed of feeds) {
    try {
      let vehicles
      if (jsonCache.has(feed.feed_url)) {
        vehicles = jsonCache.get(feed.feed_url)
      } else {
        const feedRes = await fetch(`${feed.feed_url}?v=${Date.now()}`)
        const data = await feedRes.json()
        vehicles = data.vehicles || []
        jsonCache.set(feed.feed_url, vehicles)
      }
      totalVehiclesFound += vehicles.length

      for (const v of vehicles) {
        if (!matchesFeedType(v, feed.feed_type)) { totalSkipped++; continue }
        if (!v.onweb || v.nonvehicle) { totalSkipped++; continue }
        if (v.vin) feedVins.push(v.vin)

        await sleep(200)
        const imageUrls = await fetchVehiclePhotos(v.stocknumber)
        const record = {
          dealership_id: dealershipId,
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
    await supabaseAdmin.from('inventory').update({ status: 'sold' }).eq('dealership_id', dealershipId).eq('status', 'available').not('vin', 'in', `(${feedVins.map(v => `"${v}"`).join(',')})`)
  }

  return { success: true, total_in_feeds: totalVehiclesFound, processed: totalInserted, skipped: totalSkipped, synced_at: new Date().toISOString() }
}

// Secret-protected sync (for cron / external triggers)
app.get('/sync', async (req, res) => {
  const secret = req.query.secret
  if (secret !== process.env.SYNC_SECRET && process.env.SYNC_SECRET) return res.status(401).json({ error: 'Unauthorized' })

  const targetDealershipId = req.query.dealership_id
  if (!targetDealershipId) return res.status(400).json({ error: 'Missing target dealership parameter' })

  try {
    const { data: currentDealer } = await supabaseAdmin.from('dealerships').select('id').eq('id', targetDealershipId).single()
    if (!currentDealer) return res.status(404).json({ error: 'Target business identity not found.' })

    const result = await runInventorySync(targetDealershipId)
    if (!result.success) return res.status(404).json(result)
    res.json(result)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// User-facing inventory feed management
app.get('/inventory-feeds', requireAuth, async (req, res) => {
  if (!req.dealershipId) return res.json([])
  const { data, error } = await supabaseAdmin
    .from('inventory_feeds')
    .select('id, feed_url, feed_type, created_at')
    .eq('dealership_id', req.dealershipId)
    .order('created_at', { ascending: false })
  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})

app.post('/inventory-feeds', requireAuth, async (req, res) => {
  if (req.profile.role !== 'DEALER_ADMIN' && req.profile.role !== 'OWNER') return res.status(403).json({ error: 'Admins only' })
  if (!req.dealershipId) return res.status(400).json({ error: 'No dealership associated with this account' })

  const { feed_url: rawUrl, feed_type: requestedType } = req.body || {}
  if (!rawUrl) return res.status(400).json({ error: 'feed_url is required' })

  const normalized = normalizeFeedUrl(rawUrl)
  if (!normalized) return res.status(400).json({ error: 'Invalid URL' })

  // Probe the resolved JSON URL so we fail fast on a bad URL
  try {
    const probe = await fetch(normalized.jsonUrl, { method: 'GET' })
    if (!probe.ok) {
      return res.status(400).json({
        error: `Could not find an inventory feed at ${normalized.jsonUrl}. If your dealer doesn't use LeadBox, paste the direct JSON feed URL instead.`
      })
    }
    const probeData = await probe.json().catch(() => null)
    if (!probeData || !Array.isArray(probeData.vehicles)) {
      return res.status(400).json({ error: `URL responded but didn't contain a "vehicles" array. Resolved URL: ${normalized.jsonUrl}` })
    }
  } catch (e) {
    return res.status(400).json({ error: `Could not reach ${normalized.jsonUrl}: ${e.message}` })
  }

  const feedType = requestedType && requestedType !== 'all' ? requestedType : (normalized.detectedType || 'all')

  const { data, error } = await supabaseAdmin
    .from('inventory_feeds')
    .insert({
      dealership_id: req.dealershipId,
      user_id: req.user.id,
      feed_url: normalized.jsonUrl,
      feed_type: feedType
    })
    .select()
    .single()
  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})

app.delete('/inventory-feeds/:id', requireAuth, async (req, res) => {
  if (req.profile.role !== 'DEALER_ADMIN' && req.profile.role !== 'OWNER') return res.status(403).json({ error: 'Admins only' })
  const { data: feed } = await supabaseAdmin
    .from('inventory_feeds')
    .select('id, dealership_id')
    .eq('id', req.params.id)
    .single()
  if (!feed || feed.dealership_id !== req.dealershipId) {
    return res.status(404).json({ error: 'Feed not found' })
  }
  const { error } = await supabaseAdmin.from('inventory_feeds').delete().eq('id', req.params.id)
  if (error) return res.status(500).json({ error: error.message })
  res.json({ success: true })
})

app.post('/inventory/sync', requireAuth, async (req, res) => {
  if (!req.dealershipId) return res.status(400).json({ error: 'No dealership associated with this account' })
  try {
    const result = await runInventorySync(req.dealershipId)
    if (!result.success) return res.status(400).json(result)
    res.json(result)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ── 11. DIAGNOSTIC LAYER ──
app.get('/debug', requireAuth, async (req, res) => {
  res.json({ user_id: req.user.id, profile: req.profile, dealership_id: req.dealershipId })
})

app.use((err, req, res, next) => {
  console.error('Unhandled Express error:', { path: req.path, method: req.method, message: err.message, stack: err.stack })
  if (res.headersSent) return next(err)
  res.status(500).json({ error: err.message, path: req.path, stack: err.stack })
})

app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Secure Marketplace engine live on port ${PORT}`))
