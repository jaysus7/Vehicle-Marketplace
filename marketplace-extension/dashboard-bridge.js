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
      // Hard circuit breaker: count attempts across this tab's whole session, not
      // just "tried once then reset" — that reset is what allowed an infinite loop
      // when something else (a dashboard.js crash, a storage race) kept re-triggering
      // syncAuth() before the guard could catch it.
      const attempts = Number(sessionStorage.getItem('ms_autologin_attempts') || '0')
      if (attempts >= 2) {
        sessionStorage.removeItem('ms_autologin_attempts')
        chrome.storage.local.remove(['token', 'user'])
        console.warn('[MarketSync] Autologin loop detected — clearing extension auth to break the cycle.')
        return
      }
      sessionStorage.setItem('ms_autologin_attempts', String(attempts + 1))
      setPageAuth(ext.token, ext.user)
      if (onLoginPage()) {
        location.replace('dashboard.html')
      }
      // If we're already on a non-login page (e.g. dashboard.html itself), don't
      // reload — just let the page's own script pick up the token we just set.
    }
  }

  // Lightweight one-way push: whenever the SITE has a token the extension doesn't
  // (e.g. right after a passkey login, which sets localStorage after this script has
  // already run), mirror it into the extension. Safe to call repeatedly — it only
  // writes when they differ, and never touches the auto-login loop logic.
  async function pushSiteToExt() {
    const page = getPageAuth()
    if (!page?.token) return
    const ext = await getExtAuth()
    if (!ext || ext.token !== page.token) {
      sessionStorage.removeItem('ms_logged_out')
      chrome.storage.local.set({ token: page.token, user: page.user ?? ext?.user ?? null })
    }
  }

  syncAuth()

  // Passkey / async logins set the token milliseconds-to-seconds after this script
  // runs and often without a navigation, so a single check at load misses them.
  // Poll briefly after load, and re-check whenever the tab regains focus, so the
  // extension picks up the login without the user reloading anything.
  let _pushTicks = 0
  const _pushTimer = setInterval(() => {
    pushSiteToExt()
    if (++_pushTicks >= 40) clearInterval(_pushTimer) // ~2 min of 3s polling, then stop
  }, 3000)
  window.addEventListener('focus', pushSiteToExt)
  document.addEventListener('visibilitychange', () => { if (!document.hidden) pushSiteToExt() })
  // The dashboard can also nudge us the instant it finishes logging in.
  window.addEventListener('message', (e) => {
    if (e.source === window && e.data?.__marketsync === true && e.data.dir === 'from-page' && e.data.type === 'AUTH_CHANGED') {
      pushSiteToExt()
    }
  })

  // Keep them in sync after load: if the extension logs out (popup sign-out) while
  // the dashboard is open, clear the site too; if it logs in, adopt that token.
 try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes.token) return
      const newTok = changes.token.newValue
      if (!newTok) {
        if (getPageAuth()) { clearPageAuth(); location.replace('login.html') }
      } else if (getPageAuth()?.token !== newTok) {
        // Cap reloads from this listener too — same loop risk as the autologin path.
        const reloadAttempts = Number(sessionStorage.getItem('ms_storage_reload_attempts') || '0')
        if (reloadAttempts >= 2) {
          console.warn('[MarketSync] Storage-sync reload loop detected — stopping.')
          return
        }
        sessionStorage.setItem('ms_storage_reload_attempts', String(reloadAttempts + 1))
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
