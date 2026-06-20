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
        const granted = await chrome.permissions.request({ origins: [origin] })
        if (!granted) {
          sendResponse({ success: false, error: 'Permission denied — needed to scan the dealer site.' })
          return
        }
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

  // Step 2: content script (dealer-extract.js) posts the scraped vehicles
  // back to us. We forward to MarketSync's /feeds/:id/extension-capture.
  if (msg.type === 'DEALER_INVENTORY_CAPTURED') {
    chrome.storage.local.get(['token'], async ({ token }) => {
      if (!token) {
        sendResponse({ success: false, error: 'Not signed in to MarketSync' })
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
          sendResponse({ success: false, status: r.status, error: body.error || `HTTP ${r.status}` })
          return
        }
        sendResponse({ success: true, ...body })
        // Auto-close the tab we opened (only if it's not the user's active tab)
        if (sender.tab?.id) {
          chrome.tabs.get(sender.tab.id, (t) => {
            if (t && !t.active) chrome.tabs.remove(sender.tab.id).catch(() => {})
          })
        }
      } catch (e) {
        console.error('extension-capture threw:', e)
        sendResponse({ success: false, error: e.message })
      }
    })
    return true
  }
})
