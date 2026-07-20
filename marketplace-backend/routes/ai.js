import Anthropic from '@anthropic-ai/sdk'
import { supabaseAdmin, resend, EMAIL_FROM, FRONTEND_URL, browserFetch } from '../shared.js'
import { requireAuth } from '../middleware.js'
import { marketcheckMarket, marketcheckListings, marketcheckEnabled, marketcheckCompetitorStats, marketcheckPing, marketcheckDecodeVin, marketcheckPredictPrice, marketcheckMarketStats } from '../marketcheck.js'
import { getMarketData, getSoldData, recordUsage, aiAllowed, getUsage, assistantDailyAllowed, recordAssistantChat, ASSISTANT_DAILY_LIMIT, marketcheckAllowed, recordMarketcheckCall } from '../usage.js'
import { findOrCreateContact } from './crm.js'
import { buildEquityRadar } from './equity.js'
import { buildMarketingRoi } from './marketing.js'
import { createNotification, createNotifications } from '../notifications.js'
import { runPhotoVision, scoreVehiclePhotos } from '../sync/photoVision.js'
import { fetchOemWindowStickerPdf } from '../utils/oemWindowSticker.js'
import { lookupPlate, plateLookupConfigured } from '../providers/plateLookup.js'
import { audit, AuditAction } from '../audit.js'
import {
  OWNER_EMAIL, attachOemStickerToInventory, LANG_NAME, langName,
  PRODUCT_KB, ASSISTANT_TOOLS, REPORT_TOPICS,
  buildDealershipReport, runAssistantTool,
  skipPriceComp, PRICE_MIN_COMPS, buildPriceFlag, aiErrorMessage,
  marketMedianForScan, requireDealerAdmin, median, mileageAdjustedMedian,
  computeDailyDigest,
} from './ai-helpers.js'
import { registerAiPricing } from './ai-pricing.js'
import { SMART_MODEL } from '../aiModels.js'


