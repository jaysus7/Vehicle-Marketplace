// ─────────────────────────────────────────────────────────────────────────
// AI Vision — listing photo quality scoring (part of AI Boost).
//
// Cost-controlled by design:
//   1. Free local pass with sharp across the WHOLE gallery — resolution,
//      brightness, and blank/placeholder detection on every photo. No API cost.
//   2. ONE Claude vision call per vehicle that looks at the whole gallery (up to
//      12 downscaled images in a single message) and judges what sharp can't:
//      overall quality, per-photo issues, the strongest hero, and — the real
//      value — GALLERY COVERAGE (is a buyer missing the odometer, engine bay,
//      interior, etc.?). Uses Haiku (cheap); ~1 call per vehicle.
//   3. Incremental + cached — only vehicles with photos and no photo_checked_at
//      (or a changed photo count) are scored. Metered via the cost layer.
//
// Produces a 0–100 photo_score + human-readable flags, stored on the inventory
// row (photo_score / photo_flags / photo_analysis / photo_checked_at).
// ─────────────────────────────────────────────────────────────────────────
import { supabaseAdmin } from '../shared.js'
import { recordUsage } from '../usage.js'

const HERO_MODEL = 'claude-haiku-4-5-20251001'
const MAX_INSPECT = 16           // sharp-inspect at most this many photos/vehicle (free)
const MAX_VISION = 12            // images sent to Claude in the single gallery call
const CONCURRENCY = 2            // vehicles analyzed in parallel (kept low for the 512MB tier)

async function fetchBuffer(url, timeoutMs = 12000) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) return null
    return Buffer.from(await res.arrayBuffer())
  } catch { return null }
}

// Fetch one photo and, in a single pass, run the free local sharp checks AND
// produce the small 512px JPEG the vision call needs — then let the full-res
// buffer go out of scope. This is the key memory guard: we never retain a
// gallery of multi-MB originals, only the tiny downscaled copies (~40KB each),
// so peak RAM stays well under the 512MB tier even mid-sync.
async function fetchAndAnalyze(url) {
  const buf = await fetchBuffer(url)
  if (!buf) return null
  try {
    const sharp = (await import('sharp')).default
    const meta = await sharp(buf, { failOn: 'none' }).metadata()
    const stats = await sharp(buf, { failOn: 'none' }).stats()
    const width = meta.width || 0
    const height = meta.height || 0
    // Mean luminance (0–255) across channels, and how "flat" the image is.
    const means = stats.channels.map(c => c.mean)
    const stdevs = stats.channels.map(c => c.stdev)
    const brightness = means.length ? means.reduce((a, b) => a + b, 0) / means.length : 128
    const variation = stdevs.length ? stdevs.reduce((a, b) => a + b, 0) / stdevs.length : 50
    let small = null
    try {
      small = await sharp(buf, { failOn: 'none' })
        .resize({ width: 512, withoutEnlargement: true }).jpeg({ quality: 65 }).toBuffer()
    } catch { /* undecodable for downscale — still return the local metrics */ }
    return { width, height, brightness, variation, small }
  } catch { return null }
}

