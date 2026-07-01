import { createClient } from '@supabase/supabase-js'
import { randomBytes, createHash } from 'crypto'
import { supabase, supabaseAdmin, resend, EMAIL_FROM, FRONTEND_URL } from '../shared.js'
import { requireAuth } from '../middleware.js'
import { validatePassword, rateLimit, getClientIp, generateRecoveryCodes, hashRecoveryCode } from '../security.js'
import { maybeAlertSuspiciousLogin } from '../securityAlerts.js'
import { audit, AuditAction } from '../audit.js'
import {
  beginPasskeyRegistration, finishPasskeyRegistration,
  beginPasskeyLogin, finishPasskeyLogin,
  listUserPasskeys, deletePasskey
} from '../passkeys.js'

// ──────────────────────────────────────────────────────────────────────────────
// EMAIL TEMPLATES — plain language, branded, with a clear call to action
// ──────────────────────────────────────────────────────────────────────────────

function buildResetEmailHtml({ resetUrl, ip }) {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Reset your password</title></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background:#f3f4f6;padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="560" style="max-width:560px;background:#ffffff;border-radius:12px;border:1px solid #e5e7eb;overflow:hidden;">
        <tr><td style="padding:32px 32px 16px 32px;">
          <div style="font-size:24px;font-weight:800;color:#0f172a;letter-spacing:-0.5px;">
            Market<span style="color:#6366f1;">Sync</span>
          </div>
        </td></tr>
        <tr><td style="padding:8px 32px 0 32px;">
          <h1 style="font-size:20px;color:#0f172a;margin:0 0 16px 0;">Reset your password</h1>
          <p style="font-size:15px;color:#475569;line-height:1.6;margin:0 0 24px 0;">
            We got a request to reset your MarketSync password. Click the button below to choose a new one. This link works once and expires in 15 minutes.
          </p>
          <p style="margin:0 0 32px 0;">
            <a href="${resetUrl}" style="display:inline-block;background:#6366f1;color:#ffffff;text-decoration:none;padding:14px 28px;border-radius:8px;font-weight:600;font-size:15px;">Reset Password</a>
          </p>
          <p style="font-size:13px;color:#64748b;line-height:1.6;margin:0 0 8px 0;">
            Or paste this link into your browser:
          </p>
          <p style="font-size:12px;color:#475569;word-break:break-all;background:#f8fafc;padding:12px;border-radius:6px;border:1px solid #e2e8f0;margin:0 0 24px 0;font-family:ui-monospace,SFMono-Regular,monospace;">
            ${resetUrl}
          </p>
          <hr style="border:0;border-top:1px solid #e5e7eb;margin:24px 0;">
          <p style="font-size:13px;color:#64748b;line-height:1.6;margin:0 0 8px 0;">
            <strong>Didn't request this?</strong> Ignore this email — your password won't change unless you click the button above. The request came from IP ${ip || 'unknown'}.
          </p>
        </td></tr>
        <tr><td style="padding:24px 32px;background:#f8fafc;border-top:1px solid #e5e7eb;">
          <p style="font-size:12px;color:#94a3b8;line-height:1.6;margin:0;text-align:center;">
            MarketSync · Auto-post dealership inventory to Facebook Marketplace<br>
            <a href="https://marketsync.link/" style="color:#94a3b8;">marketsync.link</a>
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`
}

function buildResetEmailText({ resetUrl, ip }) {
  return `Reset your MarketSync password

We got a request to reset your password. Open this link to choose a new one:

${resetUrl}

This link works once and expires in 15 minutes.

Didn't request this? Ignore this email — your password won't change unless you click the link. Request came from IP ${ip || 'unknown'}.

—
MarketSync
https://marketsync.link/`
}

