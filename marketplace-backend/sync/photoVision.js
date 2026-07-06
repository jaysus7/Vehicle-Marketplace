// ─────────────────────────────────────────────────────────────────────────
// AI Vision — listing photo quality scoring (the "AI Vision" $49 add-on).
//
// Cost-controlled by design:
//   1. Free local pre-filter with sharp — resolution, brightness, and
//      blank/placeholder detection on the first few photos. No API cost.
//   2. ONE Claude vision call on the hero (first) photo to judge the things
//      sharp can't — blur, clutter, bad angle, "is this actually the vehicle".
//      Uses Haiku (cheap) and only the hero image.
//   3. Incremental + cached — only vehicles with photos and no photo_checked_at
//      are scored; re-runs skip already-scored cars. Ongoing cost ≈ pennies.
//
// Produces a 0–100 photo_score + human-readable flags, stored on the inventory
// row (photo_score / photo_flags / photo_analysis / photo_checked_at).
// ─────────────────────────────────────────────────────────────────────────
import { supabaseAdmin } from '../shared.js'

const HERO_MODEL = 'claude-haiku-4-5-20251001'
const MAX_PREFILTER = 4          // sharp-inspect at most this many photos/vehicle
const CONCURRENCY = 3            // vehicles analyzed in parallel

async function fetchBuffer(url, timeoutMs = 12000) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) return null
    return Buffer.from(await res.arrayBuffer())
  } catch { return null }
}

// Free local checks on a single image buffer via sharp.
async function inspectWithSharp(buf) {
  try {
    const sharp = (await import('sharp')).default
    const img = sharp(buf, { failOn: 'none' })
    const meta = await img.metadata()
    const stats = await img.stats()
    const width = meta.width || 0
    const height = meta.height || 0
    // Mean luminance (0–255) across channels, and how "flat" the image is.
    const means = stats.channels.map(c => c.mean)
    const stdevs = stats.channels.map(c => c.stdev)
    const brightness = means.length ? means.reduce((a, b) => a + b, 0) / means.length : 128
    const variation = stdevs.length ? stdevs.reduce((a, b) => a + b, 0) / stdevs.length : 50
    return { width, height, brightness, variation }
  } catch { return null }
}

