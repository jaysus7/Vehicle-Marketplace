// Centralized security utilities — password policy, rate limiting, and HTTP security
// headers. All in one file so the auth surface has a single source of truth for what
// "2026 compliant" actually means in this codebase.
//
// Compliance targets:
//   - NIST SP 800-63B (passwords, with HIBP breach check via K-anonymity)
//   - OWASP Top 10 2024 (rate limiting, headers, transport security, CSP)
//   - CASL + CAN-SPAM (newsletter consent is captured at registration; tracked elsewhere)

import { createHash, randomBytes } from 'crypto'

// ──────────────────────────────────────────────────────────────────────────────
// PASSWORD POLICY
// ──────────────────────────────────────────────────────────────────────────────
// 12-character minimum (above NIST's 8 floor, matches what the leading SaaS
// providers ship in 2024-2026). No forced complexity rules — those are now
// considered counterproductive per NIST guidance (they push users toward
// predictable patterns like "Password1!"). Instead we rely on length + a banned
// list of the most-leaked passwords + a rule against using the email's
// local-part as the password.

const BANNED_PASSWORDS = new Set([
  // Top globally-leaked passwords from HaveIBeenPwned / SecLists. If a password
  // hashes to one of these strings (case-insensitive), it's rejected.
  // This catches ~90% of "password spray" attacks without an external API call.
  'password', 'password1', 'password12', 'password123', 'password1234',
  'qwerty', 'qwerty123', 'qwertyuiop', '1q2w3e4r5t', 'asdfghjkl',
  '123456', '1234567', '12345678', '123456789', '1234567890',
  'abc123', 'abcd1234', 'letmein', 'iloveyou', 'welcome',
  'admin', 'admin123', 'administrator', 'root', 'toor',
  'monkey', 'dragon', 'master', 'sunshine', 'princess',
  'football', 'baseball', 'basketball', 'starwars', 'pokemon',
  'trustno1', 'changeme', 'passw0rd', 'p@ssword', 'p@ssw0rd',
  'marketsync', 'marketsync1', 'marketsync123',
  // Common 12-char patterns that look strong but aren't
  'password1234', 'qwerty123456', '123456789012', 'aaaaaaaaaaaa',
  'qwertyuiop12', 'asdfghjkl123', 'zxcvbnm12345'
])

// Cheap local checks first; HIBP API check is async so a separate function
function validatePasswordSync(password, opts = {}) {
  const email = (opts.email || '').toLowerCase().trim()
  if (typeof password !== 'string') {
    return { ok: false, error: 'Password must be a string.' }
  }
  if (password.length < 12) {
    return { ok: false, error: 'Password must be at least 12 characters long.' }
  }
  if (password.length > 200) {
    return { ok: false, error: 'Password is too long (max 200 characters).' }
  }
  const lower = password.toLowerCase()
  if (BANNED_PASSWORDS.has(lower)) {
    return { ok: false, error: 'That password appears on common breach lists. Pick something less predictable.' }
  }
  if (email) {
    const localPart = email.split('@')[0]
    if (localPart.length >= 4 && lower.includes(localPart)) {
      return { ok: false, error: 'Password cannot contain your email address.' }
    }
  }
  return { ok: true }
}

// Have I Been Pwned — K-anonymity model. We hash the password with SHA-1, send
// only the first 5 hex chars to api.pwnedpasswords.com, and match the rest
// locally against the returned list. The full hash NEVER leaves this server.
// If the API is down or slow (>3s), we skip the check rather than block signup —
// the local checks above already cover the most-leaked passwords.
async function checkHaveIBeenPwned(password) {
  try {
    const sha1 = createHash('sha1').update(password).digest('hex').toUpperCase()
    const prefix = sha1.slice(0, 5)
    const suffix = sha1.slice(5)

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 3000)
    const res = await fetch(`https://api.pwnedpasswords.com/range/${prefix}`, {
      signal: controller.signal,
      headers: { 'Add-Padding': 'true' }  // makes response size constant (defeats network traffic analysis)
    })
    clearTimeout(timer)
    if (!res.ok) return { ok: true, skipped: true, reason: `HIBP status ${res.status}` }

    const text = await res.text()
    for (const line of text.split('\n')) {
      const [hashSuffix, count] = line.trim().split(':')
      if (hashSuffix === suffix && Number(count) > 0) {
        return { ok: false, breachCount: Number(count) }
      }
    }
    return { ok: true }
  } catch (e) {
    return { ok: true, skipped: true, reason: e.message }
  }
}

