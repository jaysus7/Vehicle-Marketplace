import express from 'express'
import cors from 'cors'
import ws from 'ws'
import { createClient } from '@supabase/supabase-js'
import 'dotenv/config'

const app = express()
app.use(express.json())
app.use(express.urlencoded({ extended: true }))
app.use(cors({ origin: '*' }))

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { realtime: { transport: ws } }
)

async function requireAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '')
  if (!token) return res.status(401).json({ error: 'No token provided' })

  const { data: { user }, error } = await supabase.auth.getUser(token)
  
  console.log('Auth attempt:', { 
    tokenStart: token.slice(0, 20),
    user: user?.id, 
    error: error?.message 
  })

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
// Image proxy — serves images with CORS headers for drag/drop
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
app.listen(3000, () => console.log('API running on port 3000'))
app.get('/debug', requireAuth, async (req, res) => {
  res.json({
    user_id: req.user.id,
    profile: req.profile,
    dealership_id: req.profile?.dealership_id
  })
})
// Image proxy — serves dealer images with correct CORS headers for drag/drop
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