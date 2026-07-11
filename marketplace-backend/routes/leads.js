import { supabaseAdmin, resend, EMAIL_FROM } from '../shared.js'
import { requireAuth } from '../middleware.js'
import { findOrCreateContact } from './crm.js'

const xmlEsc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]))

// Build a standard ADF (Auto-lead Data Format) XML document that any dealer CRM
// can ingest. https://www.adfxml.info/
function buildAdf(lead, vehicle, dealerName, rep) {
  const now = new Date().toISOString()
  const nameParts = String(lead.name || 'Unknown').trim()
  // Salesperson attribution: most CRMs (VinSolutions, DealerSocket, Elead) read the
  // assigned rep from a <salesperson> contact inside <vendor>. We also append it to
  // the comments so it's visible even on parsers that ignore the element.
  const repName = rep && rep.name ? String(rep.name).trim() : ''
  const salespersonXml = repName ? `
      <contact>
        <name part="full" type="individual">${xmlEsc(repName)}</name>
        ${rep.email ? `<email>${xmlEsc(rep.email)}</email>` : ''}
        ${rep.phone ? `<phone type="voice">${xmlEsc(rep.phone)}</phone>` : ''}
      </contact>` : ''
  const veh = vehicle ? `
    <vehicle interest="buy" status="${xmlEsc((vehicle.condition || 'used').toLowerCase())}">
      ${vehicle.year ? `<year>${xmlEsc(vehicle.year)}</year>` : ''}
      ${vehicle.make ? `<make>${xmlEsc(vehicle.make)}</make>` : ''}
      ${vehicle.model ? `<model>${xmlEsc(vehicle.model)}</model>` : ''}
      ${vehicle.trim ? `<trim>${xmlEsc(vehicle.trim)}</trim>` : ''}
      ${vehicle.vin ? `<vin>${xmlEsc(vehicle.vin)}</vin>` : ''}
      ${vehicle.stocknumber ? `<stock>${xmlEsc(vehicle.stocknumber)}</stock>` : ''}
      ${vehicle.price ? `<price type="asking" currency="CAD">${xmlEsc(vehicle.price)}</price>` : ''}
    </vehicle>` : ''

  return `<?xml version="1.0" encoding="UTF-8"?>
<?adf version="1.0"?>
<adf>
  <prospect status="new">
    <requestdate>${now}</requestdate>${veh}
    <customer>
      <contact>
        <name part="full" type="individual">${xmlEsc(nameParts)}</name>
        ${lead.email ? `<email>${xmlEsc(lead.email)}</email>` : ''}
        ${lead.phone ? `<phone type="voice" time="nopreference">${xmlEsc(lead.phone)}</phone>` : ''}
      </contact>
      <comments>${xmlEsc([lead.comments, repName ? `Salesperson: ${repName}` : ''].filter(Boolean).join(' — '))}</comments>
    </customer>
    <vendor>
      <vendorname>${xmlEsc(dealerName || 'Dealership')}</vendorname>${salespersonXml}
    </vendor>
    <provider>
      <name part="full">MarketSync</name>
      <service>Facebook Marketplace</service>
    </provider>
  </prospect>
</adf>`
}

