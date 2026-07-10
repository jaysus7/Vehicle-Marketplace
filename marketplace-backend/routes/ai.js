import Anthropic from '@anthropic-ai/sdk'
import { supabaseAdmin, resend, EMAIL_FROM, FRONTEND_URL, browserFetch } from '../shared.js'
import { requireAuth } from '../middleware.js'
import { marketcheckMarket, marketcheckListings, marketcheckEnabled, marketcheckCompetitorStats, marketcheckPing, marketcheckDecodeVin, marketcheckPredictPrice, marketcheckMarketStats } from '../marketcheck.js'
import { getMarketData, recordUsage, aiAllowed, getUsage, assistantDailyAllowed, recordAssistantChat, ASSISTANT_DAILY_LIMIT, marketcheckAllowed, recordMarketcheckCall } from '../usage.js'
import { createNotification, createNotifications } from '../notifications.js'
import { runPhotoVision, scoreVehiclePhotos } from '../sync/photoVision.js'

const OWNER_EMAIL = (process.env.OWNER_EMAIL || 'massiejay@gmail.com').toLowerCase()

// Google-Translate language codes → names, so AI-written listing copy can be
// requested in the rep's chosen language. Unknown codes pass through as-is.
const LANG_NAME = {
  en: 'English', fr: 'French', es: 'Spanish', de: 'German', it: 'Italian',
  pt: 'Portuguese', nl: 'Dutch', pl: 'Polish', ru: 'Russian', uk: 'Ukrainian',
  ar: 'Arabic', hi: 'Hindi', pa: 'Punjabi', ur: 'Urdu', fa: 'Persian',
  zh: 'Chinese', 'zh-cn': 'Chinese (Simplified)', 'zh-tw': 'Chinese (Traditional)',
  ja: 'Japanese', ko: 'Korean', vi: 'Vietnamese', tl: 'Tagalog', th: 'Thai',
  tr: 'Turkish', el: 'Greek', he: 'Hebrew', ro: 'Romanian', so: 'Somali',
}
const langName = code => LANG_NAME[String(code || '').toLowerCase()] || code || ''

// Product knowledge the in-dashboard assistant answers "how does MarketSync
// work / what do I get / how much" questions from. Kept here (not a DB) so it's
// easy to edit in one place — update it whenever features or pricing change.
const PRODUCT_KB = `ABOUT MARKETSYNC
MarketSync is a dealership tool that syncs your used-car inventory, posts and manages listings (incl. Facebook Marketplace), tracks leads and a sales pipeline, gamifies the sales team, and layers AI + live market data on top. There's a Chrome extension for posting/lead capture.

CORE (included) FEATURES
- Inventory: auto-sync from your website/feed; per-vehicle VIN decode, recall checks, window stickers & brochures (PDF).
- Pipeline & Leads: capture Marketplace leads, sales pipeline stages (Posted → Appointment Set → Claimed Sale → Needs Relisting), appointments with a month calendar + reminders.
- Insights: listing/sales trends and per-rep activity charts.
- Leaderboard & Sales Team: rep points/tiers, per-rep insight modal.
- Profile & Settings: account, team, billing, security.

ADD-ONS (paid, per dealership / month)
- AI Boost — about $129/mo: one-click AI listing copy, AI reply drafts for leads, AI Vision photo scoring + best-hero pick, AI-written blurbs on window stickers/brochures, AI lot-analysis summary, the daily "Today's Briefing", and this assistant.
- Inventory Intelligence — about $299/mo: live market pricing & price flags (over/under market), competitor monitoring, lot analysis (turn rate, health scores, hot/cold movers, duplicate VINs, aged units), repricing rules, stocking recommendations, Trade Appraisal (live market value + suggested cash/trade offer), market reports, and this assistant.
The account owner has every feature. Prices are approximate — tell users to check the upgrade screen (any locked feature opens it) or Profile & Settings › billing for exact, current pricing.

WHERE THINGS LIVE (nav)
Insights · Inventory · Pipeline · Appraisal (Inventory Intelligence) · Leaderboard · Sales Team · Inv. Intelligence (paid) · Profile & Settings. VIN decode, recalls, stickers & brochures are on each vehicle under Inventory.

COMMON HOW-TOs
- Sync inventory: Inventory page → Sync button.
- Decode a VIN / see recalls: open a vehicle in Inventory (or use Decode VIN on the Appraisal page).
- Appraise a trade: Appraisal page → enter VIN/details → Appraise.
- Draft a lead reply: open the lead in Pipeline → AI reply.
- See what's aging / priced off market / restock: Inv. Intelligence page.`

// Live-data tools the assistant can call on demand. Each one is a paid MarketCheck
// call, so it runs through the same allow/record gate (monthly quota + daily cap +
// global budget) as every other lookup. Owner is exempt from the per-dealer caps.
const ASSISTANT_TOOLS = [
  {
    name: 'decode_vin',
    description: 'Decode a 17-character VIN into a full spec sheet (year, make, model, trim, engine, drivetrain, options, fuel economy, MSRP). Use when the user gives a VIN and wants specs.',
    input_schema: { type: 'object', properties: { vin: { type: 'string', description: '17-character VIN' } }, required: ['vin'] },
  },
  {
    name: 'predict_price',
    description: 'Model-comparable predicted retail price and confidence band for a specific VIN. Use for "what is a fair price / what is this worth" when a VIN is available.',
    input_schema: { type: 'object', properties: { vin: { type: 'string' }, miles: { type: 'number', description: 'Odometer reading, optional' } }, required: ['vin'] },
  },
  {
    name: 'market_snapshot',
    description: 'Live market stats — active listing count, median price, and average days-on-market — for a make/model (optionally a year/trim). Use for "how is X selling / days on market / demand / is it hot or stale".',
    input_schema: { type: 'object', properties: { make: { type: 'string' }, model: { type: 'string' }, year: { type: 'number' }, trim: { type: 'string' } }, required: ['make', 'model'] },
  },
]

async function runAssistantTool(name, input, { dealershipId, isOwner, isUS }) {
  if (!marketcheckEnabled()) return 'Live market data (MarketCheck) is not configured on this account.'
  if (!(await marketcheckAllowed(dealershipId, isOwner))) return 'The market-data lookup limit has been reached for now — try again later.'
  try {
    if (name === 'decode_vin') {
      const specs = await marketcheckDecodeVin(input?.vin)
      await recordMarketcheckCall(dealershipId)   // request billed even if empty
      if (!specs) return 'No specs found for that VIN.'
      const keep = ['year', 'make', 'model', 'trim', 'body_type', 'body_subtype', 'drivetrain', 'transmission', 'engine', 'doors', 'fuel_type', 'city_mpg', 'highway_mpg', 'msrp', 'vehicle_type']
      const out = {}; for (const k of keep) if (specs[k] != null) out[k] = specs[k]
      return JSON.stringify(Object.keys(out).length ? out : specs).slice(0, 1500)
    }
    if (name === 'predict_price') {
      const p = await marketcheckPredictPrice({ vin: input?.vin, miles: input?.miles })
      await recordMarketcheckCall(dealershipId)
      return p ? JSON.stringify(p) : 'No price prediction available for that VIN.'
    }
    if (name === 'market_snapshot') {
      const s = await marketcheckMarketStats({ make: input?.make, model: input?.model, year: input?.year, trim: input?.trim, isUS })
      await recordMarketcheckCall(dealershipId)
      return s ? JSON.stringify(s) : 'No market data found for that make/model.'
    }
  } catch {
    return 'That lookup failed — the market-data service may be busy.'
  }
  return 'Unknown tool.'
}

// A vehicle we should NOT run market price comparisons on: brand-new / demo units,
// and anything at or beyond the current model year (e.g. 2026 in 2026). There is no
// meaningful used-market comp set for these, so any "% over/under market" is noise.
function skipPriceComp(vehicle) {
  const cond = (vehicle?.condition || '').toLowerCase()
  if (cond === 'new' || cond === 'demo') return true
  const yr = Number(vehicle?.year)
  return Number.isFinite(yr) && yr >= new Date().getFullYear()
}

// Build a price-comp flag from a scraped market median, with sanity guards so a
// bad/mismatched comp set never surfaces an absurd number like "233% overpriced".
// A real dealer car is essentially never off by more than ~45% vs true market — a
// deviation that large means the scraper matched the wrong listings (wrong model,
// salvage titles, parts), so we treat it as unreliable and don't flag.
function buildPriceFlag(price, marketMedian, source, compCount) {
  if (!marketMedian || marketMedian <= 0) return null
  const pct_diff = ((Number(price) - marketMedian) / marketMedian) * 100
  const reliable = (compCount == null || compCount >= 3) && Math.abs(pct_diff) <= 45
  return {
    flagged: reliable && Math.abs(pct_diff) > 15,
    median: marketMedian,
    pct_diff: Math.round(pct_diff * 10) / 10,
    comp_count: compCount ?? null,
    source,
    reliable,
  }
}

// Turn a raw Anthropic error into a clear, dealer-friendly message. The most
// common operational failure is the account running out of API credits, which
// otherwise surfaces as a cryptic 400/402 — call it out explicitly.
function aiErrorMessage(err) {
  const raw = String(err?.message || err || '')
  if (/credit balance is too low|insufficient.*credit|billing|payment/i.test(raw)) {
    return 'AI is temporarily unavailable — the AI account is out of credits. Please top up Anthropic credits to generate new reports.'
  }
  if (/rate.?limit|429|overloaded|529/i.test(raw)) {
    return 'AI is busy right now — please try again in a moment.'
  }
  return `AI request failed: ${raw}`
}

// Market median for the inventory scan — MarketCheck only (licensed, trim-matched).
// Returns { median, source, count }, or null when there's no key / no comps.
async function marketMedianForScan({ vehicle, dealer, isUS, dealershipId, isOwner, allowLive = false }) {
  if (!marketcheckEnabled()) return null
  try {
    // Routed through the cost layer: served from the shared 7-day cache when
    // possible. A live (paid) call is only made when allowLive is set — the nightly
    // refresh and button actions. Passive callers get cache-or-null (never spend).
    const { data: mc } = await getMarketData({
      dealershipId, isOwner, allowLive,
      params: {
        make: vehicle.make, model: vehicle.model, year: Number(vehicle.year),
        trim: vehicle.trim || '', mileage: vehicle.mileage ? Number(vehicle.mileage) : null,
        isUS,
      },
    })
    if (mc?.median_price) return { median: mc.median_price, source: 'MarketCheck', count: mc.count }
    return null
  } catch { return null }
}

function requireDealerAdmin(req, res, next) {
  // Dealer-level access: dealer admins, owners, and managers (a manager has full
  // dealer access, just scoped to the store they're logged into).
  if (!['DEALER_ADMIN', 'OWNER', 'MANAGER'].includes(req.profile?.role)) {
    return res.status(403).json({ error: 'Dealer-level access required' })
  }
  next()
}

// Calculate median from a sorted array of numbers
function median(sorted) {
  if (!sorted.length) return null
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 !== 0
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2
}

