import Anthropic from '@anthropic-ai/sdk'
import { supabaseAdmin, resend, EMAIL_FROM, browserFetch } from '../shared.js'
import { requireAuth } from '../middleware.js'
import { scrapeMarketData } from '../scraper.js'

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
      .select('ai_boost_active, ai_tone, ai_required_fields, ai_manager_email, auction_api_key, vin_sticker_active')
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

    // Fetch dealership AI config
    const { data: dealer, error: dealerErr } = await supabaseAdmin
      .from('dealerships')
      .select('ai_boost_active, ai_tone, ai_required_fields, ai_manager_email')
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

    // ── Price comp check ──
    // Skip for new vehicles only — used vehicles of any year are fair game for price comparison.
    let price_flag = null
    const _currentYear = new Date().getFullYear()
    const _isNewOrCurrentYear = vehicle.condition === 'new'
    if (!_isNewOrCurrentYear && vehicle.price && vehicle.make && vehicle.model && vehicle.year) {
      const yearMin = vehicle.year - 2
      const yearMax = vehicle.year + 2
      const { data: comps } = await supabaseAdmin
        .from('inventory')
        .select('price')
        .eq('dealership_id', req.dealershipId)
        .eq('make', vehicle.make)
        .eq('model', vehicle.model)
        .eq('status', 'available')
        .gte('year', yearMin)
        .lte('year', yearMax)
        .neq('id', inventory_id)
        .not('price', 'is', null)

      if (comps && comps.length > 0) {
        const prices = comps.map(c => Number(c.price)).filter(p => p > 0).sort((a, b) => a - b)
        const med = median(prices)
        if (med) {
          const pct_diff = ((Number(vehicle.price) - med) / med) * 100
          price_flag = {
            flagged: Math.abs(pct_diff) > 15,
            median: med,
            pct_diff: Math.round(pct_diff * 10) / 10,
            comp_count: prices.length
          }
        }
      }
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
      .select('ai_boost_active, ai_tone, ai_required_fields, ai_manager_email')
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
          const currentYear = new Date().getFullYear()
          // Skip price flagging for new vehicles only — used vehicles of any year are compared
          const isNewOrCurrentYear = vehicle.condition === 'new'
          if (!isNewOrCurrentYear && vehicle.price && vehicle.make && vehicle.model && vehicle.year) {
            const { data: comps } = await supabaseAdmin
              .from('inventory').select('price')
              .eq('dealership_id', req.dealershipId).eq('make', vehicle.make)
              .eq('model', vehicle.model).eq('status', 'available')
              .gte('year', vehicle.year - 2).lte('year', vehicle.year + 2)
              .neq('id', inventory_id).not('price', 'is', null)
            if (comps?.length > 0) {
              const prices = comps.map(c => Number(c.price)).filter(p => p > 0).sort((a, b) => a - b)
              const med = median(prices)
              if (med) {
                const pct_diff = ((Number(vehicle.price) - med) / med) * 100
                price_flag = { flagged: Math.abs(pct_diff) > 15, median: med, pct_diff: Math.round(pct_diff * 10) / 10 }
              }
            }
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

    // Attempt to scrape inventory data from a URL.
    // Works best with AutoTrader dealer inventory pages (server-rendered JSON).
    // Dealer homepages rarely expose structured inventory data — we detect this and return a clear error.
    async function scrapeInventoryUrl(url) {
      const res = await browserFetch(url, { signal: AbortSignal.timeout(12000) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const html = await res.text()

      let listing_count = null
      let prices = []

      // AutoTrader: embedded JSON state
      const atStateMatch = html.match(/window\.__INITIAL_STATE__\s*=\s*(\{.{0,50000}?\});?\s*<\/script>/s)
      if (atStateMatch) {
        try {
          const state = JSON.parse(atStateMatch[1])
          // total count lives at different paths in different AT versions
          const total = state?.searchResults?.totalCount
            || state?.listing?.totalCount
            || state?.resultList?.totalCount
          if (total) listing_count = total
          const listings = state?.searchResults?.listings
            || state?.resultList?.listings
            || []
          for (const l of listings) {
            const p = l?.price?.value || l?.pricingDetail?.price
            if (p && p > 1000 && p < 500000) prices.push(p)
          }
        } catch {}
      }

      // AutoTrader / generic: JSON-LD arrays
      if (!listing_count) {
        const countMatch = html.match(/"totalResults"\s*:\s*(\d+)/)
          || html.match(/"totalCount"\s*:\s*(\d+)/)
          || html.match(/"total"\s*:\s*(\d+)/)
        if (countMatch) listing_count = parseInt(countMatch[1])
      }

      // Generic: text pattern like "148 vehicles"
      if (!listing_count) {
        const textMatch = html.match(/\b(\d{1,4})\s+(?:new\s+&\s+used\s+)?(?:vehicles?|listings?|results?|cars?)\b/i)
        if (textMatch) listing_count = parseInt(textMatch[1])
      }

      // Extract prices from any embedded JSON (works on many DMS-generated sites)
      if (!prices.length) {
        const priceMatches = [...html.matchAll(/"(?:price|sellingPrice|listPrice|salePrice)"\s*:\s*"?(\d{4,6})"?/g)]
        prices = priceMatches.map(m => parseInt(m[1])).filter(p => p > 1000 && p < 500000)
      }

      // If we found nothing at all, this is probably a homepage — tell the user
      if (!listing_count && !prices.length) {
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

    const results = []
    for (const comp of competitors || []) {
      if (!comp.autotrader_url) {
        results.push({ id: comp.id, name: comp.name, result: { error: 'No URL configured', scanned_at: new Date().toISOString() } })
        continue
      }
      let scanResult
      try {
        scanResult = await scrapeInventoryUrl(comp.autotrader_url)
      } catch (err) {
        const msg = err.message === 'no_inventory_data'
          ? 'Could not find inventory data at this URL. Use an AutoTrader dealer inventory page (e.g. autotrader.ca/dealers/…) for best results.'
          : `Scan failed: ${err.message}`
        scanResult = { error: msg, scanned_at: new Date().toISOString() }
      }

      await supabaseAdmin
        .from('competitor_dealerships')
        .update({ last_scan_result: scanResult, last_scanned_at: new Date().toISOString() })
        .eq('id', comp.id)

      results.push({ id: comp.id, name: comp.name, result: scanResult })
    }

    res.json({ scanned: results.length, results })
  })

  // ── Weekly Lot Health Report ─────────────────────────────────────────────

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

    const now = Date.now()
    const ago60 = new Date(now - 60 * 86400000).toISOString()
    const ago30 = new Date(now - 30 * 86400000).toISOString()
    const ago7 = new Date(now - 7 * 86400000).toISOString()

    const [{ data: allVehicles }, { data: recentActivity }] = await Promise.all([
      supabaseAdmin
        .from('inventory')
        .select('id, year, make, model, trim, price, condition, stocknumber, image_urls, last_synced_at, created_at, status')
        .eq('dealership_id', req.dealershipId)
        .eq('status', 'available'),
      supabaseAdmin
        .from('ai_activity')
        .select('inventory_id, vehicle_label, warnings, price_flagged, price_pct_diff, created_at')
        .eq('dealership_id', req.dealershipId)
        .gte('created_at', ago7)
        .order('created_at', { ascending: false })
        .limit(500)
    ])

    const vehicles = allVehicles || []
    const totalUnits = vehicles.length
    const withPhotos = vehicles.filter(v => v.image_urls?.length > 0).length
    const noPhotos = vehicles.filter(v => !v.image_urls?.length)
    const withPrice = vehicles.filter(v => v.price > 0)
    const prices = withPrice.map(v => Number(v.price)).sort((a, b) => a - b)
    const avgPrice = prices.length ? Math.round(prices.reduce((a, b) => a + b, 0) / prices.length) : null
    const medianPrice = prices.length ? prices[Math.floor(prices.length / 2)] : null

    const withDays = vehicles.map(v => ({
      ...v,
      daysOnLot: Math.floor((now - new Date(v.last_synced_at || v.created_at).getTime()) / 86400000)
    }))
    const aging = withDays.filter(v => v.daysOnLot > 60).sort((a, b) => b.daysOnLot - a.daysOnLot)
    const slowMovers30 = withDays.filter(v => v.daysOnLot > 30 && v.daysOnLot <= 60).sort((a, b) => b.daysOnLot - a.daysOnLot)
    const avgDays = withDays.length ? Math.round(withDays.reduce((s, v) => s + v.daysOnLot, 0) / withDays.length) : 0

    // Deduplicate price drift by inventory_id, keep worst flag per vehicle
    const driftMap = {}
    for (const a of (recentActivity || [])) {
      if (!a.price_flagged) continue
      const key = a.inventory_id || a.vehicle_label
      if (!driftMap[key] || Math.abs(a.price_pct_diff) > Math.abs(driftMap[key].price_pct_diff)) {
        driftMap[key] = a
      }
    }
    const priceDrift = Object.values(driftMap).sort((a, b) => Math.abs(b.price_pct_diff) - Math.abs(a.price_pct_diff))

    // Deduplicate missing info by inventory_id
    const warnMap = {}
    for (const a of (recentActivity || [])) {
      if (!a.warnings?.length) continue
      const key = a.inventory_id || a.vehicle_label
      if (!warnMap[key]) warnMap[key] = a
    }
    const missingInfo = Object.values(warnMap)

    // Make/model mix for top-5 bar chart
    const makeCount = {}
    for (const v of vehicles) {
      const k = v.make || 'Unknown'
      makeCount[k] = (makeCount[k] || 0) + 1
    }
    const topMakes = Object.entries(makeCount).sort((a, b) => b[1] - a[1]).slice(0, 5)
    const maxMakeCount = topMakes[0]?.[1] || 1

    const dealerName = dealer.name || 'Your Dealership'
    const primary = '#1a2e4a'
    const accent = '#6366f1'

    const vLabel = v => {
      const name = [v.year, v.make, v.model, v.trim].filter(Boolean).join(' ')
      return v.stocknumber ? `${name} <span style="color:#64748b;font-size:11px">#${v.stocknumber}</span>` : name
    }
    const aLabel = a => {
      // Try to append stock number if we can find it from inventory
      const inv = vehicles.find(v => v.id === a.inventory_id)
      const sn = inv?.stocknumber
      return sn ? `${a.vehicle_label} <span style="color:#64748b;font-size:11px">#${sn}</span>` : a.vehicle_label
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
      const pct = a.price_pct_diff
      const over = pct > 0
      const color = over ? '#16a34a' : '#ef4444'
      const direction = over ? 'overpriced' : 'underpriced'
      const fix = over
        ? `Consider reducing by $${Math.round(Math.abs(pct / 100) * (vehicles.find(v => v.id === a.inventory_id)?.price || 0)).toLocaleString()} to align with market`
        : `May sell faster at current price — or raise to recapture margin`
      return `<tr>
        <td style="padding:7px 12px;border-bottom:1px solid #e2e8f0;font-size:13px">${aLabel(a)}</td>
        <td style="padding:7px 12px;border-bottom:1px solid #e2e8f0;text-align:right;font-size:13px;color:${color};font-weight:700">${over ? '+' : ''}${pct}%</td>
        <td style="padding:7px 12px;border-bottom:1px solid #e2e8f0;font-size:11px;color:#64748b">${direction} vs similar units on your lot. ${fix}</td>
      </tr>`
    }

    const warnRow = a =>
      `<tr>
        <td style="padding:7px 12px;border-bottom:1px solid #e2e8f0;font-size:13px">${aLabel(a)}</td>
        <td colspan="2" style="padding:7px 12px;border-bottom:1px solid #e2e8f0;font-size:12px;color:#b45309">${(a.warnings || []).join(' · ')}</td>
      </tr>`

    const statBox = (label, value, sub, color = '#1a2e4a') =>
      `<td width="25%" style="padding:12px;text-align:center;border-right:1px solid #e2e8f0">
        <div style="font-size:22px;font-weight:900;color:${color}">${value}</div>
        <div style="font-size:11px;font-weight:700;color:#475569;margin-top:2px;text-transform:uppercase;letter-spacing:0.05em">${label}</div>
        ${sub ? `<div style="font-size:10px;color:#94a3b8;margin-top:1px">${sub}</div>` : ''}
      </td>`

    const barRow = (label, count, max, total) => {
      const pct = Math.round((count / total) * 100)
      const barW = Math.round((count / max) * 200)
      return `<tr>
        <td style="padding:4px 12px;font-size:12px;color:#334155;width:120px">${label}</td>
        <td style="padding:4px 8px">
          <div style="background:#e2e8f0;border-radius:4px;height:14px;width:220px">
            <div style="background:${accent};border-radius:4px;height:14px;width:${barW}px"></div>
          </div>
        </td>
        <td style="padding:4px 8px;font-size:12px;color:#64748b;white-space:nowrap">${count} units (${pct}%)</td>
      </tr>`
    }

    const photosPct = totalUnits ? Math.round((withPhotos / totalUnits) * 100) : 0
    const agingPct  = totalUnits ? Math.round((aging.length / totalUnits) * 100) : 0
    const driftPct  = totalUnits ? Math.round((priceDrift.length / totalUnits) * 100) : 0

    const emailHtml = `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>body{margin:0;padding:0;background:#f8fafc;font-family:Arial,sans-serif}</style>
</head><body>
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;padding:24px 0">
<tr><td align="center">
<table width="660" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:10px;overflow:hidden;border:1px solid #e2e8f0">

  <!-- Header -->
  <tr><td style="background:${primary};padding:22px 24px">
    <div style="color:#fff;font-size:22px;font-weight:900">${dealerName}</div>
    <div style="color:#94a3b8;font-size:13px;margin-top:3px">Weekly Lot Health Report · ${new Date().toLocaleDateString('en-CA', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}</div>
  </td></tr>

  <!-- Summary stat row -->
  <tr><td style="padding:0">
    <table width="100%" cellpadding="0" cellspacing="0" style="border-bottom:1px solid #e2e8f0">
      <tr>
        ${statBox('Total Units', totalUnits, 'available now', '#1a2e4a')}
        ${statBox('Photos Coverage', `${photosPct}%`, `${withPhotos} of ${totalUnits} have photos`, photosPct < 80 ? '#ef4444' : '#16a34a')}
        ${statBox('Avg Days on Lot', avgDays, agingPct > 0 ? `${agingPct}% aging 60d+` : 'healthy turnover', avgDays > 45 ? '#f59e0b' : '#16a34a')}
        ${statBox('Price Flags', priceDrift.length, `${driftPct}% of lot`, priceDrift.length > 0 ? '#ef4444' : '#16a34a')}
      </tr>
    </table>
  </td></tr>

  <!-- Lot mix bar chart -->
  <tr><td style="padding:16px 24px 8px">
    <div style="font-size:13px;font-weight:700;color:${primary};margin-bottom:8px">📊 Inventory Mix by Make</div>
    <table cellpadding="0" cellspacing="0">
      ${topMakes.map(([make, cnt]) => barRow(make, cnt, maxMakeCount, totalUnits)).join('')}
    </table>
    <div style="font-size:11px;color:#94a3b8;margin-top:6px">Avg asking price: ${avgPrice ? '$' + avgPrice.toLocaleString() : '—'} · Median: ${medianPrice ? '$' + medianPrice.toLocaleString() : '—'}</div>
  </td></tr>

  <tr><td style="padding:0 24px 16px">
  <table width="100%" cellpadding="0" cellspacing="0" style="font-size:13px">

    <!-- Price Drift -->
    ${priceDrift.length ? `
      ${sectionHeader('💰 Price Drift Flags (' + priceDrift.length + ' vehicles)')}
      ${subNote('Price drift = this vehicle\'s asking price vs. the median of similar make/model units on your own lot. Negative = you\'re priced below market (could sell fast or you\'re leaving money). Positive = you\'re above market (may slow down the sale). Review and adjust in your DMS or listing.', 3)}
      <tr style="background:#f8fafc"><td style="padding:5px 12px;font-size:11px;font-weight:700;color:#64748b">VEHICLE</td><td style="padding:5px 12px;font-size:11px;font-weight:700;color:#64748b;text-align:right">DRIFT</td><td style="padding:5px 12px;font-size:11px;font-weight:700;color:#64748b">RECOMMENDATION</td></tr>
      ${priceDrift.map(driftRow).join('')}` : ''}

    <!-- Aging -->
    ${aging.length ? `
      ${sectionHeader('⏱ Aging Units — 60+ Days on Lot (' + aging.length + ')')}
      ${subNote('These units have been sitting for over 60 days. Consider a price reduction, trade-in push, or additional marketing. Units over 90 days are highlighted red.', 3)}
      <tr style="background:#f8fafc"><td style="padding:5px 12px;font-size:11px;font-weight:700;color:#64748b">VEHICLE</td><td style="padding:5px 12px;font-size:11px;font-weight:700;color:#64748b;text-align:right">PRICE</td><td style="padding:5px 12px;font-size:11px;font-weight:700;color:#64748b;text-align:right">DAYS</td></tr>
      ${aging.map(agingRow).join('')}` : ''}

    <!-- Slow movers 30-60d -->
    ${slowMovers30.length ? `
      ${sectionHeader('🐢 Watch List — 30–60 Days on Lot (' + slowMovers30.length + ')')}
      ${subNote('These units are approaching the aging threshold. Monitor closely — a small price move now is better than a large one at 60+ days.', 3)}
      ${slowMovers30.map(agingRow).join('')}` : ''}

    <!-- Missing photos — all, no cap -->
    ${noPhotos.length ? `
      ${sectionHeader('📷 No Photos (' + noPhotos.length + ' vehicles)')}
      ${subNote('Listings without photos get significantly fewer clicks. Upload photos through your DMS or directly in MarketSync.', 3)}
      <tr style="background:#f8fafc"><td colspan="3" style="padding:5px 12px;font-size:11px;font-weight:700;color:#64748b">VEHICLE</td></tr>
      ${noPhotos.map(v => `<tr><td colspan="3" style="padding:7px 12px;border-bottom:1px solid #e2e8f0;font-size:13px">${vLabel(v)}</td></tr>`).join('')}` : ''}

    <!-- Other missing info -->
    ${missingInfo.length ? `
      ${sectionHeader('⚠ Other Missing Info (' + missingInfo.length + ' flags, last 7 days)')}
      ${missingInfo.map(warnRow).join('')}` : ''}

    ${!aging.length && !priceDrift.length && !slowMovers30.length && !noPhotos.length && !missingInfo.length
      ? '<tr><td colspan="3" style="padding:24px;text-align:center;color:#16a34a;font-weight:700">✓ No issues — your lot is in great shape!</td></tr>'
      : ''}

  </table>
  </td></tr>

  <!-- Footer -->
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
}
