import Anthropic from '@anthropic-ai/sdk'
import { supabaseAdmin, resend, EMAIL_FROM, browserFetch } from '../shared.js'
import { requireAuth } from '../middleware.js'
import { scrapeMarketData } from '../scraper.js'
import { createNotifications } from '../notifications.js'

const OWNER_EMAIL = (process.env.OWNER_EMAIL || 'massiejay@gmail.com').toLowerCase()

function requireDealerAdmin(req, res, next) {
  if (req.profile?.role !== 'DEALER_ADMIN') {
    return res.status(403).json({ error: 'DEALER_ADMIN role required' })
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

export function registerAI(app) {
  // GET /ai/config — returns dealership's AI config
  app.get('/ai/config', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership associated' })
    const { data, error } = await supabaseAdmin
      .from('dealerships')
      .select('ai_boost_active, ai_tone, ai_required_fields, ai_manager_email, auction_api_key, vin_sticker_active, inv_intel_active')
      .eq('id', req.dealershipId)
      .single()
    if (error) return res.status(500).json({ error: error.message })
    const isOwner = (req.user.email || '').toLowerCase() === OWNER_EMAIL
    // Mask the key — return only a boolean indicating whether one is set,
    // plus a redacted preview so the UI can show "••••••••abc123"
    const auctionKeySet = !!data.auction_api_key
    const auctionKeyPreview = data.auction_api_key
      ? '••••••••' + data.auction_api_key.slice(-6)
      : ''
    const { auction_api_key: _, ...rest } = data
    res.json({ ...rest, ai_boost_active: isOwner ? true : !!data.ai_boost_active, auction_key_set: auctionKeySet, auction_key_preview: auctionKeyPreview })
  })

  // PUT /ai/config — update dealership AI config (DEALER_ADMIN only)
  app.put('/ai/config', requireAuth, requireDealerAdmin, async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership associated' })
    const { ai_tone, ai_required_fields, ai_manager_email, ai_boost_active, auction_api_key } = req.body
    const update = {}
    if (ai_tone !== undefined) update.ai_tone = ai_tone
    if (ai_required_fields !== undefined) update.ai_required_fields = ai_required_fields
    if (ai_manager_email !== undefined) update.ai_manager_email = ai_manager_email
    if (ai_boost_active !== undefined) update.ai_boost_active = ai_boost_active
    // Empty string clears the key; undefined = no change
    if (auction_api_key !== undefined) update.auction_api_key = auction_api_key || null

    const { data, error } = await supabaseAdmin
      .from('dealerships')
      .update(update)
      .eq('id', req.dealershipId)
      .select('ai_boost_active, ai_tone, ai_required_fields, ai_manager_email, auction_api_key')
      .single()
    if (error) return res.status(500).json({ error: error.message })
    const auctionKeySet = !!data.auction_api_key
    const auctionKeyPreview = data.auction_api_key ? '••••••••' + data.auction_api_key.slice(-6) : ''
    const { auction_api_key: __, ...rest2 } = data
    res.json({ ...rest2, auction_key_set: auctionKeySet, auction_key_preview: auctionKeyPreview })
  })

  // POST /ai/enrich-listing — run AI enrichment on an inventory item
  app.post('/ai/enrich-listing', requireAuth, async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership associated' })

    const { inventory_id } = req.body
    if (!inventory_id) return res.status(400).json({ error: 'inventory_id required' })

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

    if (!dealer.ai_boost_active) {
      return res.status(403).json({ error: 'AI Boost subscription is not active for this dealership' })
    }

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
    }

    // ── Price comp check vs external marketplaces ──
    // Skip for new vehicles — MSRP pricing doesn't need market comp.
    let price_flag = null
    const _isNewVehicle = (vehicle.condition || '').toLowerCase() === 'new'
    if (!_isNewVehicle && vehicle.price && vehicle.make && vehicle.model && vehicle.year) {
      try {
        const countryRaw = (dealer?.country || '').trim().toUpperCase()
        const _isUS = countryRaw === 'US' || countryRaw === 'USA' || countryRaw === 'UNITED STATES'
        const { autotrader, cargurus } = await scrapeMarketData({
          make: vehicle.make,
          model: vehicle.model,
          year: vehicle.year,
          trim: vehicle.trim || '',
          postalCode: dealer?.postal_code || '',
          province: dealer?.province || '',
          isUS: _isUS,
          vehicleLabel: `${vehicle.year} ${vehicle.make} ${vehicle.model}`,
        })
        // Use AutoTrader median first, fall back to CarGurus
        const marketMedian = autotrader?.median_price ?? cargurus?.median_price ?? null
        const marketSource = autotrader ? 'AutoTrader' : cargurus ? 'CarGurus' : null
        const compCount = (autotrader?.count ?? 0) + (cargurus?.count ?? 0)
        if (marketMedian) {
          const pct_diff = ((Number(vehicle.price) - marketMedian) / marketMedian) * 100
          price_flag = {
            flagged: Math.abs(pct_diff) > 15,
            median: marketMedian,
            pct_diff: Math.round(pct_diff * 10) / 10,
            comp_count: compCount,
            source: marketSource,
          }
        }
      } catch {}
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

Write a compelling listing in under 280 words. Include the year/make/model/trim, mileage, price, condition, colour, and key highlights from the description. Do not invent details not provided. ${tone !== 'friendly' ? 'No emoji.' : 'Minimal emoji only if it enhances readability.'}`
          }
        ]
      })
      copy = message.content[0]?.text || null
    } catch (aiErr) {
      return res.status(502).json({ error: `AI generation failed: ${aiErr.message}` })
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
      .select('ai_boost_active, ai_tone, ai_required_fields, ai_manager_email, city, province, country, postal_code')
      .eq('id', req.dealershipId)
      .single()

    const isOwner = (req.user.email || '').toLowerCase() === OWNER_EMAIL
    if (!isOwner && !dealer?.ai_boost_active) {
      return res.status(403).json({ error: 'AI Boost not active' })
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
        try {
          const { data: vehicle } = await supabaseAdmin
            .from('inventory').select('*').eq('id', inventory_id).single()
          if (!vehicle) continue

          const warnings = []
          const requiredFields = dealer.ai_required_fields || ['price', 'mileage', 'image_urls']
          if (requiredFields.includes('price') && (!vehicle.price || Number(vehicle.price) === 0)) warnings.push('Missing or zero price')
          if (requiredFields.includes('mileage') && vehicle.mileage == null) warnings.push('Missing mileage')
          if (requiredFields.includes('image_urls') && (!vehicle.image_urls || vehicle.image_urls.length === 0)) warnings.push('No photos attached')
          if (requiredFields.includes('description') && (!vehicle.description || vehicle.description.length < 20)) warnings.push('Description is missing or too short')

          let price_flag = null
          const isNewVehicle = (vehicle.condition || '').toLowerCase() === 'new'
          if (!isNewVehicle && vehicle.price && vehicle.make && vehicle.model && vehicle.year) {
            try {
              const { autotrader, cargurus } = await scrapeMarketData({
                make: vehicle.make,
                model: vehicle.model,
                year: vehicle.year,
                trim: vehicle.trim || '',
                postalCode: dealer?.postal_code || '',
                province: dealer?.province || '',
                isUS: _syncIsUS,
                vehicleLabel: `${vehicle.year} ${vehicle.make} ${vehicle.model}`,
              })
              const marketMedian = autotrader?.median_price ?? cargurus?.median_price ?? null
              const marketSource = autotrader ? 'AutoTrader' : cargurus ? 'CarGurus' : null
              if (marketMedian) {
                const pct_diff = ((Number(vehicle.price) - marketMedian) / marketMedian) * 100
                price_flag = {
                  flagged: Math.abs(pct_diff) > 15,
                  median: marketMedian,
                  pct_diff: Math.round(pct_diff * 10) / 10,
                  source: marketSource,
                }
              }
            } catch {}
          }

          await supabaseAdmin.from('ai_activity').insert({
            dealership_id: req.dealershipId,
            inventory_id,
            actor_id: req.user.id,
            vehicle_label: [vehicle.year, vehicle.make, vehicle.model, vehicle.trim].filter(Boolean).join(' '),
            warnings: warnings.length > 0 ? warnings : null,
            price_flagged: !!(price_flag?.flagged),
            price_pct_diff: price_flag?.pct_diff ?? null,
            price_median: price_flag?.median ?? null,
            copy_generated: false
          })
        } catch {}
        await new Promise(r => setTimeout(r, 300)) // gentle rate limiting between vehicles
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
    res.json({ activity: data || [] })
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

    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(503).json({ error: 'AI features not configured' })
    }

    // Fetch dealership location and country for market context
    const { data: dealer } = await supabaseAdmin
      .from('dealerships')
      .select('city, province, country')
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

    // Attempt live market scraping (best-effort; falls back to AI-only on failure)
    const vehicleLabel = `${vehicle.year} ${vehicle.make} ${vehicle.model}${trimText}`
    let scraped = { autotrader: null, cargurus: null, copart: null }
    let dataSource = 'ai_estimate'
    try {
      scraped = await scrapeMarketData({
        make: vehicle.make,
        model: vehicle.model,
        year: Number(vehicle.year),
        trim: vehicle.trim || '',
        postalCode: dealer?.postal_code || '',
        province: dealer?.province || '',
        city: dealer?.city || '',
        isUS,
        vehicleLabel,
      })
      if (scraped.autotrader || scraped.cargurus) dataSource = 'live'
    } catch {
      // scrapeMarketData handles its own alerts; keep ai_estimate mode
    }

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
1. USED vehicles: compare ONLY against used ${vehicle.year} ${vehicle.make} ${vehicle.model}${trimText} listings (same year, same trim) in the ${location} area
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

    try {
      const message = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
        messages: [{ role: 'user', content: prompt }]
      })
      const text = message.content[0]?.text?.trim() || ''
      // Strip any markdown fencing if present
      const jsonText = text.replace(/^```json?\s*/i, '').replace(/```\s*$/i, '').trim()
      estimate = JSON.parse(jsonText)
    } catch (aiErr) {
      return res.status(502).json({ error: `AI estimate failed: ${aiErr.message}` })
    }

    const yourPrice = Number(vehicle.price)
    const pct_diff = estimate?.mid
      ? Math.round(((yourPrice - estimate.mid) / estimate.mid) * 1000) / 10
      : null

    res.json({
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
    })
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
      .select('ai_boost_active, repricing_rules')
      .eq('id', req.dealershipId)
      .single()

    const isOwner = (req.user.email || '').toLowerCase() === OWNER_EMAIL
    if (!isOwner && !dealer?.ai_boost_active) return res.status(403).json({ error: 'AI Boost not active' })

    const rules = dealer.repricing_rules || { enabled: false, days_on_lot_threshold: 45, price_drop_pct: 5, overprice_threshold_pct: 20 }
    const { days_on_lot_threshold, price_drop_pct, overprice_threshold_pct } = rules

    const { data: vehicles, error } = await supabaseAdmin
      .from('inventory')
      .select('id, year, make, model, trim, price, last_synced_at, created_at')
      .eq('dealership_id', req.dealershipId)
      .eq('status', 'available')
    if (error) return res.status(500).json({ error: error.message })

    const now = Date.now()
    const suggestions = []

    for (const vehicle of vehicles || []) {
      const refDate = vehicle.last_synced_at || vehicle.created_at
      const daysOnLot = refDate ? Math.floor((now - new Date(refDate).getTime()) / 86400000) : 0
      if (daysOnLot < days_on_lot_threshold) continue
      if (!vehicle.price || !vehicle.make || !vehicle.model) continue

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

      if (!comps || comps.length === 0) continue
      const prices = comps.map(c => Number(c.price)).filter(p => p > 0).sort((a, b) => a - b)
      const med = median(prices)
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
      .select('ai_boost_active')
      .eq('id', req.dealershipId)
      .single()

    const isOwner = (req.user.email || '').toLowerCase() === OWNER_EMAIL
    if (!isOwner && !dealer?.ai_boost_active) return res.status(403).json({ error: 'AI Boost not active' })

    if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ error: 'AI features not configured' })

    const since180 = new Date(Date.now() - 180 * 86400000).toISOString()

    const [{ data: sold }, { data: current }] = await Promise.all([
      supabaseAdmin
        .from('inventory')
        .select('make, model, year')
        .eq('dealership_id', req.dealershipId)
        .in('status', ['sold', 'archived'])
        .gte('updated_at', since180)
        .order('updated_at', { ascending: false })
        .limit(200),
      supabaseAdmin
        .from('inventory')
        .select('id, make, model, year, price, status, stocknumber')
        .eq('dealership_id', req.dealershipId)
        .eq('status', 'available')
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

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
    let recommendations = []
    try {
      const message = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 1200,
        messages: [{
          role: 'user',
          content: `You are an automotive inventory strategist for a Canadian GM dealership in Ontario, Canada. Based on this dealership's 180-day sell-through data and current stock, recommend 5 specific vehicle acquisitions. Base your advice on Canadian market conditions, Ontario buyer preferences, and Canadian government incentives (iZEV program, Ontario rebates) — do NOT reference US programs like IRA or federal US credits.

Sell-through (last 180 days):
${sell_through.map(s => `- ${s.make} ${s.model}: ${s.sold} sold`).join('\n') || 'No sold data available yet'}

Current stock (available units):
${Object.entries(stockMap).map(([k, d]) => `- ${k.replace('|', ' ')}: ${d.count} units (${d.units.slice(0, 3).map(u => `id:${u.id}${u.stocknumber ? ' stock:' + u.stocknumber : ''}`).join(', ')}${d.units.length > 3 ? '…' : ''})`).join('\n') || 'No current stock'}

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

    res.json({ recommendations, sell_through, generated_at: new Date().toISOString() })
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
        .select('id, vin, stocknumber, make, model, year, condition, price, mileage, description, image_urls, created_at')
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
      .slice(0, 4)

    // Cold: stock sitting but not moving
    const cold = velocity
      .filter(s => s.current_stock >= 2 && s.monthly_velocity < 1)
      .sort((a, b) => b.current_stock - a.current_stock)
      .slice(0, 4)

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
      .select('ai_boost_active')
      .eq('id', req.dealershipId)
      .single()

    const isOwner = (req.user.email || '').toLowerCase() === OWNER_EMAIL
    if (!isOwner && !dealer?.ai_boost_active) return res.status(403).json({ error: 'AI Boost not active' })

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

    async function scrapeInventoryUrl(url) {
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

      const res = await browserFetch(fetchUrl, { signal: AbortSignal.timeout(15000) })

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
          const r = await fetchViaBrowser(url, { timeoutMs: 30000 })
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

      if (!listing_count && !prices.length) throw new Error('no_inventory_data')

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

    const results = await Promise.all((competitors || []).map(async comp => {
      if (!comp.autotrader_url) {
        const result = { error: 'No URL configured', scanned_at: new Date().toISOString() }
        return { id: comp.id, name: comp.name, result }
      }
      let scanResult
      try {
        scanResult = await scrapeInventoryUrl(comp.autotrader_url)
      } catch (err) {
        let msg
        if (err.message === 'no_inventory_data') {
          msg = 'No inventory data found at this URL. Try the dealership\'s inventory page or their AutoTrader dealer URL (autotrader.ca/dealers/…).'
        } else if (/403|401|429|blocking/i.test(err.message)) {
          msg = 'Site is blocking automated scans (WAF/bot protection). Try adding their AutoTrader URL instead.'
        } else {
          msg = `Scan failed: ${err.message}`
        }
        scanResult = { error: msg, scanned_at: new Date().toISOString() }
      }

      await supabaseAdmin
        .from('competitor_dealerships')
        .update({ last_scan_result: scanResult, last_scanned_at: new Date().toISOString() })
        .eq('id', comp.id)

      return { id: comp.id, name: comp.name, result: scanResult }
    }))

    res.json({ scanned: results.length, results })
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
      { data: soldThisWeek },
      { data: soldPrevWeek }
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
      supabaseAdmin.from('inventory')
        .select('id')
        .eq('dealership_id', dealershipId)
        .eq('status', 'sold')
        .gte('updated_at', ago7),
      supabaseAdmin.from('inventory')
        .select('id')
        .eq('dealership_id', dealershipId)
        .eq('status', 'sold')
        .gte('updated_at', ago14)
        .lt('updated_at', ago7)
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
      daysOnLot: Math.floor((now - new Date(v.last_synced_at || v.created_at).getTime()) / 86400000)
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
    const soldThisWeekCount = (soldThisWeek || []).length
    const soldPrevWeekCount = (soldPrevWeek || []).length

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

  // ── Cron: auto-send weekly health reports every Monday ────────────────────
  // Protected by CRON_SECRET header. Set up as a Render Cron Job:
  //   Schedule: 0 13 * * 1   (Monday 9am ET = 1pm UTC)
  //   Command:  curl -X POST https://<your-render-url>/cron/weekly-reports \
  //               -H "x-cron-secret: $CRON_SECRET"
  app.post('/cron/weekly-reports', async (req, res) => {
    if (req.headers['x-cron-secret'] !== process.env.CRON_SECRET) {
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
}
