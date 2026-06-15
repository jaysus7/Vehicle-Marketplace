// Security alert email service. Detects when a user signs in from a new IP /
// country and emails them a heads-up. Runs in the background so it never blocks
// the login response.
//
// Provider: Resend (https://resend.com) — modern transactional email API with
// a generous free tier (3,000 emails/month). Sender domain must be verified.
//
// Geo-IP: ipapi.co — free, no API key needed up to 1,000 requests/day. We hit
// it lazily (cached per IP for the process lifetime). If it times out we
// gracefully degrade to "unknown location".

const RESEND_API_KEY = process.env.RESEND_API_KEY
const ALERT_FROM = process.env.ALERT_EMAIL_FROM || 'MarketSync Security <noreply@marketsync.link>'

// Cache: ip → { country, city, region } — keyed for the life of the process to
// avoid hitting ipapi for every single login from the same dealership.
const geoCache = new Map()

async function lookupGeo(ip) {
  if (!ip || ip === 'unknown') return { country: 'Unknown', city: null, region: null }
  if (geoCache.has(ip)) return geoCache.get(ip)
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 3000)
    const res = await fetch(`https://ipapi.co/${encodeURIComponent(ip)}/json/`, {
      signal: controller.signal,
      headers: { 'User-Agent': 'MarketSync-SecurityAlerts/1.0' }
    })
    clearTimeout(timer)
    if (!res.ok) return { country: 'Unknown', city: null, region: null }
    const data = await res.json()
    const result = {
      country: data.country_name || 'Unknown',
      country_code: data.country_code || null,
      city: data.city || null,
      region: data.region || null
    }
    geoCache.set(ip, result)
    return result
  } catch {
    return { country: 'Unknown', city: null, region: null }
  }
}