export function registerAI(app) {
  registerAiPricing(app)   // inventory-intelligence / pricing / vision / competitor routes
  // GET /ai/config — returns dealership's AI config
  app.get('/ai/config', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership associated' })
    const { data, error } = await supabaseAdmin
      .from('dealerships')
      .select('ai_boost_active, ai_tone, ai_required_fields, ai_manager_email, vin_sticker_active, inv_intel_active, ai_vision_active, ai_boost_paid, inv_intel_paid, full_access_until, photo_background_url, country, province, city, postal_code, daily_digest_enabled, legal_name, street_address, phone, fax, hst_number, omvic_reg, plan, desk_fees, ai_internal_style, ai_customer_style, ai_knowledge, ai_knowledge_name, cost_tracking_enabled, cost_rep_visible, autoresponder_mode, autoresponder_channel')
      .eq('id', req.dealershipId)
      .single()
    if (error) return res.status(500).json({ error: error.message })
    const isOwner = (req.user.email || '').toLowerCase() === OWNER_EMAIL

    // 30-day full-access onboarding: everything is on until full_access_until. This
    // is the self-healing expiry — the first config load after the window closes
    // drops each add-on to whatever was actually paid for. (A cron sweep is the
    // backstop for dealers who aren't logged in.)
    const fa = data.full_access_until ? new Date(data.full_access_until) : null
    const fullAccess = !!fa && fa.getTime() > Date.now()
    if (fa && !fullAccess) {
      await supabaseAdmin.from('dealerships').update({
        ai_boost_active: !!data.ai_boost_paid,
        inv_intel_active: !!data.inv_intel_paid,
        full_access_until: null,
      }).eq('id', req.dealershipId)
      data.ai_boost_active = !!data.ai_boost_paid
      data.inv_intel_active = !!data.inv_intel_paid
      data.full_access_until = null
    }

    // Entitlement model:
    //  • AI Boost is the master switch for ALL AI (listing copy, price reports,
    //    AI Vision, generated/branded sticker & brochure, AI lot narrative).
    //  • Inventory Intelligence includes the VIN decoder + factory OEM docs.
    //  • The AI lot narrative inside Inv Intel needs AI Boost too.
    const aiBoost = isOwner || fullAccess || !!data.ai_boost_active
    const invIntel = isOwner || fullAccess || !!data.inv_intel_active
    const trialDaysLeft = fullAccess ? Math.ceil((fa.getTime() - Date.now()) / 86400000) : 0
    res.json({
      ...data,
      ai_boost_active: aiBoost,
      inv_intel_active: invIntel,
      vin_sticker_active: invIntel,      // VIN decoder is part of Inventory Intelligence
      ai_docs_active: aiBoost,           // generated/branded sticker & AI brochure
      ai_vision_active: aiBoost,         // AI Vision folded into AI Boost
      full_access: fullAccess,           // in the 30-day everything-on window
      full_access_until: data.full_access_until,
      trial_days_left: trialDaysLeft,
      // Photo tools: is a branded background set, and is the AI cutout provider keyed?
      photo_background_url: data.photo_background_url || null,
      background_provider_ready: !!process.env.REMOVEBG_API_KEY,
      // Trade appraisal: is a plate→VIN provider provisioned? (hides the plate UI if not)
      plate_lookup_ready: plateLookupConfigured(),
    })
  })

  // PUT /ai/config — update dealership AI config (DEALER_ADMIN only)
  app.put('/ai/config', requireAuth, requireDealerAdmin, async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership associated' })
    const { ai_tone, ai_required_fields, ai_manager_email, ai_boost_active, country, province, city, postal_code, daily_digest_enabled,
      legal_name, street_address, phone, fax, hst_number, omvic_reg } = req.body
    const update = {}
    if (ai_tone !== undefined) update.ai_tone = ai_tone
    if (ai_required_fields !== undefined) update.ai_required_fields = ai_required_fields
    if (ai_manager_email !== undefined) update.ai_manager_email = ai_manager_email
    if (ai_boost_active !== undefined) update.ai_boost_active = ai_boost_active
    if (daily_digest_enabled !== undefined) update.daily_digest_enabled = !!daily_digest_enabled
    // Market/location — drives US-vs-Canada pricing and comp searches.
    if (country !== undefined) update.country = (country || '').trim() || null
    if (province !== undefined) update.province = (province || '').trim() || null
    if (city !== undefined) update.city = (city || '').trim() || null
    if (postal_code !== undefined) update.postal_code = (postal_code || '').trim() || null
    // Legal identifiers + full contact for the OMVIC deal documents.
    if (legal_name !== undefined) update.legal_name = (legal_name || '').trim() || null
    if (street_address !== undefined) update.street_address = (street_address || '').trim() || null
    if (phone !== undefined) update.phone = (phone || '').trim() || null
    if (fax !== undefined) update.fax = (fax || '').trim() || null
    if (hst_number !== undefined) update.hst_number = (hst_number || '').trim() || null
    if (omvic_reg !== undefined) update.omvic_reg = (omvic_reg || '').trim() || null
    // Vehicle-cost tracking (internal gross): on/off + whether sales reps can see it.
    if (req.body.cost_tracking_enabled !== undefined) update.cost_tracking_enabled = !!req.body.cost_tracking_enabled
    if (req.body.cost_rep_visible !== undefined) update.cost_rep_visible = !!req.body.cost_rep_visible
    // Instant AI lead auto-responder: off / draft / auto, email or SMS.
    if (req.body.autoresponder_mode !== undefined) update.autoresponder_mode = ['off', 'draft', 'auto'].includes(req.body.autoresponder_mode) ? req.body.autoresponder_mode : 'off'
    if (req.body.autoresponder_channel !== undefined) update.autoresponder_channel = req.body.autoresponder_channel === 'sms' ? 'sms' : 'email'
    // AI persona/style prompts + knowledge base. Style prompts steer tone/voice;
    // the knowledge base is grounding text both the internal assistant and the
    // customer chat can draw on. Bounded so they can't blow up the prompt/cost.
    if (req.body.ai_internal_style !== undefined) update.ai_internal_style = (req.body.ai_internal_style || '').toString().trim().slice(0, 2000) || null
    if (req.body.ai_customer_style !== undefined) update.ai_customer_style = (req.body.ai_customer_style || '').toString().trim().slice(0, 2000) || null
    if (req.body.ai_knowledge !== undefined) update.ai_knowledge = (req.body.ai_knowledge || '').toString().trim().slice(0, 12000) || null
    if (req.body.ai_knowledge_name !== undefined) update.ai_knowledge_name = (req.body.ai_knowledge_name || '').toString().trim().slice(0, 200) || null
    // Deal-desk fee schedule set by management: [{name, amount, taxable, locked}].
    // `locked` fees can't be edited per-deal on the desk; unlocked ones can.
    if (req.body.desk_fees !== undefined) {
      update.desk_fees = Array.isArray(req.body.desk_fees)
        ? req.body.desk_fees.slice(0, 30).map(f => ({
            name: String(f?.name || '').trim().slice(0, 80),
            amount: Math.max(0, Number(f?.amount) || 0),
            taxable: f?.taxable !== false,
            locked: f?.locked === true,
          })).filter(f => f.name)
        : null
    }

    const { data, error } = await supabaseAdmin
      .from('dealerships')
      .update(update)
      .eq('id', req.dealershipId)
      .select('ai_boost_active, ai_tone, ai_required_fields, ai_manager_email, country, province, city, postal_code, daily_digest_enabled, legal_name, street_address, phone, fax, hst_number, omvic_reg, desk_fees, ai_internal_style, ai_customer_style, ai_knowledge, ai_knowledge_name, cost_tracking_enabled, cost_rep_visible, autoresponder_mode, autoresponder_channel')
      .single()
    if (error) return res.status(500).json({ error: error.message })
    // Audit sensitive setting changes — especially the internal-cost visibility flags.
    const changed = Object.keys(update)
    if (changed.length) audit(req, AuditAction.CONFIG_UPDATED, { fields: changed })
    if (req.body.cost_tracking_enabled !== undefined || req.body.cost_rep_visible !== undefined) {
      audit(req, AuditAction.COST_VISIBILITY_CHANGED, {
        cost_tracking_enabled: !!data.cost_tracking_enabled,
        cost_rep_visible: !!data.cost_rep_visible,
      })
    }
    res.json(data)
  })

  // POST /ai/knowledge-upload — extract text from an uploaded KB file (txt/md/csv,
  // or a text-based PDF) and store it as the dealership knowledge base. DEALER_ADMIN.
  app.post('/ai/knowledge-upload', requireAuth, requireDealerAdmin, async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership associated' })
    const name = String(req.body?.name || 'knowledge').slice(0, 200)
    let text = String(req.body?.text || '')
    // The client extracts plain text for txt/md/csv and sends it directly. For PDFs it
    // sends the raw text it could pull; we just store whatever text arrives, trimmed.
    text = text.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, 12000)
    if (!text) return res.status(400).json({ error: 'Couldn’t read any text from that file — paste the text instead.' })
    const { error } = await supabaseAdmin.from('dealerships')
      .update({ ai_knowledge: text, ai_knowledge_name: name }).eq('id', req.dealershipId)
    if (error) return res.status(500).json({ error: 'Could not save the knowledge base.' })
    res.json({ ok: true, name, chars: text.length })
  })

  // POST /ai/enrich-listing — run AI enrichment on an inventory item
  app.post('/ai/enrich-listing', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership associated' })

    const { inventory_id } = req.body
    if (!inventory_id) return res.status(400).json({ error: 'inventory_id required' })
    // Target language for the Facebook listing copy: an explicit body value, else
    // the posting rep's own preference (set via the Google Translate widget).
    let language = String(req.body?.language || '').trim().slice(0, 40)

    // Fetch inventory item
    const { data: vehicle, error: invErr } = await supabaseAdmin
      .from('inventory')
      .select('*')
      .eq('id', inventory_id)
      .eq('dealership_id', req.dealershipId)
      .single()
    if (invErr || !vehicle) return res.status(404).json({ error: 'Inventory item not found' })

    // Fetch dealership AI config + location for market price comps
    const { data: dealer, error: dealerErr } = await supabaseAdmin
      .from('dealerships')
      .select('ai_boost_active, ai_tone, ai_required_fields, ai_manager_email, city, province, country, postal_code')
      .eq('id', req.dealershipId)
      .single()
    if (dealerErr) return res.status(500).json({ error: dealerErr.message })

    const isOwner = (req.user.email || '').toLowerCase() === OWNER_EMAIL
    if (!isOwner && !dealer.ai_boost_active) {
      return res.status(403).json({ error: 'AI Boost subscription is not active for this dealership' })
    }
    // Resolve the copy language: explicit request → this rep's saved preference.
    if (!language) {
      const { data: me } = await supabaseAdmin.from('profiles')
        .select('preferred_language').eq('id', req.user.id).maybeSingle()
      language = me?.preferred_language || ''
    }
    language = langName(language)
    // Meter the AI listing-copy generation against the soft AI cap.
    recordUsage(req.dealershipId, { ai: 1 })

    // Check Anthropic API key
    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(503).json({ error: 'AI features not configured' })
    }

    // ── Missing field checks ──
    const warnings = []
    const requiredFields = dealer.ai_required_fields || ['price', 'mileage', 'image_urls']
    if (requiredFields.includes('price') && (!vehicle.price || Number(vehicle.price) === 0)) {
      warnings.push('Missing or zero price')
    }
    if (requiredFields.includes('mileage') && vehicle.mileage == null) {
      warnings.push('Missing mileage')
    }
    if (requiredFields.includes('image_urls') && (!vehicle.image_urls || vehicle.image_urls.length === 0)) {
      warnings.push('No photos attached')
    }
    if (requiredFields.includes('description') && (!vehicle.description || vehicle.description.length < 20)) {
      warnings.push('Description is missing or too short')
    }

    // Send email alert if there are warnings and manager email is set
    if (warnings.length > 0 && dealer.ai_manager_email && resend) {
      const vehicleLabel = `${vehicle.year} ${vehicle.make} ${vehicle.model}${vehicle.trim ? ' ' + vehicle.trim : ''}`
      await resend.emails.send({
        from: EMAIL_FROM,
        to: dealer.ai_manager_email,
        subject: `Missing info alert: ${vehicleLabel}`,
        html: `<p>The following required fields are missing for <strong>${vehicleLabel}</strong> (Stock #${vehicle.stocknumber || 'N/A'}):</p><ul>${warnings.map(w => `<li>${w}</li>`).join('')}</ul><p>Please update the listing before posting.</p>`
      }).catch(() => {}) // non-blocking — don't fail the request
      // Mirror the email as an in-app notification, deep-linked to the vehicle.
      await createNotification({
        dealershipId: req.dealershipId,
        type: 'email_sent',
        title: `Missing-info email sent: ${vehicleLabel}`,
        body: `Emailed ${dealer.ai_manager_email} — ${warnings.join(', ')}.`,
        linkPage: 'inventory',
        linkFilter: vehicle.stocknumber || vehicle.vin || '',
      })
    }

    // ── Price comp check vs external marketplaces ──
    // Skip for new vehicles — MSRP pricing doesn't need market comp.
    let price_flag = null
    if (!skipPriceComp(vehicle) && vehicle.price && vehicle.make && vehicle.model && vehicle.year) {
      const countryRaw = (dealer?.country || '').trim().toUpperCase()
      const _isUS = countryRaw === 'US' || countryRaw === 'USA' || countryRaw === 'UNITED STATES'
      const _isOwner = (req.user.email || '').toLowerCase() === OWNER_EMAIL
      const mm = await marketMedianForScan({ vehicle, dealer, isUS: _isUS, dealershipId: req.dealershipId, isOwner: _isOwner })
      if (mm) price_flag = buildPriceFlag(vehicle.price, mm.median, mm.source, mm.count, mm.matched_on ? !!mm.matched_on.trim : null)
    }

    // ── Generate AI copy via Anthropic ──
    const tone = dealer.ai_tone || 'professional'
    const toneInstruction = tone === 'friendly'
      ? 'Use a warm, approachable, conversational tone. You may use friendly language.'
      : tone === 'aggressive'
        ? 'Use an urgent, deal-focused tone. Emphasize value and urgency.'
        : 'Use a professional, informative tone. Be clear and factual. No emoji.'

    const vehicleDetails = [
      vehicle.year && vehicle.make && vehicle.model
        ? `${vehicle.year} ${vehicle.make} ${vehicle.model}${vehicle.trim ? ' ' + vehicle.trim : ''}`
        : null,
      vehicle.mileage ? `Mileage: ${Number(vehicle.mileage).toLocaleString()} km` : null,
      vehicle.price ? `Price: $${Number(vehicle.price).toLocaleString()}` : null,
      vehicle.condition ? `Condition: ${vehicle.condition}` : null,
      vehicle.exterior_color ? `Colour: ${vehicle.exterior_color}` : null,
      vehicle.stocknumber ? `Stock #: ${vehicle.stocknumber}` : null,
      vehicle.description ? `Description: ${vehicle.description}` : null,
    ].filter(Boolean).join('\n')

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

    let copy = null
    try {
      const message = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 512,
        messages: [
          {
            role: 'user',
            content: `You are writing a Facebook Marketplace vehicle listing. ${toneInstruction}

Vehicle details:
${vehicleDetails}

Write a compelling listing in under 280 words. Include the year/make/model/trim, mileage, price, condition, colour, and key highlights from the description. Do not invent details not provided. ${tone !== 'friendly' ? 'No emoji.' : 'Minimal emoji only if it enhances readability.'}${language && !/^en(g|glish)?$/i.test(language) ? `\n\nWrite the entire listing in ${language}. Keep the price, mileage number, VIN and stock number as-is.` : ''}`
          }
        ]
      })
      copy = message.content[0]?.text || null
    } catch (aiErr) {
      return res.status(502).json({ error: aiErrorMessage(aiErr) })
    }

    // Log activity so the dealer can see what AI found
    supabaseAdmin.from('ai_activity').insert({
      dealership_id: req.dealershipId,
      inventory_id,
      actor_id: req.user.id,
      vehicle_label: [vehicle.year, vehicle.make, vehicle.model, vehicle.trim].filter(Boolean).join(' '),
      warnings: warnings.length > 0 ? warnings : null,
      price_flagged: !!(price_flag?.flagged),
      price_pct_diff: price_flag?.pct_diff ?? null,
      price_median: price_flag?.median ?? null,
      comp_count: price_flag?.comp_count ?? null,
      trim_matched: price_flag?.trim_matched ?? null,
      copy_generated: !!copy
    }).then(() => {}).catch(() => {}) // fire-and-forget

    res.json({ copy, warnings, price_flag })
  })

  // POST /ai/sync-all — run AI enrichment on all active inventory for the dealership
  // Runs in background; returns immediately with a count. Results appear in /ai/activity.
  app.post('/ai/sync-all', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership associated' })

    const { data: dealer } = await supabaseAdmin
      .from('dealerships')
      .select('ai_boost_active, inv_intel_active, ai_tone, ai_required_fields, ai_manager_email, city, province, country, postal_code')
      .eq('id', req.dealershipId)
      .single()

    const isOwner = (req.user.email || '').toLowerCase() === OWNER_EMAIL
    // The Inventory Scan lives on the Inventory page and is part of the Inventory
    // Intelligence add-on — it refreshes each vehicle's market comps / % to market
    // (a metered MarketCheck call), so we gate it to Inventory Intelligence.
    if (!isOwner && !dealer?.inv_intel_active) {
      return res.status(403).json({ error: 'Inventory Intelligence add-on required' })
    }

    // Light cooldown so "Scan All" can't be hammered (owner exempt). Caching
    // already makes re-scans cheap; this is just abuse protection.
    if (!isOwner) {
      const { data: last } = await supabaseAdmin
        .from('ai_activity').select('created_at')
        .eq('dealership_id', req.dealershipId)
        .order('created_at', { ascending: false }).limit(1).maybeSingle()
      const cooldownMin = Number(process.env.SCAN_COOLDOWN_MIN || 10)
      if (last && (Date.now() - new Date(last.created_at)) < cooldownMin * 60000) {
        return res.status(429).json({ error: `Inventory was just scanned — please wait a few minutes before running it again.` })
      }
    }

    const { data: vehicles, error } = await supabaseAdmin
      .from('inventory')
      .select('id')
      .eq('dealership_id', req.dealershipId)
      .eq('status', 'available')

    if (error) return res.status(500).json({ error: error.message })
    const ids = (vehicles || []).map(v => v.id)
    res.json({ queued: ids.length, message: `Running AI checks on ${ids.length} vehicles…` })

    const _syncIsUS = (() => {
      const c = (dealer?.country || '').trim().toUpperCase()
      return c === 'US' || c === 'USA' || c === 'UNITED STATES'
    })()

    // Run enrichments in the background sequentially to avoid Anthropic rate limits
    ;(async () => {
      for (const inventory_id of ids) {
        // Every vehicle MUST produce exactly one activity row so the progress bar
        // can reach 100%. We build the row defensively and always attempt the
        // insert in a finally block — a scrape/fetch error for one car can never
        // strand the scan at "166 of 167".
        let vehicle = null
        let warnings = []
        let price_flag = null
        try {
          const { data } = await supabaseAdmin
            .from('inventory').select('*').eq('id', inventory_id).single()
          vehicle = data

          if (vehicle) {
            const requiredFields = dealer.ai_required_fields || ['price', 'mileage', 'image_urls']
            if (requiredFields.includes('price') && (!vehicle.price || Number(vehicle.price) === 0)) warnings.push('Missing or zero price')
            if (requiredFields.includes('mileage') && vehicle.mileage == null) warnings.push('Missing mileage')
            if (requiredFields.includes('image_urls') && (!vehicle.image_urls || vehicle.image_urls.length === 0)) warnings.push('No photos attached')
            if (requiredFields.includes('description') && (!vehicle.description || vehicle.description.length < 20)) warnings.push('Description is missing or too short')

            if (!skipPriceComp(vehicle) && vehicle.price && vehicle.make && vehicle.model && vehicle.year) {
              const mm = await marketMedianForScan({ vehicle, dealer, isUS: _syncIsUS, dealershipId: req.dealershipId, isOwner, allowLive: true })
              if (mm) price_flag = buildPriceFlag(vehicle.price, mm.median, mm.source, mm.count, mm.matched_on ? !!mm.matched_on.trim : null)
            }
          }
        } catch {
          // fall through to the guaranteed insert below
        } finally {
          try {
            await supabaseAdmin.from('ai_activity').insert({
              dealership_id: req.dealershipId,
              inventory_id,
              actor_id: req.user.id,
              vehicle_label: vehicle
                ? [vehicle.year, vehicle.make, vehicle.model, vehicle.trim].filter(Boolean).join(' ')
                : 'Vehicle',
              warnings: warnings.length > 0 ? warnings : null,
              price_flagged: !!(price_flag?.flagged),
              price_pct_diff: price_flag?.pct_diff ?? null,
              price_median: price_flag?.median ?? null,
              comp_count: price_flag?.comp_count ?? null,
              trim_matched: price_flag?.trim_matched ?? null,
              copy_generated: false
            })
          } catch {}
          await new Promise(r => setTimeout(r, 300)) // gentle rate limiting between vehicles
        }
      }
    })()
  })

  // GET /ai/activity — recent AI enrichment log for the dealership
  app.get('/ai/activity', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership associated' })
    const limit = Math.min(Number(req.query.limit) || 200, 500)
    const { data, error } = await supabaseAdmin
      .from('ai_activity')
      .select('id, vehicle_label, warnings, price_flagged, price_pct_diff, price_median, copy_generated, created_at, inventory_id')
      .eq('dealership_id', req.dealershipId)
      .order('created_at', { ascending: false })
      .limit(limit)
    if (error) return res.status(500).json({ error: error.message })

    // Attach each vehicle's stock number (dealers identify units by stock #, not label).
    const rows = data || []
    const invIds = [...new Set(rows.map(r => r.inventory_id).filter(Boolean))]
    if (invIds.length) {
      const { data: inv } = await supabaseAdmin
        .from('inventory').select('id, stocknumber').in('id', invIds)
      const stockById = new Map((inv || []).map(v => [v.id, v.stocknumber]))
      for (const r of rows) r.stocknumber = r.inventory_id ? (stockById.get(r.inventory_id) || null) : null
    }
    res.json({ activity: rows })
  })

  // GET /ai/marketcheck-status — is the licensed MarketCheck feed configured & live?
  app.get('/ai/marketcheck-status', requireAuth, async (req, res) => {
    res.json(await marketcheckPing())
  })

  // GET /ai/usage — this dealership's monthly live-data / AI usage vs its soft caps.
  app.get('/ai/usage', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.json({ marketcheck: null, ai: null })
    res.json(await getUsage(req.dealershipId))
  })

  // GET /ai/daily-digest — a "today's briefing" of what needs attention on the lot.
  // The signal counts are free for any dealer admin; the one-line summary is an AI
  // Boost enhancement (owner exempt, metered) and falls back to a templated line.
  app.get('/ai/daily-digest', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.json({ items: [], summary: null })
    const isOwner = (req.user.email || '').toLowerCase() === OWNER_EMAIL
    res.json(await computeDailyDigest(req.dealershipId, isOwner))
  })

  // POST /ai/lead-reply — draft a tone-matched reply to a Marketplace lead (AI Boost).
  // Two modes: pass { lead_id } to pull the lead from the DB (dashboard Pipeline), OR
  // pass { message, vehicle_label } for an ad-hoc draft from a live Facebook chat (the
  // extension, where no lead row exists).
  app.post('/ai/lead-reply', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership associated' })
    const { lead_id, message, vehicle_label: vlabelIn } = req.body || {}

    let lead = null
    if (lead_id) {
      const { data } = await supabaseAdmin
        .from('leads').select('id, name, comments, inventory_id')
        .eq('id', lead_id).eq('dealership_id', req.dealershipId).maybeSingle()
      if (!data) return res.status(404).json({ error: 'Lead not found' })
      lead = data
    } else if (message && String(message).trim()) {
      lead = { name: null, comments: String(message).slice(0, 1500), inventory_id: null }
    } else {
      return res.status(400).json({ error: 'lead_id or message required' })
    }

    const { data: dealer } = await supabaseAdmin
      .from('dealerships').select('name, ai_tone, ai_boost_active').eq('id', req.dealershipId).maybeSingle()
    const isOwner = (req.user.email || '').toLowerCase() === OWNER_EMAIL
    if (!isOwner && !dealer?.ai_boost_active) return res.status(403).json({ error: 'AI Boost not active' })
    if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ error: 'AI features not configured' })
    if (!(await aiAllowed(req.dealershipId, isOwner))) {
      return res.status(429).json({ error: 'Monthly AI limit reached — resets at the start of next month.' })
    }

    let vehicle = null
    if (lead.inventory_id) {
      const { data } = await supabaseAdmin.from('inventory')
        .select('year, make, model, trim, price, mileage, stocknumber').eq('id', lead.inventory_id).maybeSingle()
      vehicle = data
    }

    const tone = dealer?.ai_tone || 'professional'
    const toneLine = tone === 'friendly' ? 'warm, friendly and personable'
      : tone === 'aggressive' ? 'energetic and deal-focused (but never pushy or rude)'
      : 'professional, clear and courteous'
    const vLabel = vehicle
      ? `${vehicle.year} ${vehicle.make} ${vehicle.model}${vehicle.trim ? ' ' + vehicle.trim : ''}`
      : (vlabelIn ? String(vlabelIn).slice(0, 120) : null)
    const vLine = vehicle
      ? `They're asking about: ${vLabel}${vehicle.price ? `, listed at $${Number(vehicle.price).toLocaleString()}` : ''}${vehicle.mileage ? `, ${Number(vehicle.mileage).toLocaleString()} on the odometer` : ''}${vehicle.stocknumber ? ` (stock #${vehicle.stocknumber})` : ''}.`
      : (vLabel ? `They're asking about: ${vLabel}.` : 'No specific vehicle is attached to this lead.')

    const prompt = `You are a salesperson at ${dealer?.name || 'a car dealership'} replying to a customer inquiry that came in from Facebook Marketplace. Write a ${toneLine} reply.
Customer name: ${lead.name || 'there'}.
Their message: "${(lead.comments || '').slice(0, 800) || '(no message text — they tapped "is this still available?")'}"
${vLine}
Guidelines: under 90 words; answer their question if they asked one; confirm the vehicle is available; end by inviting them to book a time to come see it or take a test drive. Do NOT invent specs, financing terms, or prices you weren't given. Return ONLY the reply text — no subject line, no signature, no markdown.`

    try {
      const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
      const msg = await Promise.race([
        anthropic.messages.create({ model: 'claude-haiku-4-5-20251001', max_tokens: 300, messages: [{ role: 'user', content: prompt }] }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('ai timeout')), 25000)),
      ])
      const draft = (msg?.content?.[0]?.text || '').trim()
      if (!draft) throw new Error('No reply generated')
      recordUsage(req.dealershipId, { ai: 1 })
      res.json({ ok: true, draft, vehicle_label: vLabel })
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  // ── Scan a driver's licence → structured customer fields ───────────────────
  // A rep snaps the front of a licence; AI Vision reads it and returns the fields
  // to pre-fill a new customer. Nothing is stored here — the rep reviews and saves
  // through the normal add-customer flow. The licence image is NOT persisted.
  app.post('/crm/scan-license', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership' })
    const isOwner = (req.user.email || '').toLowerCase() === OWNER_EMAIL
    const { data: dealer } = await supabaseAdmin.from('dealerships').select('ai_boost_active').eq('id', req.dealershipId).maybeSingle()
    if (!isOwner && !dealer?.ai_boost_active) return res.status(403).json({ error: 'AI Boost not active' })
    if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ error: 'AI features not configured' })
    if (!(await aiAllowed(req.dealershipId, isOwner))) return res.status(429).json({ error: 'Monthly AI limit reached — resets next month.' })
    const img = String(req.body?.image || '')
    const m = img.match(/^data:(image\/(png|jpe?g|webp));base64,(.+)$/)
    if (!m) return res.status(400).json({ error: 'Send the licence photo as a base64 data URL.' })
    const media_type = m[1] === 'image/jpg' ? 'image/jpeg' : m[1]
    const data = m[3]
    if (data.length > 8_000_000) return res.status(400).json({ error: 'Image too large — retake at normal quality.' })
    const prompt = `You are reading a photo of a driver's licence or government photo ID to help a dealership start a customer record. Extract ONLY what is clearly legible. Return STRICT JSON with these keys (use null when not visible): first_name, last_name, address, city, province_state, postal_code, country, dl_number, date_of_birth (YYYY-MM-DD), expiry (YYYY-MM-DD). Do not guess. Return ONLY the JSON object, no prose.`
    try {
      const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
      const msg = await Promise.race([
        anthropic.messages.create({ model: 'claude-haiku-4-5-20251001', max_tokens: 400, messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type, data } },
          { type: 'text', text: prompt },
        ] }] }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('ai timeout')), 30000)),
      ])
      recordUsage(req.dealershipId, { ai: 1 })
      let txt = (msg?.content?.[0]?.text || '').trim().replace(/^```json\s*|\s*```$/g, '')
      let fields
      try { fields = JSON.parse(txt) } catch { return res.status(422).json({ error: 'Could not read the licence clearly — try a sharper, straight-on photo.' }) }
      const full_name = [fields.first_name, fields.last_name].filter(Boolean).join(' ').trim() || null
      res.json({ ok: true, fields: { ...fields, full_name } })
    } catch (e) {
      res.status(500).json({ error: e.message === 'ai timeout' ? 'Reading the licence took too long — try again.' : 'Could not read the licence.' })
    }
  })

  // ── AI copy for the website builder (✨ per-section actions) ────────────────
  // task: rewrite | improve | expand | shorten | generate | seo | faq
  // kind: headline | subheadline | cta | about | faq | seo | text
  app.post('/ai/site-copy', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership' })
    const b = req.body || {}
    const task = String(b.task || 'generate').toLowerCase()
    const kind = String(b.kind || 'text').toLowerCase().slice(0, 30)
    const current = String(b.current || '').slice(0, 2000)
    const hint = String(b.hint || '').slice(0, 200)
    const { data: dealer } = await supabaseAdmin
      .from('dealerships').select('name, ai_tone, ai_boost_active, city, province').eq('id', req.dealershipId).maybeSingle()
    const isOwner = (req.user.email || '').toLowerCase() === OWNER_EMAIL
    if (!isOwner && !dealer?.ai_boost_active) return res.status(403).json({ error: 'AI Boost not active' })
    if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ error: 'AI features not configured' })
    if (!(await aiAllowed(req.dealershipId, isOwner))) return res.status(429).json({ error: 'Monthly AI limit reached — resets next month.' })

    // Canonical tasks + back-compat aliases. The five the dealer asked for are
    // boost / fresh / short / long / seo, plus title (SEO click-worthy hook),
    // links (link-rich description) and meta (page meta description).
    const YEAR = new Date().getFullYear()
    const taskAlias = { improve: 'boost', rewrite: 'fresh', generate: 'fresh', expand: 'long', shorten: 'short' }
    const t = taskAlias[task] || task
    const keyword = String(b.keyword || '').slice(0, 80).trim()
    // Internal link targets the AI may weave in: [{label, href}]. External auth
    // links the AI chooses itself. Both only used for description-style copy.
    const linkTargets = Array.isArray(b.links)
      ? b.links.filter(l => l && l.href).slice(0, 12).map(l => ({ label: String(l.label || '').slice(0, 60), href: String(l.href).slice(0, 200) }))
      : []
    // Description-ish kinds can hold HTML links; short labels stay plain text.
    const RICH_KINDS = ['about', 'body', 'text', 'description', 'paragraph', 'intro']
    const isRich = RICH_KINDS.includes(kind)
    const wantLinks = t === 'links' || (b.with_links === true && isRich)

    const SEO_RULES = `Follow modern ${YEAR} SEO best practices: write for humans first and search engines second. ${keyword ? `Weave the focus keyword "${keyword}" in naturally near the start plus one close variant — never stuff it.` : 'Use the natural language a buyer would search.'} Match search intent, be specific and genuinely useful, use concrete entities (brands, models, city), and keep it scannable.`
    const instr = {
      boost: 'Keep the meaning but make it noticeably sharper — tighter phrasing, stronger verbs, better flow and punch.',
      fresh: 'Rewrite it from scratch with a genuinely new angle and fresh wording — do not lightly reword the original.',
      short: 'Make it shorter and punchier — cut every wasted word while keeping the core message.',
      long: 'Expand it with more useful, specific detail a buyer actually cares about — no filler or fluff.',
      seo: `Rewrite it for search. ${SEO_RULES}`,
      title: `Write ONE SEO-optimized, click-worthy title with a real hook. ${keyword ? `Front-load the keyword "${keyword}".` : ''} Under ~60 characters, specific and compelling (a curiosity or benefit hook), never clickbait that lies. No trailing period.`,
      links: `Rewrite it into an engaging, SEO-aware description (${SEO_RULES}).`,
      meta: `Write ONE meta description of 140–160 characters for this page. ${keyword ? `Include the keyword "${keyword}" naturally near the front.` : ''} Action-oriented, unique, benefit-led. Plain text only.`,
      faq: 'Write 5 genuinely useful FAQ items.',
    }[t] || 'Write fresh, specific copy.'
    const kindHint = {
      headline: 'a distinctive hero headline, 4–9 words (a real headline with a hook, not a generic slogan)',
      subheadline: 'a single supporting subheadline sentence',
      cta: 'a short call-to-action button label (2–4 words)',
      about: 'a warm, specific "about the dealership" paragraph',
      body: 'a section of website body copy',
      text: 'a section of website body copy',
      title: 'an SEO page or section title',
      meta: 'a page meta description',
      faq: 'FAQ content',
      seo: 'SEO website copy',
    }[kind] || 'a short piece of website copy'
    const tone = dealer?.ai_tone === 'friendly' ? 'warm and welcoming' : dealer?.ai_tone === 'aggressive' ? 'energetic and deal-focused' : 'confident and professional'
    const loc = [dealer?.city, dealer?.province].filter(Boolean).join(', ')
    // Real context so copy isn't generic — the makes this dealer actually stocks.
    let makes = []
    try {
      const { data: mk } = await supabaseAdmin.from('inventory').select('make').eq('dealership_id', req.dealershipId).not('make', 'is', null).limit(500)
      const counts = {}
      for (const r of (mk || [])) { const m = (r.make || '').trim(); if (m) counts[m] = (counts[m] || 0) + 1 }
      makes = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 5).map(x => x[0])
    } catch {}
    // Rotate the creative angle each call so repeated clicks give genuinely different lines.
    const ANGLES = [
      'lead with the specific brands or models they carry',
      'lead with local pride and the community they serve',
      'lead with selection and inventory breadth',
      'lead with the buying experience — easy, no-pressure, fast',
      'lead with trust, expertise, and reputation',
      'lead with financing and trade-in ease',
      'lead with a concrete customer benefit or outcome',
      'lead with service, maintenance, and ownership support',
    ]
    const angle = ANGLES[Math.floor(Math.random() * ANGLES.length)]
    const avoid = Array.isArray(b.avoid) ? b.avoid : (b.avoid ? [String(b.avoid)] : [])
    const avoidLine = [current, ...avoid].filter(Boolean).slice(0, 6).map(s => `"${String(s).slice(0, 120)}"`).join(', ')
    const isFaq = t === 'faq' || kind === 'faq'
    const isTitle = t === 'title'
    const isMeta = t === 'meta' || kind === 'meta'
    // Angle rotation only helps free-form copy; titles/meta/links stay on-brief.
    const angleLine = (isTitle || isMeta || wantLinks) ? '' : `For this version, ${angle}.\n`
    // Link block: give the model the exact internal hrefs to use + rules for one
    // external authority link. HTML output so links actually render on the site.
    const linksBlock = wantLinks
      ? `\nInclude 1–2 relevant INTERNAL links using ONLY these exact hrefs, as HTML anchors: ${linkTargets.length ? linkTargets.map(l => `"${l.label}" -> ${l.href}`).join('; ') : '(none provided — skip internal links)'}. Also include exactly ONE relevant EXTERNAL link to a genuinely authoritative, useful source (e.g. the manufacturer's official site, a government safety/consumer resource, Carfax) — use target="_blank" rel="nofollow noopener" on the external one only. Output valid HTML using <a>, <strong>, <em> and <br> where helpful; no other tags, no markdown, no <html>/<body> wrapper.`
      : ''
    const banned = 'NEVER use phrases like "Drive Home Your Dream", "Best Deals", "Your Trusted Dealer", "Today!", "Look no further", "Unbeatable", or empty hype.'
    const prompt = `You are a senior automotive copywriter for ${dealer?.name || 'a car dealership'}${loc ? ' in ' + loc : ''}.${makes.length ? ` They primarily sell ${makes.join(', ')}.` : ''} Tone: ${tone}.
Write ${kindHint}. ${instr}${hint ? ` This is for the "${hint}" ${isMeta || isTitle ? 'page' : 'section'}.` : ''}
${angleLine}Make it specific and distinctive — reference real details (brands, city, selection) where natural. ${banned}${avoidLine ? ` Do NOT repeat or lightly reword any of these existing lines: ${avoidLine}.` : ''}${linksBlock}${current && !isFaq ? `\nCurrent text to work from: "${current}".` : ''}
Return ONLY the ${isTitle ? 'title' : isMeta ? 'meta description' : 'copy'} — no quotes, no preamble${wantLinks ? '' : ', no markdown'}.${isFaq ? ' Put each FAQ on its own line formatted exactly as "Question :: Answer".' : ''}`

    try {
      const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
      const maxTok = wantLinks || t === 'long' ? 900 : isTitle ? 120 : 500
      const msg = await Promise.race([
        anthropic.messages.create({ model: 'claude-haiku-4-5-20251001', max_tokens: maxTok, temperature: isTitle || isMeta ? 0.9 : 1, messages: [{ role: 'user', content: prompt }] }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('ai timeout')), 25000)),
      ])
      let text = (msg?.content?.[0]?.text || '').trim()
      if (!wantLinks) text = text.replace(/^["']|["']$/g, '')
      if (!text) throw new Error('No copy generated')
      recordUsage(req.dealershipId, { ai: 1 })
      res.json({ ok: true, text, html: /<a\s/i.test(text) })
    } catch (e) { res.status(500).json({ error: e.message }) }
  })

  // POST /ai/sales-pitch — write a compelling sales pitch for one or many vehicles.
  // Body: { ids: [vehicleId, ...] }. Stores the result on inventory.sales_pitch and
  // returns the generated text keyed by id. Gated on AI Boost (owner exempt).
  app.post('/ai/sales-pitch', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership' })
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter(Boolean).slice(0, 200) : []
    if (!ids.length) return res.status(400).json({ error: 'No vehicles selected' })
    const { data: dealer } = await supabaseAdmin
      .from('dealerships').select('name, ai_tone, ai_boost_active, city, province').eq('id', req.dealershipId).maybeSingle()
    const isOwner = (req.user.email || '').toLowerCase() === OWNER_EMAIL
    if (!isOwner && !dealer?.ai_boost_active) return res.status(403).json({ error: 'AI Boost not active' })
    if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ error: 'AI features not configured' })

    const { data: vehicles, error } = await supabaseAdmin.from('inventory')
      .select('id, year, make, model, trim, mileage, condition, price, exterior_color, interior_color, drivetrain, fuel_type, transmission, engine, body_style, description, vin_data, specs_manual')
      .eq('dealership_id', req.dealershipId).in('id', ids)
    if (error) return res.status(500).json({ error: error.message })
    if (!vehicles?.length) return res.status(404).json({ error: 'No matching vehicles' })

    const tone = dealer?.ai_tone === 'friendly' ? 'warm and friendly' : dealer?.ai_tone === 'aggressive' ? 'energetic and deal-focused' : 'professional and confident'
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
    const pitches = {}
    let done = 0, limited = false
    for (const v of vehicles) {
      if (!(await aiAllowed(req.dealershipId, isOwner))) { limited = true; break }
      const d = v.vin_data && typeof v.vin_data === 'object' ? v.vin_data : {}
      const sm = v.specs_manual && typeof v.specs_manual === 'object' ? v.specs_manual : {}
      const facts = {
        vehicle: [v.year, v.make, v.model, v.trim].filter(Boolean).join(' '),
        condition: v.condition, mileage_km: v.mileage, price: v.price,
        exterior: v.exterior_color, interior: v.interior_color,
        drivetrain: v.drivetrain, fuel: v.fuel_type, transmission: v.transmission,
        engine: v.engine || d.engine_model, displacement_l: d.displacement_l, cylinders: d.cylinders, turbo: d.turbo,
        body_style: v.body_style, gvwr: d.gvwr,
        towing_capacity: sm.towing_capacity, horsepower: sm.horsepower, torque: sm.torque, curb_weight: sm.curb_weight, payload: sm.payload, seating: sm.seating, fuel_economy: sm.fuel_economy, cargo: sm.cargo,
        safety: Object.entries({ 'forward-collision warning': d.forward_collision, 'automatic emergency braking': d.auto_brake, 'lane-keep assist': d.lane_keep, 'blind-spot monitor': d.blind_spot_mon, 'adaptive cruise': d.adaptive_cruise }).filter(([, x]) => x && String(x).toLowerCase() !== 'not available').map(([k]) => k),
        feature_list: v.description || null,
      }
      const prompt = `You are an expert automotive copywriter for ${dealer?.name || 'a car dealership'}. Write a compelling, honest sales pitch for the vehicle below, to appear on the dealership's website vehicle-detail page.
Rules: 2–3 short paragraphs (about 60–120 words total). Lead with what makes THIS specific vehicle appealing (capability, comfort, tech, value). Use ONLY the facts provided — never invent specs, pricing, history, or awards. Don't just list features; sell the experience. Tone: ${tone}. No emoji, no markdown, no headings, no quotes.
Facts (ignore any blank/unknown fields): ${JSON.stringify(facts)}`
      try {
        const msg = await Promise.race([
          anthropic.messages.create({ model: 'claude-haiku-4-5-20251001', max_tokens: 600, messages: [{ role: 'user', content: prompt }] }),
          new Promise((_, rej) => setTimeout(() => rej(new Error('ai timeout')), 25000)),
        ])
        const text = (msg?.content?.[0]?.text || '').trim().replace(/^["']|["']$/g, '')
        if (!text) continue
        await supabaseAdmin.from('inventory').update({ sales_pitch: text, sales_pitch_at: new Date().toISOString() }).eq('id', v.id).eq('dealership_id', req.dealershipId)
        recordUsage(req.dealershipId, { ai: 1 })
        pitches[v.id] = text; done++
      } catch (e) { console.warn('[sales-pitch] failed for', v.id, e.message) }
    }
    res.json({ ok: true, count: done, pitches, limited })
  })

  // POST /ai/vehicle-copy — write a website description OR sales pitch for a single
  // vehicle from ad-hoc facts (no saved row needed), with the same rewrite modes as
  // the automation/website AI: boost / fresh / short / long / seo. Powers the ✨ AI
  // menu on the Add/Edit vehicle form, so copy can be generated before the car is saved.
  // Body: { field: 'description'|'pitch', task, vehicle:{year,make,...,specs_manual}, current }
  app.post('/ai/vehicle-copy', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership' })
    const b = req.body || {}
    const field = String(b.field || 'description').toLowerCase() === 'pitch' ? 'pitch' : 'description'
    const taskAlias = { improve: 'boost', rewrite: 'fresh', generate: 'fresh', expand: 'long', shorten: 'short' }
    const task = taskAlias[String(b.task || 'fresh').toLowerCase()] || String(b.task || 'fresh').toLowerCase()
    const current = String(b.current || '').slice(0, 2000)
    const v = (b.vehicle && typeof b.vehicle === 'object') ? b.vehicle : {}

    const { data: dealer } = await supabaseAdmin
      .from('dealerships').select('name, ai_tone, ai_boost_active, city, province').eq('id', req.dealershipId).maybeSingle()
    const isOwner = (req.user.email || '').toLowerCase() === OWNER_EMAIL
    if (!isOwner && !dealer?.ai_boost_active) return res.status(403).json({ error: 'AI Boost not active' })
    if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ error: 'AI features not configured' })
    if (!(await aiAllowed(req.dealershipId, isOwner))) return res.status(429).json({ error: 'Monthly AI limit reached — resets next month.' })

    const YEAR = new Date().getFullYear()
    const sm = (v.specs_manual && typeof v.specs_manual === 'object') ? v.specs_manual : {}
    const vd = (v.vin_data && typeof v.vin_data === 'object') ? v.vin_data : {}
    const facts = {
      vehicle: [v.year, v.make, v.model, v.trim].filter(Boolean).join(' '),
      condition: v.condition, mileage_km: v.mileage, price: v.price,
      exterior: v.exterior_color, interior: v.interior_color,
      drivetrain: v.drivetrain, fuel: v.fuel_type, transmission: v.transmission,
      engine: v.engine || vd.engine_model, body_style: v.body_style, doors: v.doors,
      towing_capacity: sm.towing_capacity, horsepower: sm.horsepower, torque: sm.torque,
      curb_weight: sm.curb_weight, payload: sm.payload, seating: sm.seating,
      fuel_economy: sm.fuel_economy, cargo: sm.cargo,
      safety: Object.entries({ 'forward-collision warning': vd.forward_collision, 'automatic emergency braking': vd.auto_brake, 'lane-keep assist': vd.lane_keep, 'blind-spot monitor': vd.blind_spot_mon, 'adaptive cruise': vd.adaptive_cruise }).filter(([, x]) => x && String(x).toLowerCase() !== 'not available').map(([k]) => k),
    }
    if (!facts.vehicle) return res.status(400).json({ error: 'Add at least the year, make and model first.' })

    const tone = dealer?.ai_tone === 'friendly' ? 'warm and friendly' : dealer?.ai_tone === 'aggressive' ? 'energetic and deal-focused' : 'professional and confident'
    const loc = [dealer?.city, dealer?.province].filter(Boolean).join(', ')
    const instr = {
      boost: 'Keep the meaning but make it noticeably sharper — tighter phrasing, stronger verbs, better flow and punch.',
      fresh: 'Write it from scratch with a genuinely new angle and fresh wording.',
      short: 'Make it shorter and punchier — cut every wasted word while keeping the core selling points.',
      long: 'Expand it with more useful, specific detail a buyer actually cares about — no filler.',
      seo: `Rewrite it for search using modern ${YEAR} SEO best practices: write for humans first, weave in the year/make/model and body style naturally near the start, match buyer search intent, and keep it scannable. Never keyword-stuff.`,
    }[task] || 'Write fresh, specific copy.'

    const spec = field === 'pitch'
      ? `Write a compelling, honest SALES PITCH for the vehicle below, to appear on the dealership's website vehicle-detail page. 2–3 short paragraphs (about 60–120 words total). Lead with what makes THIS specific vehicle appealing (capability, comfort, tech, value); sell the experience, don't just list features.`
      : `Write a clear, appealing website DESCRIPTION for the vehicle below (the vehicle-detail overview). 2–4 sentences (about 40–80 words). Highlight the standout specs, features and condition a buyer cares about.`
    const prompt = `You are an expert automotive copywriter for ${dealer?.name || 'a car dealership'}${loc ? ' in ' + loc : ''}. Tone: ${tone}.
${spec} ${instr}
Rules: Use ONLY the facts provided — never invent specs, pricing, history, packages or awards. No emoji, no markdown, no headings, no quotes.${current ? `\nCurrent text to work from: "${current}".` : ''}
Facts (ignore any blank/unknown fields): ${JSON.stringify(facts)}
Return ONLY the ${field === 'pitch' ? 'sales pitch' : 'description'} — no preamble.`

    try {
      const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
      const maxTok = task === 'long' || field === 'pitch' ? 600 : 400
      const msg = await Promise.race([
        anthropic.messages.create({ model: 'claude-haiku-4-5-20251001', max_tokens: maxTok, temperature: 1, messages: [{ role: 'user', content: prompt }] }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('ai timeout')), 25000)),
      ])
      const text = (msg?.content?.[0]?.text || '').trim().replace(/^["']|["']$/g, '')
      if (!text) throw new Error('No copy generated')
      recordUsage(req.dealershipId, { ai: 1 })
      res.json({ ok: true, text })
    } catch (e) { res.status(500).json({ error: e.message }) }
  })

  // Decode a VIN to year/make/model/trim via NHTSA (free, no key). Used by the
  // Trade Appraisal form's "Decode" button to prefill the manual fields.
  app.post('/ai/vin-decode', requireAuth, async (req, res) => {
    const vin = String(req.body?.vin || '').trim().toUpperCase()
    if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) return res.status(400).json({ error: 'Enter a valid 17-character VIN' })
    try {
      const r = await fetch(`https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues/${encodeURIComponent(vin)}?format=json`, {
        signal: AbortSignal.timeout(10000),
      })
      if (!r.ok) return res.status(502).json({ error: `VIN service error (HTTP ${r.status})` })
      const j = await r.json()
      const row = j?.Results?.[0]
      const nv = v => (v && v !== 'Not Applicable' && String(v).trim() !== '') ? String(v).trim() : null
      const nf = v => { const n = parseFloat(v); return isNaN(n) ? null : n }
      const yr = parseInt(row?.ModelYear)
      const dispL = nf(row?.DisplacementL), cyls = nv(row?.EngineCylinders)
      const engineStr = [
        dispL ? `${dispL}L` : null,
        cyls ? `${cyls}-cyl` : null,
        nv(row?.Turbo) === 'Yes' ? 'Turbo' : null,
        nv(row?.EngineHP) ? `${nv(row?.EngineHP)} HP` : null,
      ].filter(Boolean).join(' ') || null
      const out = {
        year: isNaN(yr) ? null : yr,
        make: nv(row?.Make),
        model: nv(row?.Model),
        trim: nv(row?.Trim) || nv(row?.Series),
        // Extra specs so the appraisal deal + disclosure PDF auto-fill.
        body_type: nv(row?.BodyClass),
        engine: engineStr,
        transmission: nv(row?.TransmissionStyle),
        drivetrain: nv(row?.DriveType),
        fuel_type: nv(row?.FuelTypePrimary),
      }
      if (!out.make || !out.model) return res.status(422).json({ error: 'Could not decode that VIN — enter the details manually.' })
      res.json({ ok: true, vin, ...out })
    } catch (e) {
      res.status(502).json({ error: e.name === 'TimeoutError' ? 'VIN service timed out — try again or enter details manually.' : e.message })
    }
  })

  // License-plate → VIN for trade appraisals. Uses whichever plate-decode provider
  // is provisioned (CarsXE / Vehicle Databases); returns a VIN the appraisal then
  // decodes normally. 503 when no provider is set so the UI can say "enter the VIN".
  app.post('/ai/plate-decode', requireAuth, async (req, res) => {
    if (!plateLookupConfigured()) return res.status(503).json({ error: 'Plate lookup isn’t set up on this account yet — enter the VIN instead.', not_configured: true })
    try {
      const out = await lookupPlate({ plate: req.body?.plate, region: req.body?.region, country: req.body?.country })
      res.json({ ok: true, ...out })
    } catch (e) {
      res.status(e.notConfigured ? 503 : 422).json({ error: e.message || 'Could not look up that plate.' })
    }
  })

  // Trade-in appraisal — MarketCheck retail comps + a derived cash/trade offer.
  // Accepts either a decoded/manual vehicle. Retail comes from live market data;
  // the suggested offer = retail median − reconditioning − target gross.
  app.post('/ai/appraise', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership associated' })
    const b = req.body || {}
    const year = parseInt(b.year)
    const make = String(b.make || '').trim()
    const model = String(b.model || '').trim()
    const trim = String(b.trim || '').trim()
    const mileage = b.mileage != null && b.mileage !== '' ? Number(b.mileage) : null
    // Finer comp filters: drivetrain (FWD/RWD/AWD/4WD) and engine displacement,
    // used to match like-for-like listings instead of every trim/engine of the model.
    const drivetrain = String(b.drivetrain || '').trim() || null
    const engine = String(b.engine || '').trim() || null
    if (!year || !make || !model) return res.status(400).json({ error: 'Year, make and model are required' })

    const recon = Math.max(0, Number(b.recon) || 0)
    // Target gross is now a DOLLAR figure (default $2,500), same units as recon.
    const targetGross = Math.max(0, b.target_gross != null && b.target_gross !== '' ? Number(b.target_gross) : 2500)
    // Optional Black Book / guide value the rep enters — the dealer's ground truth.
    // When present it caps the suggested offer so the tool never recommends paying
    // over book (MarketCheck asks run high, especially on thin CA sold coverage).
    const bookValue = (b.book_value != null && b.book_value !== '') ? Math.max(0, Number(b.book_value) || 0) : null

    // Accident / history — a reported accident permanently lowers what a car retails
    // AND wholesales for (buyers discount it, and it re-lists with the same disclosure).
    // The rep enters what the Carfax shows; we convert severity + reported damage into a
    // percentage haircut off the clean market retail. Tiers are deliberately conservative
    // and env-tunable. `damage` (total reported $) can only escalate the tier, never lower it.
    const ACCIDENT_PCT = {
      none: 0,
      minor: Number(process.env.APPRAISE_ACC_MINOR || 0.05),      // 1 claim, cosmetic
      moderate: Number(process.env.APPRAISE_ACC_MODERATE || 0.10), // panel/multiple claims
      major: Number(process.env.APPRAISE_ACC_MAJOR || 0.18),       // structural / airbags
      branded: Number(process.env.APPRAISE_ACC_BRANDED || 0.40),   // salvage / rebuilt / flood
    }
    const accidentRaw = String(b.accident || 'none').toLowerCase().trim()
    const reportedDamage = Math.max(0, Number(b.damage) || 0)
    // Reported-damage floor: a big number forces at least the matching tier.
    const damageTier = reportedDamage >= 6000 ? 'major' : reportedDamage >= 3000 ? 'moderate' : reportedDamage >= 1 ? 'minor' : 'none'
    const rank = { none: 0, minor: 1, moderate: 2, major: 3, branded: 4 }
    let accidentTier = ['none', 'minor', 'moderate', 'major', 'branded'].includes(accidentRaw) ? accidentRaw : 'none'
    if (rank[damageTier] > rank[accidentTier]) accidentTier = damageTier
    const accidentPct = ACCIDENT_PCT[accidentTier] ?? 0

    const { data: dealer } = await supabaseAdmin
      .from('dealerships').select('name, country, province, postal_code, inv_intel_active, ai_boost_active').eq('id', req.dealershipId).maybeSingle()
    // Trade Appraisal is part of the Inventory Intelligence add-on.
    const isOwner = (req.user.email || '').toLowerCase() === OWNER_EMAIL
    if (!isOwner && !dealer?.inv_intel_active) return res.status(403).json({ error: 'Inventory Intelligence add-on required' })
    const c = (dealer?.country || '').trim().toUpperCase()
    const isUS = c === 'US' || c === 'USA' || c === 'UNITED STATES'

    // Geo-scope comps around the dealer's location. Radius is client-selectable;
    // default 250 (mi in the US / km in Canada), 0 = nationwide (no geo filter).
    // The zip/postal comes off the dealership record so reps don't type it.
    const radius = (() => {
      if (b.radius === undefined || b.radius === null || b.radius === '') return 250
      const r = Number(b.radius)
      return Number.isFinite(r) ? Math.min(2000, Math.max(0, Math.round(r))) : 250
    })()
    const zip = radius > 0 ? ((dealer?.postal_code || '').trim() || null) : null

    // Robust market value + the clean comp listings it was built from (charts/locations).
    // Cached + metered via the cost layer (shared with the scan & price report).
    const { data: market } = await getMarketData({
      dealershipId: req.dealershipId, isOwner, allowLive: true,
      params: { make, model, year, trim, mileage, drivetrain, engine, zip, radius, isUS },
    })

    const vehicle = { year, make, model, trim: trim || null, mileage, drivetrain, engine, vin: (b.vin ? String(b.vin).trim().toUpperCase() : null) }

    if (!market || !market.median_price) {
      return res.json({ ok: true, vehicle, retail: null, appraisal: null,
        message: 'Not enough comparable listings to value this reliably (needs at least 3). MarketCheck’s Canadian coverage can be thin for rare trims — try again without the trim, or appraise a more common model.' })
    }

    // MarketCheck price prediction (recipe 04) — a model-comparable predicted
    // retail with a confidence band, shown alongside our comp-based median so the
    // dealer sees two independent reads. VIN-only; cached-free but metered + capped.
    let prediction = null
    if (vehicle.vin && marketcheckEnabled() && await marketcheckAllowed(req.dealershipId, isOwner)) {
      try {
        prediction = await marketcheckPredictPrice({ vin: vehicle.vin, miles: mileage })
        await recordMarketcheckCall(req.dealershipId)
      } catch { /* prediction is a bonus — never fail the appraisal for it */ }
    }

    // Recently SOLD comps (MarketCheck Past Inventory). These are cars that left the
    // market, so their last price is a real transaction proxy and their `dom` is a
    // proven days-on-market. Cached + metered; returns null if the plan isn't entitled
    // to sold data (we just hide the panel). This is the "proven to market" signal.
    let sold = null
    try {
      const { data: soldData } = await getSoldData({
        dealershipId: req.dealershipId, isOwner, allowLive: true,
        params: { make, model, year, trim, mileage, drivetrain, engine, zip, radius, isUS },
      })
      sold = soldData || null
    } catch { /* sold data is a bonus — never fail the appraisal for it */ }

    // ── Value model ────────────────────────────────────────────────────────────
    // MarketCheck gives us the median ASKING price of comparable dealer listings.
    // Two systematic biases push that number well above a real appraisal — which is
    // why it can land thousands over AutoTrader's "what's my car worth":
    //   1) Mileage: the comp pool ignores the subject's odometer, so a high-mileage
    //      trade gets valued like an average-mileage lot car (and vice-versa).
    //   2) Ask vs. sell: dealer asking prices sit above actual transaction prices —
    //      buyers negotiate, and trade books are calibrated to sold data, not asks.
    // We correct both, transparently, so the retail anchor reflects THIS vehicle.
    const compMedian = market.median_price
    const compMiles = market.median_mileage || market.avg_mileage || null

    // (1) Mileage adjustment — value-proportional so it scales with the car's tier
    // instead of a flat $/km that would swamp a cheap car and under-move a truck.
    // Sensitivity ≈ the share of value explained by mileage across the useful-life
    // window; tunable via env so we can calibrate against real book values.
    const REF_DIST = isUS ? 125000 : 200000            // useful-life window (mi / km)
    const MILEAGE_SENS = Number(process.env.APPRAISE_MILEAGE_SENS || 0.5)
    let mileageAdj = 0
    if (mileage > 0 && compMiles > 0) {
      const ratePerDist = (compMedian * MILEAGE_SENS) / REF_DIST
      mileageAdj = Math.round((compMiles - mileage) * ratePerDist)   // fewer miles → +, more → −
      const cap = Math.round(compMedian * 0.30)                       // never move value >30%
      mileageAdj = Math.max(-cap, Math.min(cap, mileageAdj))
    }
    const mileageAdjusted = compMedian + mileageAdj

    // (2) Ask → realistic retail. Dealer asks run above transaction prices; shave a
    // haircut so our retail anchor matches what the car actually sells for. When we
    // have SOLD comps we use the REAL market-proven ask→sold gap (asking median vs
    // sold median); otherwise we fall back to a small tunable default. This is what
    // stops old/cheap cars — where asks are wildly inflated — from reading high.
    const REALISM_DEFAULT = Number(process.env.APPRAISE_MARKET_REALISM || 0.04)
    let realism = REALISM_DEFAULT
    let realismProven = false
    if (sold && sold.median_price > 0 && compMedian > 0) {
      const gap = (compMedian - sold.median_price) / compMedian
      if (gap > 0) { realism = Math.min(0.25, gap); realismProven = true }   // cap at 25%
    }
    const realismCut = Math.round(mileageAdjusted * realism)
    const retailFromComps = Math.max(0, mileageAdjusted - realismCut)   // asks → realistic retail

    // Reconcile the independent retail reads into ONE grounded number so the sheet
    // never shows two contradicting retails (the "$8,766 vs $6,705" problem). Weights:
    // sold transactions weigh most (proven), the VIN model next, ask-derived retail
    // least (asking prices run high, especially on older cars). Extra signals only
    // pull the number when present — a comps-only appraisal is unchanged.
    const retailSignals = [{ v: retailFromComps, w: 1.0, key: 'comps' }]
    let soldRetail = null
    if (sold && sold.median_price > 0) {
      // Nudge the sold median to THIS car's odometer using the same $/dist rate, so a
      // low-mileage trade isn't valued off higher-mileage sold cars (and vice-versa).
      const soldMiles = sold.median_mileage || compMiles || 0
      let sAdj = sold.median_price
      if (mileage > 0 && soldMiles > 0) {
        const sRate = (sold.median_price * MILEAGE_SENS) / REF_DIST
        const sCap = Math.round(sold.median_price * 0.30)
        sAdj += Math.max(-sCap, Math.min(sCap, Math.round((soldMiles - mileage) * sRate)))
      }
      soldRetail = Math.max(0, Math.round(sAdj))
      retailSignals.push({ v: soldRetail, w: 1.4, key: 'sold' })
    }
    if (prediction && prediction.predicted > 0) {
      retailSignals.push({ v: prediction.predicted, w: 0.9, key: 'model' })
    }
    const wSum = retailSignals.reduce((a, s) => a + s.w, 0)
    // Clean-history retail — the reconciled blend of comps/sold/model. The comp pool is
    // average-condition, so this is what the car retails for with a clean Carfax.
    const retailClean = Math.max(0, Math.round(retailSignals.reduce((a, s) => a + s.v * s.w, 0) / wSum))
    // Apply the accident/history haircut to get THIS car's retail. Everything downstream
    // (trade, offer, gross) then flows off the accident-adjusted number.
    const historyCut = Math.round(retailClean * accidentPct)
    const retailMid = Math.max(0, retailClean - historyCut)

    // (3) ACV / wholesale = what we take the trade in for, and it "comes off retail":
    // retail − recon − target gross. That IS the wholesale take-in (it lines up with
    // AutoTrader's valuation), so we do NOT apply a separate retail→wholesale ratio on
    // top — that would double-discount. Ratio stays at 1.0 by default; an extra
    // haircut is only applied if a market explicitly sets APPRAISE_WHOLESALE_RATIO.
    const tradeRatio = (() => {
      const p = Number(b.trade_pct)
      if (Number.isFinite(p) && p > 0) return Math.min(1, p > 1 ? p / 100 : p)
      const env = Number(process.env.APPRAISE_WHOLESALE_RATIO || process.env.APPRAISE_TRADE_RATIO)
      return Number.isFinite(env) && env > 0 ? Math.min(1, env) : 1.0
    })()
    const tradeValue = Math.round(retailMid * tradeRatio)          // pre-cost retail (=retail when ratio 1.0)
    let suggestedOffer = Math.max(0, tradeValue - recon - targetGross)
    // Book-value anchor: never suggest paying more than the dealer's guide book.
    let bookCapped = false
    if (bookValue != null && bookValue > 0 && suggestedOffer > bookValue) { suggestedOffer = Math.round(bookValue); bookCapped = true }
    // Effective gross = the full spread between retail and what we pay.
    const grossPct = retailMid > 0 ? Math.round(((retailMid - suggestedOffer) / retailMid) * 1000) / 10 : null
    // Offer as a % of retail market value (vAuto-style "% to market").
    const pctToMarket = retailMid > 0 ? Math.round((suggestedOffer / retailMid) * 100) : null

    // Location breakdown (province/state → count) for the "where these are" chart.
    const compList = (market.listings || [])
    const locMap = {}
    for (const l of compList) { const k = l.region || 'Other'; locMap[k] = (locMap[k] || 0) + 1 }
    const locations = Object.entries(locMap).map(([region, count]) => ({ region, count })).sort((a, b) => b.count - a.count)

    // AI enhancement (AI Boost): a plain-English summary that explains/justifies
    // the number on the customer-facing sheet. Owner exempt; metered (soft AI cap).
    let ai_summary = null
    const aiBoost = isOwner || !!dealer?.ai_boost_active
    if (aiBoost && process.env.ANTHROPIC_API_KEY && await aiAllowed(req.dealershipId, isOwner)) {
      try {
        const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
        const cur = isUS ? 'USD' : 'CAD', du = isUS ? 'mi' : 'km'
        const mileVsMarket = (mileage > 0 && compMiles > 0)
          ? `This vehicle has ${mileage.toLocaleString()} ${du} vs a market median of ${Math.round(compMiles).toLocaleString()} ${du} (${mileageAdj >= 0 ? '+' : '−'}${cur} $${Math.abs(mileageAdj).toLocaleString()} mileage adjustment).`
          : ''
        const accidentLine = (accidentTier !== 'none' && historyCut > 0)
          ? `Accident/history: this vehicle has a ${accidentTier} accident/history record${reportedDamage ? ` (~${cur} $${reportedDamage.toLocaleString()} reported damage)` : ''}, which permanently lowers value — we deducted ${cur} $${historyCut.toLocaleString()} (${Math.round(accidentPct * 100)}%) from clean retail. State this plainly as a reason the offer is below a clean-history example.`
          : ''
        const soldLine = (sold && sold.median_price > 0)
          ? `Proven to market: ${sold.count} recently SOLD comparable${sold.count === 1 ? '' : 's'} sold at a median of ${cur} $${sold.median_price.toLocaleString()}${sold.median_dom != null ? `, averaging ${sold.median_dom} days on market before selling` : ''}. Real sold prices run about ${Math.round(realism * 100)}% below the ${cur} $${compMedian.toLocaleString()} asking median, which is why the offer is grounded in what these cars actually sell for — not just what they're listed at.`
          : ''
        const prompt = `Write a professional 2–3 sentence market summary for a vehicle trade-appraisal sheet a dealer hands to a customer. Explain the offer in plain English and justify it with the market data, including how the odometer moved the value${soldLine ? ' and how recently-sold comps prove the number' : ''}. No markdown, no bullet points, no greeting.
Vehicle: ${year} ${make} ${model}${trim ? ' ' + trim : ''}${mileage ? `, ${mileage.toLocaleString()} ${du}` : ''}.
Retail market from ${market.count} comparable listings: asking median ${cur} $${compMedian.toLocaleString()}, range $${(market.low_price || compMedian).toLocaleString()}–$${(market.high_price || compMedian).toLocaleString()}. ${mileVsMarket}
${soldLine}
${accidentLine}
Adjusted retail value for this vehicle: ${cur} $${retailMid.toLocaleString()}.${tradeValue < retailMid - 1 ? `
Wholesale value (ACV): ${cur} $${tradeValue.toLocaleString()} — about ${Math.round(tradeRatio * 100)}% of retail, in line with trade/wholesale valuation tools like AutoTrader.` : ''}
ACV / wholesale take-in (what the dealer buys it for): ${cur} $${suggestedOffer.toLocaleString()} — the retail value less ${cur} $${recon.toLocaleString()} reconditioning and a ${cur} $${targetGross.toLocaleString()} target gross, in line with trade-value tools like AutoTrader.`
        const msg = await Promise.race([
          anthropic.messages.create({ model: SMART_MODEL, max_tokens: 220, messages: [{ role: 'user', content: prompt }] }),
          new Promise((_, rej) => setTimeout(() => rej(new Error('ai timeout')), 20000)),
        ])
        ai_summary = (msg?.content?.[0]?.text || '').trim() || null
        if (ai_summary) recordUsage(req.dealershipId, { ai: 1 })
      } catch { /* summary is a nice-to-have — never fail the appraisal for it */ }
    }

    // Auto-log this appraisal so it shows in Recent Trades (rep sees own, dealer sees
    // all). Re-appraising in the same session updates the same row (appraisal_id from
    // the client) instead of piling up duplicates. Never fail the appraisal on error.
    const appraisalObj = {
      suggested_offer: suggestedOffer, retail_mid: retailMid, trade_value: tradeValue,
      recon, target_gross: targetGross, gross_pct: grossPct, pct_to_market: pctToMarket,
      ai_summary,
      sold_median: sold?.median_price ?? null,
      sold_dom: sold?.median_dom ?? null,
      sold_count: sold?.count ?? null,
      accident_tier: accidentTier !== 'none' ? accidentTier : null,
      accident_amount: historyCut || null,
      retail_clean: retailClean,
      book_value: bookValue, book_capped: bookCapped,
    }
    let appraisal_id = null
    try {
      const tradeRow = {
        dealership_id: req.dealershipId,
        created_by: req.user.id,
        salesperson_name: req.profile?.full_name || req.user.email || null,
        year, make, model, trim: trim || null, vin: vehicle.vin || null, mileage,
        suggested_offer: suggestedOffer, currency: isUS ? 'USD' : 'CAD',
        appraisal: appraisalObj,
      }
      const existingId = String(b.appraisal_id || '').trim()
      if (existingId) {
        const { data: owned } = await supabaseAdmin.from('trade_appraisals')
          .select('id, created_by').eq('id', existingId).eq('dealership_id', req.dealershipId).maybeSingle()
        if (owned && owned.created_by === req.user.id) {
          await supabaseAdmin.from('trade_appraisals').update(tradeRow).eq('id', existingId)
          appraisal_id = existingId
        }
      }
      if (!appraisal_id) {
        const { data: ins } = await supabaseAdmin.from('trade_appraisals').insert(tradeRow).select('id').single()
        appraisal_id = ins?.id || null
      }
    } catch (e) { console.warn('[appraise] auto-log failed:', e.message) }

    res.json({
      ok: true,
      vehicle,
      appraisal_id,
      dealer_name: dealer?.name || null,
      currency: isUS ? 'USD' : 'CAD',
      distance_unit: isUS ? 'mi' : 'km',
      dealer_postal: zip || null,            // for the AutoTrader/CarGurus jump-off links
      search_radius: radius || null,
      retail: {
        median: retailMid,                    // adjusted retail value for THIS vehicle
        comp_median: compMedian,               // raw median asking price of the comps
        low: market.low_price ?? null,
        high: market.high_price ?? null,
        avg: market.avg_price ?? null,
        count: market.count ?? null,
        num_found: market.num_found ?? null,   // total matching listings in the market
        avg_days_online: market.avg_days_online ?? null,
        avg_mileage: market.avg_mileage ?? market.median_mileage ?? null,
        market_mileage: compMiles,             // median mileage of the comp pool
        matched_on: market.matched_on || {},   // which filters shaped the comp set
        radius_used: market.radius_used ?? null,
        geo_scope: market.geo_scope ?? null,   // province code (e.g. 'ON') or 'radius'
        median_distance: market.median_distance ?? null,
        source: market.source || 'MarketCheck',
      },
      appraisal: {
        suggested_offer: suggestedOffer,
        retail_mid: retailMid,
        trade_value: tradeValue,               // market ACV — compare to AutoTrader
        trade_ratio: Math.round(tradeRatio * 1000) / 10,
        recon,
        target_gross: targetGross,
        gross_pct: grossPct,
        pct_to_market: pctToMarket,
        book_value: bookValue,                 // dealer's guide book, if entered
        book_capped: bookCapped,               // offer was capped down to book
        ai_summary,
        // Transparent value bridge: comp asking median → adjusted retail → trade → offer.
        adjustments: {
          comp_median: compMedian,
          subject_mileage: mileage || null,
          market_mileage: compMiles,
          mileage_adjustment: mileageAdj,
          market_realism_pct: Math.round(realism * 1000) / 10,
          market_realism_amount: -realismCut,
          market_realism_proven: realismProven,   // true = gap derived from real sold comps
          retail_from_comps: retailFromComps,       // ask-derived retail (one signal)
          retail_clean: retailClean,                // reconciled clean-history retail (blend)
          accident_tier: accidentTier !== 'none' ? accidentTier : null,
          accident_pct: accidentPct ? Math.round(accidentPct * 1000) / 10 : null,
          accident_amount: historyCut ? -historyCut : null,
          retail_value: retailMid,                  // retail after the accident/history haircut
          trade_ratio_pct: Math.round(tradeRatio * 1000) / 10,
          trade_value: tradeValue,
          recon: -recon,
          target_gross: -targetGross,
        },
        // How the reconciled retail was assembled — so the sheet can show ONE retail
        // built from all sources instead of two contradicting headline numbers.
        retail_signals: {
          comps: retailFromComps,
          sold: soldRetail,                                    // mileage-adjusted sold median (or null)
          model: prediction?.predicted ?? null,                // MarketCheck VIN model (or null)
          reconciled: retailMid,
        },
      },
      // Recently-sold "proven to market" panel: real transaction prices + days-on-market.
      sold: sold ? {
        count: sold.count,
        num_found: sold.num_found ?? null,
        median_price: sold.median_price,
        avg_price: sold.avg_price ?? null,
        low: sold.low_price ?? null,
        high: sold.high_price ?? null,
        median_mileage: sold.median_mileage ?? null,
        median_dom: sold.median_dom ?? null,                   // proven days on market
        adjusted_retail: soldRetail,                           // sold median nudged to this odometer
        ask_vs_sold_pct: (compMedian > 0 && sold.median_price > 0)
          ? Math.round(((compMedian - sold.median_price) / compMedian) * 1000) / 10 : null,
        offer_vs_sold_pct: (sold.median_price > 0)
          ? Math.round((suggestedOffer / sold.median_price) * 100) : null,
        matched_on: sold.matched_on || {},
        geo_scope: sold.geo_scope ?? null,
        radius_used: sold.radius_used ?? null,
        listings: (sold.listings || []).slice(0, 40).map(l => ({
          price: l.price, miles: l.miles, city: l.city, region: l.region,
          dealer: l.dealer || null, dom: l.dom ?? null, sold_date: l.sold_date || null,
          url: l.vdp_url || null, source: l.source || null,
        })),
      } : null,
      // Accident / history deduction applied to retail (null tier when clean).
      accident: accidentTier !== 'none' ? {
        tier: accidentTier,
        pct: Math.round(accidentPct * 1000) / 10,
        amount: historyCut,
        reported_damage: reportedDamage || null,
        retail_clean: retailClean,
        retail_after: retailMid,
      } : null,
      // MarketCheck model-comparable predicted retail + confidence band (or null).
      prediction,
      // Sample comps (price + mileage + location + clickable listing link) for the
      // charts AND the vAuto-style "click through to the live listing" comp table.
      comps: compList.slice(0, 100).map(l => ({
        price: l.price, miles: l.miles, city: l.city, region: l.region,
        dealer: l.dealer || null, url: l.vdp_url || null, source: l.source || null,
        trim: l.trim || null, dist: l.dist ?? null,
      })),
      locations,
    })
  })

  // ── Saved trade appraisals (customer + disclosure + salesperson) ───────────
  // Persist a completed appraisal with customer info and disclosure answers,
  // attributed to the logged-in salesperson from the auth token (never the body).
  // Inventory Intelligence add-on; owner exempt.
  app.post('/ai/appraisals', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership associated' })
    const isOwner = (req.user.email || '').toLowerCase() === OWNER_EMAIL
    const { data: dealer } = await supabaseAdmin
      .from('dealerships').select('inv_intel_active').eq('id', req.dealershipId).maybeSingle()
    if (!isOwner && !dealer?.inv_intel_active) return res.status(403).json({ error: 'Inventory Intelligence add-on required' })

    const b = req.body || {}
    const v = b.vehicle || {}
    const ap = b.appraisal || {}
    const num = x => { const n = Number(x); return Number.isFinite(n) ? n : null }
    const row = {
      dealership_id: req.dealershipId,
      created_by: req.user.id,
      salesperson_name: (b.salesperson_name && String(b.salesperson_name).trim()) || req.profile?.full_name || req.user.email || null,
      vin: v.vin ? String(v.vin).trim().toUpperCase().slice(0, 17) : null,
      year: v.year ? (parseInt(v.year) || null) : null,
      make: v.make || null, model: v.model || null, trim: v.trim || null,
      mileage: num(v.mileage),
      body_type: v.body_type || null, engine: v.engine || null,
      transmission: v.transmission || null, drivetrain: v.drivetrain || null,
      fuel_type: v.fuel_type || null, color: v.color || null,
      disposition: b.disposition === 'wholesale' ? 'wholesale' : 'retail',
      currency: b.currency || null,
      retail_median: num(ap.retail_mid), suggested_offer: num(ap.suggested_offer),
      recon: num(ap.recon), target_gross: num(ap.target_gross),
      appraisal: (ap && typeof ap === 'object') ? ap : null,
      customer: (b.customer && typeof b.customer === 'object') ? b.customer : null,
      disclosure: (b.disclosure && typeof b.disclosure === 'object') ? b.disclosure : null,
    }
    let savedId
    if (b.id) {
      // On update, preserve the original salesperson/creator — a manager editing a
      // rep's appraisal must not reattribute it to themselves.
      const { created_by, salesperson_name, ...rowUpdate } = row
      const { data, error } = await supabaseAdmin.from('trade_appraisals')
        .update(rowUpdate).eq('id', b.id).eq('dealership_id', req.dealershipId).select('id').maybeSingle()
      if (error) return res.status(500).json({ error: error.message })
      savedId = data?.id || b.id
    } else {
      const { data, error } = await supabaseAdmin.from('trade_appraisals').insert(row).select('id').single()
      if (error) return res.status(500).json({ error: error.message })
      savedId = data.id
    }

    // Land the customer on a unified CRM contact so the trade shows in their timeline.
    try {
      const cust = row.customer || {}
      const cname = [cust.first_name, cust.last_name].filter(Boolean).join(' ').trim() || cust.name || null
      // Prefer an explicit contact chosen via "Search customers" — link exactly. Only
      // trust an id that belongs to this dealership.
      let contactId = null
      const wantId = (b.contact_id || cust.contact_id || '').toString().trim()
      if (wantId) {
        const { data: c } = await supabaseAdmin.from('contacts')
          .select('id').eq('id', wantId).eq('dealership_id', req.dealershipId).maybeSingle()
        if (c) contactId = c.id
      }
      if (!contactId && (cname || cust.email || cust.phone || cust.mobile_phone || cust.home_phone)) {
        contactId = await findOrCreateContact({
          dealershipId: req.dealershipId, name: cname,
          email: cust.email, phone: cust.phone || cust.mobile_phone || cust.home_phone,
          repId: req.user.id, source: 'Trade Appraisal',
        })
      }
      if (contactId) await supabaseAdmin.from('trade_appraisals').update({ contact_id: contactId }).eq('id', savedId)
    } catch (e) { console.warn('[appraisals] contact link failed:', e.message) }

    // Notify selected appraisers (managers) — one targeted notification each.
    const notifyIds = Array.isArray(b.notify) ? [...new Set(b.notify.filter(Boolean))] : []
    if (notifyIds.length) {
      const vlabel = [row.year, row.make, row.model, row.trim].filter(Boolean).join(' ') || 'a vehicle'
      const who = row.salesperson_name || 'A salesperson'
      const cName = [row.customer?.first_name, row.customer?.last_name].filter(Boolean).join(' ')
      createNotifications(notifyIds.map(uid => ({
        dealership_id: req.dealershipId,
        type: 'appraisal',
        title: 'Appraisal to review',
        body: `${who} requests your appraisal on ${vlabel}${cName ? ` for ${cName}` : ''}.`,
        link_page: 'appraisal',
        target_user_id: uid,
      }))).catch(() => {})
    }
    res.json({ ok: true, id: savedId, notified: notifyIds.length })
  })

  // Management (owner/admin/manager) always sees the whole lot's appraisals. Reps
  // see only their own unless the dealership's appraisals_reps_see_all is on.
  const MANAGEMENT_ROLES = ['OWNER', 'DEALER_ADMIN', 'MANAGER']
  app.get('/ai/appraisals', requireAuth, async (req, res) => {
    const emptyMeta = { is_management: false, reps_see_all: false, restricted: true, salespeople: [] }
    if (!req.dealershipId) return res.json({ items: [], meta: emptyMeta })
    const role = req.profile?.role || 'SALES_REP'
    const isManagement = MANAGEMENT_ROLES.includes(role)
    // Per-rep visibility: management always sees all; a rep sees all only if their
    // own profile flag is set (toggled per rep in Sales Team settings).
    const repsSeeAll = !!req.profile?.can_see_all_appraisals
    const restrictToOwn = !isManagement && !repsSeeAll

    let query = supabaseAdmin.from('trade_appraisals')
      .select('id, created_at, created_by, salesperson_name, year, make, model, trim, vin, suggested_offer, currency, disposition, customer')
      .eq('dealership_id', req.dealershipId)
      .order('created_at', { ascending: false }).limit(200)
    if (restrictToOwn) query = query.eq('created_by', req.user.id)
    else if (req.query.salesperson) query = query.eq('created_by', req.query.salesperson)
    if (req.query.disposition === 'retail' || req.query.disposition === 'wholesale') query = query.eq('disposition', req.query.disposition)

    const { data, error } = await query
    if (error) return res.status(500).json({ error: error.message })
    let items = (data || []).map(r => ({
      id: r.id, created_at: r.created_at, created_by: r.created_by, salesperson: r.salesperson_name,
      label: [r.year, r.make, r.model, r.trim].filter(Boolean).join(' '),
      vin: r.vin, offer: r.suggested_offer, currency: r.currency, disposition: r.disposition,
      customer_name: [r.customer?.first_name, r.customer?.last_name].filter(Boolean).join(' ') || null,
    }))
    const q = (req.query.q || '').trim().toLowerCase()
    if (q) items = items.filter(it => [it.label, it.vin, it.customer_name, it.salesperson].filter(Boolean).join(' ').toLowerCase().includes(q))

    // Salespeople list for the filter dropdown — from the full dealership set (not
    // the current filter), so the dropdown stays stable. Management / reps-see-all only.
    let salespeople = []
    if (!restrictToOwn) {
      const { data: sp } = await supabaseAdmin.from('trade_appraisals')
        .select('created_by, salesperson_name').eq('dealership_id', req.dealershipId).limit(1000)
      const seen = new Map()
      for (const r of (sp || [])) if (r.created_by && !seen.has(r.created_by)) seen.set(r.created_by, r.salesperson_name || '—')
      salespeople = [...seen.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => (a.name || '').localeCompare(b.name || ''))
    }
    res.json({ items, meta: { role, is_management: isManagement, reps_see_all: repsSeeAll, restricted: restrictToOwn, salespeople } })
  })

  // Management sets a SINGLE rep's appraisal visibility (see all vs. own only).
  app.put('/ai/rep-appraisal-visibility', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership associated' })
    if (!MANAGEMENT_ROLES.includes(req.profile?.role)) return res.status(403).json({ error: 'Only management can change this.' })
    const repId = req.body?.rep_id
    if (!repId) return res.status(400).json({ error: 'rep_id required' })
    const can = !!req.body?.can_see_all
    // Scope to the same dealership so a manager can't flip a rep at another store.
    const { data, error } = await supabaseAdmin.from('profiles')
      .update({ can_see_all_appraisals: can }).eq('id', repId).eq('dealership_id', req.dealershipId)
      .select('id').maybeSingle()
    if (error) return res.status(500).json({ error: error.message })
    if (!data) return res.status(404).json({ error: 'Rep not found in your dealership' })
    res.json({ ok: true, rep_id: repId, can_see_all: can })
  })

  app.get('/ai/appraisals/:id', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership associated' })
    const { data, error } = await supabaseAdmin.from('trade_appraisals')
      .select('*').eq('id', req.params.id).eq('dealership_id', req.dealershipId).maybeSingle()
    if (error) return res.status(500).json({ error: error.message })
    if (!data) return res.status(404).json({ error: 'Not found' })
    res.json(data)
  })

  // Push an appraised/won trade onto the website inventory — GATED until the
  // dealer takes possession (#16). The unit is created hidden (awaiting_possession)
  // and only goes live once the linked deal is Delivered in the CRM, or a manager
  // flips possession manually. Images/docs (#18) come from the brochure/window
  // sticker fetched during appraisal, carried over as-is when the client passes them.
  app.post('/ai/appraisals/:id/acquire', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership associated' })
    if (!MANAGEMENT_ROLES.includes(req.profile?.role)) return res.status(403).json({ error: 'Manager access required' })
    const { data: ap, error } = await supabaseAdmin.from('trade_appraisals')
      .select('*').eq('id', req.params.id).eq('dealership_id', req.dealershipId).maybeSingle()
    if (error) return res.status(500).json({ error: error.message })
    if (!ap) return res.status(404).json({ error: 'Appraisal not found' })

    // Already pushed? Return the existing unit rather than duplicating.
    if (ap.inventory_id) {
      const { data: existing } = await supabaseAdmin.from('inventory')
        .select('id, status, awaiting_possession').eq('id', ap.inventory_id).maybeSingle()
      if (existing) return res.json({ ok: true, inventory_id: existing.id, already: true, awaiting_possession: !!existing.awaiting_possession })
    }

    const b = req.body || {}
    const numOrNull = (x) => { const n = Number(x); return Number.isFinite(n) ? n : null }
    // Asking price defaults to the appraisal's reconciled retail; the manager can edit later.
    const retail = numOrNull(ap.appraisal?.retail_mid) ?? numOrNull(ap.retail_median)
    const price = numOrNull(b.price) ?? retail
    // Brochure / window-sticker docs captured during appraisal (as-is, #18).
    const docFields = {}
    for (const k of ['window_sticker_oem_url', 'window_sticker_gen_url', 'brochure_oem_url', 'brochure_gen_url']) {
      if (b[k] && typeof b[k] === 'string') docFields[k] = b[k]
    }
    const row = {
      dealership_id: req.dealershipId, source: 'appraisal', status: 'available',
      condition: 'used',
      vin: ap.vin ? String(ap.vin).trim().toUpperCase().slice(0, 17) : null,
      year: ap.year || null, make: ap.make || null, model: ap.model || null, trim: ap.trim || null,
      mileage: numOrNull(ap.mileage), price,
      body_style: ap.body_type || null, engine: ap.engine || null,
      transmission: ap.transmission || null, drivetrain: ap.drivetrain || null,
      fuel_type: ap.fuel_type || null, exterior_color: ap.color || null,
      stocknumber: (b.stocknumber && String(b.stocknumber).trim()) || (ap.vin ? String(ap.vin).trim().toUpperCase().slice(-8) : null),
      image_urls: Array.isArray(b.image_urls) ? b.image_urls.filter(u => typeof u === 'string') : [],
      description: b.description || null,
      ...docFields,
      // The possession gate: hidden from the public site until this clears.
      awaiting_possession: true,
      source_appraisal_id: ap.id,
      lot_date: new Date().toISOString(),
    }
    const { data: inv, error: invErr } = await supabaseAdmin.from('inventory').insert(row).select('id').single()
    if (invErr) return res.status(500).json({ error: invErr.message })
    await supabaseAdmin.from('trade_appraisals').update({ inventory_id: inv.id }).eq('id', ap.id)
    // #18: best-effort factory window sticker for the unit (Inventory Intelligence only),
    // fire-and-forget so it never delays or fails the acquisition.
    if (row.vin && !row.window_sticker_oem_url) {
      const { data: dealer } = await supabaseAdmin.from('dealerships').select('inv_intel_active').eq('id', req.dealershipId).maybeSingle()
      const isOwner = (req.user.email || '').toLowerCase() === OWNER_EMAIL
      if (isOwner || dealer?.inv_intel_active) attachOemStickerToInventory(req.dealershipId, inv.id, { vin: row.vin, make: row.make }).catch(() => {})
    }
    res.json({ ok: true, inventory_id: inv.id, awaiting_possession: true })
  })

  // Manually clear the possession gate → the acquired unit goes live on the site.
  app.post('/ai/appraisals/:id/take-possession', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership associated' })
    if (!MANAGEMENT_ROLES.includes(req.profile?.role)) return res.status(403).json({ error: 'Manager access required' })
    const { data: ap } = await supabaseAdmin.from('trade_appraisals')
      .select('id, inventory_id').eq('id', req.params.id).eq('dealership_id', req.dealershipId).maybeSingle()
    if (!ap?.inventory_id) return res.status(404).json({ error: 'No acquired unit for this appraisal' })
    const { error } = await supabaseAdmin.from('inventory')
      .update({ awaiting_possession: false, possession_at: new Date().toISOString() })
      .eq('id', ap.inventory_id).eq('dealership_id', req.dealershipId)
    if (error) return res.status(500).json({ error: error.message })
    await supabaseAdmin.from('trade_appraisals').update({ acquired_at: new Date().toISOString() }).eq('id', ap.id)
    res.json({ ok: true, inventory_id: ap.inventory_id, live: true })
  })

  // Managers/appraisers for the "Notify appraiser" checklist (any dealership user).
  app.get('/ai/appraisers', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.json([])
    const { data, error } = await supabaseAdmin.from('profiles')
      .select('id, full_name, role')
      .eq('dealership_id', req.dealershipId)
      .in('role', MANAGEMENT_ROLES)
      .order('full_name', { ascending: true })
    if (error) return res.status(500).json({ error: error.message })
    res.json((data || []).map(m => ({ id: m.id, name: m.full_name || '(no name)', role: m.role })))
  })

  // Save this rep's language preference (chosen in the Google Translate widget).
  // Per-user; also becomes the default language for their AI Facebook copy.
  app.put('/ai/my-language', requireAuth, async (req, res) => {
    const code = String(req.body?.language || '').trim().toLowerCase().slice(0, 12) || null
    const { error } = await supabaseAdmin.from('profiles')
      .update({ preferred_language: code }).eq('id', req.user.id)
    if (error) return res.status(500).json({ error: error.message })
    res.json({ ok: true, language: code })
  })
  // ── Weekly Lot Health Report ─────────────────────────────────────────────

  async function buildReportData(dealershipId) {
    const now = Date.now()
    const ago7  = new Date(now - 7  * 86400000).toISOString()
    const ago14 = new Date(now - 14 * 86400000).toISOString()

    const [
      { data: allVehicles },
      { data: recentActivity },
      { data: prevActivity },
      { data: soldRecent }
    ] = await Promise.all([
      supabaseAdmin.from('inventory')
        .select('id, year, make, model, trim, price, condition, stocknumber, image_urls, last_synced_at, created_at, lot_date, status')
        .eq('dealership_id', dealershipId)
        .eq('status', 'available'),
      supabaseAdmin.from('ai_activity')
        .select('inventory_id, vehicle_label, warnings, price_flagged, price_pct_diff, created_at')
        .eq('dealership_id', dealershipId)
        .gte('created_at', ago7)
        .order('created_at', { ascending: false })
        .limit(500),
      supabaseAdmin.from('ai_activity')
        .select('inventory_id, price_flagged, price_pct_diff')
        .eq('dealership_id', dealershipId)
        .gte('created_at', ago14)
        .lt('created_at', ago7)
        .limit(500),
      // Recently sold: units the feed flagged sold, plus units we archived when they
      // dropped off the feed (a sale). "Sold date" = archived_at, else last_synced_at.
      supabaseAdmin.from('inventory')
        .select('id, status, archived_at, last_synced_at')
        .eq('dealership_id', dealershipId)
        .in('status', ['sold', 'archived'])
        .or(`archived_at.gte.${ago14},last_synced_at.gte.${ago14}`)
    ])

    const vehicles = allVehicles || []
    const totalUnits = vehicles.length
    const withPhotos = vehicles.filter(v => v.image_urls?.length > 0).length
    const noPhotos = vehicles.filter(v => !v.image_urls?.length)
    const prices = vehicles.filter(v => v.price > 0).map(v => Number(v.price)).sort((a, b) => a - b)
    const avgPrice = prices.length ? Math.round(prices.reduce((a, b) => a + b, 0) / prices.length) : null
    const medianPrice = prices.length ? prices[Math.floor(prices.length / 2)] : null

    const withDays = vehicles.map(v => ({
      ...v,
      // Days on lot = time since the unit landed (true lot_date from the feed when
      // present, else created_at = first-seen). last_synced_at is rewritten every
      // sync, so it's only a last-ditch fallback and can never measure age.
      daysOnLot: Math.floor((now - new Date(v.lot_date || v.created_at || v.last_synced_at).getTime()) / 86400000)
    }))
    const aging = withDays.filter(v => v.daysOnLot > 60).sort((a, b) => b.daysOnLot - a.daysOnLot)
    const slowMovers30 = withDays.filter(v => v.daysOnLot > 30 && v.daysOnLot <= 60).sort((a, b) => b.daysOnLot - a.daysOnLot)
    const avgDays = withDays.length ? Math.round(withDays.reduce((s, v) => s + v.daysOnLot, 0) / withDays.length) : 0

    const vehicleById = {}
    for (const v of vehicles) vehicleById[v.id] = v

    const driftMap = {}
    for (const a of (recentActivity || [])) {
      if (!a.price_flagged) continue
      const inv = vehicleById[a.inventory_id]
      if (!inv) continue
      const _cond = (inv.condition || '').toLowerCase()
      if (_cond === 'new' || _cond === 'demo' || _cond === 'demonstrator' || _cond === '') continue
      const key = a.inventory_id || a.vehicle_label
      if (!driftMap[key] || Math.abs(a.price_pct_diff) > Math.abs(driftMap[key].price_pct_diff)) driftMap[key] = a
    }
    const priceDrift = Object.values(driftMap).sort((a, b) => Math.abs(b.price_pct_diff) - Math.abs(a.price_pct_diff))

    const warnMap = {}
    for (const a of (recentActivity || [])) {
      const nonPhotoWarnings = (a.warnings || []).filter(w => !w.toLowerCase().includes('photo'))
      if (!nonPhotoWarnings.length) continue
      const key = a.inventory_id || a.vehicle_label
      if (!warnMap[key]) warnMap[key] = { ...a, warnings: nonPhotoWarnings }
    }
    const missingInfo = Object.values(warnMap)

    // Prev week price flags for delta comparison
    const prevDriftMap = {}
    for (const a of (prevActivity || [])) {
      if (!a.price_flagged) continue
      const inv = vehicleById[a.inventory_id]
      if (!inv) continue
      const _cond = (inv.condition || '').toLowerCase()
      if (_cond === 'new' || _cond === 'demo' || _cond === 'demonstrator' || _cond === '') continue
      const key = a.inventory_id || a.vehicle_label
      prevDriftMap[key] = a
    }
    const prevPriceFlagCount = Object.keys(prevDriftMap).length

    // New arrivals (created_at based on currently available inventory)
    const newArrivalsThisWeek = vehicles.filter(v => v.created_at >= ago7).length
    const newArrivalsPrevWeek = vehicles.filter(v => v.created_at >= ago14 && v.created_at < ago7).length
    const soldAt = (v) => v.archived_at || v.last_synced_at
    const soldThisWeekCount = (soldRecent || []).filter(v => soldAt(v) >= ago7).length
    const soldPrevWeekCount = (soldRecent || []).filter(v => soldAt(v) >= ago14 && soldAt(v) < ago7).length

    // Condition mix
    const conditionCount = { new: 0, used: 0, demo: 0 }
    for (const v of vehicles) {
      const c = (v.condition || '').toLowerCase()
      if (c === 'new') conditionCount.new++
      else if (c === 'demo' || c === 'demonstrator') conditionCount.demo++
      else conditionCount.used++
    }

    // Price brackets
    const priceBrackets = [
      { label: '< $20K',    min: 0,     max: 20000, count: 0 },
      { label: '$20K–40K',  min: 20000, max: 40000, count: 0 },
      { label: '$40K–60K',  min: 40000, max: 60000, count: 0 },
      { label: '$60K–80K',  min: 60000, max: 80000, count: 0 },
      { label: '$80K+',     min: 80000, max: Infinity, count: 0 },
    ]
    for (const v of vehicles) {
      const p = Number(v.price) || 0
      const b = priceBrackets.find(b => p >= b.min && p < b.max)
      if (b) b.count++
    }

    // Days on lot distribution
    const daysBrackets = [
      { label: '0–30 days',  count: 0 },
      { label: '31–60 days', count: 0 },
      { label: '61–90 days', count: 0 },
      { label: '90+ days',   count: 0 },
    ]
    for (const v of withDays) {
      if (v.daysOnLot <= 30) daysBrackets[0].count++
      else if (v.daysOnLot <= 60) daysBrackets[1].count++
      else if (v.daysOnLot <= 90) daysBrackets[2].count++
      else daysBrackets[3].count++
    }

    const makeCount = {}
    for (const v of vehicles) {
      const raw = (v.make || 'Unknown').trim()
      const k = raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase()
      makeCount[k] = (makeCount[k] || 0) + 1
    }
    const topMakes = Object.entries(makeCount).sort((a, b) => b[1] - a[1]).slice(0, 5)

    // CRM + sales activity (this week vs last) — makes the briefing about the whole
    // store, not just the lot: leads, deals, appointments/show-rate, e-sign, tasks.
    const [{ data: crmLeads }, { data: crmDeals }, { data: crmAppts }, { data: crmEsign }, { data: crmTasksDone }] = await Promise.all([
      supabaseAdmin.from('leads').select('created_at').eq('dealership_id', dealershipId).gte('created_at', ago14).limit(50000),
      supabaseAdmin.from('deals').select('selling_price, deal_status, sold_at').eq('dealership_id', dealershipId).in('deal_status', ['sold', 'fni', 'delivered']).gte('sold_at', ago14).limit(20000),
      supabaseAdmin.from('crm_tasks').select('due_at, done, created_at').eq('dealership_id', dealershipId).eq('type', 'appointment').gte('created_at', ago14).limit(50000),
      supabaseAdmin.from('esign_requests').select('status, created_at').eq('dealership_id', dealershipId).gte('created_at', ago14).limit(20000),
      supabaseAdmin.from('crm_tasks').select('done_at').eq('dealership_id', dealershipId).eq('done', true).gte('done_at', ago14).limit(50000),
    ])
    const inWk = (iso) => iso && iso >= ago7
    const inPrev = (iso) => iso && iso >= ago14 && iso < ago7
    const dealsWkRows = (crmDeals || []).filter(d => inWk(d.sold_at))
    const pastApptsWk = (crmAppts || []).filter(a => a.due_at && new Date(a.due_at).getTime() < now && a.due_at >= ago7)
    const apptShowed = pastApptsWk.filter(a => a.done).length
    const crm = {
      leadsWk: (crmLeads || []).filter(l => inWk(l.created_at)).length,
      leadsPrev: (crmLeads || []).filter(l => inPrev(l.created_at)).length,
      dealsWk: dealsWkRows.length,
      dealsPrev: (crmDeals || []).filter(d => inPrev(d.sold_at)).length,
      revenueWk: Math.round(dealsWkRows.reduce((s, d) => s + (Number(d.selling_price) || 0), 0)),
      apptsWk: (crmAppts || []).filter(a => inWk(a.created_at)).length,
      apptsPrev: (crmAppts || []).filter(a => inPrev(a.created_at)).length,
      apptShowed,
      apptShowRate: pastApptsWk.length ? Math.round((apptShowed / pastApptsWk.length) * 100) : null,
      esignSentWk: (crmEsign || []).filter(e => inWk(e.created_at)).length,
      esignSignedWk: (crmEsign || []).filter(e => inWk(e.created_at) && e.status === 'signed').length,
      tasksDoneWk: (crmTasksDone || []).filter(t => inWk(t.done_at)).length,
    }

    return {
      crm,
      vehicles, vehicleById,
      totalUnits, withPhotos, noPhotos, prices, avgPrice, medianPrice,
      withDays, aging, slowMovers30, avgDays,
      priceDrift, missingInfo,
      prevPriceFlagCount,
      newArrivalsThisWeek, newArrivalsPrevWeek,
      soldThisWeekCount, soldPrevWeekCount,
      conditionCount, priceBrackets, daysBrackets, topMakes
    }
  }

  app.post('/ai/weekly-report', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership associated' })

    const { data: dealer } = await supabaseAdmin
      .from('dealerships')
      .select('ai_boost_active, ai_manager_email, name')
      .eq('id', req.dealershipId)
      .single()

    const isOwner = (req.user.email || '').toLowerCase() === OWNER_EMAIL
    if (!isOwner && !dealer?.ai_boost_active) return res.status(403).json({ error: 'AI Boost not active' })
    if (!resend) return res.status(503).json({ error: 'Email not configured' })

    const d = await buildReportData(req.dealershipId)
    const {
      vehicles, vehicleById,
      totalUnits, withPhotos, noPhotos, avgPrice, medianPrice,
      aging, slowMovers30, avgDays,
      priceDrift, missingInfo,
      prevPriceFlagCount,
      newArrivalsThisWeek, newArrivalsPrevWeek,
      soldThisWeekCount, soldPrevWeekCount,
      conditionCount, priceBrackets, daysBrackets, topMakes, crm
    } = d

    const dealerName = dealer.name || 'Your Dealership'
    const primary = '#1a2e4a'
    const accent = '#6366f1'

    const photosPct = totalUnits ? Math.round((withPhotos / totalUnits) * 100) : 0
    const agingPct  = totalUnits ? Math.round((aging.length / totalUnits) * 100) : 0
    const driftPct  = totalUnits ? Math.round((priceDrift.length / totalUnits) * 100) : 0

    const wkDelta = (curr, prev, lowerBetter = false) => {
      const diff = curr - prev
      if (prev === 0 && diff === 0) return ''
      if (diff === 0) return `<div style="font-size:10px;color:#94a3b8">— same as last wk</div>`
      const up = diff > 0; const good = lowerBetter ? !up : up
      return `<div style="font-size:10px;color:${good ? '#16a34a' : '#ef4444'}">${up ? '↑' : '↓'}${Math.abs(diff)} vs last wk</div>`
    }

    const vLabel = v => {
      const name = [v.year, v.make, v.model, v.trim].filter(Boolean).join(' ')
      return v.stocknumber ? `${name} <span style="color:#64748b;font-size:11px">#${v.stocknumber}</span>` : name
    }
    const aLabel = a => {
      const inv = vehicleById[a.inventory_id]
      const sn = inv?.stocknumber
      return sn ? `${a.vehicle_label} <span style="color:#64748b;font-size:11px">#${sn}</span>` : a.vehicle_label
    }

    const statBox = (label, value, sub, color, delta = '') =>
      `<td width="25%" style="padding:12px;text-align:center;border-right:1px solid #e2e8f0">
        <div style="font-size:22px;font-weight:900;color:${color}">${value}</div>
        <div style="font-size:11px;font-weight:700;color:#475569;margin-top:2px;text-transform:uppercase;letter-spacing:0.05em">${label}</div>
        ${sub ? `<div style="font-size:10px;color:#94a3b8;margin-top:1px">${sub}</div>` : ''}
        ${delta}
      </td>`

    const barRow = (label, count, max, total, color = accent) => {
      const pct = total > 0 ? Math.round((count / total) * 100) : 0
      const barW = max > 0 ? Math.round((count / max) * 180) : 0
      return `<tr>
        <td style="padding:3px 10px;font-size:12px;color:#334155;width:110px;white-space:nowrap">${label}</td>
        <td style="padding:3px 6px"><div style="background:#e2e8f0;border-radius:4px;height:13px;width:190px"><div style="background:${color};border-radius:4px;height:13px;width:${barW}px"></div></div></td>
        <td style="padding:3px 6px;font-size:11px;color:#64748b;white-space:nowrap">${count} (${pct}%)</td></tr>`
    }

    const sectionHeader = (title, cols = 3) =>
      `<tr><td colspan="${cols}" style="background:${primary};color:#fff;font-weight:700;font-size:13px;padding:9px 12px;letter-spacing:0.02em">${title}</td></tr>`

    const subNote = (text, cols = 3) =>
      `<tr><td colspan="${cols}" style="background:#f1f5f9;color:#475569;font-size:11px;padding:7px 12px;border-bottom:1px solid #e2e8f0;font-style:italic">${text}</td></tr>`

    const agingRow = v =>
      `<tr>
        <td style="padding:7px 12px;border-bottom:1px solid #e2e8f0;font-size:13px">${vLabel(v)}</td>
        <td style="padding:7px 12px;border-bottom:1px solid #e2e8f0;text-align:right;font-size:13px">${v.price ? '$' + Number(v.price).toLocaleString() : '—'}</td>
        <td style="padding:7px 12px;border-bottom:1px solid #e2e8f0;text-align:right;font-size:13px;color:${v.daysOnLot > 90 ? '#ef4444' : '#f59e0b'};font-weight:700">${v.daysOnLot}d</td>
      </tr>`

    const driftRow = a => {
      const pct = a.price_pct_diff; const over = pct > 0
      const fix = over
        ? `Consider reducing by $${Math.round(Math.abs(pct / 100) * (vehicleById[a.inventory_id]?.price || 0)).toLocaleString()} to align with market`
        : `May sell faster at current price — or raise to recapture margin`
      return `<tr>
        <td style="padding:7px 12px;border-bottom:1px solid #e2e8f0;font-size:13px">${aLabel(a)}</td>
        <td style="padding:7px 12px;border-bottom:1px solid #e2e8f0;text-align:right;font-size:13px;color:${over ? '#16a34a' : '#ef4444'};font-weight:700">${over ? '+' : ''}${pct}%</td>
        <td style="padding:7px 12px;border-bottom:1px solid #e2e8f0;font-size:11px;color:#64748b">${over ? 'Overpriced' : 'Underpriced'} vs AutoTrader/CarGurus market median. ${fix}</td>
      </tr>`
    }

    const warnRow = a =>
      `<tr>
        <td style="padding:7px 12px;border-bottom:1px solid #e2e8f0;font-size:13px">${aLabel(a)}</td>
        <td colspan="2" style="padding:7px 12px;border-bottom:1px solid #e2e8f0;font-size:12px;color:#b45309">${(a.warnings || []).join(' · ')}</td>
      </tr>`

    const maxCondition = Math.max(conditionCount.new, conditionCount.used, conditionCount.demo, 1)
    const maxPriceBracket = Math.max(...priceBrackets.map(b => b.count), 1)
    const maxDaysBracket = Math.max(...daysBrackets.map(b => b.count), 1)
    const maxMakeCount = topMakes[0]?.[1] || 1
    const dateStr = new Date().toLocaleDateString('en-CA', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })

    const emailHtml = `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>body{margin:0;padding:0;background:#f8fafc;font-family:Arial,sans-serif}</style>
</head><body>
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;padding:24px 0">
<tr><td align="center">
<table width="660" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:10px;overflow:hidden;border:1px solid #e2e8f0">

  <!-- Header -->
  <tr><td style="background:${primary};padding:22px 24px">
    <div style="color:#fff;font-size:22px;font-weight:900">${dealerName}</div>
    <div style="color:#94a3b8;font-size:13px;margin-top:3px">Weekly Lot Health Report</div>
    <div style="color:#e2e8f0;font-size:15px;font-weight:700;margin-top:6px">${dateStr}</div>
  </td></tr>

  <!-- Row 1: inventory breakdown -->
  <tr><td style="padding:0">
    <table width="100%" cellpadding="0" cellspacing="0" style="border-bottom:1px solid #e2e8f0"><tr>
      ${statBox('Total Inventory', totalUnits, 'all available units', '#1a2e4a')}
      ${statBox('New Units', conditionCount.new, `${totalUnits ? Math.round(conditionCount.new/totalUnits*100) : 0}% of lot`, '#0ea5e9')}
      ${statBox('Used Units', conditionCount.used, `${totalUnits ? Math.round(conditionCount.used/totalUnits*100) : 0}% of lot`, '#6366f1')}
      ${statBox('Demo Units', conditionCount.demo, `${totalUnits ? Math.round(conditionCount.demo/totalUnits*100) : 0}% of lot`, '#f59e0b')}
    </tr></table>
  </td></tr>

  <!-- Row 2: core stats -->
  <tr><td style="padding:0">
    <table width="100%" cellpadding="0" cellspacing="0" style="border-bottom:1px solid #e2e8f0"><tr>
      ${statBox('Photos', `${photosPct}%`, `${withPhotos} of ${totalUnits} have photos`, photosPct < 80 ? '#ef4444' : '#16a34a')}
      ${statBox('Avg Days on Lot', avgDays, agingPct > 0 ? `${agingPct}% aging 60d+` : 'healthy turnover', avgDays > 45 ? '#f59e0b' : '#16a34a')}
      ${statBox('Price Flags', priceDrift.length, `${driftPct}% of lot (used)`, priceDrift.length > 0 ? '#ef4444' : '#16a34a', wkDelta(priceDrift.length, prevPriceFlagCount, true))}
      ${statBox('No Photos', noPhotos.length, `${noPhotos.length} listings missing`, noPhotos.length > 0 ? '#ef4444' : '#16a34a')}
    </tr></table>
  </td></tr>

  <!-- Row 3: weekly activity -->
  <tr><td style="padding:0">
    <table width="100%" cellpadding="0" cellspacing="0" style="border-bottom:1px solid #e2e8f0"><tr>
      ${statBox('New Arrivals', newArrivalsThisWeek, 'added this week', '#6366f1', wkDelta(newArrivalsThisWeek, newArrivalsPrevWeek))}
      ${statBox('Sold This Week', soldThisWeekCount, 'units sold last 7 days', soldThisWeekCount > 0 ? '#16a34a' : '#94a3b8', wkDelta(soldThisWeekCount, soldPrevWeekCount))}
      ${statBox('60d+ Aging', aging.length, `${agingPct}% of lot`, aging.length > 0 ? '#f59e0b' : '#16a34a')}
      ${statBox('Avg Ask Price', avgPrice ? '$' + avgPrice.toLocaleString() : '—', medianPrice ? `median $${medianPrice.toLocaleString()}` : '', '#334155')}
    </tr></table>
  </td></tr>

  <!-- Charts row -->
  <tr><td style="padding:14px 20px 8px">
    <table width="100%" cellpadding="0" cellspacing="0"><tr valign="top">

      <!-- Inventory mix by make -->
      <td width="50%" style="padding-right:12px">
        <div style="font-size:12px;font-weight:700;color:${primary};margin-bottom:6px">Inventory by Make</div>
        <table cellpadding="0" cellspacing="0">
          ${topMakes.map(([make, cnt]) => barRow(make, cnt, maxMakeCount, totalUnits)).join('')}
        </table>
        <div style="font-size:10px;color:#94a3b8;margin-top:4px">Avg $${avgPrice?.toLocaleString() ?? '—'} · Median $${medianPrice?.toLocaleString() ?? '—'}</div>
      </td>

      <!-- Condition mix -->
      <td width="50%" style="padding-left:12px;border-left:1px solid #e2e8f0">
        <div style="font-size:12px;font-weight:700;color:${primary};margin-bottom:6px">Condition Mix</div>
        <table cellpadding="0" cellspacing="0">
          ${barRow('New', conditionCount.new, maxCondition, totalUnits, '#16a34a')}
          ${barRow('Used', conditionCount.used, maxCondition, totalUnits, '#6366f1')}
          ${barRow('Demo', conditionCount.demo, maxCondition, totalUnits, '#f59e0b')}
        </table>
      </td>
    </tr></table>
  </td></tr>

  <!-- Price & days brackets -->
  <tr><td style="padding:8px 20px 14px;border-top:1px solid #f1f5f9">
    <table width="100%" cellpadding="0" cellspacing="0"><tr valign="top">

      <!-- Price brackets -->
      <td width="50%" style="padding-right:12px">
        <div style="font-size:12px;font-weight:700;color:${primary};margin-bottom:6px">Price Distribution</div>
        <table cellpadding="0" cellspacing="0">
          ${priceBrackets.map(b => barRow(b.label, b.count, maxPriceBracket, totalUnits, '#0ea5e9')).join('')}
        </table>
      </td>

      <!-- Days on lot -->
      <td width="50%" style="padding-left:12px;border-left:1px solid #e2e8f0">
        <div style="font-size:12px;font-weight:700;color:${primary};margin-bottom:6px">Days on Lot</div>
        <table cellpadding="0" cellspacing="0">
          ${daysBrackets.map((b, i) => barRow(b.label, b.count, maxDaysBracket, totalUnits, i === 0 ? '#16a34a' : i === 1 ? '#6366f1' : i === 2 ? '#f59e0b' : '#ef4444')).join('')}
        </table>
      </td>
    </tr></table>
  </td></tr>

  <tr><td style="padding:0 24px 16px">
  <table width="100%" cellpadding="0" cellspacing="0" style="font-size:13px">

    ${priceDrift.length ? `
      ${sectionHeader('💰 Price Drift Flags — Used Vehicles Only (' + priceDrift.length + ')')}
      ${subNote('Price drift = this vehicle\'s asking price vs. the market median on AutoTrader &amp; CarGurus for similar make/model/year. Negative = underpriced vs market (leaving margin). Positive = overpriced vs market (may slow the sale). New vehicles excluded.', 3)}
      <tr style="background:#f8fafc"><td style="padding:5px 12px;font-size:11px;font-weight:700;color:#64748b">VEHICLE</td><td style="padding:5px 12px;font-size:11px;font-weight:700;color:#64748b;text-align:right">DRIFT</td><td style="padding:5px 12px;font-size:11px;font-weight:700;color:#64748b">RECOMMENDATION</td></tr>
      ${priceDrift.map(driftRow).join('')}` : ''}

    ${aging.length ? `
      ${sectionHeader('⏱ Aging Units — 60+ Days on Lot (' + aging.length + ')')}
      ${subNote('These units have been sitting for over 60 days. Consider a price reduction, trade-in push, or additional marketing. Units over 90 days are highlighted red.', 3)}
      <tr style="background:#f8fafc"><td style="padding:5px 12px;font-size:11px;font-weight:700;color:#64748b">VEHICLE</td><td style="padding:5px 12px;font-size:11px;font-weight:700;color:#64748b;text-align:right">PRICE</td><td style="padding:5px 12px;font-size:11px;font-weight:700;color:#64748b;text-align:right">DAYS</td></tr>
      ${aging.map(agingRow).join('')}` : ''}

    ${slowMovers30.length ? `
      ${sectionHeader('🐢 Watch List — 30–60 Days on Lot (' + slowMovers30.length + ')')}
      ${subNote('These units are approaching the aging threshold. Monitor closely — a small price move now is better than a large one at 60+ days.', 3)}
      ${slowMovers30.map(agingRow).join('')}` : ''}

    ${noPhotos.length ? `
      ${sectionHeader('📷 No Photos (' + noPhotos.length + ' vehicles)')}
      ${subNote('Listings without photos get significantly fewer clicks. Upload photos through your DMS or directly in MarketSync.', 3)}
      <tr style="background:#f8fafc"><td colspan="3" style="padding:5px 12px;font-size:11px;font-weight:700;color:#64748b">VEHICLE</td></tr>
      ${noPhotos.map(v => `<tr><td colspan="3" style="padding:7px 12px;border-bottom:1px solid #e2e8f0;font-size:13px">${vLabel(v)}</td></tr>`).join('')}` : ''}

    ${missingInfo.length ? `
      ${sectionHeader('⚠ Other Missing Info (' + missingInfo.length + ' flags, last 7 days)')}
      ${missingInfo.map(warnRow).join('')}` : ''}

    ${!aging.length && !priceDrift.length && !slowMovers30.length && !noPhotos.length && !missingInfo.length
      ? '<tr><td colspan="3" style="padding:24px;text-align:center;color:#16a34a;font-weight:700">✓ No issues — your lot is in great shape!</td></tr>'
      : ''}

  </table>
  </td></tr>

  <tr><td style="background:#f8fafc;padding:14px 24px;border-top:1px solid #e2e8f0">
    <p style="margin:0;font-size:11px;color:#94a3b8">Sent by MarketSync AI Boost · <a href="https://marketsync.link" style="color:${accent}">marketsync.link</a></p>
  </td></tr>

</table>
</td></tr>
</table>
</body></html>`

    const recipient = dealer.ai_manager_email || OWNER_EMAIL
    await resend.emails.send({
      from: EMAIL_FROM,
      to: recipient,
      subject: `Lot Health Report — ${dealerName} — ${new Date().toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric' })}`,
      html: emailHtml
    })

    res.json({ sent: true, recipient })
  })

  // ── Weekly Report — printable HTML (for PDF download) ────────────────────
  app.get('/ai/weekly-report/html', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership associated' })

    const { data: dealer } = await supabaseAdmin
      .from('dealerships')
      .select('ai_boost_active, name')
      .eq('id', req.dealershipId)
      .single()

    const isOwner = (req.user.email || '').toLowerCase() === OWNER_EMAIL
    if (!isOwner && !dealer?.ai_boost_active) return res.status(403).json({ error: 'AI Boost not active' })

    const d = await buildReportData(req.dealershipId)
    const {
      vehicles, vehicleById,
      totalUnits, withPhotos, noPhotos, avgPrice, medianPrice,
      aging, slowMovers30, avgDays,
      priceDrift, missingInfo,
      prevPriceFlagCount,
      newArrivalsThisWeek, newArrivalsPrevWeek,
      soldThisWeekCount, soldPrevWeekCount,
      conditionCount, priceBrackets, daysBrackets, topMakes, crm
    } = d

    const dealerName = dealer.name || 'Your Dealership'
    const primary = '#1a2e4a'
    const accent = '#6366f1'
    const photosPct = totalUnits ? Math.round((withPhotos / totalUnits) * 100) : 0
    const agingPct  = totalUnits ? Math.round((aging.length / totalUnits) * 100) : 0
    const driftPct  = totalUnits ? Math.round((priceDrift.length / totalUnits) * 100) : 0

    const wkDelta = (curr, prev, lowerBetter = false) => {
      const diff = curr - prev
      if (prev === 0 && diff === 0) return ''
      if (diff === 0) return `<div style="font-size:10px;color:#94a3b8">— same as last wk</div>`
      const up = diff > 0; const good = lowerBetter ? !up : up
      return `<div style="font-size:10px;color:${good ? '#16a34a' : '#ef4444'}">${up ? '↑' : '↓'}${Math.abs(diff)} vs last wk</div>`
    }

    const vLabel = v => {
      const name = [v.year, v.make, v.model, v.trim].filter(Boolean).join(' ')
      return v.stocknumber ? `${name} <span style="color:#64748b;font-size:11px">#${v.stocknumber}</span>` : name
    }
    const aLabel = a => {
      const inv = vehicleById[a.inventory_id]
      const sn = inv?.stocknumber
      return sn ? `${a.vehicle_label} <span style="color:#64748b;font-size:11px">#${sn}</span>` : a.vehicle_label
    }

    const sec = (title, cols = 3) => `<tr><td colspan="${cols}" style="background:${primary};color:#fff;font-weight:700;font-size:13px;padding:9px 12px">${title}</td></tr>`
    const note = (text, cols = 3) => `<tr><td colspan="${cols}" style="background:#f1f5f9;color:#475569;font-size:11px;padding:7px 12px;border-bottom:1px solid #e2e8f0;font-style:italic">${text}</td></tr>`

    const agingRow = v => `<tr>
      <td style="padding:7px 12px;border-bottom:1px solid #e2e8f0;font-size:13px">${vLabel(v)}</td>
      <td style="padding:7px 12px;border-bottom:1px solid #e2e8f0;text-align:right;font-size:13px">${v.price ? '$' + Number(v.price).toLocaleString() : '—'}</td>
      <td style="padding:7px 12px;border-bottom:1px solid #e2e8f0;text-align:right;font-size:13px;color:${v.daysOnLot > 90 ? '#ef4444' : '#f59e0b'};font-weight:700">${v.daysOnLot}d</td></tr>`

    const driftRow = a => {
      const pct = a.price_pct_diff; const over = pct > 0
      const fix = over
        ? `Reduce by ~$${Math.round(Math.abs(pct / 100) * (vehicleById[a.inventory_id]?.price || 0)).toLocaleString()}`
        : `Priced below market median — may sell faster or raise to recapture margin`
      return `<tr>
        <td style="padding:7px 12px;border-bottom:1px solid #e2e8f0;font-size:13px">${aLabel(a)}</td>
        <td style="padding:7px 12px;border-bottom:1px solid #e2e8f0;text-align:right;font-size:13px;color:${over ? '#16a34a' : '#ef4444'};font-weight:700">${over ? '+' : ''}${pct}%</td>
        <td style="padding:7px 12px;border-bottom:1px solid #e2e8f0;font-size:11px;color:#64748b">${over ? 'Overpriced' : 'Underpriced'} vs AutoTrader/CarGurus market median. ${fix}</td></tr>`
    }

    const warnRow = a => `<tr>
      <td style="padding:7px 12px;border-bottom:1px solid #e2e8f0;font-size:13px">${aLabel(a)}</td>
      <td colspan="2" style="padding:7px 12px;border-bottom:1px solid #e2e8f0;font-size:12px;color:#b45309">${(a.warnings || []).join(' · ')}</td></tr>`

    const statBox = (label, value, sub, color, delta = '') =>
      `<td width="25%" style="padding:14px;text-align:center;border-right:1px solid #e2e8f0">
        <div style="font-size:24px;font-weight:900;color:${color}">${value}</div>
        <div style="font-size:11px;font-weight:700;color:#475569;margin-top:2px;text-transform:uppercase;letter-spacing:0.05em">${label}</div>
        ${sub ? `<div style="font-size:10px;color:#94a3b8;margin-top:1px">${sub}</div>` : ''}
        ${delta}
      </td>`

    const barRow = (label, count, max, total, color = accent) => {
      const pct = total > 0 ? Math.round((count / total) * 100) : 0
      const barW = max > 0 ? Math.round((count / max) * 200) : 0
      return `<tr>
        <td style="padding:3px 10px;font-size:12px;color:#334155;width:110px;white-space:nowrap">${label}</td>
        <td style="padding:3px 6px"><div style="background:#e2e8f0;border-radius:4px;height:13px;width:210px"><div style="background:${color};border-radius:4px;height:13px;width:${barW}px"></div></div></td>
        <td style="padding:3px 6px;font-size:11px;color:#64748b;white-space:nowrap">${count} (${pct}%)</td></tr>`
    }

    const maxCondition = Math.max(conditionCount.new, conditionCount.used, conditionCount.demo, 1)
    const maxPriceBracket = Math.max(...priceBrackets.map(b => b.count), 1)
    const maxDaysBracket = Math.max(...daysBrackets.map(b => b.count), 1)
    const maxMakeCount = topMakes[0]?.[1] || 1
    const dateStr = new Date().toLocaleDateString('en-CA', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })

    const printHtml = `<!DOCTYPE html><html><head><meta charset="utf-8">
<title>Lot Health Report — ${dateStr}</title>
<style>
  @media print { .no-print { display:none !important; } @page { margin:0.75in; } }
  body { margin:0; padding:0; background:#f8fafc; font-family:Arial,sans-serif; }
  .no-print { display:flex; justify-content:flex-end; gap:10px; padding:16px 24px; background:#fff; border-bottom:1px solid #e2e8f0; }
  .no-print button { padding:8px 18px; border-radius:6px; border:none; cursor:pointer; font-weight:700; font-size:13px; }
  .btn-print { background:${primary}; color:#fff; }
  .btn-close { background:#f1f5f9; color:#334155; }
</style>
</head><body>
<div class="no-print">
  <button class="btn-close" onclick="window.close()">✕ Close</button>
  <button class="btn-print" onclick="window.print()">🖨 Print / Save as PDF</button>
</div>
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;padding:24px 0">
<tr><td align="center">
<table width="760" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:10px;overflow:hidden;border:1px solid #e2e8f0">

  <!-- Header -->
  <tr><td style="background:${primary};padding:22px 28px">
    <div style="color:#fff;font-size:22px;font-weight:900">${dealerName}</div>
    <div style="color:#94a3b8;font-size:13px;margin-top:3px">Weekly Lot Health Report</div>
    <div style="color:#e2e8f0;font-size:15px;font-weight:700;margin-top:6px">${dateStr}</div>
  </td></tr>

  <!-- Row 1: core stats -->
  <tr><td style="padding:0">
    <table width="100%" cellpadding="0" cellspacing="0" style="border-bottom:1px solid #e2e8f0"><tr>
      ${statBox('Total Inventory', totalUnits, 'all available units', '#1a2e4a')}
      ${statBox('New Units', conditionCount.new, `${totalUnits ? Math.round(conditionCount.new/totalUnits*100) : 0}% of lot`, '#0ea5e9')}
      ${statBox('Used Units', conditionCount.used, `${totalUnits ? Math.round(conditionCount.used/totalUnits*100) : 0}% of lot`, '#6366f1')}
      ${statBox('Demo Units', conditionCount.demo, `${totalUnits ? Math.round(conditionCount.demo/totalUnits*100) : 0}% of lot`, '#f59e0b')}
    </tr></table>
  </td></tr>

  <!-- Row 2: core stats -->
  <tr><td style="padding:0">
    <table width="100%" cellpadding="0" cellspacing="0" style="border-bottom:1px solid #e2e8f0"><tr>
      ${statBox('Photos', `${photosPct}%`, `${withPhotos} of ${totalUnits} have photos`, photosPct < 80 ? '#ef4444' : '#16a34a')}
      ${statBox('Avg Days on Lot', avgDays, agingPct > 0 ? `${agingPct}% aging 60d+` : 'healthy turnover', avgDays > 45 ? '#f59e0b' : '#16a34a')}
      ${statBox('Price Flags', priceDrift.length, `${driftPct}% of lot (used)`, priceDrift.length > 0 ? '#ef4444' : '#16a34a', wkDelta(priceDrift.length, prevPriceFlagCount, true))}
      ${statBox('No Photos', noPhotos.length, `${noPhotos.length} listings missing`, noPhotos.length > 0 ? '#ef4444' : '#16a34a')}
    </tr></table>
  </td></tr>

  <!-- Row 3: weekly activity -->
  <tr><td style="padding:0">
    <table width="100%" cellpadding="0" cellspacing="0" style="border-bottom:1px solid #e2e8f0"><tr>
      ${statBox('New Arrivals', newArrivalsThisWeek, 'added this week', '#6366f1', wkDelta(newArrivalsThisWeek, newArrivalsPrevWeek))}
      ${statBox('Sold This Week', soldThisWeekCount, 'units sold last 7 days', soldThisWeekCount > 0 ? '#16a34a' : '#94a3b8', wkDelta(soldThisWeekCount, soldPrevWeekCount))}
      ${statBox('60d+ Aging', aging.length, `${agingPct}% of lot`, aging.length > 0 ? '#f59e0b' : '#16a34a')}
      ${statBox('Avg Ask Price', avgPrice ? '$' + avgPrice.toLocaleString() : '—', medianPrice ? `median $${medianPrice.toLocaleString()}` : '', '#334155')}
    </tr></table>
  </td></tr>

  <!-- Row 4: sales & CRM this week -->
  ${sec('Sales &amp; CRM — this week', 1)}
  <tr><td style="padding:0">
    <table width="100%" cellpadding="0" cellspacing="0" style="border-bottom:1px solid #e2e8f0"><tr>
      ${statBox('New Leads', crm.leadsWk, 'captured this week', '#6366f1', wkDelta(crm.leadsWk, crm.leadsPrev))}
      ${statBox('Deals Sold', crm.dealsWk, crm.revenueWk ? '$' + crm.revenueWk.toLocaleString() + ' revenue' : 'this week', crm.dealsWk > 0 ? '#16a34a' : '#94a3b8', wkDelta(crm.dealsWk, crm.dealsPrev))}
      ${statBox('Appointments', crm.apptsWk, crm.apptShowRate != null ? `${crm.apptShowRate}% show-rate` : 'booked this week', '#0ea5e9', wkDelta(crm.apptsWk, crm.apptsPrev))}
      ${statBox('Docs Signed', crm.esignSignedWk, `${crm.esignSentWk} sent this week`, crm.esignSignedWk > 0 ? '#16a34a' : '#94a3b8')}
    </tr></table>
  </td></tr>

  <!-- Charts -->
  <tr><td style="padding:16px 24px 8px">
    <table width="100%" cellpadding="0" cellspacing="0"><tr valign="top">

      <!-- Inventory by make -->
      <td width="50%" style="padding-right:14px">
        <div style="font-size:12px;font-weight:700;color:${primary};margin-bottom:6px">Inventory by Make</div>
        <table cellpadding="0" cellspacing="0">
          ${topMakes.map(([make, cnt]) => barRow(make, cnt, maxMakeCount, totalUnits)).join('')}
        </table>
        <div style="font-size:10px;color:#94a3b8;margin-top:4px">Avg $${avgPrice?.toLocaleString() ?? '—'} · Median $${medianPrice?.toLocaleString() ?? '—'}</div>
      </td>

      <!-- Condition mix -->
      <td width="50%" style="padding-left:14px;border-left:1px solid #e2e8f0">
        <div style="font-size:12px;font-weight:700;color:${primary};margin-bottom:6px">Condition Mix</div>
        <table cellpadding="0" cellspacing="0">
          ${barRow('New', conditionCount.new, maxCondition, totalUnits, '#16a34a')}
          ${barRow('Used', conditionCount.used, maxCondition, totalUnits, '#6366f1')}
          ${barRow('Demo', conditionCount.demo, maxCondition, totalUnits, '#f59e0b')}
        </table>
      </td>
    </tr></table>
  </td></tr>

  <tr><td style="padding:8px 24px 16px;border-top:1px solid #f1f5f9">
    <table width="100%" cellpadding="0" cellspacing="0"><tr valign="top">

      <!-- Price distribution -->
      <td width="50%" style="padding-right:14px">
        <div style="font-size:12px;font-weight:700;color:${primary};margin-bottom:6px">Price Distribution</div>
        <table cellpadding="0" cellspacing="0">
          ${priceBrackets.map(b => barRow(b.label, b.count, maxPriceBracket, totalUnits, '#0ea5e9')).join('')}
        </table>
      </td>

      <!-- Days on lot -->
      <td width="50%" style="padding-left:14px;border-left:1px solid #e2e8f0">
        <div style="font-size:12px;font-weight:700;color:${primary};margin-bottom:6px">Days on Lot</div>
        <table cellpadding="0" cellspacing="0">
          ${daysBrackets.map((b, i) => barRow(b.label, b.count, maxDaysBracket, totalUnits, ['#16a34a','#6366f1','#f59e0b','#ef4444'][i])).join('')}
        </table>
      </td>
    </tr></table>
  </td></tr>

  <tr><td style="padding:0 28px 20px">
  <table width="100%" cellpadding="0" cellspacing="0" style="font-size:13px">
    ${priceDrift.length ? `
      ${sec('💰 Price Drift Flags — Used Vehicles Only (' + priceDrift.length + ')')}
      ${note('Price drift = asking price vs. the median of similar make/model used units on your lot. Positive = overpriced vs your own inventory (may slow sale). Negative = underpriced (may leave margin). New vehicles are excluded.')}
      <tr style="background:#f8fafc"><td style="padding:5px 12px;font-size:11px;font-weight:700;color:#64748b">VEHICLE</td><td style="padding:5px 12px;font-size:11px;font-weight:700;color:#64748b;text-align:right">DRIFT</td><td style="padding:5px 12px;font-size:11px;font-weight:700;color:#64748b">RECOMMENDATION</td></tr>
      ${priceDrift.map(driftRow).join('')}` : ''}
    ${aging.length ? `
      ${sec('⏱ Aging Units — 60+ Days on Lot (' + aging.length + ')')}
      ${note('Over 60 days. Consider a price reduction, additional marketing, or trade-in push. 90d+ shown in red.')}
      <tr style="background:#f8fafc"><td style="padding:5px 12px;font-size:11px;font-weight:700;color:#64748b">VEHICLE</td><td style="padding:5px 12px;font-size:11px;font-weight:700;color:#64748b;text-align:right">PRICE</td><td style="padding:5px 12px;font-size:11px;font-weight:700;color:#64748b;text-align:right">DAYS</td></tr>
      ${aging.map(agingRow).join('')}` : ''}
    ${slowMovers30.length ? `
      ${sec('🐢 Watch List — 30–60 Days on Lot (' + slowMovers30.length + ')')}
      ${note('Approaching the aging threshold. A small price move now is better than a larger one at 60 days.')}
      ${slowMovers30.map(agingRow).join('')}` : ''}
    ${noPhotos.length ? `
      ${sec('📷 No Photos — All Vehicles (' + noPhotos.length + ')')}
      ${note('Listings without photos get significantly fewer clicks. Upload through your DMS or directly in MarketSync.')}
      <tr style="background:#f8fafc"><td colspan="3" style="padding:5px 12px;font-size:11px;font-weight:700;color:#64748b">VEHICLE</td></tr>
      ${noPhotos.map(v => `<tr><td colspan="3" style="padding:7px 12px;border-bottom:1px solid #e2e8f0;font-size:13px">${vLabel(v)}</td></tr>`).join('')}` : ''}
    ${missingInfo.length ? `
      ${sec('⚠ Other Missing Info (' + missingInfo.length + ' flags)')}
      ${missingInfo.map(warnRow).join('')}` : ''}
    ${!aging.length && !priceDrift.length && !slowMovers30.length && !noPhotos.length && !missingInfo.length
      ? '<tr><td colspan="3" style="padding:24px;text-align:center;color:#16a34a;font-weight:700">✓ No issues — your lot is in great shape!</td></tr>' : ''}
  </table>
  </td></tr>
  <tr><td style="background:#f8fafc;padding:14px 28px;border-top:1px solid #e2e8f0">
    <p style="margin:0;font-size:11px;color:#94a3b8">Generated by MarketSync AI Boost · marketsync.link</p>
  </td></tr>
</table></td></tr></table>
</body></html>`

    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.send(printHtml)
  })

  // ── Cron: expire the 30-day full-access onboarding ───────────────────────
  // Backstop for the lazy expiry in /ai/config (covers dealers not logged in).
  // Drops each expired dealer's add-ons to what they actually paid for.
  //   Schedule: daily, e.g. 0 8 * * *
  //   curl -X POST https://<your-render-url>/cron/expire-full-access -H "x-cron-secret: $CRON_SECRET"
  app.post('/cron/expire-full-access', async (req, res) => {
    if ((req.headers['x-cron-secret'] || '').trim() !== (process.env.CRON_SECRET || '').trim()) {
      return res.status(401).json({ error: 'Unauthorized' })
    }
    try {
      const { data } = await supabaseAdmin.from('dealerships')
        .select('id, ai_boost_paid, inv_intel_paid')
        .not('full_access_until', 'is', null)
        .lt('full_access_until', new Date().toISOString())
      let expired = 0
      for (const d of (data || [])) {
        await supabaseAdmin.from('dealerships').update({
          ai_boost_active: !!d.ai_boost_paid,
          inv_intel_active: !!d.inv_intel_paid,
          full_access_until: null,
        }).eq('id', d.id)
        expired++
      }
      res.json({ ok: true, expired })
    } catch (e) { res.status(500).json({ error: e.message }) }
  })

  // ── Cron: auto-send weekly health reports every Sunday night ─────────────
  // Protected by CRON_SECRET header. Set up as a Render Cron Job:
  //   Schedule: 59 3 * * 1   (Sunday 11:59pm ET = Monday 3:59am UTC)
  //   Command:  curl -X POST https://<your-render-url>/cron/weekly-reports \
  //               -H "x-cron-secret: $CRON_SECRET"
  app.post('/cron/weekly-reports', async (req, res) => {
    if ((req.headers['x-cron-secret'] || '').trim() !== (process.env.CRON_SECRET || '').trim()) {
      return res.status(401).json({ error: 'Unauthorized' })
    }

    // Find all dealerships with AI Boost active and an email configured
    const { data: dealers } = await supabaseAdmin
      .from('dealerships')
      .select('id, name, ai_boost_active, ai_manager_email')
      .eq('ai_boost_active', true)
      .not('ai_manager_email', 'is', null)

    let sent = 0; let failed = 0
    for (const dealer of dealers || []) {
      try {
        const d = await buildReportData(dealer.id)
        const {
          vehicles, vehicleById,
          totalUnits, withPhotos, noPhotos, avgPrice, medianPrice,
          aging, slowMovers30, avgDays,
          priceDrift, missingInfo,
          prevPriceFlagCount,
          newArrivalsThisWeek, newArrivalsPrevWeek,
          soldThisWeekCount, soldPrevWeekCount,
          conditionCount, priceBrackets, daysBrackets, topMakes
        } = d

        const primary = '#1a2e4a'; const accent = '#6366f1'
        const photosPct = totalUnits ? Math.round((withPhotos / totalUnits) * 100) : 0
        const agingPct  = totalUnits ? Math.round((aging.length / totalUnits) * 100) : 0
        const driftPct  = totalUnits ? Math.round((priceDrift.length / totalUnits) * 100) : 0

        const wkDelta = (curr, prev, lowerBetter = false) => {
          const diff = curr - prev
          if (prev === 0 && diff === 0) return ''
          if (diff === 0) return `<div style="font-size:10px;color:#94a3b8">— same as last wk</div>`
          const up = diff > 0; const good = lowerBetter ? !up : up
          return `<div style="font-size:10px;color:${good ? '#16a34a' : '#ef4444'}">${up ? '↑' : '↓'}${Math.abs(diff)} vs last wk</div>`
        }
        const vLabel = v => {
          const name = [v.year, v.make, v.model, v.trim].filter(Boolean).join(' ')
          return v.stocknumber ? `${name} <span style="color:#64748b;font-size:11px">#${v.stocknumber}</span>` : name
        }
        const aLabel = a => {
          const inv = vehicleById[a.inventory_id]; const sn = inv?.stocknumber
          return sn ? `${a.vehicle_label} <span style="color:#64748b;font-size:11px">#${sn}</span>` : a.vehicle_label
        }
        const statBox = (label, value, sub, color, delta = '') =>
          `<td width="25%" style="padding:12px;text-align:center;border-right:1px solid #e2e8f0">
            <div style="font-size:22px;font-weight:900;color:${color}">${value}</div>
            <div style="font-size:11px;font-weight:700;color:#475569;margin-top:2px;text-transform:uppercase;letter-spacing:0.05em">${label}</div>
            ${sub ? `<div style="font-size:10px;color:#94a3b8;margin-top:1px">${sub}</div>` : ''}${delta}
          </td>`
        const barRow = (label, count, max, total, color = accent) => {
          const pct = total > 0 ? Math.round((count / total) * 100) : 0
          const barW = max > 0 ? Math.round((count / max) * 180) : 0
          return `<tr>
            <td style="padding:3px 10px;font-size:12px;color:#334155;width:110px;white-space:nowrap">${label}</td>
            <td style="padding:3px 6px"><div style="background:#e2e8f0;border-radius:4px;height:13px;width:190px"><div style="background:${color};border-radius:4px;height:13px;width:${barW}px"></div></div></td>
            <td style="padding:3px 6px;font-size:11px;color:#64748b;white-space:nowrap">${count} (${pct}%)</td></tr>`
        }
        const sectionHeader = (title, cols = 3) =>
          `<tr><td colspan="${cols}" style="background:${primary};color:#fff;font-weight:700;font-size:13px;padding:9px 12px">${title}</td></tr>`
        const subNote = (text, cols = 3) =>
          `<tr><td colspan="${cols}" style="background:#f1f5f9;color:#475569;font-size:11px;padding:7px 12px;border-bottom:1px solid #e2e8f0;font-style:italic">${text}</td></tr>`
        const agingRow = v =>
          `<tr><td style="padding:7px 12px;border-bottom:1px solid #e2e8f0;font-size:13px">${vLabel(v)}</td>
           <td style="padding:7px 12px;border-bottom:1px solid #e2e8f0;text-align:right;font-size:13px">${v.price ? '$' + Number(v.price).toLocaleString() : '—'}</td>
           <td style="padding:7px 12px;border-bottom:1px solid #e2e8f0;text-align:right;font-size:13px;color:${v.daysOnLot > 90 ? '#ef4444' : '#f59e0b'};font-weight:700">${v.daysOnLot}d</td></tr>`
        const driftRow = a => {
          const pct = a.price_pct_diff; const over = pct > 0
          const fix = over
            ? `Consider reducing by $${Math.round(Math.abs(pct / 100) * (vehicleById[a.inventory_id]?.price || 0)).toLocaleString()} to align with market`
            : `May sell faster at current price — or raise to recapture margin`
          return `<tr>
            <td style="padding:7px 12px;border-bottom:1px solid #e2e8f0;font-size:13px">${aLabel(a)}</td>
            <td style="padding:7px 12px;border-bottom:1px solid #e2e8f0;text-align:right;font-size:13px;color:${over ? '#16a34a' : '#ef4444'};font-weight:700">${over ? '+' : ''}${pct}%</td>
            <td style="padding:7px 12px;border-bottom:1px solid #e2e8f0;font-size:11px;color:#64748b">${over ? 'Overpriced' : 'Underpriced'} vs AutoTrader/CarGurus market median. ${fix}</td></tr>`
        }
        const warnRow = a =>
          `<tr><td style="padding:7px 12px;border-bottom:1px solid #e2e8f0;font-size:13px">${aLabel(a)}</td>
           <td colspan="2" style="padding:7px 12px;border-bottom:1px solid #e2e8f0;font-size:12px;color:#b45309">${(a.warnings || []).join(' · ')}</td></tr>`

        const maxCondition = Math.max(conditionCount.new, conditionCount.used, conditionCount.demo, 1)
        const maxPriceBracket = Math.max(...priceBrackets.map(b => b.count), 1)
        const maxDaysBracket  = Math.max(...daysBrackets.map(b => b.count), 1)
        const maxMakeCount = topMakes[0]?.[1] || 1
        const dateStr = new Date().toLocaleDateString('en-CA', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })

        const emailHtml = `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>body{margin:0;padding:0;background:#f8fafc;font-family:Arial,sans-serif}</style>
</head><body>
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;padding:24px 0">
<tr><td align="center">
<table width="660" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:10px;overflow:hidden;border:1px solid #e2e8f0">
  <tr><td style="background:${primary};padding:22px 24px">
    <div style="color:#fff;font-size:22px;font-weight:900">${dealer.name}</div>
    <div style="color:#94a3b8;font-size:13px;margin-top:3px">Weekly Lot Health Report</div>
    <div style="color:#e2e8f0;font-size:15px;font-weight:700;margin-top:6px">${dateStr}</div>
  </td></tr>
  <tr><td style="padding:0"><table width="100%" cellpadding="0" cellspacing="0" style="border-bottom:1px solid #e2e8f0"><tr>
    ${statBox('Total Inventory', totalUnits, 'all available units', '#1a2e4a')}
    ${statBox('New Units', conditionCount.new, `${totalUnits ? Math.round(conditionCount.new/totalUnits*100) : 0}% of lot`, '#0ea5e9')}
    ${statBox('Used Units', conditionCount.used, `${totalUnits ? Math.round(conditionCount.used/totalUnits*100) : 0}% of lot`, '#6366f1')}
    ${statBox('Demo Units', conditionCount.demo, `${totalUnits ? Math.round(conditionCount.demo/totalUnits*100) : 0}% of lot`, '#f59e0b')}
  </tr></table></td></tr>
  <tr><td style="padding:0"><table width="100%" cellpadding="0" cellspacing="0" style="border-bottom:1px solid #e2e8f0"><tr>
    ${statBox('Photos', `${photosPct}%`, `${withPhotos} of ${totalUnits} have photos`, photosPct < 80 ? '#ef4444' : '#16a34a')}
    ${statBox('Avg Days on Lot', avgDays, agingPct > 0 ? `${agingPct}% aging 60d+` : 'healthy turnover', avgDays > 45 ? '#f59e0b' : '#16a34a')}
    ${statBox('Price Flags', priceDrift.length, `${driftPct}% of lot (used)`, priceDrift.length > 0 ? '#ef4444' : '#16a34a', wkDelta(priceDrift.length, prevPriceFlagCount, true))}
    ${statBox('No Photos', noPhotos.length, `${noPhotos.length} listings missing`, noPhotos.length > 0 ? '#ef4444' : '#16a34a')}
  </tr></table></td></tr>
  <tr><td style="padding:0"><table width="100%" cellpadding="0" cellspacing="0" style="border-bottom:1px solid #e2e8f0"><tr>
    ${statBox('New Arrivals', newArrivalsThisWeek, 'added this week', '#6366f1', wkDelta(newArrivalsThisWeek, newArrivalsPrevWeek))}
    ${statBox('Sold This Week', soldThisWeekCount, 'units sold last 7 days', soldThisWeekCount > 0 ? '#16a34a' : '#94a3b8', wkDelta(soldThisWeekCount, soldPrevWeekCount))}
    ${statBox('60d+ Aging', aging.length, `${agingPct}% of lot`, aging.length > 0 ? '#f59e0b' : '#16a34a')}
    ${statBox('Avg Ask Price', avgPrice ? '$' + avgPrice.toLocaleString() : '—', medianPrice ? `median $${medianPrice.toLocaleString()}` : '', '#334155')}
  </tr></table></td></tr>
  <tr><td style="padding:14px 20px 8px">
    <table width="100%" cellpadding="0" cellspacing="0"><tr valign="top">
      <td width="50%" style="padding-right:12px">
        <div style="font-size:12px;font-weight:700;color:${primary};margin-bottom:6px">Inventory by Make</div>
        <table cellpadding="0" cellspacing="0">${topMakes.map(([make, cnt]) => barRow(make, cnt, maxMakeCount, totalUnits)).join('')}</table>
        <div style="font-size:10px;color:#94a3b8;margin-top:4px">Avg $${avgPrice?.toLocaleString() ?? '—'} · Median $${medianPrice?.toLocaleString() ?? '—'}</div>
      </td>
      <td width="50%" style="padding-left:12px;border-left:1px solid #e2e8f0">
        <div style="font-size:12px;font-weight:700;color:${primary};margin-bottom:6px">Condition Mix</div>
        <table cellpadding="0" cellspacing="0">
          ${barRow('New', conditionCount.new, maxCondition, totalUnits, '#16a34a')}
          ${barRow('Used', conditionCount.used, maxCondition, totalUnits, '#6366f1')}
          ${barRow('Demo', conditionCount.demo, maxCondition, totalUnits, '#f59e0b')}
        </table>
      </td>
    </tr></table>
  </td></tr>
  <tr><td style="padding:8px 20px 14px;border-top:1px solid #f1f5f9">
    <table width="100%" cellpadding="0" cellspacing="0"><tr valign="top">
      <td width="50%" style="padding-right:12px">
        <div style="font-size:12px;font-weight:700;color:${primary};margin-bottom:6px">Price Distribution</div>
        <table cellpadding="0" cellspacing="0">${priceBrackets.map(b => barRow(b.label, b.count, maxPriceBracket, totalUnits, '#0ea5e9')).join('')}</table>
      </td>
      <td width="50%" style="padding-left:12px;border-left:1px solid #e2e8f0">
        <div style="font-size:12px;font-weight:700;color:${primary};margin-bottom:6px">Days on Lot</div>
        <table cellpadding="0" cellspacing="0">${daysBrackets.map((b, i) => barRow(b.label, b.count, maxDaysBracket, totalUnits, ['#16a34a','#6366f1','#f59e0b','#ef4444'][i])).join('')}</table>
      </td>
    </tr></table>
  </td></tr>
  <tr><td style="padding:0 24px 16px"><table width="100%" cellpadding="0" cellspacing="0" style="font-size:13px">
    ${priceDrift.length ? `
      ${sectionHeader('💰 Price Drift Flags — Used Vehicles Only (' + priceDrift.length + ')')}
      ${subNote('Price drift = this vehicle\'s asking price vs. the median of similar make/model used units on your own lot. Negative = underpriced. Positive = overpriced. New vehicles excluded.')}
      <tr style="background:#f8fafc"><td style="padding:5px 12px;font-size:11px;font-weight:700;color:#64748b">VEHICLE</td><td style="padding:5px 12px;font-size:11px;font-weight:700;color:#64748b;text-align:right">DRIFT</td><td style="padding:5px 12px;font-size:11px;font-weight:700;color:#64748b">RECOMMENDATION</td></tr>
      ${priceDrift.map(driftRow).join('')}` : ''}
    ${aging.length ? `
      ${sectionHeader('⏱ Aging Units — 60+ Days on Lot (' + aging.length + ')')}
      ${subNote('Over 60 days. Consider a price reduction, additional marketing, or trade-in push. 90d+ shown in red.')}
      <tr style="background:#f8fafc"><td style="padding:5px 12px;font-size:11px;font-weight:700;color:#64748b">VEHICLE</td><td style="padding:5px 12px;font-size:11px;font-weight:700;color:#64748b;text-align:right">PRICE</td><td style="padding:5px 12px;font-size:11px;font-weight:700;color:#64748b;text-align:right">DAYS</td></tr>
      ${aging.map(agingRow).join('')}` : ''}
    ${slowMovers30.length ? `
      ${sectionHeader('🐢 Watch List — 30–60 Days on Lot (' + slowMovers30.length + ')')}
      ${subNote('Approaching the aging threshold. A small price move now is better than a larger one at 60 days.')}
      ${slowMovers30.map(agingRow).join('')}` : ''}
    ${noPhotos.length ? `
      ${sectionHeader('📷 No Photos — All Vehicles (' + noPhotos.length + ')')}
      ${subNote('Listings without photos get significantly fewer clicks. Upload through your DMS or directly in MarketSync.')}
      <tr style="background:#f8fafc"><td colspan="3" style="padding:5px 12px;font-size:11px;font-weight:700;color:#64748b">VEHICLE</td></tr>
      ${noPhotos.map(v => `<tr><td colspan="3" style="padding:7px 12px;border-bottom:1px solid #e2e8f0;font-size:13px">${vLabel(v)}</td></tr>`).join('')}` : ''}
    ${missingInfo.length ? `
      ${sectionHeader('⚠ Other Missing Info (' + missingInfo.length + ' flags)')}
      ${missingInfo.map(warnRow).join('')}` : ''}
    ${!aging.length && !priceDrift.length && !slowMovers30.length && !noPhotos.length && !missingInfo.length
      ? '<tr><td colspan="3" style="padding:24px;text-align:center;color:#16a34a;font-weight:700">✓ No issues — your lot is in great shape!</td></tr>' : ''}
  </table></td></tr>
  <tr><td style="background:#f8fafc;padding:14px 24px;border-top:1px solid #e2e8f0">
    <p style="margin:0;font-size:11px;color:#94a3b8">Sent automatically by MarketSync AI Boost · <a href="https://marketsync.link" style="color:${accent}">marketsync.link</a></p>
  </td></tr>
</table></td></tr></table></body></html>`

        await resend.emails.send({
          from: EMAIL_FROM,
          to: dealer.ai_manager_email,
          subject: `Lot Health Report — ${dealer.name} — ${new Date().toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric' })}`,
          html: emailHtml,
        })

        // Notify that the weekly report was sent
        await createNotification({
          dealershipId: dealer.id,
          type: 'weekly_report',
          title: 'Weekly Lot Health Report Sent',
          body: `Your weekly lot health report has been sent to ${dealer.ai_manager_email}`,
          linkPage: 'ai-boost',
        }).catch(() => {})

        // Write in-app notifications for this dealer's most pressing issues
        const notifRows = []
        if (d.aging?.length) {
          notifRows.push({
            dealership_id: dealer.id,
            type: 'aging',
            title: `${d.aging.length} unit${d.aging.length > 1 ? 's' : ''} aging 60+ days`,
            body: `${d.aging.slice(0, 3).map(v => v.stock_number || v.vin?.slice(-6) || 'Unit').join(', ')}${d.aging.length > 3 ? ` +${d.aging.length - 3} more` : ''} — consider a price reduction.`,
            link_page: 'inventory',
            link_filter: null,
            read: false,
          })
        }
        if (d.priceDrift?.length) {
          notifRows.push({
            dealership_id: dealer.id,
            type: 'price_drift',
            title: `${d.priceDrift.length} price drift flag${d.priceDrift.length > 1 ? 's' : ''}`,
            body: `${d.priceDrift.length} used unit${d.priceDrift.length > 1 ? 's are' : ' is'} significantly over or under the lot median.`,
            link_page: 'inventory',
            link_filter: null,
            read: false,
          })
        }
        if (d.noPhotos?.length) {
          notifRows.push({
            dealership_id: dealer.id,
            type: 'missing_info',
            title: `${d.noPhotos.length} listing${d.noPhotos.length > 1 ? 's' : ''} without photos`,
            body: 'Listings without photos get significantly fewer clicks. Upload through your DMS.',
            link_page: 'inventory',
            link_filter: null,
            read: false,
          })
        }
        notifRows.push({
          dealership_id: dealer.id,
          type: 'weekly_report',
          title: 'Weekly lot health report sent',
          body: `${d.totalUnits} units · ${d.withPhotos} with photos · ${d.newArrivalsThisWeek} new arrivals this week.`,
          link_page: 'ai-boost',
          link_filter: null,
          read: false,
        })
        await createNotifications(notifRows)

        sent++
      } catch (err) {
        console.error(`Weekly report failed for dealer ${dealer.id}:`, err.message)
        failed++
      }
    }

    res.json({ sent, failed, total: (dealers || []).length })
  })

  // ── Daily digest email ────────────────────────────────────────────────
  // Sends each dealer a "Today's Briefing" of action items on their lot. Only
  // emails when there's something to act on (never a daily empty digest).
  // Protected by CRON_SECRET. Set up as a Render Cron Job (e.g. 7am weekdays):
  //   Schedule: 0 12 * * 1-5   (12:00 UTC ≈ 7–8am ET)
  //   Command:  curl -X POST https://<your-render-url>/cron/daily-digest \
  //               -H "x-cron-secret: $CRON_SECRET"
  app.post('/cron/daily-digest', async (req, res) => {
    if ((req.headers['x-cron-secret'] || '').trim() !== (process.env.CRON_SECRET || '').trim()) {
      return res.status(401).json({ error: 'unauthorized' })
    }
    if (!resend) return res.json({ sent: 0, note: 'email not configured' })

    const { data: dealers } = await supabaseAdmin.from('dealerships')
      .select('id, name, ai_manager_email, inv_intel_active, ai_boost_active, daily_digest_enabled')
      .not('ai_manager_email', 'is', null)

    const esc = s => String(s ?? '').replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))
    let sent = 0, failed = 0
    for (const d of (dealers || [])) {
      try {
        // Respect the dealer's opt-out, and only for add-on subscribers.
        if (d.daily_digest_enabled === false) continue
        if (!d.inv_intel_active && !d.ai_boost_active) continue
        const digest = await computeDailyDigest(d.id, false)
        if (!digest.items.length) continue  // nothing actionable — don't send

        const itemsHtml = digest.items
          .map(i => `<li style="margin:6px 0;font-size:14px;color:#334155">${i.icon} ${esc(i.text)}</li>`).join('')
        await resend.emails.send({
          from: EMAIL_FROM,
          to: d.ai_manager_email,
          subject: `Today's briefing — ${digest.items.length} item${digest.items.length > 1 ? 's' : ''} on your lot`,
          html: `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px">
            <h2 style="margin:0 0 6px;color:#0f172a">Today's Briefing</h2>
            <div style="font-size:12px;color:#94a3b8;margin-bottom:14px">${esc(d.name || '')} · ${esc(digest.date)}</div>
            <p style="font-size:15px;color:#0f172a;line-height:1.5;margin:0 0 14px">${esc(digest.summary || '')}</p>
            <ul style="list-style:none;padding:0;margin:0 0 20px">${itemsHtml}</ul>
            <a href="${FRONTEND_URL}/dashboard.html" style="display:inline-block;background:#4f46e5;color:#fff;font-weight:700;font-size:14px;text-decoration:none;padding:10px 18px;border-radius:8px">Open your dashboard →</a>
            <p style="font-size:11px;color:#94a3b8;margin-top:22px">You're getting this because you're set as the alert email on MarketSync. It only sends on days there's something to act on.</p>
          </div>`,
        })
        sent++
      } catch (e) {
        console.error(`Daily digest failed for dealer ${d.id}:`, e.message)
        failed++
      }
    }
    res.json({ sent, failed, total: (dealers || []).length })
  })

  // GET /ai/market-snapshot — live listing count, median price and days-on-market
  // for a make/model (recipe 05). Inventory Intelligence add-on; one metered +
  // daily-capped MarketCheck call. Owner exempt from the per-dealer caps.
  app.get('/ai/market-snapshot', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership associated' })
    const isOwner = (req.user.email || '').toLowerCase() === OWNER_EMAIL
    const { data: dealer } = await supabaseAdmin
      .from('dealerships').select('inv_intel_active, country').eq('id', req.dealershipId).maybeSingle()
    if (!isOwner && !dealer?.inv_intel_active) return res.status(403).json({ error: 'Inventory Intelligence add-on required' })
    if (!marketcheckEnabled()) return res.status(503).json({ error: 'Live market data is not configured.' })
    const make = String(req.query.make || '').trim()
    const model = String(req.query.model || '').trim()
    if (!make || !model) return res.status(400).json({ error: 'make and model are required' })
    if (!(await marketcheckAllowed(req.dealershipId, isOwner))) {
      return res.status(429).json({ error: 'Market-data lookup limit reached — try again later.' })
    }
    const isUS = /^(us|usa|united states)$/i.test((dealer?.country || '').trim())
    const year = req.query.year ? Number(req.query.year) : undefined
    const trim = req.query.trim ? String(req.query.trim).trim() : undefined
    try {
      const snap = await marketcheckMarketStats({ make, model, year, trim, isUS })
      await recordMarketcheckCall(req.dealershipId)
      if (!snap) return res.json({ ok: true, found: false })
      res.json({ ok: true, found: true, make, model, year: year || null, trim: trim || null, currency: isUS ? 'USD' : 'CAD', ...snap })
    } catch (e) {
      res.status(502).json({ error: 'Market snapshot failed — the data service may be busy.' })
    }
  })

  // ── AI Assistant dock ────────────────────────────────────────────────────
  // The floating "Ask MarketSync" chat. Answers questions grounded in the
  // dealer's live lot/leads snapshot. Paid feature (AI Boost or Inventory
  // Intelligence; owner exempt) and metered through the same cost layer as
  // every other AI call so it can't run past the budget kill-switch.
  app.post('/ai/assistant', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership associated' })
    const isOwner = (req.user.email || '').toLowerCase() === OWNER_EMAIL

    const { data: dealer } = await supabaseAdmin
      .from('dealerships')
      .select('name, ai_boost_active, inv_intel_active, city, province, country, ai_internal_style, ai_knowledge, ai_knowledge_name')
      .eq('id', req.dealershipId).maybeSingle()

    const entitled = isOwner || !!dealer?.ai_boost_active || !!dealer?.inv_intel_active
    if (!entitled) return res.status(403).json({ error: 'The AI assistant needs AI Boost or Inventory Intelligence.' })
    if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ error: 'AI is not configured.' })
    if (!(await aiAllowed(req.dealershipId, isOwner))) {
      return res.status(429).json({ error: 'AI usage limit reached for this month.' })
    }
    if (!(await assistantDailyAllowed(req.dealershipId, isOwner))) {
      return res.status(429).json({ error: `You've hit today's limit of ${ASSISTANT_DAILY_LIMIT} assistant questions. It resets tomorrow.` })
    }

    // Sanitise the client-sent transcript: only user/assistant turns, trimmed,
    // capped to the last 10 so the context can't balloon.
    const raw = Array.isArray(req.body?.messages) ? req.body.messages : []
    const messages = raw
      .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
      .slice(-10)
      .map(m => ({ role: m.role, content: m.content.trim().slice(0, 2000) }))
    if (!messages.length || messages[messages.length - 1].role !== 'user') {
      return res.status(400).json({ error: 'Send a question.' })
    }

    // Live snapshot the model answers from.
    const now = Date.now()
    const { data: inv } = await supabaseAdmin.from('inventory')
      .select('price, mileage, year, make, model, image_urls, photo_score, created_at, lot_date')
      .eq('dealership_id', req.dealershipId).eq('status', 'available')
    const list = inv || []
    const total = list.length
    const photoCount = v => Array.isArray(v.image_urls) ? v.image_urls.filter(Boolean).length : 0
    const aged = list.filter(v => { const ref = v.lot_date || v.created_at; return ref && (now - new Date(ref)) > 60 * 86400000 })
    const lowPhotos = list.filter(v => photoCount(v) < 4 || (v.photo_score != null && v.photo_score < 50)).length
    const noPrice = list.filter(v => !v.price || Number(v.price) === 0).length
    const priced = list.filter(v => Number(v.price) > 0).map(v => Number(v.price))
    const avgPrice = priced.length ? Math.round(priced.reduce((a, b) => a + b, 0) / priced.length) : 0
    const minPrice = priced.length ? Math.min(...priced) : 0
    const maxPrice = priced.length ? Math.max(...priced) : 0
    const makeCounts = {}
    for (const v of list) { const k = v.make || 'Unknown'; makeCounts[k] = (makeCounts[k] || 0) + 1 }
    const topMakes = Object.entries(makeCounts).sort((a, b) => b[1] - a[1]).slice(0, 6)
      .map(([m, n]) => `${m} ${n}`).join(', ')
    const agedSample = aged.slice(0, 8).map(v => `${v.year || ''} ${v.make || ''} ${v.model || ''}`.trim()).filter(Boolean).join('; ')

    const since = new Date(now - 7 * 86400000).toISOString()
    const { data: leads } = await supabaseAdmin.from('leads')
      .select('adf_sent_at, created_at').eq('dealership_id', req.dealershipId).gte('created_at', since)
    const leadsWaiting = (leads || []).filter(l => !l.adf_sent_at).length
    const leads7 = (leads || []).length

    const { data: acts } = await supabaseAdmin.from('ai_activity')
      .select('price_flagged, created_at').eq('dealership_id', req.dealershipId)
      .order('created_at', { ascending: false }).limit(400)
    const priceFlags = (acts || []).filter(a => a.price_flagged && (now - new Date(a.created_at)) < 2 * 86400000).length

    // Month-to-date sales pulse — so simple "how are we doing" questions are answered
    // instantly; the dealership_report tool handles per-rep/commission/lead deep dives.
    const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString()
    const { data: soldDeals } = await supabaseAdmin.from('deals')
      .select('deal_status, selling_price, sold_at, created_at')
      .eq('dealership_id', req.dealershipId).in('deal_status', ['sold', 'delivered']).limit(1000)
    const soldMTD = (soldDeals || []).filter(x => (x.sold_at || x.created_at) >= monthStart)
    const revMTD = soldMTD.reduce((s, x) => s + (Number(x.selling_price) || 0), 0)
    // Open, due-today-or-overdue tasks — the "what needs attention" pulse.
    const nowIso = new Date().toISOString()
    const { data: dueTasks } = await supabaseAdmin.from('crm_tasks')
      .select('due_at').eq('dealership_id', req.dealershipId).eq('done', false).lte('due_at', nowIso).limit(500)
    const overdueCount = (dueTasks || []).length
    // Cars sitting in reconditioning / get-ready.
    const { count: reconCount } = await supabaseAdmin.from('recon')
      .select('id', { count: 'exact', head: true }).eq('dealership_id', req.dealershipId)

    const loc = [dealer?.city, dealer?.province, dealer?.country].filter(Boolean).join(', ')
    const facts = [
      `Dealership: ${dealer?.name || 'this dealership'}${loc ? ` (${loc})` : ''}.`,
      `Available units: ${total}. Avg price: ${avgPrice ? '$' + avgPrice.toLocaleString() : 'n/a'} (range ${minPrice ? '$' + minPrice.toLocaleString() : 'n/a'}–${maxPrice ? '$' + maxPrice.toLocaleString() : 'n/a'}).`,
      `By make: ${topMakes || 'n/a'}.`,
      `Aging 60+ days: ${aged.length}${agedSample ? ` (e.g. ${agedSample})` : ''}.`,
      `Weak/thin photos: ${lowPhotos}. Missing price: ${noPrice}. Priced off market (last 2 days): ${priceFlags}.`,
      `Leads last 7 days: ${leads7}, of which ${leadsWaiting} still need follow-up.`,
      `Sales month-to-date: ${soldMTD.length} sold${revMTD ? ` ($${Math.round(revMTD).toLocaleString()} revenue)` : ''}. Cars in reconditioning/get-ready: ${reconCount || 0}. Open tasks due/overdue: ${overdueCount}.`,
    ].join('\n')

    const system = `You are MarketSync — the smartest person at this car dealership. You are a sharp GM/analyst who knows this store's whole operation: inventory, leads, sales, F&I, commissions, reconditioning, tasks and appointments. You do four things: (1) answer how MarketSync works, what's included, and pricing, from the PRODUCT GUIDE; (2) answer about THIS store from the LIVE SNAPSHOT; (3) for any deeper question about the store's own numbers or people — units/gross/commissions this month, who's ahead or needs coaching, lead volume/sources/conversion, unworked leads, reconditioning status, overdue tasks, who to call today, recent trades, whether we're trending up or down vs last period, what to prioritize today, which cars to discount or wholesale and the reprice target, who to call for an upgrade or lease pull-ahead, or which ad channel is paying off — call the dealership_report tool with the right topic ('trends', 'priorities', 'pricing', 'equity', 'marketing_roi', and the rest) and answer from real data (don't guess); (4) pull live MARKET data — decode a VIN, predict a price for a VIN, or a market snapshot for a make/model; (5) DO things when asked — add a follow-up task/reminder, or text/email a group of customers — via the propose_action tool, which ALWAYS asks the user to confirm before anything runs (never say it's done; say you've set it up for their confirmation). Use a tool whenever it sharpens the answer; never guess a VIN — ask for it. Be direct and specific: lead with the number, then one crisp takeaway or recommended action. Keep it tight — a couple of sentences or a short list, no headings, no fluff. Never invent numbers beyond the snapshot or tool results; when quoting product prices, note they should confirm exact pricing on the billing screen. Today: ${new Date().toISOString().slice(0, 10)}.\n\n${PRODUCT_KB}\n\nLIVE SNAPSHOT (this dealership, right now):\n${facts}`
      // Dealer-set voice/style for the internal assistant, plus their uploaded knowledge base.
      + (dealer?.ai_internal_style ? `\n\nHOUSE STYLE (follow this voice for your answers): ${dealer.ai_internal_style}` : '')
      + (dealer?.ai_knowledge ? `\n\nDEALERSHIP KNOWLEDGE BASE${dealer.ai_knowledge_name ? ` (${dealer.ai_knowledge_name})` : ''} — treat as authoritative for this store's own policies/processes:\n${dealer.ai_knowledge}` : '')

    const isUS = /^(us|usa|united states)$/i.test((dealer?.country || '').trim())
    // Finance topics of the dealership report (revenue, per-rep commissions) are
    // manager-only; a rep asking gets the non-financial slices.
    const isMgrRole = isOwner || ['DEALER_ADMIN', 'OWNER', 'MANAGER'].includes(req.profile?.role)

    try {
      const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
      const convo = messages.slice()
      const call = () => Promise.race([
        anthropic.messages.create({ model: SMART_MODEL, max_tokens: 1000, system, tools: ASSISTANT_TOOLS, messages: convo }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('ai timeout')), 25000)),
      ])
      // Tool-use loop: run any tools the model asks for, feed the results back,
      // and let it answer. Bounded so a loop can't run away (or run up cost).
      let response = await call()
      let guard = 0
      let proposedAction = null   // agentic: an action the user must confirm before it runs
      while (response?.stop_reason === 'tool_use' && guard++ < 4) {
        const toolResults = []
        for (const block of response.content || []) {
          if (block.type === 'tool_use') {
            let result
            if (block.name === 'propose_action') {
              // Never execute here — capture the proposal + tell the model it's pending
              // the user's confirmation. The frontend renders a confirm button.
              const a = block.input || {}
              const act = a.action === 'bulk_outreach' ? 'bulk_outreach' : a.action === 'create_task' ? 'create_task' : null
              if (act === 'create_task' && String(a.title || '').trim()) {
                proposedAction = { action: 'create_task', title: String(a.title).trim().slice(0, 200), due_hours: Number(a.due_hours) > 0 ? Math.min(8760, Number(a.due_hours)) : null }
              } else if (act === 'bulk_outreach' && String(a.instruction || '').trim() && isMgrRole) {
                proposedAction = { action: 'bulk_outreach', instruction: String(a.instruction).trim().slice(0, 500) }
              }
              result = proposedAction ? 'Proposed to the user — awaiting their confirmation. Do not say it is done.' : 'Could not stage that action (missing details or not permitted).'
            } else {
              result = await runAssistantTool(block.name, block.input || {}, { dealershipId: req.dealershipId, isOwner, isUS, isMgr: isMgrRole })
            }
            toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result })
          }
        }
        convo.push({ role: 'assistant', content: response.content })
        convo.push({ role: 'user', content: toolResults })
        response = await call()
      }
      const reply = (response?.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim()
      if (!reply && !proposedAction) return res.status(502).json({ error: 'No reply generated. Try rephrasing.' })
      recordUsage(req.dealershipId, { ai: 1 })       // monthly AI quota + global budget
      recordAssistantChat(req.dealershipId)          // today's per-dealer assistant cap
      res.json({ reply: reply || 'Ready when you are — confirm below to run it.', action: proposedAction })
    } catch (e) {
      res.status(502).json({ error: aiErrorMessage(e) })
    }
  })
}
