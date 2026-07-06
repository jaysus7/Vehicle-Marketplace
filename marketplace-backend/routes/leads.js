import { supabaseAdmin, resend, EMAIL_FROM } from '../shared.js'
import { requireAuth } from '../middleware.js'

const xmlEsc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]))

// Build a standard ADF (Auto-lead Data Format) XML document that any dealer CRM
// can ingest. https://www.adfxml.info/
function buildAdf(lead, vehicle, dealerName) {
  const now = new Date().toISOString()
  const nameParts = String(lead.name || 'Unknown').trim()
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
      ${lead.comments ? `<comments>${xmlEsc(lead.comments)}</comments>` : ''}
    </customer>
    <vendor>
      <vendorname>${xmlEsc(dealerName || 'Dealership')}</vendorname>
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
      .select('id, name, email, phone, comments, source, status, adf_sent_at, adf_error, inventory_id, created_at')
      .eq('dealership_id', req.dealershipId)
      .order('created_at', { ascending: false })
      .limit(300)
    if (!dealerLevel) q = q.eq('created_by', req.user.id)
    const { data, error } = await q
    if (error) return res.status(500).json({ error: error.message })
    const { data: dealer } = await supabaseAdmin
      .from('dealerships').select('crm_adf_email').eq('id', req.dealershipId).maybeSingle()
    res.json({ leads: data || [], crm_adf_email: dealer?.crm_adf_email || null, can_configure: dealerLevel })
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

    // Deliver to the CRM via ADF email when configured.
    const { data: dealer } = await supabaseAdmin
      .from('dealerships').select('name, crm_adf_email').eq('id', req.dealershipId).maybeSingle()
    let delivered = false
    if (dealer?.crm_adf_email && resend) {
      const adf = buildAdf(lead, vehicle, dealer.name)
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
