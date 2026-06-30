// background.js
const API = 'https://vehicle-marketplace-s0e4.onrender.com'
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  // Record a listing as posted
  if (msg.type === 'LISTING_POSTED') {
    chrome.storage.local.get(['token'], async ({ token }) => {
      if (!token) {
        sendResponse({ success: false, error: 'Not signed in' })
        return
      }
      try {
        const r = await fetch(`${API}/listings`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            inventory_id: msg.inventory_id,
            fb_listing_id: msg.fb_listing_id || null,
            fb_listing_url: msg.fb_listing_url || null
          })
        })
        if (!r.ok) {
          const body = await r.text().catch(() => '')
          console.error(`POST /listings failed: ${r.status}`, body)
          sendResponse({ success: false, status: r.status, error: body || `HTTP ${r.status}` })
          return
        }
        sendResponse({ success: true })
      } catch (e) {
        console.error('POST /listings threw:', e)
        sendResponse({ success: false, error: e.message })
      }
    })
    return true
  }

  // Download all vehicle photos
  if (msg.type === 'DOWNLOAD_PHOTOS') {
    const { imageUrls } = msg
    const downloadIds = []

    if (!chrome.downloads) {
      console.error('chrome.downloads not available')
      sendResponse({ success: false, error: 'Downloads API not available' })
      return true
    }

    const doDownloads = async () => {
      for (let i = 0; i < imageUrls.length; i++) {
        const url = `${API}/proxy-image?url=${encodeURIComponent(imageUrls[i])}`
        const filename = `WellandChev_Temp/photo_${String(i + 1).padStart(2, '0')}.jpg`
        await new Promise(resolve => {
          chrome.downloads.download(
            { url, filename, saveAs: false, conflictAction: 'overwrite' },
            id => {
              const err = chrome.runtime.lastError
              if (err) console.warn(`Download ${i+1} failed:`, err.message)
              else if (id) downloadIds.push(id)
              resolve()
            }
          )
        })
        await new Promise(r => setTimeout(r, 400))
      }
      console.log(`✅ Downloaded ${downloadIds.length}/${imageUrls.length} photos`)
      sendResponse({ success: true, downloadIds })
    }

    doDownloads()
    return true
  }

  // Delete temp photos after upload
  if (msg.type === 'DELETE_TEMP_PHOTOS') {
    const { downloadIds } = msg
    if (downloadIds?.length) {
      downloadIds.forEach(id => {
        chrome.downloads.removeFile(id, () => {
          chrome.downloads.erase({ id })
        })
      })
    }
    sendResponse({ success: true })
    return true
  }

  // ── EXTENSION-SIDE DEALER SITE CAPTURE ───────────────────────────────────
  // Pipeline: popup → background → permission grant → open tab → content
  //           script extracts → background forwards to MarketSync backend.
  // Bypasses Cloudflare / bot detection by using the user's own authenticated
  // Chrome session for the dealer-site fetches.

  // Step 1: popup asks us to register a new dealer site. We request host
  // permission for that origin so the dealer-extract content script can run.
  if (msg.type === 'CONNECT_DEALER_SITE') {
    (async () => {
      try {
        const origin = new URL(msg.url).origin + '/*'
        // The popup already requested this permission (it has the user gesture MV3
        // needs). Here we only verify it's present — requesting from a service worker
        // silently fails, which is what made the button look stuck.
        const has = await chrome.permissions.contains({ origins: [origin] })
        if (!has) {
          // needsEnable tells the dashboard to prompt the one-time "Enable one-click
          // capture" grant in the extension (web pages / service workers can't request
          // host permissions themselves — only an extension UI with a user gesture can).
          sendResponse({ success: false, needsEnable: true, error: 'Site access not granted. Open the MarketSync extension and click "Enable one-click capture", then try again.' })
          return
        }
        // Persist an in-progress marker so the (ephemeral) popup can show the true
        // status when it reopens — the capture runs in the background and outlives
        // the popup, so without this it looks like it "reset" to idle.
        await chrome.storage.local.set({
          captureState: { feedId: msg.feed_id || null, status: 'pulling', startedAt: Date.now() }
        })
        // Open the dealer site in a new tab. Once it loads, we inject the
        // extractor with msg.feed_id stashed on window so the content script
        // can include it when it phones home.
        const tab = await chrome.tabs.create({ url: msg.url, active: false })

        const onUpdated = (tabId, info) => {
          if (tabId !== tab.id || info.status !== 'complete') return
          chrome.tabs.onUpdated.removeListener(onUpdated)
          chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: (feedId) => { window.__marketsyncFeedId = feedId },
            args: [msg.feed_id || null]
          }).then(() => chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ['dealer-extract.js']
          })).catch(err => console.error('extract injection failed:', err))
        }
        chrome.tabs.onUpdated.addListener(onUpdated)

        sendResponse({ success: true, tab_id: tab.id })
      } catch (e) {
        sendResponse({ success: false, error: e.message })
      }
    })()
    return true
  }

  // Progress pings from the dealer-extract content script while it paginates the
  // dealer's inventory. We mirror them into captureState so the popup shows a %.
  if (msg.type === 'CAPTURE_PROGRESS') {
    const total = Number(msg.total) || 0
    const current = Number(msg.current) || 0
    const pct = total > 0 ? Math.min(95, Math.round((current / total) * 100)) : null
    chrome.storage.local.set({
      captureState: {
        feedId: msg.feed_id || null, status: 'pulling', phase: msg.phase || 'scanning',
        current, total, pct, startedAt: Date.now()
      }
    })
    return false  // no response needed
  }

  // Step 2: content script (dealer-extract.js) posts the scraped vehicles
  // back to us. We forward to MarketSync's /feeds/:id/extension-capture.
  if (msg.type === 'DEALER_INVENTORY_CAPTURED') {
    chrome.storage.local.get(['token'], async ({ token }) => {
      const setState = (s) => chrome.storage.local.set({
        captureState: { feedId: msg.feed_id || null, finishedAt: Date.now(), ...s }
      })
      if (!token) {
        await setState({ status: 'error', error: 'Not signed in to MarketSync' })
        sendResponse({ success: false, error: 'Not signed in to MarketSync' })
        return
      }
      // The extractor found nothing — surface that instead of a silent 0-vehicle upload.
      if (!Array.isArray(msg.vehicles) || msg.vehicles.length === 0) {
        await setState({ status: 'error', error: msg.error || 'No inventory detected on that page.' })
        sendResponse({ success: false, error: msg.error || 'No inventory detected on that page.' })
        return
      }
      try {
        const r = await fetch(`${API}/feeds/${encodeURIComponent(msg.feed_id)}/extension-capture`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
          },
          body: JSON.stringify({
            vehicles: msg.vehicles,
            source_url: msg.source_url,
            platform: msg.platform || 'extension_capture'
          })
        })
        const body = await r.json().catch(() => ({}))
        if (!r.ok) {
          console.error('extension-capture upload failed:', r.status, body)
          await setState({ status: 'error', error: body.error || `Upload failed (HTTP ${r.status})` })
          sendResponse({ success: false, status: r.status, error: body.error || `HTTP ${r.status}` })
          return
        }
        await setState({ status: 'done', count: body.upserted ?? msg.vehicles.length })
        sendResponse({ success: true, ...body })
        // Auto-close the tab we opened (only if it's not the user's active tab)
        if (sender.tab?.id) {
          chrome.tabs.get(sender.tab.id, (t) => {
            if (t && !t.active) chrome.tabs.remove(sender.tab.id).catch(() => {})
          })
        }
      } catch (e) {
        console.error('extension-capture threw:', e)
        await setState({ status: 'error', error: e.message })
        sendResponse({ success: false, error: e.message })
      }
    })
    return true
  }
})

