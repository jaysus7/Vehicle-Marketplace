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

  // Download all vehicle photos, then open file picker, then auto-delete
  if (msg.type === 'DOWNLOAD_AND_PICK') {
    const { imageUrls, vehicleName } = msg
    const downloadIds = []
    let completed = 0

    const downloadNext = (index) => {
      if (index >= imageUrls.length) return

      const url = `${API}/proxy-image?url=${encodeURIComponent(imageUrls[index])}`
      const filename = `WellandChev_Temp/${vehicleName}_photo_${index + 1}.jpg`
        .replace(/[^a-zA-Z0-9_\-\/\.]/g, '_')

      chrome.downloads.download({ url, filename, saveAs: false }, (downloadId) => {
        if (downloadId) downloadIds.push(downloadId)
      })
    }

    // Download all photos
    imageUrls.forEach((_, i) => setTimeout(() => downloadNext(i), i * 300))

    // Wait for all downloads then notify content script
    const checkInterval = setInterval(() => {
      if (downloadIds.length < imageUrls.length) return

      let allDone = true
      let checkCount = 0

      downloadIds.forEach(id => {
        chrome.downloads.search({ id }, (results) => {
          checkCount++
          if (results[0]?.state !== 'complete') allDone = false
          if (checkCount === downloadIds.length) {
            if (allDone) {
              clearInterval(checkInterval)
              // Tell content script downloads are ready
              chrome.tabs.sendMessage(sender.tab.id, {
                type: 'PHOTOS_READY',
                downloadIds,
                count: imageUrls.length
              })
            }
          }
        })
      })
    }, 1000)

    // Safety timeout after 30 seconds
    setTimeout(() => clearInterval(checkInterval), 30000)

    sendResponse({ success: true })
    return true
  }

  // Delete temp photos after upload
  if (msg.type === 'DELETE_TEMP_PHOTOS') {
    const { downloadIds } = msg
    downloadIds.forEach(id => {
      chrome.downloads.removeFile(id, () => {
        chrome.downloads.erase({ id })
      })
    })
    sendResponse({ success: true })
    return true
  }
})
