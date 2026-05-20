// background.js
// Listens for messages from content.js and popup.js

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  // Content script signals a listing was successfully posted
  if (msg.type === 'LISTING_POSTED') {
    chrome.storage.local.get(['token'], async ({ token }) => {
      if (!token) return

      try {
        await fetch('https://vehicle-marketplace-s0e4.onrender.com/listings', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`
          },
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
    return true // keep message channel open for async response
  }
})