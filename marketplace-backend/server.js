import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import ws from 'ws'
import Stripe from 'stripe'
import { createClient } from '@supabase/supabase-js'
import { renderAndCaptureInventory, genericMapVehicle, harvestVehicleUrls,
         inferUrlTemplate, renderUrlTemplate, fetchUrlsViaBrowser, fetchViaBrowser } from './puppeteerRenderer.js'
import { validatePassword, rateLimit, securityHeaders, corsOriginCheck, getClientIp,
         generateRecoveryCodes, hashRecoveryCode } from './security.js'
import { maybeAlertSuspiciousLogin } from './securityAlerts.js'
import { runDripCampaign, verifyUnsubToken } from './drip.js'
import {
  beginPasskeyRegistration, finishPasskeyRegistration,
  beginPasskeyLogin, finishPasskeyLogin,
  listUserPasskeys, deletePasskey
} from './passkeys.js'
import { randomBytes, createHash } from 'crypto'
import { Resend } from 'resend'

// Resend SMTP — we send transactional email (password resets etc.) directly
// from this backend instead of going through Supabase Auth. Lower latency,
// better deliverability, no shared-tenant rate limits.
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null
const EMAIL_FROM = process.env.EMAIL_FROM || 'MarketSync <noreply@marketsync.link>'

// Public frontend host used for password reset links, email verification, Stripe
// redirects, etc. This MUST be the static-site domain (marketsync.link) — NOT this
// backend's own URL.
//
// We intentionally do NOT fall back to API_URL anymore: on Render, API_URL holds
// the backend's own *.onrender.com URL, so using it produced reset links that
// pointed at this Express server — which doesn't serve the static HTML. That's
// what caused "Cannot GET /reset-password.html" and Chrome's "Dangerous site"
// warning (a password page + token on a generic *.onrender.com host trips Safe
// Browsing). Set FRONTEND_URL=https://marketsync.link on Render.
const CANONICAL_FRONTEND = 'https://marketsync.link'
const FRONTEND_URL = (process.env.FRONTEND_URL || CANONICAL_FRONTEND)
  .replace(/\/$/, '')  // strip trailing slash to avoid `//path` URLs

// Chrome Web Store listing — linked from the onboarding drip ("get the extension").
const EXTENSION_URL = process.env.CHROME_EXTENSION_URL ||
  'https://chromewebstore.google.com/detail/marketsync/mfoaodaoipaalloccolophjhblgikada'

// This backend's own public URL — used for the drip unsubscribe link, which is
// served by routes on THIS server (the static frontend has no such route).
const BACKEND_URL = (process.env.API_URL || process.env.RENDER_EXTERNAL_URL ||
  'https://vehicle-marketplace-s0e4.onrender.com').replace(/\/$/, '')

const missingEnvVars = [];
if (!process.env.SUPABASE_URL) missingEnvVars.push('SUPABASE_URL');
if (!process.env.SUPABASE_ANON_KEY) missingEnvVars.push('SUPABASE_ANON_KEY');
if (!process.env.SUPABASE_SERVICE_ROLE_KEY) missingEnvVars.push('SUPABASE_SERVICE_ROLE_KEY');

if (missingEnvVars.length > 0) {
  console.error('❌ CRITICAL CONFIGURATION ERROR: Missing Render Environment Keys:');
  console.error(JSON.stringify(missingEnvVars, null, 2));
  process.exit(1);
}

// Realistic browser headers. Many dealer sites (Performance Auto Group, etc.) sit
// behind Cloudflare / WAF rules that 403 any request whose User-Agent isn't a real
// browser. Sending a full Chrome header set clears the common "Bot Fight Mode" and
// managed-challenge rules that only inspect headers. Sites running a full JS
// challenge still need the Puppeteer fallback (fetchViaBrowser / fetchUrlsViaBrowser).
const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Sec-Ch-Ua': '"Chromium";v="131", "Not_A Brand";v="24", "Google Chrome";v="131"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"macOS"',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Upgrade-Insecure-Requests': '1'
}

// fetch() wrapper that sends browser-like headers plus a same-origin Referer/Origin.
// Caller headers in init.headers win (e.g. JSON Accept / Sec-Fetch overrides).
function browserFetch(url, init = {}) {
  let extra = {}
  try {
    const origin = new URL(url).origin
    extra = { Referer: origin + '/', Origin: origin }
  } catch {}
  return fetch(url, {
    ...init,
    headers: { ...BROWSER_HEADERS, ...extra, ...(init.headers || {}) }
  })
}

const app = express()
const PORT = process.env.PORT || 10000
const sleep = ms => new Promise(r => setTimeout(r, ms))
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY)

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, { realtime: { transport: ws } })
const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { realtime: { transport: ws } })

// Trust Render's proxy so req.ip / X-Forwarded-For resolve correctly for rate limits
app.set('trust proxy', 1)

// Security headers on every response (HSTS, X-Frame-Options, etc.)
app.use(securityHeaders)

// CORS — allowlist only. See security.js for the full list (marketsync.link,
// chrome-extension://*, plus localhost in non-production).
app.use(cors({ origin: corsOriginCheck, credentials: true }))

// Safety net: this is the API backend and does NOT serve the static frontend
// (login.html, reset-password.html, dashboard.html, …). If any link ever points
// here by mistake — e.g. a stale/misconfigured FRONTEND_URL — bounce *.html GETs
// to the canonical frontend, preserving the query string, so password-reset and
// verification links keep working instead of returning "Cannot GET". Redirecting
// to CANONICAL_FRONTEND (a different host than this backend) means no loop.
app.get(/\.html$/, (req, res) => {
  res.redirect(302, `${CANONICAL_FRONTEND}${req.originalUrl}`)
})

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
      const meta = session.metadata || {}
      const billing = {
        stripe_customer_id: session.customer,
        subscription_id: session.subscription,
        stripe_price_id: sub.items.data[0].price.id,
        billing_status: 'ACTIVE',
        trial_ends_at: null
      }
      if (meta.type === 'solo_rep' && meta.user_id) {
        await supabaseAdmin.from('profiles').update(billing).eq('id', meta.user_id)
      } else {
        await supabaseAdmin.from('dealerships').update(billing).eq('id', meta.dealership_id || session.client_reference_id)
      }
      break;
    }
    case 'customer.subscription.deleted': {
      const subId = event.data.object.id
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

// Raise the body limit well above Express's 100KB default: the extension's
// dealer-capture POST sends the full inventory (vehicles + image_url arrays +
// descriptions) in one request, which for a few hundred vehicles is several MB.
// 100KB was causing "request entity too large" (HTTP 413) on capture uploads.
app.use(express.json({ limit: '25mb' }))
app.use(express.urlencoded({ extended: true, limit: '25mb' }))

// ── 2. AUTH MIDDLEWARE ──
async function requireAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '')
  if (!token) return res.status(401).json({ error: 'No token provided' })

  try {
    const { data: { user }, error } = await supabase.auth.getUser(token)
    if (error || !user) return res.status(401).json({ error: 'AUTH_EXPIRED — please sign in again' })

    const { data: profile, error: profileError } = await supabaseAdmin
      .from('profiles')
      .select('*, dealerships(*)')
      .eq('id', user.id)
      .single()

    if (profileError || !profile) return res.status(401).json({ error: 'Profile not found' })

    if (!req.path.startsWith('/billing')) {
      const isPersonal = profile.dealerships?.is_personal === true
      const useProfileBilling = !profile.dealership_id || isPersonal
      const status = useProfileBilling
        ? profile.billing_status
        : profile.dealerships?.billing_status
      const trialEndsAt = useProfileBilling
        ? profile.trial_ends_at
        : profile.dealerships?.trial_ends_at

      if (status === 'TRIALING') {
        // Self-managed trial — no card required upfront. Block once it expires.
        if (!trialEndsAt || new Date(trialEndsAt) < new Date()) {
          return res.status(402).json({ error: 'TRIAL_EXPIRED' })
        }
      } else if (status === 'INACTIVE' || status === 'PAST_DUE') {
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

// ── 3. AUTH ENDPOINTS ──
// 5 login attempts per IP per 15 minutes — slows credential stuffing without
// hurting real users who fat-finger their password.
app.post('/auth/login', rateLimit('login', 5, 15 * 60 * 1000), async (req, res) => {
  const { email, password } = req.body
  const { data, error } = await supabase.auth.signInWithPassword({ email, password })
  if (error) {
    // Don't leak whether the email exists — Supabase already does this but we double-check
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
      conversion_rate: (total || 0) > 0
        ? Math.round(((sold || 0) / (total || 0)) * 100)
        : 0
    }
  }))

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
    ranking,
    total_members: members.length,
    team_total_listings: totalListings,
    team_total_sold: totalSold,
    team_conversion_rate: totalListings > 0
      ? Math.round((totalSold / totalListings) * 100)
      : 0
  })
})

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
    .select('id, status, posted_at, deleted_at, posted_by, vehicle_label, inventory!listings_inventory_id_fkey(year, make, model)')
    .in('posted_by', memberIds)
    .order('posted_at', { ascending: false })
    .limit(50)

  const events = []
  for (const l of listings || []) {
    // Prefer the live inventory row; fall back to the snapshotted vehicle_label on the listing
    // (vehicle_label is set when finalizeSold runs, so sold/deleted vehicles still show)
    const liveLabel = `${l.inventory?.year || ''} ${l.inventory?.make || ''} ${l.inventory?.model || ''}`.trim()
    const vehicle = liveLabel || l.vehicle_label || 'Vehicle'
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

app.get('/dealership/charts', requireAuth, async (req, res) => {
  if (req.profile.role !== 'DEALER_ADMIN' && req.profile.role !== 'OWNER') {
    return res.status(403).json({ error: 'Admins only' })
  }
  if (!req.dealershipId) return res.json({ daily: [], by_rep: [] })

  // Honor the same ?range= filter as /dashboard/insights. Lifetime means no filter.
  const rangeParam = String(req.query.range || 'lifetime').toLowerCase()
  const rangeDays = ({ '7': 7, '30': 30, '90': 90, '365': 365, '1y': 365 }[rangeParam]) || null
  const rangeStartMs = rangeDays ? Date.now() - rangeDays * 24 * 60 * 60 * 1000 : null
  const rangeStart = rangeStartMs ? new Date(rangeStartMs).toISOString() : null

  // Daily bucket window matches the range when set, else default 30d for the line chart.
  const dailyWindow = rangeDays || 30
  const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString()

  const { data: members } = await supabaseAdmin
    .from('profiles').select('id, full_name').eq('dealership_id', req.dealershipId)
  if (!members?.length) return res.json({ daily: [], by_rep: [] })
  const memberIds = members.map(m => m.id)

  // Daily posts buckets
  let dailyQuery = supabaseAdmin.from('listings').select('posted_at, posted_by').in('posted_by', memberIds)
  const dailyWindowStart = new Date(Date.now() - dailyWindow * 24 * 60 * 60 * 1000).toISOString()
  dailyQuery = dailyQuery.gte('posted_at', dailyWindowStart)
  const { data: recentListings } = await dailyQuery

  const dayBuckets = new Map()
  for (let i = dailyWindow - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000)
    dayBuckets.set(d.toISOString().slice(0, 10), 0)
  }
  for (const l of recentListings || []) {
    const key = (l.posted_at || '').slice(0, 10)
    if (dayBuckets.has(key)) dayBuckets.set(key, dayBuckets.get(key) + 1)
  }

  // Active days per rep (from logins, last 14 days) — independent of listings
  const { data: logins14 } = await supabaseAdmin
    .from('logins').select('user_id, created_at')
    .in('user_id', memberIds).gte('created_at', fourteenDaysAgo)
  const activeDaysByRep = new Map(members.map(m => [m.id, new Set()]))
  for (const l of logins14 || []) {
    const day = (l.created_at || '').slice(0, 10)
    if (day && activeDaysByRep.has(l.user_id)) activeDaysByRep.get(l.user_id).add(day)
  }

  // Per-rep stats — counted the SAME way as /dealership/leaderboard (count by
  // posted_by) so the Players cards and charts always match the leaderboard's
  // points. Range is applied on posted_at (and sold_at for sold counts); lifetime
  // means no date filter. Using reliable COUNT queries per rep instead of a single
  // multi-column row fetch avoids the bucketing bug that zeroed everyone out.
  const repStats = await Promise.all(members.map(async (m) => {
    let listingsQ = supabaseAdmin.from('listings')
      .select('id', { count: 'exact', head: true }).eq('posted_by', m.id)
    if (rangeStart) listingsQ = listingsQ.gte('posted_at', rangeStart)
    const { count: listingsCount } = await listingsQ

    let soldQ = supabaseAdmin.from('listings')
      .select('id', { count: 'exact', head: true }).eq('posted_by', m.id).eq('status', 'sold')
    if (rangeStart) soldQ = soldQ.gte('sold_at', rangeStart)
    const { count: soldCount } = await soldQ

    // Avg time-to-sell (days) across this rep's sold listings in range
    let ttsQ = supabaseAdmin.from('listings')
      .select('created_at, sold_at').eq('posted_by', m.id).eq('status', 'sold')
      .not('sold_at', 'is', null)
    if (rangeStart) ttsQ = ttsQ.gte('sold_at', rangeStart)
    const { data: soldRows } = await ttsQ
    let avgDays = 0
    if (soldRows?.length) {
      const totalMs = soldRows.reduce((acc, r) =>
        acc + Math.max(0, new Date(r.sold_at).getTime() - new Date(r.created_at).getTime()), 0)
      avgDays = Math.round(totalMs / soldRows.length / (1000 * 60 * 60 * 24) * 10) / 10
    }

    return {
      id: m.id,
      name: m.full_name,
      count: listingsCount || 0,
      sold: soldCount || 0,
      activeDays: activeDaysByRep.get(m.id)?.size || 0,
      avgDays
    }
  }))

  const by_rep = repStats
    .map(r => ({ id: r.id, name: r.name, count: r.count }))
    .sort((a, b) => b.count - a.count)
  const sold_by_rep = repStats
    .map(r => ({ name: r.name, count: r.sold }))
    .sort((a, b) => b.count - a.count)
  const active_days_by_rep = repStats
    .map(r => ({ name: r.name, count: r.activeDays }))
    .sort((a, b) => b.count - a.count)
  const sell_through_by_rep = repStats
    .map(r => ({ name: r.name, percent: r.count > 0 ? Math.round((r.sold / r.count) * 1000) / 10 : 0 }))
    .sort((a, b) => b.percent - a.percent)
  const time_to_sell_by_rep = repStats
    .map(r => ({ name: r.name, days: r.avgDays }))
    .sort((a, b) => a.days - b.days)  // ascending — faster sellers first

  res.json({
    range: rangeDays ? String(rangeDays) : 'lifetime',
    daily_window_days: dailyWindow,
    daily: [...dayBuckets.entries()].map(([date, count]) => ({ date, count })),
    by_rep,
    sold_by_rep,
    active_days_by_rep,
    sell_through_by_rep,
    time_to_sell_by_rep
  })
})

app.get('/me/stats', requireAuth, async (req, res) => {
  const stats = await buildUserStats(req.user.id)
  res.json(stats)
})