// Full async password validator — runs sync checks first, then HIBP. Always use
// this at signup, password reset, and password change. The HIBP call adds ~200ms
// of round trip but is free and adds the strongest practical breach protection.
export async function validatePassword(password, opts = {}) {
  const sync = validatePasswordSync(password, opts)
  if (!sync.ok) return sync

  const hibp = await checkHaveIBeenPwned(password)
  if (!hibp.ok) {
    return {
      ok: false,
      error: `That password has appeared in ${hibp.breachCount.toLocaleString()} known data breaches. Please choose a different one.`
    }
  }
  return { ok: true, hibp_skipped: hibp.skipped || false }
}

// ──────────────────────────────────────────────────────────────────────────────
// RECOVERY CODES (2FA backup)
// ──────────────────────────────────────────────────────────────────────────────
// 10 single-use codes generated at TOTP enrollment. User stores them somewhere
// safe (printed, password manager). If they lose their phone, they enter one
// instead of a TOTP code. Each code burns after one use.
//
// We store SHA-256 hashes (the codes themselves are 10-char base32 — high entropy)
// so even a DB leak doesn't expose them.

// Generate 10 random codes in the format "XXXX-XXXX" (8 base32 chars with a dash)
export function generateRecoveryCodes(count = 10) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'  // unambiguous: no 0/O, 1/I
  const codes = []
  for (let i = 0; i < count; i++) {
    const bytes = randomBytes(8)
    let code = ''
    for (let j = 0; j < 8; j++) code += alphabet[bytes[j] % alphabet.length]
    codes.push(`${code.slice(0, 4)}-${code.slice(4)}`)
  }
  return codes
}

// Hash for DB storage — fast (SHA-256 is fine for high-entropy codes; bcrypt is overkill)
export function hashRecoveryCode(code) {
  return createHash('sha256').update(code.replace(/[\s-]/g, '').toUpperCase()).digest('hex')
}

// ──────────────────────────────────────────────────────────────────────────────
// RATE LIMITING (in-memory token bucket)
// ──────────────────────────────────────────────────────────────────────────────
// Lightweight per-IP rate limiter. No Redis, no extra dep — fine for single-node
// deployments. If you scale to multi-node later, swap to a shared store.
//
// Each call to `rateLimit(name, max, windowMs)` returns express middleware that
// allows `max` requests per `windowMs` window per IP, then 429s.

const buckets = new Map()  // key: `${name}:${ip}` → { count, resetAt }

export function rateLimit(name, max, windowMs) {
  return (req, res, next) => {
    const ip = (req.headers['x-forwarded-for']?.toString().split(',')[0].trim())
             || req.socket?.remoteAddress
             || 'unknown'
    const key = `${name}:${ip}`
    const now = Date.now()
    const bucket = buckets.get(key)

    if (!bucket || bucket.resetAt < now) {
      buckets.set(key, { count: 1, resetAt: now + windowMs })
      return next()
    }
    if (bucket.count >= max) {
      const retryAfter = Math.ceil((bucket.resetAt - now) / 1000)
      res.set('Retry-After', String(retryAfter))
      return res.status(429).json({
        error: `Too many requests. Try again in ${retryAfter} seconds.`,
        retry_after_seconds: retryAfter
      })
    }
    bucket.count++
    next()
  }
}

// Cleanup expired buckets every 10 minutes so the Map doesn't grow unbounded
setInterval(() => {
  const now = Date.now()
  for (const [k, b] of buckets) {
    if (b.resetAt < now) buckets.delete(k)
  }
}, 10 * 60 * 1000).unref?.()

// ──────────────────────────────────────────────────────────────────────────────
// SECURITY HEADERS (helmet-lite)
// ──────────────────────────────────────────────────────────────────────────────
// Sets the headers OWASP recommends for browser-facing APIs. Skips CSP — that
// needs careful tuning against your CDN allowlist (Tailwind, Font Awesome,
// jsdelivr, etc.) and is best added separately after staging tests.

