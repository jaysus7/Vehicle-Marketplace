/**
 * Two-way calendar sync — Google Calendar + Microsoft Outlook.
 *
 * Everything here is CONFIG-GATED: it does nothing until the OAuth app
 * credentials are set as env vars on the server, so the feature ships dark and
 * lights up the moment the keys are added:
 *
 *   GOOGLE_CALENDAR_CLIENT_ID / GOOGLE_CALENDAR_CLIENT_SECRET
 *   MS_CALENDAR_CLIENT_ID     / MS_CALENDAR_CLIENT_SECRET   (+ optional MS_CALENDAR_TENANT)
 *
 * The OAuth redirect URI to register with each provider is:
 *   <BACKEND_URL>/calendar/callback/google
 *   <BACKEND_URL>/calendar/callback/microsoft
 *
 * Model: a MarketSync appointment is a crm_tasks row with type='appointment' and
 * a due_at. Each connection belongs to one user. Outbound — creating/updating/
 * cancelling an appointment mirrors it to that user's calendar. Inbound — pulling
 * the calendar creates/updates matching appointments (mapped by external_event_id).
 *
 * Tokens live in calendar_connections (service-role-only table). Access tokens are
 * refreshed on demand; only the refresh token is long-lived.
 */
import crypto from 'node:crypto'
import { supabaseAdmin, BACKEND_URL } from './shared.js'

const GOOGLE = {
  id: process.env.GOOGLE_CALENDAR_CLIENT_ID || '',
  secret: process.env.GOOGLE_CALENDAR_CLIENT_SECRET || '',
  scopes: ['https://www.googleapis.com/auth/calendar.events', 'https://www.googleapis.com/auth/userinfo.email', 'openid'],
}
const MS = {
  id: process.env.MS_CALENDAR_CLIENT_ID || '',
  secret: process.env.MS_CALENDAR_CLIENT_SECRET || '',
  tenant: process.env.MS_CALENDAR_TENANT || 'common',
  scopes: ['offline_access', 'openid', 'email', 'Calendars.ReadWrite', 'User.Read'],
}
const STATE_SECRET = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dev-secret'
const APPT_MINUTES = 60   // appointments carry a start (due_at) only; assume a 1h block

export const PROVIDERS = ['google', 'microsoft']
export function providerConfigured(p) {
  if (p === 'google') return !!(GOOGLE.id && GOOGLE.secret)
  if (p === 'microsoft') return !!(MS.id && MS.secret)
  return false
}
export function anyProviderConfigured() { return providerConfigured('google') || providerConfigured('microsoft') }
const redirectUri = (p) => `${BACKEND_URL}/calendar/callback/${p}`

// ── Signed OAuth state (CSRF + which user/provider) ──────────────────────────
export function signState(payload) {
  const body = Buffer.from(JSON.stringify({ ...payload, ts: Date.now() })).toString('base64url')
  const mac = crypto.createHmac('sha256', STATE_SECRET).update(body).digest('base64url')
  return `${body}.${mac}`
}
export function verifyState(state) {
  try {
    const [body, mac] = String(state || '').split('.')
    if (!body || !mac) return null
    const expect = crypto.createHmac('sha256', STATE_SECRET).update(body).digest('base64url')
    if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expect))) return null
    const data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
    if (!data.ts || Date.now() - data.ts > 15 * 60 * 1000) return null   // 15-min window
    return data
  } catch { return null }
}

// ── Authorize URL ────────────────────────────────────────────────────────────
export function authUrl(provider, state) {
  if (provider === 'google') {
    const q = new URLSearchParams({
      client_id: GOOGLE.id, redirect_uri: redirectUri('google'), response_type: 'code',
      access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true',
      scope: GOOGLE.scopes.join(' '), state,
    })
    return `https://accounts.google.com/o/oauth2/v2/auth?${q}`
  }
  if (provider === 'microsoft') {
    const q = new URLSearchParams({
      client_id: MS.id, redirect_uri: redirectUri('microsoft'), response_type: 'code',
      response_mode: 'query', scope: MS.scopes.join(' '), state,
    })
    return `https://login.microsoftonline.com/${MS.tenant}/oauth2/v2.0/authorize?${q}`
  }
  throw new Error('Unknown provider')
}