// Personal chart data for the solo/rep insights page: posts & sales over time +
// a status breakdown. Mirrors what dealer admins get, scoped to this one user.
app.get('/me/charts', requireAuth, async (req, res) => {
  try {
    const range = String(req.query.range || 'lifetime')
    const { data: rows, error } = await supabaseAdmin
      .from('listings')
      .select('status, posted_at, deleted_at')
      .eq('posted_by', req.user.id)
    if (error) return res.status(500).json({ error: error.message })
    const listings = rows || []

    const breakdown = { active: 0, sold: 0, deleted: 0 }
    for (const l of listings) {
      if (l.status === 'sold') breakdown.sold++
      else if (l.status === 'deleted') breakdown.deleted++
      else breakdown.active++
    }

    const days = range === '7' ? 7 : range === '30' ? 30 : range === '90' ? 90 : range === '365' ? 365 : null
    const monthly = days === null || days > 90       // lifetime / 1y → monthly buckets
    const since = days ? Date.now() - days * 86400000 : null
    const keyOf = (iso) => new Date(iso).toISOString().slice(0, monthly ? 7 : 10)

    const buckets = new Map()
    const bump = (iso, field) => {
      if (!iso) return
      if (since && new Date(iso).getTime() < since) return
      const k = keyOf(iso)
      const b = buckets.get(k) || { date: k, posted: 0, sold: 0 }
      b[field]++
      buckets.set(k, b)
    }
    for (const l of listings) {
      bump(l.posted_at, 'posted')
      if (l.status === 'sold') bump(l.deleted_at || l.posted_at, 'sold')
    }
    const trend = [...buckets.values()].sort((a, b) => a.date.localeCompare(b.date))
    res.json({ trend, breakdown, monthly })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ── Global leaderboard ─────────────────────────────────────────────────────────
// Platform-wide ranking of every rep and every dealership. ANONYMIZED: each caller
// sees only their OWN name; everyone else shows as "Rep #N" / "Dealer #N". Lets solo
// reps and dealers see how they stack up against the whole network without exposing
// competitors' identities. Points = listings·100 + sold·500 (same as team board).
app.get('/leaderboard/global', requireAuth, async (req, res) => {
  try {
    const [{ data: listings }, { data: profiles }] = await Promise.all([
      supabaseAdmin.from('listings').select('posted_by, status'),
      supabaseAdmin.from('profiles').select('id, full_name, dealership_id, dealerships(name, is_personal)')
    ])
    const profById = new Map((profiles || []).map(p => [p.id, p]))

    // Tally listings + sold per rep.
    const repTally = new Map()
    for (const l of listings || []) {
      if (!l.posted_by) continue
      const t = repTally.get(l.posted_by) || { posted: 0, sold: 0 }
      t.posted++
      if (l.status === 'sold') t.sold++
      repTally.set(l.posted_by, t)
    }
    const pts = (t) => t.posted * 100 + t.sold * 500

    // Reps board — every rep with activity.
    const reps = [...repTally.entries()].map(([uid, t]) => ({
      uid, points: pts(t), sold: t.sold, posted: t.posted,
      name: profById.get(uid)?.full_name || 'Rep', isYou: uid === req.user.id
    })).sort((a, b) => b.points - a.points || b.sold - a.sold)

    // Dealers board — roll reps up into their (non-personal) dealership.
    const dealerTally = new Map()
    for (const [uid, t] of repTally.entries()) {
      const p = profById.get(uid)
      if (!p?.dealership_id || p.dealerships?.is_personal) continue
      const d = dealerTally.get(p.dealership_id) || { points: 0, sold: 0, posted: 0, name: p.dealerships?.name || 'Dealer' }
      d.points += pts(t); d.sold += t.sold; d.posted += t.posted
      dealerTally.set(p.dealership_id, d)
    }
    const dealers = [...dealerTally.entries()].map(([did, d]) => ({
      did, ...d, isYou: did === req.dealershipId
    })).sort((a, b) => b.points - a.points || b.sold - a.sold)

    const repsOut = reps.map((r, i) => ({
      rank: i + 1, points: r.points, sold: r.sold, posted: r.posted,
      isYou: r.isYou, name: r.isYou ? (r.name || 'You') : `Rep #${i + 1}`
    }))
    const dealersOut = dealers.map((d, i) => ({
      rank: i + 1, points: d.points, sold: d.sold, posted: d.posted,
      isYou: d.isYou, name: d.isYou ? (d.name || 'Your dealership') : `Dealer #${i + 1}`
    }))

    res.json({
      total_reps: repsOut.length,
      total_dealers: dealersOut.length,
      reps: repsOut.slice(0, 100),
      dealers: dealersOut.slice(0, 100),
      you_rep: repsOut.find(r => r.isYou) || null,
      you_dealer: dealersOut.find(d => d.isYou) || null
    })
  } catch (e) {
    console.error('[leaderboard/global] failed:', e.message)
    res.status(500).json({ error: e.message })
  }
})

app.get('/dashboard/insights', requireAuth, async (req, res) => {
  const isAdmin = req.profile.role === 'DEALER_ADMIN' || req.profile.role === 'OWNER'
  const now = new Date()

  // Time range filter: lifetime | 365 | 90 | 30 | 7 (days). Defaults to lifetime.
  // Returns ISO `start` so we can re-apply it to .gte() consistently across queries.
  const rangeParam = String(req.query.range || 'lifetime').toLowerCase()
  const rangeDays = ({ '7': 7, '30': 30, '90': 90, '365': 365, '1y': 365 }[rangeParam]) || null
  const rangeStart = rangeDays
    ? new Date(now.getTime() - rangeDays * 24 * 60 * 60 * 1000).toISOString()
    : null
  const rangeLabel = rangeDays ? `last ${rangeDays} days` : 'lifetime'

  const day = now.getUTCDay() || 7
  const startOfWeek = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (day - 1)
  )).toISOString()

  let inventorySynced = 0, inventoryAvailable = 0, listingsPosted = 0
  let soldThisMonth = 0, activeDaysThisWeek = 0, listingsByAdmin = 0, listingsByReps = 0
  let avgTimeToSellDays = null, postsPerDay = 0, sellThroughRate = 0
  let inventoryAged60d = 0, linkClicks = 0
  const warnings = {}

  // Helper: apply rangeStart filter to a supabase query builder
  const withRange = (q, col = 'created_at') => rangeStart ? q.gte(col, rangeStart) : q

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

      // Aged inventory: available cars on the lot more than 60 days
      const sixtyDaysAgo = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000).toISOString()
      const { count: aged, error: agedErr } = await supabaseAdmin
        .from('inventory').select('id', { count: 'exact', head: true })
        .eq('dealership_id', req.dealershipId)
        .eq('status', 'available')
        .lt('created_at', sixtyDaysAgo)
      if (agedErr) warnings.inventory_aged = agedErr.message
      else inventoryAged60d = aged || 0
    }
  } catch (e) { warnings.inventory = e.message }

  try {
    if (isAdmin && req.dealershipId) {
      const { data: members, error: memErr } = await supabaseAdmin
        .from('profiles').select('id, role').eq('dealership_id', req.dealershipId)
      if (memErr) {
        warnings.listings = memErr.message
      } else {
        const memberIds = (members || []).map(m => m.id)
        const adminIds = (members || [])
          .filter(m => m.role === 'DEALER_ADMIN' || m.role === 'OWNER')
          .map(m => m.id)
        const repIds = (members || [])
          .filter(m => m.role === 'SALES_REP')
          .map(m => m.id)

        if (memberIds.length) {
          const { count: total } = await withRange(
            supabaseAdmin.from('listings').select('id', { count: 'exact', head: true })
              .in('posted_by', memberIds)
          )
          listingsPosted = total || 0

          const { count: sold } = await withRange(
            supabaseAdmin.from('listings').select('id', { count: 'exact', head: true })
              .in('posted_by', memberIds).eq('status', 'sold')
          , 'sold_at')
          soldThisMonth = sold || 0

          // Avg time-to-sell: pull sold rows in range, compute (sold_at - created_at) avg in days
          const soldQuery = supabaseAdmin
            .from('listings').select('created_at, sold_at')
            .in('posted_by', memberIds).eq('status', 'sold')
            .not('sold_at', 'is', null)
          const { data: soldRows } = await withRange(soldQuery, 'sold_at')
          if (soldRows && soldRows.length) {
            const totalMs = soldRows.reduce((acc, r) => {
              const diff = new Date(r.sold_at).getTime() - new Date(r.created_at).getTime()
              return acc + Math.max(0, diff)
            }, 0)
            avgTimeToSellDays = Math.round(totalMs / soldRows.length / (1000 * 60 * 60 * 24) * 10) / 10
          }
        }
        if (adminIds.length) {
          const { count } = await withRange(
            supabaseAdmin.from('listings').select('id', { count: 'exact', head: true })
              .in('posted_by', adminIds)
          )
          listingsByAdmin = count || 0
        }
        if (repIds.length) {
          const { count } = await withRange(
            supabaseAdmin.from('listings').select('id', { count: 'exact', head: true })
              .in('posted_by', repIds)
          )
          listingsByReps = count || 0
        }
      }
    } else {
      const { count: total, error: totalErr } = await withRange(
        supabaseAdmin.from('listings').select('id', { count: 'exact', head: true })
          .eq('posted_by', req.user.id)
      )
      if (totalErr) warnings.listings = totalErr.message
      else listingsPosted = total || 0

      const { count: sold, error: soldErr } = await withRange(
        supabaseAdmin.from('listings').select('id', { count: 'exact', head: true })
          .eq('posted_by', req.user.id).eq('status', 'sold')
      , 'sold_at')
      if (soldErr) warnings.sold = soldErr.message
      else soldThisMonth = sold || 0

      const { data: soldRows } = await withRange(
        supabaseAdmin.from('listings').select('created_at, sold_at')
          .eq('posted_by', req.user.id).eq('status', 'sold')
          .not('sold_at', 'is', null)
      , 'sold_at')
      if (soldRows && soldRows.length) {
        const totalMs = soldRows.reduce((acc, r) =>
          acc + Math.max(0, new Date(r.sold_at).getTime() - new Date(r.created_at).getTime()), 0)
        avgTimeToSellDays = Math.round(totalMs / soldRows.length / (1000 * 60 * 60 * 24) * 10) / 10
      }
    }
  } catch (e) { warnings.listings = e.message }

  // Derived metrics
  if (listingsPosted > 0 && rangeDays) {
    postsPerDay = Math.round((listingsPosted / rangeDays) * 10) / 10
  }
  if (listingsPosted > 0) {
    sellThroughRate = Math.round((soldThisMonth / listingsPosted) * 1000) / 10  // e.g. 23.4 (%)
  }

  // Link clicks (FB Marketplace listing → MarketSync redirect → dealer site).
  // Counts rows in listing_clicks scoped to this user/dealership, within the range.
  try {
    let clickIds = null
    if (isAdmin && req.dealershipId) {
      const { data: members } = await supabaseAdmin
        .from('profiles').select('id').eq('dealership_id', req.dealershipId)
      clickIds = (members || []).map(m => m.id)
    } else {
      clickIds = [req.user.id]
    }
    if (clickIds && clickIds.length) {
      // Click attribution flows through listings.posted_by
      const { data: listingRows } = await supabaseAdmin
        .from('listings').select('id').in('posted_by', clickIds)
      const listingIds = (listingRows || []).map(l => l.id)
      if (listingIds.length) {
        const { count } = await withRange(
          supabaseAdmin.from('listing_clicks').select('id', { count: 'exact', head: true })
            .in('listing_id', listingIds)
        , 'clicked_at')
        linkClicks = count || 0
      }
    }
  } catch (e) {
    // listing_clicks table may not exist yet — that's fine, just leave linkClicks at 0
    if (!e.message?.includes('does not exist')) warnings.clicks = e.message
  }

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

  if (Object.keys(warnings).length) {
    console.warn('Insights partial:', { user: req.user.id, role: req.profile.role, warnings })
  }

  res.json({
    range: rangeDays ? String(rangeDays) : 'lifetime',
    range_label: rangeLabel,
    inventory_available: inventoryAvailable,
    inventory_synced: inventorySynced,
    inventory_aged_60d: inventoryAged60d,
    listings_posted: listingsPosted,
    listings_by_admin: listingsByAdmin,
    listings_by_reps: listingsByReps,
    sold_this_month: soldThisMonth,
    avg_time_to_sell_days: avgTimeToSellDays,
    posts_per_day: postsPerDay,
    sell_through_rate: sellThroughRate,
    link_clicks: linkClicks,
    active_days_this_week: activeDaysThisWeek,
    scope: isAdmin ? 'dealership' : 'personal',
    warnings: Object.keys(warnings).length ? warnings : undefined
  })
})

app.get('/dealership/team/:userId/stats', requireAuth, async (req, res) => {
  if (req.profile.role !== 'DEALER_ADMIN' && req.profile.role !== 'OWNER') {
    return res.status(403).json({ error: 'Admins only' })
  }

  const { data: target } = await supabaseAdmin
    .from('profiles')
    .select('id, full_name, role, dealership_id, created_at')
    .eq('id', req.params.userId)
    .single()
  if (!target || target.dealership_id !== req.dealershipId) {
    return res.status(404).json({ error: 'User not found in your dealership' })
  }

  const { data: authUser } = await supabaseAdmin.auth.admin
    .getUserById(req.params.userId).catch(() => ({ data: null }))
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
      let q = supabaseAdmin
        .from('listings')
        .select('id', { count: 'exact', head: true })
        .eq('posted_by', userId)
      if (status) q = q.eq('status', status)
      const { count, error } = await q
      if (error) {
        console.warn(`countOf(${status || 'all'}) failed:`, error.message)
        return 0
      }
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
      .select('id, status, posted_at, fb_listing_url, inventory!listings_inventory_id_fkey(id, year, make, model, trim, price, image_urls)')
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

// ── OWNER-ONLY: NEWSLETTER SUBSCRIBER EXPORT ──
// Gated to a single owner email (you). Returns CSV-ready data of everyone who
// opted in to marketing emails during signup. Drop the file into Resend/Mailchimp/etc.
const OWNER_EMAIL = (process.env.OWNER_EMAIL || 'massiejay@gmail.com').toLowerCase()

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

// ── 6. INVENTORY ──
app.get('/inventory', requireAuth, async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('inventory')
    .select('*')
    .eq('dealership_id', req.dealershipId)
    .eq('status', 'available')
    .order('created_at', { ascending: false })
  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})

app.get('/inventory/all', requireAuth, async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('inventory')
    .select('id, vin, year, make, model, trim, price, mileage, condition, exterior_color, status, image_urls, source_url, description, last_synced_at')
    .eq('dealership_id', req.dealershipId)
    .order('created_at', { ascending: false })
  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})
app.get('/inventory/:id', requireAuth, async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('inventory')
    .select('*')
    .eq('id', req.params.id)
    .eq('dealership_id', req.dealershipId)
    .single()
  if (error) return res.status(404).json({ error: 'Not found' })
  res.json(data)
})

// ── 7. LISTINGS ──
app.post('/listings', requireAuth, async (req, res) => {
  const { inventory_id, fb_listing_id } = req.body

  // Only store a Facebook URL if it's a real posted-item permalink
  // (.../marketplace/item/<id>). The extension's manual "Mark Posted" button can
  // fire while still on the create page, which would otherwise save the generic
  // .../marketplace/create/vehicle URL and make "View on FB" link to a blank form.
  const rawUrl = req.body.fb_listing_url
  const fb_listing_url = (typeof rawUrl === 'string' && rawUrl.includes('/marketplace/item/'))
    ? rawUrl
    : null

  // Dedupe: the manual button and the auto-detector can both fire for the same
  // vehicle. Reuse an existing 'posted' listing and backfill its URL/id instead of
  // inserting a duplicate (manual marks it posted first, auto-detect fills the URL).
  const { data: existingRows } = await supabaseAdmin
    .from('listings').select('id, fb_listing_url, fb_listing_id')
    .eq('inventory_id', inventory_id).eq('posted_by', req.user.id).eq('status', 'posted')
    .order('posted_at', { ascending: false }).limit(1)
  const existing = existingRows?.[0]

  if (existing) {
    const patch = {}
    if (fb_listing_url && !existing.fb_listing_url) patch.fb_listing_url = fb_listing_url
    if (fb_listing_id && !existing.fb_listing_id) patch.fb_listing_id = fb_listing_id
    if (!Object.keys(patch).length) return res.json(existing)
    const { data, error } = await supabaseAdmin
      .from('listings').update(patch).eq('id', existing.id).select().single()
    if (error) return res.status(500).json({ error: error.message })
    return res.json(data)
  }

  const { data, error } = await supabaseAdmin
    .from('listings')
    .insert({
      inventory_id,
      posted_by: req.user.id,
      fb_listing_id: fb_listing_id || null,
      fb_listing_url,
      status: 'posted',
      posted_at: new Date().toISOString()
    })
    .select()
    .single()
  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})

// ── FIX: use explicit FK hint + JS-side dealership filter to avoid ambiguous join ──
app.get('/listings', requireAuth, async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('listings')
    .select('*, inventory!listings_inventory_id_fkey(*)')
    .eq('status', 'posted')
    .eq('posted_by', req.user.id)   // ← THIS is the fix
    .order('posted_at', { ascending: false })
  if (error) return res.status(500).json({ error: error.message })
  res.json(data || [])
})
app.patch('/listings/:id/delete', requireAuth, async (req, res) => {
  // Queue the Facebook listing for DELETION (not "sold") — the extension will
  // remove it from Marketplace. We only queue it if there's an FB URL to act on;
  // fb_synced_at stays null so the extension's poller picks it up.
  const { error } = await supabaseAdmin
    .from('listings')
    .update({
      status: 'deleted',
      deleted_at: new Date().toISOString(),
      fb_sync_action: 'delete',
      fb_synced_at: null
    })
    .eq('id', req.params.id)
  if (error) return res.status(500).json({ error: error.message })
  res.json({ success: true })
})

// ── Facebook auto-sync queue ──────────────────────────────────────────────────
// Facebook Marketplace has no server-side API for personal listings, so the
// browser extension performs "Mark as sold" / "Delete" actions client-side.
// These two endpoints are the queue: the extension polls pending-fb-sync for the
// signed-in user's own listings, acts on Facebook, then reports back via fb-sync-done.

// What FB actions are waiting for THIS user to perform (scoped to posted_by — the
// FB session belongs to the logged-in rep, so we only ever touch their own posts).
app.get('/listings/pending-fb-sync', requireAuth, async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('listings')
    .select('id, fb_listing_url, fb_sync_action, fb_sync_attempts, vehicle_label')
    .eq('posted_by', req.user.id)
    .not('fb_sync_action', 'is', null)
    .is('fb_synced_at', null)
    .not('fb_listing_url', 'is', null)
    .lt('fb_sync_attempts', 5)       // give up after 5 failed attempts
    .order('deleted_at', { ascending: true })
    .limit(25)
  if (error) return res.status(500).json({ error: error.message })
  res.json(data || [])
})

// Extension reports the outcome. ok=true → mark synced (stop queueing).
// ok=false → bump the attempt counter so we eventually stop retrying.
app.post('/listings/:id/fb-sync-done', requireAuth, async (req, res) => {
  const { ok } = req.body || {}
  const { data: listing } = await supabaseAdmin
    .from('listings')
    .select('id, posted_by, fb_sync_attempts')
    .eq('id', req.params.id)
    .single()
  if (!listing) return res.status(404).json({ error: 'Listing not found' })
  if (listing.posted_by !== req.user.id) return res.status(403).json({ error: 'Not your listing' })

  const update = ok
    ? { fb_synced_at: new Date().toISOString() }
    : { fb_sync_attempts: (listing.fb_sync_attempts || 0) + 1 }
  const { error } = await supabaseAdmin.from('listings').update(update).eq('id', req.params.id)
  if (error) return res.status(500).json({ error: error.message })
  res.json({ success: true })
})

