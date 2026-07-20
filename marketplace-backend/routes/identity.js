/**
 * Identity verification — Stripe Identity. A rep starts a real check on a customer
 * (government-ID document authentication + a matching selfie / liveness). Stripe
 * does the document + biometric work; we store only the pass/fail status and a
 * non-sensitive summary on the contact. The ID images live at Stripe, not here.
 *
 *   POST /identity/start    { contact_id } -> { url }  (hosted verification link)
 *   GET  /identity/status?contact_id       -> current status (polls Stripe)
 *
 * Uses the existing STRIPE_SECRET_KEY. Requires Stripe Identity to be enabled on
 * the Stripe account; if it isn't, Stripe returns an error we surface plainly.
 */
import { stripe, supabaseAdmin, FRONTEND_URL } from '../shared.js'
import { requireAuth } from '../middleware.js'
import { audit, AuditAction } from '../audit.js'

const configured = () => !!process.env.STRIPE_SECRET_KEY

export function registerIdentity(app) {
  app.get('/identity/config', requireAuth, (req, res) => res.json({ ok: true, configured: configured() }))

  app.post('/identity/start', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership' })
    if (!configured()) return res.status(501).json({ error: 'Identity verification isn’t configured on this server yet.' })
    const contactId = String(req.body?.contact_id || '')
    if (!contactId) return res.status(400).json({ error: 'contact_id required' })
    const { data: contact } = await supabaseAdmin.from('contacts')
      .select('id, full_name, email').eq('id', contactId).eq('dealership_id', req.dealershipId).maybeSingle()
    if (!contact) return res.status(404).json({ error: 'Customer not found' })
    try {
      const vs = await stripe.identity.verificationSessions.create({
        type: 'document',
        metadata: { dealership_id: req.dealershipId, contact_id: contactId },
        options: { document: { require_matching_selfie: true, require_live_capture: true } },
        return_url: `${FRONTEND_URL.replace(/\/$/, '')}/dashboard.html?idv=done&contact=${encodeURIComponent(contactId)}`,
      })
      await supabaseAdmin.from('contacts').update({
        id_verification_session: vs.id, id_verification_status: 'pending', id_verified_at: null, id_verification_report: null,
      }).eq('id', contactId)
      audit(req, AuditAction.CONFIG_UPDATED, { id_verification_started: contactId })
      res.json({ ok: true, url: vs.url, status: vs.status })
    } catch (e) {
      // Most common: Identity not enabled on the account.
      const msg = /not.*enabled|activate|identity/i.test(e.message || '')
        ? 'Turn on Stripe Identity in your Stripe dashboard (Settings → Identity) to use verification.'
        : (e.message || 'Could not start verification.')
      res.status(400).json({ error: msg })
    }
  })

  app.get('/identity/status', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership' })
    const contactId = String(req.query.contact_id || '')
    if (!contactId) return res.status(400).json({ error: 'contact_id required' })
    const { data: contact } = await supabaseAdmin.from('contacts')
      .select('id, id_verification_status, id_verification_session, id_verified_at, id_verification_report')
      .eq('id', contactId).eq('dealership_id', req.dealershipId).maybeSingle()
    if (!contact) return res.status(404).json({ error: 'Customer not found' })
    // No session yet, or Stripe not configured — just return what we have.
    if (!contact.id_verification_session || !configured()) {
      return res.json({ ok: true, status: contact.id_verification_status || 'unstarted', verified_at: contact.id_verified_at, report: contact.id_verification_report })
    }
    try {
      const vs = await stripe.identity.verificationSessions.retrieve(contact.id_verification_session)
      const status = vs.status  // requires_input | processing | verified | canceled
      const patch = { id_verification_status: status }
      let report = contact.id_verification_report
      if (status === 'verified') {
        patch.id_verified_at = contact.id_verified_at || new Date().toISOString()
        // Pull a non-sensitive summary (name + document type + selfie match), not the images.
        try {
          const full = await stripe.identity.verificationSessions.retrieve(contact.id_verification_session, { expand: ['verified_outputs'] })
          const vo = full.verified_outputs || {}
          report = { name: [vo.first_name, vo.last_name].filter(Boolean).join(' ') || null, dob: vo.dob ? `${vo.dob.year}-${String(vo.dob.month).padStart(2, '0')}-${String(vo.dob.day).padStart(2, '0')}` : null, document_type: vo.id_number_type || 'document', selfie_matched: true }
          patch.id_verification_report = report
        } catch {}
      } else if (status === 'requires_input' && vs.last_error) {
        report = { ...(report || {}), last_error: vs.last_error.reason || 'Verification needs another attempt.' }
        patch.id_verification_report = report
      }
      await supabaseAdmin.from('contacts').update(patch).eq('id', contactId)
      res.json({ ok: true, status, verified_at: patch.id_verified_at || contact.id_verified_at, report })
    } catch (e) {
      res.json({ ok: true, status: contact.id_verification_status || 'unstarted', verified_at: contact.id_verified_at, report: contact.id_verification_report, error: e.message })
    }
  })
}
