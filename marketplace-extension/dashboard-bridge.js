// dashboard-bridge.js — runs on the MarketSync dashboard (marketsync.link).
// Bridges window.postMessage (page) ↔ chrome messaging (extension) so the dashboard
// can launch a Cloudflare browser-capture and show live progress WITHOUT the user
// opening the extension popup. The capture still runs in the extension (only the
// user's browser session gets past Cloudflare); this just lets the dashboard drive it.
(() => {
  const post = (msg) => window.postMessage({ __marketsync: true, dir: 'from-ext', ...msg }, '*')
  const version = (() => { try { return chrome.runtime.getManifest().version } catch { return null } })()

  // ── Single sign-on between the dashboard (marketsync.link) and the extension ──
  // Both store the same Supabase JWT: the site in localStorage('token'/'user'),
  // the extension in chrome.storage.local. We mirror them so signing into one
  // signs you into the other. This only ever runs on marketsync.link (manifest-
  // scoped) and only moves the user's own token between their own site + extension.
  const getPageAuth = () => {
    try {
      const token = localStorage.getItem('token')
      if (!token) return null
      let user = null
      try { user = JSON.parse(localStorage.getItem('user') || 'null') } catch {}
      return { token, user }
    } catch { return null }
  }
  const setPageAuth = (token, user) => {
    try {
      localStorage.setItem('token', token)
      if (user != null) localStorage.setItem('user', typeof user === 'string' ? user : JSON.stringify(user))
    } catch {}
  }
  const clearPageAuth = () => { try { localStorage.removeItem('token'); localStorage.removeItem('user') } catch {} }
  const getExtAuth = () => new Promise(r =>
    chrome.storage.local.get(['token', 'user'], ({ token, user }) => r(token ? { token, user } : null)))

  const onLoginPage = () =>
    /(^|\/)(login|register|index)\.html?$/.test(location.pathname) || location.pathname === '/'

  async function syncAuth() {
    const page = getPageAuth()
    const ext = await getExtAuth()
    const explicitLogout = sessionStorage.getItem('ms_logged_out') === '1'

    // Site is logged in → it's the source of truth. Push to the extension.
    if (page?.token) {
      sessionStorage.removeItem('ms_logged_out')
      sessionStorage.removeItem('ms_autologin_tried')
      if (!ext || ext.token !== page.token) {
        chrome.storage.local.set({ token: page.token, user: page.user ?? ext?.user ?? null })
      }
      return
    }

    // Site is NOT logged in.
    if (explicitLogout) {
      // The user deliberately signed out on the site → sign the extension out too.
      sessionStorage.removeItem('ms_logged_out')
      if (ext) chrome.storage.local.remove(['token', 'user'])
      return
    }

    if (ext?.token) {
      // Extension is logged in but the site isn't → log the site in automatically.
      // Guard against a loop if the token is expired: we try exactly once; if the
      // dashboard bounces us back here still tokenless, we treat the token as dead.
      if (sessionStorage.getItem('ms_autologin_tried') === '1') {
        sessionStorage.removeItem('ms_autologin_tried')
        chrome.storage.local.remove(['token', 'user'])
        return
      }
      sessionStorage.setItem('ms_autologin_tried', '1')
      setPageAuth(ext.token, ext.user)
      location.replace(onLoginPage() ? 'dashboard.html' : location.href)
    }
  }

  syncAuth()

  // Keep them in sync after load: if the extension logs out (popup sign-out) while
  // the dashboard is open, clear the site too; if it logs in, adopt that token.
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes.token) return
      const newTok = changes.token.newValue
      if (!newTok) {
        if (getPageAuth()) { clearPageAuth(); location.replace('login.html') }
      } else if (getPageAuth()?.token !== newTok) {
        chrome.storage.local.get(['user'], ({ user }) => { setPageAuth(newTok, user); location.reload() })
      }
    })
  } catch {}

  // Tell the page the extension is installed → dashboard enables its Pull button.
  post({ type: 'EXT_PRESENT', version })

  window.addEventListener('message', (e) => {
    if (e.source !== window) return
    const d = e.data
    if (!d || d.__marketsync !== true || d.dir !== 'from-page') return

    if (d.type === 'PING') { post({ type: 'EXT_PRESENT', version }); return }

    if (d.type === 'PULL_INVENTORY' && d.feedUrl) {
      chrome.runtime.sendMessage(
        { type: 'CONNECT_DEALER_SITE', url: d.feedUrl, feed_id: d.feedId || null },
        (resp) => {
          post({
            type: 'PULL_STARTED',
            feedId: d.feedId || null,
            ok: !!resp?.success,
            error: resp?.error || null,
            needsEnable: !!resp?.needsEnable
          })
        }
      )
    }
  })

  // Relay capture progress (background writes captureState as it runs).
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.captureState) {
        post({ type: 'CAPTURE_STATE', state: changes.captureState.newValue || null })
      }
    })
    chrome.storage.local.get(['captureState'], ({ captureState }) => {
      if (captureState) post({ type: 'CAPTURE_STATE', state: captureState })
    })
  } catch {}
})()