// Best-effort send via Resend — silently no-ops if RESEND_API_KEY isn't set
// so local dev / staging without keys doesn't break.
export async function sendEmail({ to, subject, html, text }) {
  if (!RESEND_API_KEY) {
    console.log(`[email] (RESEND_API_KEY not set) Would send to ${to}: ${subject}`)
    return { sent: false, reason: 'no api key' }
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ from: ALERT_FROM, to, subject, html, text })
    })
    if (!res.ok) {
      const body = await res.text()
      console.warn(`[email] Resend ${res.status}: ${body}`)
      return { sent: false, status: res.status, body }
    }
    return { sent: true }
  } catch (e) {
    console.warn(`[email] send failed: ${e.message}`)
    return { sent: false, error: e.message }
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Suspicious login detector
// ──────────────────────────────────────────────────────────────────────────────
// "Suspicious" = sign-in from an IP the user has NEVER used before, OR from a
// country they've never been in. First-ever login isn't suspicious. We compare
// against the last 90 days of login history.
//
// Call this AFTER the new login row has been inserted (so we have the history).
// Never throws — security alerts are best-effort and should never block auth.

export async function maybeAlertSuspiciousLogin({
  supabaseAdmin, userId, userEmail, currentIp, currentUserAgent
}) {
  try {
    const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString()
    const { data: history } = await supabaseAdmin
      .from('logins')
      .select('ip, created_at')
      .eq('user_id', userId)
      .gte('created_at', ninetyDaysAgo)
      .order('created_at', { ascending: false })
      .limit(200)

    const rows = history || []
    // Exclude the row we just inserted (newest with matching IP within 1 min)
    const recent = rows.slice(1)

    // First-ever login → not suspicious
    if (recent.length === 0) return { suspicious: false, reason: 'first login' }

    const seenIps = new Set(recent.map(r => r.ip).filter(Boolean))
    if (seenIps.has(currentIp)) return { suspicious: false, reason: 'known IP' }

    // Unknown IP — also check if it's at least in a known country
    const currentGeo = await lookupGeo(currentIp)
    const seenGeos = await Promise.all(
      [...seenIps].slice(0, 5).map(ip => lookupGeo(ip))
    )
    const knownCountries = new Set(seenGeos.map(g => g.country_code).filter(Boolean))

    const newCountry = currentGeo.country_code
      && !knownCountries.has(currentGeo.country_code)
      && knownCountries.size > 0

    // Alert: new IP always; bonus highlight if also new country
    await sendSuspiciousLoginEmail({
      to: userEmail,
      ip: currentIp,
      geo: currentGeo,
      newCountry,
      userAgent: currentUserAgent
    })
    return { suspicious: true, newCountry, ip: currentIp, geo: currentGeo }
  } catch (e) {
    console.warn(`[security-alert] check failed: ${e.message}`)
    return { suspicious: false, error: e.message }
  }
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

async function sendSuspiciousLoginEmail({ to, ip, geo, newCountry, userAgent }) {
  const where = [geo.city, geo.region, geo.country].filter(Boolean).join(', ') || 'Unknown location'
  const ua = (userAgent || '').slice(0, 200)
  const subject = newCountry
    ? `⚠️ New sign-in from ${geo.country} on your MarketSync account`
    : `New sign-in to your MarketSync account`
  const text = [
    `Hi,`,
    ``,
    `Someone just signed in to your MarketSync account from a new device or location:`,
    ``,
    `  Location: ${where}`,
    `  IP address: ${ip || 'unknown'}`,
    `  Browser/Device: ${ua}`,
    `  Time: ${new Date().toUTCString()}`,
    ``,
    `If this was you, you can ignore this message.`,
    ``,
    `If not:`,
    `  1. Change your password immediately at https://marketsync.link/login.html`,
    `  2. Enable two-factor authentication in your profile`,
    `  3. Sign out all other devices from your dashboard's Security section`,
    ``,
    `— The MarketSync team`,
    `https://marketsync.link`
  ].join('\n')
  const html = `
    <div style="font-family:system-ui,-apple-system,Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#0f172a;">
      <div style="font-weight:bold;font-size:18px;margin-bottom:16px;">
        ${newCountry ? '⚠️ ' : ''}New sign-in to your MarketSync account
      </div>
      <p>Someone just signed in to your MarketSync account from a new device or location:</p>
      <table style="border-collapse:collapse;margin:12px 0;">
        <tr><td style="padding:6px 12px;color:#64748b;">Location:</td><td style="padding:6px 12px;"><strong>${escapeHtml(where)}</strong></td></tr>
        <tr><td style="padding:6px 12px;color:#64748b;">IP address:</td><td style="padding:6px 12px;font-family:monospace;">${escapeHtml(ip)}</td></tr>
        <tr><td style="padding:6px 12px;color:#64748b;">Browser/Device:</td><td style="padding:6px 12px;font-family:monospace;font-size:12px;">${escapeHtml(ua)}</td></tr>
        <tr><td style="padding:6px 12px;color:#64748b;">Time (UTC):</td><td style="padding:6px 12px;">${new Date().toUTCString()}</td></tr>
      </table>
      <p style="background:#fef3c7;border:1px solid #fcd34d;border-radius:8px;padding:12px;">
        <strong>Was this you?</strong> You can ignore this message.<br><br>
        <strong>Not you?</strong> Act now:
      </p>
      <ol style="line-height:1.7;">
        <li><a href="https://marketsync.link/forgot-password.html" style="color:#4f46e5;">Change your password immediately</a></li>
        <li>Enable two-factor authentication in your profile</li>
        <li>Sign out all other devices from your dashboard's Security section</li>
      </ol>
      <hr style="border:0;border-top:1px solid #e2e8f0;margin:24px 0;">
      <p style="color:#64748b;font-size:12px;">
        — The MarketSync team · <a href="https://marketsync.link" style="color:#4f46e5;">marketsync.link</a>
      </p>
    </div>
  `
  await sendEmail({ to, subject, html, text })
}
