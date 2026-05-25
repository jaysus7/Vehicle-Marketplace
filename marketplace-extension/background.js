// background.js
const API = 'https://vehicle-marketplace-s0e4.onrender.com'
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  // Record a listing as posted
  if (msg.type === 'LISTING_POSTED') {
    chrome.storage.local.get(['token'], async ({ token }) => {
      if (!token) return
      try {
        await fetch(`${API}/listings`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            inventory_id: msg.inventory_id,
            fb_listing_id: msg.fb_listing_id || null,
            fb_listing_url: msg.fb_listing_url || null
          })
        })
        sendResponse({ success: true })
      } catch (e) {
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
})