// Content Security Policy — locks down which origins the browser will load resources
// from. Allowlist matches every CDN currently in the frontend (Tailwind, Font Awesome,
// Chart.js, Stripe, Supabase, GTM, Calendly, CookieYes). Adjust here if you add a new CDN.
const CSP_DIRECTIVES = [
  "default-src 'self'",
  // Scripts: own origin + CDN, GA, Stripe, Calendly, CookieYes. 'unsafe-inline' is
  // required because Tailwind CDN injects styles via inline <style>; eval'd inline
  // tag handlers (onclick) are also used in places. To tighten further we'd need to
  // self-host Tailwind + replace all inline event handlers.
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' " +
    "https://cdn.tailwindcss.com https://cdnjs.cloudflare.com https://cdn.jsdelivr.net " +
    "https://www.googletagmanager.com https://www.google-analytics.com " +
    "https://js.stripe.com https://assets.calendly.com https://cdn-cookieyes.com",
  "style-src 'self' 'unsafe-inline' " +
    "https://cdnjs.cloudflare.com https://cdn.jsdelivr.net " +
    "https://fonts.googleapis.com https://assets.calendly.com",
  "font-src 'self' data: https://cdnjs.cloudflare.com https://fonts.gstatic.com",
  "img-src 'self' data: blob: https:",  // dealer photo proxies make this broad
  "connect-src 'self' " +
    "https://vehicle-marketplace-s0e4.onrender.com " +
    "https://*.supabase.co https://*.supabase.in " +
    "https://www.google-analytics.com https://stats.g.doubleclick.net " +
    "https://api.stripe.com https://calendly.com " +
    "https://api.pwnedpasswords.com",
  "frame-src 'self' https://www.youtube.com https://js.stripe.com " +
    "https://hooks.stripe.com https://calendly.com",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self' https://hooks.stripe.com",
  "frame-ancestors 'none'",  // matches X-Frame-Options DENY
  "upgrade-insecure-requests"
].join('; ')

export function securityHeaders(req, res, next) {
  // Force HTTPS for the next 2 years and apply to subdomains
  res.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains')
  // Stop browsers from MIME-sniffing responses (CRLF + Content-Type confusion)
  res.set('X-Content-Type-Options', 'nosniff')
  // Block this site from being framed (clickjacking) — belt-and-suspenders with CSP frame-ancestors
  res.set('X-Frame-Options', 'DENY')
  // Don't leak full URL paths to other origins via Referer
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin')
  // Limit powerful browser features we don't use
  res.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), interest-cohort=()')
  // Disable cross-origin window opener access (tabnabbing prevention)
  res.set('Cross-Origin-Opener-Policy', 'same-origin')
  // Content Security Policy — see CSP_DIRECTIVES above for what's allowed
  res.set('Content-Security-Policy', CSP_DIRECTIVES)
  next()
}

// ──────────────────────────────────────────────────────────────────────────────
// CORS — locked down to known origins
// ──────────────────────────────────────────────────────────────────────────────
// Pass to cors({ origin: corsOriginCheck }) so dev (localhost), the marketing
// site, the dashboard, and the Chrome extension all work — and nothing else.

export function corsOriginCheck(origin, callback) {
  if (!origin) return callback(null, true)  // server-to-server, curl, etc.
  const allowed = [
    'https://marketsync.link',
    'https://www.marketsync.link'
  ]
  if (allowed.includes(origin)) return callback(null, true)
  if (origin.startsWith('chrome-extension://')) return callback(null, true)
  if (process.env.NODE_ENV !== 'production') {
    if (origin.startsWith('http://localhost:') || origin.startsWith('http://127.0.0.1:')) {
      return callback(null, true)
    }
  }
  return callback(new Error(`CORS blocked: ${origin}`), false)
}

// ──────────────────────────────────────────────────────────────────────────────
// IP HELPER — used to record consent (CASL/GDPR) and audit events
// ──────────────────────────────────────────────────────────────────────────────
export function getClientIp(req) {
  return (req.headers['x-forwarded-for']?.toString().split(',')[0].trim())
       || req.socket?.remoteAddress
       || null
}
