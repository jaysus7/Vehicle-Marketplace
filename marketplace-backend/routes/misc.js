import * as dnsLib from 'dns'

function isPrivateIp(ip) {
  if (dnsLib.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number)
    return (
      a === 10 || a === 127 || a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    )
  }
  return true
}

async function isSafeImageUrl(rawUrl) {
  let parsed
  try { parsed = new URL(rawUrl) } catch { return false }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
  if (parsed.hostname === 'localhost') return false
  try {
    const { address } = await dnsLib.promises.lookup(parsed.hostname)
    if (isPrivateIp(address)) return false
  } catch {
    return false
  }
  return true
}

export function registerRoutes(app) {
  app.get('/proxy-image', async (req, res) => {
    const { url } = req.query
    if (!url || typeof url !== 'string') return res.status(400).json({ error: 'No URL provided' })
    if (!(await isSafeImageUrl(url))) return res.status(400).json({ error: 'Invalid or disallowed URL' })
    try {
      const response = await fetch(url)
      const buffer = await response.arrayBuffer()
      const contentType = response.headers.get('content-type') || 'image/jpeg'
      res.set({
        'Content-Type': contentType,
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=3600'
      })
      res.send(Buffer.from(buffer))
    } catch (e) {
      res.status(500).json({ error: 'Failed to fetch image' })
    }
  })
}
