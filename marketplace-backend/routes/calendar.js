/**
 * Calendar sync routes — connect/disconnect Google & Outlook, run syncs, and the
 * outbound hook the CRM calls when an appointment changes.
 *
 *   GET  /calendar/status                  what's configured + connected (per user)
 *   GET  /calendar/connect/:provider       -> { url } to start OAuth
 *   GET  /calendar/callback/:provider       OAuth redirect target (public)
 *   POST /calendar/disconnect/:provider     remove a connection (+ best-effort revoke)
 *   POST /calendar/sync-now                  pull external events for this user now
 *   POST /cron/calendar-pull                 sweep all connections (CRON_SECRET)
 *
 * syncAppointmentOut(taskId, action) is exported for crm.js / service.js to call
 * fire-and-forget after they create/update/complete an appointment task.
 */
import { supabaseAdmin, FRONTEND_URL } from '../shared.js'
import { requireAuth } from '../middleware.js'
import { audit, AuditAction } from '../audit.js'
import {
  PROVIDERS, providerConfigured, anyProviderConfigured, authUrl, signState, verifyState,
  exchangeCode, fetchProviderEmail, pushEvent, deleteEvent, pullEvents, getConnectionForUser,
} from '../calendarSync.js'

const label = (p) => (p === 'google' ? 'Google Calendar' : p === 'microsoft' ? 'Outlook Calendar' : p)

export function registerCalendar(app) {
  app.get('/calendar/status', requireAuth, async (req, res) => {
    const { data: conns } = await supabaseAdmin.from('calendar_connections')
      .select('provider, provider_email, calendar_id, last_synced_at, last_error, created_at')
      .eq('user_id', req.user.id)
    const byProvider = Object.fromEntries((conns || []).map(c => [c.provider, c]))
    res.json({
      ok: true,
      providers: PROVIDERS.map(p => ({
        provider: p, label: label(p),
        configured: providerConfigured(p),
        connected: !!byProvider[p],
        account: byProvider[p]?.provider_email || null,
        last_synced_at: byProvider[p]?.last_synced_at || null,
        last_error: byProvider[p]?.last_error || null,
      })),
      any_configured: anyProviderConfigured(),
    })
  })

  app.get('/calendar/connect/:provider', requireAuth, async (req, res) => {
    const provider = req.params.provider
    if (!PROVIDERS.includes(provider)) return res.status(400).json({ error: 'Unknown provider' })
    if (!providerConfigured(provider)) return res.status(501).json({ error: `${label(provider)} isn’t configured on this server yet.` })
    const state = signState({ uid: req.user.id, did: req.dealershipId, p: provider })
    res.json({ ok: true, url: authUrl(provider, state) })
  })

  // OAuth redirect target. Public (the provider calls it), but the signed state
  // carries + verifies which user started the flow. Always redirects back to the
  // dashboard with a friendly status rather than returning JSON.
  app.get('/calendar/callback/:provider', async (req, res) => {
    const provider = req.params.provider
    const done = (ok, msg) => res.redirect(`${FRONTEND_URL}/dashboard.html?calendar=${ok ? 'connected' : 'error'}&provider=${provider}&msg=${encodeURIComponent(msg || '')}`)
    try {
      if (!PROVIDERS.includes(provider) || !providerConfigured(provider)) return done(false, 'Not configured')
      if (req.query.error) return done(false, String(req.query.error_description || req.query.error))
      const st = verifyState(req.query.state)
      if (!st || st.p !== provider) return done(false, 'This connection link expired — try again.')
      const tok = await exchangeCode(provider, String(req.query.code || ''))
      if (!tok.access_token) return done(false, 'Could not complete the connection.')
      const expires = new Date(Date.now() + (Number(tok.expires_in) || 3500) * 1000).toISOString()
      const email = await fetchProviderEmail(provider, tok.access_token)
      const row = {
        dealership_id: st.did || null, user_id: st.uid, provider, provider_email: email,
        access_token: tok.access_token, refresh_token: tok.refresh_token || null,
        token_expires_at: expires, calendar_id: 'primary', sync_token: null,
        last_error: null, updated_at: new Date().toISOString(),
      }
      // Upsert on (user_id, provider). Keep an existing refresh token if the
      // provider didn't return a new one (Google only sends it on first consent).
      const { data: existing } = await supabaseAdmin.from('calendar_connections').select('id, refresh_token').eq('user_id', st.uid).eq('provider', provider).maybeSingle()
      if (existing) {
        if (!row.refresh_token) row.refresh_token = existing.refresh_token
        await supabaseAdmin.from('calendar_connections').update(row).eq('id', existing.id)
      } else {
        await supabaseAdmin.from('calendar_connections').insert(row)
      }
      audit({ user: { id: st.uid, email }, dealershipId: st.did, headers: req.headers }, AuditAction.CONFIG_UPDATED, { calendar_connected: provider })
      done(true, label(provider))
    } catch (e) {
      console.error('[calendar] callback failed:', e.message)
      done(false, e.message)
    }
  })

  app.post('/calendar/disconnect/:provider', requireAuth, async (req, res) => {
    const provider = req.params.provider
    await supabaseAdmin.from('calendar_connections').delete().eq('user_id', req.user.id).eq('provider', provider)
    audit(req, AuditAction.CONFIG_UPDATED, { calendar_disconnected: provider })
    res.json({ ok: true })
  })

  app.post('/calendar/sync-now', requireAuth, async (req, res) => {
    const { data: conns } = await supabaseAdmin.from('calendar_connections').select('*').eq('user_id', req.user.id)
    if (!conns?.length) return res.status(400).json({ error: 'No calendar connected.' })
    const results = []
    for (const conn of conns) {
      try { const r = await pullEvents(conn); results.push({ provider: conn.provider, ...r }) }
      catch (e) {
        await supabaseAdmin.from('calendar_connections').update({ last_error: e.message?.slice(0, 300) || 'sync failed' }).eq('id', conn.id)
        results.push({ provider: conn.provider, error: e.message })
      }
    }
    res.json({ ok: true, results })
  })

  // Periodic inbound sweep for every connection. Set up as a Render Cron Job:
  //   curl -X POST https://<backend>/cron/calendar-pull -H "x-cron-secret: $CRON_SECRET"
  app.post('/cron/calendar-pull', async (req, res) => {
    if ((req.headers['x-cron-secret'] || '').trim() !== (process.env.CRON_SECRET || '').trim()) {
      return res.status(403).json({ error: 'Forbidden' })
    }
    const { data: conns } = await supabaseAdmin.from('calendar_connections').select('*').limit(1000)
    let ok = 0, failed = 0
    for (const conn of (conns || [])) {
      try { await pullEvents(conn); ok++ }
      catch (e) { failed++; await supabaseAdmin.from('calendar_connections').update({ last_error: e.message?.slice(0, 300) || 'sync failed' }).eq('id', conn.id) }
    }
    res.json({ ok: true, synced: ok, failed })
  })
}

