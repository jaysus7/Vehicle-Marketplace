import Anthropic from '@anthropic-ai/sdk'
import { supabaseAdmin, resend, EMAIL_FROM } from '../shared.js'
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
      .select('ai_boost_active, ai_tone, ai_required_fields, ai_manager_email')
      .eq('id', req.dealershipId)
      .single()
    if (error) return res.status(500).json({ error: error.message })
    const isOwner = (req.user.email || '').toLowerCase() === OWNER_EMAIL
    res.json({ ...data, ai_boost_active: isOwner ? true : !!data.ai_boost_active })
  })

  // PUT /ai/config — update dealership AI config (DEALER_ADMIN only)
  app.put('/ai/config', requireAuth, requireDealerAdmin, async (req, res) => {
    if (!req.dealershipId) return res.status(400).json({ error: 'No dealership associated' })
    const { ai_tone, ai_required_fields, ai_manager_email, ai_boost_active } = req.body
    const update = {}
    if (ai_tone !== undefined) update.ai_tone = ai_tone
    if (ai_required_fields !== undefined) update.ai_required_fields = ai_required_fields
    if (ai_manager_email !== undefined) update.ai_manager_email = ai_manager_email
    if (ai_boost_active !== undefined) update.ai_boost_active = ai_boost_active

    const { data, error } = await supabaseAdmin
      .from('dealerships')
      .update(update)
      .eq('id', req.dealershipId)
      .select('ai_boost_active, ai_tone, ai_required_fields, ai_manager_email')
      .single()
    if (error) return res.status(500).json({ error: error.message })
    res.json(data)
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
    // Current-year new vehicles sell at MSRP — skip comp flagging for them.
    let price_flag = null
    const _currentYear = new Date().getFullYear()
    const _isCurrentYearNew = Number(vehicle.year) >= _currentYear || vehicle.condition === 'new'
    if (!_isCurrentYearNew && vehicle.price && vehicle.make && vehicle.model && vehicle.year) {
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
          const isCurrentYearNew = vehicle.condition === 'new' && Number(vehicle.year) >= currentYear
          if (!isCurrentYearNew && vehicle.price && vehicle.make && vehicle.model && vehicle.year) {
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
    let scraped = { autotrader: null, cargurus: null }
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
    if (scraped.autotrader) {
      const at = scraped.autotrader
      liveDataLines.push(`LIVE ${src1} data (${at.count} listings): avg price $${at.avg_price.toLocaleString()} ${currency}, median $${at.median_price.toLocaleString()}, avg mileage ${at.avg_mileage.toLocaleString()} ${distanceUnit}`)
    }
    if (scraped.cargurus) {
      const cg = scraped.cargurus
      liveDataLines.push(`LIVE ${src2} data (${cg.count} listings): avg price $${cg.avg_price.toLocaleString()} ${currency}, median $${cg.median_price.toLocaleString()}, avg mileage ${cg.avg_mileage.toLocaleString()} ${distanceUnit}`)
    }
    const liveDataBlock = liveDataLines.length
      ? `\nREAL SCRAPED MARKET DATA — use these as your primary pricing anchors:\n${liveDataLines.join('\n')}\n`
      : `\nNo live scrape data available — use your training knowledge of the ${marketLabel} market.\n`

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
8. days_on_market_estimate: estimate realistically — overpriced vehicles take longer, well-priced take less
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

    res.json({ vehicle, estimate, pct_diff, data_source: dataSource })
  })
}