// One Claude vision verdict on the hero photo (blur / composition / subject).
async function classifyHero(buf) {
  if (!process.env.ANTHROPIC_API_KEY) return null
  try {
    const Anthropic = (await import('@anthropic-ai/sdk')).default
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
    // Down-scale to keep the image token cost low.
    let media = 'image/jpeg', b64
    try {
      const sharp = (await import('sharp')).default
      const jpg = await sharp(buf, { failOn: 'none' }).resize({ width: 768, withoutEnlargement: true }).jpeg({ quality: 72 }).toBuffer()
      b64 = jpg.toString('base64')
    } catch { b64 = buf.toString('base64') }

    const prompt = `You are grading the HERO photo of a used-car marketplace listing. Return ONLY JSON:
{"quality":"good|fair|poor","is_vehicle":true|false,"issues":["short phrases: blurry, too dark, cluttered background, bad angle, watermark, stock/placeholder image, low resolution, obstructed"]}
Judge sharpness, lighting, framing, and whether it clearly shows the actual vehicle. Be strict but fair.`

    const call = anthropic.messages.create({
      model: HERO_MODEL,
      max_tokens: 300,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: media, data: b64 } },
          { type: 'text', text: prompt },
        ],
      }],
    })
    const msg = await Promise.race([
      call,
      new Promise((_, rej) => setTimeout(() => rej(new Error('vision timeout')), 30000)),
    ])
    let text = (msg?.content?.[0]?.text || '').trim().replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/```\s*$/, '')
    const s = text.indexOf('{'), e = text.lastIndexOf('}')
    if (s >= 0 && e > s) text = text.slice(s, e + 1)
    const parsed = JSON.parse(text)
    return {
      quality: ['good', 'fair', 'poor'].includes(parsed.quality) ? parsed.quality : 'fair',
      is_vehicle: parsed.is_vehicle !== false,
      issues: Array.isArray(parsed.issues) ? parsed.issues.slice(0, 6) : [],
    }
  } catch { return null }
}

// Score one vehicle's photos → { score, flags, analysis }.
export async function scoreVehiclePhotos(vehicle) {
  const urls = Array.isArray(vehicle.image_urls) ? vehicle.image_urls.filter(Boolean) : []
  const flags = []

  if (urls.length === 0) {
    return { score: 0, flags: ['No photos'], analysis: { photo_count: 0 } }
  }

  // 25 pts: quantity. Buyers expect a full gallery.
  const countScore = urls.length >= 10 ? 25 : urls.length >= 6 ? 18 : urls.length >= 3 ? 10 : 5
  if (urls.length < 5) flags.push(`Only ${urls.length} photo${urls.length === 1 ? '' : 's'}`)

  // Pre-filter the first few photos locally (free).
  let techScore = 25
  const perPhoto = []
  const inspectUrls = urls.slice(0, MAX_PREFILTER)
  const buffers = await Promise.all(inspectUrls.map(u => fetchBuffer(u)))
  let darkCount = 0, tinyCount = 0, blankCount = 0
  for (let i = 0; i < buffers.length; i++) {
    const buf = buffers[i]
    if (!buf) continue
    const s = await inspectWithSharp(buf)
    if (!s) continue
    const issues = []
    if (s.width && s.width < 640) { tinyCount++; issues.push('low resolution') }
    if (s.brightness < 55) { darkCount++; issues.push('too dark') }
    if (s.variation < 12) { blankCount++; issues.push('blank/placeholder') }
    perPhoto.push({ index: i, width: s.width, height: s.height, issues })
  }
  if (tinyCount) { techScore -= 8; flags.push('Low-resolution photo(s)') }
  if (darkCount) { techScore -= 8; flags.push('Dark / underexposed photo(s)') }
  if (blankCount) { techScore -= 12; flags.push('Blank or placeholder image') }
  techScore = Math.max(0, techScore)

  // 50 pts: hero-photo quality via Claude vision (the "AI" judgement).
  let heroScore = 35   // neutral default if vision unavailable
  let hero = null
  const heroBuf = buffers[0] || await fetchBuffer(urls[0])
  if (heroBuf) hero = await classifyHero(heroBuf)
  if (hero) {
    heroScore = hero.quality === 'good' ? 50 : hero.quality === 'fair' ? 32 : 12
    if (!hero.is_vehicle) { heroScore = Math.min(heroScore, 10); flags.push('Hero photo may not show the vehicle') }
    if (hero.quality === 'poor') flags.push('Poor hero photo')
    for (const iss of hero.issues) {
      const f = iss.charAt(0).toUpperCase() + iss.slice(1)
      if (!flags.some(x => x.toLowerCase().includes(iss.toLowerCase()))) flags.push(f)
    }
  }

  const score = Math.max(0, Math.min(100, Math.round(countScore + techScore + heroScore)))
  return {
    score,
    flags: [...new Set(flags)].slice(0, 8),
    analysis: {
      photo_count: urls.length,
      count_score: countScore,
      tech_score: techScore,
      hero_score: heroScore,
      hero,
      per_photo: perPhoto,
      scored_at: new Date().toISOString(),
    },
  }
}

/**
 * Score a dealership's un-scored inventory photos. Caller should ensure the
 * dealership has AI Vision active. Safe to fire-and-forget.
 *
 * @param {string} dealershipId
 * @param {object} [opts]
 * @param {number} [opts.max=300]   cap vehicles per run
 * @param {boolean} [opts.rescan]   re-score even already-checked vehicles
 */
export async function runPhotoVision(dealershipId, { max = 300, rescan = false } = {}) {
  if (!dealershipId) return { scored: 0 }
  try {
    let q = supabaseAdmin
      .from('inventory')
      .select('id, image_urls, photo_checked_at')
      .eq('dealership_id', dealershipId)
      .eq('status', 'available')
      .limit(max)
    if (!rescan) q = q.is('photo_checked_at', null)
    const { data: rows, error } = await q
    if (error) { console.warn('[ai-vision] fetch failed:', error.message); return { scored: 0 } }

    const todo = (rows || []).filter(r => Array.isArray(r.image_urls) && r.image_urls.length >= 0)
    if (!todo.length) return { scored: 0 }

    let scored = 0
    for (let i = 0; i < todo.length; i += CONCURRENCY) {
      const batch = todo.slice(i, i + CONCURRENCY)
      await Promise.all(batch.map(async row => {
        const { score, flags, analysis } = await scoreVehiclePhotos(row)
        const { error: upErr } = await supabaseAdmin.from('inventory').update({
          photo_score: score,
          photo_flags: flags,
          photo_analysis: analysis,
          photo_checked_at: new Date().toISOString(),
        }).eq('id', row.id)
        if (!upErr) scored++
      }))
    }
    if (scored) console.log(`[ai-vision] dealership ${dealershipId}: scored ${scored}/${todo.length} vehicles`)
    return { scored }
  } catch (e) {
    console.warn('[ai-vision] run failed (non-fatal):', e.message)
    return { scored: 0 }
  }
}
