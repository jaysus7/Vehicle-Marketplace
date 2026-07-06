// ─────────────────────────────────────────────────────────────────────────
// OEM window sticker lookup — tries to fetch the REAL manufacturer Monroney
// label (the original window sticker) by VIN, so a dealer sees the authentic
// factory document when it's available, and we only fall back to a generated
// sticker when it isn't.
//
// Reality of coverage: the window sticker is produced per-manufacturer, and
// only a few brands publish it publicly by VIN. Ford/Lincoln have a genuinely
// public, reliable endpoint — that's what we start with. Each provider is a
// small self-contained function, so more public brands can be added over time
// (and a paid Monroney API could slot in here later for near-universal cover).
// ─────────────────────────────────────────────────────────────────────────

const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/i

// A real Monroney PDF is a proper PDF and never trivially small. Manufacturer
// "not found" responses are usually an HTML page or a tiny placeholder.
function looksLikePdf(buf) {
  return buf && buf.length > 8000 && buf.slice(0, 5).toString('latin1') === '%PDF-'
}

// Shared: GET a candidate URL and accept it only if it's a real PDF.
async function fetchPdf(url) {
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(15000) })
  if (!res.ok) return null
  const ct = (res.headers.get('content-type') || '').toLowerCase()
  if (ct && !ct.includes('pdf') && !ct.includes('octet-stream')) return null
  const buf = Buffer.from(await res.arrayBuffer())
  return looksLikePdf(buf) ? buf : null
}

// Ford Direct publishes Ford + Lincoln window stickers publicly by VIN.
async function fordProvider(vin) {
  const buf = await fetchPdf(`https://www.windowsticker.forddirect.com/windowsticker.pdf?vin=${encodeURIComponent(vin)}`)
  return buf ? { buffer: buf, provider: 'Ford' } : null
}

// Stellantis (FCA) exposes a public window-sticker PDF by VIN on each brand
// site via the shared /hostd/windowsticker/getWindowStickerPdf.do path.
function stellantisProvider(host, label) {
  return async (vin) => {
    const buf = await fetchPdf(`https://www.${host}/hostd/windowsticker/getWindowStickerPdf.do?vin=${encodeURIComponent(vin)}`)
    return buf ? { buffer: buf, provider: label } : null
  }
}
const chryslerProvider = stellantisProvider('chrysler.com', 'Chrysler')
const dodgeProvider    = stellantisProvider('dodge.com', 'Dodge')
const jeepProvider     = stellantisProvider('jeep.com', 'Jeep')
const ramProvider      = stellantisProvider('ramtrucks.com', 'Ram')
const fiatProvider     = stellantisProvider('fiatusa.com', 'Fiat')

// GM exposes a public window-sticker PDF by VIN for 2020+ Chevrolet, GMC,
// Buick and Cadillac via its Consumer Web Services API.
async function gmProvider(vin) {
  const buf = await fetchPdf(`https://cws.gm.com/vs-cws/vehshop/v2/vehicle/windowsticker?vin=${encodeURIComponent(vin)}`)
  return buf ? { buffer: buf, provider: 'GM' } : null
}

// Map a make to the providers worth trying (avoids pointless cross-brand calls).
// Only brands with a genuinely public by-VIN endpoint are wired. Everything
// else (GM, Toyota, Honda, Hyundai/Kia, Nissan, VW/Audi, and the luxury imports)
// has no free public source — those fall back to the generated sticker, and are
// where a paid Monroney API (MonroneyLabels / MarketCheck / DataOne) would slot in.
function providersFor(make) {
  const m = (make || '').toLowerCase()
  const list = []
  if (/\bford\b|lincoln/.test(m)) list.push(fordProvider)
  if (/chrysler/.test(m))                       list.push(chryslerProvider)
  if (/\bdodge\b/.test(m))                       list.push(dodgeProvider)
  if (/\bjeep\b/.test(m))                        list.push(jeepProvider)
  if (/\bram\b|ramtrucks/.test(m))               list.push(ramProvider)
  if (/\bfiat\b/.test(m))                        list.push(fiatProvider)
  if (/chevrolet|chevy|\bgmc\b|buick|cadillac|\bgm\b/.test(m)) list.push(gmProvider)
  // Unknown/blank make → try the public families before giving up.
  if (!list.length) list.push(fordProvider, jeepProvider, gmProvider)
  return list
}

/**
 * Attempt to fetch the authentic OEM window sticker PDF for a vehicle.
 * Returns { buffer, provider } on success, or null if no public source has it.
 * Never throws — safe to call inline.
 *
 * @param {object} vehicle  inventory row (needs vin + make)
 */
export async function fetchOemWindowStickerPdf(vehicle) {
  const vin = (vehicle?.vin || '').trim().toUpperCase()
  if (!VIN_RE.test(vin)) return null
  for (const provider of providersFor(vehicle.make)) {
    try {
      const hit = await provider(vin)
      if (hit) return hit
    } catch (e) {
      console.warn('[oem-sticker] provider failed:', e.message)
    }
  }
  return null
}