// Shared helper: after a vehicle is sold via any path, snapshot identity onto the listing
// so leaderboard/activity feeds still have year/make/model after the inventory row is gone,
// then DELETE the inventory row entirely. Listings/sales FKs are ON DELETE SET NULL so their
// historical records survive.
async function finalizeSold(listingId, inventoryId) {
  const now = new Date().toISOString()
  // 1. Snapshot vehicle identity onto the listing row
  if (inventoryId) {
    const { data: inv } = await supabaseAdmin
      .from('inventory')
      .select('year, make, model, trim, vin, price')
      .eq('id', inventoryId)
      .single()
    if (inv) {
      const label = [inv.year, inv.make, inv.model, inv.trim].filter(Boolean).join(' ').trim()
      // fb_sync_action='sold' queues the extension to mark the FB listing "Sold".
      await supabaseAdmin
        .from('listings')
        .update({ status: 'sold', deleted_at: now, vehicle_label: label || null, fb_sync_action: 'sold', fb_synced_at: null })
        .eq('id', listingId)
    } else {
      await supabaseAdmin
        .from('listings')
        .update({ status: 'sold', deleted_at: now, fb_sync_action: 'sold', fb_synced_at: null })
        .eq('id', listingId)
    }
    // 2. Delete the inventory row — vehicle is gone from the dealer site / sold
    await supabaseAdmin.from('inventory').delete().eq('id', inventoryId)
  }
}

app.post('/listings/sync-fb-sold', requireAuth, async (req, res) => {
  const { fb_listing_url } = req.body || {}
  if (!fb_listing_url) return res.status(400).json({ error: 'fb_listing_url required' })

  const normalizedUrl = fb_listing_url.split('?')[0].split('#')[0]

  const { data: candidates } = await supabaseAdmin
    .from('listings')
    .select('id, inventory_id, status, fb_listing_url, inventory!listings_inventory_id_fkey(dealership_id)')
    .eq('status', 'posted')
    .ilike('fb_listing_url', `${normalizedUrl}%`)

  const listing = (candidates || []).find(l => l.inventory?.dealership_id === req.dealershipId)
  if (!listing) return res.json({ success: false, matched: false })

  await finalizeSold(listing.id, listing.inventory_id)
  // FB already shows this as sold (that's how we detected it) — no need to queue
  // the extension to mark it sold again.
  await supabaseAdmin
    .from('listings')
    .update({ fb_sync_action: null, fb_synced_at: new Date().toISOString() })
    .eq('id', listing.id)
  res.json({ success: true, matched: true, listing_id: listing.id })
})

// "I Sold It" — rep closed the deal. Records sale (500 pts) + deletes inventory row.
app.post('/listings/:id/sold-by-me', requireAuth, async (req, res) => {
  const { data: listing, error: lookupErr } = await supabaseAdmin
    .from('listings')
    .select('id, inventory_id, inventory!listings_inventory_id_fkey(dealership_id)')
    .eq('id', req.params.id)
    .single()
  if (lookupErr || !listing) return res.status(404).json({ error: 'Listing not found' })
  if (listing.inventory?.dealership_id !== req.dealershipId) return res.status(403).json({ error: 'Not your dealership' })

  // Record the sale FIRST (before deleting inventory) so points are credited.
  const { error: saleErr } = await supabaseAdmin.from('sales').insert({
    inventory_id: listing.inventory_id,
    sold_by: req.user.id,
    dealership_id: req.dealershipId,
    points_awarded: 500
  })
  if (saleErr) console.warn('Sales insert failed (table may not exist yet):', saleErr.message)

  await finalizeSold(listing.id, listing.inventory_id)
  res.json({ success: true, points_awarded: 500 })
})

// "I Sold It on FB" — rep closed a deal that came through the Facebook listing.
// Bonus points (750) since the sale came from MarketSync's posting.
app.post('/listings/:id/sold-on-fb', requireAuth, async (req, res) => {
  const { data: listing, error: lookupErr } = await supabaseAdmin
    .from('listings')
    .select('id, inventory_id, inventory!listings_inventory_id_fkey(dealership_id)')
    .eq('id', req.params.id)
    .single()
  if (lookupErr || !listing) return res.status(404).json({ error: 'Listing not found' })
  if (listing.inventory?.dealership_id !== req.dealershipId) return res.status(403).json({ error: 'Not your dealership' })

  const { error: saleErr } = await supabaseAdmin.from('sales').insert({
    inventory_id: listing.inventory_id,
    sold_by: req.user.id,
    dealership_id: req.dealershipId,
    points_awarded: 750
  })
  if (saleErr) console.warn('Sales insert failed:', saleErr.message)

  await finalizeSold(listing.id, listing.inventory_id)
  res.json({ success: true, points_awarded: 750 })
})

// "Sold by Other" — someone else closed it. No points, but vehicle still gets removed.
app.post('/listings/:id/sold-by-other', requireAuth, async (req, res) => {
  const { data: listing, error: lookupErr } = await supabaseAdmin
    .from('listings')
    .select('id, inventory_id, inventory!listings_inventory_id_fkey(dealership_id)')
    .eq('id', req.params.id)
    .single()
  if (lookupErr || !listing) return res.status(404).json({ error: 'Listing not found' })
  if (listing.inventory?.dealership_id !== req.dealershipId) return res.status(403).json({ error: 'Not your dealership' })

  await finalizeSold(listing.id, listing.inventory_id)
  res.json({ success: true, points_awarded: 0 })
})

// Legacy /sold endpoint — keep working, treats as "sold by other" (no point credit)
app.post('/listings/:id/sold', requireAuth, async (req, res) => {
  const { data: listing, error: lookupErr } = await supabaseAdmin
    .from('listings')
    .select('id, inventory_id, inventory!listings_inventory_id_fkey(dealership_id)')
    .eq('id', req.params.id)
    .single()
  if (lookupErr || !listing) return res.status(404).json({ error: 'Listing not found' })
  if (listing.inventory?.dealership_id !== req.dealershipId) return res.status(403).json({ error: 'Not your dealership' })

  await finalizeSold(listing.id, listing.inventory_id)
  res.json({ success: true })
})

// ── 8. BILLING ──
app.post('/billing/checkout', requireAuth, async (req, res) => {
  const isPersonal = req.profile.dealerships?.is_personal === true
  const isSolo = !req.dealershipId || isPersonal

  if (req.profile.role === 'SALES_REP' && req.dealershipId && !isPersonal) {
    return res.status(403).json({ error: 'Sales reps under a dealership do not manage billing.' })
  }

  const priceId = req.body?.priceId || (isSolo
    ? process.env.STRIPE_SOLO_PRICE_ID
    : process.env.STRIPE_DEALER_PRICE_ID)
  if (!priceId) return res.status(500).json({ error: 'Missing Stripe price ID env var' })

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
        const portalSession = await stripe.billingPortal.sessions.create({
          customer: existingCustomerId,
          return_url: `${FRONTEND_URL}/dashboard.html`
        })
        return res.json({ url: portalSession.url })
      } catch (portalErr) {
        console.warn('Portal initialization bypassed:', portalErr.message)
      }
    }
    // No Stripe-side trial — we self-manage the 7-day no-card trial via billing_status='TRIALING'.
    // By the time the user hits checkout, their trial has either ended or they chose to upgrade early;
    // either way Stripe charges immediately.
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      mode: 'subscription',
      client_reference_id: clientRefId,
      metadata,
      subscription_data: { metadata },
      success_url: `${FRONTEND_URL}/dashboard.html`,
      cancel_url: `${FRONTEND_URL}/dashboard.html`
    })
    res.json({ url: session.url })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.post('/billing/portal', requireAuth, async (req, res) => {
  res.redirect(307, '/billing/checkout')
})

app.get('/billing/trial-status', requireAuth, async (req, res) => {
  const isPersonal = req.profile.dealerships?.is_personal === true
  const useProfileBilling = !req.profile.dealership_id || isPersonal
  const status = useProfileBilling
    ? req.profile.billing_status
    : req.profile.dealerships?.billing_status
  const trialEndsAt = useProfileBilling
    ? req.profile.trial_ends_at
    : req.profile.dealerships?.trial_ends_at

  let daysRemaining = null
  if (status === 'TRIALING' && trialEndsAt) {
    const ms = new Date(trialEndsAt).getTime() - Date.now()
    daysRemaining = Math.max(0, Math.ceil(ms / (1000 * 60 * 60 * 24)))
  }

  res.json({
    status: status || null,
    trial_ends_at: trialEndsAt || null,
    days_remaining: daysRemaining,
    is_active: status === 'ACTIVE',
    is_trialing: status === 'TRIALING' && daysRemaining !== null && daysRemaining > 0
  })
})

// ── CLICK REDIRECT (Facebook Marketplace attribution) ──
// Buyer clicks the dealer link in a Marketplace listing description → hits this
// endpoint → we log the click and 302 to the actual dealer URL. Public — no auth
// required (Facebook strips referrer auth headers, and the link must work for
// anonymous buyers). The listing_id alone is enough since each listing row stores
// the dealer source_url via its linked inventory row.
app.get('/r/:listingId', async (req, res) => {
  const { listingId } = req.params

  // Look up the destination URL: prefer the inventory row's source_url, fall back
  // to a stored snapshot if inventory has been deleted (sold/dropped).
  let destination = null
  try {
    const { data: listing } = await supabaseAdmin
      .from('listings')
      .select('inventory_id, inventory!listings_inventory_id_fkey(source_url)')
      .eq('id', listingId)
      .maybeSingle()
    destination = listing?.inventory?.source_url || null
  } catch {}

  // Log the click (don't block redirect on logging errors)
  supabaseAdmin
    .from('listing_clicks')
    .insert({
      listing_id: listingId,
      source: req.query.s || 'fb_marketplace',
      user_agent: (req.headers['user-agent'] || '').slice(0, 500),
      referrer: (req.headers.referer || req.headers.referrer || '').slice(0, 500)
    })
    .then(({ error }) => { if (error) console.warn('listing_click insert failed:', error.message) })

  if (destination) return res.redirect(302, destination)
  // Fall back to the homepage rather than 404 — buyer should land somewhere usable
  res.redirect(302, FRONTEND_URL)
})

// Tracked redirect keyed by INVENTORY id. The extension embeds this link in the FB
// Marketplace description, where the listing row doesn't exist yet at fill time. At
// click time the post is live, so we resolve the dealer URL from inventory and
// attribute the click to the most recent posted listing for that vehicle.
app.get('/r/v/:inventoryId', async (req, res) => {
  const { inventoryId } = req.params

  let destination = null
  let listingId = null
  try {
    const { data: inv } = await supabaseAdmin
      .from('inventory').select('source_url').eq('id', inventoryId).maybeSingle()
    destination = inv?.source_url || null

    const { data: rows } = await supabaseAdmin
      .from('listings').select('id')
      .eq('inventory_id', inventoryId).eq('status', 'posted')
      .order('posted_at', { ascending: false }).limit(1)
    listingId = rows?.[0]?.id || null
  } catch {}

  // Only log when we can attribute the click to a real listing — the insights metric
  // counts clicks via listings.posted_by, so an unattributed click wouldn't be counted.
  if (listingId) {
    supabaseAdmin
      .from('listing_clicks')
      .insert({
        listing_id: listingId,
        source: req.query.s || 'fb_marketplace',
        user_agent: (req.headers['user-agent'] || '').slice(0, 500),
        referrer: (req.headers.referer || req.headers.referrer || '').slice(0, 500)
      })
      .then(({ error }) => { if (error) console.warn('listing_click insert failed:', error.message) })
  }

  if (destination) return res.redirect(302, destination)
  res.redirect(302, FRONTEND_URL)
})

// ── 9. IMAGE PROXY ──
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

// ── 10. SYNC ENGINE ──
function mapFuel(fuel) {
  if (!fuel) return 'Gasoline'
  const f = fuel.toLowerCase()
  if (f.includes('electric')) return 'Electric'
  if (f.includes('hybrid')) return 'Hybrid'
  if (f.includes('diesel')) return 'Diesel'
  return 'Gasoline'
}

function buildDescription(vehicle) {
  // Feature list: prefer the feed's explicit searchables, fall back to upgrades/options.
  // Entries may be plain strings or { name } objects depending on the platform.
  const featureSrc = (Array.isArray(vehicle.searchablesarray) && vehicle.searchablesarray.length)
    ? vehicle.searchablesarray
    : (Array.isArray(vehicle.upgrades) ? vehicle.upgrades
      : (Array.isArray(vehicle.options) ? vehicle.options : []))
  const features = featureSrc
    .map(f => (typeof f === 'string' ? f : (f?.name || f?.label || '')))
    .map(s => String(s).trim())
    .filter(Boolean)
    .slice(0, 18)
    .join(' • ')

  const tags = []
  if (vehicle.condition) tags.push(String(vehicle.condition).toUpperCase())
  if (vehicle.certified) tags.push('CERTIFIED PRE-OWNED')
  if (vehicle.demo) tags.push('DEMO')
  if (vehicle.salepending) tags.push('SALE PENDING')

  const headline = `${vehicle.year || ''} ${vehicle.make || ''} ${vehicle.model || ''} ${vehicle.trim || ''}`
    .replace(/\s+/g, ' ').trim()
  const tagLine = tags.length ? tags.join(' • ') : null

  const specs = [
    vehicle.mileage ? `${Number(vehicle.mileage).toLocaleString()} km` : null,
    vehicle.exteriorcolor ? `${vehicle.exteriorcolor} exterior` : null,
    vehicle.interiorcolor ? `${vehicle.interiorcolor} interior` : null,
    vehicle.bodystyle || null,
    vehicle.drivetrain || null,
    vehicle.engine || null,
    vehicle.transmission ? `${vehicle.transmission} transmission` : null,
    vehicle.fueltype ? `${vehicle.fueltype} fuel` : null,
    vehicle.seats ? `${vehicle.seats} seats` : null
  ].filter(Boolean)

  // A short trim/marketing blurb when the feed ships one.
  const blurb = [vehicle.trimdescription, vehicle.description]
    .map(s => (typeof s === 'string' ? s.trim() : ''))
    .find(s => s && s.length > 20 && s.length < 600) || null

  const sections = [
    tagLine ? `${tagLine}\n${headline}` : headline,
    specs.length ? specs.join(' • ') : null,
    blurb,
    features ? `FEATURES:\n${features}` : null,
    vehicle.stocknumber ? `Stock #${vehicle.stocknumber}` : null
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

const PLATFORM_PROBES = [
  {
    platform: 'leadbox',
    label: 'LeadBox',
    buildUrls: (origin) => [`${origin}/wp-content/uploads/data/inventory.json`],
    validate: (data) => Array.isArray(data?.vehicles) && data.vehicles.length > 0,
    extract: (data) => data.vehicles,
    mapVehicle: (v) => ({
      vin: v.vin, year: v.year, make: v.make, model: v.model, trim: v.trim,
      price: v.saleprice || v.price, mileage: v.mileage, condition: v.condition,
      stocknumber: v.stocknumber, exteriorcolor: v.exteriorcolor
    })
  },
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
      vin: v.VIN || v.vin, year: v.Year || v.year, make: v.Make || v.make,
      model: v.Model || v.model, trim: v.Trim || v.trim,
      price: v.Price || v.ListPrice || v.price, mileage: v.Mileage || v.mileage,
      condition: v.IsNew ? 'New' : 'Used', stocknumber: v.StockNumber || v.stocknumber,
      exteriorcolor: v.ExteriorColour || v.ExteriorColor || v.exteriorcolor
    })
  },
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
      vin: v.vin, year: v.year, make: v.make, model: v.model, trim: v.trim,
      price: v.price || v.final_price, mileage: v.mileage || v.odometer,
      condition: v.type, stocknumber: v.stock_number || v.stock, exteriorcolor: v.exterior_color
    })
  },
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
      vin: v.vin, year: v.modelYear || v.year, make: v.make, model: v.model, trim: v.trim,
      price: v.pricing?.advertised || v.finalPrice || v.price, mileage: v.odometer || v.mileage,
      condition: v.type, stocknumber: v.stockNumber || v.stock, exteriorcolor: v.exteriorColor
    })
  },
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
      vin: v.vin, year: v.year || v.modelYear, make: v.make, model: v.model, trim: v.trim,
      price: v.price || v.sellingPrice, mileage: v.mileage || v.odometer,
      condition: v.newOrUsed || v.condition, stocknumber: v.stockNumber || v.stock,
      exteriorcolor: v.exteriorColor || v.color
    })
  },
  {
    platform: 'cdk',
    label: 'CDK Global',
    buildUrls: (origin) => [
      `${origin}/inventory/api/vehicles?pageSize=10`,
      `${origin}/api/cdk/inventory`
    ],
    validate: (data) => Array.isArray(data?.vehicles || data?.results) &&
      (data?.vehicles || data?.results)?.[0]?.vin,
    extract: (data) => data?.vehicles || data?.results || [],
    mapVehicle: (v) => ({
      vin: v.vin, year: v.modelYear || v.year, make: v.make, model: v.model, trim: v.trim,
      price: v.internetPrice || v.price, mileage: v.mileage, condition: v.type,
      stocknumber: v.stockNumber, exteriorcolor: v.exteriorColor
    })
  },
  {
    platform: 'ux_auto',
    label: 'UX Auto',
    buildUrls: (origin) => [
      `${origin}/inventory/list/NEW`,
      `${origin}/inventory/list/USED`,
      `${origin}/inventory/list/DEMO`,
      `${origin}/inventory/list/new`,
      `${origin}/inventory/list/used`,
    ],
    validate: (data) =>
      data?.result === 'Success' && Array.isArray(data?.records) && data.records.length > 0,
    extract: (data) => data.records,
    mapVehicle: (v) => ({
      vin: v.vin,
      year: v.year,
      make: v.make,
      model: v.model,
      trim: v.trim || null,
      price: v.sale_price || v.list_price || v.retail_price || 0,
      mileage: v.mileage || 0,
      condition: v.condition || null,
      stocknumber: v.stock_id || v.stocknumber,
      exteriorcolor: v.ext_color || null,
      interiorcolor: v.int_color || null,
      bodystyle: v.body_type || v.body_style || null,
      fueltype: v.fuel_type || null,
      transmission: v.transmission || null,
      drivetrain: v.drivetrain || v.drive_train || null,
      onweb: v.active !== 'n',
      salepending: false,
      image_urls: v.s3_key
        ? [`https://d3ls4jww1dnhu4.cloudfront.net/${v.s3_key}`]
        : (Array.isArray(v.images) ? v.images : [])
    })
  },
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
      vin: v.vin, year: v.year, make: v.make, model: v.model, trim: v.trim,
      price: v.price || v.saleprice, mileage: v.mileage, condition: v.condition,
      stocknumber: v.stocknumber, exteriorcolor: v.exteriorcolor
    })
  },
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
      vin: v.vin, year: v.year, make: v.make, model: v.model, trim: v.trim,
      price: v.price, mileage: v.odometer || v.mileage, condition: v.condition,
      stocknumber: v.stockNumber || v.stock, exteriorcolor: v.exteriorColour || v.exteriorColor
    })
  },
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
      vin: v.vin || v.Vin, year: v.year || v.Year, make: v.make || v.Make,
      model: v.model || v.Model, trim: v.trim || v.Trim, price: v.price || v.Price,
      mileage: v.mileage || v.Mileage, condition: v.condition || v.Condition,
      stocknumber: v.stockNumber || v.StockNumber, exteriorcolor: v.exteriorColor || v.ExteriorColor
    })
  },
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
      vin: v.vin, year: v.year, make: v.make, model: v.model, trim: v.trim,
      price: v.price, mileage: v.mileage, condition: v.condition,
      stocknumber: v.stock, exteriorcolor: v.color
    })
  },
  {
    platform: 'schema_jsonld',
    label: 'Schema.org JSON-LD',
    htmlProbe: true,
    buildUrls: () => [],
    validate: (data) => {
      if (!data?.jsonLd) return false
      return extractCarsFromJsonLd(data.jsonLd).length > 0
    },
    extract: (data) => extractCarsFromJsonLd(data.jsonLd),
    mapVehicle: (v) => {
      // Idempotent: works on RAW Schema.org Car nodes AND on already-normalized
      // vehicles from parseEDealerDetailPage. We pick whichever field name is
      // populated rather than blindly overwriting with undefined.
      // Without this, the sitemap walker's vin/stocknumber got wiped when the
      // mapper ran over its output → "128 no VIN/stock #" skips.
      const pick = (...keys) => {
        for (const k of keys) {
          if (v[k] != null && v[k] !== '') return v[k]
        }
        return null
      }
      const cond = v.itemCondition || v.condition || ''
      const condition = cond.includes('NewCondition') ? 'New'
        : cond.includes('UsedCondition') ? 'Used'
        : cond.includes('Refurbished') ? 'Certified'
        : (cond === 'New' || cond === 'Used' || cond === 'Demo') ? cond
        : null
      const drive = (v.driveWheelConfiguration || '').match(/\/(\w+)WheelDriveConfiguration/)?.[1]
      let trim = v.trim || null
      if (!trim && typeof v.vehicleConfiguration === 'string') {
        const parts = v.vehicleConfiguration.split(' ')
        trim = parts.slice(0, -1).join(' ') || null
      }
      const image = Array.isArray(v.image) ? v.image[0] : v.image
      return {
        vin: pick('vin', 'vehicleIdentificationNumber'),
        year: pick('year', 'vehicleModelDate'),
        make: v.make || v.brand?.name || v.manufacturer?.name || v.brand || null,
        model: pick('model'),
        trim,
        price: pick('price') ?? v.offers?.price ?? null,
        mileage: pick('mileage') ?? v.mileageFromOdometer?.value ?? null,
        condition,
        stocknumber: pick('stocknumber', 'sku', 'productID'),
        exteriorcolor: pick('exteriorcolor', 'color'),
        interiorcolor: pick('interiorcolor', 'vehicleInteriorColor'),
        bodystyle: pick('bodystyle', 'bodyType'),
        fueltype: pick('fueltype') ?? v.vehicleEngine?.fuelType ?? null,
        transmission: pick('transmission', 'vehicleTransmission'),
        drivetrain: pick('drivetrain') || drive,
        image_urls: Array.isArray(v.image_urls) && v.image_urls.length
          ? v.image_urls
          : (image && image !== 'https://static.edealer.ca/V4/assets/images/new_vehicles_images_coming.png'
              ? [image] : [])
      }
    }
  }
]

