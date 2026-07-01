import 'dotenv/config'
import ws from 'ws'
import Stripe from 'stripe'
import { createClient } from '@supabase/supabase-js'
import { Resend } from 'resend'

// Resend SMTP — we send transactional email (password resets etc.) directly
// from this backend instead of going through Supabase Auth. Lower latency,
// better deliverability, no shared-tenant rate limits.
export const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null
export const EMAIL_FROM = process.env.EMAIL_FROM || 'MarketSync <noreply@marketsync.link>'

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
export const CANONICAL_FRONTEND = 'https://marketsync.link'
export const FRONTEND_URL = (process.env.FRONTEND_URL || CANONICAL_FRONTEND)
  .replace(/\/$/, '')  // strip trailing slash to avoid `//path` URLs

// Chrome Web Store listing — linked from the onboarding drip ("get the extension").
export const EXTENSION_URL = process.env.CHROME_EXTENSION_URL ||
  'https://chromewebstore.google.com/detail/marketsync/mfoaodaoipaalloccolophjhblgikada'

// This backend's own public URL — used for the drip unsubscribe link, which is
// served by routes on THIS server (the static frontend has no such route).
export const BACKEND_URL = (process.env.API_URL || process.env.RENDER_EXTERNAL_URL ||
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
export const BROWSER_HEADERS = {
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
export function browserFetch(url, init = {}) {
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

export const sleep = ms => new Promise(r => setTimeout(r, ms))
export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY)

export const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, { realtime: { transport: ws } })
export const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { realtime: { transport: ws } })