// ── Token exchange + refresh ─────────────────────────────────────────────────
async function tokenRequest(url, params) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params) })
  const data = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(data.error_description || data.error || `token request failed (${r.status})`)
  return data
}

export async function exchangeCode(provider, code) {
  if (provider === 'google') {
    return tokenRequest('https://oauth2.googleapis.com/token', {
      code, client_id: GOOGLE.id, client_secret: GOOGLE.secret,
      redirect_uri: redirectUri('google'), grant_type: 'authorization_code',
    })
  }
  return tokenRequest(`https://login.microsoftonline.com/${MS.tenant}/oauth2/v2.0/token`, {
    code, client_id: MS.id, client_secret: MS.secret, redirect_uri: redirectUri('microsoft'),
    grant_type: 'authorization_code', scope: MS.scopes.join(' '),
  })
}

async function refreshToken(provider, refresh_token) {
  if (provider === 'google') {
    return tokenRequest('https://oauth2.googleapis.com/token', {
      refresh_token, client_id: GOOGLE.id, client_secret: GOOGLE.secret, grant_type: 'refresh_token',
    })
  }
  return tokenRequest(`https://login.microsoftonline.com/${MS.tenant}/oauth2/v2.0/token`, {
    refresh_token, client_id: MS.id, client_secret: MS.secret, grant_type: 'refresh_token', scope: MS.scopes.join(' '),
  })
}

// Return a valid access token for a connection, refreshing + persisting if stale.
async function validAccessToken(conn) {
  const skew = 60 * 1000
  if (conn.access_token && conn.token_expires_at && new Date(conn.token_expires_at).getTime() - skew > Date.now()) {
    return conn.access_token
  }
  if (!conn.refresh_token) throw new Error('No refresh token — reconnect the calendar.')
  const t = await refreshToken(conn.provider, conn.refresh_token)
  const access_token = t.access_token
  const token_expires_at = new Date(Date.now() + (Number(t.expires_in) || 3500) * 1000).toISOString()
  const patch = { access_token, token_expires_at, updated_at: new Date().toISOString() }
  if (t.refresh_token) patch.refresh_token = t.refresh_token   // MS rotates refresh tokens
  await supabaseAdmin.from('calendar_connections').update(patch).eq('id', conn.id)
  conn.access_token = access_token; conn.token_expires_at = token_expires_at
  return access_token
}

// Who did we connect? (shown in the UI so the user knows which account is linked)
export async function fetchProviderEmail(provider, accessToken) {
  try {
    if (provider === 'google') {
      const r = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', { headers: { Authorization: `Bearer ${accessToken}` } })
      const d = await r.json(); return d.email || null
    }
    const r = await fetch('https://graph.microsoft.com/v1.0/me', { headers: { Authorization: `Bearer ${accessToken}` } })
    const d = await r.json(); return d.mail || d.userPrincipalName || null
  } catch { return null }
}

// ── Event shape mapping ──────────────────────────────────────────────────────
function apptWindow(task) {
  const start = new Date(task.due_at)
  const end = new Date(start.getTime() + APPT_MINUTES * 60000)
  return { start, end }
}
function eventDescription(task, contactName) {
  const lines = ['Booked in MarketSync.']
  if (contactName) lines.push(`Customer: ${contactName}`)
  if (task.service_type) lines.push(`Service: ${task.service_type}`)
  return lines.join('\n')
}