// ── Outbound hook (fire-and-forget) ──────────────────────────────────────────
// Called by the CRM after an appointment task is created/updated/completed. Mirrors
// the change to the assigned user's connected calendar(s). Never throws.
export async function syncAppointmentOut(taskId, action = 'upsert') {
  try {
    if (!anyProviderConfigured()) return
    const { data: task } = await supabaseAdmin.from('crm_tasks').select('*').eq('id', taskId).maybeSingle()
    if (!task || task.type !== 'appointment') return
    // Sync to the assigned rep's calendar (fall back to the creator).
    const ownerId = task.assigned_to || task.created_by
    if (!ownerId) return
    const conn = await getConnectionForUser(ownerId)
    if (!conn) return

    // A completed/cancelled MarketSync appointment removes the external event.
    if (action === 'delete' || task.done) {
      if (task.external_event_id) { await deleteEvent(conn, task.external_event_id); await supabaseAdmin.from('crm_tasks').update({ external_event_id: null }).eq('id', task.id) }
      return
    }
    // Don't echo an event we just imported FROM this same calendar back to it.
    if (task.external_source === conn.provider && task.external_event_id && task.category === 'calendar') return

    let contactName = null
    if (task.contact_id) { const { data: c } = await supabaseAdmin.from('contacts').select('full_name, first_name, last_name').eq('id', task.contact_id).maybeSingle(); contactName = c?.full_name || [c?.first_name, c?.last_name].filter(Boolean).join(' ') || null }
    const eventId = await pushEvent(conn, task, contactName)
    if (eventId && eventId !== task.external_event_id) {
      await supabaseAdmin.from('crm_tasks').update({ external_event_id: eventId, external_source: conn.provider }).eq('id', task.id)
    }
  } catch (e) {
    console.error('[calendar] outbound sync failed for task', taskId, '—', e.message)
  }
}