export function registerLeads(app) {
  // List leads for the dealership (reps see their own; dealer-level sees all).
  app.get('/leads', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.json({ leads: [], crm_adf_email: null })
    const dealerLevel = ['DEALER_ADMIN', 'OWNER', 'MANAGER'].includes(req.profile.role)
    let q = supabaseAdmin.from('leads')
      .select('id, name, email, phone, comments, source, status, adf_sent_at, adf_error, inventory_id, created_by, created_at')
      .eq('dealership_id', req.dealershipId)
      .order('created_at', { ascending: false })
      .limit(300)
    if (!dealerLevel) q = q.eq('created_by', req.user.id)
    const { data, error } = await q
    if (error) return res.status(500).json({ error: error.message })

    // Attribute each lead to the rep who logged it, so a dealer-level view shows
    // the whole team's leads with who captured them.
    const repIds = [...new Set((data || []).map(l => l.created_by).filter(Boolean))]
    let repNames = {}
    if (repIds.length) {
      const { data: reps } = await supabaseAdmin
        .from('profiles').select('id, full_name, display_name').in('id', repIds)
      repNames = Object.fromEntries((reps || []).map(r => [r.id, r.full_name || r.display_name || '—']))
    }
    const leads = (data || []).map(l => ({ ...l, rep: repNames[l.created_by] || null }))

    const { data: dealer } = await supabaseAdmin
      .from('dealerships').select('crm_adf_email').eq('id', req.dealershipId).maybeSingle()
    res.json({ leads, crm_adf_email: dealer?.crm_adf_email || null, can_configure: dealerLevel })
  })

  // Capture a lead and (if a CRM address is set) deliver it as ADF XML by email.
  app.post('/leads', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership' })
    const { name, email, phone, comments, inventory_id, source } = req.body || {}
    if (!name && !email && !phone) return res.status(400).json({ error: 'Enter at least a name, phone, or email' })

    // Attach the vehicle of interest when one is chosen (verify it's ours).
    let vehicle = null
    if (inventory_id) {
      const { data: v } = await supabaseAdmin
        .from('inventory').select('id, year, make, model, trim, vin, stocknumber, price, condition, dealership_id')
        .eq('id', inventory_id).maybeSingle()
      if (v && v.dealership_id === req.dealershipId) vehicle = v
    }

    const { data: lead, error } = await supabaseAdmin
      .from('leads')
      .insert({
        dealership_id: req.dealershipId,
        created_by: req.user.id,
        inventory_id: vehicle?.id || null,
        name: name || null, email: email || null, phone: phone || null,
        comments: comments || null, source: source || 'Facebook Marketplace',
      })
      .select().single()
    if (error) return res.status(500).json({ error: error.message })

    // Land this lead on a unified CRM contact (dedupe by email/phone) so the
    // built-in CRM stays populated automatically — no double entry.
    try {
      const contactId = await findOrCreateContact({
        dealershipId: req.dealershipId, name: lead.name, email: lead.email,
        phone: lead.phone, repId: req.user.id, source: lead.source,
      })
      if (contactId) await supabaseAdmin.from('leads').update({ contact_id: contactId }).eq('id', lead.id)
    } catch (e) { console.warn('[leads] contact link failed:', e.message) }

    // Deliver to the CRM via ADF email when configured.
    const { data: dealer } = await supabaseAdmin
      .from('dealerships').select('name, crm_adf_email').eq('id', req.dealershipId).maybeSingle()
    // The salesperson who logged the lead — attached to the ADF for CRM attribution.
    const { data: repProfile } = await supabaseAdmin
      .from('profiles').select('full_name, display_name, phone').eq('id', req.user.id).maybeSingle()
    const rep = {
      name: repProfile?.full_name || repProfile?.display_name || '',
      email: req.user?.email || '',
      phone: repProfile?.phone || '',
    }
    let delivered = false
    if (dealer?.crm_adf_email && resend) {
      const adf = buildAdf(lead, vehicle, dealer.name, rep)
      try {
        await resend.emails.send({
          from: EMAIL_FROM,
          to: dealer.crm_adf_email,
          subject: `ADF Lead${vehicle ? ' — ' + [vehicle.year, vehicle.make, vehicle.model].filter(Boolean).join(' ') : ''}`,
          text: adf,
          attachments: [{ filename: 'lead.adf.xml', content: Buffer.from(adf).toString('base64') }],
        })
        await supabaseAdmin.from('leads').update({ adf_sent_at: new Date().toISOString(), status: 'sent' }).eq('id', lead.id)
        delivered = true
      } catch (e) {
        await supabaseAdmin.from('leads').update({ adf_error: e.message }).eq('id', lead.id)
      }
    }
    res.json({ ok: true, lead, delivered, crm_configured: !!dealer?.crm_adf_email })
  })

  // Dealer admins set/clear the CRM's ADF intake email.
  app.put('/leads/crm-email', requireAuth, async (req, res) => {
    if (!['DEALER_ADMIN', 'OWNER', 'MANAGER'].includes(req.profile.role)) {
      return res.status(403).json({ error: 'Dealer admin required' })
    }
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership' })
    const email = String(req.body?.crm_adf_email || '').trim() || null
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'Invalid email' })
    const { error } = await supabaseAdmin
      .from('dealerships').update({ crm_adf_email: email }).eq('id', req.dealershipId)
    if (error) return res.status(500).json({ error: error.message })
    res.json({ ok: true, crm_adf_email: email })
  })

  // Re-send a lead's ADF (e.g. after fixing the CRM address).
  app.post('/leads/:id/resend', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership' })
    const { data: lead } = await supabaseAdmin
      .from('leads').select('*').eq('id', req.params.id).eq('dealership_id', req.dealershipId).maybeSingle()
    if (!lead) return res.status(404).json({ error: 'Lead not found' })
    const { data: dealer } = await supabaseAdmin
      .from('dealerships').select('name, crm_adf_email').eq('id', req.dealershipId).maybeSingle()
    if (!dealer?.crm_adf_email) return res.status(400).json({ error: 'Set your CRM ADF email first' })
    if (!resend) return res.status(503).json({ error: 'Email not configured' })

    let vehicle = null
    if (lead.inventory_id) {
      const { data: v } = await supabaseAdmin.from('inventory')
        .select('id, year, make, model, trim, vin, stocknumber, price, condition').eq('id', lead.inventory_id).maybeSingle()
      vehicle = v || null
    }
    const adf = buildAdf(lead, vehicle, dealer.name)
    try {
      await resend.emails.send({
        from: EMAIL_FROM, to: dealer.crm_adf_email,
        subject: `ADF Lead (resend)${vehicle ? ' — ' + [vehicle.year, vehicle.make, vehicle.model].filter(Boolean).join(' ') : ''}`,
        text: adf,
        attachments: [{ filename: 'lead.adf.xml', content: Buffer.from(adf).toString('base64') }],
      })
      await supabaseAdmin.from('leads').update({ adf_sent_at: new Date().toISOString(), status: 'sent', adf_error: null }).eq('id', lead.id)
      res.json({ ok: true })
    } catch (e) {
      await supabaseAdmin.from('leads').update({ adf_error: e.message }).eq('id', lead.id)
      res.status(500).json({ error: e.message })
    }
  })
}
