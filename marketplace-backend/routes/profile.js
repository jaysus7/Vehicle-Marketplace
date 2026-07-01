import { supabaseAdmin } from '../shared.js'
import { requireAuth } from '../middleware.js'
import { validatePassword, rateLimit } from '../security.js'

// ── OWNER-ONLY: NEWSLETTER SUBSCRIBER EXPORT ──
// Gated to a single owner email (you). Returns CSV-ready data of everyone who
// opted in to marketing emails during signup. Drop the file into Resend/Mailchimp/etc.
const OWNER_EMAIL = (process.env.OWNER_EMAIL || 'massiejay@gmail.com').toLowerCase()

export function registerRoutes(app) {
  app.get('/auth/me', requireAuth, async (req, res) => {
    res.json({
      id: req.user.id,
      email: req.user.email,
      full_name: req.profile.full_name,
      role: req.profile.role,
      dealership: req.profile.dealerships
    })
  })

  // ── 4. PROFILE ──
  app.put('/profile/update', requireAuth, rateLimit('profile-update', 10, 60 * 60 * 1000), async (req, res) => {
    const { fullName, email, password, dealershipName, websiteUrl } = req.body

    try {
      const authUpdates = {}
      if (email) authUpdates.email = email
      if (password) {
        // 2026 password policy applies to in-app password changes too
        const pwCheck = await validatePassword(password, { email: email || req.user.email })
        if (!pwCheck.ok) return res.status(400).json({ error: pwCheck.error })
        authUpdates.password = password
      }

      if (Object.keys(authUpdates).length > 0) {
        const { error: authError } = await supabaseAdmin.auth.admin.updateUserById(req.user.id, authUpdates)
        if (authError) throw authError
      }

      if (fullName) {
        const { error: profileError } = await supabaseAdmin
          .from('profiles')
          .update({ full_name: fullName })
          .eq('id', req.user.id)
        if (profileError) throw profileError
      }

      if (req.dealershipId && (dealershipName || websiteUrl)) {
        const dealerUpdates = {}
        if (dealershipName) dealerUpdates.name = dealershipName
        if (websiteUrl) dealerUpdates.website_url = websiteUrl

        const { error: dealerError } = await supabaseAdmin
          .from('dealerships')
          .update(dealerUpdates)
          .eq('id', req.dealershipId)
        if (dealerError) throw dealerError
      }

      res.json({ message: 'Workspace identity updated successfully' })
    } catch (err) {
      res.status(400).json({ error: err.message })
    }
  })

  // ── 5. TEAM MANAGEMENT ──
  app.get('/dealership/team', requireAuth, async (req, res) => {
    if (req.profile.role !== 'DEALER_ADMIN' && req.profile.role !== 'OWNER') {
      return res.status(403).json({ error: 'Admins only' })
    }
    if (!req.dealershipId) return res.json([])

    const { data: members, error } = await supabaseAdmin
      .from('profiles')
      .select('id, full_name, role, account_role, created_at')
      .eq('dealership_id', req.dealershipId)
      .order('created_at', { ascending: true })
    if (error) return res.status(500).json({ error: error.message })

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
        conversion_rate: (totalCount || 0) > 0
          ? Math.round(((soldCount || 0) / (totalCount || 0)) * 100)
          : 0,
        logins_30d: loginsCount || 0,
        created_at: m.created_at
      }
    }))

    res.json(enriched)
  })

  app.post('/admin/users/invite', requireAuth, async (req, res) => {
    if (req.profile.role !== 'DEALER_ADMIN' && req.profile.role !== 'OWNER') {
      return res.status(403).json({ error: 'Admins only' })
    }
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership associated with this admin account' })

    const { email, full_name, password } = req.body || {}
    if (!email || !full_name) return res.status(400).json({ error: 'email and full_name required' })

    // Either: admin set a real password (must meet 2026 policy), or we generate a
    // cryptographically-random 16-char temporary one. No more weak Math.random() temps.
    let tempPassword
    if (password) {
      const pwCheck = await validatePassword(password, { email })
      if (!pwCheck.ok) return res.status(400).json({ error: pwCheck.error })
      tempPassword = password
    } else {
      // 16 base64 chars from crypto.randomBytes — strong enough that the rep should
      // reset on first login. Always passes the policy.
      const { randomBytes } = await import('crypto')
      tempPassword = randomBytes(12).toString('base64').replace(/[+/=]/g, '') + 'Aa9!'
    }

    // Rep needs to verify their email like any other signup
    const { data: newUser, error: authError } = await supabaseAdmin.auth.admin.createUser({
      email,
      password: tempPassword,
      email_confirm: false
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
      temp_password: tempPassword,
      note: 'Rep must verify their email before they can log in. Share the temp password securely.'
    })
  })

  // ── SESSION ACTIVITY (recent logins + sign out other devices) ──
  // Returns last 20 login events for the current user so they can spot suspicious access.
  // Pairs with /me/sessions/revoke-others to sign all OTHER sessions out at once.
  app.get('/me/sessions', requireAuth, async (req, res) => {
    const { data, error } = await supabaseAdmin
      .from('logins')
      .select('id, created_at, ip, user_agent')
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false })
      .limit(20)
    if (error) return res.status(500).json({ error: error.message })

    const events = (data || []).map(row => {
      const ua = row.user_agent || ''
      let browser = 'Unknown browser'
      if (/Edg\//.test(ua)) browser = 'Edge'
      else if (/Chrome\//.test(ua) && !/Edg\//.test(ua)) browser = 'Chrome'
      else if (/Safari\//.test(ua) && !/Chrome\//.test(ua)) browser = 'Safari'
      else if (/Firefox\//.test(ua)) browser = 'Firefox'
      let os = 'Unknown OS'
      if (/Mac OS X/.test(ua)) os = 'macOS'
      else if (/Windows/.test(ua)) os = 'Windows'
      else if (/iPhone|iPad/.test(ua)) os = 'iOS'
      else if (/Android/.test(ua)) os = 'Android'
      else if (/Linux/.test(ua)) os = 'Linux'
      return { id: row.id, timestamp: row.created_at, ip: row.ip || null, browser, os }
    })
    res.json({ events })
  })

  // Revoke every refresh token except the current request's. The current access token
  // still works until its short-lived expiry (Supabase ~1h default), then forces a
  // re-login on every other device.
  app.post('/me/sessions/revoke-others', requireAuth, async (req, res) => {
    try {
      const { error } = await supabaseAdmin.auth.admin.signOut(req.user.id, 'others')
      if (error) {
        // Older Supabase clients don't accept the scope arg — fall back to revoking all
        const { error: fallbackErr } = await supabaseAdmin.auth.admin.signOut(req.user.id)
        if (fallbackErr) throw fallbackErr
        return res.json({ success: true, scope: 'all', message: 'All sessions signed out, including this one. Please log in again.' })
      }
      res.json({ success: true, scope: 'others', message: 'Other devices have been signed out.' })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  app.get('/owner/newsletter-subscribers', requireAuth, async (req, res) => {
    if ((req.user.email || '').toLowerCase() !== OWNER_EMAIL) {
      return res.status(403).json({ error: 'Owner-only endpoint' })
    }

    const { data: profiles, error } = await supabaseAdmin
      .from('profiles')
      .select('id, full_name, newsletter_consent_at, newsletter_consent_ip')
      .not('newsletter_consent_at', 'is', null)
      .order('newsletter_consent_at', { ascending: false })
    if (error) return res.status(500).json({ error: error.message })

    // Look up email from Supabase auth for each consented profile
    const enriched = await Promise.all((profiles || []).map(async (p) => {
      const { data: authUser } = await supabaseAdmin.auth.admin.getUserById(p.id).catch(() => ({ data: null }))
      return {
        email: authUser?.user?.email || null,
        full_name: p.full_name,
        consent_at: p.newsletter_consent_at,
        consent_ip: p.newsletter_consent_ip
      }
    }))
    const valid = enriched.filter(r => r.email)

    // Respect ?format=csv for direct paste into mail tools
    if ((req.query.format || '').toLowerCase() === 'csv') {
      const header = 'email,name,consent_at,consent_ip\n'
      const rows = valid.map(r =>
        `${r.email},${(r.full_name || '').replace(/,/g, ' ')},${r.consent_at},${r.consent_ip || ''}`
      ).join('\n')
      res.set('Content-Type', 'text/csv')
      res.set('Content-Disposition', 'attachment; filename="marketsync-newsletter.csv"')
      return res.send(header + rows)
    }
    res.json({ count: valid.length, subscribers: valid })
  })

  app.delete('/admin/users/:id', requireAuth, async (req, res) => {
    if (req.profile.role !== 'DEALER_ADMIN' && req.profile.role !== 'OWNER') {
      return res.status(403).json({ error: 'Admins only' })
    }
    if (req.params.id === req.user.id) return res.status(400).json({ error: 'Cannot remove yourself' })

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
}