async function apiFetch(url, accessToken, opts = {}) {
  const r = await fetch(url, { ...opts, headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', ...(opts.headers || {}) } })
  if (r.status === 204) return {}
  const data = await r.json().catch(() => ({}))
  if (!r.ok) { const e = new Error(data.error?.message || data.error_description || `calendar API ${r.status}`); e.status = r.status; throw e }
  return data
}

// ── Outbound: push one appointment to the connected calendar ─────────────────
export async function pushEvent(conn, task, contactName) {
  const token = await validAccessToken(conn)
  const { start, end } = apptWindow(task)
  const cal = encodeURIComponent(conn.calendar_id || 'primary')
  if (conn.provider === 'google') {
    const body = {
      summary: task.title || 'Appointment',
      description: eventDescription(task, contactName),
      start: { dateTime: start.toISOString() }, end: { dateTime: end.toISOString() },
      extendedProperties: { private: { marketsync_task_id: task.id } },
    }
    const base = `https://www.googleapis.com/calendar/v3/calendars/${cal}/events`
    const out = task.external_event_id
      ? await apiFetch(`${base}/${encodeURIComponent(task.external_event_id)}`, token, { method: 'PATCH', body: JSON.stringify(body) })
      : await apiFetch(base, token, { method: 'POST', body: JSON.stringify(body) })
    return out.id
  }
  // Microsoft Graph
  const body = {
    subject: task.title || 'Appointment',
    body: { contentType: 'text', content: eventDescription(task, contactName) },
    start: { dateTime: start.toISOString(), timeZone: 'UTC' }, end: { dateTime: end.toISOString(), timeZone: 'UTC' },
  }
  if (task.external_event_id) {
    const out = await apiFetch(`https://graph.microsoft.com/v1.0/me/events/${encodeURIComponent(task.external_event_id)}`, token, { method: 'PATCH', body: JSON.stringify(body) })
    return out.id || task.external_event_id
  }
  const out = await apiFetch('https://graph.microsoft.com/v1.0/me/events', token, { method: 'POST', body: JSON.stringify(body) })
  return out.id
}

export async function deleteEvent(conn, eventId) {
  if (!eventId) return
  const token = await validAccessToken(conn)
  try {
    if (conn.provider === 'google') {
      const cal = encodeURIComponent(conn.calendar_id || 'primary')
      await apiFetch(`https://www.googleapis.com/calendar/v3/calendars/${cal}/events/${encodeURIComponent(eventId)}`, token, { method: 'DELETE' })
    } else {
      await apiFetch(`https://graph.microsoft.com/v1.0/me/events/${encodeURIComponent(eventId)}`, token, { method: 'DELETE' })
    }
  } catch (e) { if (e.status !== 404 && e.status !== 410) throw e }   // already gone is fine
}

// ── Inbound: pull external events → upsert appointments ──────────────────────
// Returns { imported, updated, cancelled }. Uses an incremental cursor when the
// provider gives one; falls back to a time-boxed window otherwise.
export async function pullEvents(conn) {
  const token = await validAccessToken(conn)
  let imported = 0, updated = 0, cancelled = 0
  if (conn.provider === 'google') {
    const cal = encodeURIComponent(conn.calendar_id || 'primary')
    const params = new URLSearchParams({ singleEvents: 'true', showDeleted: 'true', maxResults: '250' })
    if (conn.sync_token) params.set('syncToken', conn.sync_token)
    else { params.set('timeMin', new Date().toISOString()); params.set('timeMax', new Date(Date.now() + 90 * 86400000).toISOString()) }
    let url = `https://www.googleapis.com/calendar/v3/calendars/${cal}/events?${params}`
    let nextSyncToken = null
    while (url) {
      let page
      try { page = await apiFetch(url, token) }
      catch (e) {
        if (e.status === 410) { await supabaseAdmin.from('calendar_connections').update({ sync_token: null }).eq('id', conn.id); conn.sync_token = null; return pullEvents(conn) }
        throw e
      }
      for (const ev of (page.items || [])) {
        const r = await upsertFromExternal(conn, {
          id: ev.id, status: ev.status, title: ev.summary,
          start: ev.start?.dateTime || (ev.start?.date ? `${ev.start.date}T09:00:00Z` : null),
        })
        imported += r.imported; updated += r.updated; cancelled += r.cancelled
      }
      nextSyncToken = page.nextSyncToken || nextSyncToken
      url = page.nextPageToken ? `https://www.googleapis.com/calendar/v3/calendars/${cal}/events?${new URLSearchParams({ singleEvents: 'true', showDeleted: 'true', maxResults: '250', pageToken: page.nextPageToken })}` : null
    }
    await supabaseAdmin.from('calendar_connections').update({ sync_token: nextSyncToken || conn.sync_token, last_synced_at: new Date().toISOString(), last_error: null }).eq('id', conn.id)
  } else {
    // Microsoft Graph delta
    let url = conn.sync_token || `https://graph.microsoft.com/v1.0/me/calendarView/delta?startDateTime=${encodeURIComponent(new Date().toISOString())}&endDateTime=${encodeURIComponent(new Date(Date.now() + 90 * 86400000).toISOString())}`
    let deltaLink = null
    while (url) {
      const page = await apiFetch(url, token)
      for (const ev of (page.value || [])) {
        const removed = ev['@removed'] || ev.isCancelled
        const raw = ev.start?.dateTime || null   // Graph returns UTC (no suffix) unless a Prefer tz is sent
        const start = raw ? (raw.endsWith('Z') ? raw : raw + 'Z') : null
        const r = await upsertFromExternal(conn, {
          id: ev.id, status: removed ? 'cancelled' : 'confirmed', title: ev.subject, start,
        })
        imported += r.imported; updated += r.updated; cancelled += r.cancelled
      }
      deltaLink = page['@odata.deltaLink'] || deltaLink
      url = page['@odata.nextLink'] || null
    }
    await supabaseAdmin.from('calendar_connections').update({ sync_token: deltaLink || conn.sync_token, last_synced_at: new Date().toISOString(), last_error: null }).eq('id', conn.id)
  }
  return { imported, updated, cancelled }
}

// Create/update/cancel a MarketSync appointment from an external event.
async function upsertFromExternal(conn, ev) {
  if (!ev.id) return { imported: 0, updated: 0, cancelled: 0 }
  const { data: existing } = await supabaseAdmin.from('crm_tasks')
    .select('id, done').eq('external_event_id', ev.id).eq('dealership_id', conn.dealership_id).maybeSingle()
  const isCancelled = ev.status === 'cancelled'
  if (isCancelled) {
    if (existing && !existing.done) { await supabaseAdmin.from('crm_tasks').update({ done: true, done_at: new Date().toISOString() }).eq('id', existing.id); return { imported: 0, updated: 0, cancelled: 1 } }
    return { imported: 0, updated: 0, cancelled: 0 }
  }
  if (!ev.start) return { imported: 0, updated: 0, cancelled: 0 }
  if (existing) {
    await supabaseAdmin.from('crm_tasks').update({ title: (ev.title || 'Appointment').slice(0, 200), due_at: new Date(ev.start).toISOString() }).eq('id', existing.id)
    return { imported: 0, updated: 1, cancelled: 0 }
  }
  await supabaseAdmin.from('crm_tasks').insert({
    dealership_id: conn.dealership_id, assigned_to: conn.user_id, created_by: conn.user_id,
    title: (ev.title || 'Appointment').slice(0, 200), type: 'appointment', category: 'calendar',
    due_at: new Date(ev.start).toISOString(), external_event_id: ev.id, external_source: conn.provider,
  })
  return { imported: 1, updated: 0, cancelled: 0 }
}

// ── Convenience: fetch the connection for a user (or dealership sweep) ────────
export async function getConnectionForUser(userId, provider = null) {
  let q = supabaseAdmin.from('calendar_connections').select('*').eq('user_id', userId)
  if (provider) q = q.eq('provider', provider)
  const { data } = await q.maybeSingle()
  return data || null
}
