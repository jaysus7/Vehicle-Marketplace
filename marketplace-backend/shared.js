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
// Every request gets a hard 25s timeout unless the caller passes its own signal —
// one hanging dealer site must never stall the sync loop for everyone else.
export function browserFetch(url, init = {}) {
  let extra = {}
  try {
    const origin = new URL(url).origin
    extra = { Referer: origin + '/', Origin: origin }
  } catch {}
  return fetch(url, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(25000),
    headers: { ...BROWSER_HEADERS, ...extra, ...(init.headers || {}) }
  })
}

// Route a request through ScraperAPI (https://scraperapi.com) when
// SCRAPER_API_KEY is set. Free tier: 1 000 requests/month.
// render=true triggers their headless Chrome — JS executes, Cloudflare clears.
// Returns a standard Response-like object with .ok, .status, .text(), .json().
export async function scraperApiFetch(targetUrl, { render = false, timeoutMs = 45000 } = {}) {
  const key = process.env.SCRAPER_API_KEY
  if (!key) throw new Error('SCRAPER_API_KEY env var not set')
  const api = `https://api.scraperapi.com?api_key=${key}&url=${encodeURIComponent(targetUrl)}${render ? '&render=true' : ''}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(api, { signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

// Parse rendered HTML from ScraperAPI (or any headless response) for eDealer
// vehicle data. Tries script-tag JSON globals first, then data-vin card attributes.
export function parseEDealerHtml(html) {
  if (!html) return []

  // 1. Window / var globals assigned as JSON arrays in inline scripts
  const scriptRe = /(?:var |window\.)(?:inventory|inventoryData|inventoryItems|vehicles|inventoryList)\s*=\s*(\[[\s\S]{20,}?\]);/i
  const keyRe = /"(?:inventory|vehicles|items)"\s*:\s*(\[[\s\S]{20,}?\])/i
  for (const re of [scriptRe, keyRe]) {
    const m = html.match(re)
    if (m) {
      try {
        const arr = JSON.parse(m[1])
        if (Array.isArray(arr) && arr.length && (arr[0]?.VIN || arr[0]?.vin || arr[0]?.stocknumber)) return arr
      } catch {}
    }
  }

  // 2. data-vin attributes on card elements
  const vehicles = []
  const seen = new Set()
  const cardRe = /<[^>]+data-vin="([^"]+)"([^>]*)>/gi
  let m
  while ((m = cardRe.exec(html)) !== null) {
    const vin = m[1]
    if (!vin || seen.has(vin)) continue
    seen.add(vin)
    const tag = m[0]
    const attr = (name) => { const a = tag.match(new RegExp(`data-${name}="([^"]*)"`, 'i')); return a ? a[1] : null }
    vehicles.push({
      VIN: vin, vin,
      year: attr('year'), make: attr('make'), model: attr('model'), trim: attr('trim'),
      StockNumber: attr('stock') || attr('stocknumber'),
      stocknumber: attr('stock') || attr('stocknumber'),
      price: parseInt(attr('price') || '0', 10) || 0,
      saleprice: parseInt(attr('saleprice') || attr('price') || '0', 10) || 0,
      condition: attr('condition'), mileage: parseInt(attr('mileage') || '0', 10) || 0,
    })
  }
  return vehicles
}

export const sleep = ms => new Promise(r => setTimeout(r, ms))
export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY)

export const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, { realtime: { transport: ws } })
export const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { realtime: { transport: ws } })