// One Claude vision call over the WHOLE gallery — overall quality, per-photo
// issues, the strongest hero, and gallery coverage (what shots are missing).
async function classifyGallery(smallBuffers) {
  if (!process.env.ANTHROPIC_API_KEY) return null
  try {
    // Buffers arrive already downscaled to 512px JPEG (see fetchAndAnalyze), so
    // there's nothing to resize here — just base64-encode for the vision call.
    const imgs = []
    for (const buf of smallBuffers) {
      if (!buf) continue
      imgs.push(buf.toString('base64'))
      if (imgs.length >= MAX_VISION) break
    }
    if (!imgs.length) return null

    const Anthropic = (await import('@anthropic-ai/sdk')).default
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
    const content = imgs.map(b64 => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } }))
    content.push({ type: 'text', text: `You are grading the PHOTO GALLERY of a used-car marketplace listing. ${imgs.length} photos are shown, in order (index 0 first). Return ONLY JSON:
{"overall":"good|fair|poor","best_hero_index":<0-based index of the strongest lead photo>,"missing_shots":[important shots a buyer expects that are NOT present — vocabulary: "exterior front","exterior rear","side profile","interior","dashboard/odometer","engine bay","seats","trunk/cargo","wheels/tires"],"issues":["short phrases: photo 3 blurry, several too dark, watermark, stock/placeholder image, poor lighting, cluttered background, hero doesn't show the vehicle"]}
Judge sharpness, lighting, framing, whether photos clearly show the actual vehicle, and how complete the gallery is. Be strict but fair.` })

    const call = anthropic.messages.create({
      model: HERO_MODEL,
      max_tokens: 500,
      messages: [{ role: 'user', content }],
    })
    const msg = await Promise.race([
      call,
      new Promise((_, rej) => setTimeout(() => rej(new Error('vision timeout')), 45000)),
    ])
    let text = (msg?.content?.[0]?.text || '').trim().replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/```\s*$/, '')
    const s = text.indexOf('{'), e = text.lastIndexOf('}')
    if (s >= 0 && e > s) text = text.slice(s, e + 1)
    const p = JSON.parse(text)
    return {
      overall: ['good', 'fair', 'poor'].includes(p.overall) ? p.overall : 'fair',
      best_hero_index: Number.isInteger(p.best_hero_index) ? p.best_hero_index : 0,
      missing_shots: Array.isArray(p.missing_shots) ? p.missing_shots.slice(0, 8) : [],
      issues: Array.isArray(p.issues) ? p.issues.slice(0, 6) : [],
      analyzed: imgs.length,
    }
  } catch { return null }
}

// Score one vehicle's photos → { score, flags, analysis }.
// Scoring out of 100: quantity 20 · technical quality across the gallery 20 ·
// AI overall quality 35 · AI gallery coverage 25.
export async function scoreVehiclePhotos(vehicle) {
  const urls = Array.isArray(vehicle.image_urls) ? vehicle.image_urls.filter(Boolean) : []
  const flags = []

  if (urls.length === 0) {
    return { score: 0, flags: ['No photos'], analysis: { photo_count: 0 } }
  }

  // 20 pts: quantity. Buyers expect a full gallery.
  const countScore = urls.length >= 10 ? 20 : urls.length >= 6 ? 15 : urls.length >= 3 ? 9 : 4
  if (urls.length < 6) flags.push(`Only ${urls.length} photo${urls.length === 1 ? '' : 's'}`)

  // Local pass across the whole gallery (free). Process ONE photo at a time so we
  // only ever hold a single full-res image in memory; each pass keeps just the
  // tiny downscaled copy for the vision call and drops the original.
  const inspectUrls = urls.slice(0, MAX_INSPECT)
  let darkCount = 0, tinyCount = 0, blankCount = 0, inspected = 0
  const perPhoto = []
  const smallBufs = []
  for (let i = 0; i < inspectUrls.length; i++) {
    const s = await fetchAndAnalyze(inspectUrls[i])
    if (!s) continue
    if (s.small) smallBufs.push(s.small)
    inspected++
    const issues = []
    if (s.width && s.width < 640) { tinyCount++; issues.push('low resolution') }
    if (s.brightness < 55) { darkCount++; issues.push('too dark') }
    if (s.variation < 12) { blankCount++; issues.push('blank/placeholder') }
    perPhoto.push({ index: i, width: s.width, height: s.height, issues })
  }
  // 20 pts: technical quality, scaled by how many photos are affected.
  let techScore = 20
  if (tinyCount) { techScore -= Math.min(8, tinyCount * 2); flags.push(`${tinyCount} low-resolution photo${tinyCount > 1 ? 's' : ''}`) }
  if (darkCount) { techScore -= Math.min(8, darkCount * 2); flags.push(`${darkCount} dark / underexposed photo${darkCount > 1 ? 's' : ''}`) }
  if (blankCount) { techScore -= Math.min(12, blankCount * 4); flags.push(`${blankCount} blank or placeholder image${blankCount > 1 ? 's' : ''}`) }
  techScore = Math.max(0, techScore)

  // 35 pts quality + 25 pts coverage: one Claude vision call over the gallery.
  let qualityScore = 22   // neutral defaults if vision is unavailable
  let coverageScore = 18
  const galleryBufs = smallBufs.slice(0, MAX_VISION)
  const g = galleryBufs.length ? await classifyGallery(galleryBufs) : null
  if (g) {
    qualityScore = g.overall === 'good' ? 35 : g.overall === 'fair' ? 22 : 8
    coverageScore = Math.max(0, 25 - (g.missing_shots.length * 4))
    if (g.missing_shots.length) flags.push(`Missing shots: ${g.missing_shots.slice(0, 5).join(', ')}`)
    if (g.overall === 'poor') flags.push('Poor overall photo quality')
    for (const iss of g.issues) {
      const f = iss.charAt(0).toUpperCase() + iss.slice(1)
      if (!flags.some(x => x.toLowerCase().includes(iss.toLowerCase()))) flags.push(f)
    }
    if (Number.isInteger(g.best_hero_index) && g.best_hero_index > 0 && g.best_hero_index < urls.length) {
      flags.push(`Lead with photo #${g.best_hero_index + 1} for a stronger hero`)
    }
  }

  const score = Math.max(0, Math.min(100, Math.round(countScore + techScore + qualityScore + coverageScore)))
  return {
    score,
    flags: [...new Set(flags)].slice(0, 10),
    analysis: {
      photo_count: urls.length,
      inspected,
      count_score: countScore,
      tech_score: techScore,
      quality_score: qualityScore,
      coverage_score: coverageScore,
      gallery: g,
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
    const { data: rows, error } = await supabaseAdmin
      .from('inventory')
      .select('id, image_urls, photo_checked_at, photo_analysis')
      .eq('dealership_id', dealershipId)
      .eq('status', 'available')
      .limit(max)
    if (error) { console.warn('[ai-vision] fetch failed:', error.message); return { scored: 0 } }

    // Score vehicles that were never checked, or whose photo count changed since the
    // last check — a unit scored before its photos synced would otherwise stay stuck
    // at "No photos / 0" forever even after 20 photos land.
    const todo = (rows || []).filter(r => {
      if (rescan || !r.photo_checked_at) return true
      const cur = Array.isArray(r.image_urls) ? r.image_urls.filter(Boolean).length : 0
      const prev = r.photo_analysis?.photo_count ?? null
      return prev !== cur
    })
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
        // Each scored vehicle is ~one Claude vision call — meter it (soft AI cap).
        if (analysis?.gallery) recordUsage(dealershipId, { ai: 1 })
      }))
    }
    if (scored) console.log(`[ai-vision] dealership ${dealershipId}: scored ${scored}/${todo.length} vehicles`)
    return { scored }
  } catch (e) {
    console.warn('[ai-vision] run failed (non-fatal):', e.message)
    return { scored: 0 }
  }
}