// ── Facebook auto-sync (mark Sold / Delete) ───────────────────────────────────
// The backend flags listings whose vehicle was sold/deleted in MarketSync. We poll
// for them, open each FB listing in a background tab, and content.js performs the
// "Mark as sold" / "Delete listing" click, then reports back here. FB has no API
// for this — it can only run while Chrome is open and the user is logged into FB.

const FB_SYNC_ALARM = 'fbSyncPoll'
const FB_MAX_OPEN_PER_POLL = 3      // don't flood the user with tabs at once
const FB_REDISPATCH_MS = 6 * 60 * 1000  // re-open a still-pending listing at most this often

function fbItemIdFromUrl(url) {
  const m = String(url || '').match(/\/marketplace\/item\/(\d+)/)
  return m ? m[1] : null
}

async function pollFbSync() {
  // ── Proactive sold scanner ────────────────────────────────────────────────────
// Catches vehicles marked sold directly on Facebook (not through MarketSync).
// Every 4 hours, open each active FB listing in a hidden background tab —
// content.js's existing detectFbSoldBadge() + checkSold() logic does the rest
// and reports back via POST /listings/sync-fb-sold automatically.
const SOLD_SCAN_ALARM = 'soldScanPoll'
const SOLD_SCAN_MAX_OPEN_PER_RUN = 5   // don't flood the user with tabs at once
const SOLD_SCAN_TAB_LIFETIME_MS = 20000 // give content.js time to detect + report

async function runSoldScan() {
  const { token } = await chrome.storage.local.get(['token'])
  if (!token) return

  let listings
  try {
    const r = await fetch(`${API}/listings?status=posted`, {
      headers: { Authorization: `Bearer ${token}` }
    })
    if (!r.ok) return
    listings = await r.json()
  } catch { return }

  const toCheck = (Array.isArray(listings) ? listings : [])
    .filter(l => l.fb_listing_url)
    .slice(0, SOLD_SCAN_MAX_OPEN_PER_RUN)

  if (!toCheck.length) return
  console.log(`[MarketSync] Sold scan: checking ${toCheck.length} active FB listings`)

  for (let i = 0; i < toCheck.length; i++) {
    await new Promise(r => setTimeout(r, i * 8000)) // stagger to avoid FB rate limits
    try {
      const tab = await chrome.tabs.create({ url: toCheck[i].fb_listing_url, active: false })
      setTimeout(() => chrome.tabs.remove(tab.id).catch(() => {}), SOLD_SCAN_TAB_LIFETIME_MS)
    } catch (e) {
      console.warn('[MarketSync] Sold scan tab error:', e.message)
    }
  }
}
  const { token } = await chrome.storage.local.get(['token'])
  if (!token) return

  let pending
  try {
    const r = await fetch(`${API}/listings/pending-fb-sync`, {
      headers: { Authorization: `Bearer ${token}` }
    })
    if (!r.ok) return
    pending = await r.json()
  } catch { return }

  if (!Array.isArray(pending) || pending.length === 0) {
    await chrome.storage.local.set({ fbSyncQueue: {} })  // nothing pending → clear
    return
  }

  const { fbSyncQueue = {} } = await chrome.storage.local.get(['fbSyncQueue'])
  const now = Date.now()
  const queue = {}
  const toOpen = []

  for (const item of pending) {
    const itemId = fbItemIdFromUrl(item.fb_listing_url)
    if (!itemId) continue
    const prev = fbSyncQueue[itemId]
    const dispatchedAt = prev?.dispatchedAt || 0
    const entry = { listingId: item.id, action: item.fb_sync_action, fbUrl: item.fb_listing_url, dispatchedAt }
    if (toOpen.length < FB_MAX_OPEN_PER_POLL && (now - dispatchedAt) > FB_REDISPATCH_MS) {
      entry.dispatchedAt = now
      toOpen.push(item.fb_listing_url)
    }
    queue[itemId] = entry
  }

  // IMPORTANT: persist the queue BEFORE opening tabs, so content.js (which reads
  // fbSyncQueue on load) always finds its instructions when the tab finishes loading.
  await chrome.storage.local.set({ fbSyncQueue: queue })
  for (const url of toOpen) chrome.tabs.create({ url, active: false }).catch(() => {})
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Run a poll right now (e.g. popup just opened, or a sale was just recorded).
  if (msg.type === 'FB_SYNC_NOW') {
    pollFbSync()       // processes pending mark-sold/delete queue from MarketSync
    runSoldScan()       // proactively checks active FB listings for the sold badge
    sendResponse({ success: true })
    return true
  }

  // content.js reports the result of a Mark-Sold / Delete attempt.
  if (msg.type === 'FB_SYNC_REPORT') {
    chrome.storage.local.get(['token', 'fbSyncQueue'], async ({ token, fbSyncQueue }) => {
      if (token && msg.listingId) {
        try {
          await fetch(`${API}/listings/${msg.listingId}/fb-sync-done`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ ok: !!msg.ok })
          })
        } catch (e) { console.warn('fb-sync-done failed:', e.message) }
      }
      // On success, drop it from the local queue and close the tab we opened.
      if (msg.ok && fbSyncQueue && msg.itemId && fbSyncQueue[msg.itemId]) {
        delete fbSyncQueue[msg.itemId]
        await chrome.storage.local.set({ fbSyncQueue })
      }
      if (msg.ok && sender.tab?.id) {
        chrome.tabs.get(sender.tab.id, (t) => {
          if (t && !t.active) chrome.tabs.remove(sender.tab.id).catch(() => {})
        })
      }
      sendResponse({ success: true })
    })
    return true
  }
})

// Poll on install, on browser startup, and every 5 minutes.
// Sold scan runs less often (4 hours) since it opens visible-ish background tabs.
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(FB_SYNC_ALARM, { periodInMinutes: 5 })
  chrome.alarms.create(SOLD_SCAN_ALARM, { periodInMinutes: 240 })
  pollFbSync()
  setTimeout(runSoldScan, 10 * 60 * 1000) // wait 10 min after install/boot before first scan
})
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(FB_SYNC_ALARM, { periodInMinutes: 5 })
  chrome.alarms.create(SOLD_SCAN_ALARM, { periodInMinutes: 240 })
  pollFbSync()
  setTimeout(runSoldScan, 10 * 60 * 1000)
})
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === FB_SYNC_ALARM) pollFbSync()
  if (alarm.name === SOLD_SCAN_ALARM) runSoldScan()
})