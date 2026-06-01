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
      // Solo reps own a personal dealership, but their billing lives on the profile.
      // Real team dealerships use dealership.billing_status. Standalone users
      // (no dealership at all) also use profile.billing_status.
      const isPersonal = profile.dealerships?.is_personal === true
      const useProfileBilling = !profile.dealership_id || isPersonal

      const status = useProfileBilling
        ? profile.billing_status
        : profile.dealerships?.billing_status

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
      // Auto-create a personal "dealership" container so solo reps get their own
      // inventory pool, feeds, catalog, and sync — without affecting any team's data.
      const { data: personalDealership, error: personalErr } = await supabaseAdmin
        .from('dealerships')
        .insert({
          name: `${fullName} — Personal`,
          website_url: null,
          billing_status: null,        // billing lives on the profile for solo reps
          is_personal: true
        })
        .select()
        .single()
      if (personalErr) throw personalErr
      createdDealershipId = personalDealership.id

      const { error: profileError } = await supabaseAdmin
        .from('profiles')
        .insert({
          id: createdUserId,
          dealership_id: createdDealershipId,
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

app.post('/support', async (req, res) => {
  const { name, email, subject, message } = req.body || {}
  if (!name || !email || !message) return res.status(400).json({ error: 'name, email, and message are required' })

  const { error } = await supabaseAdmin
    .from('support_requests')
    .insert({ name, email, subject: subject || null, message })
  if (error) {
    console.error('Support insert failed:', error.message)
    return res.status(500).json({ error: 'Could not submit your request. Please try again.' })
  }
  console.log('📩 Support request:', { name, email, subject })
  res.json({ success: true })
})

app.post('/auth/forgot-password', async (req, res) => {
  const { email } = req.body || {}
  if (!email) return res.status(400).json({ error: 'email required' })
  // Always respond success to avoid leaking which addresses are registered
  try {
    await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${process.env.FRONTEND_URL}/reset-password.html`
    })
  } catch (e) {
    console.warn('resetPasswordForEmail failed:', e.message)
  }
  res.json({ success: true })
})

app.post('/auth/reset-password', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '')
  if (!token) return res.status(401).json({ error: 'No token provided' })
  const { password } = req.body || {}
  if (!password || password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' })

  const { data: { user }, error: userErr } = await supabase.auth.getUser(token)
  if (userErr || !user) return res.status(401).json({ error: 'Invalid recovery session' })

  const { error: updateErr } = await supabaseAdmin.auth.admin.updateUserById(user.id, { password })
  if (updateErr) return res.status(500).json({ error: updateErr.message })

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

  // Stitch in auth emails, listing counts, sold count, conversion, and recent login activity
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
  const enriched = await Promise.all(members.map(async (m) => {
    const { data: authUser } = await supabaseAdmin.auth.admin.getUserById(m.id).catch(() => ({ data: null }))
    const { count: listingsCount } = await supabaseAdmin
      .from('listings').select('id', { count: 'exact', head: true })
      .eq('posted_by', m.id).eq('status', 'posted')
    const { count: soldCount } = await supabaseAdmin
      .from('listings').select('id', { count: 'exact', head: true })
      .eq('posted_by', m.id).eq('status', 'sold')
    const { count: totalCount } = await supabaseAdmin
      .from('listings').select('id', { count: 'exact', head: true })
      .eq('posted_by', m.id)
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
      listings_sold: soldCount || 0,
      conversion_rate: (totalCount || 0) > 0 ? Math.round(((soldCount || 0) / (totalCount || 0)) * 100) : 0,
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

// Team leaderboard — PGA-style ranked table for the whole dealership (admin + reps).
// Visible to anyone in a team dealership (solo reps don't get a leaderboard).
app.get('/dealership/leaderboard', requireAuth, async (req, res) => {
  if (!req.dealershipId) return res.json({ ranking: [], total_members: 0 })
  if (req.profile.dealerships?.is_personal === true) return res.json({ ranking: [], total_members: 0 })

  const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString()

  const { data: members } = await supabaseAdmin
    .from('profiles').select('id, full_name, role').eq('dealership_id', req.dealershipId)
  if (!members?.length) return res.json({ ranking: [], total_members: 0 })

  const rows = await Promise.all(members.map(async (m) => {
    const { count: posted } = await supabaseAdmin
      .from('listings').select('id', { count: 'exact', head: true })
      .eq('posted_by', m.id).eq('status', 'posted')
    const { count: sold } = await supabaseAdmin
      .from('listings').select('id', { count: 'exact', head: true })
      .eq('posted_by', m.id).eq('status', 'sold')
    const { count: total } = await supabaseAdmin
      .from('listings').select('id', { count: 'exact', head: true })
      .eq('posted_by', m.id)
    const { count: recentLogins } = await supabaseAdmin
      .from('logins').select('id', { count: 'exact', head: true })
      .eq('user_id', m.id).gte('created_at', fourteenDaysAgo)
    return {
      id: m.id,
      name: m.full_name,
      role: m.role,
      total_listings: total || 0,
      active_listings: posted || 0,
      sold_listings: sold || 0,
      recent_logins: recentLogins || 0,
      conversion_rate: (total || 0) > 0 ? Math.round(((sold || 0) / (total || 0)) * 100) : 0
    }
  }))

  // Rank by: most listings first, then most sold, then most active (recent logins).
  // Stable ordering by name for fully-tied rows.
  const ranking = rows
    .slice()
    .sort((a, b) =>
      b.total_listings - a.total_listings
      || b.sold_listings - a.sold_listings
      || b.recent_logins - a.recent_logins
      || a.name.localeCompare(b.name)
    )
    .map((r, i) => ({ ...r, rank: i + 1 }))

  const totalListings = rows.reduce((s, r) => s + r.total_listings, 0)
  const totalSold = rows.reduce((s, r) => s + r.sold_listings, 0)

  res.json({
    ranking,                                    // ordered, with rank attached
    total_members: members.length,
    team_total_listings: totalListings,
    team_total_sold: totalSold,
    team_conversion_rate: totalListings > 0 ? Math.round((totalSold / totalListings) * 100) : 0
  })
})

// Recent team activity (for the gamified leaderboard's activity feed)
app.get('/dealership/activity', requireAuth, async (req, res) => {
  if (!req.dealershipId) return res.json({ events: [] })
  if (req.profile.dealerships?.is_personal === true) return res.json({ events: [] })

  const { data: members } = await supabaseAdmin
    .from('profiles').select('id, full_name').eq('dealership_id', req.dealershipId)
  if (!members?.length) return res.json({ events: [] })

  const memberMap = new Map(members.map(m => [m.id, m.full_name]))
  const memberIds = members.map(m => m.id)

  const { data: listings } = await supabaseAdmin
    .from('listings')
    .select('id, status, posted_at, deleted_at, posted_by, inventory!inner(year, make, model)')
    .in('posted_by', memberIds)
    .order('posted_at', { ascending: false })
    .limit(50)

  const events = []
  for (const l of listings || []) {
    const vehicle = `${l.inventory?.year || ''} ${l.inventory?.make || ''} ${l.inventory?.model || ''}`.trim()
    const userName = memberMap.get(l.posted_by) || 'Unknown'
    if (l.posted_at) {
      events.push({ type: 'posted', user_name: userName, vehicle, timestamp: l.posted_at, points: 100 })
    }
    if (l.status === 'sold' && l.deleted_at) {
      events.push({ type: 'sold', user_name: userName, vehicle, timestamp: l.deleted_at, points: 500 })
    }
  }
  events.sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''))
  res.json({ events: events.slice(0, 25) })
})

// Time-series data for charts — dealer admin only
app.get('/dealership/charts', requireAuth, async (req, res) => {
  if (req.profile.role !== 'DEALER_ADMIN' && req.profile.role !== 'OWNER') return res.status(403).json({ error: 'Admins only' })
  if (!req.dealershipId) return res.json({ daily: [], by_rep: [] })

  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()

  const { data: members } = await supabaseAdmin
    .from('profiles').select('id, full_name').eq('dealership_id', req.dealershipId)
  if (!members?.length) return res.json({ daily: [], by_rep: [] })
  const memberIds = members.map(m => m.id)

  // Listings over last 30 days (for the time-series chart)
  const { data: recentListings } = await supabaseAdmin
    .from('listings').select('posted_at, posted_by')
    .in('posted_by', memberIds)
    .gte('posted_at', thirtyDaysAgo)

  const dayBuckets = new Map()
  for (let i = 29; i >= 0; i--) {
    const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000)
    dayBuckets.set(d.toISOString().slice(0, 10), 0)
  }
  for (const l of recentListings || []) {
    const key = (l.posted_at || '').slice(0, 10)
    if (dayBuckets.has(key)) dayBuckets.set(key, dayBuckets.get(key) + 1)
  }

  // Per-rep all-time listings + sold
  const { data: allListings } = await supabaseAdmin
    .from('listings').select('posted_by, status').in('posted_by', memberIds)
  const repTotals = new Map(members.map(m => [m.id, { id: m.id, name: m.full_name, count: 0, sold: 0 }]))
  for (const l of allListings || []) {
    const entry = repTotals.get(l.posted_by)
    if (!entry) continue
    entry.count++
    if (l.status === 'sold') entry.sold++
  }

  // Active days per rep — distinct days each rep logged in over the last 14 days
  const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString()
  const { data: logins14 } = await supabaseAdmin
    .from('logins').select('user_id, created_at')
    .in('user_id', memberIds).gte('created_at', fourteenDaysAgo)
  const activeDaysByRep = new Map(members.map(m => [m.id, new Set()]))
  for (const l of logins14 || []) {
    const day = (l.created_at || '').slice(0, 10)
    if (day && activeDaysByRep.has(l.user_id)) activeDaysByRep.get(l.user_id).add(day)
  }

  const by_rep = [...repTotals.values()].sort((a, b) => b.count - a.count)
  const sold_by_rep = [...repTotals.values()].map(r => ({ name: r.name, count: r.sold })).sort((a, b) => b.count - a.count)
  const active_days_by_rep = [...repTotals.values()].map(r => ({
    name: r.name,
    count: activeDaysByRep.get(r.id)?.size || 0
  })).sort((a, b) => b.count - a.count)

  res.json({
    daily: [...dayBuckets.entries()].map(([date, count]) => ({ date, count })),
    by_rep,
    sold_by_rep,
    active_days_by_rep
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
  const day = now.getUTCDay() || 7
  const startOfWeek = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (day - 1))).toISOString()

  // Wrap each query independently so one failure can't blank the whole strip.
  let inventorySynced = 0, listingsPosted = 0, soldThisMonth = 0, activeDaysThisWeek = 0
  const warnings = {}

  let inventoryAvailable = 0
  try {
    if (req.dealershipId) {
      const { count, error } = await supabaseAdmin
        .from('inventory').select('id', { count: 'exact', head: true })
        .eq('dealership_id', req.dealershipId)
      if (error) warnings.inventory_total = error.message
      else inventorySynced = count || 0

      const { count: avail, error: availErr } = await supabaseAdmin
        .from('inventory').select('id', { count: 'exact', head: true })
        .eq('dealership_id', req.dealershipId)
        .eq('status', 'available')
      if (availErr) warnings.inventory_available = availErr.message
      else inventoryAvailable = avail || 0
    }
  } catch (e) { warnings.inventory = e.message }

  // Breakdown: for admins we surface separate counts for their own posts vs reps' posts.
  let listingsByAdmin = 0, listingsByReps = 0
  try {
    if (isAdmin && req.dealershipId) {
      // Get team members (avoiding inventory!inner — too fragile)
      const { data: members, error: memErr } = await supabaseAdmin
        .from('profiles').select('id, role').eq('dealership_id', req.dealershipId)
      if (memErr) warnings.listings = memErr.message
      else {
        const memberIds = (members || []).map(m => m.id)
        const adminIds = (members || []).filter(m => m.role === 'DEALER_ADMIN' || m.role === 'OWNER').map(m => m.id)
        const repIds = (members || []).filter(m => m.role === 'SALES_REP').map(m => m.id)

        if (memberIds.length) {
          const { count: total } = await supabaseAdmin
            .from('listings').select('id', { count: 'exact', head: true })
            .in('posted_by', memberIds)
          listingsPosted = total || 0

          const { count: sold } = await supabaseAdmin
            .from('listings').select('id', { count: 'exact', head: true })
            .in('posted_by', memberIds).eq('status', 'sold')
          soldThisMonth = sold || 0
        }

        if (adminIds.length) {
          const { count } = await supabaseAdmin
            .from('listings').select('id', { count: 'exact', head: true })
            .in('posted_by', adminIds)
          listingsByAdmin = count || 0
        }
        if (repIds.length) {
          const { count } = await supabaseAdmin
            .from('listings').select('id', { count: 'exact', head: true })
            .in('posted_by', repIds)
          listingsByReps = count || 0
        }
      }
    } else {
      const { count: total, error: totalErr } = await supabaseAdmin
        .from('listings').select('id', { count: 'exact', head: true }).eq('posted_by', req.user.id)
      if (totalErr) warnings.listings = totalErr.message
      else listingsPosted = total || 0

      const { count: sold, error: soldErr } = await supabaseAdmin
        .from('listings').select('id', { count: 'exact', head: true })
        .eq('posted_by', req.user.id).eq('status', 'sold')
      if (soldErr) warnings.sold = soldErr.message
      else soldThisMonth = sold || 0
    }
  } catch (e) { warnings.listings = e.message }

  try {
    const { data, error } = await supabaseAdmin
      .from('logins')
      .select('created_at')
      .eq('user_id', req.user.id)
      .gte('created_at', startOfWeek)
    if (error) warnings.logins = error.message
    else {
      const distinctDays = new Set((data || []).map(l => l.created_at.slice(0, 10)))
      activeDaysThisWeek = distinctDays.size
    }
  } catch (e) { warnings.logins = e.message }

  if (Object.keys(warnings).length) console.warn('Insights partial:', { user: req.user.id, role: req.profile.role, warnings })

  res.json({
    inventory_available: inventoryAvailable,
    inventory_synced: inventorySynced,
    listings_posted: listingsPosted,
    listings_by_admin: listingsByAdmin,
    listings_by_reps: listingsByReps,
    sold_this_month: soldThisMonth,
    active_days_this_week: activeDaysThisWeek,
    scope: isAdmin ? 'dealership' : 'personal',
    warnings: Object.keys(warnings).length ? warnings : undefined
  })
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
  const countOf = async (status) => {
    try {
      let q = supabaseAdmin.from('listings').select('id', { count: 'exact', head: true }).eq('posted_by', userId)
      if (status) q = q.eq('status', status)
      const { count, error } = await q
      if (error) { console.warn(`countOf(${status || 'all'}) failed:`, error.message); return 0 }
      return count || 0
    } catch (e) {
      console.warn(`countOf(${status || 'all'}) threw:`, e.message)
      return 0
    }
  }
  const [total, active, sold, deleted] = await Promise.all([
    countOf(null),
    countOf('posted'),
    countOf('sold'),
    countOf('deleted')
  ])

  let recent = []
  try {
    const { data, error } = await supabaseAdmin
      .from('listings')
      .select('id, status, posted_at, fb_listing_url, inventory!inner(id, year, make, model, trim, price, image_urls)')
      .eq('posted_by', userId)
      .order('posted_at', { ascending: false })
      .limit(10)
    if (error) console.warn('Recent listings failed:', error.message)
    else recent = data || []
  } catch (e) {
    console.warn('Recent listings threw:', e.message)
  }

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
    .select('id, vin, year, make, model, trim, price, mileage, exterior_color, status, image_urls, source_url, last_synced_at')
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

// Called by the extension's content script when it detects a "Sold" badge on a
// FB Marketplace listing page the user owns. Idempotent — safe to call multiple times.
app.post('/listings/sync-fb-sold', requireAuth, async (req, res) => {
  const { fb_listing_url } = req.body || {}
  if (!fb_listing_url) return res.status(400).json({ error: 'fb_listing_url required' })

  // Match by URL prefix so trailing query params/fragments don't break the lookup
  const normalizedUrl = fb_listing_url.split('?')[0].split('#')[0]

  const { data: candidates } = await supabaseAdmin
    .from('listings')
    .select('id, inventory_id, status, fb_listing_url, inventory!inner(dealership_id)')
    .eq('status', 'posted')
    .ilike('fb_listing_url', `${normalizedUrl}%`)

  const listing = (candidates || []).find(l => l.inventory.dealership_id === req.dealershipId)
  if (!listing) return res.json({ success: false, matched: false })

  const now = new Date().toISOString()
  await supabaseAdmin.from('listings').update({ status: 'sold', deleted_at: now }).eq('id', listing.id)
  await supabaseAdmin.from('inventory').update({ status: 'sold' }).eq('id', listing.inventory_id)
  res.json({ success: true, matched: true, listing_id: listing.id })
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
  const isPersonal = req.profile.dealerships?.is_personal === true
  // Solo rep = either no dealership, or a personal one. Either way bills on the profile.
  const isSolo = !req.dealershipId || isPersonal

  // Dealer reps (real team rep — not personal dealership) don't pay individually.
  if (req.profile.role === 'SALES_REP' && req.dealershipId && !isPersonal) {
    return res.status(403).json({ error: 'Sales reps under a dealership do not manage billing — your subscription is tied to the dealership account.' })
  }
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
        const portalSession = await stripe.billingPortal.sessions.create({ customer: existingCustomerId, return_url: `${process.env.FRONTEND_URL}/dashboard.html` })
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
      subscription_data: { metadata, trial_period_days: 7 },
      success_url: `${process.env.FRONTEND_URL}/dashboard.html`,
      cancel_url: `${process.env.FRONTEND_URL}/dashboard.html`
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


// ── FEED PROBE ENDPOINT ──────────────────────────────────────────────────────
// Replaces the single-platform normalizeFeedUrl with a multi-platform detector.
// Also adds POST /feeds/probe so the dashboard/extension can discover feed URLs
// before committing them to the DB.
// ─────────────────────────────────────────────────────────────────────────────

// Known field shapes per platform so we can validate a response is actually
// vehicle inventory and not some other JSON blob.
const PLATFORM_PROBES = [
  // ── LeadBox (WordPress-based, Canadian — your current platform) ───────────
  {
    platform: 'leadbox',
    label: 'LeadBox',
    buildUrls: (origin) => [
      `${origin}/wp-content/uploads/data/inventory.json`
    ],
    validate: (data) => Array.isArray(data?.vehicles) && data.vehicles.length > 0,
    extract: (data) => data.vehicles,
    mapVehicle: (v) => ({
      vin: v.vin,
      year: v.year,
      make: v.make,
      model: v.model,
      trim: v.trim,
      price: v.saleprice || v.price,
      mileage: v.mileage,
      condition: v.condition,
      stocknumber: v.stocknumber,
      exteriorcolor: v.exteriorcolor,
    })
  },

  // ── EDealer (Canadian — Honda, Nissan, Hyundai in Ontario) ────────────────
  {
    platform: 'edealer',
    label: 'EDealer',
    buildUrls: (origin) => [
      `${origin}/api/inventory/getall`,
      `${origin}/api/vehicles`,
      `${origin}/Inventory/GetInventory`
    ],
    validate: (data) => {
      if (Array.isArray(data) && data[0]?.VIN) return true
      if (Array.isArray(data?.vehicles) && data.vehicles[0]?.VIN) return true
      if (Array.isArray(data?.Vehicles) && data.Vehicles[0]?.VIN) return true
      return false
    },
    extract: (data) => Array.isArray(data) ? data : (data?.vehicles || data?.Vehicles || []),
    mapVehicle: (v) => ({
      vin: v.VIN || v.vin,
      year: v.Year || v.year,
      make: v.Make || v.make,
      model: v.Model || v.model,
      trim: v.Trim || v.trim,
      price: v.Price || v.ListPrice || v.price,
      mileage: v.Mileage || v.mileage,
      condition: v.IsNew ? 'New' : 'Used',
      stocknumber: v.StockNumber || v.stocknumber,
      exteriorcolor: v.ExteriorColour || v.ExteriorColor || v.exteriorcolor,
    })
  },

  // ── Dealer Inspire / Cars.com (WP REST API) ───────────────────────────────
  {
    platform: 'dealer_inspire',
    label: 'Dealer Inspire',
    buildUrls: (origin) => [
      `${origin}/wp-json/di-wp/v2/inventory`,
      `${origin}/wp-json/inventory/v1/vehicles`
    ],
    validate: (data) => Array.isArray(data) && data[0]?.vin,
    extract: (data) => data,
    mapVehicle: (v) => ({
      vin: v.vin,
      year: v.year,
      make: v.make,
      model: v.model,
      trim: v.trim,
      price: v.price || v.final_price,
      mileage: v.mileage || v.odometer,
      condition: v.type,
      stocknumber: v.stock_number || v.stock,
      exteriorcolor: v.exterior_color,
    })
  },

  // ── Dealer.com / Cox Automotive ───────────────────────────────────────────
  {
    platform: 'dealer_com',
    label: 'Dealer.com',
    buildUrls: (origin) => [
      `${origin}/apis/widget/INVENTORY_LISTING_DEFAULT_AUTO_ALL:inventory-data-bus1/getInventory?limit=10`,
      `${origin}/apis/widget/INVENTORY_LISTING_DEFAULT_AUTO_ALL:inventory-data-bus1/getInventory`
    ],
    validate: (data) => Array.isArray(data?.inventory) && data.inventory.length > 0,
    extract: (data) => data.inventory,
    mapVehicle: (v) => ({
      vin: v.vin,
      year: v.modelYear || v.year,
      make: v.make,
      model: v.model,
      trim: v.trim,
      price: v.pricing?.advertised || v.finalPrice || v.price,
      mileage: v.odometer || v.mileage,
      condition: v.type,
      stocknumber: v.stockNumber || v.stock,
      exteriorcolor: v.exteriorColor,
    })
  },

  // ── Sincro / DealerOn (Toyota & Lexus Canada default) ────────────────────
  {
    platform: 'sincro',
    label: 'Sincro / DealerOn',
    buildUrls: (origin) => [
      `${origin}/api/inventory/vehicles`,
      `${origin}/api/vehicles`,
      `${origin}/inventory/api/vehicles`
    ],
    validate: (data) => {
      if (Array.isArray(data?.vehicles) && data.vehicles[0]?.vin) return true
      if (Array.isArray(data?.data) && data.data[0]?.vin) return true
      return false
    },
    extract: (data) => data?.vehicles || data?.data || [],
    mapVehicle: (v) => ({
      vin: v.vin,
      year: v.year || v.modelYear,
      make: v.make,
      model: v.model,
      trim: v.trim,
      price: v.price || v.sellingPrice,
      mileage: v.mileage || v.odometer,
      condition: v.newOrUsed || v.condition,
      stocknumber: v.stockNumber || v.stock,
      exteriorcolor: v.exteriorColor || v.color,
    })
  },

  // ── CDK Global ────────────────────────────────────────────────────────────
  {
    platform: 'cdk',
    label: 'CDK Global',
    buildUrls: (origin) => [
      `${origin}/inventory/api/vehicles?pageSize=10`,
      `${origin}/api/cdk/inventory`
    ],
    validate: (data) => Array.isArray(data?.vehicles || data?.results) && (data?.vehicles || data?.results)?.[0]?.vin,
    extract: (data) => data?.vehicles || data?.results || [],
    mapVehicle: (v) => ({
      vin: v.vin,
      year: v.modelYear || v.year,
      make: v.make,
      model: v.model,
      trim: v.trim,
      price: v.internetPrice || v.price,
      mileage: v.mileage,
      condition: v.type,
      stocknumber: v.stockNumber,
      exteriorcolor: v.exteriorColor,
    })
  },

  // ── Strathcom (Canadian — Alberta/Ontario) ────────────────────────────────
  {
    platform: 'strathcom',
    label: 'Strathcom',
    buildUrls: (origin) => [
      `${origin}/wp-content/uploads/data/inventory.json`,
      `${origin}/vehicle-inventory/feeds/all.json`
    ],
    validate: (data) => Array.isArray(data?.vehicles) && data.vehicles.length > 0,
    extract: (data) => data.vehicles,
    mapVehicle: (v) => ({
      vin: v.vin,
      year: v.year,
      make: v.make,
      model: v.model,
      trim: v.trim,
      price: v.price || v.saleprice,
      mileage: v.mileage,
      condition: v.condition,
      stocknumber: v.stocknumber,
      exteriorcolor: v.exteriorcolor,
    })
  },

  // ── Vicimus / Glovebox (Canadian) ─────────────────────────────────────────
  {
    platform: 'vicimus',
    label: 'Vicimus / Glovebox',
    buildUrls: (origin) => [
      `${origin}/api/inventory`,
      `${origin}/glovebox/api/inventory/vehicles`
    ],
    validate: (data) => Array.isArray(data?.data || data) && (data?.data || data)?.[0]?.vin,
    extract: (data) => data?.data || data || [],
    mapVehicle: (v) => ({
      vin: v.vin,
      year: v.year,
      make: v.make,
      model: v.model,
      trim: v.trim,
      price: v.price,
      mileage: v.odometer || v.mileage,
      condition: v.condition,
      stocknumber: v.stockNumber || v.stock,
      exteriorcolor: v.exteriorColour || v.exteriorColor,
    })
  },

  // ── SM360 (Canadian market) ───────────────────────────────────────────────
  {
    platform: 'sm360',
    label: 'SM360',
    buildUrls: (origin) => [
      `${origin}/api/inventory/list`,
      `${origin}/fr/api/vehicles`,
      `${origin}/en/api/vehicles`
    ],
    validate: (data) => Array.isArray(data?.vehicles || data?.results || data),
    extract: (data) => data?.vehicles || data?.results || (Array.isArray(data) ? data : []),
    mapVehicle: (v) => ({
      vin: v.vin || v.Vin,
      year: v.year || v.Year,
      make: v.make || v.Make,
      model: v.model || v.Model,
      trim: v.trim || v.Trim,
      price: v.price || v.Price,
      mileage: v.mileage || v.Mileage,
      condition: v.condition || v.Condition,
      stocknumber: v.stockNumber || v.StockNumber,
      exteriorcolor: v.exteriorColor || v.ExteriorColor,
    })
  },

  // ── DealerFire / Solera (common in US, some Canadian) ────────────────────
  {
    platform: 'dealerfire',
    label: 'DealerFire',
    buildUrls: (origin) => [
      `${origin}/ws/getData.php?type=inventory`,
      `${origin}/inventory.json`
    ],
    validate: (data) => Array.isArray(data?.vehicles || data) && (data?.vehicles || data)?.[0]?.vin,
    extract: (data) => data?.vehicles || (Array.isArray(data) ? data : []),
    mapVehicle: (v) => ({
      vin: v.vin,
      year: v.year,
      make: v.make,
      model: v.model,
      trim: v.trim,
      price: v.price,
      mileage: v.mileage,
      condition: v.condition,
      stocknumber: v.stock,
      exteriorcolor: v.color,
    })
  },

  // ── Schema.org JSON-LD (universal fallback) ────────────────────────────────
  // Any dealer site that publishes Vehicle / Car Schema.org structured data in
  // its inventory page HTML works. Tried LAST after every platform-specific JSON
  // path fails. Covers EDealer, plus any future platform that adds JSON-LD.
  {
    platform: 'schema_jsonld',
    label: 'Schema.org JSON-LD',
    htmlProbe: true,
    buildUrls: () => [],   // unused — detectFeedPlatform uses the page URL directly
    validate: (data) => {
      if (!data?.jsonLd) return false
      return extractCarsFromJsonLd(data.jsonLd).length > 0
    },
    extract: (data) => extractCarsFromJsonLd(data.jsonLd),
    mapVehicle: (v) => {
      // Schema.org URL-encoded condition → New / Used
      const cond = v.itemCondition || ''
      const condition = cond.includes('NewCondition') ? 'New'
        : cond.includes('UsedCondition') ? 'Used'
        : cond.includes('Refurbished') ? 'Certified'
        : null
      // Drive wheel config URL → readable
      const drive = (v.driveWheelConfiguration || '').match(/\/(\w+)WheelDriveConfiguration/)?.[1]
      // Trim heuristic: vehicleConfiguration often = "AWD 4dr Avenir SUV" — last token is body, rest is trim.
      let trim = null
      if (typeof v.vehicleConfiguration === 'string') {
        const parts = v.vehicleConfiguration.split(' ')
        trim = parts.slice(0, -1).join(' ') || null
      }
      const image = Array.isArray(v.image) ? v.image[0] : v.image
      return {
        vin: v.vehicleIdentificationNumber,
        year: v.vehicleModelDate,
        make: v.brand?.name || v.manufacturer?.name || v.brand,
        model: v.model,
        trim,
        price: v.offers?.price ?? null,
        mileage: v.mileageFromOdometer?.value ?? null,
        condition,
        stocknumber: v.sku || v.productID,
        exteriorcolor: v.color,
        interiorcolor: v.vehicleInteriorColor,
        bodystyle: v.bodyType,
        fueltype: v.vehicleEngine?.fuelType,
        transmission: v.vehicleTransmission,
        drivetrain: drive,
        image_urls: image && image !== 'https://static.edealer.ca/V4/assets/images/new_vehicles_images_coming.png' ? [image] : []
      }
    }
  },
]

// ── Helper: probe a single URL with a timeout ─────────────────────────────
// Fetch an HTML page and pull every <script type="application/ld+json"> block.
// Returns a flat array of Schema.org nodes (with @graph unwrapped).
async function probeUrlHtml(url, timeoutMs = 12000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 MarketSync-FeedProbe/1.0' }
    })
    clearTimeout(timer)
    if (!res.ok) return { ok: false, status: res.status }
    const html = await res.text()
    const blocks = []
    const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
    let m
    while ((m = re.exec(html)) !== null) {
      try { blocks.push(JSON.parse(m[1])) } catch {}
    }
    // Flatten @graph arrays
    const flat = []
    const walk = (node) => {
      if (!node) return
      if (Array.isArray(node)) { node.forEach(walk); return }
      if (Array.isArray(node['@graph'])) { node['@graph'].forEach(walk); return }
      flat.push(node)
    }
    blocks.forEach(walk)
    return { ok: true, jsonLd: flat }
  } catch (e) {
    clearTimeout(timer)
    return { ok: false, reason: e.name === 'AbortError' ? 'timeout' : e.message }
  }
}

// Parse one EDealer vehicle detail page into a vehicle record.
// EDealer detail pages don't carry per-vehicle JSON-LD (the Car node is on the listing
// page), so we extract from <title>, <meta description>, and body content via regex.
function parseEDealerDetailPage(html, url) {
  const titleMatch = html.match(/<title>([^<]+)<\/title>/i)
  const title = titleMatch ? titleMatch[1].trim() : ''

  // Title shape: "New 2026 GMC Yukon 4WD 4dr Denali for Sale in St. Catharines, ON | John Bear..."
  const condMatch = title.match(/^(New|Used|Demo|Pre-Owned|Certified Pre-Owned)\b/i)
  const condition = condMatch ? condMatch[1] : null
  const ymmMatch = title.match(/^(?:New|Used|Demo|Pre-Owned|Certified Pre-Owned)?\s*(\d{4})\s+(\S+)\s+(.+?)\s+for Sale/i)
  const year = ymmMatch ? parseInt(ymmMatch[1]) : null
  const make = ymmMatch ? ymmMatch[2] : null
  const model = ymmMatch ? ymmMatch[3] : null

  // Meta description: "Learn more about this New 2026 GMC Yukon ..., 9162-26 available now ... for $120,082"
  const metaMatch = html.match(/<meta\s+name="description"[^>]*content="([^"]+)"/i)
  const metaDesc = metaMatch ? metaMatch[1] : ''
  const stockMatch = metaDesc.match(/,\s*([A-Z0-9-]{3,20})\s+available/i)
  const stocknumber = stockMatch ? stockMatch[1] : null
  const priceMatch = metaDesc.match(/\$([\d,]+)/)
  const price = priceMatch ? parseInt(priceMatch[1].replace(/,/g, '')) : 0

  // First valid VIN in page body — typically the primary vehicle (similar vehicles below)
  const vinMatch = html.match(/[A-HJ-NPR-Z0-9]{17}/)
  const vin = vinMatch ? vinMatch[0] : null

  // First km/miles count on the page
  const mileageMatch = html.match(/(\d{1,3}(?:,\d{3})*)\s*km\b/i)
  const mileage = mileageMatch ? parseInt(mileageMatch[1].replace(/,/g, '')) : 0

  // All unique full-res inventory images for this vehicle
  const imageRe = /https:\/\/media\.edealer\.ca\/w_1920[^"'\s]*\/inventory\/[A-Z0-9]+\.webp/g
  const seen = new Set()
  const image_urls = []
  let m
  while ((m = imageRe.exec(html)) !== null) {
    if (!seen.has(m[0])) { seen.add(m[0]); image_urls.push(m[0]) }
  }

  // Only return if we got the essentials (VIN + year + make)
  if (!vin || !year || !make) return null

  return {
    vin, year, make, model, price, mileage, stocknumber, condition,
    onweb: true, salepending: false, image_urls,
    _detail_url: url
  }
}

// Fetch + parse all vehicles via the EDealer inventory sitemap (works on all EDealer dealer sites).
// Returns full inventory regardless of pagination — solves the infinite-scroll limitation.
async function fetchEDealerInventoryFromSitemap(origin) {
  try {
    const r = await fetch(`${origin}/inventory-listing-sitemap.xml`, { headers: { 'User-Agent': 'MarketSync-Sync/1.0' } })
    if (!r.ok) return null
    const xml = await r.text()
    const urls = [...xml.matchAll(/<loc>([^<]+\/inventory\/[^<]+vdp\/?)<\/loc>/g)].map(m => m[1])
    if (!urls.length) return null
    console.log(`[sync] EDealer sitemap: ${urls.length} detail URLs to fetch`)

    const vehicles = []
    const CONCURRENCY = 6
    for (let i = 0; i < urls.length; i += CONCURRENCY) {
      const batch = urls.slice(i, i + CONCURRENCY)
      const results = await Promise.all(batch.map(async (url) => {
        try {
          const res = await fetch(url, { headers: { 'User-Agent': 'MarketSync-Sync/1.0' } })
          if (!res.ok) return null
          return parseEDealerDetailPage(await res.text(), url)
        } catch { return null }
      }))
      vehicles.push(...results.filter(Boolean))
    }
    console.log(`[sync] EDealer sitemap: extracted ${vehicles.length} valid vehicles`)
    return vehicles
  } catch (e) {
    console.warn('[sync] EDealer sitemap fetch failed:', e.message)
    return null
  }
}

// Extract ALL unique full-res inventory image URLs from a single page of HTML.
// Used for detail pages which contain ~10-30 photos of one vehicle.
function extractEDealerImagesFromPage(html) {
  const re = /https:\/\/media\.edealer\.ca\/w_1920[^"'\s]*\/inventory\/[A-Z0-9]+\.webp/g
  const seen = new Set()
  let m
  while ((m = re.exec(html)) !== null) seen.add(m[0])
  return [...seen]
}

// Find vehicle detail-page anchors in EDealer listing HTML (one per vehicle, in document order)
function extractEDealerDetailUrls(html, origin) {
  const re = /href="(\/inventory\/[a-zA-Z0-9-]+vdp\/?)"/g
  const out = []
  const seen = new Set()
  let m
  while ((m = re.exec(html)) !== null) {
    const path = m[1].endsWith('/') ? m[1] : m[1] + '/'
    if (!seen.has(path)) { seen.add(path); out.push(`${origin}${path}`) }
  }
  return out
}

// Fetch detail pages concurrently in batches, extract per-vehicle photos. Order preserved.
async function fetchEDealerDetailImageGroups(detailUrls, concurrency = 4) {
  const results = new Array(detailUrls.length).fill([])
  for (let i = 0; i < detailUrls.length; i += concurrency) {
    const batch = detailUrls.slice(i, i + concurrency)
    const batchResults = await Promise.all(batch.map(async (url) => {
      try {
        const r = await fetch(url, { headers: { 'User-Agent': 'MarketSync-Sync/1.0' } })
        if (!r.ok) return []
        return extractEDealerImagesFromPage(await r.text())
      } catch { return [] }
    }))
    batchResults.forEach((imgs, idx) => { results[i + idx] = imgs })
  }
  return results
}

// Extract per-vehicle image galleries from EDealer-style inventory HTML.
// EDealer renders one `w_400` thumbnail per vehicle followed by N `w_1920` full-res
// images of that vehicle, then the next thumbnail marks the next vehicle.
function extractEDealerImageGroups(html) {
  const thumbRe = /https:\/\/media\.edealer\.ca\/w_400[^"'\s]*\/inventory\/[A-Z0-9]+\.webp/g
  const fullRe = /https:\/\/media\.edealer\.ca\/w_1920[^"'\s]*\/inventory\/[A-Z0-9]+\.webp/g
  const thumbs = []
  let m
  while ((m = thumbRe.exec(html)) !== null) thumbs.push({ pos: m.index, url: m[0] })
  const fulls = []
  while ((m = fullRe.exec(html)) !== null) fulls.push({ pos: m.index, url: m[0] })
  if (!thumbs.length) return []
  return thumbs.map((t, i) => {
    const end = i + 1 < thumbs.length ? thumbs[i + 1].pos : html.length
    const seen = new Set()
    const gallery = []
    for (const f of fulls) {
      if (f.pos > t.pos && f.pos < end && !seen.has(f.url)) {
        seen.add(f.url)
        gallery.push(f.url)
      }
    }
    return gallery
  })
}

// Walk JSON-LD nodes and pull every Car / Vehicle item.
// Robust against arbitrary nesting — handles ItemList, double-nested arrays
// (some dealer platforms emit `itemListElement: [[{...}]]`), @graph wrappers, etc.
function extractCarsFromJsonLd(nodes) {
  const cars = []
  const seen = new WeakSet()
  const isCar = (node) => {
    const type = node?.['@type']
    if (!type) return false
    const types = Array.isArray(type) ? type : [type]
    return types.some(t => t === 'Car' || t === 'Vehicle' || t === 'MotorVehicle')
  }
  const visit = (node) => {
    if (!node) return
    if (Array.isArray(node)) { node.forEach(visit); return }
    if (typeof node !== 'object') return
    if (seen.has(node)) return
    seen.add(node)
    if (isCar(node)) { cars.push(node); return }
    // Follow common wrappers — each may itself be an array, object, or array-of-array
    if (node['@graph']) visit(node['@graph'])
    if (node.itemListElement) visit(node.itemListElement)
    if (node.item) visit(node.item)
  }
  visit(nodes)
  return cars
}

async function probeUrl(url, timeoutMs = 8000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'Accept': 'application/json', 'User-Agent': 'MarketSync-FeedProbe/1.0' }
    })
    clearTimeout(timer)
    if (!res.ok) return { ok: false, status: res.status }
    const contentType = res.headers.get('content-type') || ''
    if (!contentType.includes('json')) return { ok: false, status: res.status, reason: 'non-json response' }
    const data = await res.json()
    return { ok: true, data }
  } catch (e) {
    clearTimeout(timer)
    return { ok: false, reason: e.name === 'AbortError' ? 'timeout' : e.message }
  }
}

// ── Core: try all platforms against a given dealer URL ────────────────────
async function detectFeedPlatform(dealerUrl) {
  let origin
  try {
    origin = new URL(dealerUrl.trim()).origin
  } catch {
    return { success: false, error: 'Invalid URL' }
  }

  const attempts = []

  for (const platform of PLATFORM_PROBES) {
    const urls = platform.htmlProbe
      ? [dealerUrl]                  // HTML-probe platforms (Schema.org JSON-LD) use the page URL as-is
      : platform.buildUrls(origin)
    for (const url of urls) {
      const result = platform.htmlProbe ? await probeUrlHtml(url) : await probeUrl(url)
      const probeData = platform.htmlProbe ? result : result.data
      attempts.push({
        platform: platform.platform, label: platform.label, url,
        ok: result.ok, status: result.status, reason: result.reason
      })

      if (result.ok && platform.validate(probeData)) {
        const vehicles = platform.extract(probeData)
        const sample = vehicles.slice(0, 3).map(platform.mapVehicle)
        return {
          success: true,
          platform: platform.platform,
          platform_label: platform.label,
          feed_url: url,
          vehicle_count: vehicles.length,
          sample_vehicles: sample,
          attempts,
        }
      }
    }
  }

  return {
    success: false,
    error: 'No known inventory feed found for this dealer URL. Try pasting the direct JSON feed URL instead.',
    attempts,
  }
}

// ── POST /feeds/probe ─────────────────────────────────────────────────────
// Body: { url: "https://somedealer.ca/vehicles/new/" }
// No auth required — safe because it only reads public URLs.
// Returns: platform name, resolved feed URL, vehicle count, 3-vehicle sample.
app.post('/feeds/probe', async (req, res) => {
  const { url } = req.body || {}
  if (!url) return res.status(400).json({ error: 'url is required' })

  try {
    const result = await detectFeedPlatform(url)
    res.json(result)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ── Updated normalizeFeedUrl: platform-aware ──────────────────────────────
// Used by POST /inventory-feeds when the user pastes a dealer URL.
// Returns { jsonUrl, detectedType } or null.
function normalizeFeedUrl(input) {
  if (!input) return null
  let url
  try { url = new URL(input.trim()) } catch { return null }

  const path = url.pathname.toLowerCase()

  // Detect inventory type from URL path
  let detectedType = null
  if (path.includes('new-inventory') || path.includes('/new/') || path.includes('/new?')) detectedType = 'new'
  else if (path.includes('used-inventory') || path.includes('/used/') || path.includes('/used?')) detectedType = 'used'
  else if (path.includes('demo-inventory') || path.includes('/demo/')) detectedType = 'demo'
  else if (path.includes('/fleet')) detectedType = 'fleet'

  // If it's already a .json URL, use it directly
  if (path.endsWith('.json')) return { jsonUrl: url.toString(), detectedType }

  const origin = url.origin
  const host = url.hostname.toLowerCase()

  // EDealer
  if (host.includes('edealer')) {
    return { jsonUrl: `${origin}/api/inventory/getall`, detectedType }
  }

  // Dealer Inspire (Cars.com)
  if (host.includes('dealerinspire') || host.includes('di-uploads')) {
    return { jsonUrl: `${origin}/wp-json/di-wp/v2/inventory`, detectedType }
  }

  // Dealer.com (Cox)
  if (host.includes('dealer.com')) {
    return { jsonUrl: `${origin}/apis/widget/INVENTORY_LISTING_DEFAULT_AUTO_ALL:inventory-data-bus1/getInventory`, detectedType }
  }

  // Sincro / DealerOn (Toyota/Lexus Canada)
  if (host.includes('sincro') || host.includes('dealeron')) {
    return { jsonUrl: `${origin}/api/inventory/vehicles`, detectedType }
  }

  // Vicimus
  if (host.includes('vicimus') || host.includes('glovebox')) {
    return { jsonUrl: `${origin}/api/inventory`, detectedType }
  }

  // SM360
  if (host.includes('sm360')) {
    return { jsonUrl: `${origin}/api/inventory/list`, detectedType }
  }

  // CDK
  if (host.includes('cdk') || host.includes('cobalt')) {
    return { jsonUrl: `${origin}/inventory/api/vehicles`, detectedType }
  }

  // DealerFire
  if (host.includes('dealerfire') || host.includes('solera')) {
    return { jsonUrl: `${origin}/ws/getData.php?type=inventory`, detectedType }
  }

  // LeadBox / default fallback (WordPress wp-content path)
  return { jsonUrl: `${origin}/wp-content/uploads/data/inventory.json`, detectedType }
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

  let totalAttempts = 0, totalSkipped = 0, totalVehiclesFound = 0
  const uniqueVins = new Set()        // distinct VINs we successfully upserted
  const allRawVins = new Set()        // EVERY VIN seen across all raw feed JSONs (no filter) — used for auto-mark-sold

  // Dedupe by URL — if the dealer has multiple feeds (new/used/demo) pointing at the same JSON,
  // we only need to fetch the JSON once and apply each filter against the cached vehicles list.
  const jsonCache = new Map()

  for (const feed of feeds) {
    try {
      let vehicles
      if (jsonCache.has(feed.feed_url)) {
        vehicles = jsonCache.get(feed.feed_url)
      } else {
        // Try JSON first; if the saved feed_url points at an HTML page (Schema.org case), fall back to JSON-LD extraction
        const feedRes = await fetch(`${feed.feed_url}?v=${Date.now()}`, {
          headers: { 'User-Agent': 'Mozilla/5.0 MarketSync-Sync/1.0' }
        })
        const ct = feedRes.headers.get('content-type') || ''
        if (ct.includes('json')) {
          const data = await feedRes.json()
          vehicles = data.vehicles || data.inventory || data.data || data.items || (Array.isArray(data) ? data : [])
        } else {
          // HTML response → extract Schema.org JSON-LD
          const html = await feedRes.text()
          const blocks = []
          const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
          let m
          while ((m = re.exec(html)) !== null) {
            try { blocks.push(JSON.parse(m[1])) } catch {}
          }
          const flat = []
          const walk = (n) => {
            if (!n) return
            if (Array.isArray(n)) { n.forEach(walk); return }
            if (Array.isArray(n['@graph'])) { n['@graph'].forEach(walk); return }
            flat.push(n)
          }
          blocks.forEach(walk)
          const cars = extractCarsFromJsonLd(flat)
          const origin = new URL(feed.feed_url).origin

          // BEST PATH: try the EDealer inventory sitemap — full inventory, no pagination limit.
          // This solves the "12 of 80 vehicles" problem on any EDealer site.
          const sitemapVehicles = await fetchEDealerInventoryFromSitemap(origin)
          if (sitemapVehicles && sitemapVehicles.length > cars.length) {
            console.log(`[sync] Using sitemap walker (${sitemapVehicles.length}) instead of listing JSON-LD (${cars.length})`)
            vehicles = sitemapVehicles
            jsonCache.set(feed.feed_url, vehicles)
            totalVehiclesFound += vehicles.length
            // Skip the listing-JSON-LD path entirely — sitemap data is complete
          } else {
          // FALLBACK: listing-page JSON-LD + per-detail-page photo enrichment
          // Two image sources, in order of quality:
          //   1. Detail pages (per-vehicle pages have 10-30 photos each — best)
          //   2. Listing-page HTML carousel (fallback when detail fetch fails)
          // We fetch detail pages concurrently in batches of 4 to avoid hammering the dealer.
          const detailUrls = extractEDealerDetailUrls(html, origin)
          let imageGroups = []
          if (detailUrls.length === cars.length && detailUrls.length > 0) {
            // Same count → detail anchors align 1:1 with JSON-LD cars by document order
            console.log(`[sync] Fetching ${detailUrls.length} detail pages for per-vehicle photos`)
            imageGroups = await fetchEDealerDetailImageGroups(detailUrls)
          } else {
            // Fallback: extract photo galleries from the listing HTML
            imageGroups = extractEDealerImageGroups(html)
          }
          // Normalize Schema.org Car shape into a flatter LeadBox-compatible object so the
          // rest of this loop can read it uniformly. Index into imageGroups by position.
          vehicles = cars.map((c, i) => ({
            vin: c.vehicleIdentificationNumber,
            year: c.vehicleModelDate,
            make: c.brand?.name || c.manufacturer?.name || c.brand,
            model: c.model,
            trim: (() => {
              const cfg = typeof c.vehicleConfiguration === 'string' ? c.vehicleConfiguration : ''
              const parts = cfg.split(' ')
              return parts.length > 1 ? parts.slice(0, -1).join(' ') : null
            })(),
            price: c.offers?.price,
            mileage: c.mileageFromOdometer?.value,
            exteriorcolor: c.color,
            interiorcolor: c.vehicleInteriorColor,
            transmission: c.vehicleTransmission,
            fueltype: c.vehicleEngine?.fuelType,
            bodystyle: c.bodyType,
            condition: (c.itemCondition || '').includes('NewCondition') ? 'New' :
                       (c.itemCondition || '').includes('UsedCondition') ? 'Used' : null,
            stocknumber: c.sku || c.productID,
            onweb: true,
            salepending: false,
            image_urls: (() => {
              // Prefer EDealer per-vehicle gallery extracted from HTML
              if (imageGroups[i]?.length) return imageGroups[i]
              // Fall back to JSON-LD image, filtering out the "coming soon" placeholder
              const img = Array.isArray(c.image) ? c.image[0] : c.image
              if (!img || (typeof img === 'string' && img.includes('coming.png'))) return []
              return [img]
            })(),
            // Detail page URL for "View on dealer site" links — falls back to listing page
            _detail_url: detailUrls[i] || feed.feed_url
          }))
          jsonCache.set(feed.feed_url, vehicles)
          totalVehiclesFound += vehicles.length
        }     // end fallback (no sitemap)
        }   // end else (sitemap didn't outperform listing JSON-LD)
      }   // end if (!jsonCache.has(feed.feed_url))

      // Capture every VIN from the raw feed — independent of feed_type filter — for auto-sold.
      // A vehicle still on the dealer's site should never get auto-marked sold, even if it
      // doesn't match the current feed's filter category.
      for (const v of vehicles) {
        if (v.vin) allRawVins.add(v.vin)
      }

      for (const v of vehicles) {
        if (!matchesFeedType(v, feed.feed_type)) { totalSkipped++; continue }
        if (v.onweb === false || v.nonvehicle) { totalSkipped++; continue }
        if (!v.vin) { totalSkipped++; continue }

        await sleep(200)
        // Prefer embedded image URLs; fall back to LeadBox-style photo lookup
        let imageUrls = Array.isArray(v.image_urls) && v.image_urls.length ? v.image_urls : []
        if (!imageUrls.length && v.stocknumber) {
          imageUrls = await fetchVehiclePhotos(v.stocknumber)
        }
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
          interior_color: v.interiorcolor || null,
          transmission: v.transmission || null,
          fuel_type: mapFuel(v.fueltype),
          description: buildDescription(v),
          image_urls: imageUrls,
          source_url: v._detail_url    // JSON-LD path (EDealer) — proper detail URL
            || (feed.feed_url.includes('/wp-content')
                  ? `${feed.feed_url.split('/wp-content')[0]}/inventory/${v.stocknumber || ''}`
                  : feed.feed_url),
          status: v.salepending ? 'pending' : 'available',
          last_synced_at: new Date().toISOString()
        }
        const { error } = await supabaseAdmin.from('inventory').upsert(record, { onConflict: 'vin' })
        if (error) {
          totalSkipped++
        } else {
          totalAttempts++
          if (v.vin) uniqueVins.add(v.vin)
        }
      }
    } catch (feedErr) {
      console.error(feedErr.message)
    }
  }

  if (allRawVins.size > 0) {
    const vinList = [...allRawVins]
    // 1. Mark as sold: anything available in DB whose VIN is NOT in any raw feed
    await supabaseAdmin.from('inventory')
      .update({ status: 'sold' })
      .eq('dealership_id', dealershipId)
      .eq('status', 'available')
      .not('vin', 'in', `(${vinList.map(v => `"${v}"`).join(',')})`)
    // 2. Restore: anything previously marked sold but now back in the feed → available
    //    (covers our wrongly-sold rows from the previous narrower-filter bug)
    await supabaseAdmin.from('inventory')
      .update({ status: 'available' })
      .eq('dealership_id', dealershipId)
      .eq('status', 'sold')
      .in('vin', vinList)
  }

  // Count current available inventory after sync so the dashboard sees the truth
  const { count: availableCount } = await supabaseAdmin
    .from('inventory')
    .select('id', { count: 'exact', head: true })
    .eq('dealership_id', dealershipId)
    .eq('status', 'available')

  return {
    success: true,
    total_in_feeds: totalVehiclesFound,
    unique_vehicles: uniqueVins.size,
    available_after_sync: availableCount || 0,
    attempts: totalAttempts,
    duplicates_merged: Math.max(0, totalAttempts - uniqueVins.size),
    skipped: totalSkipped,
    synced_at: new Date().toISOString()
  }
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
  // Admins manage team feeds; solo reps manage their personal dealership's feeds.
  const canManage = req.profile.role === 'DEALER_ADMIN'
    || req.profile.role === 'OWNER'
    || req.profile.dealerships?.is_personal === true
  if (!canManage) return res.status(403).json({ error: 'Only dealer admins or solo reps can manage feeds' })
  if (!req.dealershipId) return res.status(400).json({ error: 'No dealership associated with this account' })

  const { feed_url: rawUrl, feed_type: requestedType } = req.body || {}
  if (!rawUrl) return res.status(400).json({ error: 'feed_url is required' })

  // Pull inventory-type hint (new/used/demo) from the original URL path
  const typeHint = normalizeFeedUrl(rawUrl)
  if (!typeHint) return res.status(400).json({ error: 'Invalid URL' })

  let workingUrl = null
  let detectedPlatform = null
  let attempts = []

  // Only single-probe when the USER pasted a real .json URL.
  // For dealer landing pages (like /inventory/new/), always run the full multi-platform probe.
  const userPastedJson = (() => {
    try { return new URL(rawUrl.trim()).pathname.toLowerCase().endsWith('.json') }
    catch { return false }
  })()

  if (userPastedJson) {
    try {
      const r = await fetch(rawUrl)
      attempts.push({ url: rawUrl, status: r.status, ok: r.ok })
      if (r.ok) workingUrl = rawUrl
    } catch (e) {
      attempts.push({ url: rawUrl, error: e.message })
    }
  } else {
    // Public dealer URL — try every known platform via the central probe
    const detection = await detectFeedPlatform(rawUrl)
    attempts = detection.attempts || []
    if (detection.success) {
      workingUrl = detection.feed_url
      detectedPlatform = detection.platform_label
    }
  }

  if (!workingUrl) {
    return res.status(400).json({
      error: `Could not find a working inventory feed at this dealer site. We tried ${attempts.length} known platform paths. If your dealer uses a different system, paste the direct JSON feed URL instead.`,
      attempted: attempts.slice(0, 8).map(a => `${a.url} → ${a.status || a.error || 'no data'}`)
    })
  }

  const feedType = requestedType && requestedType !== 'all' ? requestedType : (typeHint.detectedType || 'all')

  const { data, error } = await supabaseAdmin
    .from('inventory_feeds')
    .insert({
      dealership_id: req.dealershipId,
      user_id: req.user.id,
      feed_url: workingUrl,
      feed_type: feedType
    })
    .select()
    .single()
  if (error) return res.status(500).json({ error: error.message })
  console.log(`✓ Added feed: ${detectedPlatform || 'direct'} → ${workingUrl}`)
  res.json({ ...data, platform: detectedPlatform })
})

app.delete('/inventory-feeds/:id', requireAuth, async (req, res) => {
  const canManage = req.profile.role === 'DEALER_ADMIN'
    || req.profile.role === 'OWNER'
    || req.profile.dealerships?.is_personal === true
  if (!canManage) return res.status(403).json({ error: 'Only dealer admins or solo reps can manage feeds' })
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

// ── 12. SCHEDULED INVENTORY SYNC (replaces external n8n cron) ──
// Iterates every dealership with at least one feed and runs the standard sync.
async function syncAllDealerships(triggerLabel = 'scheduled') {
  const startedAt = new Date().toISOString()
  console.log(`[sync-all:${triggerLabel}] started at ${startedAt}`)

  const { data: dealerships, error } = await supabaseAdmin
    .from('dealerships').select('id, name')
  if (error) {
    console.error(`[sync-all:${triggerLabel}] failed to list dealerships:`, error.message)
    return { success: false, error: error.message }
  }

  const results = []
  for (const d of dealerships || []) {
    try {
      const r = await runInventorySync(d.id)
      console.log(`[sync-all:${triggerLabel}] ${d.name} (${d.id}):`,
        r.success ? `${r.unique_vehicles} unique, ${r.skipped} skipped` : r.error)
      results.push({ dealership_id: d.id, ...r })
    } catch (e) {
      console.error(`[sync-all:${triggerLabel}] ${d.id} threw:`, e.message)
      results.push({ dealership_id: d.id, success: false, error: e.message })
    }
  }

  console.log(`[sync-all:${triggerLabel}] finished. ${results.length} dealership(s) processed.`)
  return { success: true, started_at: startedAt, finished_at: new Date().toISOString(), results }
}

// External-trigger endpoint (use this if you prefer Render Cron Jobs or cron-job.org)
app.post('/cron/sync-all', async (req, res) => {
  const secret = req.headers['x-cron-secret'] || req.query.secret
  if (secret !== process.env.SYNC_SECRET) return res.status(401).json({ error: 'Unauthorized' })
  const result = await syncAllDealerships('manual')
  res.json(result)
})

// In-process schedule — fires every SYNC_INTERVAL_HOURS (default 6) for as long as the service is up.
const SYNC_INTERVAL_HOURS = Number(process.env.SYNC_INTERVAL_HOURS || 6)
if (SYNC_INTERVAL_HOURS > 0) {
  // Initial run 60s after boot (lets the service settle), then every N hours
  setTimeout(() => syncAllDealerships('boot'), 60 * 1000)
  setInterval(() => syncAllDealerships('interval'), SYNC_INTERVAL_HOURS * 60 * 60 * 1000)
  console.log(`📅 Scheduled inventory sync every ${SYNC_INTERVAL_HOURS}h (set SYNC_INTERVAL_HOURS=0 to disable)`)
}

app.use((err, req, res, next) => {
  console.error('Unhandled Express error:', { path: req.path, method: req.method, message: err.message, stack: err.stack })
  if (res.headersSent) return next(err)
  res.status(500).json({ error: err.message, path: req.path, stack: err.stack })
})

app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Secure Marketplace engine live on port ${PORT}`))