// Compute the "today's briefing" digest for a dealership — the action items on
// the lot plus a one-line summary. Shared by the GET endpoint (in-dashboard card)
// and the daily-email cron. isOwner exempts the AI summary from the soft cap.
async function computeDailyDigest(dealershipId, isOwner = false) {
  const now = Date.now()
  const { data: inv } = await supabaseAdmin.from('inventory')
    .select('id, price, image_urls, photo_score, created_at')
    .eq('dealership_id', dealershipId).eq('status', 'available')
  const list = inv || []
  const total = list.length
  const photoCount = v => Array.isArray(v.image_urls) ? v.image_urls.filter(Boolean).length : 0
  const aging = list.filter(v => v.created_at && (now - new Date(v.created_at)) > 60 * 86400000).length
  const lowPhotos = list.filter(v => photoCount(v) < 4 || (v.photo_score != null && v.photo_score < 50)).length
  const noPrice = list.filter(v => !v.price || Number(v.price) === 0).length

  const since = new Date(now - 7 * 86400000).toISOString()
  const { data: leads } = await supabaseAdmin.from('leads')
    .select('id, created_at, adf_sent_at').eq('dealership_id', dealershipId).gte('created_at', since)
  const leadsWaiting = (leads || []).filter(l => !l.adf_sent_at).length
  const leads7 = (leads || []).length

  const { data: acts } = await supabaseAdmin.from('ai_activity')
    .select('price_flagged, created_at').eq('dealership_id', dealershipId)
    .order('created_at', { ascending: false }).limit(400)
  const priceFlags = (acts || []).filter(a => a.price_flagged && (now - new Date(a.created_at)) < 2 * 86400000).length

  const items = []
  if (leadsWaiting) items.push({ icon: '📬', text: `${leadsWaiting} lead${leadsWaiting > 1 ? 's' : ''} waiting for follow-up`, page: 'pipeline' })
  if (lowPhotos) items.push({ icon: '📸', text: `${lowPhotos} listing${lowPhotos > 1 ? 's' : ''} need better photos`, page: 'inv-intel' })
  if (priceFlags) items.push({ icon: '💲', text: `${priceFlags} vehicle${priceFlags > 1 ? 's' : ''} priced off market`, page: 'inv-intel' })
  if (noPrice) items.push({ icon: '⚠️', text: `${noPrice} listing${noPrice > 1 ? 's' : ''} missing a price`, page: 'inventory' })
  if (aging) items.push({ icon: '🕒', text: `${aging} unit${aging > 1 ? 's' : ''} aging 60+ days`, page: 'inv-intel' })

  let summary = null
  if (!items.length) {
    summary = 'Everything looks good today — no urgent items on the lot.'
  } else {
    const { data: dealer } = await supabaseAdmin.from('dealerships').select('ai_boost_active').eq('id', dealershipId).maybeSingle()
    const aiBoost = isOwner || !!dealer?.ai_boost_active
    if (aiBoost && process.env.ANTHROPIC_API_KEY && await aiAllowed(dealershipId, isOwner)) {
      const facts = `Lot: ${total} available. ${leadsWaiting} leads waiting (${leads7} in 7 days). ${lowPhotos} weak photos. ${priceFlags} priced off market. ${noPrice} missing price. ${aging} aging 60+ days.`
      try {
        const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
        const msg = await Promise.race([
          anthropic.messages.create({ model: 'claude-haiku-4-5-20251001', max_tokens: 150, messages: [{ role: 'user', content: `You are a dealership GM's assistant writing a ONE-sentence morning briefing. Be direct and say what to tackle first. No markdown, no greeting, no lists. Data: ${facts}` }] }),
          new Promise((_, rej) => setTimeout(() => rej(new Error('ai timeout')), 15000)),
        ])
        summary = (msg?.content?.[0]?.text || '').trim() || null
        if (summary) recordUsage(dealershipId, { ai: 1 })
      } catch { /* fall through to templated */ }
    }
    if (!summary) summary = `${items.length} thing${items.length > 1 ? 's' : ''} to look at today — start with ${items[0].text.toLowerCase()}.`
  }

  return { date: new Date().toISOString().slice(0, 10), items, summary, counts: { total, leadsWaiting, lowPhotos, priceFlags, noPrice, aging } }
}