async function probeUrlHtml(url, timeoutMs = 12000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await browserFetch(url, { signal: controller.signal })
    clearTimeout(timer)
    if (res.status === 403 || res.status === 503) return { ok: false, status: res.status, blocked: true }
    if (!res.ok) return { ok: false, status: res.status }
    const html = await res.text()
    const blocks = []
    const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
    let m
    while ((m = re.exec(html)) !== null) {
      try { blocks.push(JSON.parse(m[1])) } catch {}
    }
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

// Extract the VIN from an EDealer detail page. The old approach —
// `html.match(/[A-HJ-NPR-Z0-9]{17}/)` — grabbed the FIRST 17-char uppercase-alnum
// run anywhere in the HTML, with no label and no boundaries. On EDealer's shared
// template that first run is often a constant token (asset hash, analytics/build
// ID), so EVERY vehicle page returned the SAME "VIN" and the whole inventory
// collapsed to one row ("1 unique · N duplicate VINs merged"). We now prefer an
// explicitly-labeled VIN and only fall back to a properly-bounded standalone token.
function extractEDealerVin(html) {
  const labeled =
       html.match(/"vehicleIdentificationNumber"\s*:\s*"([A-HJ-NPR-Z0-9]{17})"/i)
    || html.match(/data-vin\s*=\s*["']([A-HJ-NPR-Z0-9]{17})["']/i)
    || html.match(/"vin"\s*:\s*"([A-HJ-NPR-Z0-9]{17})"/i)
    || html.match(/\bVIN\b[\s:#>"'\/]*([A-HJ-NPR-Z0-9]{17})\b/i)
  if (labeled) return labeled[1].toUpperCase()

  // Fallback: a standalone 17-char VIN-shaped token bounded by non-alphanumerics
  // on BOTH sides — so we never slice 17 chars out of a longer hash/minified token
  // that repeats on every page.
  const m = html.match(/(?<![A-Za-z0-9])([A-HJ-NPR-Z0-9]{17})(?![A-Za-z0-9])/)
  return m ? m[1].toUpperCase() : null
}

function parseEDealerDetailPage(html, url) {
  const titleMatch = html.match(/<title>([^<]+)<\/title>/i)
  const title = titleMatch ? titleMatch[1].trim() : ''
  const condMatch = title.match(/^(New|Used|Demo|Pre-Owned|Certified Pre-Owned)\b/i)
  const condition = condMatch ? condMatch[1] : null
  const ymmMatch = title.match(/^(?:New|Used|Demo|Pre-Owned|Certified Pre-Owned)?\s*(\d{4})\s+(\S+)\s+(.+?)\s+for Sale/i)
  const year = ymmMatch ? parseInt(ymmMatch[1]) : null
  const make = ymmMatch ? ymmMatch[2] : null
  const model = ymmMatch ? ymmMatch[3] : null
  const metaMatch = html.match(/<meta\s+name="description"[^>]*content="([^"]+)"/i)
  const metaDesc = metaMatch ? metaMatch[1] : ''
  const stockMatch = metaDesc.match(/,\s*([A-Z0-9-]{3,20})\s+available/i)
  const stocknumber = stockMatch ? stockMatch[1] : null
  const priceMatch = metaDesc.match(/\$([\d,]+)/)
  const price = priceMatch ? parseInt(priceMatch[1].replace(/,/g, '')) : 0
  const vin = extractEDealerVin(html)
  const mileageMatch = html.match(/(\d{1,3}(?:,\d{3})*)\s*km\b/i)
  const mileage = mileageMatch ? parseInt(mileageMatch[1].replace(/,/g, '')) : 0
  const imageRe = /https:\/\/media\.edealer\.ca\/w_1920[^"'\s]*?\.webp/g
  const seen = new Set()
  const image_urls = []
  let m
  while ((m = imageRe.exec(html)) !== null) {
    if (!seen.has(m[0])) { seen.add(m[0]); image_urls.push(m[0]) }
  }
  // Need year+make plus at least one identifier (VIN or stock#). Downstream dedup
  // falls back to stock# when VIN is absent, so a missing VIN no longer drops the car.
  if (!year || !make || (!vin && !stocknumber)) return null
  return { vin, year, make, model, price, mileage, stocknumber, condition, onweb: true, salepending: false, image_urls, _detail_url: url }
}

// ── Puppeteer-based full inventory fetcher for JS-rendered EDealer sites ──
// HTTP-only EDealer walker — uses the inventory sitemap (works on every EDealer site
// with Yoast SEO, which is all of them). No Chrome/Puppeteer dependency.
// For 200-300 vehicles this finishes in ~30-60 seconds with concurrency=6.
async function fetchEDealerInventoryFromSitemap(origin) {
  try {
    const smRes = await browserFetch(`${origin}/inventory-listing-sitemap.xml`)
    if (!smRes.ok) {
      console.warn(`[sync] EDealer sitemap missing at ${origin} (HTTP ${smRes.status})`)
      return null
    }
    const xml = await smRes.text()
    // Match every <loc>...vdp/</loc> entry — vdp = vehicle detail page
    let urls = [...xml.matchAll(/<loc>([^<]+\/inventory\/[^<]+vdp\/?)<\/loc>/g)].map(m => m[1])
    if (!urls.length) {
      console.warn(`[sync] EDealer sitemap parsed but contained 0 detail URLs`)
      return null
    }

    // Memory cap: walking too many detail pages on Render's 512MB free tier blows
    // the heap (each page is ~300KB-1MB HTML, decoded to UTF-16 = 2x in V8). For
    // dealers with more inventory than this cap, we sync only the most recent N and
    // log how many were skipped. Configurable via env so upgrades unlock everything.
    const MAX_DETAIL_URLS = parseInt(process.env.MAX_SITEMAP_URLS) || 100
    const totalUrls = urls.length
    if (totalUrls > MAX_DETAIL_URLS) {
      urls = urls.slice(0, MAX_DETAIL_URLS)
      console.warn(`[sync] EDealer sitemap: capping walk at ${MAX_DETAIL_URLS}/${totalUrls} URLs (set MAX_SITEMAP_URLS env to raise)`)
    } else {
      console.log(`[sync] EDealer sitemap: ${urls.length} detail URLs to fetch`)
    }

    // Per-response size limit — a single misbehaving page (e.g. inline base64 photos)
    // could blow heap by itself. Cap reads at 3MB and skip oversized pages.
    const MAX_BYTES = 3 * 1024 * 1024

    const vehicles = []
    let fetched = 0, failed = 0, oversized = 0
    const CONCURRENCY = 3
    for (let i = 0; i < urls.length; i += CONCURRENCY) {
      const batch = urls.slice(i, i + CONCURRENCY)
      const results = await Promise.all(batch.map(async (url) => {
        try {
          const r = await browserFetch(url)
          if (!r.ok) { failed++; return null }
          // Skip oversized responses without decoding the whole body to a string
          const lenHeader = parseInt(r.headers.get('content-length') || '0')
          if (lenHeader > MAX_BYTES) { oversized++; return null }
          let html = await r.text()
          if (html.length > MAX_BYTES) { html = null; oversized++; return null }
          const parsed = parseEDealerDetailPage(html, url)
          html = null  // explicit drop so GC reclaims the 1MB+ string before next batch
          fetched++
          return parsed
        } catch { failed++; return null }
      }))
      vehicles.push(...results.filter(Boolean))
      // Tiny pause between batches lets V8 schedule a young-gen GC pass —
      // measurably reduces peak heap on long walks
      if (i + CONCURRENCY < urls.length) await sleep(50)
    }
    console.log(`[sync] EDealer sitemap walker: ${vehicles.length} valid · ${fetched} fetched · ${failed} failed · ${oversized} oversized`)
    return vehicles.length > 0 ? vehicles : null
  } catch (e) {
    console.warn('[sync] EDealer sitemap walker failed:', e.message)
    return null
  }
}

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

function extractEDealerImagesFromPage(html) {
  const re = /https:\/\/media\.edealer\.ca\/w_1920[^"'\s]*?\.webp/g
  const seen = new Set()
  let m
  while ((m = re.exec(html)) !== null) seen.add(m[0])
  return [...seen]
}

async function fetchEDealerDetailImageGroups(detailUrls, concurrency = 2) {
  const results = new Array(detailUrls.length).fill([])
  for (let i = 0; i < detailUrls.length; i += concurrency) {
    const batch = detailUrls.slice(i, i + concurrency)
    const batchResults = await Promise.all(batch.map(async (url) => {
      try {
        const r = await browserFetch(url)
        if (!r.ok) return []
        return extractEDealerImagesFromPage(await r.text())
      } catch { return [] }
    }))
    batchResults.forEach((imgs, idx) => { results[i + idx] = imgs })
  }
  return results
}

function extractEDealerImageGroups(html) {
  const thumbRe = /https:\/\/media\.edealer\.ca\/w_400[^"'\s]*?\.webp/g
  const fullRe = /https:\/\/media\.edealer\.ca\/w_1920[^"'\s]*?\.webp/g
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

function extractCarsFromJsonLd(nodes) {
  const cars = []
  const seen = new WeakSet()
  const isCar = (node) => {
    const type = node?.['@type']
    if (!type) return false
    const types = Array.isArray(type) ? type : [type]
    return types.some(t => t === 'Car' || t === 'Vehicle' || t === 'MotorVehicle')
  }
  // ITERATIVE walker (no recursion). Yoast SEO + EDealer graphs can produce
  // deeply nested structures (50+ levels) — a recursive version blew Node's
  // stack on production and triggered SIGABRT (exit 134). This version uses
  // an explicit work-queue so it can handle ANY depth in O(nodes) memory.
  const queue = [nodes]
  while (queue.length > 0) {
    const node = queue.pop()
    if (!node) continue
    if (Array.isArray(node)) {
      for (const item of node) queue.push(item)
      continue
    }
    if (typeof node !== 'object') continue
    if (seen.has(node)) continue
    seen.add(node)
    if (isCar(node)) { cars.push(node); continue }
    for (const v of Object.values(node)) {
      if (v && typeof v === 'object') queue.push(v)
    }
  }
  return cars
}

// ── Convertus / motocommerce (VMS) ───────────────────────────────────────────
// Convertus dealer sites (WordPress "achilles" theme) expose none of the standard
// feed paths. Their SRP bundle loads inventory through a SAME-ORIGIN PHP proxy that
// forwards to the VMS API:
//   {origin}/wp-content/plugins/convertus-vms/include/php/ajax-vehicles.php
//       ?endpoint=<url-encoded VMS url>&action=vms_data
// VMS url: https://vms.prod.convertus.rocks/api/filtering/?cp=<inventoryId>&pg=N&pc=100&sc=<class>...
// cp = the dealer's inventoryId, embedded in every page as "inventoryId":"NNNN".
// Hitting the VMS host directly 403s (WAF); going through the dealer's own proxy works.
const CONVERTUS_VMS_FILTERING = 'https://vms.prod.convertus.rocks/api/filtering/'

function extractConvertusInventoryId(html) {
  const m = html.match(/"inventoryId"\s*:\s*"?(\d{1,8})"?/i)
  return m ? m[1] : null
}

function buildConvertusProxyUrl(origin, inventoryId, { page = 1, perPage = 100, saleClass = '' } = {}) {
  const endpoint = `${CONVERTUS_VMS_FILTERING}?cp=${inventoryId}&ln=en&pg=${page}&pc=${perPage}`
    + `&dc=true&sc=${encodeURIComponent(saleClass)}&ai=true&in_stock=true&on_order=true&in_transit=true`
  return `${origin}/wp-content/plugins/convertus-vms/include/php/ajax-vehicles.php`
    + `?endpoint=${encodeURIComponent(endpoint)}&action=vms_data`
}

function mapConvertusVehicle(v) {
  const price = (v.sale_price && v.sale_price > 0 ? v.sale_price : 0)
    || v.internet_price || v.asking_price || v.retail_price || v.msrp || 0
  const image_urls = Array.isArray(v.image)
    ? v.image.map(im => im?.image_original || im?.image_lg || im?.image_md).filter(Boolean)
    : []
  const sc = String(v.sale_class || '').toLowerCase()
  const condition = sc.startsWith('new') ? 'New' : sc.startsWith('used') ? 'Used' : (v.sale_class || null)
  return {
    vin: v.vin || null,
    year: v.year || null,
    make: v.make || null,
    model: v.model || null,
    trim: v.trim || v.search_trim || null,
    stocknumber: v.stock_number || null,
    price,
    saleprice: price,
    mileage: Number(v.odometer) || 0,
    condition,
    demo: v.demo === 1 || v.demo === true,
    exteriorcolor: v.exterior_color || v.manu_exterior_color || null,
    interiorcolor: v.interior_color || null,
    transmission: v.transmission || null,
    fueltype: v.fuel_type || null,
    bodystyle: v.body_style || null,
    image_urls,
    vdp_url: v.vdp_url || null,
    onweb: true,
    salepending: false
  }
}

// Paginate the same-origin proxy for the full inventory. feedType maps to the VMS
// `sc` (sale class) param so "new"/"used" feeds fetch only that subset.
async function fetchConvertusInventory(origin, inventoryId, feedType = 'all') {
  const saleClass = feedType === 'new' ? 'New' : feedType === 'used' ? 'Used' : ''
  const perPage = 100
  const all = []
  let page = 1, total = Infinity
  try {
    while (all.length < total && page <= 50) {
      const url = buildConvertusProxyUrl(origin, inventoryId, { page, perPage, saleClass })
      const r = await browserFetch(url, { headers: { 'Accept': 'application/json, text/plain, */*' } })
      if (!r.ok) { console.warn(`[sync] Convertus page ${page} HTTP ${r.status}`); break }
      let data
      try { data = JSON.parse(await r.text()) } catch { console.warn('[sync] Convertus page not JSON'); break }
      total = Number(data?.summary?.total_vehicles) || all.length
      const results = Array.isArray(data?.results) ? data.results : []
      if (!results.length) break
      all.push(...results.map(mapConvertusVehicle))
      page++
    }
    console.log(`[sync] Convertus: ${all.length}/${total} vehicles (inventoryId=${inventoryId}, sc='${saleClass}')`)
    return all
  } catch (e) {
    console.warn('[sync] Convertus fetch failed:', e.message)
    return all
  }
}

// Detection: fetch the dealer page, pull inventoryId, confirm the proxy returns vehicles.
async function detectConvertus(dealerUrl) {
  try {
    const origin = new URL(dealerUrl).origin
    const pageRes = await browserFetch(dealerUrl)
    if (!pageRes.ok) return null
    const html = await pageRes.text()
    if (!/convertus|achilles/i.test(html)) return null
    const inventoryId = extractConvertusInventoryId(html)
    if (!inventoryId) return null
    const url = buildConvertusProxyUrl(origin, inventoryId, { page: 1, perPage: 100, saleClass: '' })
    const r = await browserFetch(url, { headers: { 'Accept': 'application/json, text/plain, */*' } })
    if (!r.ok) return null
    let data
    try { data = JSON.parse(await r.text()) } catch { return null }
    const results = Array.isArray(data?.results) ? data.results : []
    if (!results.length) return null
    return {
      success: true,
      platform: 'convertus',
      platform_label: 'Convertus (VMS)',
      feed_url: url,
      source_dealer_url: origin,
      vehicle_count: Number(data?.summary?.total_vehicles) || results.length,
      sample_vehicles: results.slice(0, 3).map(mapConvertusVehicle)
    }
  } catch (e) {
    console.warn('[probe] Convertus detection failed:', e.message)
    return null
  }
}

// ── DealerPage (dealerpage.ca) — server-rendered WordPress dealer theme ─────────
// These sites expose NO JSON feed and fire NO inventory XHR (the listing HTML is
// server-rendered), so neither the static path probes nor the headless SPA-render
// fallback catch them — every probe just hits the WordPress soft-404 (HTTP 200 +
// homepage HTML). We parse the /vehicles/ listing page directly: each card is an
// <a itemprop="url"> wrapper containing a CarGurus VIN/price span, labelled text
// (Mileage / Stock #), and a lazy-loaded image whose real URL sits in data-lazy-src.
function decodeHtmlEntities(s) {
  return String(s || '')
    .replace(/&#0?38;|&amp;/g, '&')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&#x2f;|&#47;/gi, '/')
}

function parseDealerPageHtml(html) {
  const anchorRe = /<a\b[^>]*\bitemprop="url"[^>]*>/gi
  const starts = []
  let m
  while ((m = anchorRe.exec(html)) !== null) starts.push(m.index)

  const vehicles = []
  for (let k = 0; k < starts.length; k++) {
    const chunk = html.slice(starts[k], k + 1 < starts.length ? starts[k + 1] : starts[k] + 9000)
    const href = (chunk.match(/<a\b[^>]*>/)?.[0].match(/href="([^"]+)"/) || [])[1] || null
    const img = (chunk.match(/data-lazy-src="([^"]+)"/) || chunk.match(/itemprop="image"[^>]+src="(https?:\/\/[^"]+)"/) || [])[1] || null
    const alt = (chunk.match(/alt="([^"]*)"/) || [])[1] || ''
    const text = chunk.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
    // Prefer the CarGurus widget data attrs, but fall back to the visible text so
    // dealers WITHOUT the CarGurus integration still get VIN + price.
    const vin = (chunk.match(/data-cg-vin="([^"]*)"/) || [])[1]
      || (text.match(/\bVIN[:\s#]*([A-HJ-NPR-Z0-9]{11,17})\b/i) || [])[1] || null
    const priceRaw = (chunk.match(/data-cg-price="([^"]*)"/) || [])[1]
      || (text.match(/(?:Dealer Price|Sale Price|Our Price|Price)[:\s]*\$\s*([\d,]+(?:\.\d+)?)/i) || [])[1]?.replace(/,/g, '') || null
    // Accept KM (Canada) or Miles (US).
    const mileage = (text.match(/(?:Mileage|Odometer)[:\s]*([\d,]+)\s*(?:KM|Miles|mi)\b/i) || [])[1]?.replace(/,/g, '') || null
    const stock = (text.match(/Stock\s*#?\s*:?\s*([A-Za-z0-9-]+)/i) || [])[1] || null
    const trans = (text.match(/Transmission\s+(.+?)\s+(?:Dealer Price|Price|Details|Get|Book|Apply)/i) || [])[1] || null
    const condition = (/\bUsed\b/i.test(text)) ? 'Used' : (/\bNew\b/i.test(text) ? 'New' : null)
    // Sold detection: DealerPage keeps sold cars on the listing page, flagged via the
    // schema.org availability ("Sold!") and a "SOLD" image overlay. Mark them so they
    // import as status:'sold' (shown in the catalog, but NOT offered for posting).
    const sold = /itemprop="availability"[^>]*>[^<]*sold/i.test(chunk)
      || /<p[^>]*>\s*SOLD\s*<\/p>/i.test(chunk)

    const toks = decodeHtmlEntities(alt).trim().split(/\s+/)
    const year = /^(19|20)\d{2}$/.test(toks[0] || '') ? toks[0] : null
    if (!vin && !year) continue   // not a real card

    vehicles.push({
      vin,
      year,
      make: toks[1] || null,
      model: toks[2] || null,
      trim: toks.slice(3).join(' ') || null,
      price: priceRaw ? Number(priceRaw) : null,
      mileage: mileage ? Number(mileage) : null,
      stock_number: stock,
      transmission: trans ? trans.trim() : null,
      condition,
      sold,
      vdp_url: href,
      images: img ? [decodeHtmlEntities(img)] : []
    })
  }
  return vehicles
}

// Fetch + parse a DealerPage listing page into canonical vehicle records.
async function fetchDealerPageInventory(pageUrl) {
  const r = await browserFetch(`${pageUrl}${pageUrl.includes('?') ? '&' : '?'}v=${Date.now()}`, {
    headers: { 'Accept': 'text/html,application/xhtml+xml' }
  })
  if (!r.ok) return []
  const html = await r.text()
  return parseDealerPageHtml(html).map(v => ({ ...genericMapVehicle(v), sold: v.sold, vdp_url: v.vdp_url, _detail_url: v.vdp_url }))
}

async function detectDealerPage(dealerUrl) {
  try {
    const origin = new URL(dealerUrl).origin
    // Listing page candidates, most-likely first. DealerPage uses /vehicles/.
    const candidates = [...new Set([dealerUrl, `${origin}/vehicles/`, `${origin}/inventory/`])]
    for (const url of candidates) {
      const r = await browserFetch(url)
      if (!r.ok) continue
      const html = await r.text()
      const isDealerPage = /dealerpage\.ca|dealersite-inventory/i.test(html)
        || (/data-cg-vin=/.test(html) && /itemprop="url"/.test(html))
      if (!isDealerPage) continue
      const raw = parseDealerPageHtml(html)
      if (!raw.length) continue
      return {
        success: true,
        platform: 'dealerpage',
        platform_label: 'DealerPage',
        feed_url: url,
        source_dealer_url: origin,
        vehicle_count: raw.length,
        sample_vehicles: raw.slice(0, 3).map(genericMapVehicle)
      }
    }
    return null
  } catch (e) {
    console.warn('[probe] DealerPage detection failed:', e.message)
    return null
  }
}

async function probeUrl(url, timeoutMs = 8000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await browserFetch(url, {
      signal: controller.signal,
      headers: { 'Accept': 'application/json, text/plain, */*', 'Sec-Fetch-Dest': 'empty', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Site': 'same-origin' }
    })
    clearTimeout(timer)
    // Cloudflare/WAF block — signal to the caller that a real-browser retry may help.
    if (res.status === 403 || res.status === 503) return { ok: false, status: res.status, blocked: true }
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

async function detectFeedPlatform(dealerUrl) {
  let origin
  try {
    origin = new URL(dealerUrl.trim()).origin
  } catch {
    return { success: false, error: 'Invalid URL' }
  }

  const attempts = []
  const blockedJsonProbes = []  // { platform, url } for JSON probes that 403/503'd (likely Cloudflare)

  for (const platform of PLATFORM_PROBES) {
    const urls = platform.htmlProbe ? [dealerUrl] : platform.buildUrls(origin)
    for (const url of urls) {
      const result = platform.htmlProbe ? await probeUrlHtml(url) : await probeUrl(url)
      const probeData = platform.htmlProbe ? result : result.data
      attempts.push({
        platform: platform.platform, label: platform.label, url,
        ok: result.ok, status: result.status, reason: result.reason
      })
      if (result.blocked && !platform.htmlProbe) blockedJsonProbes.push({ platform: platform.platform, url })

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
          attempts
        }
      }
    }
  }

  // Cloudflare / WAF escalation: if static probes were BLOCKED (403/503) rather than
  // simply absent, the JSON feed likely exists but is gated behind bot protection.
  // Retry the blocked JSON endpoints through real Chrome (one warmed session that
  // clears any JS challenge), then validate/extract exactly as the static path would.
  if (blockedJsonProbes.length) {
    console.log(`[probe] ${blockedJsonProbes.length} probe(s) blocked (403/503) — retrying via headless Chrome`)
    try {
      const results = await fetchUrlsViaBrowser(blockedJsonProbes.map(p => p.url))
      for (const r of results) {
        if (!r.ok || !r.body) continue
        let data
        try { data = JSON.parse(r.body) } catch { continue }
        const ref = blockedJsonProbes.find(p => p.url === r.url)
        const platform = ref && PLATFORM_PROBES.find(pp => pp.platform === ref.platform)
        if (!platform || !platform.validate(data)) continue
        const vehicles = platform.extract(data)
        console.log(`[probe] Cloudflare-bypassed feed via Chrome: ${vehicles.length} vehicles from ${r.url}`)
        return {
          success: true,
          platform: platform.platform,
          platform_label: platform.label,
          feed_url: r.url,
          vehicle_count: vehicles.length,
          sample_vehicles: vehicles.slice(0, 3).map(platform.mapVehicle),
          cloudflare_bypassed: true,
          attempts
        }
      }
    } catch (e) {
      console.warn(`[probe] headless Cloudflare retry failed: ${e.message}`)
    }
  }

  // Convertus / motocommerce (VMS) sites hide inventory behind a same-origin proxy;
  // none of the static paths match. Detect via the listing page's inventoryId.
  const convertus = await detectConvertus(dealerUrl)
  if (convertus) {
    console.log(`[probe] Convertus detected: ${convertus.vehicle_count} vehicles`)
    return { ...convertus, attempts }
  }

  // DealerPage (dealerpage.ca) — server-rendered HTML, no JSON feed / no XHR.
  const dealerpage = await detectDealerPage(dealerUrl)
  if (dealerpage) {
    console.log(`[probe] DealerPage detected: ${dealerpage.vehicle_count} vehicles`)
    return { ...dealerpage, attempts }
  }

  // Fallback: render the SPA in a headless browser and watch for the inventory XHR.
  // Catches UX Auto, pure DealerInspire SPAs, and most other JS-rendered dealer sites.
  console.log(`[probe] No static probe matched — rendering ${dealerUrl} with headless Chromium`)
  try {
    const rendered = await renderAndCaptureInventory(dealerUrl)
    if (rendered.success && rendered.vehicles?.length > 0) {
      console.log(`[probe] Headless capture: ${rendered.vehicles.length} vehicles from ${rendered.source_url}`)
      return {
        success: true,
        platform: 'spa_render',
        platform_label: 'SPA (headless render)',
        feed_url: rendered.source_url,
        vehicle_count: rendered.vehicles.length,
        sample_vehicles: rendered.sample.map(genericMapVehicle),
        attempts: [...attempts, ...(rendered.attempts || [])]
      }
    }
    attempts.push({ platform: 'spa_render', label: 'SPA (headless render)', ok: false, reason: rendered.error })
  } catch (e) {
    attempts.push({ platform: 'spa_render', label: 'SPA (headless render)', ok: false, reason: e.message })
  }

  // If most probes were blocked (403/503) by a WAF and every fallback also failed,
  // this is almost certainly a Cloudflare IP-reputation block: server-side access —
  // INCLUDING our headless Chrome on Render — can't get through, because the block is
  // on the datacenter IP/ASN, not a solvable JS challenge. The user must use the
  // MarketSync Chrome extension, which captures from their own (residential) browser.
  const blockedCount = attempts.filter(a => a.status === 403 || a.status === 503).length
  const cloudflareBlocked = blockedCount >= 3
  return {
    success: false,
    cloudflare_blocked: cloudflareBlocked,
    error: cloudflareBlocked
      ? "This dealer site is protected by Cloudflare and blocks server-side access (the block is on the server's IP, so it can't be bypassed from our end). Use the MarketSync Chrome extension on the dealer's inventory page to capture vehicles directly from your browser."
      : 'No known inventory feed found for this dealer URL. Try pasting the direct JSON feed URL instead.',
    attempts
  }
}

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

// ── EXTENSION-SIDE INVENTORY CAPTURE ───────────────────────────────────────
// The user's Chrome extension (dealer-extract.js) fetched inventory from
// inside their authenticated browser session and is uploading it here. Used
// for dealer sites our backend can't reach (Cloudflare, custom auth, etc.).
//
// Payload: { vehicles: [...], source_url, platform }
// `feed_id` from the URL path must belong to req.dealershipId.
app.post('/feeds/:id/extension-capture', requireAuth, async (req, res) => {
  const feedId = req.params.id
  const { vehicles, source_url, platform } = req.body || {}

  if (!Array.isArray(vehicles)) {
    return res.status(400).json({ error: 'vehicles array required' })
  }

  // Verify the caller owns this feed
  const { data: feed, error: feedErr } = await supabaseAdmin
    .from('inventory_feeds')
    .select('id, dealership_id, feed_url, platform')
    .eq('id', feedId)
    .single()
  if (feedErr || !feed) return res.status(404).json({ error: 'Feed not found' })
  if (feed.dealership_id !== req.dealershipId) {
    return res.status(403).json({ error: 'Feed does not belong to your dealership' })
  }

  // Stamp the feed so the dashboard can show "last captured via extension".
  // Preserve the needs_extension_capture marker for Cloudflare-protected feeds so
  // the extension bar + dashboard warning keep showing (the server still can't sync
  // these; they must always be re-captured via the browser). Record when we last did.
  await supabaseAdmin
    .from('inventory_feeds')
    .update({
      platform: feed.platform === 'needs_extension_capture' ? 'needs_extension_capture' : (platform || 'extension_capture'),
      last_extension_sync_at: new Date().toISOString(),
      source_dealer_url: source_url || feed.feed_url
    })
    .eq('id', feedId)

  // Upsert each vehicle. Re-uses the same record shape as runInventorySync
  // so the dashboard catalog / sold-tracking / leaderboard all just work.
  const hasFeedId = await inventoryHasFeedId()
  let upserted = 0, skipped = 0
  for (const v of vehicles) {
    // The probe inside the extension already runs roughly the same field
    // normalization as PLATFORM_PROBES.mapVehicle. Apply the canonical mapper
    // here too so weirdly-shaped feeds still land in the right columns.
    const probe = PLATFORM_PROBES.find(p => p.platform === platform)
    const mapped = probe?.mapVehicle ? { ...v, ...probe.mapVehicle(v) } : v

    if (!mapped.vin && !mapped.stocknumber) { skipped++; continue }
    if (!matchesFeedType(mapped, 'all')) { skipped++; continue }

    const effectiveVin = mapped.vin || `STK-${req.dealershipId.slice(0, 8)}-${mapped.stocknumber}`

    const record = {
      dealership_id: req.dealershipId,
      vin: effectiveVin,
      year: parseInt(mapped.year) || null,
      make: mapped.make,
      model: mapped.model,
      trim: mapped.trim || null,
      price: mapped.saleprice || mapped.price || 0,
      mileage: mapped.mileage || 0,
      condition: mapped.condition || null,
      exterior_color: mapped.exteriorcolor || null,
      interior_color: mapped.interiorcolor || null,
      transmission: mapped.transmission || null,
      fuel_type: mapFuel(mapped.fueltype),
      description: buildDescription(mapped),
      image_urls: Array.isArray(mapped.image_urls) ? mapped.image_urls : [],
      source_url: buildSourceUrl({ ...feed, platform, url_template: null, url_map: null }, mapped),
      status: mapped.salepending ? 'pending' : 'available',
      last_synced_at: new Date().toISOString(),
      ...(hasFeedId ? { feed_id: feedId } : {})
    }

    const { error } = await supabaseAdmin
      .from('inventory')
      .upsert(record, { onConflict: 'vin' })
    if (error) { skipped++; continue }
    upserted++
  }

  console.log(`[extension-capture] feed=${feedId} upserted=${upserted} skipped=${skipped}`)
  res.json({ success: true, upserted, skipped, total: vehicles.length })
})

function normalizeFeedUrl(input) {
  if (!input) return null
  let url
  try { url = new URL(input.trim()) } catch { return null }

  const path = url.pathname.toLowerCase()
  let detectedType = null
  if (path.includes('new-inventory') || path.includes('/new/') || path.includes('/new?')) detectedType = 'new'
  else if (path.includes('used-inventory') || path.includes('/used/') || path.includes('/used?')) detectedType = 'used'
  else if (path.includes('demo-inventory') || path.includes('/demo/')) detectedType = 'demo'
  else if (path.includes('/fleet')) detectedType = 'fleet'

  if (path.endsWith('.json')) return { jsonUrl: url.toString(), detectedType }

  const origin = url.origin
  const host = url.hostname.toLowerCase()

  if (host.includes('edealer')) return { jsonUrl: `${origin}/api/inventory/getall`, detectedType }
  if (host.includes('dealerinspire') || host.includes('di-uploads')) return { jsonUrl: `${origin}/wp-json/di-wp/v2/inventory`, detectedType }
  if (host.includes('dealer.com')) return { jsonUrl: `${origin}/apis/widget/INVENTORY_LISTING_DEFAULT_AUTO_ALL:inventory-data-bus1/getInventory`, detectedType }
  if (host.includes('sincro') || host.includes('dealeron')) return { jsonUrl: `${origin}/api/inventory/vehicles`, detectedType }
  if (host.includes('vicimus') || host.includes('glovebox')) return { jsonUrl: `${origin}/api/inventory`, detectedType }
  if (host.includes('sm360')) return { jsonUrl: `${origin}/api/inventory/list`, detectedType }
  if (host.includes('cdk') || host.includes('cobalt')) return { jsonUrl: `${origin}/inventory/api/vehicles`, detectedType }
  if (host.includes('dealerfire') || host.includes('solera')) return { jsonUrl: `${origin}/ws/getData.php?type=inventory`, detectedType }

  return { jsonUrl: `${origin}/wp-content/uploads/data/inventory.json`, detectedType }
}

function matchesFeedType(v, feedType) {
  if (!feedType || feedType === 'all' || feedType === 'fleet') return true
  if (feedType === 'new') return v.condition === 'New' && !v.demo
  if (feedType === 'used') return v.condition === 'Used'
  if (feedType === 'demo') return v.demo === true
  return true
}

// ── Helper: build condition-based source URL for LeadBox sites ──
// Generic source URL resolver — works for ANY feed (LeadBox, EDealer, custom JSON, etc.)
// Strategy: try the most specific URL we have, fall back to progressively broader pages.
// Guarantees a non-404 link to the dealer's site for every vehicle.
function buildSourceUrl(feed, vehicle) {
  // 1. EDealer sitemap walker (and any future walker) provides the actual detail URL
  if (vehicle._detail_url
      && typeof vehicle._detail_url === 'string'
      && vehicle._detail_url.startsWith('http')
      && !vehicle._detail_url.endsWith('/inventory/')) {
    return vehicle._detail_url
  }

  // 2. Some feeds include the vehicle's own detail URL inline. Check a wide set of
  //    field names — LeadBox/others vary (vdpUrl, vehicle_url, link, href, etc.).
  const explicit = vehicle.url || vehicle.permalink || vehicle.detailUrl || vehicle.detail_url
                || vehicle.vdpurl || vehicle.vdpUrl || vehicle.vdp_url || vehicle.thirdpartyvdpurl
                || vehicle.vehicleUrl || vehicle.vehicle_url || vehicle.vehicleURL
                || vehicle.link || vehicle.href || vehicle.detailURL || vehicle.detailsUrl
  if (typeof explicit === 'string' && explicit.startsWith('http')) return explicit

  // 2b. LeadBox: build the deterministic, verified VDP URL up front. LeadBox ships
  //     no inline per-vehicle URL, and the harvested url_map / category fallback were
  //     producing 404s — so prefer this exact pattern over those when we can build a
  //     complete slug. (Falls through to url_map/category only if a field is missing.)
  if (isLeadBoxFeed(feed)) {
    const lb = buildLeadBoxVdpUrl(feed.feed_url, vehicle)
    if (lb) return lb
  }

  // 3. UNIVERSAL: inferred url_template — applies to ANY dealer site. Set once
  //    per feed by inferUrlTemplate() during the first sync after feed-add.
  if (feed.url_template) {
    const rendered = renderUrlTemplate(feed.url_template, vehicle)
    if (rendered && rendered.startsWith('http')) return rendered
  }

  // 4. Per-feed harvested URL map (fallback for platforms that haven't inferred a template)
  if (feed.url_map && vehicle.stocknumber) {
    const fromMap = feed.url_map[String(vehicle.stocknumber)]
    if (typeof fromMap === 'string' && fromMap.startsWith('http')) return fromMap
  }

  // 5. LeadBox-specific category fallback (last-resort, guaranteed not to 404)
  if (feed.feed_url && feed.feed_url.includes('/wp-content')) {
    return buildLeadBoxSourceUrl(feed.feed_url, vehicle)
  }

  // 6. If the saved feed_url is a viewable HTML page (not raw JSON), use it as-is
  if (feed.feed_url && !feed.feed_url.toLowerCase().endsWith('.json')) {
    return feed.feed_url
  }

  // 7. Last resort: dealer's homepage (origin only) — never 404s
  try { return new URL(feed.feed_url).origin } catch { return feed.feed_url || null }
}

// LeadBox dealers don't expose a consistent per-vehicle URL pattern across all sites
// (we tested /inventory/{stock}/, /vehicle/{stock}/, /vehicles/{stock}/, /?p={stock} —
// every one of them 404s on most dealer instances). Until we can probe each dealer's real
// detail URL at feed-add time, fall back to the category listing page — it always works
// and the visitor can find the specific car from there. EDealer + any feed that ships an
// explicit per-vehicle URL is handled via `_detail_url` instead and never hits this fn.
function buildLeadBoxSourceUrl(feedUrl, vehicle) {
  const origin = feedUrl.split('/wp-content')[0]

  // Prefer the deterministic per-vehicle VDP, then any explicit inline URL.
  const vdp = buildLeadBoxVdpUrl(feedUrl, vehicle)
  if (vdp) return vdp
  const explicit = vehicle.url || vehicle.permalink || vehicle.detailUrl || vehicle.detail_url
                || vehicle.vdpurl || vehicle.thirdpartyvdpurl
  if (typeof explicit === 'string' && explicit.startsWith('http')) return explicit

  // Category listing — last resort when we can't build a per-vehicle slug
  if (vehicle.condition === 'New') return `${origin}/new-vehicles/`
  if (vehicle.condition === 'Used') return `${origin}/used-vehicles/`
  if (vehicle.demo) return `${origin}/demo-inventory/`
  return `${origin}/vehicles/`
}

function isLeadBoxFeed(feed) {
  return feed?.platform === 'leadbox'
    || (typeof feed?.feed_url === 'string' && feed.feed_url.includes('/wp-content/uploads/data/inventory.json'))
}

// Build LeadBox's verified VDP URL: {origin}/view/{condition}-{year}-{make}-{model}-{id}/
// (lowercased, non-alphanumeric runs → single hyphen). The trailing id is LeadBox's
// internal vehicle `id` field — NOT the stock number. Returns null if any slug part
// is missing so callers can fall back. Verified against live wellandchev.com listings.
function buildLeadBoxVdpUrl(feedUrl, vehicle) {
  const origin = typeof feedUrl === 'string' && feedUrl.includes('/wp-content')
    ? feedUrl.split('/wp-content')[0]
    : (() => { try { return new URL(feedUrl).origin } catch { return null } })()
  if (!origin) return null
  const id = vehicle.id || vehicle.vehicle_id || vehicle.leadbox_id
  const condition = vehicle.condition || (vehicle.demo ? 'Demo' : null)
  if (!id || !vehicle.year || !vehicle.make || !vehicle.model || !condition) return null
  const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  const path = `${slug(condition)}-${vehicle.year}-${slug(vehicle.make)}-${slug(vehicle.model)}-${id}`
  return `${origin}/view/${path}/`
}

// Per-dealership in-flight sync tracking. Prevents the boot sync, the post-add
// auto-sync, and a manual Sync Now click from all running for the same dealership
// at the same time — that overlap was the cause of "Exited with status 134" (OOM
// from multiple large feed parses overlapping in memory).
const _syncsInFlight = new Map()  // dealershipId → Promise<result>

// Live sync progress, keyed by dealershipId, so the dashboard's Sync button can
// poll an accurate percentage and the user knows it isn't frozen. In-memory only
// (fine for our single Render instance); entries self-expire shortly after a sync
// finishes. Overall pct blends feed index + per-feed import fraction so it climbs
// smoothly 0→100 even across multiple feeds.
const syncProgress = new Map()  // dealershipId → { phase, feedIndex, feedCount, current, total, pct, message, updatedAt }

function setSyncProgress(dealershipId, patch) {
  const prev = syncProgress.get(dealershipId) || {}
  syncProgress.set(dealershipId, { ...prev, ...patch, updatedAt: Date.now() })
}

function syncOverallPct(feedIndex, feedCount, current, total) {
  if (!feedCount) return 0
  const feedFraction = total > 0 ? current / total : 0
  // Cap at 99 until the run fully finalizes (delete-diff + count queries still run).
  return Math.min(99, Math.round(((feedIndex + feedFraction) / feedCount) * 100))
}

// Feature-detect the inventory.feed_id column once per process. Lets us tag each
// vehicle with the feed that produced it (precise, cascade-safe deletes) WITHOUT
// breaking sync if the migration hasn't been run yet — we just omit the column.
let _invHasFeedId = null
async function inventoryHasFeedId() {
  if (_invHasFeedId !== null) return _invHasFeedId
  const { error } = await supabaseAdmin.from('inventory').select('feed_id').limit(1)
  _invHasFeedId = !error
  if (error) console.warn('[sync] inventory.feed_id column missing — run the migration for precise feed-scoped deletes (falling back to origin matching)')
  return _invHasFeedId
}

async function runInventorySync(dealershipId) {
  if (_syncsInFlight.has(dealershipId)) {
    console.log(`[sync] piggy-backing on in-flight sync for ${dealershipId}`)
    return _syncsInFlight.get(dealershipId)
  }
  setSyncProgress(dealershipId, { phase: 'starting', feedIndex: 0, feedCount: 0, current: 0, total: 0, pct: 0, message: 'Starting sync…' })
  const promise = _runInventorySyncInner(dealershipId)
  _syncsInFlight.set(dealershipId, promise)
  try {
    const result = await promise
    setSyncProgress(dealershipId, { phase: 'done', pct: 100, message: 'Sync complete.' })
    return result
  } catch (e) {
    setSyncProgress(dealershipId, { phase: 'error', message: e.message || 'Sync failed.' })
    throw e
  } finally {
    _syncsInFlight.delete(dealershipId)
    // Keep the terminal state briefly so a final poll can read 100%/error, then drop it.
    const ds = dealershipId
    setTimeout(() => syncProgress.delete(ds), 15000)
  }
}

async function _runInventorySyncInner(dealershipId) {
  // Defensive: ask for the new columns first; if any is missing (migration not yet run),
  // retry with the legacy column set so sync still works. Surfaces a clear warning instead
  // of silently flipping to "No inventory feeds configured".
  let feeds = null
  let selectError = null
  {
    const { data, error } = await supabaseAdmin
      .from('inventory_feeds')
      .select('id, feed_url, feed_type, platform, source_dealer_url, url_map, url_template')
      .eq('dealership_id', dealershipId)
    if (!error) { feeds = data }
    else selectError = error
  }
  if (!feeds) {
    console.warn(`[sync] full column select failed (${selectError?.message}) — falling back to legacy columns`)
    const { data, error } = await supabaseAdmin
      .from('inventory_feeds')
      .select('id, feed_url, feed_type')
      .eq('dealership_id', dealershipId)
    if (error) {
      console.error('[sync] legacy column select also failed:', error.message)
      return { success: false, error: `Could not read inventory feeds: ${error.message}` }
    }
    feeds = data
  }
  if (!feeds || feeds.length === 0) {
    return { success: false, error: 'No inventory feeds configured for this dealership.' }
  }

  let totalAttempts = 0, totalSkipped = 0, totalVehiclesFound = 0
  // Aggregate skip reasons across all feeds for this dealership — surfaced in the API
  // response so the dashboard can show exactly WHY vehicles got rejected. Beats reading
  // Render logs to debug a sync.
  const skipReasons = { feed_type: 0, offline: 0, no_identifier: 0, upsert_error: 0 }
  const uniqueVins = new Set()  // VINs successfully upserted this run
  const allRawVins = new Set()  // every VIN from raw feed data (no filter) — for auto-sold

  const jsonCache = new Map()
  const hasFeedId = await inventoryHasFeedId()

  let feedIndex = -1
  for (const feed of feeds) {
    feedIndex++
    setSyncProgress(dealershipId, {
      phase: 'fetching', feedIndex, feedCount: feeds.length, current: 0, total: 0,
      pct: syncOverallPct(feedIndex, feeds.length, 0, 0),
      message: feeds.length > 1 ? `Fetching inventory (feed ${feedIndex + 1}/${feeds.length})…` : 'Fetching inventory…'
    })
    try {
      let vehicles

      // Match this feed to its probe definition so we can apply the right field mapper
      const probe = PLATFORM_PROBES.find(p => p.platform === feed.platform)

      // ── URL DISCOVERY (puppeteer-gated) ─────────────────────────────────────
      // Browser-based template inference + URL harvest are MEMORY HUNGRY (~200MB
      // per Chromium instance). On Render's free tier they push the process past
      // its 512MB limit and crash the sync mid-run. The deterministic builders
      // in buildSourceUrl already cover LeadBox + UX Auto (the two platforms we
      // actually use), so this puppeteer-based discovery is now opt-in only.
      //
      // To re-enable on a beefier instance, set ENABLE_PUPPETEER_DISCOVERY=1 in
      // Render → Environment. The deterministic builders run regardless.
      if (process.env.ENABLE_PUPPETEER_DISCOVERY === '1' && !feed.url_template) {
        try {
          console.log(`[sync] Inferring url_template for feed ${feed.id} (${feed.platform || 'unknown'})...`)
          const dealerSite = feed.source_dealer_url
            || (feed.feed_url?.includes('/wp-content') ? feed.feed_url.split('/wp-content')[0] : null)
            || (() => { try { return new URL(feed.feed_url).origin } catch { return null } })()
          if (dealerSite) {
            let feedJson = null
            try {
              const feedRes = await fetch(feed.feed_url, {
                headers: {
                  'Accept': 'application/json',
                  'Origin': feed.source_dealer_url ? new URL(feed.source_dealer_url).origin : '',
                  'Referer': feed.source_dealer_url || ''
                }
              })
              feedJson = await feedRes.json().catch(() => null)
            } catch {}
            const samples = feedJson?.vehicles || feedJson?.records || (Array.isArray(feedJson) ? feedJson : [])
            if (samples.length) {
              const inferred = await inferUrlTemplate(dealerSite, samples)
              if (inferred.ok && inferred.template) {
                await supabaseAdmin
                  .from('inventory_feeds')
                  .update({ url_template: inferred.template })
                  .eq('id', feed.id)
                feed.url_template = inferred.template
                console.log(`[sync] ✓ Inferred template (via ${inferred.matched_by}): ${inferred.template}`)
              } else {
                console.warn(`[sync] Template inference failed: ${inferred.error}`)
              }
            }
          }
        } catch (e) {
          console.warn(`[sync] url_template inference failed (non-fatal): ${e.message}`)
        }
      }

      if (jsonCache.has(feed.feed_url)) {
        vehicles = jsonCache.get(feed.feed_url)
      } else if (feed.platform === 'spa_render') {
        // SPA dealer. The captured XHR URL almost always works for plain HTTP fetches —
        // try that first (fast). Re-render the dealer site only if direct fetch fails
        // (XHR URL broken, auth rotated, dealer moved). When re-render finds a new URL,
        // update the stored feed_url so future syncs use it.
        vehicles = []
        let usedFreshUrl = null

        try {
          const r = await fetch(`${feed.feed_url}?v=${Date.now()}`, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36',
              'Accept': 'application/json',
              'Origin': feed.source_dealer_url ? new URL(feed.source_dealer_url).origin : '',
              'Referer': feed.source_dealer_url || ''
            }
          })
          const ct = r.headers.get('content-type') || ''
          if (r.ok && ct.includes('json')) {
            const data = await r.json()
            const raw = data.records || data.vehicles || data.data || data.inventory || (Array.isArray(data) ? data : [])
            if (raw.length > 0) {
              vehicles = raw.map(genericMapVehicle)
              console.log(`[sync] SPA direct fetch: ${vehicles.length} vehicles from ${feed.feed_url}`)
            }
          }
        } catch (e) {
          console.warn(`[sync] SPA direct fetch failed for ${feed.feed_url}: ${e.message}`)
        }

        // Direct fetch returned nothing → re-render the dealer's listing page
        if (vehicles.length === 0 && feed.source_dealer_url) {
          console.log(`[sync] SPA direct fetch returned 0 — re-rendering ${feed.source_dealer_url}`)
          const rendered = await renderAndCaptureInventory(feed.source_dealer_url)
          if (rendered.success && rendered.vehicles?.length > 0) {
            vehicles = rendered.vehicles.map(genericMapVehicle)
            usedFreshUrl = rendered.source_url
            console.log(`[sync] SPA re-render: ${vehicles.length} vehicles from ${rendered.source_url}`)
          } else {
            console.warn(`[sync] SPA re-render also failed: ${rendered.error}`)
          }
        }

        // Persist the new XHR URL if re-render found a different one
        if (usedFreshUrl && usedFreshUrl !== feed.feed_url) {
          await supabaseAdmin
            .from('inventory_feeds')
            .update({ feed_url: usedFreshUrl })
            .eq('id', feed.id)
          console.log(`[sync] Updated feed_url for feed ${feed.id} → ${usedFreshUrl}`)
        }

        jsonCache.set(feed.feed_url, vehicles)
        totalVehiclesFound += vehicles.length
      } else if (feed.platform === 'convertus') {
        // Convertus/VMS — re-derive origin + inventoryId from the stored proxy feed_url
        // and paginate the same-origin proxy for the full inventory.
        const origin = (() => { try { return new URL(feed.feed_url).origin } catch { return null } })()
        const cpMatch = decodeURIComponent(feed.feed_url).match(/[?&]cp=(\d+)/)
        const inventoryId = cpMatch ? cpMatch[1] : null
        if (origin && inventoryId) {
          vehicles = await fetchConvertusInventory(origin, inventoryId, feed.feed_type)
        } else {
          console.warn(`[sync] Convertus feed ${feed.id} missing origin/inventoryId in feed_url`)
          vehicles = []
        }
        jsonCache.set(feed.feed_url, vehicles)
        totalVehiclesFound += vehicles.length
      } else if (feed.platform === 'dealerpage') {
        // DealerPage — re-fetch & re-parse the listing HTML each sync (real photo
        // URLs are in the page, so no detail-page enrichment is needed).
        vehicles = await fetchDealerPageInventory(feed.feed_url)
        jsonCache.set(feed.feed_url, vehicles)
        totalVehiclesFound += vehicles.length
      } else if (feed.platform === 'ux_auto') {
        // UX Auto splits inventory across /NEW, /USED, /DEMO endpoints — fetch all three
        const base = feed.feed_url.replace(/\/(NEW|USED|DEMO|new|used|demo)\/?$/, '')
        const conditions = ['NEW', 'USED', 'DEMO']
        const all = []
        for (const cond of conditions) {
          try {
            const r = await browserFetch(`${base}/${cond}?v=${Date.now()}`, {
              headers: { 'Accept': 'application/json' }
            })
            if (!r.ok) continue
            const d = await r.json()
            if (d?.result === 'Success' && Array.isArray(d.records)) all.push(...d.records)
          } catch {}
        }
        vehicles = all
        jsonCache.set(feed.feed_url, vehicles)
        totalVehiclesFound += vehicles.length
      } else {
        const feedRes = await browserFetch(`${feed.feed_url}?v=${Date.now()}`, {
          headers: { 'Accept': 'application/json, text/plain, */*', 'Sec-Fetch-Dest': 'empty', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Site': 'same-origin' }
        })
        let ct = feedRes.headers.get('content-type') || ''

        // Read the body once. On a Cloudflare/WAF block (403/503), refetch through
        // real Chrome so the JS challenge clears and we get the actual feed body.
        let bodyText
        if (feedRes.status === 403 || feedRes.status === 503) {
          console.log(`[sync] feed ${feed.feed_url} blocked (HTTP ${feedRes.status}) — retrying via headless Chrome`)
          const br = await fetchViaBrowser(`${feed.feed_url}?v=${Date.now()}`)
          bodyText = br.ok ? br.body : ''
          if (br.contentType) ct = br.contentType
        } else {
          bodyText = await feedRes.text()
        }

        const looksJson = ct.includes('json') || /^\s*[\[{]/.test(bodyText || '')
        if (looksJson) {
          let data = null
          try { data = JSON.parse(bodyText) } catch {}
          vehicles = data ? (data.vehicles || data.inventory || data.data || data.items || data.records || (Array.isArray(data) ? data : [])) : []
          jsonCache.set(feed.feed_url, vehicles)
          totalVehiclesFound += vehicles.length
        } else {
          // HTML response — extract Schema.org JSON-LD, then try Puppeteer
          const html = bodyText
          const blocks = []
          const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
          let m
          while ((m = re.exec(html)) !== null) {
            try { blocks.push(JSON.parse(m[1])) } catch {}
          }
          // Iterative flattener — same stack-safety reason as extractCarsFromJsonLd
          const flat = []
          const walkQueue = [...blocks]
          while (walkQueue.length > 0) {
            const n = walkQueue.pop()
            if (!n) continue
            if (Array.isArray(n)) { for (const x of n) walkQueue.push(x); continue }
            if (Array.isArray(n['@graph'])) { for (const x of n['@graph']) walkQueue.push(x); continue }
            flat.push(n)
          }
          const cars = extractCarsFromJsonLd(flat)
          const origin = new URL(feed.feed_url).origin

          // Try Puppeteer walker first — gets full paginated inventory
          const sitemapVehicles = await fetchEDealerInventoryFromSitemap(origin)
          if (sitemapVehicles && sitemapVehicles.length > cars.length) {
            console.log(`[sync] Using sitemap walker (${sitemapVehicles.length} vehicles) instead of listing-page JSON-LD (${cars.length})`)
            vehicles = sitemapVehicles
            jsonCache.set(feed.feed_url, vehicles)
            totalVehiclesFound += vehicles.length
          } else {
            // Fallback: listing-page JSON-LD + detail page photo enrichment
            const detailUrls = extractEDealerDetailUrls(html, origin)
            let imageGroups = []
            if (detailUrls.length === cars.length && detailUrls.length > 0) {
              console.log(`[sync] Fetching ${detailUrls.length} detail pages for per-vehicle photos`)
              imageGroups = await fetchEDealerDetailImageGroups(detailUrls)
            } else {
              imageGroups = extractEDealerImageGroups(html)
            }
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
              condition: (c.itemCondition || '').includes('NewCondition') ? 'New'
                : (c.itemCondition || '').includes('UsedCondition') ? 'Used' : null,
              stocknumber: c.sku || c.productID,
              onweb: true,
              salepending: false,
              image_urls: (() => {
                if (imageGroups[i]?.length) return imageGroups[i]
                const img = Array.isArray(c.image) ? c.image[0] : c.image
                if (!img || (typeof img === 'string' && img.includes('coming.png'))) return []
                return [img]
              })(),
              _detail_url: detailUrls[i] || feed.feed_url
            }))
            jsonCache.set(feed.feed_url, vehicles)
            totalVehiclesFound += vehicles.length
          }
        }
      }

      // Normalize raw vehicle records using this platform's mapper (additive — raw
      // fields stay accessible, mapper overrides with the canonical field names that
      // the rest of the sync engine expects: vin, stocknumber, price, exteriorcolor, etc.)
      if (probe?.mapVehicle) {
        // In-place merge instead of spread+map — saves ~50% peak memory on large
        // feeds (500+ cars). The previous version doubled the vehicles array by
        // creating a new wrapper object for every entry.
        for (const raw of vehicles) Object.assign(raw, probe.mapVehicle(raw))
      }

      // Capture every VIN from raw feed for auto-sold logic
      for (const v of vehicles) {
        if (v.vin) allRawVins.add(v.vin)
      }

      let skippedNoIdentifier = 0
      let skippedFeedType = 0
      let skippedOnweb = 0

      // Iterate by index so we can null-out each vehicle after upserting it.
      // For 500+ vehicle feeds this lets V8 reclaim per-vehicle memory mid-loop
      // instead of holding the whole array until the sync finishes.
      const feedTotal = vehicles.length
      setSyncProgress(dealershipId, {
        phase: 'importing', feedIndex, feedCount: feeds.length, current: 0, total: feedTotal,
        pct: syncOverallPct(feedIndex, feeds.length, 0, feedTotal),
        message: feeds.length > 1
          ? `Importing vehicles (feed ${feedIndex + 1}/${feeds.length}): 0/${feedTotal}`
          : `Importing vehicles: 0/${feedTotal}`
      })
      for (let vehicleIdx = 0; vehicleIdx < vehicles.length; vehicleIdx++) {
        const v = vehicles[vehicleIdx]
        // Report progress every vehicle — cheap, and the loop already sleeps 200ms each.
        setSyncProgress(dealershipId, {
          current: vehicleIdx + 1,
          pct: syncOverallPct(feedIndex, feeds.length, vehicleIdx + 1, feedTotal),
          message: feeds.length > 1
            ? `Importing vehicles (feed ${feedIndex + 1}/${feeds.length}): ${vehicleIdx + 1}/${feedTotal}`
            : `Importing vehicles: ${vehicleIdx + 1}/${feedTotal}`
        })
        if (!v) continue
        if (!matchesFeedType(v, feed.feed_type)) { totalSkipped++; skippedFeedType++; vehicles[vehicleIdx] = null; continue }
        if (v.onweb === false || v.nonvehicle) { totalSkipped++; skippedOnweb++; vehicles[vehicleIdx] = null; continue }
        // Need SOME unique identifier — VIN preferred, stock# acceptable. Was previously
        // rejecting all vehicles with no VIN, which made schema_jsonld dealer sites (where
        // JSON-LD often omits VIN) sync 0 vehicles.
        if (!v.vin && !v.stocknumber) { totalSkipped++; skippedNoIdentifier++; vehicles[vehicleIdx] = null; continue }

        await sleep(200)

        let imageUrls = Array.isArray(v.image_urls) && v.image_urls.length ? v.image_urls : []
        if (!imageUrls.length && v.stocknumber) {
          imageUrls = await fetchVehiclePhotos(v.stocknumber)
        }

        const sourceUrl = buildSourceUrl(feed, v)

        // Synthesize a stable VIN when one isn't provided — combine dealer + stock so
        // the same vehicle re-syncs cleanly without exploding the inventory table.
        const effectiveVin = v.vin || `STK-${dealershipId.slice(0, 8)}-${v.stocknumber}`

        // Platform-agnostic sold/pending detection: honor whatever status the feed
        // exposes (DealerPage sets v.sold; JSON feeds may carry status/availability).
        // A vehicle can't be both — sold wins over pending.
        const statusStr = String(v.status || v.availability || v.sale_status || v.saleStatus || v.state || '').toLowerCase()
        const isSold = v.sold === true || /\bsold\b|sold[\s_-]?out|soldout/.test(statusStr)
        const isPending = !isSold && (v.salepending === true || v.sale_pending === true || /pending|deposit|on[\s_-]?hold|in[\s_-]?progress/.test(statusStr))

        const record = {
  dealership_id: dealershipId,
  vin: effectiveVin,
  year: parseInt(v.year),
  make: v.make,
  model: v.model,
  trim: v.trim || null,
  price: v.saleprice || v.price || 0,
  mileage: v.mileage || 0,
  condition: v.condition || null,          // ← ADD THIS LINE
  exterior_color: v.exteriorcolor || null,
  interior_color: v.interiorcolor || null,
  transmission: v.transmission || null,
  fuel_type: mapFuel(v.fueltype),
  description: buildDescription(v),
  image_urls: imageUrls,
  source_url: sourceUrl,
  status: isSold ? 'sold' : (isPending ? 'pending' : 'available'),
  last_synced_at: new Date().toISOString(),
  // Tag the originating feed when the column exists → ON DELETE CASCADE removes
  // these rows automatically when the feed is deleted (omitted pre-migration).
  ...(hasFeedId ? { feed_id: feed.id } : {})
}

        const { error } = await supabaseAdmin
          .from('inventory')
          .upsert(record, { onConflict: 'vin' })
        if (error) {
          totalSkipped++
          skipReasons.upsert_error++
          if (skipReasons.upsert_error <= 3) console.warn(`[sync] upsert error: ${error.message}`)
        } else {
          totalAttempts++
          uniqueVins.add(effectiveVin)
        }
        // Release per-vehicle memory after upsert — gives V8 the chance to GC
        // the vehicle's image_urls + description + raw feed fields mid-loop
        vehicles[vehicleIdx] = null
      }

      // Aggregate this feed's skip counts into the dealership-wide totals
      skipReasons.feed_type += skippedFeedType
      skipReasons.offline += skippedOnweb
      skipReasons.no_identifier += skippedNoIdentifier

      // Verbose per-feed skip diagnostics — also kept in Render logs for deeper digs
      if (totalSkipped > 0) {
        console.log(`[sync] feed ${feed.id} skip breakdown: feed_type=${skippedFeedType}, offline=${skippedOnweb}, no_identifier=${skippedNoIdentifier}, upsert_error=${skipReasons.upsert_error}`)
      }
    } catch (feedErr) {
      console.error('[sync] Feed error:', feedErr.message)
    }
  }

  // ── Auto-sold: single clean block ──
  // Union raw feed VINs with successfully upserted VINs to avoid false sold marking
  // when JSON-LD is missing vehicleIdentificationNumber on some vehicles.
  console.log(`[sync] allRawVins captured: ${allRawVins.size} of ${totalVehiclesFound} vehicles`)

  if (allRawVins.size > 0) {
    const captureRate = allRawVins.size / Math.max(totalVehiclesFound, 1)
    if (captureRate < 0.8) {
      console.warn(`[sync] VIN capture rate too low (${Math.round(captureRate * 100)}%) — skipping auto-sold to avoid false positives`)
    } else {
      // Union: allRawVins (from feed) + uniqueVins (actually upserted this run)
      const feedVinSet = new Set([...allRawVins, ...uniqueVins])

      // Compute the sold/restore diffs in JS rather than via PostgREST .not().in()
      // — the URL-encoded VIN list breaks past ~100 VINs and silently matches everything,
      // causing the entire inventory to flip to sold. Doing it in JS is reliable at any scale.
      const { data: currentRows, error: fetchErr } = await supabaseAdmin
        .from('inventory')
        .select('id, vin, status')
        .eq('dealership_id', dealershipId)
        .eq('status', 'available')   // sold rows are now deleted, not flagged
      if (fetchErr) {
        console.error('[sync] could not fetch current inventory for diff:', fetchErr.message)
      } else {
        // Vehicle no longer in feed → it's gone from the dealer site, delete it.
        // (Listings rows survive thanks to ON DELETE SET NULL on inventory_id.)
        const toDelete = []
        for (const row of currentRows || []) {
          if (!row.vin) continue
          if (!feedVinSet.has(row.vin)) toDelete.push(row.id)
        }

        // Safety brake: if the diff says >50% of current inventory must be deleted,
        // something's off (feed change, partial fetch) — skip rather than wipe data.
        const totalCount = (currentRows || []).length
        if (totalCount > 0 && toDelete.length / totalCount > 0.5) {
          console.warn(`[sync] would delete ${toDelete.length}/${totalCount} inventory rows — refusing (likely sync glitch)`)
        } else if (toDelete.length) {
          for (let i = 0; i < toDelete.length; i += 100) {
            const slice = toDelete.slice(i, i + 100)
            // Dropped from the feed → if any were posted to Facebook, queue their
            // listings for DELETION from Marketplace (the extension performs it). Do
            // this BEFORE deleting inventory so inventory_id still matches. Wrapped so a
            // pre-migration DB (no fb_sync_action column) never breaks the sync.
            try {
              await supabaseAdmin
                .from('listings')
                .update({ status: 'deleted', deleted_at: new Date().toISOString(), fb_sync_action: 'delete', fb_synced_at: null })
                .in('inventory_id', slice)
                .eq('status', 'posted')
                .not('fb_listing_url', 'is', null)
            } catch (e) { console.warn('[sync] delete→FB queue failed (non-fatal):', e.message) }
            // Listings FK is ON DELETE SET NULL → their history survives.
            await supabaseAdmin.from('inventory').delete().in('id', slice)
          }
          console.log(`[sync] auto-delete: ${toDelete.length} inventory rows removed (dropped from feed)`)
        }
      }
    }
  }

  // Feed marks a vehicle SOLD but keeps it listed (e.g. DealerPage) → if it was
  // posted to Facebook, queue a "mark sold" so the FB listing reflects it. Idempotent:
  // once the listing flips to 'sold' it no longer matches status='posted'.
  try {
    const { data: soldRows } = await supabaseAdmin
      .from('inventory').select('id')
      .eq('dealership_id', dealershipId).eq('status', 'sold')
    const soldIds = (soldRows || []).map(r => r.id)
    for (let i = 0; i < soldIds.length; i += 100) {
      const slice = soldIds.slice(i, i + 100)
      await supabaseAdmin.from('listings')
        .update({ status: 'sold', deleted_at: new Date().toISOString(), fb_sync_action: 'sold', fb_synced_at: null })
        .in('inventory_id', slice).eq('status', 'posted').not('fb_listing_url', 'is', null)
    }
  } catch (e) { console.warn('[sync] sold→FB queue failed (non-fatal):', e.message) }

  setSyncProgress(dealershipId, { phase: 'finalizing', pct: 99, message: 'Finalizing…' })

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
    skip_breakdown: skipReasons,
    synced_at: new Date().toISOString()
  }
}

// ── SYNC ROUTES ──
app.get('/sync', async (req, res) => {
  const secret = req.query.secret
  if (secret !== process.env.SYNC_SECRET && process.env.SYNC_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  const targetDealershipId = req.query.dealership_id
  if (!targetDealershipId) return res.status(400).json({ error: 'Missing target dealership parameter' })

  try {
    const { data: currentDealer } = await supabaseAdmin
      .from('dealerships').select('id').eq('id', targetDealershipId).single()
    if (!currentDealer) return res.status(404).json({ error: 'Target business identity not found.' })

    const result = await runInventorySync(targetDealershipId)
    if (!result.success) return res.status(404).json(result)
    res.json(result)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.get('/inventory-feeds', requireAuth, async (req, res) => {
  if (!req.dealershipId) return res.json([])
  const { data, error } = await supabaseAdmin
    .from('inventory_feeds')
    .select('id, feed_url, feed_type, platform, created_at, last_extension_sync_at')
    .eq('dealership_id', req.dealershipId)
    .order('created_at', { ascending: false })
  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})

app.post('/inventory-feeds', requireAuth, async (req, res) => {
  const canManage = req.profile.role === 'DEALER_ADMIN'
    || req.profile.role === 'OWNER'
    || req.profile.dealerships?.is_personal === true
  if (!canManage) return res.status(403).json({ error: 'Only dealer admins or solo reps can manage feeds' })
  if (!req.dealershipId) return res.status(400).json({ error: 'No dealership associated with this account' })

  const { feed_url: rawUrl, feed_type: requestedType } = req.body || {}
  if (!rawUrl) return res.status(400).json({ error: 'feed_url is required' })

  const typeHint = normalizeFeedUrl(rawUrl)
  if (!typeHint) return res.status(400).json({ error: 'Invalid URL' })

  let workingUrl = null
  let detectedPlatform = null
  let detectedPlatformSlug = null
  let attempts = []
  let cloudflareBlocked = false

  const userPastedJson = (() => {
    try { return new URL(rawUrl.trim()).pathname.toLowerCase().endsWith('.json') }
    catch { return false }
  })()

  if (userPastedJson) {
    try {
      const r = await browserFetch(rawUrl, { headers: { 'Accept': 'application/json, text/plain, */*', 'Sec-Fetch-Dest': 'empty', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Site': 'same-origin' } })
      attempts.push({ url: rawUrl, status: r.status, ok: r.ok })
      if (r.ok) {
        workingUrl = rawUrl
      } else if (r.status === 403 || r.status === 503) {
        // Cloudflare/WAF — confirm reachability through real Chrome before giving up.
        const br = await fetchViaBrowser(rawUrl)
        attempts.push({ url: rawUrl, status: br.status, ok: br.ok, via: 'headless-chrome' })
        if (br.ok) workingUrl = rawUrl
        else cloudflareBlocked = true
      }
    } catch (e) {
      attempts.push({ url: rawUrl, error: e.message })
    }
  } else {
    const detection = await detectFeedPlatform(rawUrl)
    attempts = detection.attempts || []
    cloudflareBlocked = !!detection.cloudflare_blocked
    if (detection.success) {
      workingUrl = detection.feed_url
      detectedPlatform = detection.platform_label
      detectedPlatformSlug = detection.platform
    }
  }

  if (!workingUrl) {
    if (cloudflareBlocked) {
      // Cloudflare blocks server-side access, but the user's OWN browser can reach
      // the site. Instead of failing, create the feed flagged for extension capture
      // so the extension's "Connect dealer site" button appears and pulls inventory
      // from their session. No server-side sync runs for this feed.
      workingUrl = rawUrl
      detectedPlatformSlug = 'needs_extension_capture'
      detectedPlatform = 'Browser capture (Cloudflare-protected)'
    } else {
      return res.status(400).json({
        cloudflare_blocked: false,
        error: `Could not find a working inventory feed at this dealer site. We tried ${attempts.length} known platform paths. If your dealer uses a different system, paste the direct JSON feed URL instead.`,
        attempted: attempts.slice(0, 8).map(a => `${a.url} → ${a.status || a.error || 'no data'}`)
      })
    }
  }

  // Respect the user's explicit dropdown choice — including "all" — over URL-path detection.
  // (Old behavior treated "all" as "auto-detect", which silently overrode the user's
  // selection to "new" when the URL contained /new/, defeating the point of the dropdown.)
  const feedType = requestedType || typeHint.detectedType || 'all'

  // For SPA-rendered dealers, keep the user's original URL — we need it to re-render
  // the site if the captured XHR URL stops working (e.g. auth tokens rotate).
  const sourceDealerUrl = ['spa_render', 'convertus', 'needs_extension_capture', 'dealerpage'].includes(detectedPlatformSlug) ? rawUrl : null

  // For LeadBox feeds, harvest per-vehicle URLs from the dealer's listing pages now
  // (their JSON feed doesn't include vehicle detail URLs). Saves a stock→URL map onto
  // the feed row; the sync engine uses it to set source_url per vehicle.
  let urlMap = null
  if (detectedPlatformSlug === 'leadbox' && workingUrl) {
    try {
      console.log(`[feed-add] Harvesting per-vehicle URLs from ${rawUrl}...`)
      const feedRes = await fetch(workingUrl)
      const feedJson = await feedRes.json().catch(() => null)
      const vehicleKeys = (feedJson?.vehicles || [])
        .map(v => ({
          stock: v.stocknumber || v.stock_id || v.stock || null,
          vin: v.vin || v.VIN || null
        }))
        .filter(v => v.stock || v.vin)
      if (vehicleKeys.length) {
        const harvest = await harvestVehicleUrls(rawUrl, vehicleKeys)
        if (harvest.success) {
          urlMap = harvest.map
          console.log(`[feed-add] Harvested ${harvest.matched}/${harvest.total} URLs`)
        } else {
          console.warn(`[feed-add] Harvest yielded 0 matches: ${harvest.error || 'no anchors'}`)
        }
      }
    } catch (e) {
      console.warn(`[feed-add] URL harvest failed (non-fatal): ${e.message}`)
    }
  }

  const { data, error } = await supabaseAdmin
    .from('inventory_feeds')
    .insert({
      dealership_id: req.dealershipId,
      user_id: req.user.id,
      feed_url: workingUrl,
      feed_type: feedType,
      platform: detectedPlatformSlug,
      source_dealer_url: sourceDealerUrl,
      url_map: urlMap
    })
    .select()
    .single()
  if (error) return res.status(500).json({ error: error.message })
  console.log(`✓ Added feed: ${detectedPlatform || 'direct'} → ${workingUrl}`)
  res.json({
    ...data,
    platform: detectedPlatform,
    needs_extension_capture: detectedPlatformSlug === 'needs_extension_capture'
  })
})

app.delete('/inventory-feeds/:id', requireAuth, async (req, res) => {
  const canManage = req.profile.role === 'DEALER_ADMIN'
    || req.profile.role === 'OWNER'
    || req.profile.dealerships?.is_personal === true
  if (!canManage) return res.status(403).json({ error: 'Only dealer admins or solo reps can manage feeds' })

  const { data: feed } = await supabaseAdmin
    .from('inventory_feeds')
    .select('id, dealership_id, feed_url, source_dealer_url')
    .eq('id', req.params.id)
    .single()
  if (!feed || feed.dealership_id !== req.dealershipId) {
    return res.status(404).json({ error: 'Feed not found' })
  }

  // Collect every origin this feed covers. We check BOTH feed_url and
  // source_dealer_url because for many platforms the vehicles' source_url lives on
  // the dealer site origin while the feed_url is a JSON/proxy host on a different
  // origin — matching only feed_url would orphan inventory on delete.
  const originsOf = (...urls) => {
    const s = new Set()
    for (const u of urls) { try { if (u) s.add(new URL(u).origin) } catch {} }
    return s
  }
  const feedOrigins = originsOf(feed.feed_url, feed.source_dealer_url)

  // 0. Precise path: if inventory rows are tagged with this feed_id, remove them
  // (and detach their listings) directly — reliable for ANY platform regardless of
  // whether the vehicle source_url shares the feed's origin. Legacy rows without a
  // feed_id fall through to the origin-matching logic below.
  let deletedByFeedId = 0
  if (await inventoryHasFeedId()) {
    const { data: byFeed } = await supabaseAdmin
      .from('inventory').select('id').eq('dealership_id', req.dealershipId).eq('feed_id', req.params.id)
    const ids = (byFeed || []).map(r => r.id)
    for (let i = 0; i < ids.length; i += 100) {
      const slice = ids.slice(i, i + 100)
      await supabaseAdmin.from('listings').delete().in('inventory_id', slice)
      await supabaseAdmin.from('inventory').delete().in('id', slice)
    }
    deletedByFeedId = ids.length
  }

  // 1. Remove the feed row itself
  const { error: delFeedErr } = await supabaseAdmin
    .from('inventory_feeds').delete().eq('id', req.params.id)
  if (delFeedErr) return res.status(500).json({ error: delFeedErr.message })

  // 2. Decide what inventory should also be removed.
  // Look at the dealership's REMAINING feeds. If another feed still covers one of
  // this feed's origins (e.g., you deleted /new/ but kept /used/), leave that
  // inventory — the remaining feed covers it and the next sync reconciles.
  const { data: remainingFeeds } = await supabaseAdmin
    .from('inventory_feeds').select('feed_url, source_dealer_url').eq('dealership_id', req.dealershipId)

  const remainingOrigins = new Set()
  for (const f of remainingFeeds || []) {
    for (const o of originsOf(f.feed_url, f.source_dealer_url)) remainingOrigins.add(o)
  }

  let inventoryDeleted = 0
  let toDelete = []

  if (Array.isArray(remainingFeeds) && remainingFeeds.length === 0) {
    // No feeds left at all — wipe the dealership's inventory entirely
    const { data: all } = await supabaseAdmin
      .from('inventory').select('id').eq('dealership_id', req.dealershipId)
    toDelete = (all || []).map(r => r.id)
  } else {
    // Origins covered ONLY by the deleted feed (not by any remaining feed).
    const orphanedOrigins = [...feedOrigins].filter(o => !remainingOrigins.has(o))
    if (orphanedOrigins.length) {
      const { data: matching } = await supabaseAdmin
        .from('inventory').select('id, source_url')
        .eq('dealership_id', req.dealershipId)
      toDelete = (matching || [])
        .filter(r => r.source_url && orphanedOrigins.some(o => r.source_url.startsWith(o)))
        .map(r => r.id)
    }
  }

  // 3. Cascade-delete listings then inventory, batched to avoid URL-length limits
  if (toDelete.length) {
    for (let i = 0; i < toDelete.length; i += 100) {
      const slice = toDelete.slice(i, i + 100)
      // Listings have FK to inventory — must go first
      await supabaseAdmin.from('listings').delete().in('inventory_id', slice)
      await supabaseAdmin.from('inventory').delete().in('id', slice)
    }
    inventoryDeleted = toDelete.length
  }
  inventoryDeleted += deletedByFeedId
  if (inventoryDeleted) {
    console.log(`[feed delete] dealership=${req.dealershipId} feed=${req.params.id} removed ${inventoryDeleted} inventory rows (${deletedByFeedId} by feed_id)`)
  }

  res.json({ success: true, inventory_deleted: inventoryDeleted })
})

// Lightweight progress poll for the dashboard Sync button. Returns the live
// percentage/phase of an in-flight sync for the caller's dealership, or idle.
app.get('/inventory/sync/progress', requireAuth, (req, res) => {
  if (!req.dealershipId) return res.json({ phase: 'idle', pct: 0 })
  res.json(syncProgress.get(req.dealershipId) || { phase: 'idle', pct: 0 })
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

// ── 11. DIAGNOSTICS ──
app.get('/debug', requireAuth, async (req, res) => {
  res.json({ user_id: req.user.id, profile: req.profile, dealership_id: req.dealershipId })
})

// ── 12. SCHEDULED SYNC ──
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
      console.log(
        `[sync-all:${triggerLabel}] ${d.name} (${d.id}):`,
        r.success ? `${r.unique_vehicles} unique, ${r.skipped} skipped` : r.error
      )
      results.push({ dealership_id: d.id, ...r })
    } catch (e) {
      console.error(`[sync-all:${triggerLabel}] ${d.id} threw:`, e.message)
      results.push({ dealership_id: d.id, success: false, error: e.message })
    }

    // Breathing room between dealerships — gives V8's GC time to reclaim memory
    // from the previous dealership's sitemap walker before the next one starts.
    // Also logs current heap usage so we can see what's actually accumulating.
    const mem = process.memoryUsage()
    const mb = (n) => (n / 1024 / 1024).toFixed(0)
    console.log(`[sync-all:${triggerLabel}] heap=${mb(mem.heapUsed)}/${mb(mem.heapTotal)}MB rss=${mb(mem.rss)}MB`)
    if (global.gc) global.gc()
    await new Promise(r => setTimeout(r, 2000))
  }

  console.log(`[sync-all:${triggerLabel}] finished. ${results.length} dealership(s) processed.`)
  return {
    success: true,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    results
  }
}

app.post('/cron/sync-all', async (req, res) => {
  const secret = req.headers['x-cron-secret'] || req.query.secret
  if (secret !== process.env.SYNC_SECRET) return res.status(401).json({ error: 'Unauthorized' })
  const result = await syncAllDealerships('manual')
  res.json(result)
})

const SYNC_INTERVAL_HOURS = Number(process.env.SYNC_INTERVAL_HOURS || 6)
if (SYNC_INTERVAL_HOURS > 0) {
  setTimeout(() => syncAllDealerships('boot'), 60 * 1000)
  setInterval(() => syncAllDealerships('interval'), SYNC_INTERVAL_HOURS * 60 * 60 * 1000)
  console.log(`📅 Scheduled inventory sync every ${SYNC_INTERVAL_HOURS}h (set SYNC_INTERVAL_HOURS=0 to disable)`)
}

// ──────────────────────────────────────────────────────────────────────────────
// Onboarding drip campaign — 7-email trial sequence (see drip.js)
// ──────────────────────────────────────────────────────────────────────────────

function runDrip(trigger) {
  return runDripCampaign({
    supabaseAdmin,
    resend,
    emailFrom: EMAIL_FROM,
    frontendUrl: FRONTEND_URL,
    extensionUrl: EXTENSION_URL,
    unsubBaseUrl: BACKEND_URL,
    unsubSecret: process.env.SYNC_SECRET || '',
    trigger
  })
}

// Manual trigger — same X-Cron-Secret auth as /cron/sync-all.
app.post('/cron/drip', async (req, res) => {
  const secret = req.headers['x-cron-secret'] || req.query.secret
  if (secret !== process.env.SYNC_SECRET) return res.status(401).json({ error: 'Unauthorized' })
  const result = await runDrip('manual')
  res.json(result)
})

// One-click unsubscribe from the onboarding tips. Public (no login) — the token
// proves ownership. GET serves the link a human clicks in the footer; POST handles
// the RFC 8058 one-click unsubscribe that Gmail/Outlook fire from the
// List-Unsubscribe header. Both just flip drip_unsubscribed_at.
async function applyDripUnsubscribe(req) {
  const userId = String((req.query.u || req.body?.u) || '')
  const token = String((req.query.t || req.body?.t) || '')
  if (!verifyUnsubToken(userId, token, process.env.SYNC_SECRET || '')) return false
  try {
    await supabaseAdmin
      .from('profiles')
      .update({ drip_unsubscribed_at: new Date().toISOString() })
      .eq('id', userId)
  } catch (e) {
    console.warn('[unsubscribe] update failed:', e.message)
  }
  return true
}

app.get('/unsubscribe', async (req, res) => {
  const ok = await applyDripUnsubscribe(req)
  if (!ok) {
    return res.status(400).type('html').send('<p>This unsubscribe link is invalid or expired.</p>')
  }
  res.type('html').send(
    '<div style="font-family:-apple-system,sans-serif;max-width:480px;margin:64px auto;text-align:center;color:#0f172a;">' +
    '<h1 style="font-size:20px;">You\'re unsubscribed</h1>' +
    '<p style="color:#475569;">You won\'t get any more MarketSync onboarding tips. ' +
    'Account and security emails (like password resets) will still come through.</p>' +
    '<p><a href="https://marketsync.link/" style="color:#6366f1;">Back to MarketSync</a></p></div>'
  )
})

app.post('/unsubscribe', async (req, res) => {
  const ok = await applyDripUnsubscribe(req)
  res.status(ok ? 200 : 400).json({ success: ok })
})

const DRIP_INTERVAL_HOURS = Number(process.env.DRIP_INTERVAL_HOURS || 24)
if (DRIP_INTERVAL_HOURS > 0) {
  setTimeout(() => runDrip('boot'), 2 * 60 * 1000)
  setInterval(() => runDrip('interval'), DRIP_INTERVAL_HOURS * 60 * 60 * 1000)
  console.log(`📧 Scheduled onboarding drip every ${DRIP_INTERVAL_HOURS}h (set DRIP_INTERVAL_HOURS=0 to disable)`)
}

app.use((err, req, res, next) => {
  console.error('Unhandled Express error:', {
    path: req.path,
    method: req.method,
    message: err.message,
    stack: err.stack
  })
  if (res.headersSent) return next(err)
  res.status(500).json({ error: err.message, path: req.path, stack: err.stack })
})

app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Secure Marketplace engine live on port ${PORT}`))