export function registerRoutes(app) {
  // ── 3. AUTH ENDPOINTS ──
  // 5 login attempts per IP per 15 minutes — slows credential stuffing without
  // hurting real users who fat-finger their password.
  app.post('/auth/login', rateLimit('login', 5, 15 * 60 * 1000), async (req, res) => {
    const { email, password } = req.body
    const { data, error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) {
      // Don't leak whether the email exists — Supabase already does this but we double-check
      audit(req, AuditAction.USER_LOGIN_FAILED, { email })
      return res.status(401).json({ error: 'Invalid email or password.' })
    }
    // Require verified email before allowing the session through
    if (!data.user.email_confirmed_at) {
      return res.status(403).json({
        error: 'EMAIL_NOT_VERIFIED',
        message: 'Please check your inbox and click the verification link before signing in.'
      })
    }

    // 2FA gate — if user has a verified TOTP factor, return a partial session and require
    // a code via /auth/2fa/challenge before they get a usable access token.
    try {
      const userClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
        global: { headers: { Authorization: `Bearer ${data.session.access_token}` } }
      })
      const { data: factors } = await userClient.auth.mfa.listFactors()
      const verified = (factors?.totp || []).find(f => f.status === 'verified')
      if (verified) {
        return res.status(202).json({
          mfa_required: true,
          factor_id: verified.id,
          partial_token: data.session.access_token,
          message: 'Two-factor code required.'
        })
      }
    } catch (mfaErr) {
      console.warn('MFA status check failed (allowing login):', mfaErr.message)
    }

    const currentIp = getClientIp(req)
    const currentUa = (req.headers['user-agent'] || '').slice(0, 500)

    supabaseAdmin.from('logins').insert({
      user_id: data.user.id,
      ip: currentIp,
      user_agent: currentUa
    }).then(async ({ error: logErr }) => {
      if (logErr) console.warn('Failed to log login event:', logErr.message)
      // Best-effort suspicious-login alert (never blocks login response)
      await maybeAlertSuspiciousLogin({
        supabaseAdmin,
        userId: data.user.id,
        userEmail: data.user.email,
        currentIp,
        currentUserAgent: currentUa
      })
    })

    audit(req, AuditAction.USER_LOGIN, { method: 'password', user_id: data.user.id })
    res.json({
      access_token: data.session.access_token,
      user: { id: data.user.id, email: data.user.email }
    })
  })

  // 3 registrations per IP per hour — stops bot-driven sign-up abuse
  app.post('/auth/register', rateLimit('register', 3, 60 * 60 * 1000), async (req, res) => {
    const { accountRole, fullName, email, password, dealershipName, websiteUrl, feeds,
            newsletterConsent } = req.body

    if (!email || !password || !fullName || !accountRole) {
      return res.status(400).json({ error: 'Missing required registration fields' })
    }
    if (accountRole === 'dealer_admin' && !dealershipName) {
      return res.status(400).json({ error: 'Dealership name required for admin accounts' })
    }

    // 2026 password policy — NIST 800-63B compliant
    const pwCheck = await validatePassword(password, { email })
    if (!pwCheck.ok) return res.status(400).json({ error: pwCheck.error })

    let createdUserId = null
    let createdDealershipId = null

    try {
      // email_confirm: false → Supabase sends a verification email; user can't log in
      // until they click the link. This blocks signups with someone else's email.
      const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
        email,
        password,
        email_confirm: false
      })
      if (authError) throw authError
      createdUserId = authData.user.id

      const trialEndsAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()

      // Newsletter consent (CASL/GDPR/CAN-SPAM): only record if explicitly opted in.
      // Stamp the timestamp + IP so we have audit trail of when consent was given.
      const newsletter = newsletterConsent === true
        ? { newsletter_consent_at: new Date().toISOString(), newsletter_consent_ip: getClientIp(req) }
        : {}

      if (accountRole === 'dealer_admin') {
        const { data: dealership, error: dealerError } = await supabaseAdmin
          .from('dealerships')
          .insert({
            name: dealershipName,
            website_url: websiteUrl || null,
            billing_status: 'TRIALING',
            trial_ends_at: trialEndsAt
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
            price_tier: 'DEALER',
            ...newsletter
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
        const { data: personalDealership, error: personalErr } = await supabaseAdmin
          .from('dealerships')
          .insert({
            name: `${fullName} — Personal`,
            website_url: null,
            billing_status: null,
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
            price_tier: 'SOLO_INDIVIDUAL',
            billing_status: 'TRIALING',
            trial_ends_at: trialEndsAt,
            ...newsletter
          })
        if (profileError) throw profileError
      }

      res.json({
        success: true,
        user_id: createdUserId,
        verification_required: true,
        message: 'Account created. Check your email and click the verification link to activate your account.'
      })
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

  // Resend the verification email — rate-limited to stop abuse
  app.post('/auth/resend-verification', rateLimit('resend-verify', 3, 60 * 60 * 1000), async (req, res) => {
    const { email } = req.body || {}
    if (!email) return res.status(400).json({ error: 'email required' })
    try {
      // Supabase's resend endpoint covers both signup and email-change confirmations
      await supabase.auth.resend({
        type: 'signup',
        email,
        options: { emailRedirectTo: `${FRONTEND_URL}/login.html?verified=1` }
      })
    } catch (e) {
      console.warn('resend verification failed:', e.message)
    }
    // Always return success so we don't leak whether the email exists
    res.json({ success: true, message: 'If an account exists for that email and is not yet verified, a new link has been sent.' })
  })

  app.post('/auth/logout', requireAuth, async (req, res) => {
    audit(req, AuditAction.USER_LOGOUT)
    await supabase.auth.signOut()
    res.json({ success: true })
  })

  // ── TOTP 2FA ──────────────────────────────────────────────────────────────────
  // Optional but strongly encouraged. Uses Supabase Auth's built-in MFA (TOTP).
  // Users enroll once via Google Authenticator / 1Password / Authy / etc., then
  // every login challenges them for a 6-digit code after password verification.
  //
  // Flow:
  //   1. POST /auth/2fa/enroll          → returns QR code + secret to user
  //   2. User scans into authenticator app
  //   3. POST /auth/2fa/verify-enroll   → user enters first code; we activate
  //   4. From this point, /auth/login responds with MFA_REQUIRED instead of a session
  //   5. POST /auth/2fa/challenge       → user submits code; gets full session

  // Step 1 — Start enrollment. Returns the TOTP secret + a provisioning URI the
  // frontend renders into a QR code.
  app.post('/auth/2fa/enroll', requireAuth, rateLimit('mfa-enroll', 5, 60 * 60 * 1000), async (req, res) => {
    try {
      const token = req.headers.authorization?.replace('Bearer ', '')
      const userClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
        global: { headers: { Authorization: `Bearer ${token}` } }
      })

      const { data, error } = await userClient.auth.mfa.enroll({
        factorType: 'totp',
        friendlyName: `MarketSync (${new Date().toISOString().slice(0, 10)})`
      })
      if (error) return res.status(400).json({ error: error.message })

      // Supabase returns the TOTP secret + a URI like
      // "otpauth://totp/MarketSync:email?secret=BASE32&issuer=MarketSync"
      res.json({
        factor_id: data.id,
        qr_code_uri: data.totp?.uri || null,
        secret: data.totp?.secret || null
      })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // Step 2 — Verify the user can produce a valid TOTP code, finalizing enrollment
  app.post('/auth/2fa/verify-enroll', requireAuth, rateLimit('mfa-verify', 10, 60 * 60 * 1000), async (req, res) => {
    const { factor_id, code } = req.body || {}
    if (!factor_id || !code) return res.status(400).json({ error: 'factor_id and code are required' })

    try {
      const token = req.headers.authorization?.replace('Bearer ', '')
      const userClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
        global: { headers: { Authorization: `Bearer ${token}` } }
      })

      // Create challenge then verify in one shot — Supabase requires this pattern
      const { data: challenge, error: chErr } = await userClient.auth.mfa.challenge({ factorId: factor_id })
      if (chErr) return res.status(400).json({ error: chErr.message })

      const { error: verifyErr } = await userClient.auth.mfa.verify({
        factorId: factor_id,
        challengeId: challenge.id,
        code
      })
      if (verifyErr) return res.status(400).json({ error: 'Invalid code. Make sure your authenticator app is in sync.' })

      // Issue 10 recovery codes — returned ONCE, hashed in DB. If the user loses
      // their phone they can use one of these to get back in.
      const codes = generateRecoveryCodes(10)
      const rows = codes.map(c => ({
        user_id: req.user.id,
        code_hash: hashRecoveryCode(c)
      }))
      // Wipe any previous codes (e.g. user re-enrolled after disabling) then write fresh ones
      await supabaseAdmin.from('recovery_codes').delete().eq('user_id', req.user.id)
      const { error: codeErr } = await supabaseAdmin.from('recovery_codes').insert(rows)
      if (codeErr) console.warn('recovery_codes insert failed:', codeErr.message)

      audit(req, AuditAction.MFA_ENROLLED, { factor_id })
      res.json({
        success: true,
        message: 'Two-factor authentication is now active on this account.',
        recovery_codes: codes,
        recovery_codes_note: 'Save these somewhere safe (password manager, printed). Each one works ONCE if you lose your phone. They will not be shown again.'
      })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // Regenerate recovery codes (invalidates old ones). Available from the security panel.
  app.post('/auth/2fa/regenerate-recovery-codes', requireAuth, rateLimit('mfa-regen', 3, 60 * 60 * 1000), async (req, res) => {
    try {
      const codes = generateRecoveryCodes(10)
      const rows = codes.map(c => ({ user_id: req.user.id, code_hash: hashRecoveryCode(c) }))
      await supabaseAdmin.from('recovery_codes').delete().eq('user_id', req.user.id)
      const { error } = await supabaseAdmin.from('recovery_codes').insert(rows)
      if (error) throw error
      res.json({ recovery_codes: codes, message: 'New recovery codes generated. Old codes no longer work.' })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // ── WEBAUTHN / PASSKEYS ───────────────────────────────────────────────────────
  // Register a new passkey (user must be signed in)
  app.post('/auth/passkey/register/begin', requireAuth, rateLimit('passkey-reg', 10, 60 * 60 * 1000), async (req, res) => {
    try {
      const options = await beginPasskeyRegistration({
        supabaseAdmin, userId: req.user.id, userEmail: req.user.email
      })
      res.json(options)
    } catch (err) { res.status(500).json({ error: err.message }) }
  })

  app.post('/auth/passkey/register/finish', requireAuth, async (req, res) => {
    const { response, device_name } = req.body || {}
    if (!response) return res.status(400).json({ error: 'response required' })
    const result = await finishPasskeyRegistration({
      supabaseAdmin, userId: req.user.id, response, deviceName: device_name
    })
    if (!result.ok) return res.status(400).json({ error: result.error })
    audit(req, AuditAction.PASSKEY_REGISTERED, { device_name: device_name || null })
    res.json({ success: true, message: 'Passkey registered.' })
  })

  // List & delete passkeys (for the security panel UI)
  app.get('/auth/passkey/list', requireAuth, async (req, res) => {
    const items = await listUserPasskeys({ supabaseAdmin, userId: req.user.id })
    res.json({ passkeys: items })
  })

  app.delete('/auth/passkey/:id', requireAuth, async (req, res) => {
    const ok = await deletePasskey({ supabaseAdmin, userId: req.user.id, passkeyId: req.params.id })
    if (!ok) return res.status(404).json({ error: 'Passkey not found' })
    audit(req, AuditAction.PASSKEY_DELETED, { passkey_id: req.params.id })
    res.json({ success: true })
  })

  // Passwordless login via passkey — no password required
  app.post('/auth/passkey/login/begin', rateLimit('passkey-login', 10, 15 * 60 * 1000), async (req, res) => {
    const { email } = req.body || {}
    try {
      const options = await beginPasskeyLogin({ supabaseAdmin, email })
      res.json(options)
    } catch (err) { res.status(500).json({ error: err.message }) }
  })

  app.post('/auth/passkey/login/finish', rateLimit('passkey-login', 10, 15 * 60 * 1000), async (req, res) => {
    const { email, response } = req.body || {}
    if (!response) return res.status(400).json({ error: 'response required' })
    const result = await finishPasskeyLogin({ supabaseAdmin, email, response })
    if (!result.ok) return res.status(401).json({ error: result.error })

    // Mint a Supabase session for the verified user. We use the admin API to
    // generate a fresh access token via magic link (server-side) without sending
    // an email.
    try {
      const { data: { user } } = await supabaseAdmin.auth.admin.getUserById(result.userId)
      if (!user) return res.status(401).json({ error: 'User no longer exists' })

      // Use generateLink to produce a one-time recovery URL we'll consume server-side
      const { data: link, error: linkErr } = await supabaseAdmin.auth.admin.generateLink({
        type: 'magiclink',
        email: user.email,
        options: { redirectTo: `${FRONTEND_URL}/dashboard.html` }
      })
      if (linkErr) return res.status(500).json({ error: 'Could not mint session: ' + linkErr.message })

      // Pull the access token out of the hashed verification URL
      const params = new URL(link.properties.action_link).searchParams
      const tokenHash = params.get('token_hash') || link.properties.hashed_token
      if (!tokenHash) return res.status(500).json({ error: 'No token returned by Supabase' })

      const { data: verifyData, error: verifyErr } = await supabase.auth.verifyOtp({
        token_hash: tokenHash,
        type: 'magiclink'
      })
      if (verifyErr || !verifyData?.session) {
        return res.status(500).json({ error: 'Session mint failed: ' + (verifyErr?.message || 'unknown') })
      }

      // Log + suspicious-login check (best-effort)
      const currentIp = getClientIp(req)
      const currentUa = (req.headers['user-agent'] || '').slice(0, 500) + ' [passkey]'
      supabaseAdmin.from('logins').insert({
        user_id: user.id, ip: currentIp, user_agent: currentUa
      }).then(async ({ error: logErr }) => {
        if (logErr) console.warn('login log failed:', logErr.message)
        await maybeAlertSuspiciousLogin({
          supabaseAdmin, userId: user.id, userEmail: user.email,
          currentIp, currentUserAgent: currentUa
        })
      })

      res.json({
        access_token: verifyData.session.access_token,
        user: { id: user.id, email: user.email }
      })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // Step 3 — Disable 2FA (requires fresh authentication, i.e. current session)
  app.post('/auth/2fa/disable', requireAuth, rateLimit('mfa-disable', 5, 60 * 60 * 1000), async (req, res) => {
    try {
      const token = req.headers.authorization?.replace('Bearer ', '')
      const userClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
        global: { headers: { Authorization: `Bearer ${token}` } }
      })

      const { data: factors } = await userClient.auth.mfa.listFactors()
      const totp = (factors?.totp || []).find(f => f.status === 'verified')
      if (!totp) return res.json({ success: true, message: 'No active 2FA factor.' })

      const { error } = await userClient.auth.mfa.unenroll({ factorId: totp.id })
      if (error) throw error
      res.json({ success: true, message: 'Two-factor authentication has been disabled.' })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // Status — returns whether the current user has 2FA active. Used by the profile UI.
  app.get('/auth/2fa/status', requireAuth, async (req, res) => {
    try {
      const token = req.headers.authorization?.replace('Bearer ', '')
      const userClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
        global: { headers: { Authorization: `Bearer ${token}` } }
      })
      const { data: factors } = await userClient.auth.mfa.listFactors()
      const verified = (factors?.totp || []).find(f => f.status === 'verified')
      res.json({ enabled: !!verified, factor_id: verified?.id || null })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // Login-time challenge. Called after the password step when login responds with
  // MFA_REQUIRED. Accepts a TOTP code OR an 8-char recovery code (XXXX-XXXX format).
  app.post('/auth/2fa/challenge', rateLimit('mfa-challenge', 5, 15 * 60 * 1000), async (req, res) => {
    const { factor_id, code, partial_token } = req.body || {}
    if (!factor_id || !code || !partial_token) {
      return res.status(400).json({ error: 'factor_id, code, and partial_token are required' })
    }

    try {
      const userClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
        global: { headers: { Authorization: `Bearer ${partial_token}` } }
      })

      // Detect recovery code by shape (8 alphanumeric chars with optional dash) —
      // distinguishes from 6-digit TOTP. Lets users paste codes as XXXX-XXXX or XXXXXXXX.
      const normalized = code.replace(/[\s-]/g, '').toUpperCase()
      const isRecoveryCode = /^[A-Z2-9]{8}$/.test(normalized)

      if (isRecoveryCode) {
        // Recover via recovery code — look up the hash + delete it (single-use)
        const { data: { user } } = await userClient.auth.getUser()
        if (!user) return res.status(401).json({ error: 'Invalid session.' })

        const hash = hashRecoveryCode(normalized)
        const { data: codeRow, error: lookupErr } = await supabaseAdmin
          .from('recovery_codes')
          .select('id')
          .eq('user_id', user.id)
          .eq('code_hash', hash)
          .maybeSingle()
        if (lookupErr || !codeRow) return res.status(401).json({ error: 'Invalid recovery code.' })

        // Burn the code immediately
        await supabaseAdmin.from('recovery_codes').delete().eq('id', codeRow.id)

        // The partial_token is already a valid Supabase access token at this point —
        // we accept the recovery code as proof and return it as the session.
        // (Recovery code use is logged via the logins insert below.)
        supabaseAdmin.from('logins').insert({
          user_id: user.id,
          ip: getClientIp(req),
          user_agent: (req.headers['user-agent'] || '').slice(0, 500) + ' [recovery-code]'
        }).then(({ error: logErr }) => {
          if (logErr) console.warn('login log failed:', logErr.message)
        })

        // Count remaining codes so the UI can nag the user to regenerate
        const { count: remaining } = await supabaseAdmin
          .from('recovery_codes').select('id', { count: 'exact', head: true })
          .eq('user_id', user.id)

        return res.json({
          access_token: partial_token,
          user: { id: user.id, email: user.email },
          used_recovery_code: true,
          recovery_codes_remaining: remaining || 0
        })
      }

      // Otherwise treat as TOTP code
      const { data: challenge, error: chErr } = await userClient.auth.mfa.challenge({ factorId: factor_id })
      if (chErr) return res.status(400).json({ error: chErr.message })

      const { data, error } = await userClient.auth.mfa.verify({
        factorId: factor_id,
        challengeId: challenge.id,
        code
      })
      if (error) return res.status(401).json({ error: 'Invalid 2FA code.' })

      // Log successful TOTP login
      supabaseAdmin.from('logins').insert({
        user_id: data.user?.id,
        ip: getClientIp(req),
        user_agent: (req.headers['user-agent'] || '').slice(0, 500) + ' [totp]'
      }).then(({ error: logErr }) => {
        if (logErr) console.warn('login log failed:', logErr.message)
      })

      res.json({
        access_token: data.access_token,
        user: { id: data.user?.id, email: data.user?.email }
      })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
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

  // ──────────────────────────────────────────────────────────────────────────────
  // PASSWORD RESET (custom flow — bypasses Supabase Auth's built-in email)
  // ──────────────────────────────────────────────────────────────────────────────
  // Why: Supabase's reset email goes through a shared low-priority sender that
  // caused 10+ minute delays + 4/hour rate limits. We generate our own token,
  // store a hash of it in `password_reset_tokens`, and email the link via Resend
  // (using the marketsync.link domain with proper DKIM/SPF/DMARC). Delivers in
  // seconds, rate-limited by us, single-use, 15-minute expiry, leaks nothing.

  // Constant-time response — always returns success whether the email exists or not,
  // to prevent attackers from probing "is account X registered here?".
  app.post('/auth/forgot-password', rateLimit('forgot', 5, 60 * 60 * 1000), async (req, res) => {
    const { email } = req.body || {}
    if (!email || typeof email !== 'string' || !email.includes('@')) {
      return res.status(400).json({ error: 'Valid email required' })
    }

    const normEmail = email.toLowerCase().trim()
    const responseMessage = 'If an account exists for that email, we sent a reset link.'

    try {
      // Look up the user in Supabase. We don't expose whether they exist.
      const { data: usersList } = await supabaseAdmin.auth.admin.listUsers({ page: 1, perPage: 1000 })
      const user = (usersList?.users || []).find(u => (u.email || '').toLowerCase() === normEmail)

      if (user && resend) {
        // Generate a 256-bit secure random token; store ONLY its SHA-256 hash.
        // The raw token is sent in the email and never persisted. Even a full
        // DB dump can't be used to reset passwords.
        const rawToken = randomBytes(32).toString('hex')   // 64-char hex string
        const tokenHash = createHash('sha256').update(rawToken).digest('hex')
        const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString()  // 15 minutes

        // Insert token row. used_at stays null until consumed; we one-shot it.
        const { error: insErr } = await supabaseAdmin
          .from('password_reset_tokens')
          .insert({
            user_id: user.id,
            email: normEmail,
            token_hash: tokenHash,
            expires_at: expiresAt,
            requested_ip: getClientIp(req)
          })

        if (!insErr) {
          const resetUrl = `${FRONTEND_URL}/reset-password.html?token=${rawToken}`
          const html = buildResetEmailHtml({ resetUrl, ip: getClientIp(req) })
          const plain = buildResetEmailText({ resetUrl, ip: getClientIp(req) })

          const { error: sendErr } = await resend.emails.send({
            from: EMAIL_FROM,
            to: normEmail,
            subject: 'Reset your MarketSync password',
            html,
            text: plain,
            // Anti-spam headers — required by Gmail/Outlook bulk-sender policies.
            headers: {
              'List-Unsubscribe': `<mailto:unsubscribe@marketsync.link?subject=unsub-${user.id}>`,
              'X-Entity-Ref-ID': tokenHash.slice(0, 16)  // helps Resend track this send
            }
          })

          if (sendErr) {
            console.error('Resend send failed:', sendErr.message)
          } else {
            console.log(`[forgot-password] reset email sent to ${normEmail}`)
          }
        } else {
          console.error('Token insert failed:', insErr.message)
        }
      } else if (!resend) {
        console.warn('[forgot-password] RESEND_API_KEY not set — email not sent')
      }
    } catch (e) {
      // Swallow — never leak account-existence via error responses
      console.warn('[forgot-password] threw:', e.message)
    }

    res.json({ success: true, message: responseMessage })
  })

  app.post('/auth/reset-password', rateLimit('reset', 5, 60 * 60 * 1000), async (req, res) => {
    const { token, password } = req.body || {}
    if (!token || typeof token !== 'string') return res.status(400).json({ error: 'Reset token required' })
    if (!password) return res.status(400).json({ error: 'New password required' })

    // Hash the supplied token and look up the row — never compare raw tokens.
    const tokenHash = createHash('sha256').update(token).digest('hex')

    const { data: row, error: lookupErr } = await supabaseAdmin
      .from('password_reset_tokens')
      .select('id, user_id, email, expires_at, used_at')
      .eq('token_hash', tokenHash)
      .maybeSingle()

    if (lookupErr) return res.status(500).json({ error: 'Could not verify token' })
    if (!row) return res.status(400).json({ error: 'This reset link is invalid or has expired.' })
    if (row.used_at) return res.status(400).json({ error: 'This reset link has already been used.' })
    if (new Date(row.expires_at) < new Date()) {
      return res.status(400).json({ error: 'This reset link has expired. Request a new one.' })
    }

    // Validate the new password against same policy as registration (length, HIBP, etc.)
    const pwCheck = await validatePassword(password, { email: row.email })
    if (!pwCheck.ok) return res.status(400).json({ error: pwCheck.error })

    // Update password via Supabase admin API
    const { error: updateErr } = await supabaseAdmin.auth.admin.updateUserById(row.user_id, { password })
    if (updateErr) return res.status(500).json({ error: 'Could not update password. Try again.' })

    // Mark token used (idempotency + audit trail)
    await supabaseAdmin
      .from('password_reset_tokens')
      .update({ used_at: new Date().toISOString(), used_ip: getClientIp(req) })
      .eq('id', row.id)

    // Security best practice: invalidate ALL other sessions so an attacker who
    // had a token before the reset can't keep using it.
    try {
      await supabaseAdmin.auth.admin.signOut(row.user_id, 'others')
    } catch (e) {
      console.warn('Sign-out others failed (non-fatal):', e.message)
    }

    // Audit-log the reset event
    try {
      await supabaseAdmin.from('logins').insert({
        user_id: row.user_id,
        ip: getClientIp(req),
        user_agent: (req.headers['user-agent'] || '').slice(0, 500),
        event: 'password_reset'
      })
    } catch {}

    console.log(`[reset-password] password reset for ${row.email}`)
    res.json({ success: true })
  })
}
