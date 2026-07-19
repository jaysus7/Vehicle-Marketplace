/**
 * AI inventory-intelligence + pricing routes (extracted from ai.js).
 * Market positions, lot report, price report, repricing, stocking, inventory
 * intelligence, AI Vision scans, and competitor tracking.
 */
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
import {
  OWNER_EMAIL, attachOemStickerToInventory, LANG_NAME, langName,
  PRODUCT_KB, ASSISTANT_TOOLS, REPORT_TOPICS,
  buildDealershipReport, runAssistantTool,
  skipPriceComp, PRICE_MIN_COMPS, buildPriceFlag, aiErrorMessage,
  marketMedianForScan, requireDealerAdmin, median, mileageAdjustedMedian,
  computeDailyDigest,
} from './ai-helpers.js'

export function registerAiPricing(app) {

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
      .select('inventory_id, price_median, comp_count, trim_matched, created_at')
      .eq('dealership_id', req.dealershipId)
      .not('price_median', 'is', null)
      .order('created_at', { ascending: false })
      .limit(3000)
    // Keep the newest median per vehicle (rows come newest-first). `meta` carries the
    // comp quality so the badge can show count + whether it was trim-matched.
    const positions = {}, meta = {}
    for (const a of acts || []) {
      if (a.inventory_id && positions[a.inventory_id] == null) {
        positions[a.inventory_id] = a.price_median
        meta[a.inventory_id] = { count: a.comp_count ?? null, trim_matched: a.trim_matched ?? null }
      }
    }

    // Action verdict per vehicle (ok / raise / lower) from the cached price reports —
    // powers the green/amber/red tag on inventory cards. Only surfaced when the report
    // was generated at the vehicle's CURRENT price (a price change makes it stale).
    const verdicts = {}
    const { data: reports } = await supabaseAdmin
      .from('price_reports')
      .select('inventory_id, report, price_at_generation, generated_at')
      .eq('dealership_id', req.dealershipId)
      .limit(5000)
    for (const r of reports || []) {
      const est = r.report?.estimate
      const v = est?.pricing_verdict
      if (!r.inventory_id || !v) continue
      verdicts[r.inventory_id] = {
        verdict: v,
        headline: est.verdict_headline || null,
        reason: est.verdict_reason || null,
        price_at_generation: r.price_at_generation ?? null,
        generated_at: r.generated_at || null,
      }
    }
    res.json({ positions, meta, verdicts, active: true })
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
      .select('id, year, make, model, trim, condition, price, mileage, exterior_color, stocknumber, status, lot_date, created_at')
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

    // Appraisal context the verdict weighs: how long it's sat, and today's date/season.
    const _lotRef = vehicle.lot_date || vehicle.created_at
    const daysOnLot = _lotRef ? Math.max(0, Math.floor((Date.now() - new Date(_lotRef)) / 86400000)) : null
    const _now = new Date()
    const todayContext = `${_now.toISOString().slice(0, 10)} (${_now.toLocaleString('en-US', { month: 'long' })})`

    // Shared verdict rubric — turns a raw price-vs-market number into an ACTION
    // ("ok" / "raise" / "lower") by weighing the same things a person does when
    // appraising, in priority order. Reused by both the MarketCheck and AI paths.
    const verdictGuidance = `PRICING VERDICT — the dealer needs an ACTION, not just a number. Weigh these IN THIS ORDER:
1. Days on lot (${daysOnLot == null ? 'unknown' : daysOnLot + ' days'}) and realistic days-to-sell — THE MOST IMPORTANT factor. A unit sitting well past a normal turn is a strong reason to lower; a fresh unit has room to hold or raise.
2. Mileage vs market.
3. Colour desirability, overall condition/quality, and any accident history (reduces value).
4. Seasonality — today is ${todayContext}. Weigh seasonal demand (AWD/4x4/trucks stronger heading into winter, convertibles/sporty in spring/summer, year-end clearance pressure as the calendar year closes).
5. Model-year cycle — this is a ${vehicle.year}. Consider whether a redesign/refresh is imminent or already happened: if it is now the previous-generation "old style" it should sit below the newer one; a fresh redesign can command more; the closer next-year models are to landing, the more aging pressure on older-year units.
Then classify:
- "ok"    → the current price is appropriate once ALL of the above are considered — EVEN IF it is above or below raw market average. Above market is fine when justified (low km, fresh redesign, in-season demand, desirable colour); below market is fine when justified (high km, old style, off-season, aged unit priced to move).
- "raise" → genuinely UNDERPRICED and leaving money on the table; recommend raising.
- "lower" → genuinely OVERPRICED for its situation and will sit too long; recommend lowering.
Only choose "raise" or "lower" when the price should actually change. When comps are thin or not trim-matched, default to "ok".`

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
        // Reliability: a like-for-like read. MarketCheck relaxes to "any trim of the
        // model" when a loaded trim has thin comps, which pools cheap base trims and
        // reads falsely over/under. Beyond ±45% is almost always a mismatched set.
        const _hasTrim = !!(vehicle.trim && String(vehicle.trim).trim())
        const _trimMatched = mc.matched_on ? !!mc.matched_on.trim : null
        const reliable = Math.abs(pct_diff) <= 45
          && (mc.count == null || mc.count >= PRICE_MIN_COMPS)
          && !(_hasTrim && _trimMatched === false && Math.abs(pct_diff) > 15)
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
        if (!reliable) {
          const reason = (_hasTrim && _trimMatched === false)
            ? 'aren’t matched to this exact trim (they include other trims of the ' + (vehicle.model || 'model') + '), so the $' + mid.toLocaleString() + ' ' + currency + ' average likely understates a loaded trim'
            : (mc.count != null && mc.count < PRICE_MIN_COMPS)
              ? 'are too thin a sample (' + mc.count.toLocaleString() + ' listing' + (mc.count === 1 ? '' : 's') + ') to trust for a rare or premium trim — the $' + mid.toLocaleString() + ' ' + currency + ' average can be well off'
              : 'give an average of $' + mid.toLocaleString() + ' ' + currency + ' that’s far from your price'
          note = `Low-confidence read: the ${mc.count.toLocaleString()} comparable listings we found ${reason}. Verify the trim against a book (Black Book/vAuto) before repricing — don’t treat the % to market as exact.`
        }
        // Verdict = the ACTION. Low-confidence reads never flag a reprice — they stay
        // "ok" with the note explaining why. Only a reliable read asks the AI to judge
        // raise / hold / lower from the full appraisal context (days-on-lot, mileage,
        // season, model-year cycle). One AI call does both insight + verdict — no extra cost.
        let pricingVerdict = 'ok', verdictHeadline = null, verdictReason = null
        let daysToSell = pct_diff > 15 ? 75 : pct_diff > 5 ? 55 : pct_diff < -5 ? 25 : 40
        try {
          if (reliable && process.env.ANTHROPIC_API_KEY) {
            const anthropicN = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
            const msg = await anthropicN.messages.create({
              model: 'claude-sonnet-5', max_tokens: 600,
              system: 'You are a dealer-grade automotive pricing analyst. Respond with ONLY one valid JSON object — no markdown, no preamble.',
              messages: [{ role: 'user', content: `Vehicle: ${vehicleLabel}, ${mileageText}${vehicle.exterior_color ? ', ' + vehicle.exterior_color : ''}, listed at $${yourPrice.toLocaleString()} ${currency} in ${location}.
Real market data from ${mc.count} comparable listings: average $${mid.toLocaleString()} ${currency} (range $${mc.low_price.toLocaleString()}–$${mc.high_price.toLocaleString()}), average mileage ${mc.median_mileage ? mc.median_mileage.toLocaleString() + ' ' + distanceUnit : 'n/a'}. The listing is ${Math.abs(pct_diff)}% ${pct_diff > 0 ? 'above' : 'below'} market. Mileage rating: ${mileageRating}.

${verdictGuidance}

Respond with ONLY this JSON:
{"insight":"<two plain, specific, factual sentences of market insight for the dealer>","verdict":"ok"|"raise"|"lower","headline":"<max 6 words, e.g. 'Priced to turn' / 'Underpriced — room to raise' / 'Overpriced — trim to sell'>","reason":"<one or two sentences citing the deciding factors: days on lot, mileage, season, model cycle>","days_to_sell":<integer realistic days to sell at this price>}` }]
            })
            const t = (msg.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim()
            const j = t ? JSON.parse(t.replace(/^```json?\s*/i, '').replace(/```\s*$/i, '').trim()) : null
            if (j) {
              if (j.insight) note = String(j.insight)
              if (['ok', 'raise', 'lower'].includes(j.verdict)) pricingVerdict = j.verdict
              if (j.headline) verdictHeadline = String(j.headline)
              if (j.reason) verdictReason = String(j.reason)
              if (Number.isFinite(Number(j.days_to_sell))) daysToSell = Math.round(Number(j.days_to_sell))
            }
          }
        } catch { /* insight/verdict best-effort — the numbers stand on their own */ }
        if (!reliable) {
          pricingVerdict = 'ok'
          verdictHeadline = 'Low-confidence read'
          verdictReason = 'Comps are thin or not trim-matched — verify against a book before repricing.'
        }

        const estimate = {
          low: mc.low_price, mid, high: mc.high_price, currency,
          price_to_market_pct: ptm,
          days_on_market_estimate: daysToSell,
          pricing_verdict: pricingVerdict,
          verdict_headline: verdictHeadline,
          verdict_reason: verdictReason,
          confidence: !reliable ? 'low' : mc.count >= 25 ? 'high' : mc.count >= 8 ? 'medium' : 'low',
          reliable,
          trim_matched: _trimMatched,
          comp_count: mc.count ?? null,
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
          // The actual comps behind the average, so the dealer can verify the match
          // (right trim? right mileage?) instead of trusting a black-box number.
          comps: (mc.listings || [])
            .filter(l => Number(l.price) > 0)
            .sort((a, b) => (a.price || 0) - (b.price || 0))
            .slice(0, 20)
            .map(l => ({ year: l.year ?? null, trim: l.trim ?? null, price: l.price ?? null, mileage: l.miles ?? null, region: l.region ?? null, dealer: l.dealer ?? null, url: l.vdp_url ?? null })),
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
Days on lot: ${daysOnLot == null ? 'unknown' : daysOnLot + ' days'} · Today: ${todayContext}
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

${verdictGuidance}

Respond with ONLY valid JSON (no markdown, no explanation, no trailing commas):
{
  "low": <integer ${currency}, lower bound of fair retail range for this exact vehicle>,
  "mid": <integer ${currency}, typical asking price for comparable listings>,
  "high": <integer ${currency}, upper bound — well-equipped or low-mileage premium>,
  "currency": "${currency}",
  "price_to_market_pct": <integer, listed price as % of mid, e.g. 98 = 2% below market>,
  "days_on_market_estimate": <integer, realistic days to sell at listed price>,
  "pricing_verdict": "ok" | "raise" | "lower",
  "verdict_headline": "<max 6 words, e.g. 'Priced to turn' / 'Underpriced — room to raise' / 'Overpriced — trim to sell'>",
  "verdict_reason": "<one or two sentences citing the deciding factors: days on lot, mileage, season, model-year cycle>",
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

    // Never flag a reprice off a low-confidence read — fall back to "ok" with a note.
    if (!['ok', 'raise', 'lower'].includes(estimate.pricing_verdict) || estimate.confidence === 'low' || estimate.reliable === false) {
      if (estimate.pricing_verdict && estimate.pricing_verdict !== 'ok') {
        estimate.verdict_headline = estimate.verdict_headline || 'Low-confidence read'
        estimate.verdict_reason = 'Comps are limited — verify against a book before repricing.'
      }
      estimate.pricing_verdict = 'ok'
    }

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
      .select('id, year, make, model, trim, price, mileage, condition, last_synced_at, created_at, lot_date')
      .eq('dealership_id', req.dealershipId)
      .eq('status', 'available')
    if (error) return res.status(500).json({ error: error.message })

    const now = Date.now()
    const suggestions = []

    for (const vehicle of vehicles || []) {
      // Days on lot = time since the unit landed (true lot_date when the feed gave
      // one, else created_at = first-seen). last_synced_at is rewritten every sync,
      // so it can NEVER be used for aging — it would keep the count near 0.
      const refDate = vehicle.lot_date || vehicle.created_at || vehicle.last_synced_at
      const daysOnLot = refDate ? Math.floor((now - new Date(refDate).getTime()) / 86400000) : 0
      if (daysOnLot < days_on_lot_threshold) continue
      if (!vehicle.price || !vehicle.make || !vehicle.model) continue
      if (skipPriceComp(vehicle)) continue // new / current-year units have no used-market comp

      // Compare against the MARKET (MarketCheck/scraper — same source as the price
      // report), so a unit priced above real market gets flagged even when it's in
      // line with the store's own copies. Fall back to the internal-inventory median
      // when no market data is available.
      let med = null, medCount = null, trimMatched = null
      const mm = await marketMedianForScan({ vehicle, dealer, isUS: _reIsUS, dealershipId: req.dealershipId, isOwner: (req.user.email || '').toLowerCase() === OWNER_EMAIL, allowLive: true })
      if (mm?.median) { med = mm.median; medCount = mm.count ?? null; trimMatched = mm.matched_on ? !!mm.matched_on.trim : null }
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
        med = median(prices); medCount = prices.length; trimMatched = null   // internal fallback isn't trim-matched
      }
      if (!med) continue

      const pct_diff = ((Number(vehicle.price) - med) / med) * 100
      if (pct_diff <= overprice_threshold_pct) continue
      // ── Don't cry wolf on a mismatched comp set (the "drop $21k when vAuto says
      // 102%" bug). MarketCheck relaxes to "any trim of the model" when a loaded
      // trim has thin local comps, which pools cheap base trims and reads falsely
      // overpriced. Suppress the recommendation unless it's a like-for-like read:
      const hasTrim = !!(vehicle.trim && String(vehicle.trim).trim())
      if (pct_diff > 45) continue                                   // beyond ±45% = almost always bad comps
      if (hasTrim && trimMatched === false) continue                // comps weren't matched to this trim
      if (medCount != null && medCount < PRICE_MIN_COMPS) continue  // too thin a sample to trust

      const suggestedPrice = Math.round(Number(vehicle.price) * (1 - price_drop_pct / 100))
      const label = [vehicle.year, vehicle.make, vehicle.model, vehicle.trim].filter(Boolean).join(' ')
      const marketBasis = mm?.mileage_adjusted ? 'mileage-adjusted market value' : 'market median'
      const note = `${daysOnLot} days on lot — suggest reducing price by ${price_drop_pct}% to $${suggestedPrice.toLocaleString()} (currently ${Math.round(pct_diff)}% above ${marketBasis} $${Math.round(med).toLocaleString()})`

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
        comp_count: medCount,
        trim_matched: trimMatched,
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

}