export function registerAI(app) {
  // GET /ai/config — returns dealership's AI config
  app.get('/ai/config', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership associated' })
    const { data, error } = await supabaseAdmin
      .from('dealerships')
      .select('ai_boost_active, ai_tone, ai_required_fields, ai_manager_email, vin_sticker_active, inv_intel_active, ai_vision_active, country, province, city, postal_code, daily_digest_enabled')
      .eq('id', req.dealershipId)
      .single()
    if (error) return res.status(500).json({ error: error.message })
    const isOwner = (req.user.email || '').toLowerCase() === OWNER_EMAIL
    // Entitlement model:
    //  • AI Boost is the master switch for ALL AI (listing copy, price reports,
    //    AI Vision, generated/branded sticker & brochure, AI lot narrative).
    //  • Inventory Intelligence includes the VIN decoder + factory OEM docs.
    //  • The AI lot narrative inside Inv Intel needs AI Boost too.
    const aiBoost = isOwner || !!data.ai_boost_active
    const invIntel = isOwner || !!data.inv_intel_active
    res.json({
      ...data,
      ai_boost_active: aiBoost,
      inv_intel_active: invIntel,
      vin_sticker_active: invIntel,      // VIN decoder is part of Inventory Intelligence
      ai_docs_active: aiBoost,           // generated/branded sticker & AI brochure
      ai_vision_active: aiBoost,         // AI Vision folded into AI Boost
    })
  })

  // PUT /ai/config — update dealership AI config (DEALER_ADMIN only)
  app.put('/ai/config', requireAuth, requireDealerAdmin, async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership associated' })
    const { ai_tone, ai_required_fields, ai_manager_email, ai_boost_active, country, province, city, postal_code, daily_digest_enabled } = req.body
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

    const { data, error } = await supabaseAdmin
      .from('dealerships')
      .update(update)
      .eq('id', req.dealershipId)
      .select('ai_boost_active, ai_tone, ai_required_fields, ai_manager_email, country, province, city, postal_code, daily_digest_enabled')
      .single()
    if (error) return res.status(500).json({ error: error.message })
    res.json(data)
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
      if (mm) price_flag = buildPriceFlag(vehicle.price, mm.median, mm.source, mm.count)
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
              if (mm) price_flag = buildPriceFlag(vehicle.price, mm.median, mm.source, mm.count)
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
    // small, tunable haircut so our retail anchor matches what the car actually sells
    // for (and lines up with the trade books the customer is checking).
    const REALISM = Number(process.env.APPRAISE_MARKET_REALISM || 0.04)
    const realismCut = Math.round(mileageAdjusted * REALISM)
    const retailMid = Math.max(0, mileageAdjusted - realismCut)   // realistic retail value

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
    const suggestedOffer = Math.max(0, tradeValue - recon - targetGross)
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
        const prompt = `Write a professional 2–3 sentence market summary for a vehicle trade-appraisal sheet a dealer hands to a customer. Explain the offer in plain English and justify it with the market data, including how the odometer moved the value. No markdown, no bullet points, no greeting.
Vehicle: ${year} ${make} ${model}${trim ? ' ' + trim : ''}${mileage ? `, ${mileage.toLocaleString()} ${du}` : ''}.
Retail market from ${market.count} comparable listings: asking median ${cur} $${compMedian.toLocaleString()}, range $${(market.low_price || compMedian).toLocaleString()}–$${(market.high_price || compMedian).toLocaleString()}. ${mileVsMarket}
Adjusted retail value for this vehicle: ${cur} $${retailMid.toLocaleString()}.${tradeValue < retailMid - 1 ? `
Wholesale value (ACV): ${cur} $${tradeValue.toLocaleString()} — about ${Math.round(tradeRatio * 100)}% of retail, in line with trade/wholesale valuation tools like AutoTrader.` : ''}
ACV / wholesale take-in (what the dealer buys it for): ${cur} $${suggestedOffer.toLocaleString()} — the retail value less ${cur} $${recon.toLocaleString()} reconditioning and a ${cur} $${targetGross.toLocaleString()} target gross, in line with trade-value tools like AutoTrader.`
        const msg = await Promise.race([
          anthropic.messages.create({ model: 'claude-haiku-4-5-20251001', max_tokens: 220, messages: [{ role: 'user', content: prompt }] }),
          new Promise((_, rej) => setTimeout(() => rej(new Error('ai timeout')), 20000)),
        ])
        ai_summary = (msg?.content?.[0]?.text || '').trim() || null
        if (ai_summary) recordUsage(req.dealershipId, { ai: 1 })
      } catch { /* summary is a nice-to-have — never fail the appraisal for it */ }
    }

    res.json({
      ok: true,
      vehicle,
      dealer_name: dealer?.name || null,
      currency: isUS ? 'USD' : 'CAD',
      distance_unit: isUS ? 'mi' : 'km',
      retail: {
        median: retailMid,                    // adjusted retail value for THIS vehicle
        comp_median: compMedian,               // raw median asking price of the comps
        low: market.low_price ?? null,
        high: market.high_price ?? null,
        avg: market.avg_price ?? null,
        count: market.count ?? null,
        avg_days_online: market.avg_days_online ?? null,
        avg_mileage: market.avg_mileage ?? market.median_mileage ?? null,
        market_mileage: compMiles,             // median mileage of the comp pool
        matched_on: market.matched_on || {},   // which filters shaped the comp set
        radius_used: market.radius_used ?? null,
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
        ai_summary,
        // Transparent value bridge: comp asking median → adjusted retail → trade → offer.
        adjustments: {
          comp_median: compMedian,
          subject_mileage: mileage || null,
          market_mileage: compMiles,
          mileage_adjustment: mileageAdj,
          market_realism_pct: Math.round(REALISM * 1000) / 10,
          market_realism_amount: -realismCut,
          retail_value: retailMid,
          trade_ratio_pct: Math.round(tradeRatio * 1000) / 10,
          trade_value: tradeValue,
          recon: -recon,
          target_gross: -targetGross,
        },
      },
      // MarketCheck model-comparable predicted retail + confidence band (or null).
      prediction,
      // Sample comps (price + mileage + location) for the PDF charts.
      comps: compList.slice(0, 50).map(l => ({ price: l.price, miles: l.miles, city: l.city, region: l.region })),
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

  // GET /ai/market-positions — latest market median per inventory_id (from the most
  // recent Inventory Scan). Powers the "% to market" badge on used inventory cards.
  // Inventory Intelligence add-on only; returns {} otherwise (so the UI stays hidden).
  app.get('/ai/market-positions', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.json({ positions: {}, active: false })
    const { data: dealer } = await supabaseAdmin
      .from('dealerships').select('inv_intel_active').eq('id', req.dealershipId).maybeSingle()
    const isOwner = (req.user.email || '').toLowerCase() === OWNER_EMAIL
    if (!isOwner && !dealer?.inv_intel_active) return res.json({ positions: {}, active: false })

    const { data: acts } = await supabaseAdmin
      .from('ai_activity')
      .select('inventory_id, price_median, created_at')
      .eq('dealership_id', req.dealershipId)
      .not('price_median', 'is', null)
      .order('created_at', { ascending: false })
      .limit(3000)
    // Keep the newest median per vehicle (rows come newest-first).
    const positions = {}
    for (const a of acts || []) {
      if (a.inventory_id && positions[a.inventory_id] == null) positions[a.inventory_id] = a.price_median
    }
    res.json({ positions, active: true })
  })

  // GET /ai/lot-report — aggregate the whole lot against AutoTrader/CarGurus market
  // averages. Built from the most recent scan (ai_activity.price_median per vehicle)
  // so it's instant and free — run "Scan All Inventory" first to refresh the comps.
  app.get('/ai/lot-report', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership associated' })

    const { data: dealer } = await supabaseAdmin
      .from('dealerships').select('inv_intel_active').eq('id', req.dealershipId).single()
    const isOwner = (req.user.email || '').toLowerCase() === OWNER_EMAIL
    // Lot Average Report is part of the Inventory Scan → Inventory Intelligence.
    if (!isOwner && !dealer?.inv_intel_active) {
      return res.status(403).json({ error: 'Inventory Intelligence add-on required' })
    }

    // Latest scan result per vehicle that produced a (reliable) market median.
    const { data: acts, error: aErr } = await supabaseAdmin
      .from('ai_activity')
      .select('inventory_id, price_median, created_at')
      .eq('dealership_id', req.dealershipId)
      .not('price_median', 'is', null)
      .order('created_at', { ascending: false })
      .limit(3000)
    if (aErr) return res.status(500).json({ error: aErr.message })

    const latest = new Map()
    for (const a of acts || []) {
      if (a.inventory_id && !latest.has(a.inventory_id)) latest.set(a.inventory_id, a)
    }
    const ids = [...latest.keys()]
    if (!ids.length) {
      return res.json({ count: 0, vehicles: [], lot_avg: 0, market_avg: 0, overall_pct_diff: 0, over: 0, under: 0, fair: 0 })
    }

    const { data: inv } = await supabaseAdmin
      .from('inventory')
      .select('id, year, make, model, trim, price, status')
      .in('id', ids)
      .eq('dealership_id', req.dealershipId)
      .eq('status', 'available')

    const vehicles = []
    for (const v of inv || []) {
      const a = latest.get(v.id)
      const yourPrice = Number(v.price)
      const market = Number(a?.price_median)
      if (!yourPrice || !market) continue
      const pct = Math.round(((yourPrice - market) / market) * 1000) / 10
      // Skip implausible comps (>45% off) — almost always mismatched/thin market
      // data, not real over/under-pricing. Keeps the report honest.
      if (Math.abs(pct) > 45) continue
      vehicles.push({
        inventory_id: v.id,
        label: [v.year, v.make, v.model, v.trim].filter(Boolean).join(' ') || 'Vehicle',
        your_price: yourPrice,
        market_avg: market,
        pct_diff: pct,
      })
    }
    vehicles.sort((a, b) => b.pct_diff - a.pct_diff)

    const count = vehicles.length
    const lotAvg = count ? Math.round(vehicles.reduce((s, v) => s + v.your_price, 0) / count) : 0
    const marketAvg = count ? Math.round(vehicles.reduce((s, v) => s + v.market_avg, 0) / count) : 0
    const overallPct = marketAvg ? Math.round(((lotAvg - marketAvg) / marketAvg) * 1000) / 10 : 0
    const over = vehicles.filter(v => v.pct_diff > 5).length
    const under = vehicles.filter(v => v.pct_diff < -5).length
    const fair = count - over - under

    res.json({ count, lot_avg: lotAvg, market_avg: marketAvg, overall_pct_diff: overallPct, over, under, fair, vehicles })
  })

  // GET /ai/price-report/:inventory_id — AI market estimate for a vehicle
  app.get('/ai/price-report/:inventory_id', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership associated' })
    const { inventory_id } = req.params

    const { data: vehicle, error: vErr } = await supabaseAdmin
      .from('inventory')
      .select('id, year, make, model, trim, condition, price, mileage, exterior_color, stocknumber, status')
      .eq('id', inventory_id)
      .eq('dealership_id', req.dealershipId)
      .single()
    if (vErr || !vehicle) return res.status(404).json({ error: 'Vehicle not found' })

    if (!vehicle.price || !vehicle.make || !vehicle.model || !vehicle.year) {
      return res.json({ vehicle, estimate: null, pct_diff: null })
    }

    // Current-year / new / demo units have no meaningful used-market comp set —
    // skip the calculation entirely rather than flag them against mismatched data.
    if (skipPriceComp(vehicle)) {
      return res.json({
        vehicle, estimate: null, pct_diff: null, skipped: true,
        reason: `${vehicle.year} ${vehicle.make} ${vehicle.model} is a new / current-year vehicle — there isn't a reliable used-market comparison set, so a market price report isn't generated for it.`,
      })
    }

    // Serve the cached report if it's fresh (72 hours) and the asking price hasn't
    // changed. Reports cache for 72h from generation; ?refresh=1 forces a rebuild.
    const CACHE_HOURS = 72
    if (req.query.refresh !== '1') {
      const { data: cached } = await supabaseAdmin
        .from('price_reports').select('report, price_at_generation, generated_at')
        .eq('inventory_id', inventory_id).maybeSingle()
      if (cached) {
        const ageHours = (Date.now() - new Date(cached.generated_at)) / 3600000
        const priceSame = cached.price_at_generation == null || Number(cached.price_at_generation) === Number(vehicle.price)
        if (ageHours < CACHE_HOURS && priceSame) {
          return res.json({ ...cached.report, cached: true, generated_at: cached.generated_at })
        }
      }
    }

    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(503).json({ error: 'AI features not configured' })
    }

    // Fetch dealership location and country for market context
    const { data: dealer } = await supabaseAdmin
      .from('dealerships')
      .select('city, province, country, postal_code')
      .eq('id', req.dealershipId)
      .single()

    const isNew = vehicle.condition === 'new' || Number(vehicle.year) >= new Date().getFullYear()
    const conditionLabel = isNew ? 'new' : 'used'

    // Determine market (US vs Canada) based on dealership country field
    const countryRaw = (dealer?.country || '').trim().toUpperCase()
    const isUS = countryRaw === 'US' || countryRaw === 'USA' || countryRaw === 'UNITED STATES'
    const currency = isUS ? 'USD' : 'CAD'
    const marketLabel = isUS ? 'US' : 'Canadian'
    const distanceUnit = isUS ? 'miles' : 'km'
    const marketSources = isUS
      ? ['AutoTrader.com', 'CarGurus.com', 'Cars.com']
      : ['AutoTrader Canada', 'CarGurus Canada', 'Kijiji Autos']
    const location = [dealer?.city, dealer?.province].filter(Boolean).join(', ') || (isUS ? 'United States' : 'Canada')
    const mileageText = vehicle.mileage ? `${Number(vehicle.mileage).toLocaleString()} ${distanceUnit}` : 'unknown mileage'
    const trimText = vehicle.trim ? ` ${vehicle.trim}` : ''

    const [src1, src2, src3] = marketSources
    const vehicleMileage = vehicle.mileage ? Number(vehicle.mileage) : null
    const currentYear = new Date().getFullYear()
    const vehicleAge = currentYear - Number(vehicle.year)
    // Expected mileage for age: CA = 19,000 km/yr, US = 13,500 mi/yr
    const expectedMileage = isUS ? vehicleAge * 13500 : vehicleAge * 19000
    const mileageDelta = vehicleMileage != null ? vehicleMileage - expectedMileage : null
    const mileageContext = vehicleMileage != null
      ? `This vehicle has ${mileageDelta > 0 ? mileageDelta.toLocaleString() + ' ' + distanceUnit + ' MORE than expected' : Math.abs(mileageDelta).toLocaleString() + ' ' + distanceUnit + ' LESS than expected'} for its age (expected ~${expectedMileage.toLocaleString()} ${distanceUnit} for a ${vehicleAge}-year-old vehicle at typical ${marketLabel} annual rates of ${isUS ? '13,500 mi/yr' : '19,000 km/yr'}).`
      : 'Mileage unknown.'

    const vehicleLabel = `${vehicle.year} ${vehicle.make} ${vehicle.model}${trimText}`
    const yourPrice = Number(vehicle.price)

    // ── PRIMARY: MarketCheck licensed data ──────────────────────────────────
    // When a MarketCheck key is configured we build the report from real
    // aggregated market stats (dealer-grade, same class of data as vAuto) and use
    // the AI only for a short written insight. Falls through to an AI-only estimate
    // below when there's no key or MarketCheck has no comps for this exact vehicle.
    if (marketcheckEnabled()) {
      const _prIsOwner = (req.user.email || '').toLowerCase() === OWNER_EMAIL
      const { data: mc } = await getMarketData({
        dealershipId: req.dealershipId, isOwner: _prIsOwner, allowLive: true,
        params: {
          make: vehicle.make, model: vehicle.model, year: Number(vehicle.year),
          trim: vehicle.trim || '', mileage: vehicleMileage, isUS,
        },
      })
      if (mc && mc.median_price) {
        const mid = mc.median_price
        const pct_diff = Math.round(((yourPrice - mid) / mid) * 1000) / 10
        const ptm = Math.round((yourPrice / mid) * 100)
        // Mileage rating vs the MarketCheck market average mileage.
        let mileageRating = 'average', mileageImpact = 0
        if (mc.median_mileage && vehicleMileage) {
          const d = (vehicleMileage - mc.median_mileage) / mc.median_mileage
          mileageRating = d <= -0.3 ? 'well below average' : d <= -0.1 ? 'below average'
            : d >= 0.3 ? 'well above average' : d >= 0.1 ? 'above average' : 'average'
          // ~$0.08/km (CA) or ~$0.10/mi (US) rough odometer adjustment, capped.
          const rate = isUS ? 0.10 : 0.08
          mileageImpact = Math.max(-4000, Math.min(4000, Math.round((mc.median_mileage - vehicleMileage) * rate)))
        }

        // Short AI insight (best-effort — the numbers stand on their own if this fails).
        let note = `Based on ${mc.count.toLocaleString()} comparable ${marketLabel} listings, the market average for this ${vehicleLabel} is ${'$' + mid.toLocaleString()} ${currency}. Your price is ${Math.abs(pct_diff)}% ${pct_diff > 0 ? 'above' : pct_diff < 0 ? 'below' : 'in line with'} market.`
        try {
          if (process.env.ANTHROPIC_API_KEY) {
            const anthropicN = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
            const msg = await anthropicN.messages.create({
              model: 'claude-sonnet-5', max_tokens: 300,
              system: 'You are a concise automotive pricing analyst. Reply with two plain sentences, no markdown, no preamble.',
              messages: [{ role: 'user', content: `Write a two-sentence market insight for a dealer about this vehicle. Be specific and factual. Vehicle: ${vehicleLabel}, ${mileageText}, listed at $${yourPrice.toLocaleString()} ${currency} in ${location}. Real market data from ${mc.count} comparable listings: average $${mid.toLocaleString()} ${currency} (range $${mc.low_price.toLocaleString()}–$${mc.high_price.toLocaleString()}), average mileage ${mc.median_mileage ? mc.median_mileage.toLocaleString() + ' ' + distanceUnit : 'n/a'}. The listing is ${Math.abs(pct_diff)}% ${pct_diff > 0 ? 'above' : 'below'} market.` }]
            })
            const t = (msg.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim()
            if (t) note = t
          }
        } catch {}

        const estimate = {
          low: mc.low_price, mid, high: mc.high_price, currency,
          price_to_market_pct: ptm,
          days_on_market_estimate: pct_diff > 15 ? 75 : pct_diff > 5 ? 55 : pct_diff < -5 ? 25 : 40,
          confidence: mc.count >= 25 ? 'high' : mc.count >= 8 ? 'medium' : 'low',
          note,
          marketplace_averages: [
            { name: 'MarketCheck (live market)', avg: mid, estimated_listings: `${mc.count.toLocaleString()} listings`, avg_mileage: mc.median_mileage || null },
          ],
          mileage_analysis: {
            market_avg_mileage: mc.median_mileage || null,
            mileage_rating: mileageRating,
            mileage_price_impact: mileageImpact,
            mileage_note: mc.median_mileage && vehicleMileage
              ? `At ${vehicleMileage.toLocaleString()} ${distanceUnit} vs a market average of ${mc.median_mileage.toLocaleString()} ${distanceUnit}, this unit is ${mileageRating}.`
              : 'Mileage comparison unavailable.',
          },
        }

        const payload = { vehicle, estimate, pct_diff, data_source: 'marketcheck', copart: null }
        supabaseAdmin.from('price_reports').upsert({
          inventory_id, dealership_id: req.dealershipId, report: payload,
          price_at_generation: yourPrice, generated_at: new Date().toISOString(),
        }, { onConflict: 'inventory_id' }).then(({ error }) => {
          if (error) console.warn('[price-report] cache write failed:', error.message)
        })
        return res.json(payload)
      }
    }

    // ── FALLBACK: AI estimate (no live comps) ────────────────────────────────
    // Reached only when MarketCheck has no key or no comps for this exact vehicle.
    // We no longer scrape retail sites; the AI produces a training-knowledge
    // estimate and the report is clearly marked ai_estimate.
    const scraped = { autotrader: null, cargurus: null, copart: null }
    const dataSource = 'ai_estimate'

    // Build real-data context lines to inject into the prompt
    const liveDataLines = []
    const fmtScraped = (s) => {
      const daysNote = s.avg_days_online != null
        ? `, avg days online ${s.avg_days_online} (${s.days_online_sample}/${s.count} listings had date)`
        : ''
      return `avg price $${s.avg_price.toLocaleString()} ${currency}, median price $${s.median_price.toLocaleString()}, avg mileage ${s.avg_mileage.toLocaleString()} ${distanceUnit}, median mileage ${s.median_mileage.toLocaleString()} ${distanceUnit}${daysNote}`
    }

    if (scraped.autotrader) liveDataLines.push(`LIVE ${src1} data (${scraped.autotrader.count} listings): ${fmtScraped(scraped.autotrader)}`)
    if (scraped.cargurus) liveDataLines.push(`LIVE ${src2} data (${scraped.cargurus.count} listings): ${fmtScraped(scraped.cargurus)}`)
    if (scraped.copart) {
      const cp = scraped.copart
      liveDataLines.push(`AUCTION REFERENCE — Copart Canada (${cp.count} salvage/insurance lots): avg $${cp.avg_price.toLocaleString()} ${currency}, median $${cp.median_price.toLocaleString()}, avg mileage ${cp.avg_mileage.toLocaleString()} ${distanceUnit} — these are WHOLESALE/SALVAGE values, expect retail to be 40–80% higher`)
    }

    const liveDataBlock = liveDataLines.length
      ? `\nREAL SCRAPED MARKET DATA — use these as your primary anchors for pricing, mileage, and days-on-market:\n${liveDataLines.join('\n')}\n`
      : `\nNo live scrape data available — use your training knowledge of the ${marketLabel} market.\n`

    // Compute combined avg days online across retail platforms (for days_on_market_estimate rule)
    const allDaysSamples = [scraped.autotrader, scraped.cargurus]
      .filter(s => s?.avg_days_online != null)
    const combinedAvgDays = allDaysSamples.length
      ? Math.round(allDaysSamples.reduce((a, b) => a + b.avg_days_online, 0) / allDaysSamples.length)
      : null

    // Marketplace-specific instructions for the JSON output
    const atInstruction = scraped.autotrader
      ? `"avg": ${scraped.autotrader.avg_price}, "estimated_listings": "~${scraped.autotrader.count} listings", "avg_mileage": ${scraped.autotrader.avg_mileage}`
      : `"avg": <integer ${currency} realistic avg for this vehicle on ${src1}>, "estimated_listings": "<e.g. ~40 listings>", "avg_mileage": <integer>`
    const cgInstruction = scraped.cargurus
      ? `"avg": ${scraped.cargurus.avg_price}, "estimated_listings": "~${scraped.cargurus.count} listings", "avg_mileage": ${scraped.cargurus.avg_mileage}`
      : `"avg": <integer ${currency}>, "estimated_listings": "<e.g. ~25 listings>", "avg_mileage": <integer>`

    const prompt = `You are a professional automotive market analyst with dealer-grade accuracy, equivalent to vAuto or Black Book. You specialize in the ${marketLabel} used vehicle market and have deep knowledge of real retail listing prices on ${marketSources.join(', ')}.

VEHICLE TO ANALYZE:
${vehicle.year} ${vehicle.make} ${vehicle.model}${trimText}
Listed price: ${vehicle.price ? '$' + Number(vehicle.price).toLocaleString() + ' ' + currency : 'unknown'}
Condition: ${conditionLabel}
Mileage: ${mileageText}
${vehicle.exterior_color ? `Colour: ${vehicle.exterior_color}` : ''}
Vehicle age: ${vehicleAge} year(s) old (${currentYear} model year context: ${vehicle.year})
Mileage context: ${mileageContext}
${liveDataBlock}
CRITICAL RULES — accuracy is paramount:
1. Compare ONLY against listings that match on ALL of: same MODEL (${vehicle.make} ${vehicle.model}), same YEAR (${vehicle.year}), same TRIM (${vehicle.trim || 'base'}), same CONDITION (${conditionLabel}), and comparable MILEAGE (within roughly ±30% of ${mileageText}) in the ${location} area. Discard any comp that differs in trim, is a different model year, or has wildly different mileage — those are NOT valid comparables and must not pull the average up or down.
2. NEW vehicles: compare against new ${vehicle.year} ${vehicle.make} ${vehicle.model} at MSRP
3. ALL prices MUST be in ${currency} reflecting the ACTUAL ${marketLabel} retail market — do NOT use US prices for Canadian vehicles or vice versa
4. ${isUS ? 'US retail prices are typically 15–25% lower in USD than equivalent Canadian CAD prices.' : 'Canadian retail prices in CAD are typically 25–35% higher than the same vehicle in USD due to currency, taxes, and import costs.'}
5. If LIVE SCRAPED data is provided above, anchor your mid price and market_avg_mileage to that data — do not deviate by more than 5%
6. Mileage rating MUST accurately reflect the delta vs expected mileage — if mileage is ABOVE expected it is above/well above average, if BELOW it is below/well below average
7. price_to_market_pct: compute as Math.round((listedPrice / mid) * 100) where listedPrice = ${vehicle.price || 0}
8. days_on_market_estimate: ${combinedAvgDays != null ? `The scraped market average days online is ${combinedAvgDays} days — use this as your baseline, then adjust up/down based on how this vehicle's price compares to market mid` : 'estimate realistically based on price-to-market — overpriced vehicles take longer, well-priced take less'}
9. Each marketplace has slightly different avg prices — reflect this realistically
10. You MUST return ALL fields in the JSON — do not omit any field
11. This report is used by professional auto dealers — be precise and realistic, not generic

Respond with ONLY valid JSON (no markdown, no explanation, no trailing commas):
{
  "low": <integer ${currency}, lower bound of fair retail range for this exact vehicle>,
  "mid": <integer ${currency}, typical asking price for comparable listings>,
  "high": <integer ${currency}, upper bound — well-equipped or low-mileage premium>,
  "currency": "${currency}",
  "price_to_market_pct": <integer, listed price as % of mid, e.g. 98 = 2% below market>,
  "days_on_market_estimate": <integer, realistic days to sell at listed price>,
  "confidence": "high" | "medium" | "low",
  "note": "<two specific sentences about this exact vehicle's market demand, trim desirability, mileage position, and regional pricing in ${location}>",
  "marketplace_averages": [
    { "name": "${src1}", ${atInstruction} },
    { "name": "${src2}", ${cgInstruction} },
    { "name": "${src3}", "avg": <integer ${currency}>, "estimated_listings": "<e.g. ~55 listings>", "avg_mileage": <integer> }
  ],
  "mileage_analysis": {
    "market_avg_mileage": <integer, ${scraped.autotrader || scraped.cargurus ? 'anchor to live scraped avg_mileage above' : `realistic average ${distanceUnit} for used ${vehicle.year} ${vehicle.make} ${vehicle.model}${trimText} listings in ${location}`}>,
    "mileage_rating": "well below average" | "below average" | "average" | "above average" | "well above average",
    "mileage_price_impact": <integer ${currency}, realistic dollar premium (positive) or discount (negative) vs same vehicle at average mileage — typically $500–$3000 range>,
    "mileage_note": "<one precise sentence: state actual mileage vs market avg and the pricing implication>"
  }
}`

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
    let estimate = null

    // Ask for the report, retrying once if the model returns unparseable output.
    let lastErr = null
    for (let attempt = 0; attempt < 2 && !estimate; attempt++) {
      try {
        const message = await anthropic.messages.create({
          model: 'claude-sonnet-5',
          max_tokens: 1600,
          system: 'You are a precise automotive pricing engine. Respond with ONLY a single valid JSON object and nothing else — no prose, no markdown fences.',
          messages: [{ role: 'user', content: prompt }]
        })
        // Concatenate ALL text blocks (not just content[0]) so nothing is dropped.
        const text = (message.content || [])
          .filter(b => b.type === 'text' && b.text)
          .map(b => b.text).join('').trim()
        const jsonText = text.replace(/^```json?\s*/i, '').replace(/```\s*$/i, '').trim()
        try {
          estimate = JSON.parse(jsonText)
        } catch {
          const braced = jsonText.match(/\{[\s\S]*\}/)
          if (!braced) throw new Error('no JSON object in AI response')
          estimate = JSON.parse(braced[0])
        }
      } catch (aiErr) {
        lastErr = aiErr
        // On a credit/billing/rate error, don't waste a second attempt.
        if (/credit|billing|payment|429|rate.?limit/i.test(String(aiErr?.message || ''))) break
      }
    }
    if (!estimate) {
      return res.status(502).json({ error: aiErrorMessage(lastErr) })
    }

    const pct_diff = estimate?.mid
      ? Math.round(((yourPrice - estimate.mid) / estimate.mid) * 1000) / 10
      : null

    const payload = {
      vehicle,
      estimate,
      pct_diff,
      data_source: dataSource,
      copart: scraped.copart ? {
        avg_price: scraped.copart.avg_price,
        median_price: scraped.copart.median_price,
        avg_mileage: scraped.copart.avg_mileage,
        count: scraped.copart.count,
      } : null,
    }

    // Cache the report for a week (keyed by vehicle; keyed price lets us bust it
    // early if the asking price changes). Fire-and-forget — never block the response.
    supabaseAdmin.from('price_reports').upsert({
      inventory_id: inventory_id,
      dealership_id: req.dealershipId,
      report: payload,
      price_at_generation: yourPrice,
      generated_at: new Date().toISOString(),
    }, { onConflict: 'inventory_id' }).then(({ error }) => {
      if (error) console.warn('[price-report] cache write failed:', error.message)
    })

    res.json(payload)
  })

  // ── Repricing Rules ──────────────────────────────────────────────────────

  app.get('/ai/repricing-rules', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership associated' })
    const { data, error } = await supabaseAdmin
      .from('dealerships')
      .select('repricing_rules')
      .eq('id', req.dealershipId)
      .single()
    if (error) return res.status(500).json({ error: error.message })
    res.json({ rules: data.repricing_rules || { enabled: false, days_on_lot_threshold: 45, price_drop_pct: 5, overprice_threshold_pct: 20 } })
  })

  app.put('/ai/repricing-rules', requireAuth, requireDealerAdmin, async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership associated' })
    const { enabled, days_on_lot_threshold, price_drop_pct, overprice_threshold_pct } = req.body
    const rules = { enabled: !!enabled, days_on_lot_threshold: Number(days_on_lot_threshold) || 45, price_drop_pct: Number(price_drop_pct) || 5, overprice_threshold_pct: Number(overprice_threshold_pct) || 20 }
    const { error } = await supabaseAdmin
      .from('dealerships')
      .update({ repricing_rules: rules })
      .eq('id', req.dealershipId)
    if (error) return res.status(500).json({ error: error.message })
    res.json({ rules })
  })

  app.post('/ai/repricing-apply', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership associated' })

    const { data: dealer } = await supabaseAdmin
      .from('dealerships')
      .select('inv_intel_active, repricing_rules, country, province, postal_code')
      .eq('id', req.dealershipId)
      .single()

    const isOwner = (req.user.email || '').toLowerCase() === OWNER_EMAIL
    if (!isOwner && !dealer?.inv_intel_active) return res.status(403).json({ error: 'Inventory Intelligence not active' })

    const rules = dealer.repricing_rules || { enabled: false, days_on_lot_threshold: 45, price_drop_pct: 5, overprice_threshold_pct: 20 }
    const { days_on_lot_threshold, price_drop_pct, overprice_threshold_pct } = rules
    const _reIsUS = (() => {
      const c = (dealer?.country || '').trim().toUpperCase()
      return c === 'US' || c === 'USA' || c === 'UNITED STATES'
    })()

    const { data: vehicles, error } = await supabaseAdmin
      .from('inventory')
      .select('id, year, make, model, trim, price, mileage, condition, last_synced_at, created_at')
      .eq('dealership_id', req.dealershipId)
      .eq('status', 'available')
    if (error) return res.status(500).json({ error: error.message })

    const now = Date.now()
    const suggestions = []

    for (const vehicle of vehicles || []) {
      // Days on lot = time since the unit first appeared (created_at). last_synced_at
      // is rewritten to "now" on every feed sync, so it can NEVER be used for aging —
      // it would keep the count near 0 and nothing would ever flag.
      const refDate = vehicle.created_at || vehicle.last_synced_at
      const daysOnLot = refDate ? Math.floor((now - new Date(refDate).getTime()) / 86400000) : 0
      if (daysOnLot < days_on_lot_threshold) continue
      if (!vehicle.price || !vehicle.make || !vehicle.model) continue
      if (skipPriceComp(vehicle)) continue // new / current-year units have no used-market comp

      // Compare against the MARKET (MarketCheck/scraper — same source as the price
      // report), so a unit priced above real market gets flagged even when it's in
      // line with the store's own copies. Fall back to the internal-inventory median
      // when no market data is available.
      let med = null
      const mm = await marketMedianForScan({ vehicle, dealer, isUS: _reIsUS, dealershipId: req.dealershipId, isOwner: (req.user.email || '').toLowerCase() === OWNER_EMAIL, allowLive: true })
      if (mm?.median) med = mm.median
      if (!med) {
        const { data: comps } = await supabaseAdmin
          .from('inventory')
          .select('price')
          .eq('dealership_id', req.dealershipId)
          .eq('make', vehicle.make)
          .eq('model', vehicle.model)
          .eq('status', 'available')
          .gte('year', vehicle.year - 2)
          .lte('year', vehicle.year + 2)
          .neq('id', vehicle.id)
          .not('price', 'is', null)
        const prices = (comps || []).map(c => Number(c.price)).filter(p => p > 0).sort((a, b) => a - b)
        med = median(prices)
      }
      if (!med) continue

      const pct_diff = ((Number(vehicle.price) - med) / med) * 100
      if (pct_diff <= overprice_threshold_pct) continue

      const suggestedPrice = Math.round(Number(vehicle.price) * (1 - price_drop_pct / 100))
      const label = [vehicle.year, vehicle.make, vehicle.model, vehicle.trim].filter(Boolean).join(' ')
      const note = `${daysOnLot} days on lot — suggest reducing price by ${price_drop_pct}% to $${suggestedPrice.toLocaleString()} (currently ${Math.round(pct_diff)}% above median $${Math.round(med).toLocaleString()})`

      suggestions.push({ inventory_id: vehicle.id, vehicle_label: label, note, days_on_lot: daysOnLot, suggested_price: suggestedPrice })

      await supabaseAdmin.from('ai_activity').insert({
        dealership_id: req.dealershipId,
        inventory_id: vehicle.id,
        actor_id: req.user.id,
        vehicle_label: label,
        warnings: [note],
        price_flagged: true,
        price_pct_diff: Math.round(pct_diff * 10) / 10,
        price_median: med,
        copy_generated: false
      }).then(() => {}).catch(() => {})
    }

    res.json({ flagged: suggestions.length, suggestions })
  })

  // ── Stocking Recommendations ─────────────────────────────────────────────

  app.get('/ai/stocking-recommendations', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership associated' })

    const { data: dealer } = await supabaseAdmin
      .from('dealerships')
      .select('inv_intel_active, stocking_recs, stocking_recs_at')
      .eq('id', req.dealershipId)
      .single()

    const isOwner = (req.user.email || '').toLowerCase() === OWNER_EMAIL
    if (!isOwner && !dealer?.inv_intel_active) return res.status(403).json({ error: 'Inventory Intelligence not active' })

    // Serve the cached set for 24h unless a refresh is explicitly requested. Keeps the
    // panel instant and always populated, and caps Claude spend to ~once/day/dealer.
    const refresh = req.query.refresh === '1'
    const CACHE_MS = 24 * 60 * 60 * 1000
    if (!refresh && dealer?.stocking_recs_at && Array.isArray(dealer.stocking_recs) && dealer.stocking_recs.length &&
        (Date.now() - new Date(dealer.stocking_recs_at).getTime()) < CACHE_MS) {
      return res.json({ recommendations: dealer.stocking_recs, generated_at: dealer.stocking_recs_at, cached: true })
    }

    // A unit's last_synced_at is the last time it appeared in the feed — i.e. roughly
    // when it sold and dropped off. Feeds refresh in bursts, so a strict 30-day window
    // often catches nothing; look back 90 days so there's real sell-through signal.
    const soldSince = new Date(Date.now() - 90 * 86400000).toISOString()

    const [{ data: sold }, { data: current }, { data: competitors }] = await Promise.all([
      supabaseAdmin
        .from('inventory')
        .select('make, model, year')
        .eq('dealership_id', req.dealershipId)
        .in('status', ['sold', 'archived'])
        .gte('last_synced_at', soldSince)
        .order('last_synced_at', { ascending: false })
        .limit(200),
      supabaseAdmin
        .from('inventory')
        .select('id, make, model, year, price, status, stocknumber')
        .eq('dealership_id', req.dealershipId)
        .eq('status', 'available'),
      supabaseAdmin
        .from('competitor_dealerships')
        .select('name, last_scan_result')
        .eq('dealership_id', req.dealershipId)
        .not('last_scanned_at', 'is', null)
    ])

    // Tally sell-through by make/model
    const sellMap = {}
    for (const v of sold || []) {
      const k = `${v.make}|${v.model}`
      sellMap[k] = (sellMap[k] || { make: v.make, model: v.model, sold: 0 })
      sellMap[k].sold++
    }
    const sell_through = Object.values(sellMap).sort((a, b) => b.sold - a.sold).slice(0, 20)

    // Current stock with IDs for linking
    const stockMap = {}
    for (const v of current || []) {
      const k = `${v.make}|${v.model}`
      if (!stockMap[k]) stockMap[k] = { count: 0, units: [] }
      stockMap[k].count++
      stockMap[k].units.push({ id: v.id, stocknumber: v.stocknumber || null })
    }

    // Summarise competitor stock from last scan results
    const competitorSummary = (competitors || [])
      .filter(c => c.last_scan_result && !c.last_scan_result.error)
      .map(c => {
        const r = c.last_scan_result
        const topModels = Array.isArray(r.top_models) ? r.top_models.slice(0, 5).join(', ') : ''
        const total = r.total_listings ?? r.unit_count ?? '?'
        return `- ${c.name}: ${total} units on lot${topModels ? '; top models: ' + topModels : ''}`
      }).join('\n')

    // Deterministic fallback so the panel ALWAYS shows recommendations even when the
    // AI call fails, the key is missing, or the daily AI budget is spent.
    const buildFallback = () => {
      const out = []
      const seen = new Set()
      // 1) Proven movers from recent sell-through.
      for (const s of sell_through) {
        const k = `${s.make}|${s.model}`
        if (seen.has(k)) continue
        seen.add(k)
        const inStock = stockMap[k]
        out.push({
          make: s.make, model: s.model, year_range: 'recent',
          reason: inStock
            ? `Strong seller — ${s.sold} sold recently with only ${inStock.count} now in stock. Restock to keep up with demand.`
            : `Sold ${s.sold} recently but none currently in stock — a proven mover worth re-acquiring.`,
          priority: s.sold >= 3 ? 'high' : (s.sold >= 2 ? 'medium' : 'low'),
          existing_units: inStock ? inStock.units.slice(0, 3).map(u => ({ id: u.id, stocknumber: u.stocknumber })) : []
        })
        if (out.length >= 5) return out
      }
      // 2) Top up from current stock composition (core models that fit this lot).
      const byCount = Object.entries(stockMap).sort((a, b) => b[1].count - a[1].count)
      for (const [k, d] of byCount) {
        if (seen.has(k)) continue
        seen.add(k)
        const [make, model] = k.split('|')
        out.push({
          make, model, year_range: 'recent',
          reason: `A core model on your lot (${d.count} in stock). Keep it stocked — it's a consistent fit for your buyers.`,
          priority: 'low',
          existing_units: d.units.slice(0, 3).map(u => ({ id: u.id, stocknumber: u.stocknumber }))
        })
        if (out.length >= 5) return out
      }
      // 3) Generic starter set (brand-new lot with no data yet).
      const starters = [
        { make: 'Chevrolet', model: 'Silverado 1500', reason: 'Full-size pickups are the highest-demand segment in Ontario — a reliable, fast-turning acquisition.' },
        { make: 'GMC', model: 'Sierra 1500', reason: 'Strong truck demand and healthy margins; pairs well with Silverado stock.' },
        { make: 'Chevrolet', model: 'Equinox', reason: 'Compact SUVs are the volume segment for Canadian families — quick turn, broad appeal.' },
        { make: 'GMC', model: 'Terrain', reason: 'Popular compact SUV with steady used demand across Ontario.' },
        { make: 'Chevrolet', model: 'Trax', reason: 'Affordable entry SUV — strong for first-time and budget buyers.' }
      ]
      for (const s of starters) {
        if (out.length >= 5) break
        out.push({ ...s, year_range: 'recent', priority: 'medium', existing_units: [] })
      }
      return out.slice(0, 5)
    }

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
    let recommendations = []
    try {
      if (!process.env.ANTHROPIC_API_KEY || !(await aiAllowed(req.dealershipId, isOwner))) throw new Error('ai_unavailable')
      const message = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1200,
        messages: [{
          role: 'user',
          content: `You are an automotive inventory strategist for a Canadian GM dealership in Ontario, Canada. Based on this dealership's recent sell-through data, current stock, and nearby competitor lots, recommend 5 specific vehicle acquisitions. Factor in Canadian market conditions (fuel prices, weather, rural vs urban mix), Ontario buyer preferences, seasonal demand, Canadian government incentives (iZEV program, Ontario rebates) — do NOT reference US programs. Also consider what competitors are stocking heavily (avoid oversupplied models) and where gaps exist.

Recent sell-through:
${sell_through.map(s => `- ${s.make} ${s.model}: ${s.sold} sold`).join('\n') || 'No sold data available yet'}

Current stock (available units):
${Object.entries(stockMap).map(([k, d]) => `- ${k.replace('|', ' ')}: ${d.count} units (${d.units.slice(0, 3).map(u => `id:${u.id}${u.stocknumber ? ' stock:' + u.stocknumber : ''}`).join(', ')}${d.units.length > 3 ? '…' : ''})`).join('\n') || 'No current stock'}
${competitorSummary ? `\nNearby competitor lots (scanned):\n${competitorSummary}` : ''}

Return ONLY valid JSON array (no markdown):
[{"make":"...","model":"...","year_range":"...","reason":"...","priority":"high|medium|low","existing_units":[{"id":"...","stocknumber":"..."}]}]
- "existing_units": array of {id, stocknumber} objects from the current stock list that match this make/model; empty array if none in stock
(exactly 5 items)`
        }]
      })
      const text = message.content[0]?.text?.trim().replace(/^```json?\s*/i, '').replace(/```\s*$/i, '') || '[]'
      recommendations = JSON.parse(text)
    } catch {
      recommendations = []
    }

    // Guarantee a populated list — fall back to the deterministic set when the AI
    // returned nothing usable.
    if (!Array.isArray(recommendations) || !recommendations.length) {
      recommendations = buildFallback()
    }

    const generated_at = new Date().toISOString()
    // Persist for the 24h cache (best-effort — never block the response).
    supabaseAdmin.from('dealerships')
      .update({ stocking_recs: recommendations, stocking_recs_at: generated_at })
      .eq('id', req.dealershipId)
      .then(() => {}).catch(() => {})

    res.json({ recommendations, sell_through, generated_at })
  })

  // ── Inventory Intelligence ────────────────────────────────────────────────
  app.get('/ai/inventory-intelligence', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership associated' })

    const { data: dealer } = await supabaseAdmin
      .from('dealerships')
      .select('inv_intel_active, name')
      .eq('id', req.dealershipId)
      .single()

    const isOwner = (req.user.email || '').toLowerCase() === OWNER_EMAIL
    if (!isOwner && !dealer?.inv_intel_active) return res.status(403).json({ error: 'Inventory Intelligence not active' })

    const since90  = new Date(Date.now() -  90 * 86400000).toISOString()
    const since30  = new Date(Date.now() -  30 * 86400000).toISOString()
    const since180 = new Date(Date.now() - 180 * 86400000).toISOString()

    const [{ data: available }, { data: sold90 }, { data: sold30 }] = await Promise.all([
      supabaseAdmin
        .from('inventory')
        .select('id, vin, stocknumber, make, model, year, condition, price, mileage, description, image_urls, created_at, photo_score, photo_flags, photo_checked_at')
        .eq('dealership_id', req.dealershipId)
        .eq('status', 'available'),
      supabaseAdmin
        .from('inventory')
        .select('make, model, year, condition, last_synced_at')
        .eq('dealership_id', req.dealershipId)
        .in('status', ['sold', 'archived'])
        .gte('last_synced_at', since90),
      supabaseAdmin
        .from('inventory')
        .select('make, model, year, condition, last_synced_at')
        .eq('dealership_id', req.dealershipId)
        .in('status', ['sold', 'archived'])
        .gte('last_synced_at', since30),
    ])

    const vehicles = available || []

    // ── 1. Duplicate VIN detection ─────────────────────────────────────────
    const vinCount = {}
    for (const v of vehicles) {
      const vin = (v.vin || '').trim().toUpperCase()
      if (!vin || vin.length < 6) continue
      if (!vinCount[vin]) vinCount[vin] = []
      vinCount[vin].push({ id: v.id, stock: v.stocknumber || v.stock_number || '', year: v.year, make: v.make, model: v.model })
    }
    const duplicateVins = Object.entries(vinCount)
      .filter(([, arr]) => arr.length > 1)
      .map(([vin, units]) => ({ vin, units }))

    // ── 2. Segment velocity (by make × model) ─────────────────────────────
    const seg90 = {}, seg30 = {}
    for (const v of sold90 || []) {
      const k = `${v.make}|${v.model}`
      seg90[k] = (seg90[k] || 0) + 1
    }
    for (const v of sold30 || []) {
      const k = `${v.make}|${v.model}`
      seg30[k] = (seg30[k] || 0) + 1
    }

    const stockBySegment = {}
    for (const v of vehicles) {
      const k = `${v.make}|${v.model}`
      if (!stockBySegment[k]) stockBySegment[k] = { make: v.make, model: v.model, units: [] }
      stockBySegment[k].units.push(v)
    }

    const allSegments = new Set([
      ...Object.keys(seg90),
      ...Object.keys(seg30),
      ...Object.keys(stockBySegment),
    ])

    const velocity = []
    for (const k of allSegments) {
      const [make, model] = k.split('|')
      const s30 = seg30[k] || 0
      const s90 = seg90[k] || 0
      const stock = (stockBySegment[k]?.units || []).length
      // Turn rate = monthly velocity / current stock (months of supply, lower = faster)
      const monthlyVelocity = s90 / 3  // avg sold per month over 90d
      const monthsOfSupply = monthlyVelocity > 0 ? Math.round((stock / monthlyVelocity) * 10) / 10 : null
      velocity.push({ make, model, sold_30d: s30, sold_90d: s90, current_stock: stock, monthly_velocity: Math.round(monthlyVelocity * 10) / 10, months_of_supply: monthsOfSupply })
    }
    velocity.sort((a, b) => (b.sold_90d - a.sold_90d) || (a.months_of_supply ?? 99) - (b.months_of_supply ?? 99))

    // Hot: selling fast, low stock
    const hot = velocity
      .filter(s => s.monthly_velocity > 0 && s.current_stock < 3)
      .sort((a, b) => b.monthly_velocity - a.monthly_velocity)
      .slice(0, 5)

    // Cold: stock sitting but not moving
    const cold = velocity
      .filter(s => s.current_stock >= 2 && s.monthly_velocity < 1)
      .sort((a, b) => b.current_stock - a.current_stock)
      .slice(0, 5)

    // ── 3. Per-vehicle health score ────────────────────────────────────────
    const now = Date.now()
    const scoredVehicles = vehicles.map(v => {
      // Photos (30 pts max)
      const photoCount = Array.isArray(v.image_urls) ? v.image_urls.length : (v.image_urls ? 1 : 0)
      const photoScore = photoCount >= 10 ? 30 : photoCount >= 5 ? 20 : photoCount >= 1 ? 10 : 0

      // Days on lot (25 pts max)
      const days = Math.round((now - new Date(v.created_at).getTime()) / 86400000)
      const daysScore = days < 15 ? 25 : days < 30 ? 20 : days < 60 ? 10 : days < 90 ? 5 : 0

      // Price set (15 pts)
      const priceScore = v.price > 0 ? 15 : 0

      // Mileage set (10 pts)
      const mileageScore = v.mileage > 0 ? 10 : 0

      // Description (10 pts)
      const descScore = (v.description || '').trim().length > 50 ? 10 : 0

      // Fields complete (10 pts)
      const completeScore = [v.year, v.make, v.model, v.condition].every(Boolean) ? 10 : 0

      const score = photoScore + daysScore + priceScore + mileageScore + descScore + completeScore

      const stock = v.stocknumber || ''
      return {
        id: v.id,
        stock,
        year: v.year,
        make: v.make,
        model: v.model,
        condition: v.condition,
        price: v.price,
        days,
        photos: photoCount,
        // AI Vision photo-quality score/flags (folded into health — no separate page).
        photo_score: v.photo_score ?? null,
        photo_flags: Array.isArray(v.photo_flags) ? v.photo_flags : [],
        photo_checked_at: v.photo_checked_at ?? null,
        score,
        breakdown: { photos: photoScore, days: daysScore, price: priceScore, mileage: mileageScore, description: descScore, fields: completeScore },
        issues: [
          photoCount === 0 && 'No photos',
          !(v.price > 0) && 'No price',
          !(v.mileage > 0) && 'No mileage',
          !(v.description?.trim().length > 50) && 'Short/no description',
          days >= 60 && `${days}d on lot`,
        ].filter(Boolean),
      }
    }).sort((a, b) => a.score - b.score)  // lowest health first

    // ── 4. Summary stats ──────────────────────────────────────────────────
    const avgScore = vehicles.length
      ? Math.round(scoredVehicles.reduce((s, v) => s + v.score, 0) / vehicles.length)
      : 0
    const needsAttention = scoredVehicles.filter(v => v.score < 50).length

    res.json({
      summary: { total: vehicles.length, avg_score: avgScore, needs_attention: needsAttention, duplicate_vins: duplicateVins.length },
      velocity: velocity.slice(0, 30),
      hot_segments: hot,
      cold_segments: cold,
      duplicate_vins: duplicateVins,
      vehicles: scoredVehicles,
      narrative: null,
      generated_at: new Date().toISOString(),
    })
  })

  // ── Inventory Narrative (separate — Anthropic call kept off the hot path) ─
  app.post('/ai/inventory-narrative', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership associated' })
    const isOwner = (req.user.email || '').toLowerCase() === OWNER_EMAIL
    const { data: dealer } = await supabaseAdmin
      .from('dealerships')
      .select('inv_intel_active')
      .eq('id', req.dealershipId)
      .single()
    if (!isOwner && !dealer?.inv_intel_active) return res.status(403).json({ error: 'Inventory Intelligence not active' })
    if (!process.env.ANTHROPIC_API_KEY) return res.json({ narrative: null })

    const { total, avg_score, needs_attention, duplicate_vins, hot, cold, top_movers, no_photos, stale } = req.body
    try {
      const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
      const prompt = `You are an automotive inventory analyst for a Canadian dealership. Analyze this lot data and return exactly 5 bullet-point insights — each under 20 words, specific, actionable. Return ONLY a JSON array of strings (no markdown):

Lot: ${total} available | avg health score: ${avg_score}/100 | ${needs_attention} units need attention
Hot segments (low stock, selling fast): ${(hot || []).join('; ') || 'none'}
Cold segments (high stock, slow moving): ${(cold || []).join('; ') || 'none'}
Top movers 90d: ${(top_movers || []).join(', ')}
Duplicate VINs: ${duplicate_vins}
Units without photos: ${no_photos}
Units 60d+ on lot: ${stale}`
      const msg = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 400,
        messages: [{ role: 'user', content: prompt }]
      })
      const text = msg.content[0]?.text?.trim().replace(/^```json?\s*/i, '').replace(/```\s*$/i, '') || '[]'
      res.json({ narrative: JSON.parse(text) })
    } catch {
      res.json({ narrative: null })
    }
  })

  // ── AI Vision — photo quality scoring (part of AI Boost) ─────────────────

  async function visionActive(dealershipId, email) {
    if ((email || '').toLowerCase() === OWNER_EMAIL) return true
    const { data } = await supabaseAdmin
      .from('dealerships').select('ai_boost_active').eq('id', dealershipId).single()
    return !!data?.ai_boost_active
  }

  // Kick off a background photo scan of the dealership's inventory.
  app.post('/ai/vision/scan', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership associated' })
    if (!await visionActive(req.dealershipId, req.user.email)) {
      return res.status(403).json({ error: 'AI Vision not active' })
    }
    const rescan = req.query.rescan === '1' || req.body?.rescan === true
    // Grab vehicles that still need scoring: never checked, or the photo count
    // changed since the last check (so a unit scored before its photos synced gets
    // re-scored instead of being stuck at "No photos"). ?rescan=1 forces all.
    const { data: pending } = await supabaseAdmin.from('inventory')
      .select('id, image_urls, photo_checked_at, photo_analysis')
      .eq('dealership_id', req.dealershipId).eq('status', 'available')
      .order('created_at', { ascending: false }).limit(600)
    const todo = (pending || []).filter(r => {
      if (rescan || !r.photo_checked_at) return true
      const cur = Array.isArray(r.image_urls) ? r.image_urls.filter(Boolean).length : 0
      const prev = r.photo_analysis?.photo_count ?? null
      return prev !== cur
    })

    // Score a small first batch synchronously so results appear the instant the
    // scan returns — on big stores the fully-background job is slow/unreliable on
    // the host and the user was left staring at an empty page. The rest runs in
    // the background as before.
    const FIRST_BATCH = 6
    const head = todo.slice(0, FIRST_BATCH)
    await Promise.all(head.map(async row => {
      try {
        const { score, flags, analysis } = await scoreVehiclePhotos(row)
        await supabaseAdmin.from('inventory').update({
          photo_score: score, photo_flags: flags, photo_analysis: analysis,
          photo_checked_at: new Date().toISOString(),
        }).eq('id', row.id)
        if (analysis?.gallery) recordUsage(req.dealershipId, { ai: 1 })
      } catch (e) { console.warn('[ai-vision] first-batch score failed:', e.message) }
    }))

    res.json({ status: 'scanning', total: todo.length, scored_now: head.length })
    // Fire-and-forget the remainder — results land on the inventory rows.
    if (todo.length > FIRST_BATCH) {
      runPhotoVision(req.dealershipId, { rescan }).catch(e => console.warn('[ai-vision] scan failed:', e.message))
    }
  })

  // Return scored vehicles (worst first) + a summary.
  app.get('/ai/vision/results', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership associated' })
    if (!await visionActive(req.dealershipId, req.user.email)) {
      return res.status(403).json({ error: 'AI Vision not active' })
    }
    const { data, error } = await supabaseAdmin
      .from('inventory')
      .select('id, year, make, model, trim, stocknumber, image_urls, photo_score, photo_flags, photo_checked_at')
      .eq('dealership_id', req.dealershipId)
      .eq('status', 'available')
    if (error) return res.status(500).json({ error: error.message })

    const rows = data || []
    const scored = rows.filter(r => r.photo_checked_at)
    const vehicles = scored
      .map(r => ({
        id: r.id,
        label: [r.year, r.make, r.model, r.trim].filter(Boolean).join(' '),
        stocknumber: r.stocknumber || null,
        photo_count: Array.isArray(r.image_urls) ? r.image_urls.length : 0,
        thumb: Array.isArray(r.image_urls) ? r.image_urls[0] : null,
        score: r.photo_score ?? 0,
        flags: r.photo_flags || [],
      }))
      .sort((a, b) => a.score - b.score)

    const avg = scored.length ? Math.round(scored.reduce((s, r) => s + (r.photo_score || 0), 0) / scored.length) : null
    res.json({
      summary: {
        total: rows.length,
        scored: scored.length,
        unscored: rows.length - scored.length,
        avg_score: avg,
        needs_attention: vehicles.filter(v => v.score < 50).length,
        no_photos: vehicles.filter(v => v.photo_count === 0).length,
      },
      vehicles,
    })
  })

  // ── Competitor Monitoring ────────────────────────────────────────────────

  app.get('/ai/competitors', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership associated' })
    const { data, error } = await supabaseAdmin
      .from('competitor_dealerships')
      .select('*')
      .eq('dealership_id', req.dealershipId)
      .order('created_at', { ascending: true })
    if (error) return res.status(500).json({ error: error.message })
    res.json({ competitors: data || [] })
  })

  app.post('/ai/competitors', requireAuth, requireDealerAdmin, async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership associated' })
    const { name, autotrader_url } = req.body
    if (!name) return res.status(400).json({ error: 'name required' })
    const { data, error } = await supabaseAdmin
      .from('competitor_dealerships')
      .insert({ dealership_id: req.dealershipId, name, autotrader_url: autotrader_url || null })
      .select()
      .single()
    if (error) return res.status(500).json({ error: error.message })
    res.json({ competitor: data })
  })

  app.patch('/ai/competitors/:id', requireAuth, requireDealerAdmin, async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership associated' })
    const { autotrader_url } = req.body || {}
    const { data, error } = await supabaseAdmin
      .from('competitor_dealerships')
      .update({ autotrader_url: autotrader_url || null })
      .eq('id', req.params.id)
      .eq('dealership_id', req.dealershipId)
      .select()
      .single()
    if (error) return res.status(500).json({ error: error.message })
    res.json({ competitor: data })
  })

  app.delete('/ai/competitors/:id', requireAuth, requireDealerAdmin, async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership associated' })
    const { error } = await supabaseAdmin
      .from('competitor_dealerships')
      .delete()
      .eq('id', req.params.id)
      .eq('dealership_id', req.dealershipId)
    if (error) return res.status(500).json({ error: error.message })
    res.json({ deleted: true })
  })

  app.post('/ai/competitors/scan', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership associated' })

    const { data: dealer } = await supabaseAdmin
      .from('dealerships')
      .select('ai_boost_active, country')
      .eq('id', req.dealershipId)
      .single()

    const isOwner = (req.user.email || '').toLowerCase() === OWNER_EMAIL
    if (!isOwner && !dealer?.ai_boost_active) return res.status(403).json({ error: 'AI Boost not active' })

    const _compIsUS = (() => {
      const c = (dealer?.country || '').trim().toUpperCase()
      return c === 'US' || c === 'USA' || c === 'UNITED STATES'
    })()

    const { data: competitors } = await supabaseAdmin
      .from('competitor_dealerships')
      .select('*')
      .eq('dealership_id', req.dealershipId)

    // Attempt to extract inventory data from a competitor URL.
    // Strategy 1: Use detectFeedPlatform — probes known DMS API endpoints
    //   (EDealer, CDK, Dealer Inspire, Sincro, etc.) from the site's origin.
    //   Works on any homepage URL, returns actual vehicle count and prices.
    // Strategy 2: HTML scraping — AutoTrader embedded JSON or generic patterns.
    // Parse Schema.org Car/Vehicle JSON-LD listings from HTML
    function parseSchemaOrg(html) {
      const prices = []
      let listing_count = null
      const scriptRe = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
      let m
      while ((m = scriptRe.exec(html)) !== null) {
        try {
          const blob = JSON.parse(m[1])
          const items = Array.isArray(blob) ? blob : (blob['@graph'] ? blob['@graph'] : [blob])
          for (const item of items) {
            const type = item['@type'] || ''
            if (/Car|Vehicle|Product|Offer/i.test(type)) {
              const price = Number(item?.offers?.price ?? item?.price ?? 0)
              if (price > 1000 && price < 500_000) prices.push(price)
            }
            if (/ItemList/i.test(type) && item.numberOfItems) listing_count = Number(item.numberOfItems)
          }
        } catch {}
      }
      return { prices, listing_count }
    }

    // Try common dealer JSON feed paths that bypass WAF HTML blocks
    async function tryJsonFeedFallback(origin) {
      const FEED_PATHS = [
        '/api/inventory?format=json&limit=200',
        '/inventory.json',
        '/vehicles.json',
        '/api/vehicles?limit=200',
        '/api/inventory/vehicles?limit=200',
        '/feeds/inventory.json',
      ]
      for (const path of FEED_PATHS) {
        try {
          const r = await browserFetch(origin + path, {
            signal: AbortSignal.timeout(8000),
            headers: { Accept: 'application/json' }
          })
          if (!r.ok) continue
          const ct = r.headers.get('content-type') || ''
          if (!ct.includes('json')) continue
          const data = await r.json()
          const arr = Array.isArray(data) ? data : (data.vehicles ?? data.inventory ?? data.items ?? data.listings ?? data.results ?? [])
          if (!Array.isArray(arr) || !arr.length) continue
          const prices = arr.map(v => Number(v.price ?? v.sellingPrice ?? v.listPrice ?? 0)).filter(p => p > 1000 && p < 500_000)
          if (prices.length) {
            const sorted = [...prices].sort((a, b) => a - b)
            return {
              listing_count: arr.length,
              avg_price: Math.round(prices.reduce((a, b) => a + b, 0) / prices.length),
              min_price: sorted[0],
              max_price: sorted[sorted.length - 1],
              platform: 'JSON feed',
              scanned_at: new Date().toISOString()
            }
          }
        } catch {}
      }
      return null
    }

    // Sitemap scan — the one method that reliably survives Cloudflare/WAF, because
    // dealer sites MUST expose an XML sitemap of their vehicle-detail (VDP) pages for
    // Google. We discover sitemaps via robots.txt (Cloudflare always serves it) plus
    // common paths, recurse sitemap indexes, and count VDP URLs. No JS page load, no
    // extension. Returns the inventory count + detected platform, or null.
    async function sitemapCountFallback(origin) {
      if (!origin) return null
      // A VDP URL is a single-vehicle detail page; exclude listing/showroom/blog pages.
      const EXCLUDE = /\/(vlp|srp|showroom|search|buildandprice|build-and-price|blog|category|page|author|tag|about|contact|service|parts|finance|specials|staff|reviews|directions)\/?/i
      // Match single-vehicle detail pages across the common dealer platforms.
      const INCLUDE = /\/(vdp|vehicle-details|vehicledetails)\b|\/(new|used|certified|pre-owned)\/[^/]+\/[^/]+|\/(vehicle|vehicles|inventory)\/[^/]*(19|20)\d{2}[-_ ][a-z]|\/(19|20)\d{2}-[a-z][a-z0-9-]+-[a-z0-9]+\/?$|[?&](vehicleid|vin|stock|stk)=/i
      const seen = new Set()
      let sniffedXml = ''
      const tried = new Set()

      // Cloudflare "Bot Fight Mode" blocks generic browser UAs but usually still
      // serves robots.txt/sitemaps to search crawlers, so if a normal read is
      // blocked we retry once as Googlebot before giving up.
      const GOOGLEBOT_UA = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'
      const fetchText = async (u, accept) => {
        for (const ua of [null, GOOGLEBOT_UA]) {
          try {
            const headers = { 'Accept': accept }
            if (ua) headers['User-Agent'] = ua
            const r = await browserFetch(u, { signal: AbortSignal.timeout(9000), headers })
            if (r.ok) return await r.text()
          } catch {}
        }
        return null
      }

      const collect = async (u, depth = 0) => {
        if (depth > 3 || seen.size > 8000 || tried.has(u)) return
        tried.add(u)
        const xml = await fetchText(u, 'application/xml, text/xml, */*')
        if (xml == null) return
        sniffedXml += xml.slice(0, 4000)
        const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/gi)].map(m => m[1].trim().replace(/&amp;/g, '&'))
        // Sitemap index → recurse into child sitemaps that look inventory-related first,
        // then any remaining ones if we still have no hits.
        if (/<sitemapindex/i.test(xml)) {
          const invChildren = locs.filter(c => /inventory|vehicle|listing|vdp|used|new|certified/i.test(c))
          for (const child of invChildren.slice(0, 15)) await collect(child, depth + 1)
          if (seen.size === 0) {
            for (const child of locs.slice(0, 8)) await collect(child, depth + 1)
          }
          return
        }
        for (const loc of locs) {
          if (INCLUDE.test(loc) && !EXCLUDE.test(loc)) seen.add(loc)
        }
      }

      // 1) robots.txt → Sitemap: entries (Cloudflare-friendly, dealer-agnostic).
      const sitemapUrls = []
      const robotsTxt = await fetchText(origin + '/robots.txt', 'text/plain, */*')
      if (robotsTxt) {
        for (const m of robotsTxt.matchAll(/^\s*sitemap:\s*(\S+)/gim)) sitemapUrls.push(m[1].trim())
      }

      // 2) common sitemap paths as a backstop (covers Dealer.com, DealerInspire,
      //    eDealer, Convertus, Sincro, DI, and WordPress dealer themes).
      const candidates = [
        ...sitemapUrls,
        origin + '/inventory-listing-sitemap.xml', origin + '/vehicles-sitemap.xml',
        origin + '/inventory-sitemap.xml', origin + '/inventory_sitemap.xml',
        origin + '/sitemap_index.xml', origin + '/sitemap.xml', origin + '/sitemap-index.xml',
        origin + '/sitemap/sitemap.xml', origin + '/sitemap/index.xml',
        origin + '/vehicle-sitemap.xml', origin + '/used-inventory-sitemap.xml',
        origin + '/new-inventory-sitemap.xml', origin + '/sitemapindex.xml',
      ]
      for (const url of candidates) {
        await collect(url)
        if (seen.size > 0) break
      }
      if (seen.size === 0) return null

      // Platform sniff from the collected VDP URLs + sitemap markup.
      const sample = [...seen].slice(0, 50).join(' ') + ' ' + sniffedXml
      let platform = 'Sitemap'
      if (/edealer|\/vdp\//i.test(sample)) platform = 'eDealer'
      else if (/dealer\.com|dealerdotcom/i.test(sample)) platform = 'Dealer.com'
      else if (/dealerinspire/i.test(sample)) platform = 'Dealer Inspire'
      else if (/convertus/i.test(sample)) platform = 'Convertus'
      else if (/vinsolutions|dealersocket/i.test(sample)) platform = 'DealerSocket'
      else if (/wp-|wordpress|admin-ajax/i.test(sample)) platform = 'WordPress'
      return {
        listing_count: seen.size,
        avg_price: null, min_price: null, max_price: null,
        platform,
        method: 'sitemap',
        scanned_at: new Date().toISOString()
      }
    }

    async function scrapeInventoryUrl(url) {
      let sitemapOrigin = ''
      try { sitemapOrigin = new URL(url).origin } catch {}

      // Strategy 1: DMS platform detection (probes known API endpoints — works on dealer homepages)
      try {
        const { detectFeedPlatform } = await import('../sync/platforms.js')
        const probe = await detectFeedPlatform(url)
        if (probe.success) {
          const vehicles = probe.sample_vehicles || []
          const prices = vehicles.map(v => Number(v.price)).filter(p => p > 1000 && p < 500000)
          const sorted = [...prices].sort((a, b) => a - b)
          const avg_price = prices.length ? Math.round(prices.reduce((a, b) => a + b, 0) / prices.length) : null
          return {
            listing_count: probe.vehicle_count ?? null,
            avg_price,
            min_price: sorted[0] ?? null,
            max_price: sorted[sorted.length - 1] ?? null,
            platform: probe.platform_label ?? probe.platform,
            scanned_at: new Date().toISOString()
          }
        }
      } catch {}

      // Strategy 1a: sitemap-first for plain dealer websites (NOT AutoTrader/CarGurus,
      // which have their own richer APIs below). Dealer sites are almost always behind
      // Cloudflare, which blocks HTML/Puppeteer scraping but serves the XML sitemap. So
      // for a dealer homepage/inventory URL, count VDP pages from the sitemap up front —
      // fast and reliable — instead of grinding through soon-to-be-blocked fetches.
      if (!/autotrader\.|cargurus\./i.test(url)) {
        const sm = await sitemapCountFallback(sitemapOrigin)
        if (sm) return sm
      }

      // Strategy 1b: CarGurus dealer inventory API
      // CarGurus dealer pages: cargurus.com/Cars/new/nl/d/dealer-slug/d_<dealerId>
      // or: cargurus.com/Cars/inventorylisting/viewDetailsFilterViewInventoryListing.action?zip=...&dealerListings=true&trim=...&sellerType=D&sellerId=<id>
      if (/cargurus\.com/i.test(url)) {
        try {
          // Extract seller/dealer ID from URL
          const sellerIdMatch = url.match(/[?&]sellerId=(\d+)/) || url.match(/\/d_(\d+)(?:[/?#]|$)/) || url.match(/d_(\d+)/)
          if (sellerIdMatch) {
            const sellerId = sellerIdMatch[1]
            // CarGurus JSON API for a specific dealer's listings
            const apiUrl = `https://www.cargurus.com/Cars/inventorylisting/ajaxFetchSubsetInventoryListing.action?zip=00000&showNegotiable=true&sortDir=ASC&sourceContext=carGurusHomePageModel&distance=100&sortType=PRICE&sellerTypes=D&listingTypes=ALL&sellerId=${sellerId}&maxResults=100`
            const r = await browserFetch(apiUrl, {
              signal: AbortSignal.timeout(15000),
              headers: { 'Accept': 'application/json', 'Referer': 'https://www.cargurus.com/' }
            })
            if (r.ok) {
              const data = await r.json()
              const listings = data?.listings ?? data?.listingResults ?? []
              const total = data?.totalListings ?? data?.totalCount ?? listings.length
              const prices = listings.map(l => Number(l.price ?? l.listingPrice ?? 0)).filter(p => p > 1000 && p < 500000)
              if (total > 0 || prices.length > 0) {
                const sorted = [...prices].sort((a, b) => a - b)
                return {
                  listing_count: total || prices.length,
                  avg_price: prices.length ? Math.round(prices.reduce((a, b) => a + b, 0) / prices.length) : null,
                  min_price: sorted[0] ?? null,
                  max_price: sorted[sorted.length - 1] ?? null,
                  platform: 'CarGurus',
                  top_models: [...new Set(listings.slice(0, 20).map(l => [l.year, l.makeName, l.modelName].filter(Boolean).join(' ')).filter(Boolean))].slice(0, 5),
                  scanned_at: new Date().toISOString()
                }
              }
            }
          }
          // Fallback: fetch the CarGurus page directly (they're more permissive than direct dealer sites)
          const cgRes = await browserFetch(url, { signal: AbortSignal.timeout(15000), headers: { 'Referer': 'https://www.google.com/' } })
          if (cgRes.ok) {
            const html = await cgRes.text()
            // CarGurus embeds data in window.cargurus.viewData or __NEXT_DATA__
            const cgDataMatch = html.match(/window\.cargurus\s*=\s*(\{[\s\S]{0,200000}\});?\s*<\/script>/i)
              || html.match(/window\["cargurus"\]\s*=\s*(\{[\s\S]{0,200000}\});?\s*<\/script>/i)
            if (cgDataMatch) {
              try {
                const cgData = JSON.parse(cgDataMatch[1])
                const tot = cgData?.viewData?.totalListings ?? cgData?.totalListings ?? null
                const listings2 = cgData?.viewData?.listings ?? cgData?.listings ?? []
                const prices2 = listings2.map(l => Number(l.price ?? 0)).filter(p => p > 1000 && p < 500000)
                if (tot || prices2.length) {
                  const sorted = [...prices2].sort((a, b) => a - b)
                  return {
                    listing_count: tot ?? prices2.length,
                    avg_price: prices2.length ? Math.round(prices2.reduce((a, b) => a + b, 0) / prices2.length) : null,
                    min_price: sorted[0] ?? null,
                    max_price: sorted[sorted.length - 1] ?? null,
                    platform: 'CarGurus',
                    scanned_at: new Date().toISOString()
                  }
                }
              } catch {}
            }
            // Generic count extraction from CarGurus HTML
            const countMatch = html.match(/"totalListings"\s*:\s*(\d+)/)
              || html.match(/"numListings"\s*:\s*(\d+)/)
              || html.match(/(\d{1,4})\s+(?:new\s+[&+]\s+used\s+)?(?:vehicles?|listings?|cars?)\s+for\s+sale/i)
            if (countMatch) {
              return {
                listing_count: parseInt(countMatch[1]),
                avg_price: null, min_price: null, max_price: null,
                platform: 'CarGurus',
                scanned_at: new Date().toISOString()
              }
            }
          }
        } catch (e) {
          // If CarGurus specific strategies fail, fall through to generic strategies
          console.error('[CarGurus scrape]', e.message)
        }
      }

      // Strategy 2: HTML scraping (AutoTrader pages, generic embedded JSON)
      // For AutoTrader.ca dealer URLs, bump rcp to 100 and force rcs=0 so we
      // get as many listings as possible in one fetch (avoids the 24-unit page cap).
      let fetchUrl = url
      if (/autotrader\.ca/i.test(url)) {
        try {
          const u = new URL(url)
          u.searchParams.set('rcp', '100')
          u.searchParams.set('rcs', '0')
          u.searchParams.set('srt', '35')
          fetchUrl = u.toString()
        } catch {}
      }

      let res
      try {
        res = await browserFetch(fetchUrl, { signal: AbortSignal.timeout(15000) })
      } catch (fetchErr) {
        // Network reset / timeout (common on Cloudflare-fronted sites) — the page
        // never loaded, but the XML sitemap usually still does. Try it before giving up.
        const sm = await sitemapCountFallback(sitemapOrigin)
        if (sm) return sm
        throw fetchErr
      }

      // Strategy 3: on 403 (WAF/bot block) try JSON feed paths and Schema.org JSON-LD
      if (res.status === 403 || res.status === 401 || res.status === 429) {
        let origin = ''
        try { origin = new URL(url).origin } catch {}

        // 3a: probe common JSON feed endpoints
        if (origin) {
          const feedResult = await tryJsonFeedFallback(origin)
          if (feedResult) return feedResult
        }

        // 3b: try the inventory sub-page which sometimes has looser WAF rules
        const inventoryPaths = ['/inventory/new', '/inventory', '/new-vehicles', '/used-vehicles', '/vehicles']
        for (const path of inventoryPaths) {
          try {
            const r2 = await browserFetch(origin + path, { signal: AbortSignal.timeout(12000) })
            if (!r2.ok) continue
            const html2 = await r2.text()
            const { prices: sp, listing_count: slc } = parseSchemaOrg(html2)
            if (sp.length || slc) {
              const sorted = [...sp].sort((a, b) => a - b)
              return {
                listing_count: slc ?? sp.length,
                avg_price: sp.length ? Math.round(sp.reduce((a, b) => a + b, 0) / sp.length) : null,
                min_price: sorted[0] ?? null,
                max_price: sorted[sorted.length - 1] ?? null,
                platform: 'Schema.org JSON-LD',
                scanned_at: new Date().toISOString()
              }
            }
          } catch {}
        }

        // 3c: Puppeteer — real browser, clears JS challenges (same path inventory sync uses)
        try {
          const { fetchViaBrowser } = await import('../puppeteerRenderer.js')
          const r = await fetchViaBrowser(url, { timeoutMs: 15000 })
          if (r.ok && r.body) {
            const { prices: sp, listing_count: slc } = parseSchemaOrg(r.body)
            if (sp.length || slc) {
              const sorted = [...sp].sort((a, b) => a - b)
              return {
                listing_count: slc ?? sp.length,
                avg_price: sp.length ? Math.round(sp.reduce((a, b) => a + b, 0) / sp.length) : null,
                min_price: sorted[0] ?? null,
                max_price: sorted[sorted.length - 1] ?? null,
                platform: 'Schema.org (browser)',
                scanned_at: new Date().toISOString()
              }
            }
            // Try the same embedded-JSON extraction on the Puppeteer-rendered HTML
            const ndMatch = r.body.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/)
            if (ndMatch) {
              try {
                const nd = JSON.parse(ndMatch[1])
                const tot = findTotal(nd)
                const raw = extractListings(nd)
                const bp = raw.map(l => Number(l?.price?.value ?? l?.price ?? 0)).filter(p => p > 1000 && p < 500_000)
                if (tot || bp.length) {
                  const sorted = [...bp].sort((a, b) => a - b)
                  return {
                    listing_count: tot ?? bp.length,
                    avg_price: bp.length ? Math.round(bp.reduce((a, b) => a + b, 0) / bp.length) : null,
                    min_price: sorted[0] ?? null,
                    max_price: sorted[sorted.length - 1] ?? null,
                    platform: 'browser render',
                    scanned_at: new Date().toISOString()
                  }
                }
              } catch {}
            }
          }
        } catch {}

        // 3d: last resort — sitemap VDP count (immune to WAF/Cloudflare page blocks)
        const sm = await sitemapCountFallback(origin)
        if (sm) return sm

        throw new Error(`HTTP ${res.status} — site is blocking automated scans`)
      }

      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const html = await res.text()

      let listing_count = null
      let prices = []

      // Helper: walk an object tree looking for a listing array with prices
      function extractListings(obj, depth = 0) {
        if (depth > 8 || !obj || typeof obj !== 'object') return []
        if (Array.isArray(obj) && obj.length > 0) {
          const s = obj[0]
          if (s && (s.price !== undefined || s.pricingDetail !== undefined || s.listPrice !== undefined)) return obj
        }
        for (const v of Object.values(obj)) {
          const found = extractListings(v, depth + 1)
          if (found.length) return found
        }
        return []
      }

      // Helper: find the true total count (not just the page count) in AT json
      function findTotal(obj, depth = 0) {
        if (depth > 6 || !obj || typeof obj !== 'object' || Array.isArray(obj)) return null
        for (const [k, v] of Object.entries(obj)) {
          if (/^(totalCount|totalResults|totalListings|numFound|total_count|count)$/i.test(k) && typeof v === 'number' && v > 0) return v
          if (typeof v === 'object') {
            const r = findTotal(v, depth + 1)
            if (r) return r
          }
        }
        return null
      }

      // Try __NEXT_DATA__ first (AutoTrader CA uses Next.js)
      const nextDataMatch = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/)
      if (nextDataMatch) {
        try {
          const nd = JSON.parse(nextDataMatch[1])
          const total = findTotal(nd)
          if (total) listing_count = total
          const raw = extractListings(nd)
          for (const l of raw) {
            const p = Number(l?.price?.value ?? l?.price ?? l?.pricingDetail?.price ?? l?.listPrice ?? 0)
            if (p > 1000 && p < 500000) prices.push(p)
          }
        } catch {}
      }

      // Also try window.__INITIAL_STATE__
      if (!listing_count || !prices.length) {
        const atStateMatch = html.match(/window\.__INITIAL_STATE__\s*=\s*(\{.{0,80000}?\});?\s*<\/script>/s)
        if (atStateMatch) {
          try {
            const state = JSON.parse(atStateMatch[1])
            if (!listing_count) listing_count = findTotal(state)
            if (!prices.length) {
              const raw = extractListings(state)
              for (const l of raw) {
                const p = Number(l?.price?.value ?? l?.price ?? l?.pricingDetail?.price ?? l?.listPrice ?? 0)
                if (p > 1000 && p < 500000) prices.push(p)
              }
            }
          } catch {}
        }
      }

      // Regex fallback for total count
      if (!listing_count) {
        const countMatch = html.match(/"totalResults"\s*:\s*(\d+)/)
          || html.match(/"totalCount"\s*:\s*(\d+)/)
          || html.match(/"numFound"\s*:\s*(\d+)/)
          || html.match(/"total"\s*:\s*(\d+)/)
        if (countMatch) listing_count = parseInt(countMatch[1])
      }

      // Plain-text count ("147 vehicles")
      if (!listing_count) {
        const textMatch = html.match(/\b(\d{1,4})\s+(?:new\s+[&+]\s+used\s+)?(?:vehicles?|listings?|results?|cars?)\b/i)
        if (textMatch) listing_count = parseInt(textMatch[1])
      }

      // Generic price extraction fallback
      if (!prices.length) {
        const priceMatches = [...html.matchAll(/"(?:price|sellingPrice|listPrice|salePrice)"\s*:\s*"?(\d{4,6})"?/g)]
        prices = priceMatches.map(m => parseInt(m[1])).filter(p => p > 1000 && p < 500000)
      }

      if (!listing_count && !prices.length) {
        const sm = await sitemapCountFallback(sitemapOrigin)
        if (sm) return sm
        throw new Error('no_inventory_data')
      }

      const sorted = [...prices].sort((a, b) => a - b)
      const avg_price = prices.length ? Math.round(prices.reduce((a, b) => a + b, 0) / prices.length) : null
      return {
        listing_count: listing_count ?? (prices.length || null),
        avg_price,
        min_price: sorted[0] ?? null,
        max_price: sorted[sorted.length - 1] ?? null,
        scanned_at: new Date().toISOString()
      }
    }

    const compList = competitors || []
    // Respond immediately — scan runs in background to avoid platform timeout
    res.json({ status: 'scanning', total: compList.length })

    // Scan every competitor CONCURRENTLY with a hard per-site time budget, so one
    // slow/blocked site (a giant sitemap index, a Puppeteer challenge) can't stall
    // the batch and leave the UI polling forever. Each competitor always gets its
    // last_scanned_at stamped within the budget, so the frontend's "done/total"
    // reliably reaches total.
    const PER_SITE_MS = 40000
    const scanOne = async (comp) => {
      if (!comp.autotrader_url) {
        return { error: 'No URL configured', scanned_at: new Date().toISOString() }
      }
      // PRIMARY: MarketCheck (licensed data) — reliable, no scraping, no Cloudflare.
      // Maps the competitor's website domain to their active listings + price stats.
      if (marketcheckEnabled()) {
        try {
          const mc = await marketcheckCompetitorStats({ url: comp.autotrader_url, isUS: _compIsUS })
          recordUsage(req.dealershipId, { marketcheck: 1 })  // metered (not vehicle-cacheable)
          if (mc) return mc
        } catch {}
      }
      try {
        return await Promise.race([
          scrapeInventoryUrl(comp.autotrader_url),
          new Promise((_, rej) => setTimeout(() => rej(new Error('timed_out')), PER_SITE_MS)),
        ])
      } catch (err) {
        let msg
        if (err.message === 'timed_out') {
          msg = 'Timed out reading this site. It may be heavily bot-protected — try their CarGurus or AutoTrader dealer page URL instead.'
        } else if (err.message === 'no_inventory_data') {
          msg = 'No inventory data found at this URL. Try the dealership\'s inventory page or their AutoTrader dealer URL (autotrader.ca/dealers/…).'
        } else if (/403|401|429|blocking/i.test(err.message)) {
          msg = 'Site is blocking automated scans (WAF/bot protection). Try their CarGurus or AutoTrader dealer page URL instead.'
        } else {
          msg = `Scan failed: ${err.message}`
        }
        return { error: msg, scanned_at: new Date().toISOString() }
      }
    }

    ;(async () => {
      await Promise.allSettled(compList.map(async (comp) => {
        const scanResult = await scanOne(comp)
        await supabaseAdmin
          .from('competitor_dealerships')
          .update({ last_scan_result: scanResult, last_scanned_at: new Date().toISOString() })
          .eq('id', comp.id)
      }))
    })().catch(e => console.error('[competitor scan background]', e.message))
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
        .select('id, year, make, model, trim, price, condition, stocknumber, image_urls, last_synced_at, created_at, status')
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
      // Days on lot = time since the unit first appeared (created_at). last_synced_at
      // is rewritten to "now" on every feed sync, so it can never measure age.
      daysOnLot: Math.floor((now - new Date(v.created_at || v.last_synced_at).getTime()) / 86400000)
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

    return {
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
      conditionCount, priceBrackets, daysBrackets, topMakes
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
      conditionCount, priceBrackets, daysBrackets, topMakes
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
      .select('name, ai_boost_active, inv_intel_active, city, province, country')
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
      .select('price, mileage, year, make, model, image_urls, photo_score, created_at')
      .eq('dealership_id', req.dealershipId).eq('status', 'available')
    const list = inv || []
    const total = list.length
    const photoCount = v => Array.isArray(v.image_urls) ? v.image_urls.filter(Boolean).length : 0
    const aged = list.filter(v => v.created_at && (now - new Date(v.created_at)) > 60 * 86400000)
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

    const loc = [dealer?.city, dealer?.province, dealer?.country].filter(Boolean).join(', ')
    const facts = [
      `Dealership: ${dealer?.name || 'this dealership'}${loc ? ` (${loc})` : ''}.`,
      `Available units: ${total}. Avg price: ${avgPrice ? '$' + avgPrice.toLocaleString() : 'n/a'} (range ${minPrice ? '$' + minPrice.toLocaleString() : 'n/a'}–${maxPrice ? '$' + maxPrice.toLocaleString() : 'n/a'}).`,
      `By make: ${topMakes || 'n/a'}.`,
      `Aging 60+ days: ${aged.length}${agedSample ? ` (e.g. ${agedSample})` : ''}.`,
      `Weak/thin photos: ${lowPhotos}. Missing price: ${noPrice}. Priced off market (last 2 days): ${priceFlags}.`,
      `Leads last 7 days: ${leads7}, of which ${leadsWaiting} still need follow-up.`,
    ].join('\n')

    const system = `You are MarketSync's in-dashboard assistant for a car dealership admin/GM. You do three things: (1) answer questions about how MarketSync works, what's included, and pricing, using the PRODUCT GUIDE; (2) answer questions about THIS store using the LIVE SNAPSHOT; and (3) pull live market data with your tools — decode a VIN, predict a fair price for a VIN, or get a market snapshot (listing count, median price, days-on-market) for a make/model. Use a tool only when it clearly helps answer the question, and never guess a VIN — ask for it. Keep answers short and practical — a couple of sentences or a tight list, no headings, no fluff. Never invent numbers beyond the snapshot or tool results, and when quoting product prices note they should confirm exact pricing on the upgrade/billing screen. Today: ${new Date().toISOString().slice(0, 10)}.\n\n${PRODUCT_KB}\n\nLIVE SNAPSHOT (this dealership, right now):\n${facts}`

    const isUS = /^(us|usa|united states)$/i.test((dealer?.country || '').trim())

    try {
      const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
      const convo = messages.slice()
      const call = () => Promise.race([
        anthropic.messages.create({ model: 'claude-haiku-4-5-20251001', max_tokens: 700, system, tools: ASSISTANT_TOOLS, messages: convo }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('ai timeout')), 25000)),
      ])
      // Tool-use loop: run any tools the model asks for, feed the results back,
      // and let it answer. Bounded so a loop can't run away (or run up cost).
      let response = await call()
      let guard = 0
      while (response?.stop_reason === 'tool_use' && guard++ < 4) {
        const toolResults = []
        for (const block of response.content || []) {
          if (block.type === 'tool_use') {
            const result = await runAssistantTool(block.name, block.input || {}, { dealershipId: req.dealershipId, isOwner, isUS })
            toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result })
          }
        }
        convo.push({ role: 'assistant', content: response.content })
        convo.push({ role: 'user', content: toolResults })
        response = await call()
      }
      const reply = (response?.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim()
      if (!reply) return res.status(502).json({ error: 'No reply generated. Try rephrasing.' })
      recordUsage(req.dealershipId, { ai: 1 })       // monthly AI quota + global budget
      recordAssistantChat(req.dealershipId)          // today's per-dealer assistant cap
      res.json({ reply })
    } catch (e) {
      res.status(502).json({ error: aiErrorMessage(e) })
    }
  })
}
