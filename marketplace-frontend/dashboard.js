const API = 'https://vehicle-marketplace-s0e4.onrender.com';
// Carfax Canada report link by VIN. Swap to your dealer badge/report URL if you
// wire the Carfax account (the VIN is appended, URL-encoded).
const CARFAX_BASE = 'https://www.carfax.ca/vehicle-history-reports?vin=';

// Global HTML escaper. Used throughout the pipeline board, leads table, and other
// renderers. It was previously only defined locally inside one function, so those
// other call sites threw "Can't find variable: esc" mid-render — which left the
// Pipeline & Leads page stuck on "Loading…" (the render crashed before painting).
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// GET a JSON endpoint with a cold-start-friendly retry. The backend runs on a
// tier that spins down when idle, so the first request after a lull can hang or
// return a 502/503/504 for ~30–60s while it wakes. We retry those (and network
// errors) a few times with backoff, and surface the real status/message on final
// failure instead of a generic "could not load".
async function apiGetJson(path, { retries = 4, timeoutMs = 15000, onRetry } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetch(`${API}${path}`, {
        headers: { 'Authorization': `Bearer ${token || localStorage.getItem('token') || ''}` },
        signal: ctrl.signal,
        cache: 'no-store',   // avoid 304s that Response.ok treats as a failure
      });
      // IMPORTANT: keep the abort timer armed across the body read too. Reading
      // the body (r.json()) is a second network step — on a flaky mobile
      // connection the server can send the 200 headers and then stall mid-body.
      // If we clear the timer before r.json(), that read has no timeout and hangs
      // forever: the page is stuck on "Loading…" with no retry and no error (the
      // exact pipeline/leads "stuck loading" bug). Clearing the timer only after
      // the body is fully read means a stalled body aborts → retries → surfaces.
      if (r.ok) return await r.json();
      // Transient (waking up / gateway) → retry; otherwise fail with the body.
      if ([429, 500, 502, 503, 504].includes(r.status) && attempt < retries) {
        lastErr = new Error(`HTTP ${r.status}`);
      } else {
        let msg = `HTTP ${r.status}`;
        try { const b = await r.json(); if (b?.error) msg = b.error; } catch {}
        throw new Error(msg);
      }
    } catch (e) {
      if (e.name === 'AbortError') lastErr = new Error('Request timed out');
      else lastErr = e;
      if (attempt >= retries) throw lastErr;
    } finally {
      clearTimeout(timer);
    }
    if (typeof onRetry === 'function') try { onRetry(attempt + 1, retries + 1); } catch {}
    // Backoff: 1s, 2s, 4s, 6s — ride out a cold start without long silent hangs.
    await new Promise(res => setTimeout(res, Math.min(6000, 1000 * (attempt + 1))));
  }
  throw lastErr || new Error('Request failed');
}

// Generic JSON write helper (POST/PUT/PATCH/DELETE). Throws Error(body.error) on
// non-2xx so callers can try/catch + toast. Used by the built-in CRM.
async function apiSendJson(path, method = 'POST', body = null, { timeoutMs = 20000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`${API}${path}`, {
      method,
      headers: { 'Authorization': `Bearer ${token || localStorage.getItem('token') || ''}`, 'Content-Type': 'application/json' },
      body: body != null ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    let data = null; try { data = await r.json(); } catch {}
    if (!r.ok) throw new Error(data?.error || `HTTP ${r.status}`);
    return data || {};
  } finally { clearTimeout(timer); }
}

// Surface otherwise-invisible runtime errors so "stuck loading" symptoms become
// diagnosable instead of silent. Deduped so a repeating error doesn't spam.
;(function installGlobalErrorSurfacer() {
  let last = '';
  const show = (label, msg) => {
    const text = `${label}: ${msg}`;
    if (text === last) return; last = text;
    console.error('[MarketSync]', text);
    try { if (typeof showToast === 'function') showToast(text.slice(0, 160), 'error', 8000); } catch {}
  };
  window.addEventListener('error', (e) => show('JS error', e.message || String(e.error || e)));
  window.addEventListener('unhandledrejection', (e) => show('Unhandled', (e.reason && (e.reason.message || e.reason)) || 'promise rejection'));
})();

function showToast(message, type = 'info', duration = 4000) {
  const el = document.createElement('div');
  const colors = { success: 'bg-emerald-600', error: 'bg-red-600', info: 'bg-indigo-600' };
  el.className = `fixed bottom-6 left-1/2 -translate-x-1/2 z-[99999] px-5 py-3 rounded-xl text-white text-sm font-semibold shadow-xl transition-opacity ${colors[type] || colors.info}`;
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 400); }, duration);
}

// If the extension passed a token in the URL hash (#tk=...), store it into
// localStorage so the user is automatically logged in, then strip the hash.
;(function bootstrapExtensionToken() {
  try {
    const hash = window.location.hash
    const match = hash.match(/[#&]tk=([^&]+)/)
    if (match) {
      const tk = decodeURIComponent(match[1])
      localStorage.setItem('token', tk)
      // Replace hash without reloading so the token isn't left in browser history
      history.replaceState(null, '', window.location.pathname + window.location.search)
    }
  } catch {}
})()

// Keys that should survive localStorage.clear() (user-level UI preferences, not session data)
const PERSIST_KEYS = ['ms_tour_done', 'ms_ext_cta_dismissed'];
function clearLocalStorage() {
  const saved = {};
  PERSIST_KEYS.forEach(k => { try { const v = localStorage.getItem(k); if (v !== null) saved[k] = v; } catch {} });
  localStorage.clear();
  Object.entries(saved).forEach(([k, v]) => { try { localStorage.setItem(k, v); } catch {} });
}

// "Keep me signed in" window: if it has lapsed, drop the stored session so the
// user is returned to login instead of riding a stale token.
(function enforceRememberWindow() {
  try {
    const until = Number(localStorage.getItem('ms_remember_until') || '0');
    if (until && Date.now() > until) clearLocalStorage();
  } catch {}
})();

// Local Security Handshake Validations
let token = localStorage.getItem('token');
const userRaw = localStorage.getItem('user');

// Silently refresh the Supabase access token using the stored refresh token, so a
// "keep me signed in" session stays alive for its full window without the user
// re-authenticating. Runs on load and every 30 minutes.
async function refreshSessionSilently() {
  const rt = localStorage.getItem('refresh_token');
  if (!rt) return;
  const until = Number(localStorage.getItem('ms_remember_until') || '0');
  if (until && Date.now() > until) return; // window lapsed — bootstrap handles logout
  try {
    const r = await fetch(`${API}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: rt }),
    });
    if (!r.ok) return; // keep the current token; it may still be valid
    const d = await r.json();
    if (d.access_token) { token = d.access_token; localStorage.setItem('token', d.access_token); }
    if (d.refresh_token) localStorage.setItem('refresh_token', d.refresh_token);
  } catch {}
}
if (token && localStorage.getItem('refresh_token')) {
  refreshSessionSilently();
  setInterval(refreshSessionSilently, 30 * 60 * 1000);
}

// True while we're waiting to see if the extension's single-sign-on bridge will
// inject a token. Blocks the dashboard init from running (and failing) in that window.
let __authPending = false;

if (!token) {
  // Don't bounce straight to login. The extension bridge (dashboard-bridge.js)
  // runs at document_idle and mirrors the extension's session into localStorage —
  // redirecting before it lands is exactly what caused the dashboard↔login flash
  // when a user is signed into the extension but not yet the site. Wait briefly for
  // the token to appear; reload cleanly if it does, only then fall back to login.
  __authPending = true;
  (async () => {
    for (let i = 0; i < 20; i++) {          // ~2s grace window
      await new Promise(r => setTimeout(r, 100));
      const t = localStorage.getItem('token');
      if (t) { token = t; location.reload(); return; }
    }
    clearLocalStorage();
    window.location.href = 'login.html';
  })();
}

const user = userRaw ? JSON.parse(userRaw) : {};
let profileContext = null;

// Page permission flags (set after profile loads, read by switchPage to mirror panels into Insights)
let __canSeeLeaderboard = false;
let __canSeeTeamInsights = false;
let __canSeeSalesTeam = false;

// AI Boost — hot/cold segment cache (populated by renderIntel, read by renderCatalog)
let __hotMakeModels = new Set();
let __coldMakeModels = new Set();
// AI Boost — per-vehicle health score cache (id → score)
let __vehicleHealthScores = {};

// Lazy page loaders: registered during init, each runs once the matching page is
// first opened. Keeps login from firing a burst of heavy requests (feeds, catalog,
// leaderboard, inventory-intelligence) all at once, which stalled the free-tier
// backend. Populated in the init flow; drained by switchPage.
const __pageInit = {};
function runPageInit(pageId) {
  const fn = __pageInit[pageId];
  if (fn) { delete __pageInit[pageId]; try { fn(); } catch (e) { console.warn('[lazy-load]', pageId, e); } }
}

// Pre-fetch hot/cold + health caches so tags show on inventory cards. Heavy call,
// so it now runs lazily the first time the Inventory page is opened.
let __invIntelTagsLoaded = false;
function prefetchInvIntelTags() {
  if (!__invIntelActive || __invIntelTagsLoaded) return;
  __invIntelTagsLoaded = true;
  apiGetJson('/ai/inventory-intelligence', { retries: 2 })
    .then(data => {
      if (!data) return;
      __hotMakeModels = new Set((data.hot_segments || []).map(s => `${s.make} ${s.model}`.toLowerCase()));
      __coldMakeModels = new Set((data.cold_segments || []).map(s => `${s.make} ${s.model}`.toLowerCase()));
      __vehicleHealthScores = Object.fromEntries((data.vehicles || []).map(v => [v.id, v.score]));
      if (__hotMakeModels.size > 0 || __coldMakeModels.size > 0) {
        document.getElementById('catalog-segment-pills')?.classList.remove('hidden');
      }
      if (typeof renderCatalog === 'function' && document.getElementById('catalog-list')) renderCatalog();
    })
    .catch(() => { __invIntelTagsLoaded = false; });
}

// Run Engine Boot Lifecycle
document.addEventListener('DOMContentLoaded', () => {
  // Don't boot the dashboard while we're still waiting on the extension SSO bridge
  // (or if there's genuinely no session) — otherwise the init fires auth'd requests
  // with no token and flashes a broken UI before the redirect/reload lands.
  if (__authPending || !localStorage.getItem('token')) return;
  // Show insights immediately — mobile sees content before the auth fetch completes.
  // role-gated items (data-admin-nav etc.) stay hidden until ms-role-ready is set inside init.
  switchPage('insights');
  initializeDashboardEcosystem();
  setupActionListeners();
});


async function initializeDashboardEcosystem() {
  try {
    // Fetch unified server profile context. Render free/starter tier can cold-start
    // (30-60s) — give it real time instead of letting a default browser timeout
    // produce a confusing error that looks identical to an auth failure.
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 45000);
    const res = await fetch(`${API}/auth/me`, {
      headers: { 'Authorization': `Bearer ${token}` },
      signal: controller.signal
    });
    // Keep the abort timer armed until the body is fully read (same reasoning as
    // apiGetJson): a response whose headers arrive but whose body stalls must
    // still time out, otherwise the dashboard hangs on a blank/loading screen.
    if (res.status === 401 || res.status === 402) {
      if (res.status === 402) {
        const body = await res.json().catch(() => ({}))
        clearTimeout(timeoutId);
        throw new Error(body.error === 'TRIAL_EXPIRED' ? 'TRIAL_EXPIRED' : 'SUBSCRIPTION_REQUIRED')
      }
      clearTimeout(timeoutId);
      throw new Error('SESSION_EXPIRED')
    }

    profileContext = await res.json();
    clearTimeout(timeoutId);

    // Render Shared Header Components
    // For dealer admins: lead with the DEALERSHIP NAME (so it visually distinguishes the
    // dealer admin view from rep views). Person's name moves to the subtitle line.
    // For reps / solo: lead with the person's name (their own dashboard, not the team's).
    const personName = profileContext.full_name || user.email;
    const isPersonalDealership = profileContext.dealership?.is_personal === true;
    const dealershipName = isPersonalDealership
      ? 'Independent'
      : (profileContext.dealership?.name || 'Independent');
    const isAdminHeader = ['DEALER_ADMIN', 'OWNER', 'MANAGER'].includes(profileContext.role);

    if (isAdminHeader && !isPersonalDealership) {
      document.getElementById('ui-profile-name').textContent = dealershipName;
      document.getElementById('ui-dealership-name').textContent = `${personName} · Admin`;
    } else {
      document.getElementById('ui-profile-name').textContent = personName;
      document.getElementById('ui-dealership-name').textContent = dealershipName;
    }

    // Pre-fill profile form
    document.getElementById('prof-name').value = profileContext.full_name || '';
    document.getElementById('prof-email').value = profileContext.email || user.email || '';
    { const p = document.getElementById('prof-phone'); if (p) p.value = profileContext.phone || ''; }
    document.getElementById('prof-dealername').value = profileContext.dealership?.name || '';
    document.getElementById('prof-website').value = profileContext.dealership?.website_url || '';
    document.getElementById('prof-display-name').value = profileContext.display_name || '';

    // Avatar preview
    const avatarImg = document.getElementById('prof-avatar-img');
    const avatarInitial = document.getElementById('prof-avatar-initial');
    const avatarRemove = document.getElementById('prof-avatar-remove');
    const setAvatarPreview = (url) => {
      if (url) {
        avatarImg.src = url; avatarImg.classList.remove('hidden');
        avatarInitial.classList.add('hidden'); avatarRemove.classList.remove('hidden');
      } else {
        avatarImg.classList.add('hidden'); avatarInitial.classList.remove('hidden');
        avatarRemove.classList.add('hidden');
        avatarInitial.textContent = (profileContext.full_name || '?').trim().charAt(0).toUpperCase();
      }
    };
    setAvatarPreview(profileContext.avatar_url || null);

    document.getElementById('prof-avatar-file').addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;
      if (file.size > 2 * 1024 * 1024) { alert('Image must be under 2 MB'); e.target.value = ''; return; }
      const reader = new FileReader();
      reader.onload = (ev) => {
        // Compress: resize to max 256px and convert to JPEG at 70% quality
        const img = new Image();
        img.onload = () => {
          const MAX = 256;
          const scale = Math.min(1, MAX / Math.max(img.width, img.height));
          const canvas = document.createElement('canvas');
          canvas.width = Math.round(img.width * scale);
          canvas.height = Math.round(img.height * scale);
          canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
          const dataUrl = canvas.toDataURL('image/jpeg', 0.70);
          setAvatarPreview(dataUrl);
          // Replace file input with compressed blob for upload
          canvas.toBlob(blob => {
            const dt = new DataTransfer();
            dt.items.add(new File([blob], 'avatar.jpg', { type: 'image/jpeg' }));
            document.getElementById('prof-avatar-file').files = dt.files;
          }, 'image/jpeg', 0.70);
        };
        img.src = ev.target.result;
      };
      reader.readAsDataURL(file);
    });
    avatarRemove.addEventListener('click', () => {
      document.getElementById('prof-avatar-file').value = '';
      setAvatarPreview(null);
    });

    // Route Workspace Rendering Logic based on Account Role
    const role = profileContext.role || 'SALES_REP'; // Standard safe fallback role assignment
    const isPersonalForPill = profileContext.dealership?.is_personal === true;
    const rolePillLabel = (role === 'SALES_REP' && isPersonalForPill) ? 'SOLO_REP' : role;
    document.getElementById('ui-role-pill').textContent = rolePillLabel;

    // Hide dealer-only profile fields for sales reps
    if (role !== 'DEALER_ADMIN' && role !== 'OWNER' && role !== 'MANAGER') {
      document.querySelectorAll('[data-dealer-only]').forEach(el => el.classList.add('hidden'));
    }

    // Load transactional data + insights
    const [fleet, totalListings] = await Promise.all([
      fetchMetrics('/inventory'),
      fetchMetrics('/listings')
    ]);

    loadInsights();
    initSecurityPanel();

    // If returning from Stripe checkout, verify payment then load AI config
    const aiSessionId = new URLSearchParams(window.location.search).get('ai_boost_session');
    if (aiSessionId) {
      window.history.replaceState({}, '', window.location.pathname);
      await verifyAIBoostSession(aiSessionId);
    }

    loadAIBoostSection();
    setupAIBoostListeners();
    setupInvIntelListeners();
    setupAiVisionListeners();

    const isAdmin = role === 'DEALER_ADMIN' || role === 'OWNER' || role === 'MANAGER';
    const inDealership = !!profileContext.dealership?.id;
    const isPersonal = profileContext.dealership?.is_personal === true;
    const isSolo = role === 'SALES_REP' && (isPersonal || !inDealership);
    const isDealerRep = role === 'SALES_REP' && inDealership && !isPersonal;
    const canManageFeeds = isAdmin || isSolo;

    // Feeds + Catalog visible to anyone with a dealership (team or personal)
    if (inDealership) {
      document.getElementById('feeds-panel').classList.remove('hidden');
      document.getElementById('catalog-panel').classList.remove('hidden');
      // Defer the actual data loads until the Inventory page is first opened.
      __pageInit.inventory = () => { loadInventoryFeeds(); loadInventoryCatalog(); prefetchInvIntelTags(); };
    }

    if (!canManageFeeds) {
      // Dealer reps see feeds read-only — hide add/sync controls
      document.querySelectorAll('[data-admin-only]').forEach(el => el.classList.add('hidden'));
    }

    // Billing section: lives inside the Profile card now. Dealer reps don't pay (covered by dealer).
    if (isDealerRep) {
      document.getElementById('billing-section')?.classList.add('hidden');
    }

    // Hide admin-only nav items for non-admins
    if (!isAdmin) {
      document.querySelectorAll('[data-admin-nav]').forEach(el => el.classList.add('hidden'));
    }

    // Groups live inside Profile & Settings — reveal that section for anyone who
    // can create or join a group (dealer admins, group admins, owner).
    if (role === 'DEALER_GROUP' || role === 'OWNER' || role === 'DEALER_ADMIN') {
      document.getElementById('groups-settings-section')?.classList.remove('hidden');
    }

    // Today's Briefing (AI daily digest) on the Insights home page — admins only.
    if (isAdmin) loadDailyDigest();

    // Posting-safety (FB ban protection) settings — dealer-level.
    if (['DEALER_ADMIN', 'OWNER', 'MANAGER'].includes(role)) {
      document.getElementById('guardrail-settings-section')?.classList.remove('hidden');
      __pageInit.profile = () => loadGuardrailSettings();
    }
    // Hide team-only nav items (Leaderboard) for solo reps — nothing to rank
    if (isSolo || !inDealership) {
      document.querySelectorAll('[data-team-nav]').forEach(el => el.classList.add('hidden'));
    }

    // All role-based hide rules above have run. Reveal the page now (the head CSS
    // kept role-gated items hidden until this point, so nothing dealer-only ever
    // flashed for a solo rep). This happens synchronously after the hides, so the
    // browser paints the correct nav in one go.
    document.body.classList.add('ms-role-ready');
    document.getElementById('insights-skeleton')?.classList.add('hidden');

    // Team leaderboard is for actual teams (admin + reps in a real dealership).
    // Solo reps / no-team users have nothing to rank against on a team, so we hide
    // the team panel entirely — they only get the Global Leaderboard below.
    if (inDealership && !isPersonal) {
      __pageInit.leaderboard = () => loadLeaderboard();
    } else {
      document.getElementById('leaderboard-panel')?.classList.add('hidden');
    }

    // Set permission flags used by switchPage to mirror panels into Insights
    __canSeeLeaderboard = inDealership && !isPersonal;
    __canSeeTeamInsights = isAdmin;
    __canSeeSalesTeam = isAdmin;

    // Wire up the sidebar nav
    document.querySelectorAll('#dashboard-nav .nav-item').forEach(btn => {
      btn.addEventListener('click', () => switchPage(btn.dataset.page));
    });
    setupMobileMoreMenu();
    switchPage('insights');

    // Global leaderboard — available to EVERYONE (solo reps included). Loaded lazily on first carousel switch.
    initGlobalLeaderboard();

    if (isAdmin) {
      document.getElementById('leaderboard-panel')?.classList.remove('hidden');
      document.getElementById('dealer-view-panel')?.classList.remove('hidden');
      // Team players + trend charts now live on the Insights page (admin only)
      document.getElementById('insights-team-section')?.classList.remove('hidden');
      loadCharts();
      loadDealerManagementMatrix();
    } else {
      document.getElementById('rep-view-panel').classList.remove('hidden');
      loadMyStats();
    }

} catch (err) {
    if (err.message === 'TRIAL_EXPIRED') {
      alert('Your 30-day free trial has ended. Add a payment method to keep using MarketSync.');
      window.location.href = '/upgrade.html?reason=trial_ended';
      return;
    }
    if (err.message === 'SUBSCRIPTION_REQUIRED') {
      alert('Subscription required to access system. Redirecting to billing...');
      launchStripeLifecycle();
      return;
    }
    if (err.message === 'SESSION_EXPIRED') {
      // Genuine 401 from the server — token really is invalid/expired. Safe to log out.
      clearLocalStorage();
      window.location.href = 'login.html';
      return;
    }
    // Anything else (network blip, cold-start timeout, a render-time JS error, etc.)
    // is NOT proof the session is invalid. Logging out here is what causes the
    // dashboard <-> login flicker loop. Show an inline error and let the user retry
    // instead of nuking their session.
   console.error('Dashboard init failed (non-auth error):', err);
    const banner = document.createElement('div');
    banner.className = 'fixed top-0 left-0 right-0 z-50 bg-red-600 text-white text-sm text-center py-2';
    banner.innerHTML = `Something went wrong loading the dashboard. <button onclick="window.location.reload()" class="underline font-bold ml-2">Retry</button>`;
    document.body.prepend(banner);
    document.body.classList.add('ms-role-ready'); // reveal page instead of leaving it stuck hidden
  }
}

// Sidebar nav page switcher. Each page shows only its own content — no panel
// mirroring, so Insights stays clean and each nav item lands on a focused view.
function switchPage(pageId) {
  ensurePanelsInOriginalLocations();

  // Pipeline is retired and Leads moved into the CRM — redirect any old deep link
  // (nav, notification link_page) to the right CRM tab.
  if (pageId === 'leads') { __crmTab = 'leads'; pageId = 'crm'; }
  else if (pageId === 'pipeline') { __crmTab = 'contacts'; pageId = 'crm'; }

  document.querySelectorAll('[data-page-content]').forEach(el => {
    el.classList.toggle('hidden', el.dataset.pageContent !== pageId);
  });
  document.querySelectorAll('#dashboard-nav .nav-item, #nav-vin-sticker, #nav-inv-intel, #nav-ai-vision').forEach(btn => {
    const active = btn.id === 'nav-inv-intel' ? pageId === 'inv-intel'
                 : btn.id === 'nav-vin-sticker'? pageId === 'vin-sticker'
                 : btn.id === 'nav-ai-vision' ? pageId === 'ai-vision'
                 : btn.dataset.page === pageId;
    btn.classList.toggle('bg-indigo-100', active);
    btn.classList.toggle('dark:bg-indigo-950/50', active);
    btn.classList.toggle('text-indigo-700', active);
    btn.classList.toggle('dark:text-indigo-300', active);
    btn.classList.toggle('text-slate-700', !active);
    btn.classList.toggle('dark:text-slate-300', !active);
  });

  // Fire any one-time lazy loaders registered for this page (feeds, catalog,
  // leaderboard, guardrail settings, inventory-intelligence tags).
  runPageInit(pageId);

  if (pageId === 'vin-sticker') loadVinStickerPage();
  if (pageId === 'profile') { loadProfileBranding(); loadCrmAdfSetting(); }
  if (pageId === 'inv-intel' && typeof window._invIntelPageHook === 'function') window._invIntelPageHook();
  if (pageId === 'ai-vision') loadAiVisionPage();
  if (pageId === 'crm') loadCrmPage();
  if (pageId === 'website') loadWebsitePage();
  if (pageId === 'automation') loadAutomationPage();
  if (pageId === 'equity') loadEquityPage();
  if (pageId === 'appraisal') { initAppraisal(); loadApprList(); apprEnsureBranding(); }
}

// ── Trade Appraisal ──────────────────────────────────────────────────────────
let __apprWired = false;
let __apprData = null;   // last appraisal result, for the PDF export
let __apprDealId = null; // id of the saved trade_appraisals record (for updates)
let __apprDecodedSpecs = null; // engine/trans/drivetrain/body/fuel from the last VIN decode
let __apprSalesperson = null;  // salesperson name for the CURRENT deal (record's creator, or logged-in)
let __apprBranding = null;     // { logo_url, primary_color, ... } for PDF branding
let __apprDealerInfo = null;   // { city, province, postal_code, country } for PDF header
function initAppraisal() {
  if (__apprWired) return;      // switchPage calls this each visit; wire once
  const $ = (id) => document.getElementById(id);
  const decodeBtn = $('appr-decode'), runBtn = $('appr-run'), result = $('appr-result');
  if (!decodeBtn || !runBtn) return;
  __apprWired = true;

  // Standalone VIN decoder — pops the same full specs & recall modal as Inventory.
  const lookupBtn = $('appr-vin-lookup-btn'), lookupInput = $('appr-vin-lookup');
  const runVinLookup = () => {
    const vin = (lookupInput?.value || '').trim().toUpperCase();
    if (vin.length !== 17) { showToast('Enter a 17-character VIN', 'error'); return; }
    openVinDecode(null, vin);
  };
  lookupBtn?.addEventListener('click', runVinLookup);
  lookupInput?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); runVinLookup(); } });

  // OEM factory docs (no AI) — decode for the build, then pull the factory PDF.
  const oemMsg = (t, err) => { const el = $('appr-oem-msg'); if (el) { el.textContent = t; el.className = 'text-xs ' + (err ? 'text-rose-500' : 'text-slate-400'); } };
  async function apprFetchOem(kind) {
    const vin = ((lookupInput?.value || $('appr-vin')?.value) || '').trim().toUpperCase();
    if (vin.length !== 17) { oemMsg('Enter a 17-character VIN first', true); return; }
    const btn = kind === 'sticker' ? $('appr-oem-sticker') : $('appr-oem-brochure');
    const orig = btn.textContent; btn.disabled = true; btn.textContent = 'Fetching…';
    oemMsg('Looking up the factory ' + (kind === 'sticker' ? 'window sticker' : 'brochure') + '…');
    try {
      let make = ($('appr-make')?.value || '').trim(), model = ($('appr-model')?.value || '').trim(), year = ($('appr-year')?.value || '').trim();
      if (!make || (kind === 'brochure' && (!model || !year))) {
        const dr = await fetch(`${API}/ai/vin-decode`, { method: 'POST', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ vin }) });
        const dd = await dr.json().catch(() => ({}));
        if (dr.ok) { make = make || dd.make || ''; model = model || dd.model || ''; year = year || dd.year || ''; }
      }
      const path = kind === 'sticker' ? '/vin/oem-window-sticker' : '/vin/oem-brochure';
      const r = await fetch(`${API}${path}`, { method: 'POST', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ vin, make, model, year }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { oemMsg(d.message || d.error || 'Not available', true); return; }
      oemMsg('Opened in a new tab.');
      window.open(d.url, '_blank');
    } catch { oemMsg('Lookup failed — try again', true); }
    finally { btn.disabled = false; btn.textContent = orig; }
  }
  $('appr-oem-sticker')?.addEventListener('click', () => apprFetchOem('sticker'));
  $('appr-oem-brochure')?.addEventListener('click', () => apprFetchOem('brochure'));

  decodeBtn.addEventListener('click', async () => {
    const vin = ($('appr-vin').value || '').trim().toUpperCase();
    if (vin.length !== 17) { showToast('Enter a 17-character VIN', 'error'); return; }
    const orig = decodeBtn.textContent;
    decodeBtn.disabled = true; decodeBtn.textContent = 'Decoding…';
    try {
      const r = await fetch(`${API}/ai/vin-decode`, {
        method: 'POST', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ vin })
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Decode failed');
      if (d.year) $('appr-year').value = d.year;
      $('appr-make').value = d.make || '';
      $('appr-model').value = d.model || '';
      $('appr-trim').value = d.trim || '';
      // Stash the specs so the saved deal + disclosure PDF auto-fill.
      __apprDecodedSpecs = { body_type: d.body_type || null, engine: d.engine || null, transmission: d.transmission || null, drivetrain: d.drivetrain || null, fuel_type: d.fuel_type || null };
      // Prefill the comp filters so the appraisal matches like-for-like (same
      // drivetrain + engine), not every trim/engine of the model.
      if (d.engine && $('appr-engine')) $('appr-engine').value = d.engine;
      const dtSel = $('appr-drivetrain');
      if (dtSel && d.drivetrain) {
        const dt = d.drivetrain.toUpperCase();
        const canon = /AWD|ALL.?WHEEL|4MATIC|QUATTRO|XDRIVE/.test(dt) ? 'AWD'
          : /4WD|4X4|FOUR.?WHEEL/.test(dt) ? '4WD'
          : /FWD|FRONT|4X2|2WD/.test(dt) ? 'FWD'
          : /RWD|REAR/.test(dt) ? 'RWD' : '';
        if (canon) dtSel.value = canon;
      }
      const summary = [d.year, d.make, d.model, d.trim].filter(Boolean).join(' ');
      const sumEl = $('appr-vin-decoded-text'), wrap = $('appr-vin-decoded');
      if (sumEl && wrap) { sumEl.textContent = summary || 'vehicle identified'; wrap.classList.remove('hidden'); }
      showToast('VIN decoded — add mileage, then Appraise', 'success');
    } catch (e) { showToast(e.message, 'error'); }
    finally { decodeBtn.disabled = false; decodeBtn.textContent = orig; }
  });

  runBtn.addEventListener('click', async () => {
    const num = (id) => ($(id).value || '').replace(/[^0-9.]/g, '');
    const body = {
      vin: ($('appr-vin').value || '').trim().toUpperCase() || null,
      year: ($('appr-year').value || '').trim(),
      make: ($('appr-make').value || '').trim(),
      model: ($('appr-model').value || '').trim(),
      trim: ($('appr-trim').value || '').trim(),
      mileage: num('appr-mileage'),
      condition: $('appr-condition').value,
      recon: num('appr-recon'),
      target_gross: num('appr-gross'),
      accident: $('appr-accident')?.value || 'none',
      damage: num('appr-damage'),
      // Like-for-like comp filters. Fall back to the decoded specs when the field
      // is blank (e.g. rep decoded a VIN but didn't touch the drivetrain select).
      drivetrain: ($('appr-drivetrain')?.value || '').trim() || (__apprDecodedSpecs?.drivetrain || ''),
      engine: ($('appr-engine')?.value || '').trim() || (__apprDecodedSpecs?.engine || ''),
      radius: $('appr-radius')?.value ?? '',
      appraisal_id: __apprDealId || undefined,   // update the same trade log on re-appraise
    };
    if (!body.year || !body.make || !body.model) { showToast('Year, make and model are required', 'error'); return; }
    const orig = runBtn.textContent;
    runBtn.disabled = true; runBtn.textContent = 'Appraising…';
    result.innerHTML = `<div class="py-10 text-center text-sm text-slate-400 italic">Pulling live market comps…</div>`;
    try {
      const r = await fetch(`${API}/ai/appraise`, {
        method: 'POST', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Appraisal failed');
      result.innerHTML = renderAppraisal(d);
      if (typeof loadApprList === 'function') loadApprList();  // refresh Recent Trades
    } catch (e) {
      result.innerHTML = `<div class="py-8 text-center text-sm text-slate-500">Couldn't appraise: ${esc(e.message)}</div>`;
    } finally { runBtn.disabled = false; runBtn.textContent = orig; }
  });

  initApprDeal();
}

function apprTile(label, value, sub) {
  return `<div class="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4">
    <div class="text-[10px] font-bold uppercase tracking-wider text-slate-400">${esc(label)}</div>
    <div class="text-lg font-black text-slate-900 dark:text-white mt-1 leading-tight">${value}</div>
    <div class="text-[11px] text-slate-400 mt-0.5">${esc(sub)}</div>
  </div>`;
}

// Wipe the appraisal + deal-details forms and all state so every trade starts
// fresh. Resetting __apprDealId is what makes the next Appraise create a NEW
// trade record instead of overwriting the last one.
function resetAppraisal() {
  const set = (id, v = '') => { const el = document.getElementById(id); if (el) el.value = v; };
  ['appr-vin', 'appr-year', 'appr-make', 'appr-model', 'appr-trim', 'appr-mileage', 'appr-engine', 'appr-damage',
   'cust-first', 'cust-last', 'cust-home-phone', 'cust-mobile-phone', 'cust-email', 'cust-postal', 'cust-address', 'disc-notes'
  ].forEach(id => set(id));
  set('appr-condition', 'good'); set('appr-drivetrain', ''); set('appr-radius', '250'); set('appr-accident', 'none');
  set('appr-recon', '1200'); set('appr-gross', '2500');
  document.getElementById('appr-vin-decoded')?.classList.add('hidden');
  set('appr-vin-decoded-text');
  const res = document.getElementById('appr-result'); if (res) res.innerHTML = '';
  const dmsg = document.getElementById('appr-deal-msg'); if (dmsg) dmsg.textContent = '';
  document.querySelectorAll('input[name="appr-disposition"]').forEach(r => { r.checked = r.value === 'retail'; });
  document.querySelectorAll('#appr-disclosure-qa select').forEach(s => { s.selectedIndex = 0; });
  document.querySelectorAll('#appr-features input[type=checkbox]').forEach(c => { c.checked = false; });
  // Wipe state → next appraisal is a brand-new record, attributed to the logged-in rep.
  __apprData = null; __apprDealId = null; __apprDecodedSpecs = null; __apprSalesperson = null;
  document.getElementById('appr-vin')?.focus();
  if (typeof showToast === 'function') showToast('Cleared — ready for a new appraisal', 'info');
}

// vAuto-style live comparable listings — click any row to open the actual listing
// (dealer site / AutoTrader / CarGurus, wherever it's listed) and compare.
function apprCompsTable(comps, du, money, numFound) {
  const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
  const srcLabel = (c) => {
    const h = (host(c.url) || (c.source || '')).toLowerCase();
    if (h.includes('autotrader')) return 'AutoTrader';
    if (h.includes('cargurus')) return 'CarGurus';
    if (h.includes('cars.com')) return 'Cars.com';
    if (h.includes('kijiji')) return 'Kijiji';
    return host(c.url) || (c.source || 'Listing');
  };
  const rows = (comps || []).filter(c => c.price > 0).sort((a, b) => a.price - b.price).slice(0, 75);
  if (!rows.length) return '';
  const withLinks = rows.filter(c => c.url).length;
  return `
    <div class="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4">
      <div class="flex items-center justify-between mb-2">
        <div class="text-xs uppercase font-bold tracking-wider text-slate-500 dark:text-slate-400">Comparable listings${numFound && numFound > rows.length ? ` · ${Number(numFound).toLocaleString()} in market` : ''}</div>
        <div class="text-[11px] text-slate-400">${withLinks} of ${rows.length} link to the live ad</div>
      </div>
      <div class="overflow-x-auto -mx-1">
        <table class="w-full text-sm border-collapse min-w-[520px]">
          <thead><tr class="text-[10px] uppercase tracking-wider text-slate-400 border-b border-slate-200 dark:border-slate-800">
            <th class="text-left py-2 px-2">Price</th>
            <th class="text-right py-2 px-2">${du === 'mi' ? 'Miles' : 'KM'}</th>
            <th class="text-left py-2 px-2">Dealer / location</th>
            <th class="text-left py-2 px-2">Source</th>
            <th class="text-right py-2 px-2"></th>
          </tr></thead>
          <tbody>
            ${rows.map(c => {
              const loc = [c.dealer, [c.city, c.region].filter(Boolean).join(', ')].filter(Boolean).join(' · ');
              const clickable = !!c.url;
              return `<tr class="border-b border-slate-100 dark:border-slate-800/60 ${clickable ? 'cursor-pointer hover:bg-indigo-50 dark:hover:bg-indigo-950/30' : ''}" ${clickable ? `onclick="window.open('${encodeURI(c.url)}','_blank','noopener')"` : ''}>
                <td class="py-2 px-2 font-bold text-slate-900 dark:text-white tabular-nums">${money(c.price)}</td>
                <td class="py-2 px-2 text-right tabular-nums text-slate-600 dark:text-slate-300">${c.miles ? Number(c.miles).toLocaleString() : '—'}</td>
                <td class="py-2 px-2 text-slate-600 dark:text-slate-300 truncate max-w-[220px]">${esc(loc || '—')}</td>
                <td class="py-2 px-2 text-slate-500 dark:text-slate-400">${esc(srcLabel(c))}</td>
                <td class="py-2 px-2 text-right">${clickable ? '<span class="text-indigo-500 font-bold text-xs whitespace-nowrap">View ↗</span>' : ''}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
      ${withLinks === 0 ? '<div class="text-[11px] text-slate-400 mt-2">Direct links aren\'t available for this vehicle\'s comps yet — they populate as fresh market data comes in.</div>' : ''}
    </div>`;
}

// Robust sold-date formatter. MarketCheck dates can arrive as Unix epoch SECONDS,
// which new Date() misreads as ms → "Jan 1970". Coerce seconds→ms and reject any
// pre-2000 / invalid value so we show a clean "—" instead of a bogus 1970.
function fmtSoldDate(s) {
  if (s == null || s === '') return '—';
  let d;
  if (typeof s === 'number' || /^\d+$/.test(String(s))) {
    let n = Number(s); if (n < 1e12) n *= 1000;
    d = new Date(n);
  } else { d = new Date(s); }
  return (isNaN(d.getTime()) || d.getFullYear() < 2000) ? '—' : d.toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
}

// Recently-SOLD comps table — like apprCompsTable but with a days-on-market column
// and a sold date. These are proven transactions, the strongest evidence on the sheet.
function apprSoldTable(sold, du, money) {
  const rows = (sold || []).filter(c => c.price > 0).sort((a, b) => a.price - b.price).slice(0, 40);
  if (!rows.length) return '';
  return `
    <div class="mt-3 overflow-x-auto -mx-1">
      <table class="w-full text-sm border-collapse min-w-[520px]">
        <thead><tr class="text-[10px] uppercase tracking-wider text-slate-400 border-b border-slate-200 dark:border-slate-800">
          <th class="text-left py-2 px-2">Sold price</th>
          <th class="text-right py-2 px-2">${du === 'mi' ? 'Miles' : 'KM'}</th>
          <th class="text-right py-2 px-2">Days on mkt</th>
          <th class="text-left py-2 px-2">Location</th>
          <th class="text-right py-2 px-2">Sold</th>
        </tr></thead>
        <tbody>
          ${rows.map(c => {
            const loc = [c.dealer, [c.city, c.region].filter(Boolean).join(', ')].filter(Boolean).join(' · ');
            const clickable = !!c.url;
            return `<tr class="border-b border-slate-100 dark:border-slate-800/60 ${clickable ? 'cursor-pointer hover:bg-emerald-50 dark:hover:bg-emerald-950/20' : ''}" ${clickable ? `onclick="window.open('${encodeURI(c.url)}','_blank','noopener')"` : ''}>
              <td class="py-2 px-2 font-bold text-slate-900 dark:text-white tabular-nums">${money(c.price)}</td>
              <td class="py-2 px-2 text-right tabular-nums text-slate-600 dark:text-slate-300">${c.miles ? Number(c.miles).toLocaleString() : '—'}</td>
              <td class="py-2 px-2 text-right tabular-nums text-slate-600 dark:text-slate-300">${c.dom != null ? c.dom : '—'}</td>
              <td class="py-2 px-2 text-slate-600 dark:text-slate-300 truncate max-w-[200px]">${esc(loc || '—')}</td>
              <td class="py-2 px-2 text-right text-slate-500 dark:text-slate-400 whitespace-nowrap">${esc(fmtSoldDate(c.sold_date))}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>`;
}

function renderAppraisal(d) {
  __apprData = d;
  __apprDealId = d.appraisal_id || null;  // the auto-logged trade record (for Deal Details save + updates)
  __apprSalesperson = null; // new appraisal → attributed to the logged-in user
  const v = d.vehicle || {};
  const label = [v.year, v.make, v.model, v.trim].filter(Boolean).join(' ') || 'Vehicle';
  const cur = d.currency || 'CAD';
  const du = d.distance_unit || 'km';
  const money = (n) => n != null ? '$' + Number(n).toLocaleString() : '—';

  if (!d.retail || !d.appraisal) {
    return `<div class="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5">
      <div class="font-bold text-slate-900 dark:text-white">${esc(label)}</div>
      <div class="text-sm text-amber-600 dark:text-amber-400 mt-2">${esc(d.message || 'No market data found for this vehicle.')}</div>
    </div>`;
  }
  const rt = d.retail, ap = d.appraisal;
  // Only surface the retail→trade step when there's an actual discount (ratio < 100%).
  const hasTradeSpread = ap.trade_value != null && ap.retail_mid != null && ap.trade_value < ap.retail_mid - 1;
  return `
    <div class="space-y-4">
      <div class="bg-indigo-600 text-white rounded-xl p-5">
        <div class="flex items-start justify-between gap-3">
          <div>
            <div class="text-xs font-bold uppercase tracking-wider text-indigo-200">Suggested trade / cash offer</div>
            <div class="flex items-center gap-2 mt-1 flex-wrap">
              <div class="text-3xl font-black">${money(ap.suggested_offer)} <span class="text-base font-semibold text-indigo-200">${cur}</span></div>
              ${hasTradeSpread ? `<span class="text-[11px] font-bold bg-white/15 rounded-full px-2 py-0.5">Wholesale ${money(ap.trade_value)}</span>` : ''}
            </div>
          </div>
          <button onclick="generateAppraisalPdf()" class="flex-shrink-0 flex items-center gap-1.5 bg-white/15 hover:bg-white/25 text-white text-xs font-bold px-3 py-2 rounded-lg transition">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/></svg>
            PDF
          </button>
        </div>
        <div class="text-xs text-indigo-100 mt-2">${hasTradeSpread ? 'Wholesale ' + money(ap.trade_value) : 'Retail ' + money(ap.retail_mid)} − recon ${money(ap.recon)} − gross ${money(ap.target_gross)} = ACV / wholesale take-in</div>
      </div>
      ${ap.adjustments ? (() => {
        const adj = ap.adjustments;
        const signed = (n) => (n > 0 ? '+' : n < 0 ? '−' : '') + money(Math.abs(n));
        const rows = [];
        rows.push(['Comparable asking median', money(adj.comp_median), rt.count != null ? `${rt.count} comps` : '']);
        if (adj.mileage_adjustment) {
          const more = (adj.subject_mileage != null && adj.market_mileage != null) ? (adj.subject_mileage > adj.market_mileage) : (adj.mileage_adjustment < 0);
          const detail = (adj.subject_mileage != null && adj.market_mileage != null)
            ? `${Number(adj.subject_mileage).toLocaleString()} vs ${Math.round(adj.market_mileage).toLocaleString()} ${du} market`
            : '';
          rows.push([`Mileage adjustment (${more ? 'above' : 'below'} market)`, signed(adj.mileage_adjustment), detail, adj.mileage_adjustment < 0]);
        }
        if (adj.market_realism_amount) {
          rows.push([`Ask → sold (${adj.market_realism_pct}%)`, signed(adj.market_realism_amount), adj.market_realism_proven ? 'from real sold comps' : 'est. transaction gap', true]);
        }
        return `<div class="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4">
          <div class="text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-2">How we got to retail value</div>
          <div class="space-y-1.5">
            ${rows.map(([lbl, val, sub, neg]) => `<div class="flex items-center justify-between gap-3 text-sm">
              <div class="min-w-0"><span class="text-slate-700 dark:text-slate-200">${esc(lbl)}</span>${sub ? `<span class="text-[11px] text-slate-400 ml-1.5">${esc(sub)}</span>` : ''}</div>
              <div class="font-bold tabular-nums flex-shrink-0 ${neg ? 'text-rose-500' : 'text-slate-900 dark:text-white'}">${val}</div>
            </div>`).join('')}
            <div class="flex items-center justify-between gap-3 text-sm border-t border-slate-200 dark:border-slate-700 pt-1.5 mt-1.5">
              <div class="font-bold text-slate-900 dark:text-white">Adjusted retail value${adj.accident_amount ? ' (clean history)' : ''}</div>
              <div class="font-black tabular-nums text-slate-900 dark:text-white">${money(adj.retail_clean != null ? adj.retail_clean : adj.retail_value)}</div>
            </div>
            ${adj.accident_amount ? `<div class="flex items-center justify-between gap-3 text-sm">
              <div class="min-w-0"><span class="text-slate-700 dark:text-slate-200">Accident / history${adj.accident_tier ? ` (${esc(adj.accident_tier)})` : ''}${adj.accident_pct != null ? ` −${adj.accident_pct}%` : ''}</span><span class="text-[11px] text-slate-400 ml-1.5">history deduction</span></div>
              <div class="font-bold tabular-nums flex-shrink-0 text-rose-500">−${money(Math.abs(adj.accident_amount))}</div>
            </div>
            <div class="flex items-center justify-between gap-3 text-sm">
              <div class="font-bold text-slate-900 dark:text-white">Retail (this vehicle)</div>
              <div class="font-black tabular-nums text-slate-900 dark:text-white">${money(adj.retail_value)}</div>
            </div>` : ''}
            ${hasTradeSpread ? `<div class="flex items-center justify-between gap-3 text-sm">
              <div class="min-w-0"><span class="text-slate-700 dark:text-slate-200">Retail → wholesale${adj.trade_ratio_pct != null ? ` (${adj.trade_ratio_pct}% of retail)` : ''}</span><span class="text-[11px] text-slate-400 ml-1.5">wholesale spread</span></div>
              <div class="font-bold tabular-nums flex-shrink-0 text-rose-500">−${money(adj.retail_value - adj.trade_value)}</div>
            </div>
            <div class="flex items-center justify-between gap-3 text-sm border-t border-slate-200 dark:border-slate-700 pt-1.5 mt-1.5">
              <div class="font-bold text-slate-900 dark:text-white">Wholesale value (ACV) <span class="text-[11px] font-medium text-slate-400">(compare to AutoTrader)</span></div>
              <div class="font-black tabular-nums text-indigo-600 dark:text-indigo-400">${money(adj.trade_value)}</div>
            </div>` : ''}
            ${adj.recon ? `<div class="flex items-center justify-between gap-3 text-sm"><div class="text-slate-700 dark:text-slate-200">Reconditioning</div><div class="font-bold tabular-nums text-rose-500">−${money(Math.abs(adj.recon))}</div></div>` : ''}
            ${adj.target_gross ? `<div class="flex items-center justify-between gap-3 text-sm"><div class="text-slate-700 dark:text-slate-200">Target gross</div><div class="font-bold tabular-nums text-rose-500">−${money(Math.abs(adj.target_gross))}</div></div>` : ''}
            <div class="flex items-center justify-between gap-3 text-sm border-t border-slate-200 dark:border-slate-700 pt-1.5 mt-1.5">
              <div class="font-bold text-slate-900 dark:text-white">Suggested offer</div>
              <div class="font-black tabular-nums text-emerald-600 dark:text-emerald-400">${money(ap.suggested_offer)}</div>
            </div>
          </div>
          <div class="text-[11px] text-slate-400 mt-2">Adjusts the market's asking prices for this vehicle's odometer and the ask→sell gap to get retail value. Your ACV / wholesale take-in comes off retail (− recon − gross) and lines up with trade-value tools like AutoTrader.</div>
        </div>`;
      })() : ''}
      ${(() => {
        // Retail cross-check: show every independent read (asking comps, real sold
        // prices, MarketCheck's VIN model) as INPUTS that were reconciled into one
        // retail — instead of two contradicting headline numbers. Only render when we
        // actually have a second signal beyond the comps.
        const sig = ap.retail_signals || {};
        const cards = [];
        cards.push({ lbl: 'Asking comps', val: sig.comps, sub: `${rt.count ?? '—'} live listings` });
        if (sig.sold != null) cards.push({ lbl: 'Recently sold', val: sig.sold, sub: `${(d.sold && d.sold.count) || '—'} sold`, hot: true });
        if (sig.model != null) cards.push({ lbl: 'VIN model', val: sig.model, sub: (d.prediction && d.prediction.low && d.prediction.high) ? `${money(d.prediction.low)}–${money(d.prediction.high)}` : 'MarketCheck' });
        if (cards.length < 2) return '';
        return `<div class="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4">
          <div class="text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-2">Retail cross-check — reconciled from ${cards.length} independent reads</div>
          <div class="grid grid-cols-2 sm:grid-cols-${Math.min(4, cards.length + 1)} gap-2">
            ${cards.map(c => `<div class="rounded-lg border ${c.hot ? 'border-emerald-200 dark:border-emerald-900 bg-emerald-50/50 dark:bg-emerald-950/20' : 'border-slate-200 dark:border-slate-700'} p-2.5">
              <div class="text-[10px] font-bold uppercase tracking-wider ${c.hot ? 'text-emerald-600 dark:text-emerald-400' : 'text-slate-400'}">${esc(c.lbl)}</div>
              <div class="text-lg font-black text-slate-900 dark:text-white tabular-nums">${money(c.val)}</div>
              <div class="text-[10px] text-slate-400">${esc(c.sub)}</div>
            </div>`).join('')}
            <div class="rounded-lg border-2 border-indigo-300 dark:border-indigo-800 bg-indigo-50 dark:bg-indigo-950/30 p-2.5">
              <div class="text-[10px] font-bold uppercase tracking-wider text-indigo-600 dark:text-indigo-400">Retail used</div>
              <div class="text-lg font-black text-indigo-700 dark:text-indigo-300 tabular-nums">${money(sig.reconciled != null ? sig.reconciled : rt.median)}</div>
              <div class="text-[10px] text-slate-400">weighted blend</div>
            </div>
          </div>
          <div class="text-[11px] text-slate-400 mt-2">We weight real sold prices highest, then the VIN model, then live asks (asking prices run above what cars sell for). One grounded retail — no guessing between numbers.</div>
        </div>`;
      })()}
      ${d.sold ? (() => {
        const s = d.sold;
        const PROV = { ON:'Ontario', QC:'Quebec', BC:'B.C.', AB:'Alberta', MB:'Manitoba', SK:'Saskatchewan', NS:'Nova Scotia', NB:'New Brunswick', NL:'Newfoundland', PE:'P.E.I.' };
        const scope = (s.matched_on && s.matched_on.geo)
          ? (s.radius_used ? `within ${s.radius_used} ${du}` : (s.geo_scope && s.geo_scope !== 'radius' ? (PROV[s.geo_scope] || s.geo_scope) : 'local'))
          : 'nationwide';
        return `<div class="bg-white dark:bg-slate-900 border border-emerald-200 dark:border-emerald-900 rounded-xl p-4">
          <div class="flex items-center gap-1.5 mb-2">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="#059669" stroke-width="2" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg>
            <span class="text-xs font-bold text-emerald-700 dark:text-emerald-300 uppercase tracking-wider">Proven to market — recently sold</span>
            <span class="text-[10px] font-medium text-slate-400">${s.count} sold · ${esc(scope)}</span>
          </div>
          <div class="grid grid-cols-2 sm:grid-cols-4 gap-3">
            ${apprTile('Sold median', money(s.median_price), s.low && s.high ? `${money(s.low)}–${money(s.high)}` : 'actual sale prices')}
            ${apprTile('Days on market', s.median_dom != null ? s.median_dom + ' days' : '—', 'before it sold')}
            ${apprTile('Ask vs sold', s.ask_vs_sold_pct != null ? '−' + s.ask_vs_sold_pct + '%' : '—', 'asks run high')}
            ${apprTile('Your offer vs sold', s.offer_vs_sold_pct != null ? s.offer_vs_sold_pct + '%' : '—', 'of sold price')}
          </div>
          <div class="text-[11px] text-slate-400 mt-2">These are comparable cars that actually left the market — the closest public proof of what this vehicle sells for, and how fast.</div>
          ${(s.listings && s.listings.length) ? apprSoldTable(s.listings, du, money) : ''}
        </div>`;
      })() : ''}
      ${ap.ai_summary ? `<div class="bg-violet-50 dark:bg-violet-950/30 border border-violet-200 dark:border-violet-900 rounded-xl p-4">
        <div class="flex items-center gap-1.5 mb-1">
          <svg viewBox="0 0 24 24" width="14" height="14" class="flex-shrink-0" aria-hidden="true"><path d="M12 2.5l2.4 6.6 6.6 2.4-6.6 2.4L12 20.5l-2.4-6.6L3 11.5l6.6-2.4z" fill="#c4b5fd" fill-opacity="0.5" stroke="#6d28d9" stroke-width="1.4" stroke-linejoin="round"/></svg>
          <span class="text-xs font-bold text-violet-700 dark:text-violet-300 uppercase tracking-wider">AI Market Insight</span>
        </div>
        <p class="text-sm text-slate-700 dark:text-slate-300 leading-relaxed">${esc(ap.ai_summary)}</p>
      </div>` : ''}
      <div class="grid grid-cols-2 sm:grid-cols-4 gap-3">
        ${apprTile('We sell for', money(rt.median), `retail · ${rt.count ?? '—'} comps`)}
        ${hasTradeSpread ? apprTile('Wholesale (ACV)', money(ap.trade_value), `${ap.trade_ratio}% of retail`) : apprTile('Retail range', `${money(rt.low)}–${money(rt.high)}`, 'fair retail')}
        ${apprTile('Avg days to sell', rt.avg_days_online != null ? rt.avg_days_online + ' days' : '—', 'on market')}
        ${apprTile('Target gross', money(ap.target_gross), ap.gross_pct != null ? ap.gross_pct + '% of retail' : 'your margin')}
      </div>
      ${(() => {
        const m = rt.matched_on || {};
        const chips = [];
        chips.push('Year ' + (v.year || '—'));
        if (m.trim && v.trim) chips.push('Trim ' + v.trim);
        if (m.drivetrain && v.drivetrain) chips.push(String(v.drivetrain).toUpperCase());
        if (m.engine && v.engine) chips.push(String(v.engine));
        const PROV = { ON:'Ontario', QC:'Quebec', BC:'B.C.', AB:'Alberta', MB:'Manitoba', SK:'Saskatchewan', NS:'Nova Scotia', NB:'New Brunswick', NL:'Newfoundland', PE:'P.E.I.' };
        if (m.geo && rt.radius_used) chips.push('Within ' + rt.radius_used + ' ' + du + (rt.median_distance != null ? ` · ~${Math.round(rt.median_distance)} ${du} avg` : ''));
        else if (m.geo && rt.geo_scope && rt.geo_scope !== 'radius') chips.push((PROV[rt.geo_scope] || rt.geo_scope) + ' only');
        else if (m.geo) chips.push('Local');
        else chips.push('Nationwide');
        return `<div class="flex flex-wrap items-center gap-1.5">
          <span class="text-[11px] font-semibold text-slate-400">Comps matched on:</span>
          ${chips.map(c => `<span class="text-[11px] font-medium bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 rounded-full px-2 py-0.5">${esc(c)}</span>`).join('')}
        </div>`;
      })()}
      ${apprMarketplaceLinks(d, v)}
      ${apprCompsTable(d.comps, du, money, rt.num_found)}
      <div class="text-xs text-slate-400">${esc(label)}${v.mileage ? ` · ${Number(v.mileage).toLocaleString()} ${du}` : ''} · Source: ${esc(rt.source || 'MarketCheck')}. Retail-market based — not auction/wholesale values.</div>
    </div>`;
}

// vAuto-style "check the other marketplaces" jump-offs — dealers price the same car
// differently across sites, so give reps one click to the exact vehicle on AutoTrader
// and CarGurus near them. Uses each site's native search where reliable.
function apprMarketplaceLinks(d, v) {
  const slug = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
  const make = slug(v.make), model = slug(v.model);
  if (!make || !model) return '';
  const isUS = (d.distance_unit === 'mi');
  const postal = (d.dealer_postal || '').replace(/\s+/g, '');
  const yr = v.year || '';
  // AutoTrader native path search (CA + US both use /cars/{make}/{model}); scope to
  // year + the dealer's location when we have it.
  const atBase = isUS ? 'https://www.autotrader.com' : 'https://www.autotrader.ca';
  const at = isUS
    ? `${atBase}/cars-for-sale/all-cars/${make}/${model}?searchRadius=${d.search_radius || 300}${postal ? `&zip=${encodeURIComponent(postal)}` : ''}${yr ? `&startYear=${yr}&endYear=${yr}` : ''}`
    : `${atBase}/cars/${make}/${model}/?${postal ? `loc=${encodeURIComponent(postal)}&prx=${d.search_radius || 250}&` : ''}${yr ? `yRng=${yr}%2C${yr}&` : ''}sts=Used`;
  // CarGurus URLs are entity-ID based (not buildable), so use a site-scoped Google
  // search — always lands on real CarGurus listings for the vehicle.
  const q = encodeURIComponent(`${yr} ${v.make} ${v.model} ${v.trim || ''} for sale`.trim());
  const cg = `https://www.google.com/search?q=${q}+site:${isUS ? 'cargurus.com' : 'cargurus.ca'}`;
  return `
    <div class="flex flex-wrap items-center gap-2">
      <span class="text-[11px] font-semibold text-slate-400">Compare across sites:</span>
      <a href="${at}" target="_blank" rel="noopener" class="text-xs font-bold px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition">AutoTrader ↗</a>
      <a href="${cg}" target="_blank" rel="noopener" class="text-xs font-bold px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition">CarGurus ↗</a>
    </div>`;
}

// ── Appraisal PDF (print-to-PDF window with charts) ──────────────────────────
function apprHistogramSvg(prices, marks, money) {
  if (!prices.length) return '';
  const W = 680, H = 210, padL = 44, padR = 20, padT = 24, padB = 40;
  const vals = prices.concat([marks.offer, marks.median, marks.sold].filter(x => x != null));
  const lo = Math.floor(Math.min(...vals) / 1000) * 1000;
  const hi = Math.ceil(Math.max(...vals) / 1000) * 1000 || lo + 1000;
  const bins = 8, bw = (hi - lo) / bins || 1;
  const counts = new Array(bins).fill(0);
  prices.forEach(p => { let i = Math.floor((p - lo) / bw); if (i < 0) i = 0; if (i >= bins) i = bins - 1; counts[i]++; });
  const maxC = Math.max(...counts, 1);
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const xOf = (val) => padL + ((val - lo) / (hi - lo)) * plotW;
  let bars = '';
  for (let i = 0; i < bins; i++) {
    const bx = padL + (i / bins) * plotW + 3, bwid = plotW / bins - 6, bh = (counts[i] / maxC) * plotH;
    bars += `<rect x="${bx.toFixed(1)}" y="${(padT + plotH - bh).toFixed(1)}" width="${bwid.toFixed(1)}" height="${bh.toFixed(1)}" fill="#c7d2fe" rx="2"/>`;
  }
  const mark = (val, color, txt) => val == null ? '' :
    `<line x1="${xOf(val).toFixed(1)}" y1="${padT}" x2="${xOf(val).toFixed(1)}" y2="${padT + plotH}" stroke="${color}" stroke-width="2" stroke-dasharray="4 3"/>
     <text x="${xOf(val).toFixed(1)}" y="${padT - 8}" fill="${color}" font-size="10" font-weight="700" text-anchor="middle">${txt}</text>`;
  let xlab = '';
  for (let i = 0; i <= bins; i += 2) { const val = lo + i * bw; xlab += `<text x="${xOf(val).toFixed(1)}" y="${H - padB + 16}" fill="#64748b" font-size="9" text-anchor="middle">${money(Math.round(val))}</text>`; }
  return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto">
    ${bars}
    <line x1="${padL}" y1="${padT + plotH}" x2="${W - padR}" y2="${padT + plotH}" stroke="#cbd5e1"/>
    ${mark(marks.median, '#4f46e5', 'We sell')}
    ${mark(marks.sold, '#b45309', 'Sold')}
    ${mark(marks.offer, '#16a34a', 'We buy')}
    ${xlab}
  </svg>`;
}
function apprLocationSvg(locations) {
  const top = (locations || []).slice(0, 8);
  if (!top.length) return '';
  const maxC = Math.max(...top.map(l => l.count), 1);
  const rowH = 24, W = 680, labelW = 70, numW = 40;
  let rows = '';
  top.forEach((l, i) => {
    const y = i * rowH, bwid = (W - labelW - numW) * (l.count / maxC);
    rows += `<text x="0" y="${y + 16}" font-size="11" fill="#0f172a" font-weight="600">${esc(l.region || 'Other')}</text>
      <rect x="${labelW}" y="${y + 5}" width="${Math.max(2, bwid).toFixed(1)}" height="14" fill="#818cf8" rx="3"/>
      <text x="${(labelW + Math.max(2, bwid) + 6).toFixed(1)}" y="${y + 16}" font-size="10" fill="#475569">${l.count}</text>`;
  });
  return `<svg viewBox="0 0 ${W} ${top.length * rowH}" style="width:100%;height:auto">${rows}</svg>`;
}
function generateAppraisalPdf() {
  const d = __apprData;
  if (!d || !d.retail || !d.appraisal) { showToast('Run an appraisal first', 'error'); return; }
  const v = d.vehicle || {}, rt = d.retail, ap = d.appraisal;
  const label = [v.year, v.make, v.model, v.trim].filter(Boolean).join(' ') || 'Vehicle';
  const cur = d.currency || 'CAD', du = d.distance_unit || 'km';
  const money = (n) => n != null ? '$' + Number(n).toLocaleString() : '—';
  const prices = (d.comps || []).map(c => c.price).filter(p => p > 0);
  const sd = d.sold || null;
  const hist = apprHistogramSvg(prices, { median: rt.median, offer: ap.suggested_offer, sold: sd?.median_price ?? null }, money);
  const locs = apprLocationSvg(d.locations || []);
  const today = new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
  const row = (l, val, strong) => `<tr><td style="padding:6px 0;color:#475569">${l}</td><td style="padding:6px 0;text-align:right;font-weight:${strong ? 800 : 600};color:${strong ? '#4f46e5' : '#0f172a'}">${val}</td></tr>`;

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Appraisal — ${esc(label)}</title>
<style>
  @media print { .no-print{display:none!important} @page{margin:0.6in} }
  *{box-sizing:border-box} body{font-family:-apple-system,Segoe UI,Arial,sans-serif;color:#0f172a;background:#fff;margin:0;padding:24px;max-width:760px;margin:0 auto}
  h1{font-size:22px;margin:0} h2{font-size:14px;text-transform:uppercase;letter-spacing:.05em;color:#64748b;margin:26px 0 8px}
  .head{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #e2e8f0;padding-bottom:12px}
  .offer{background:#4f46e5;color:#fff;border-radius:12px;padding:18px 20px;margin-top:18px}
  .offer .n{font-size:32px;font-weight:900;margin-top:2px}
  table{width:100%;border-collapse:collapse;font-size:13px}
  .card{border:1px solid #e2e8f0;border-radius:10px;padding:14px}
  .grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-top:12px}
  .stat .l{font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:#94a3b8;font-weight:700}
  .stat .v{font-size:18px;font-weight:800;margin-top:2px}
  .cap{font-size:11px;color:#94a3b8;margin-top:6px}
  .btn{padding:9px 18px;border-radius:8px;border:none;cursor:pointer;font-weight:700;font-size:13px;background:#4f46e5;color:#fff}
</style></head><body>
  <div class="no-print" style="display:flex;justify-content:flex-end;gap:10px;margin-bottom:14px">
    <button class="btn" onclick="window.print()">Print / Save as PDF</button>
    <button class="btn" style="background:#e2e8f0;color:#0f172a" onclick="window.close()">Close</button>
  </div>
  <div class="head">
    <div><h1>${esc(d.dealer_name || 'Trade Appraisal')}</h1><div style="color:#64748b;font-size:13px;margin-top:2px">Vehicle Trade Appraisal</div></div>
    <div style="text-align:right;font-size:12px;color:#64748b">${today}</div>
  </div>

  <div style="font-size:17px;font-weight:800;margin-top:16px">${esc(label)}</div>
  <div style="color:#64748b;font-size:13px">${v.mileage ? Number(v.mileage).toLocaleString() + ' ' + du : ''}${v.vin ? ' · VIN ' + esc(v.vin) : ''}</div>

  <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:18px">
    <div class="offer" style="margin-top:0">
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:.05em;opacity:.8;font-weight:700">We buy it for (trade / cash offer)</div>
      <div class="n">${money(ap.suggested_offer)} <span style="font-size:15px;opacity:.8">${cur}</span></div>
      ${ap.pct_to_market != null ? `<div style="font-size:12px;opacity:.85;margin-top:4px">${ap.pct_to_market}% of retail market</div>` : ''}
    </div>
    <div class="offer" style="margin-top:0;background:#059669">
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:.05em;opacity:.85;font-weight:700">We sell it for (retail)</div>
      <div class="n">${money(rt.median)} <span style="font-size:15px;opacity:.8">${cur}</span></div>
      <div style="font-size:12px;opacity:.9;margin-top:4px">${money(rt.median - ap.suggested_offer)} spread before costs</div>
    </div>
  </div>

  ${ap.ai_summary ? `<div class="card" style="background:#f5f3ff;border-color:#ddd6fe">
    <div style="font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:#6d28d9;font-weight:800;margin-bottom:4px">AI Market Insight</div>
    <div style="font-size:13px;color:#334155;line-height:1.5">${esc(ap.ai_summary)}</div>
  </div>` : ''}

  <h2>Price breakdown</h2>
  <div class="card"><table>
    ${(() => {
      const adj = ap.adjustments;
      if (!adj) return row('Retail market value (median of ' + (rt.count ?? '—') + ' comps)', money(ap.retail_mid));
      const signed = (n) => (n < 0 ? '−' : '+') + money(Math.abs(n));
      let out = row('Comparable asking median (' + (rt.count ?? '—') + ' comps)', money(adj.comp_median));
      if (adj.mileage_adjustment) {
        const detail = (adj.subject_mileage != null && adj.market_mileage != null)
          ? ' (' + Number(adj.subject_mileage).toLocaleString() + ' vs ' + Math.round(adj.market_mileage).toLocaleString() + ' ' + du + ')' : '';
        out += row('Mileage adjustment' + detail, signed(adj.mileage_adjustment));
      }
      if (adj.market_realism_amount) out += row('Ask → sold market adjustment (' + adj.market_realism_pct + '%)', signed(adj.market_realism_amount));
      out += '<tr><td colspan="2"><div style="border-top:1px solid #e2e8f0;margin:4px 0"></div></td></tr>';
      if (adj.accident_amount) {
        out += row('Adjusted retail value (clean history)', money(adj.retail_clean != null ? adj.retail_clean : ap.retail_mid), true);
        out += row('− Accident / history' + (adj.accident_tier ? ' (' + adj.accident_tier + (adj.accident_pct != null ? ', −' + adj.accident_pct + '%' : '') + ')' : ''), '−' + money(Math.abs(adj.accident_amount)));
        out += '<tr><td colspan="2"><div style="border-top:1px solid #e2e8f0;margin:4px 0"></div></td></tr>';
        out += row('Retail value (this vehicle)', money(ap.retail_mid), true);
      } else {
        out += row('Adjusted retail value', money(ap.retail_mid), true);
      }
      if (adj.trade_value != null && adj.trade_value < adj.retail_value - 1) {
        out += row('− Retail → wholesale spread' + (adj.trade_ratio_pct != null ? ' (wholesale = ' + adj.trade_ratio_pct + '% of retail)' : ''), '−' + money(adj.retail_value - adj.trade_value));
        out += '<tr><td colspan="2"><div style="border-top:1px solid #e2e8f0;margin:4px 0"></div></td></tr>';
        out += row('Wholesale value (ACV)', money(adj.trade_value), true);
      }
      return out;
    })()}
    ${row('− Reconditioning', '−' + money(ap.recon))}
    ${row('− Target gross', '−' + money(ap.target_gross))}
    <tr><td colspan="2"><div style="border-top:1px solid #e2e8f0;margin:4px 0"></div></td></tr>
    ${row('ACV / wholesale take-in', money(ap.suggested_offer), true)}
    ${ap.pct_to_market != null ? row('Take-in as % of retail market', ap.pct_to_market + '%') : ''}
  </table></div>

  <div class="grid">
    <div class="card stat"><div class="l">Retail range</div><div class="v">${money(rt.low)}–${money(rt.high)}</div></div>
    <div class="card stat"><div class="l">Avg days to sell</div><div class="v">${rt.avg_days_online != null ? rt.avg_days_online + ' days' : '—'}</div></div>
    <div class="card stat"><div class="l">Comparable listings</div><div class="v">${rt.count ?? '—'}</div></div>
  </div>

  ${sd ? `<h2>Proven to market — recently sold</h2>
  <div class="card" style="border-color:#a7f3d0;background:#f0fdf4">
    <div class="grid" style="margin-top:0">
      <div class="stat"><div class="l">Sold median</div><div class="v" style="color:#047857">${money(sd.median_price)}</div></div>
      <div class="stat"><div class="l">Days on market</div><div class="v">${sd.median_dom != null ? sd.median_dom + ' days' : '—'}</div></div>
      <div class="stat"><div class="l">Your offer vs sold</div><div class="v">${sd.offer_vs_sold_pct != null ? sd.offer_vs_sold_pct + '%' : '—'}</div></div>
    </div>
    <div class="cap">${sd.count} comparable vehicle${sd.count === 1 ? '' : 's'} that actually sold${sd.ask_vs_sold_pct != null ? ` — real sale prices ran ${sd.ask_vs_sold_pct}% below the asking median` : ''}. The closest public proof of what this ${esc(label)} sells for, and how fast.</div>
  </div>` : ''}

  ${hist ? `<h2>Market price distribution</h2><div class="card">${hist}<div class="cap">Live retail listings for this ${esc(label)}. Dashed lines mark what we sell it for (retail)${sd ? ', the recent sold median' : ''} and what we buy it at (offer).</div></div>` : ''}

  ${locs ? `<h2>Where these comparables are</h2><div class="card">${locs}<div class="cap">Locations of the comparable listings (by region), from ${rt.count ?? (d.comps || []).length} active listings.</div></div>` : ''}

  ${(() => {
    const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
    const rows = (d.comps || []).filter(c => c.price > 0).sort((a, b) => a.price - b.price).slice(0, 40);
    if (!rows.length) return '';
    return `<h2>Comparable listings — click to compare</h2><div class="card"><table>
      <tr style="color:#94a3b8;font-size:10px;text-transform:uppercase;letter-spacing:.04em">
        <td style="padding:4px 0">Price</td><td style="padding:4px 0;text-align:right">${du === 'mi' ? 'Miles' : 'KM'}</td>
        <td style="padding:4px 0">Dealer / location</td><td style="padding:4px 0;text-align:right">Link</td></tr>
      ${rows.map(c => {
        const loc = [c.dealer, [c.city, c.region].filter(Boolean).join(', ')].filter(Boolean).join(' · ');
        return `<tr style="border-top:1px solid #f1f5f9">
          <td style="padding:6px 0;font-weight:700">${money(c.price)}</td>
          <td style="padding:6px 0;text-align:right;color:#475569">${c.miles ? Number(c.miles).toLocaleString() : '—'}</td>
          <td style="padding:6px 0;color:#475569;font-size:12px">${esc(loc || '—')}</td>
          <td style="padding:6px 0;text-align:right">${c.url ? `<a href="${encodeURI(c.url)}" target="_blank" style="color:#4f46e5;font-weight:700;text-decoration:none">${esc(host(c.url) || 'View')} ↗</a>` : '<span style="color:#cbd5e1">—</span>'}</td>
        </tr>`;
      }).join('')}
    </table><div class="cap">Live comparable listings. Click a link to open the actual ad and compare.</div></div>`;
  })()}

  ${(() => {
    const rows = (sd?.listings || []).filter(c => c.price > 0).sort((a, b) => a.price - b.price).slice(0, 25);
    if (!rows.length) return '';
    return `<h2>Recently sold — proven transactions</h2><div class="card"><table>
      <tr style="color:#94a3b8;font-size:10px;text-transform:uppercase;letter-spacing:.04em">
        <td style="padding:4px 0">Sold price</td><td style="padding:4px 0;text-align:right">${du === 'mi' ? 'Miles' : 'KM'}</td>
        <td style="padding:4px 0;text-align:right">Days on mkt</td><td style="padding:4px 0">Location</td><td style="padding:4px 0;text-align:right">Sold</td></tr>
      ${rows.map(c => {
        const loc = [c.dealer, [c.city, c.region].filter(Boolean).join(', ')].filter(Boolean).join(' · ');
        return `<tr style="border-top:1px solid #f1f5f9">
          <td style="padding:6px 0;font-weight:700;color:#047857">${money(c.price)}</td>
          <td style="padding:6px 0;text-align:right;color:#475569">${c.miles ? Number(c.miles).toLocaleString() : '—'}</td>
          <td style="padding:6px 0;text-align:right;color:#475569">${c.dom != null ? c.dom : '—'}</td>
          <td style="padding:6px 0;color:#475569;font-size:12px">${esc(loc || '—')}</td>
          <td style="padding:6px 0;text-align:right;color:#64748b">${esc(fmtSoldDate(c.sold_date))}</td>
        </tr>`;
      }).join('')}
    </table><div class="cap">Comparable vehicles that recently left the market — real sale prices and how long each took to sell.</div></div>`;
  })()}

  <div style="margin-top:22px;font-size:11px;color:#94a3b8;border-top:1px solid #e2e8f0;padding-top:10px">
    Prepared ${today}. Values are retail-market estimates from live ${esc(rt.source || 'MarketCheck')} listings — not a guaranteed offer or an auction/wholesale value. Final offer subject to inspection.
  </div>
</body></html>`;

  const w = window.open('', '_blank');
  if (!w) { showToast('Allow pop-ups to open the PDF view', 'error'); return; }
  w.document.write(html);
  w.document.close();
}

// Appointments open in a full-screen modal from the Pipeline page.
document.addEventListener('DOMContentLoaded', () => {
  const apptBtn = document.getElementById('open-appointments-btn');
  const panel = document.getElementById('appointments-panel');
  if (!apptBtn || !panel) return;
  const closeBtn = document.getElementById('close-appointments-btn');
  const openModal = () => { panel.classList.remove('hidden'); document.body.style.overflow = 'hidden'; loadAppointmentsPage(); };
  const closeModal = () => { panel.classList.add('hidden'); document.body.style.overflow = ''; };
  apptBtn.addEventListener('click', openModal);
  closeBtn?.addEventListener('click', closeModal);
  // Click the dark backdrop (but not the panel itself) to close.
  panel.addEventListener('click', (e) => { if (e.target === panel) closeModal(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !panel.classList.contains('hidden')) closeModal(); });
});

// ══ Built-in CRM ═════════════════════════════════════════════════════════════
// Unified customer records + activity timeline + follow-up tasks. Every lead,
// appraisal and sale lands on one contact. One tool, one place.
let __crmTab = 'contacts';
let __crmSearchTimer = null;
const crmMoney = (n, cur) => n != null ? (cur === 'USD' ? 'US$' : '$') + Number(n).toLocaleString() : '—';
const crmWhen = (s) => {
  if (!s) return '';
  const d = new Date(s); if (isNaN(d.getTime())) return '';
  const diff = (Date.now() - d.getTime()) / 86400000;
  if (diff < 1 && d.getDate() === new Date().getDate()) return 'Today';
  if (diff < 2) return 'Yesterday';
  if (diff < 7) return Math.floor(diff) + 'd ago';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: diff > 300 ? 'numeric' : undefined });
};
const CRM_STATUS = { uncontacted: 'Uncontacted', contacted: 'Contacted', appointment: 'Appointment', sold: 'Sold', fni: 'F&I', turnover: 'Turn over', delivered: 'Delivered', followup: 'Follow up', lost: 'Lost' };
const crmStatusColor = (s) => ({
  uncontacted: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300',
  contacted: 'bg-sky-100 text-sky-700 dark:bg-sky-950/40 dark:text-sky-300',
  appointment: 'bg-violet-100 text-violet-700 dark:bg-violet-950/40 dark:text-violet-300',
  sold: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300',
  fni: 'bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300',
  turnover: 'bg-orange-100 text-orange-700 dark:bg-orange-950/40 dark:text-orange-300',
  delivered: 'bg-teal-100 text-teal-700 dark:bg-teal-950/40 dark:text-teal-300',
  followup: 'bg-blue-100 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300',
  lost: 'bg-rose-100 text-rose-600 dark:bg-rose-950/40 dark:text-rose-300',
}[s] || 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300');

// Lookup caches for the intake form (reps + our inventory for the "new car" picker).
let __crmReps = null, __crmInventory = null;
async function crmEnsureLookups() {
  if (!__crmReps) { try { __crmReps = (await apiGetJson('/crm/reps')).reps || []; } catch { __crmReps = []; } }
  if (!__crmInventory) {
    try { __crmInventory = (await apiGetJson('/inventory/all', { retries: 1 })).filter(v => String(v.status || 'available').toLowerCase() === 'available'); }
    catch { __crmInventory = []; }
  }
}

async function loadCrmPage() {
  const root = document.getElementById('crm-root');
  if (!root) return;
  const tab = (id, label) => `<button onclick="crmSetTab('${id}')" class="px-4 py-2 text-sm font-bold border-b-2 whitespace-nowrap transition ${__crmTab === id ? 'border-indigo-500 text-indigo-600 dark:text-indigo-400' : 'border-transparent text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'}">${label}</button>`;
  root.innerHTML = `
    <div class="flex items-center gap-1 border-b border-slate-200 dark:border-slate-800 mb-4 overflow-x-auto">
      ${tab('contacts', 'Contacts')}${tab('leads', 'Leads')}${tab('appointments', 'Appointments')}${tab('tasks', 'Tasks')}
    </div>
    <div id="crm-body"></div>`;
  const body = document.getElementById('crm-body');
  if (__crmTab === 'contacts') crmLoadContacts();
  else if (__crmTab === 'tasks') crmLoadTasks();
  else if (__crmTab === 'leads') {
    // Leads (incl. Facebook Marketplace) + the DMS/CRM (ADF) connection live here now.
    body.innerHTML = `<div id="leads-root"><div class="py-16 text-center text-sm text-slate-400 italic">Loading leads…</div></div>`;
    loadLeadsPage();
  } else if (__crmTab === 'appointments') {
    body.innerHTML = `<div id="appointments-root"><div class="py-16 text-center text-sm text-slate-400 italic">Loading appointments…</div></div>`;
    loadAppointmentsPage();
  }
}
function crmSetTab(t) { __crmTab = t; loadCrmPage(); }

let __crmCanSeeAll = false;
// Renders the persistent toolbar (search + manager "by rep" filter) ONCE, then
// only refreshes the list on search/filter so the search box keeps focus.
async function crmLoadContacts() {
  const body = document.getElementById('crm-body');
  if (!body) return;
  await crmEnsureLookups();   // reps for the "by rep" filter
  body.innerHTML = `
    <div class="flex flex-wrap items-center gap-2 mb-3">
      <div class="relative flex-1 min-w-[200px] max-w-sm">
        <svg class="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path stroke-linecap="round" d="M21 21l-4-4"/></svg>
        <input id="crm-search" placeholder="Search ALL contacts — name, email, phone…" oninput="crmSearchDebounced()" class="w-full bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded-lg pl-9 pr-3 py-2 text-sm">
      </div>
      <span id="crm-repfilter"></span>
    </div>
    <div id="crm-list" class="py-10 text-center text-sm text-slate-400 italic">Loading contacts…</div>`;
  crmRefreshContacts();
}
function crmSearchDebounced() { clearTimeout(__crmSearchTimer); __crmSearchTimer = setTimeout(crmRefreshContacts, 300); }
async function crmRefreshContacts() {
  if (!document.getElementById('crm-list')) return;
  const q = (document.getElementById('crm-search')?.value || '').trim();
  const rep = document.getElementById('crm-rep')?.value || '';
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  if (rep) params.set('rep', rep);
  try {
    const d = await apiGetJson(`/crm/contacts${params.toString() ? `?${params}` : ''}`);
    const list = document.getElementById('crm-list');
    if (!list) return;   // navigated away mid-fetch
    __crmCanSeeAll = d.can_see_all;
    // Render the "by rep" filter once managers are confirmed (kept across refreshes).
    const rf = document.getElementById('crm-repfilter');
    if (rf && d.can_see_all && !document.getElementById('crm-rep')) {
      rf.innerHTML = `<select id="crm-rep" onchange="crmRefreshContacts()" class="bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded-lg px-3 py-2 text-sm">
        <option value="">All reps</option>
        ${(__crmReps || []).map(r => `<option value="${r.id}">${esc(r.name)}</option>`).join('')}
      </select>`;
    }
    const contacts = d.contacts || [];
    if (!contacts.length) {
      list.className = '';
      list.innerHTML = `<div class="py-16 text-center text-sm text-slate-400">${q || rep ? 'No contacts match.' : 'No contacts yet — they appear automatically as you capture leads and save appraisals, or add one manually.'}</div>`;
      return;
    }
    const scopeNote = q ? 'searching all' : (rep ? 'one rep' : (d.can_see_all ? 'whole team' : 'yours'));
    list.className = '';
    list.innerHTML = `<div class="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden divide-y divide-slate-100 dark:divide-slate-800">
      ${contacts.map(crmContactRow).join('')}</div>
      <div class="text-[11px] text-slate-400 mt-2">${contacts.length} contact${contacts.length === 1 ? '' : 's'} · ${scopeNote}</div>`;
  } catch (e) {
    const list = document.getElementById('crm-list');
    if (list) list.innerHTML = `<div class="py-16 text-center text-sm text-slate-500">Couldn't load contacts: ${esc(e.message)}<br><button onclick="crmRefreshContacts()" class="mt-3 text-indigo-500 font-bold">Retry</button></div>`;
  }
}
function crmContactRow(c) {
  const initials = (c.full_name || '?').split(/\s+/).map(w => w[0]).filter(Boolean).slice(0, 2).join('').toUpperCase();
  const sub = [c.email, c.phone].filter(Boolean).join(' · ');
  return `<div onclick="openCrmContact('${c.id}')" class="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-indigo-50 dark:hover:bg-indigo-950/20 transition">
    <div class="w-9 h-9 rounded-full bg-indigo-100 dark:bg-indigo-950/50 text-indigo-600 dark:text-indigo-300 flex items-center justify-center text-xs font-black flex-shrink-0">${esc(initials || '?')}</div>
    <div class="min-w-0 flex-1">
      <div class="flex items-center gap-2"><span class="font-bold text-slate-900 dark:text-white truncate">${esc(c.full_name || 'Unknown')}</span>
        <span class="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-full ${crmStatusColor(c.status)}">${esc(CRM_STATUS[c.status] || c.status)}</span>
        ${c.dnc ? '<span class="text-[10px] font-bold text-rose-500">DNC</span>' : ''}
      </div>
      <div class="text-xs text-slate-500 dark:text-slate-400 truncate">${esc(sub || '—')}</div>
    </div>
    <div class="text-right flex-shrink-0 flex flex-col items-end gap-1">
      <select onclick="event.stopPropagation()" onchange="crmQuickStatus(event,'${c.id}')" title="Move up the pipeline" class="text-[11px] font-bold border border-slate-200 dark:border-slate-700 rounded-md bg-white dark:bg-slate-950 text-slate-700 dark:text-slate-200 px-1.5 py-1 cursor-pointer">
        ${Object.entries(CRM_STATUS).map(([k, l]) => `<option value="${k}" ${c.status === k ? 'selected' : ''}>${l}</option>`).join('')}
      </select>
      ${c.rep_name ? `<div class="text-[11px] text-slate-500 dark:text-slate-400">${esc(c.rep_name)}</div>` : ''}
      <div class="text-[11px] text-slate-400">${esc(crmWhen(c.last_activity_at || c.created_at))}</div>
    </div>
  </div>`;
}
// Quick pipeline move from the list — PUT the new stage (fires automation server-side).
async function crmQuickStatus(ev, id) {
  ev.stopPropagation();
  const sel = ev.target, status = sel.value;
  sel.disabled = true;
  try { await apiSendJson(`/crm/contacts/${id}`, 'PUT', { status }); showToast('Moved to ' + (CRM_STATUS[status] || status), 'success'); if (typeof crmRefreshContacts === 'function') crmRefreshContacts(); }
  catch (e) { showToast(e.message, 'error'); }
  finally { sel.disabled = false; }
}
window.crmQuickStatus = crmQuickStatus;

// ── Contact detail modal ─────────────────────────────────────────────────────
function crmOverlay(inner, maxW = 'max-w-2xl') {
  const el = document.createElement('div');
  el.className = 'fixed inset-0 z-[9998] bg-black/50 flex items-start md:items-center justify-center p-3 overflow-y-auto';
  el.innerHTML = `<div class="bg-white dark:bg-slate-900 rounded-2xl shadow-2xl w-full ${maxW} my-4 max-h-[92vh] overflow-y-auto" onclick="event.stopPropagation()">${inner}</div>`;
  el.addEventListener('click', () => el.remove());
  document.addEventListener('keydown', function esc2(ev) { if (ev.key === 'Escape') { el.remove(); document.removeEventListener('keydown', esc2); } });
  document.body.appendChild(el);
  return el;
}
async function openCrmContact(id) {
  const ov = crmOverlay(`<div class="p-10 text-center text-sm text-slate-400 italic">Loading…</div>`);
  try {
    const d = await apiGetJson(`/crm/contacts/${id}`);
    ov.querySelector('div > div').innerHTML = crmDetailHtml(d);
    ov.__contactId = id;
  } catch (e) { ov.querySelector('div > div').innerHTML = `<div class="p-8 text-center text-sm text-slate-500">Couldn't load: ${esc(e.message)}</div>`; }
}
function crmDetailHtml(d) {
  const c = d.contact;
  const initials = (c.full_name || '?').split(/\s+/).map(w => w[0]).filter(Boolean).slice(0, 2).join('').toUpperCase();
  const openTasks = (d.tasks || []).filter(t => !t.done);
  return `
  <div class="sticky top-0 bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 px-5 py-4 flex items-start justify-between gap-3 z-10">
    <div class="flex items-center gap-3 min-w-0">
      <div class="w-11 h-11 rounded-full bg-indigo-100 dark:bg-indigo-950/50 text-indigo-600 dark:text-indigo-300 flex items-center justify-center text-sm font-black flex-shrink-0">${esc(initials || '?')}</div>
      <div class="min-w-0">
        <div class="flex items-center gap-2"><span class="text-lg font-black text-slate-900 dark:text-white truncate">${esc(c.full_name || 'Unknown')}</span>
          <span class="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-full ${crmStatusColor(c.status)}">${esc(CRM_STATUS[c.status] || c.status)}</span></div>
        <div class="text-xs text-slate-500 dark:text-slate-400 truncate">${esc([c.email, c.phone].filter(Boolean).join(' · ') || 'No contact info')}</div>
      </div>
    </div>
    <button onclick="this.closest('.fixed').remove()" class="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 flex-shrink-0"><svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" d="M6 6l12 12M18 6L6 18"/></svg></button>
  </div>
  <div class="p-5 space-y-4">
    <div class="flex flex-wrap gap-2">
      ${c.email && !c.dnc && c.consent_email !== false ? `<button onclick="crmEmailForm('${c.id}')" class="flex items-center gap-1.5 text-xs font-bold bg-indigo-600 hover:bg-indigo-500 text-white px-3 py-1.5 rounded-lg"><svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M3 8l9 6 9-6M4 6h16v12H4z"/></svg>Email</button>` : ''}
      ${c.phone ? `<a href="tel:${esc(c.phone)}" onclick="crmQuickLog('${c.id}','call')" class="flex items-center gap-1.5 text-xs font-bold bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 px-3 py-1.5 rounded-lg"><svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M2.25 6.75c0 8.284 6.716 15 15 15h2.25a2.25 2.25 0 002.25-2.25v-1.372c0-.516-.351-.966-.852-1.091l-4.423-1.106c-.44-.11-.902.055-1.173.417l-.97 1.293c-.282.376-.769.542-1.21.38a12.035 12.035 0 01-7.143-7.143c-.162-.441.004-.928.38-1.21l1.293-.97c.363-.271.527-.734.417-1.173L6.963 3.102a1.125 1.125 0 00-1.091-.852H4.5A2.25 2.25 0 002.25 4.5v2.25z"/></svg>Call</a>` : ''}
      ${c.phone ? `<a href="sms:${esc(c.phone)}" onclick="crmQuickLog('${c.id}','sms')" class="flex items-center gap-1.5 text-xs font-bold bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 px-3 py-1.5 rounded-lg"><svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M8 12h8M8 8h8m-8 8h4m5-13H3v14l4-3h14V3z"/></svg>Text</a>` : ''}
      <button onclick="crmLogForm('${c.id}')" class="flex items-center gap-1.5 text-xs font-bold bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 px-3 py-1.5 rounded-lg">Log activity</button>
      <button onclick="crmTaskForm('${c.id}')" class="flex items-center gap-1.5 text-xs font-bold bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 px-3 py-1.5 rounded-lg">Add task</button>
      <button onclick="crmOpenForm('${c.id}')" class="flex items-center gap-1.5 text-xs font-bold bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 px-3 py-1.5 rounded-lg">Edit</button>
      <button onclick="crmApptForm('${c.id}')" class="flex items-center gap-1.5 text-xs font-bold bg-violet-100 dark:bg-violet-950/40 text-violet-700 dark:text-violet-300 hover:bg-violet-200 px-3 py-1.5 rounded-lg"><svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M8 7V3m8 4V3M4 11h16M5 5h14a1 1 0 011 1v13a1 1 0 01-1 1H5a1 1 0 01-1-1V6a1 1 0 011-1z"/></svg>Book appointment</button>
      ${c.status === 'delivered' && ['DEALER_ADMIN', 'OWNER', 'MANAGER'].includes(profileContext?.role) ? `<button onclick="crmLeaseForm('${c.id}')" class="flex items-center gap-1.5 text-xs font-bold bg-emerald-100 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-200 px-3 py-1.5 rounded-lg"><svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M3 6l9-3 9 3M4 10v10h16V10M9 21v-6h6v6"/></svg>Deal / equity</button>` : ''}
    </div>
    ${c.notes ? `<div class="text-xs bg-amber-50 dark:bg-amber-950/20 border border-amber-100 dark:border-amber-950/40 rounded-lg p-3 text-slate-700 dark:text-slate-300">${esc(c.notes)}</div>` : ''}
    ${crmDetailFacts(c, d)}
    ${openTasks.length ? `<div>
      <div class="text-[11px] font-bold uppercase tracking-wider text-slate-400 mb-1.5">Open tasks</div>
      <div class="space-y-1.5">${openTasks.map(t => crmTaskRow(t, c.id)).join('')}</div>
    </div>` : ''}
    <div id="crm-detail-form"></div>
    <div>
      <div class="text-[11px] font-bold uppercase tracking-wider text-slate-400 mb-2">Activity timeline</div>
      ${(d.timeline || []).length ? `<div class="space-y-2.5">${d.timeline.map(crmTimelineItem).join('')}</div>`
        : '<div class="text-sm text-slate-400 italic py-4">No activity yet.</div>'}
    </div>
  </div>`;
}
// Compact facts grid on the contact detail (address, DL, birthday, extra phones,
// source/salesperson, trade + new-car-of-interest vehicles).
function crmDetailFacts(c, d) {
  const rows = [];
  const fact = (k, v) => { if (v) rows.push(`<div><dt class="text-[10px] font-bold uppercase tracking-wider text-slate-400">${esc(k)}</dt><dd class="text-sm text-slate-800 dark:text-slate-100">${esc(v)}</dd></div>`); };
  if (c.contact_type === 'company') fact('Company', c.company_name);
  const addr = [c.address, [c.city, c.province, c.postal_code].filter(Boolean).join(', ')].filter(Boolean).join(' · ');
  fact('Address', addr);
  if (c.phone_home) fact('Home #', c.phone_home);
  if (c.phone_work) fact('Work #', c.phone_work);
  if (c.birthday) fact('Birthday', new Date(c.birthday).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }));
  if (c.dl_number) fact("Driver's licence", c.dl_number + (c.dl_expiry ? ` (exp ${new Date(c.dl_expiry).toLocaleDateString(undefined, { month: 'short', year: 'numeric' })})` : ''));
  fact('Source', c.source);
  fact('Salesperson', c.rep_name);
  const tv = c.trade_vehicle;
  if (tv && (tv.make || tv.vin)) fact('Trade vehicle', [tv.year, tv.make, tv.model, tv.trim].filter(Boolean).join(' ') + (tv.mileage ? ` · ${Number(tv.mileage).toLocaleString()} km` : '') + (tv.vin ? ` · VIN ${tv.vin}` : ''));
  if (d.interest_vehicle_label?.label) fact('New car of interest', d.interest_vehicle_label.label + (d.interest_vehicle_label.price ? ` · $${Number(d.interest_vehicle_label.price).toLocaleString()}` : ''));
  if (!rows.length) return '';
  return `<dl class="grid grid-cols-2 gap-3 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg p-3">${rows.join('')}</dl>`;
}
function crmTaskRow(t, contactId) {
  const overdue = t.due_at && new Date(t.due_at) < Date.now();
  return `<div class="flex items-center gap-2 text-sm">
    <input type="checkbox" ${t.done ? 'checked' : ''} onchange="crmToggleTask('${t.id}', this.checked, '${contactId}')" class="w-4 h-4 rounded accent-indigo-600 flex-shrink-0">
    <span class="flex-1 ${t.done ? 'line-through text-slate-400' : 'text-slate-700 dark:text-slate-200'}">${esc(t.title)}</span>
    ${t.due_at ? `<span class="text-[11px] ${overdue && !t.done ? 'text-rose-500 font-bold' : 'text-slate-400'}">${esc(crmWhen(t.due_at))}</span>` : ''}
  </div>`;
}
function crmTimelineItem(t) {
  const icon = { comm: '💬', lead: '📥', appraisal: '🚗', sale: '✅' };
  const chIcon = { call: '📞', sms: '💬', email: '✉️', note: '📝' };
  let head = '', bodyTxt = t.body || '';
  if (t.kind === 'comm') {
    const label = { call: 'Call', sms: 'Text', email: 'Email', note: 'Note', system: 'System' }[t.channel] || 'Note';
    const dir = t.direction === 'in' ? ' (inbound)' : t.direction === 'out' ? ' (outbound)' : '';
    head = `${chIcon[t.channel] || '📝'} ${label}${dir}${t.subject ? ` — ${esc(t.subject)}` : ''}`;
  } else if (t.kind === 'lead') {
    head = `📥 Lead${t.source ? ` · ${esc(t.source)}` : ''}${t.vehicle ? ` — ${esc(t.vehicle)}` : ''}`;
  } else if (t.kind === 'appraisal') {
    head = `🚗 Appraisal — ${esc(t.vehicle || 'vehicle')}${t.offer != null ? ` · offer ${crmMoney(t.offer, t.currency)}` : ''}`;
    bodyTxt = '';
  }
  return `<div class="flex gap-2.5">
    <div class="w-7 flex-shrink-0 text-center text-sm pt-0.5">${(t.kind === 'comm' ? '' : icon[t.kind]) || ''}</div>
    <div class="min-w-0 flex-1 border-l-2 border-slate-100 dark:border-slate-800 pl-3 pb-1">
      <div class="text-sm font-semibold text-slate-800 dark:text-slate-100">${head}</div>
      ${bodyTxt ? `<div class="text-sm text-slate-600 dark:text-slate-300 whitespace-pre-wrap mt-0.5">${esc(bodyTxt)}</div>` : ''}
      <div class="text-[11px] text-slate-400 mt-0.5">${esc(crmWhen(t.at))}${t.rep ? ` · ${esc(t.rep)}` : ''}</div>
    </div>
  </div>`;
}

// ── Inline forms inside the detail modal ─────────────────────────────────────
function crmDetailFormSlot(html) { const s = document.getElementById('crm-detail-form'); if (s) { s.innerHTML = html; s.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); } }
function crmLogForm(id) {
  crmDetailFormSlot(`<div class="bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg p-3 space-y-2">
    <div class="flex gap-2">
      <select id="crm-log-channel" class="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg px-2 py-1.5 text-sm"><option value="note">Note</option><option value="call">Call</option><option value="sms">Text</option><option value="email">Email</option></select>
      <input id="crm-log-subject" placeholder="Subject (optional)" class="flex-1 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg px-3 py-1.5 text-sm">
    </div>
    <textarea id="crm-log-body" rows="2" placeholder="What happened?" class="w-full bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg px-3 py-2 text-sm"></textarea>
    <div class="flex gap-2 justify-end"><button onclick="crmDetailFormSlot('')" class="text-xs font-bold text-slate-500 px-3 py-1.5">Cancel</button>
      <button onclick="crmSaveLog('${id}')" class="text-xs font-bold bg-indigo-600 hover:bg-indigo-500 text-white px-3 py-1.5 rounded-lg">Log it</button></div>
  </div>`);
}
async function crmSaveLog(id) {
  const channel = document.getElementById('crm-log-channel')?.value || 'note';
  const subject = document.getElementById('crm-log-subject')?.value || '';
  const body = document.getElementById('crm-log-body')?.value || '';
  if (!body.trim() && !subject.trim()) { showToast('Add a note', 'error'); return; }
  try { await apiSendJson(`/crm/contacts/${id}/log`, 'POST', { channel, subject, body, direction: channel === 'note' ? 'internal' : 'out' }); showToast('Logged', 'success'); openCrmContact(id); }
  catch (e) { showToast(e.message, 'error'); }
}
async function crmQuickLog(id, channel) {
  // Fired when a rep taps Call/Text — auto-logs the touch so the timeline stays honest.
  try { await apiSendJson(`/crm/contacts/${id}/log`, 'POST', { channel, direction: 'out', body: channel === 'call' ? 'Called (tap-to-dial)' : 'Texted (tap-to-message)' }); } catch {}
}
function crmEmailForm(id) {
  crmDetailFormSlot(`<div class="bg-slate-50 dark:bg-slate-950 border border-indigo-200 dark:border-indigo-900 rounded-lg p-3 space-y-2">
    <div class="text-[11px] font-bold uppercase tracking-wider text-indigo-500">Send email</div>
    <input id="crm-email-subject" placeholder="Subject" class="w-full bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg px-3 py-1.5 text-sm">
    <textarea id="crm-email-body" rows="4" placeholder="Message…" class="w-full bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg px-3 py-2 text-sm"></textarea>
    <div class="flex gap-2 justify-end"><button onclick="crmDetailFormSlot('')" class="text-xs font-bold text-slate-500 px-3 py-1.5">Cancel</button>
      <button onclick="crmSendEmail('${id}')" class="text-xs font-bold bg-indigo-600 hover:bg-indigo-500 text-white px-3 py-1.5 rounded-lg">Send</button></div>
  </div>`);
}
async function crmSendEmail(id) {
  const subject = document.getElementById('crm-email-subject')?.value || '';
  const body = document.getElementById('crm-email-body')?.value || '';
  if (!subject.trim() || !body.trim()) { showToast('Subject and message required', 'error'); return; }
  try { await apiSendJson(`/crm/contacts/${id}/email`, 'POST', { subject, body }); showToast('Email sent', 'success'); openCrmContact(id); }
  catch (e) { showToast(e.message, 'error'); }
}
function crmTaskForm(id) {
  crmDetailFormSlot(`<div class="bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg p-3 space-y-2">
    <div class="flex gap-2">
      <select id="crm-task-type" class="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg px-2 py-1.5 text-sm"><option value="followup">Follow-up</option><option value="call">Call</option><option value="text">Text</option><option value="email">Email</option><option value="other">Other</option></select>
      <input id="crm-task-due" type="date" class="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg px-2 py-1.5 text-sm">
    </div>
    <input id="crm-task-title" placeholder="Task (e.g. Follow up on financing)" class="w-full bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg px-3 py-1.5 text-sm">
    <div class="flex gap-2 justify-end"><button onclick="crmDetailFormSlot('')" class="text-xs font-bold text-slate-500 px-3 py-1.5">Cancel</button>
      <button onclick="crmSaveTask('${id}')" class="text-xs font-bold bg-indigo-600 hover:bg-indigo-500 text-white px-3 py-1.5 rounded-lg">Add task</button></div>
  </div>`);
}
async function crmSaveTask(id) {
  const title = document.getElementById('crm-task-title')?.value || '';
  const type = document.getElementById('crm-task-type')?.value || 'followup';
  const due = document.getElementById('crm-task-due')?.value || '';
  if (!title.trim()) { showToast('Enter a task', 'error'); return; }
  try { await apiSendJson('/crm/tasks', 'POST', { contact_id: id, title, type, due_at: due ? new Date(due).toISOString() : null }); showToast('Task added', 'success'); openCrmContact(id); }
  catch (e) { showToast(e.message, 'error'); }
}
async function crmToggleTask(taskId, done, contactId) {
  try { await apiSendJson(`/crm/tasks/${taskId}`, 'PUT', { done }); if (contactId) openCrmContact(contactId); else crmLoadTasks(); }
  catch (e) { showToast(e.message, 'error'); }
}
// ── Lease / equity details right on the delivered customer (managers) ────────
async function crmLeaseForm(id) {
  crmDetailFormSlot(`<div class="bg-emerald-50 dark:bg-emerald-950/20 border border-emerald-200 dark:border-emerald-900 rounded-lg p-3 text-sm text-slate-500">Loading lease details…</div>`);
  let d;
  try { [d] = await Promise.all([apiGetJson(`/equity/lease/by-contact/${id}`), eqEnsureVehicles()]); }
  catch (e) { crmDetailFormSlot(`<div class="bg-rose-50 dark:bg-rose-950/20 border border-rose-200 dark:border-rose-900 rounded-lg p-3 text-sm text-rose-600">Couldn't load: ${esc(e.message)}</div>`); return; }
  const l = d.lease;
  if (!l) { crmDetailFormSlot(`<div class="bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg p-3 space-y-2 text-sm"><div class="text-slate-600 dark:text-slate-300">No delivered vehicle record found for this customer yet. Lease/finance details attach to a delivered ownership record.</div><div class="flex justify-end"><button onclick="crmDetailFormSlot('')" class="text-xs font-bold text-slate-500 px-3 py-1.5">Close</button></div></div>`); return; }
  const dt = l.deal_type || (l.is_leased ? 'lease' : 'finance');
  const ic = 'w-full bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded px-2 py-1 text-xs';
  crmDetailFormSlot(`<div class="bg-emerald-50 dark:bg-emerald-950/20 border border-emerald-200 dark:border-emerald-900 rounded-lg p-3 space-y-2" data-lease="${l.id}">
    <div class="flex items-center gap-2 flex-wrap">
      <div class="text-[11px] font-bold uppercase tracking-wider text-emerald-600 flex-1 min-w-0">Deal / equity — ${esc(l.vehicle || 'vehicle')}</div>
      <select class="clz-dtype bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded px-2 py-1 text-xs font-bold" onchange="eqDealTypeToggle(this)">${Object.keys(DEAL_LABELS).map(t => `<option value="${t}" ${dt === t ? 'selected' : ''}>${DEAL_LABELS[t]}</option>`).join('')}</select>
    </div>
    ${l.equity != null ? `<div class="text-xs font-bold ${l.equity >= 0 ? 'text-emerald-600' : 'text-rose-600'}">${eqMoney(l.equity)} est. equity${l.months_remaining != null ? ` · ${l.months_remaining} mo left` : ''} · est. wholesale ${eqMoney(l.wholesaleEst)} − payoff ${eqMoney(l.payoffEst)}</div>` : ''}
    <div><label class="text-[10px] text-slate-400">Vehicle purchased</label><select class="clz-vehicle ${ic}">${eqVehicleOptions(l.vehicle_id, l.vehicle)}</select></div>
    <div class="grid grid-cols-2 sm:grid-cols-3 gap-2">
      ${eqDealFields(l, ic, 'clz-', dt, d.settings)}
    </div>
    <div class="flex gap-2 justify-end"><button onclick="crmDetailFormSlot('')" class="text-xs font-bold text-slate-500 px-3 py-1.5">Cancel</button>
      <button onclick="crmSaveLease('${l.id}','${id}', this)" class="text-xs font-bold bg-emerald-600 hover:bg-emerald-500 text-white px-4 py-1.5 rounded-lg">Save</button></div>
  </div>`);
}
async function crmSaveLease(leaseId, contactId, btn) {
  const card = btn.closest('[data-lease]'); const g = (c) => card.querySelector(c)?.value.trim();
  const body = {
    deal_type: card.querySelector('.clz-dtype')?.value || 'lease',
    vehicle_id: card.querySelector('.clz-vehicle')?.value || '',
    lease_term_months: g('.clz-term'), monthly_payment: g('.clz-pay'), residual_value: g('.clz-res'),
    loan_amount: g('.clz-loan'), loan_apr: g('.clz-apr'), purchase_price: g('.clz-price'),
    payoff_amount: g('.clz-payoff'), delivery_mileage: g('.clz-miles'), annual_km_allowance: g('.clz-km'),
  };
  const orig = btn.textContent; btn.disabled = true; btn.textContent = 'Saving…';
  try { await apiSendJson(`/equity/lease/${leaseId}`, 'PUT', body); showToast('Deal saved', 'success'); crmLeaseForm(contactId); }
  catch (e) { btn.disabled = false; btn.textContent = orig; showToast(e.message, 'error'); }
}
// ── Appointment booking (with Gmail + Outlook calendar links) ────────────────
function crmApptForm(id) {
  const now = new Date(Date.now() + 3600000);
  const defDate = now.toISOString().slice(0, 10), defTime = now.toTimeString().slice(0, 5);
  crmDetailFormSlot(`<div class="bg-violet-50 dark:bg-violet-950/20 border border-violet-200 dark:border-violet-900 rounded-lg p-3 space-y-2">
    <div class="text-[11px] font-bold uppercase tracking-wider text-violet-500">Book appointment</div>
    <input id="crm-appt-title" value="Appointment" placeholder="Title" class="w-full bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg px-3 py-1.5 text-sm">
    <div class="flex gap-2">
      <input id="crm-appt-date" type="date" value="${defDate}" class="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg px-2 py-1.5 text-sm">
      <input id="crm-appt-time" type="time" value="${defTime}" class="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg px-2 py-1.5 text-sm">
      <select id="crm-appt-dur" class="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg px-2 py-1.5 text-sm"><option value="30">30 min</option><option value="60" selected>1 hr</option><option value="90">1.5 hr</option></select>
    </div>
    <div class="flex gap-2 justify-end"><button onclick="crmDetailFormSlot('')" class="text-xs font-bold text-slate-500 px-3 py-1.5">Cancel</button>
      <button onclick="crmSaveAppt('${id}')" class="text-xs font-bold bg-violet-600 hover:bg-violet-500 text-white px-3 py-1.5 rounded-lg">Book + get calendar links</button></div>
  </div>`);
}
function crmCalLinks(title, startIso, mins, details) {
  const start = new Date(startIso), end = new Date(start.getTime() + mins * 60000);
  const z = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');   // 20260711T150000Z
  const g = `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent(title)}&dates=${z(start)}/${z(end)}&details=${encodeURIComponent(details || '')}`;
  const o = `https://outlook.office.com/calendar/0/deeplink/compose?subject=${encodeURIComponent(title)}&startdt=${start.toISOString()}&enddt=${end.toISOString()}&body=${encodeURIComponent(details || '')}`;
  const ics = 'data:text/calendar;charset=utf8,' + encodeURIComponent(`BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nDTSTART:${z(start)}\nDTEND:${z(end)}\nSUMMARY:${title}\nDESCRIPTION:${details || ''}\nEND:VEVENT\nEND:VCALENDAR`);
  return { g, o, ics };
}
async function crmSaveAppt(id) {
  const title = document.getElementById('crm-appt-title')?.value || 'Appointment';
  const date = document.getElementById('crm-appt-date')?.value;
  const time = document.getElementById('crm-appt-time')?.value || '09:00';
  const dur = Number(document.getElementById('crm-appt-dur')?.value || 60);
  if (!date) { showToast('Pick a date', 'error'); return; }
  const startIso = new Date(`${date}T${time}`).toISOString();
  try {
    await apiSendJson('/crm/tasks', 'POST', { contact_id: id, title, type: 'appointment', due_at: startIso });
    await apiSendJson(`/crm/contacts/${id}/log`, 'POST', { channel: 'note', direction: 'internal', subject: 'Appointment booked', body: `${title} — ${new Date(startIso).toLocaleString()}` });
    await apiSendJson(`/crm/contacts/${id}`, 'PUT', { status: 'appointment' });
    const { g, o, ics } = crmCalLinks(title, startIso, dur, 'Booked via MarketSync CRM');
    crmDetailFormSlot(`<div class="bg-violet-50 dark:bg-violet-950/20 border border-violet-200 dark:border-violet-900 rounded-lg p-3 space-y-2">
      <div class="text-sm font-bold text-slate-800 dark:text-slate-100">Appointment booked for ${esc(new Date(startIso).toLocaleString())}</div>
      <div class="text-xs text-slate-500">Add it to your calendar:</div>
      <div class="flex flex-wrap gap-2">
        <a href="${g}" target="_blank" class="text-xs font-bold bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 px-3 py-1.5 rounded-lg">📅 Google Calendar</a>
        <a href="${o}" target="_blank" class="text-xs font-bold bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 px-3 py-1.5 rounded-lg">📅 Outlook</a>
        <a href="${ics}" download="appointment.ics" class="text-xs font-bold bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 px-3 py-1.5 rounded-lg">⬇ .ics file</a>
      </div>
      <button onclick="openCrmContact('${id}')" class="text-xs font-bold text-indigo-500">Done</button>
    </div>`);
    showToast('Appointment booked', 'success');
  } catch (e) { showToast(e.message, 'error'); }
}

// ── Full add/edit contact form (the dealership intake workflow) ─────────────
// CRM / DMS (ADF) connection — lives on the Settings page now.
async function loadCrmAdfSetting() {
  const card = document.getElementById('crm-dms-card'); if (!card) return;
  try {
    const d = await apiGetJson('/leads/crm-email');
    card.classList.toggle('hidden', !d.can_configure);
    const inp = document.getElementById('crm-adf-email'); if (inp) inp.value = d.crm_adf_email || '';
  } catch { /* leave as-is */ }
}
async function saveCrmAdfEmail(btn) {
  const inp = document.getElementById('crm-adf-email'), msg = document.getElementById('crm-adf-msg');
  const orig = btn.textContent; btn.disabled = true; btn.textContent = 'Saving…';
  try {
    const r = await fetch(`${API}/leads/crm-email`, { method: 'PUT', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ crm_adf_email: (inp?.value || '').trim() }) });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Failed');
    if (msg) { msg.textContent = '✓ Saved — leads now deliver to your CRM.'; msg.className = 'text-xs mt-2 text-emerald-600 dark:text-emerald-400'; msg.classList.remove('hidden'); }
  } catch (e) { if (msg) { msg.textContent = e.message; msg.className = 'text-xs mt-2 text-red-500'; msg.classList.remove('hidden'); } }
  finally { btn.disabled = false; btn.textContent = orig; }
}
window.saveCrmAdfEmail = saveCrmAdfEmail;
function openCrmContactModal() { crmOpenForm(null); }
let __crmTradeDecoded = null;   // decoded trade vehicle held while the form is open

// Searchable "new car of interest" picker over our own inventory (stock # first).
function crmInvLabel(v) {
  return `${v.stocknumber ? '#' + v.stocknumber + ' — ' : ''}${[v.year, v.make, v.model, v.trim].filter(Boolean).join(' ')}${v.price ? ' · $' + Number(v.price).toLocaleString() : ''}`;
}
function crmInterestSearch() {
  const box = document.getElementById('crm-interest-results');
  const qi = document.getElementById('crm-f-interest-q');
  const hid = document.getElementById('crm-f-interest');
  if (!box || !qi) return;
  const q = (qi.value || '').trim().toLowerCase();
  if (!q && hid) hid.value = '';   // cleared → unpin
  let items = (__crmInventory || []);
  if (q) {
    const match = (v) => {
      const stock = String(v.stocknumber || '').toLowerCase();
      const label = [v.year, v.make, v.model, v.trim].filter(Boolean).join(' ').toLowerCase();
      return stock.includes(q) || label.includes(q) || String(v.vin || '').toLowerCase().includes(q);
    };
    // Stock-number hits first (this is how a desk looks a car up).
    items = items.filter(match).sort((a, b) => {
      const as = String(a.stocknumber || '').toLowerCase().includes(q) ? 0 : 1;
      const bs = String(b.stocknumber || '').toLowerCase().includes(q) ? 0 : 1;
      return as - bs;
    });
  }
  items = items.slice(0, 30);
  if (!items.length) { box.innerHTML = '<div class="px-3 py-2 text-xs text-slate-400">No matching stock</div>'; box.classList.remove('hidden'); return; }
  box.innerHTML = items.map(v => `<button type="button" onmousedown="event.preventDefault()" onclick="crmPickInterest('${v.id}')" class="w-full text-left px-3 py-2 hover:bg-indigo-50 dark:hover:bg-indigo-950/30 text-sm flex justify-between gap-2 border-b border-slate-50 dark:border-slate-800 last:border-0">
    <span class="truncate">${v.stocknumber ? `<span class="font-bold text-indigo-600 dark:text-indigo-400">#${esc(v.stocknumber)}</span> ` : ''}${esc([v.year, v.make, v.model, v.trim].filter(Boolean).join(' '))}</span>
    ${v.price ? `<span class="text-slate-400 flex-shrink-0 tabular-nums">$${Number(v.price).toLocaleString()}</span>` : ''}
  </button>`).join('');
  box.classList.remove('hidden');
}
function crmPickInterest(id) {
  const v = (__crmInventory || []).find(x => x.id === id);
  if (!v) return;
  const hid = document.getElementById('crm-f-interest'); if (hid) hid.value = id;
  const qi = document.getElementById('crm-f-interest-q'); if (qi) qi.value = crmInvLabel(v);
  document.getElementById('crm-interest-results')?.classList.add('hidden');
}
async function crmOpenForm(id) {
  await crmEnsureLookups();
  let c = {};
  if (id) { try { c = (await apiGetJson(`/crm/contacts/${id}`)).contact || {}; } catch (e) { showToast(e.message, 'error'); return; } }
  __crmTradeDecoded = c.trade_vehicle || null;
  const inp = (id2, val, ph, cls = '') => `<input id="${id2}" value="${esc(val ?? '')}" placeholder="${esc(ph)}" class="${cls} bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded-lg px-3 py-2 text-sm">`;
  const lbl = (t) => `<label class="block text-[11px] font-semibold text-slate-500 dark:text-slate-400 mb-1">${t}</label>`;
  const repOpts = ['<option value="">— Unassigned —</option>'].concat((__crmReps || []).map(r => `<option value="${r.id}" ${c.assigned_rep === r.id ? 'selected' : ''}>${esc(r.name)}</option>`)).join('');
  const statusOpts = Object.entries(CRM_STATUS).map(([k, l]) => `<option value="${k}" ${(c.status || 'uncontacted') === k ? 'selected' : ''}>${l}</option>`).join('');
  const preInv = (__crmInventory || []).find(v => v.id === c.interest_inventory_id);
  const isCo = c.contact_type === 'company';
  const sect = (t) => `<div class="text-[11px] font-black uppercase tracking-wider text-indigo-500 pt-1">${t}</div>`;
  crmOverlay(`<div class="p-5 space-y-3">
    <div class="flex items-center justify-between">
      <div class="text-lg font-black text-slate-900 dark:text-white">${id ? 'Edit contact' : 'New contact'}</div>
      <button onclick="this.closest('.fixed').remove()" class="text-slate-400 hover:text-slate-600"><svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" d="M6 6l12 12M18 6L6 18"/></svg></button>
    </div>
    <div class="flex gap-2">
      <label class="flex-1"><input type="radio" name="crm-ctype" value="individual" ${!isCo ? 'checked' : ''} class="peer hidden" onchange="crmToggleCompany(false)"><span class="block text-center text-sm font-bold py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 peer-checked:bg-indigo-600 peer-checked:text-white peer-checked:border-indigo-600 cursor-pointer">Individual</span></label>
      <label class="flex-1"><input type="radio" name="crm-ctype" value="company" ${isCo ? 'checked' : ''} class="peer hidden" onchange="crmToggleCompany(true)"><span class="block text-center text-sm font-bold py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 peer-checked:bg-indigo-600 peer-checked:text-white peer-checked:border-indigo-600 cursor-pointer">Company</span></label>
    </div>
    <div id="crm-company-row" class="${isCo ? '' : 'hidden'}">${lbl('Company name')}${inp('crm-f-company', c.company_name, 'Company name', 'w-full')}</div>
    ${sect('Name')}
    <div class="grid grid-cols-2 gap-2">
      <div>${lbl('First name')}${inp('crm-f-first', c.first_name, 'First', 'w-full')}</div>
      <div>${lbl('Last name')}${inp('crm-f-last', c.last_name, 'Last', 'w-full')}</div>
      <div>${lbl('Middle name')}${inp('crm-f-middle', c.middle_name, 'Middle', 'w-full')}</div>
      <div>${lbl('Suffix')}${inp('crm-f-suffix', c.suffix, 'Jr, Sr, III', 'w-full')}</div>
    </div>
    ${sect('Contact')}
    <div>${lbl('Email')}${inp('crm-f-email', c.email, 'name@email.com', 'w-full')}</div>
    <div class="grid grid-cols-3 gap-2">
      <div>${lbl('Mobile #')}${inp('crm-f-mobile', c.phone_mobile || c.phone, 'Mobile', 'w-full')}</div>
      <div>${lbl('Home #')}${inp('crm-f-home', c.phone_home, 'Home', 'w-full')}</div>
      <div>${lbl('Work #')}${inp('crm-f-work', c.phone_work, 'Work', 'w-full')}</div>
    </div>
    ${sect('Address')}
    <div>${lbl('Street address')}${inp('crm-f-address', c.address, 'Street address', 'w-full')}</div>
    <div class="grid grid-cols-3 gap-2">
      <div>${lbl('City')}${inp('crm-f-city', c.city, 'City', 'w-full')}</div>
      <div>${lbl('Province / State')}${inp('crm-f-province', c.province, 'ON', 'w-full')}</div>
      <div>${lbl('Postal / ZIP')}${inp('crm-f-postal', c.postal_code, 'A1A 1A1', 'w-full')}</div>
    </div>
    ${sect('Identification')}
    <div class="grid grid-cols-3 gap-2">
      <div>${lbl('Birthday')}<input id="crm-f-birthday" type="date" value="${esc(c.birthday || '')}" class="w-full bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded-lg px-3 py-2 text-sm"></div>
      <div>${lbl("Driver's licence #")}${inp('crm-f-dl', c.dl_number, 'DL number', 'w-full')}</div>
      <div>${lbl('DL expiry')}<input id="crm-f-dlexp" type="date" value="${esc(c.dl_expiry || '')}" class="w-full bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded-lg px-3 py-2 text-sm"></div>
    </div>
    ${sect('Source & assignment')}
    <div class="grid grid-cols-3 gap-2">
      <div>${lbl('Source')}${inp('crm-f-source', c.source, 'e.g. Walk-in, Web', 'w-full')}</div>
      <div>${lbl('Salesperson')}<select id="crm-f-rep" class="w-full bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded-lg px-3 py-2 text-sm">${repOpts}</select></div>
      <div>${lbl('Status')}<select id="crm-f-status" class="w-full bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded-lg px-3 py-2 text-sm">${statusOpts}</select></div>
    </div>
    ${sect('Trade vehicle (decode from VIN)')}
    <div class="flex gap-2">
      ${inp('crm-f-tradevin', __crmTradeDecoded?.vin, '17-char VIN', 'flex-1 uppercase')}
      <button type="button" onclick="crmDecodeTrade()" class="text-xs font-bold bg-slate-200 dark:bg-slate-700 hover:bg-slate-300 dark:hover:bg-slate-600 text-slate-700 dark:text-slate-200 px-3 rounded-lg">Decode</button>
    </div>
    <div class="grid grid-cols-4 gap-2">
      ${inp('crm-f-tradeyear', __crmTradeDecoded?.year, 'Year')}${inp('crm-f-trademake', __crmTradeDecoded?.make, 'Make')}${inp('crm-f-trademodel', __crmTradeDecoded?.model, 'Model')}${inp('crm-f-tradetrim', __crmTradeDecoded?.trim, 'Trim')}
    </div>
    <div>${lbl('Trade mileage')}${inp('crm-f-trademiles', __crmTradeDecoded?.mileage, 'e.g. 85000', 'w-full')}</div>
    ${sect('New car of interest')}
    <div class="relative">
      <input id="crm-f-interest-q" value="${esc(preInv ? crmInvLabel(preInv) : '')}" placeholder="Search your stock — stock #, year, make, model…" autocomplete="off" oninput="crmInterestSearch()" onfocus="crmInterestSearch()" onblur="setTimeout(()=>document.getElementById('crm-interest-results')?.classList.add('hidden'),200)" class="w-full bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded-lg px-3 py-2 text-sm">
      <input type="hidden" id="crm-f-interest" value="${esc(c.interest_inventory_id || '')}">
      <div id="crm-interest-results" class="hidden absolute z-20 mt-1 w-full max-h-60 overflow-y-auto bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg shadow-xl"></div>
    </div>
    <div class="text-[11px] text-slate-400">Clear the box to remove the pinned vehicle.</div>
    ${sect('Notes')}
    <textarea id="crm-f-notes" rows="2" placeholder="Notes" class="w-full bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded-lg px-3 py-2 text-sm">${esc(c.notes || '')}</textarea>
    <div class="flex gap-2 justify-end pt-1"><button onclick="this.closest('.fixed').remove()" class="text-sm font-bold text-slate-500 px-4 py-2">Cancel</button>
      <button onclick="crmSaveContact(this, ${id ? `'${id}'` : 'null'})" class="text-sm font-bold bg-indigo-600 hover:bg-indigo-500 text-white px-4 py-2 rounded-lg">${id ? 'Save' : 'Create'}</button></div>
  </div>`, 'max-w-2xl');
}
function crmToggleCompany(isCo) { const r = document.getElementById('crm-company-row'); if (r) r.classList.toggle('hidden', !isCo); }
async function crmDecodeTrade() {
  const vin = (document.getElementById('crm-f-tradevin')?.value || '').trim().toUpperCase();
  if (vin.length !== 17) { showToast('Enter a 17-character VIN', 'error'); return; }
  try {
    const r = await fetch(`${API}/ai/vin-decode`, { method: 'POST', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ vin }) });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'Decode failed');
    const set = (id, v) => { const el = document.getElementById(id); if (el && v != null) el.value = v; };
    set('crm-f-tradeyear', d.year); set('crm-f-trademake', d.make); set('crm-f-trademodel', d.model); set('crm-f-tradetrim', d.trim);
    __crmTradeDecoded = { vin, ...d };
    showToast('VIN decoded', 'success');
  } catch (e) { showToast(e.message, 'error'); }
}
async function crmSaveContact(btn, id) {
  const val = (i) => (document.getElementById(i)?.value || '').trim();
  const ctype = document.querySelector('input[name="crm-ctype"]:checked')?.value || 'individual';
  const tradeVin = val('crm-f-tradevin');
  const trade = (tradeVin || val('crm-f-trademake')) ? {
    vin: tradeVin || null, year: val('crm-f-tradeyear') || null, make: val('crm-f-trademake') || null,
    model: val('crm-f-trademodel') || null, trim: val('crm-f-tradetrim') || null, mileage: val('crm-f-trademiles') || null,
  } : null;
  const body = {
    contact_type: ctype,
    company_name: val('crm-f-company'),
    first_name: val('crm-f-first'), last_name: val('crm-f-last'), middle_name: val('crm-f-middle'), suffix: val('crm-f-suffix'),
    email: val('crm-f-email'), phone_mobile: val('crm-f-mobile'), phone_home: val('crm-f-home'), phone_work: val('crm-f-work'),
    phone: val('crm-f-mobile'),
    address: val('crm-f-address'), city: val('crm-f-city'), province: val('crm-f-province'), postal_code: val('crm-f-postal'),
    birthday: val('crm-f-birthday') || null, dl_number: val('crm-f-dl'), dl_expiry: val('crm-f-dlexp') || null,
    source: val('crm-f-source'), assigned_rep: val('crm-f-rep') || null, status: val('crm-f-status') || 'uncontacted',
    trade_vehicle: trade, interest_inventory_id: val('crm-f-interest') || null,
    notes: val('crm-f-notes'),
  };
  const nameGiven = body.first_name || body.last_name || body.company_name;
  if (!nameGiven && !body.email && !body.phone) { showToast('Enter a name, phone, or email', 'error'); return; }
  try {
    const d = id ? await apiSendJson(`/crm/contacts/${id}`, 'PUT', body) : await apiSendJson('/crm/contacts', 'POST', body);
    btn.closest('.fixed').remove();
    showToast(id ? 'Saved' : 'Contact created', 'success');
    if (__crmTab === 'contacts') crmLoadContacts();
    const cid = id || d.contact?.id;
    if (cid) openCrmContact(cid);
  } catch (e) { showToast(e.message, 'error'); }
}

// ── Tasks tab ────────────────────────────────────────────────────────────────
async function crmLoadTasks() {
  const body = document.getElementById('crm-body');
  if (!body) return;
  body.innerHTML = `<div id="crm-tasklist" class="py-10 text-center text-sm text-slate-400 italic">Loading tasks…</div>`;
  try {
    const d = await apiGetJson('/crm/tasks?scope=open');
    const tasks = d.tasks || [];
    const el = document.getElementById('crm-tasklist');
    if (!el) return;   // user navigated away mid-fetch
    if (!tasks.length) { el.className = ''; el.innerHTML = '<div class="py-16 text-center text-sm text-slate-400">No open tasks. Add follow-ups from a contact.</div>'; return; }
    el.className = '';
    el.innerHTML = `<div class="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl divide-y divide-slate-100 dark:divide-slate-800">
      ${tasks.map(t => {
        const overdue = t.due_at && new Date(t.due_at) < Date.now();
        return `<div class="flex items-center gap-3 px-4 py-3">
          <input type="checkbox" onchange="crmToggleTask('${t.id}', this.checked)" class="w-4 h-4 rounded accent-indigo-600 flex-shrink-0">
          <div class="min-w-0 flex-1">
            <div class="font-semibold text-sm text-slate-800 dark:text-slate-100 truncate">${esc(t.title)}</div>
            <div class="text-xs text-slate-400">${t.contact_name ? `<button onclick="openCrmContact('${t.contact_id}')" class="text-indigo-500 hover:underline">${esc(t.contact_name)}</button> · ` : ''}${esc((t.type || 'followup'))}</div>
          </div>
          ${t.due_at ? `<span class="text-[11px] flex-shrink-0 ${overdue ? 'text-rose-500 font-bold' : 'text-slate-400'}">${esc(crmWhen(t.due_at))}</span>` : ''}
        </div>`;
      }).join('')}</div>`;
  } catch (e) {
    const el = document.getElementById('crm-tasklist');
    if (el) el.innerHTML = `<div class="py-16 text-center text-sm text-slate-500">Couldn't load tasks: ${esc(e.message)}<br><button onclick="crmLoadTasks()" class="mt-3 text-indigo-500 font-bold">Retry</button></div>`;
  }
}

// ── Leads (CRM ADF delivery) ─────────────────────────────────────────────────
async function loadLeadsPage() {
  const root = document.getElementById('leads-root');
  if (!root) return;
  root.innerHTML = `<div class="py-16 text-center text-sm text-slate-400 italic">Loading leads…</div>`;
  let data, inv = [];
  try {
    data = await apiGetJson('/leads', { onRetry: (n, total) => {
      root.innerHTML = `<div class="py-16 text-center text-sm text-slate-400 italic">Still loading… retrying (${n}/${total})</div>`;
    }});
    try { inv = (await apiGetJson('/inventory/all', { retries: 1 })).filter(v => String(v.status || 'available').toLowerCase() === 'available'); } catch {}
  } catch (e) {
    root.innerHTML = `<div class="py-16 text-center text-sm text-slate-500">Couldn't load leads: ${esc(e.message)}<br><button onclick="loadLeadsPage()" class="mt-3 text-indigo-500 hover:text-indigo-400 font-bold">Retry</button></div>`;
    return;
  }

  const vehOpts = inv.slice(0, 500).map(v => `<option value="${v.id}">${esc([v.year, v.make, v.model, v.trim].filter(Boolean).join(' '))}${v.stocknumber ? ' · #' + esc(v.stocknumber) : ''}</option>`).join('');
  const crmSet = !!data.crm_adf_email;

  const statusPill = (l) => {
    if (l.adf_sent_at) return `<span class="text-[10px] font-bold uppercase px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300">Sent to CRM</span>`;
    if (l.adf_error) return `<span class="text-[10px] font-bold uppercase px-1.5 py-0.5 rounded bg-red-100 text-red-700 dark:bg-red-950/50 dark:text-red-300" title="${esc(l.adf_error)}">Failed</span>`;
    return `<span class="text-[10px] font-bold uppercase px-1.5 py-0.5 rounded bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400">Not delivered</span>`;
  };
  const rows = (data.leads || []).map(l => `
    <tr class="border-b border-slate-100 dark:border-slate-800/60">
      <td class="py-3 px-3"><div class="font-semibold text-slate-900 dark:text-white">${esc(l.name || '—')}</div><div class="text-xs text-slate-400">${esc(l.source || '')}${l.rep ? ' · ' + esc(l.rep) : ''}</div></td>
      <td class="py-3 px-3 text-slate-600 dark:text-slate-300">${esc(l.phone || '')}${l.phone && l.email ? '<br>' : ''}${esc(l.email || '')}</td>
      <td class="py-3 px-3 text-slate-500 dark:text-slate-400 max-w-[220px]">${esc(l.comments || '')}</td>
      <td class="py-3 px-3">${statusPill(l)}</td>
      <td class="py-3 px-3 text-right whitespace-nowrap">
        <button class="lead-ai-reply text-violet-600 hover:text-violet-500 text-xs font-bold" data-id="${l.id}">✦ Draft reply</button>
        ${!l.adf_sent_at && crmSet ? `<button class="lead-resend text-indigo-500 hover:text-indigo-400 text-xs font-bold ml-3" data-id="${l.id}">Send to CRM</button>` : ''}
      </td>
    </tr>`).join('') || '<tr><td colspan="5" class="py-8 text-center text-sm text-slate-400 italic">No leads yet.</td></tr>';

  root.innerHTML = `
    <div class="mb-5">
      <h2 class="text-xl font-bold text-slate-900 dark:text-white">Leads</h2>
      <p class="text-sm text-slate-500 dark:text-slate-400 mt-1">Log buyer leads — they're delivered to your CRM automatically as an ADF email.</p>
    </div>

    ${!crmSet ? `<div class="bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-lg px-4 py-3 text-sm text-amber-700 dark:text-amber-300">No CRM/DMS connection set yet — leads are still saved here, and will send once ${data.can_configure ? 'you add it in <b>Settings → CRM / DMS connection</b>' : 'your admin adds it in Settings'}.</div>` : ''}

    <div class="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5">
      <h3 class="text-sm font-bold text-slate-900 dark:text-white mb-3">Log a lead</h3>
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <input id="lead-name" placeholder="Buyer name" class="bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded-lg px-3 py-2 text-sm">
        <input id="lead-phone" placeholder="Phone" class="bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded-lg px-3 py-2 text-sm">
        <input id="lead-email" type="email" placeholder="Email" class="bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded-lg px-3 py-2 text-sm">
        <select id="lead-vehicle" class="bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded-lg px-3 py-2 text-sm"><option value="">Vehicle of interest (optional)</option>${vehOpts}</select>
      </div>
      <textarea id="lead-comments" rows="2" placeholder="Notes / what they asked about" class="w-full mt-3 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded-lg px-3 py-2 text-sm"></textarea>
      <div class="flex items-center gap-3 mt-3">
        <button id="lead-save" class="bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-bold px-5 py-2 rounded-lg transition">Save lead${crmSet ? ' & send to CRM' : ''}</button>
        <span id="lead-msg" class="hidden text-xs"></span>
      </div>
    </div>

    <div class="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
      <div class="overflow-x-auto"><table class="w-full text-sm text-left min-w-[640px]">
        <thead><tr class="border-b border-slate-200 dark:border-slate-800 text-slate-500 dark:text-slate-400 uppercase text-xs tracking-wider">
          <th class="py-3 px-3">Buyer</th><th class="py-3 px-3">Contact</th><th class="py-3 px-3">Notes</th><th class="py-3 px-3">CRM</th><th class="py-3 px-3 text-right">Action</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
    </div>`;

  document.getElementById('lead-save')?.addEventListener('click', async () => {
    const btn = document.getElementById('lead-save'); const msg = document.getElementById('lead-msg');
    btn.disabled = true;
    try {
      const r = await fetch(`${API}/leads`, { method: 'POST', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({
        name: document.getElementById('lead-name').value.trim(),
        phone: document.getElementById('lead-phone').value.trim(),
        email: document.getElementById('lead-email').value.trim(),
        inventory_id: document.getElementById('lead-vehicle').value || null,
        comments: document.getElementById('lead-comments').value.trim(),
      }) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Failed');
      msg.textContent = d.delivered ? '✓ Saved & sent to CRM' : (d.crm_configured ? 'Saved (CRM send failed — check address)' : 'Saved (set your CRM email to auto-send)');
      msg.className = 'text-xs ' + (d.delivered ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400');
      msg.classList.remove('hidden');
      loadLeadsPage();
    } catch (e) { msg.textContent = e.message; msg.className = 'text-xs text-red-500'; msg.classList.remove('hidden'); btn.disabled = false; }
  });

  root.querySelectorAll('.lead-resend').forEach(b => b.addEventListener('click', async () => {
    b.disabled = true; b.textContent = 'Sending…';
    try {
      const r = await fetch(`${API}/leads/${b.dataset.id}/resend`, { method: 'POST', headers: { 'Authorization': `Bearer ${token}` } });
      if (!r.ok) throw new Error((await r.json()).error || 'Failed');
      loadLeadsPage();
    } catch (e) { alert(e.message); b.disabled = false; b.textContent = 'Send to CRM'; }
  }));

  root.querySelectorAll('.lead-ai-reply').forEach(b => b.addEventListener('click', () => openLeadReply(b.dataset.id)));
}

// AI reply draft for a Marketplace lead (AI Boost). Non-subscribers → upgrade modal.
async function openLeadReply(leadId) {
  if (!__aiBoostActive) { openUpgradeModal('ai_boost'); return; }
  const modal = document.createElement('div');
  modal.className = 'fixed inset-0 z-[60] bg-black/70 flex items-start justify-center p-4 overflow-y-auto';
  modal.innerHTML = `<div class="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl w-full max-w-lg mt-16 p-6 shadow-2xl">
    <div class="flex items-center justify-between mb-3">
      <h3 class="text-base font-bold text-slate-900 dark:text-white flex items-center gap-1.5">
        <svg viewBox="0 0 24 24" width="15" height="15" class="flex-shrink-0" aria-hidden="true"><path d="M12 2.5l2.4 6.6 6.6 2.4-6.6 2.4L12 20.5l-2.4-6.6L3 11.5l6.6-2.4z" fill="#c4b5fd" fill-opacity="0.5" stroke="#6d28d9" stroke-width="1.4" stroke-linejoin="round"/></svg>
        AI reply draft
      </h3>
      <button data-x class="text-slate-400 hover:text-slate-700 dark:hover:text-white text-2xl leading-none">&times;</button>
    </div>
    <div data-body class="text-sm text-slate-500 dark:text-slate-400 py-10 text-center italic">Drafting a reply…</div>
  </div>`;
  document.body.appendChild(modal);
  const close = () => modal.remove();
  modal.addEventListener('click', e => { if (e.target === modal || e.target.closest('[data-x]')) close(); });
  const body = modal.querySelector('[data-body]');
  try {
    const r = await fetch(`${API}/ai/lead-reply`, {
      method: 'POST', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ lead_id: leadId }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Failed to draft reply');
    body.className = 'space-y-3';
    body.innerHTML = `
      ${data.vehicle_label ? `<div class="text-xs text-slate-400">Re: ${esc(data.vehicle_label)}</div>` : ''}
      <textarea id="lead-reply-text" rows="7" class="w-full bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-900 dark:text-white">${esc(data.draft)}</textarea>
      <div class="flex gap-2">
        <button id="lead-reply-copy" class="flex-1 bg-violet-600 hover:bg-violet-500 text-white text-sm font-bold px-4 py-2 rounded-lg transition">Copy reply</button>
        <button data-x class="px-4 py-2 text-sm font-bold text-slate-500 hover:text-slate-700 dark:hover:text-slate-200">Close</button>
      </div>
      <p class="text-[11px] text-slate-400">Review before sending — AI can miss details. Paste into your Marketplace chat.</p>`;
    modal.querySelector('#lead-reply-copy')?.addEventListener('click', () => {
      const t = modal.querySelector('#lead-reply-text');
      t.select();
      (navigator.clipboard?.writeText(t.value) || Promise.reject()).then(() => showToast('Reply copied', 'success')).catch(() => { try { document.execCommand('copy'); showToast('Reply copied', 'success'); } catch {} });
    });
  } catch (e) {
    body.className = 'py-8 text-center text-sm text-red-500';
    body.textContent = e.message;
  }
}

// Mobile "all pages" sheet — lists every nav page the user can access.
function setupMobileMoreMenu() {
  const btn = document.getElementById('nav-more');
  const menu = document.getElementById('nav-more-menu');
  const list = document.getElementById('nav-more-list');
  if (!btn || !menu || !list) return;
  const close = () => menu.classList.add('hidden');

  btn.addEventListener('click', () => {
    // Rebuild each open so it reflects the user's current role/add-on access.
    // Include every nav button that isn't role-hidden (Tailwind `hidden` class).
    const navBtns = [...document.querySelectorAll('#dashboard-nav button[title]')]
      .filter(b => b.id !== 'nav-more' && !b.classList.contains('hidden'));
    list.innerHTML = '';
    navBtns.forEach(src => {
      const label = src.getAttribute('title') || '';
      const svg = src.querySelector('svg')?.outerHTML || '';
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'flex items-center gap-2.5 px-3 py-3 rounded-lg text-sm font-medium text-slate-700 dark:text-slate-200 bg-slate-50 dark:bg-slate-800/60 hover:bg-slate-100 dark:hover:bg-slate-800 transition text-left';
      item.innerHTML = `<span class="w-5 h-5 flex-shrink-0 opacity-70">${svg}</span><span class="truncate">${label}</span>`;
      item.addEventListener('click', () => { close(); src.click(); });
      list.appendChild(item);
    });
    menu.classList.remove('hidden');
  });

  document.getElementById('nav-more-close')?.addEventListener('click', close);
  menu.addEventListener('click', (e) => { if (e.target === menu) close(); });
}

// ── Sales Pipeline (integrated page) ─────────────────────────────────────────
const PL_COLS = [
  { key: 'posted', label: 'Posted', dot: 'bg-blue-500' },
  { key: 'appointment_set', label: 'Appointment Set', dot: 'bg-indigo-500' },
  { key: 'claimed_sale', label: 'Claimed Sales', dot: 'bg-emerald-500' },
  { key: 'need_relisting', label: 'Need Relisting', dot: 'bg-amber-500' },
];
const PL_MOVE_LABEL = { posted: 'Posted', appointment_set: 'Appointment Set', claimed_sale: 'Mark Sold', need_relisting: 'Need Relisting' };
let PL_DATA = { columns: {}, counts: {} };
// Cards the user has collapsed (kept across re-renders so a move/refresh doesn't
// re-expand everything). Board-wide collapse toggles every card at once.
const PL_COLLAPSED = new Set();
// Whether we've applied the default "all collapsed" state on first render yet.
let PL_COLLAPSED_INITED = false;
const plMoney = (n) => n != null ? '$' + Number(n).toLocaleString() : '';
const plKm = (n) => n != null ? Number(n).toLocaleString() + ' km' : '';
const plPosted = (d) => { try { const days = Math.floor((Date.now() - new Date(d)) / 86400000); return days <= 0 ? 'today' : days + 'd ago'; } catch { return ''; } };
const plAppt = (d) => { try { return new Date(d).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); } catch { return ''; } };

function plAskAppointment(label, existingAt, existingNote) {
  return new Promise(resolve => {
    const modal = document.getElementById('appt-modal');
    const dt = document.getElementById('appt-dt'), note = document.getElementById('appt-note'), err = document.getElementById('appt-err');
    document.getElementById('appt-veh').textContent = label || '';
    err.classList.add('hidden');
    const base = existingAt ? new Date(existingAt) : new Date(Date.now() + 3600000);
    dt.value = new Date(base.getTime() - base.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    note.value = existingNote || '';
    modal.classList.remove('hidden');
    const close = (val) => { modal.classList.add('hidden'); document.getElementById('appt-save').onclick = null; document.getElementById('appt-cancel').onclick = null; resolve(val); };
    document.getElementById('appt-cancel').onclick = () => close(null);
    document.getElementById('appt-save').onclick = () => {
      if (!dt.value) { err.textContent = 'Pick a date and time.'; err.classList.remove('hidden'); return; }
      close({ at: new Date(dt.value).toISOString(), note: note.value.trim() });
    };
  });
}

function plCard(c) {
  const others = PL_COLS.map(x => x.key).filter(k => k !== c.stage);
  const opts = others.map(k => `<option value="${k}">${PL_MOVE_LABEL[k]}</option>`).join('');
  const rep = c.rep ? ` · ${esc(c.rep)}` : '';
  const sub = [c.trim, c.exterior_color].filter(Boolean).join(' · ');
  const meta = [c.stocknumber ? '#' + esc(c.stocknumber) : '', c.mileage ? plKm(c.mileage) : ''].filter(Boolean).join(' · ');
  const thumb = c.image
    ? `<img src="${esc(c.image)}" alt="" loading="lazy" class="w-full h-24 object-cover rounded-md bg-slate-100 dark:bg-slate-800">`
    : `<div class="w-full h-24 rounded-md bg-slate-100 dark:bg-slate-800 flex items-center justify-center text-slate-300 text-2xl">🚗</div>`;
  const postedTag = `<span class="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300">Posted</span>`;
  const collapsed = PL_COLLAPSED.has(c.id);
  const chevron = `<button data-collapse="${c.id}" class="flex-shrink-0 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 transition p-0.5" title="${collapsed ? 'Expand' : 'Collapse'}"><svg class="w-4 h-4 transition-transform ${collapsed ? '' : 'rotate-90'}" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7"/></svg></button>`;
  return `
    <div class="pl-card group bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-3 cursor-grab active:cursor-grabbing" draggable="true" data-card-id="${c.id}" data-card-label="${esc(c.label)}" data-card-stage="${c.stage}">
      <div class="flex items-start gap-1.5">
        ${chevron}
        <div class="min-w-0 flex-1">
          <div class="text-sm font-bold text-slate-900 dark:text-white leading-snug truncate">${esc(c.label)}</div>
          ${collapsed && c.price ? `<div class="text-xs font-black text-slate-700 dark:text-slate-200 mt-0.5">${plMoney(c.price)}</div>` : ''}
        </div>
      </div>
      <div class="pl-body ${collapsed ? 'hidden' : ''}">
      ${thumb}
      <div class="mt-2 min-w-0">
        ${sub ? `<div class="text-[11px] text-slate-500 dark:text-slate-400 truncate">${esc(sub)}</div>` : ''}
      </div>
      <div class="flex items-center justify-between gap-2 mt-1.5">
        ${postedTag}
        ${c.price ? `<span class="text-sm font-black text-slate-900 dark:text-white">${plMoney(c.price)}</span>` : ''}
      </div>
      ${meta ? `<div class="text-[11px] text-slate-400 mt-1">${meta}</div>` : ''}
      <div class="text-[11px] text-slate-400 mt-0.5">${c.posted_at ? 'Posted ' + plPosted(c.posted_at) : ''}${rep}</div>
      ${c.stage === 'appointment_set' && c.appointment_at ? `
        <div class="mt-2 flex items-center justify-between gap-2 text-xs bg-indigo-50 dark:bg-indigo-950/40 border border-indigo-200 dark:border-indigo-800 rounded px-2 py-1.5">
          <span class="font-semibold text-indigo-700 dark:text-indigo-300">📅 ${esc(plAppt(c.appointment_at))}</span>
          <button data-appt-edit="${c.id}" data-label="${esc(c.label)}" data-at="${esc(c.appointment_at)}" data-note="${esc(c.appointment_note || '')}" class="text-indigo-500 hover:text-indigo-400 font-bold">Edit</button>
        </div>${c.appointment_note ? `<div class="text-[11px] text-slate-400 mt-1">${esc(c.appointment_note)}</div>` : ''}` : ''}
      ${c.stage === 'need_relisting' ? `<button data-relist="${c.id}" class="mt-2 w-full text-xs font-bold bg-amber-500 hover:bg-amber-400 text-white rounded px-2 py-1.5 transition">↻ Relist on Facebook</button>` : ''}
      ${(c.fb_listing_url || c.source_url) ? `
        <div class="mt-2 grid ${c.fb_listing_url && c.source_url ? 'grid-cols-2' : 'grid-cols-1'} gap-1.5">
          ${c.fb_listing_url ? `<a href="${esc(c.fb_listing_url)}" target="_blank" rel="noopener" class="text-center text-xs font-bold px-2 py-1.5 rounded bg-[#1877F2]/10 text-[#1877F2] hover:bg-[#1877F2]/20 transition">Facebook ↗</a>` : ''}
          ${c.source_url ? `<a href="${esc(c.source_url)}" target="_blank" rel="noopener" class="text-center text-xs font-bold px-2 py-1.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700 transition">Listing ↗</a>` : ''}
        </div>` : ''}
      <select data-move="${c.id}" class="mt-2 w-full text-xs bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded px-2 py-1 text-slate-600 dark:text-slate-300">
        <option value="">Move to…</option>${opts}
      </select>
      </div>
    </div>`;
}

async function plMoveCard(id, stage, label) {
  const body = { stage };
  if (stage === 'appointment_set') {
    const appt = await plAskAppointment(label, null, null);
    if (!appt) return false;
    body.appointment_at = appt.at; body.appointment_note = appt.note;
  }
  const r = await fetch(`${API}/pipeline/${id}`, { method: 'PATCH', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error((await r.json()).error || 'Failed');
  return true;
}

function plRender() {
  const root = document.getElementById('pipeline-root');
  if (!root) return;
  const allCardIds = Object.values(PL_DATA.columns || {}).flat().map(c => c.id);
  // Start every card collapsed on first load — the user opens the ones they want.
  // Only done once so a later move/refresh doesn't re-collapse cards they opened.
  if (!PL_COLLAPSED_INITED && allCardIds.length > 0) {
    allCardIds.forEach(id => PL_COLLAPSED.add(id));
    PL_COLLAPSED_INITED = true;
  }
  const allCollapsed = allCardIds.length > 0 && allCardIds.every(id => PL_COLLAPSED.has(id));
  const cols = PL_COLS.map(col => {
    const cards = (PL_DATA.columns[col.key] || []);
    const bodyHtml = cards.length ? cards.map(plCard).join('') : '<div class="text-xs text-slate-400 italic py-6 text-center">Nothing here</div>';
    return `
      <div class="flex flex-col min-w-0">
        <div class="flex items-center justify-between mb-3 px-1">
          <div class="flex items-center gap-2 text-sm font-bold text-slate-700 dark:text-slate-200"><span class="w-2 h-2 rounded-full ${col.dot}"></span>${col.label}</div>
          <span class="text-xs font-bold text-slate-400 bg-slate-100 dark:bg-slate-800 rounded-full px-2 py-0.5">${PL_DATA.counts[col.key] || 0}</span>
        </div>
        <div class="pl-dropzone space-y-2.5 flex-1 rounded-lg p-1 -m-1 transition" data-col="${col.key}">${bodyHtml}</div>
      </div>`;
  }).join('');

  root.innerHTML = `
    <div class="flex items-center justify-between mb-6 flex-wrap gap-3">
      <div>
        <h2 class="text-xl font-bold text-slate-900 dark:text-white">Sales Pipeline</h2>
        <p class="text-sm text-slate-500 dark:text-slate-400 mt-1">${PL_DATA.can_manage_all ? 'Every posting across your store' : 'Your postings'} — move each one as the deal progresses.</p>
      </div>
      <div class="flex items-center gap-2">
        <button id="pl-collapse-all" class="text-sm font-bold px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-600 hover:bg-slate-100 dark:hover:bg-slate-800 transition">${allCollapsed ? 'Expand all' : 'Collapse all'}</button>
        <button id="pl-refresh" class="text-sm font-bold px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-600 hover:bg-slate-100 dark:hover:bg-slate-800 transition">Refresh</button>
      </div>
    </div>
    <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-5">${cols}</div>`;

  document.getElementById('pl-refresh').addEventListener('click', loadPipelinePage);
  // Collapse / expand toggles (kept client-side; no reload needed).
  root.querySelectorAll('[data-collapse]').forEach(btn => btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const id = btn.dataset.collapse;
    if (PL_COLLAPSED.has(id)) PL_COLLAPSED.delete(id); else PL_COLLAPSED.add(id);
    plRender();
  }));
  document.getElementById('pl-collapse-all').addEventListener('click', () => {
    const allIds = Object.values(PL_DATA.columns || {}).flat().map(c => c.id);
    if (allIds.every(id => PL_COLLAPSED.has(id))) allIds.forEach(id => PL_COLLAPSED.delete(id));
    else allIds.forEach(id => PL_COLLAPSED.add(id));
    plRender();
  });
  root.querySelectorAll('[data-relist]').forEach(btn => btn.addEventListener('click', async () => {
    btn.disabled = true; btn.textContent = 'Relisting…';
    try {
      const r = await fetch(`${API}/pipeline/${btn.dataset.relist}/relist`, { method: 'POST', headers: { 'Authorization': `Bearer ${token}` } });
      if (!r.ok) throw new Error((await r.json()).error || 'Failed');
      window.open('https://www.facebook.com/marketplace/create/vehicle', '_blank', 'noopener');
      loadPipelinePage();
    } catch (e) { alert(e.message); btn.disabled = false; btn.textContent = '↻ Relist on Facebook'; }
  }));
  root.querySelectorAll('[data-appt-edit]').forEach(btn => btn.addEventListener('click', async () => {
    const appt = await plAskAppointment(btn.dataset.label, btn.dataset.at, btn.dataset.note);
    if (!appt) return;
    try {
      const r = await fetch(`${API}/pipeline/${btn.dataset.apptEdit}`, { method: 'PATCH', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ stage: 'appointment_set', appointment_at: appt.at, appointment_note: appt.note }) });
      if (!r.ok) throw new Error((await r.json()).error || 'Failed');
      loadPipelinePage();
    } catch (e) { alert(e.message); }
  }));
  root.querySelectorAll('[data-move]').forEach(sel => sel.addEventListener('change', async () => {
    const stage = sel.value; if (!stage) return;
    const label = sel.closest('[data-card-label]')?.dataset.cardLabel;
    sel.disabled = true;
    try { const ok = await plMoveCard(sel.dataset.move, stage, label); if (ok) loadPipelinePage(); else { sel.disabled = false; sel.value = ''; } }
    catch (e) { alert(e.message); sel.disabled = false; sel.value = ''; }
  }));

  let dragId = null, dragStage = null, dragLabel = null;
  root.querySelectorAll('.pl-card').forEach(el => {
    el.addEventListener('dragstart', e => { dragId = el.dataset.cardId; dragStage = el.dataset.cardStage; dragLabel = el.dataset.cardLabel; el.classList.add('opacity-40'); e.dataTransfer.effectAllowed = 'move'; });
    el.addEventListener('dragend', () => el.classList.remove('opacity-40'));
  });
  root.querySelectorAll('.pl-dropzone').forEach(zone => {
    zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('bg-indigo-50', 'dark:bg-indigo-950/30'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('bg-indigo-50', 'dark:bg-indigo-950/30'));
    zone.addEventListener('drop', async e => {
      e.preventDefault(); zone.classList.remove('bg-indigo-50', 'dark:bg-indigo-950/30');
      const target = zone.dataset.col;
      if (!dragId || target === dragStage) return;
      try { const ok = await plMoveCard(dragId, target, dragLabel); if (ok) loadPipelinePage(); } catch (err) { alert(err.message); }
    });
  });
}

async function loadPipelinePage() {
  const root = document.getElementById('pipeline-root');
  if (!root) return;
  root.innerHTML = `<div class="py-16 text-center text-sm text-slate-400 italic">Loading pipeline…</div>`;
  try {
    PL_DATA = await apiGetJson('/pipeline', { onRetry: (n, total) => {
      root.innerHTML = `<div class="py-16 text-center text-sm text-slate-400 italic">Still loading… retrying (${n}/${total})</div>`;
    }});
    plRender();
  } catch (e) {
    root.innerHTML = `<div class="py-16 text-center text-sm text-slate-500">Couldn't load the pipeline: ${esc(e.message)}<br><button onclick="loadPipelinePage()" class="mt-3 text-indigo-500 hover:text-indigo-400 font-bold">Retry</button></div>`;
  }
  // Leads live on the same page now — load them alongside the board.
  if (document.getElementById('leads-root')) loadLeadsPage();
}

// ── Appointments — month calendar with clickable detail modal ────────────────
let __apptData = [];            // all appointments from the API
let __apptCanManageAll = false;
let __apptMonth = new Date();   // the month currently displayed (day ignored)
const __apptDayKey = (d) => { const x = new Date(d); return `${x.getFullYear()}-${x.getMonth()}-${x.getDate()}`; };

async function loadAppointmentsPage() {
  const root = document.getElementById('appointments-root');
  if (!root) return;
  root.innerHTML = `<div class="py-16 text-center text-sm text-slate-400 italic">Loading appointments…</div>`;
  let data;
  try {
    data = await apiGetJson('/appointments', { onRetry: (n, total) => {
      root.innerHTML = `<div class="py-16 text-center text-sm text-slate-400 italic">Still loading… retrying (${n}/${total})</div>`;
    }});
  } catch (e) {
    root.innerHTML = `<div class="py-16 text-center text-sm text-slate-500">Couldn't load appointments: ${esc(e.message)}<br><button onclick="loadAppointmentsPage()" class="mt-3 text-indigo-500 hover:text-indigo-400 font-bold">Retry</button></div>`;
    return;
  }
  __apptData = data.appointments || [];
  __apptCanManageAll = !!data.can_manage_all;
  // Jump to the month of the soonest upcoming appointment on first load.
  const nextUp = __apptData.find(a => !a.past) || __apptData[0];
  __apptMonth = nextUp ? new Date(nextUp.appointment_at) : new Date();
  renderApptCalendar();
}

function renderApptCalendar() {
  const root = document.getElementById('appointments-root');
  if (!root) return;

  // Group appointments by local day-key.
  const byDay = {};
  __apptData.forEach((a, idx) => {
    const k = __apptDayKey(a.appointment_at);
    (byDay[k] = byDay[k] || []).push({ ...a, _idx: idx });
  });

  const view = new Date(__apptMonth.getFullYear(), __apptMonth.getMonth(), 1);
  const monthName = view.toLocaleString(undefined, { month: 'long', year: 'numeric' });
  const firstDow = view.getDay();                         // 0=Sun
  const daysInMonth = new Date(view.getFullYear(), view.getMonth() + 1, 0).getDate();
  const todayKey = __apptDayKey(new Date());

  const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const cells = [];
  for (let i = 0; i < firstDow; i++) cells.push('<div class="bg-slate-50/60 dark:bg-slate-900/40 min-h-[92px]"></div>');
  for (let day = 1; day <= daysInMonth; day++) {
    const k = `${view.getFullYear()}-${view.getMonth()}-${day}`;
    const items = (byDay[k] || []).sort((a, b) => new Date(a.appointment_at) - new Date(b.appointment_at));
    const isToday = k === todayKey;
    const chips = items.slice(0, 3).map(a => {
      const t = new Date(a.appointment_at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
      const cls = a.past
        ? 'bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400'
        : 'bg-indigo-100 dark:bg-indigo-950/60 text-indigo-700 dark:text-indigo-300 hover:bg-indigo-200 dark:hover:bg-indigo-900';
      return `<button data-appt-idx="${a._idx}" class="w-full text-left truncate text-[10px] font-semibold px-1.5 py-1 rounded ${cls} transition" title="${esc(t + ' · ' + a.label)}">${esc(t)} ${esc(a.label)}</button>`;
    }).join('');
    const more = items.length > 3 ? `<div class="text-[10px] text-slate-400 px-1.5">+${items.length - 3} more</div>` : '';
    cells.push(`
      <div class="bg-white dark:bg-slate-900 min-h-[92px] p-1.5 flex flex-col gap-1 ${isToday ? 'ring-2 ring-inset ring-indigo-400' : ''}">
        <div class="text-[11px] font-bold ${isToday ? 'text-indigo-600 dark:text-indigo-400' : 'text-slate-400'}">${day}</div>
        ${chips}${more}
      </div>`);
  }
  // Pad the final week so the grid stays rectangular.
  while (cells.length % 7 !== 0) cells.push('<div class="bg-slate-50/60 dark:bg-slate-900/40 min-h-[92px]"></div>');

  root.innerHTML = `
    <div class="mb-4 flex items-center justify-between flex-wrap gap-3">
      <div>
        <h2 class="text-xl font-bold text-slate-900 dark:text-white">Appointments</h2>
        <p class="text-sm text-slate-500 dark:text-slate-400 mt-0.5">${__apptCanManageAll ? 'Every appointment your reps have booked' : 'Your booked appointments'} — tap one for details.</p>
      </div>
      <div class="flex items-center gap-1.5">
        <button id="appt-prev" class="w-8 h-8 flex items-center justify-center rounded-lg border border-slate-300 dark:border-slate-600 hover:bg-slate-100 dark:hover:bg-slate-800 transition" title="Previous month"><svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M15 19l-7-7 7-7"/></svg></button>
        <div class="text-sm font-bold text-slate-800 dark:text-slate-200 min-w-[140px] text-center">${monthName}</div>
        <button id="appt-next" class="w-8 h-8 flex items-center justify-center rounded-lg border border-slate-300 dark:border-slate-600 hover:bg-slate-100 dark:hover:bg-slate-800 transition" title="Next month"><svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7"/></svg></button>
        <button id="appt-today" class="text-xs font-bold px-3 h-8 rounded-lg border border-slate-300 dark:border-slate-600 hover:bg-slate-100 dark:hover:bg-slate-800 transition">Today</button>
      </div>
    </div>
    <div class="grid grid-cols-7 gap-px bg-slate-200 dark:bg-slate-800 rounded-xl overflow-hidden border border-slate-200 dark:border-slate-800">
      ${dow.map(d => `<div class="bg-slate-50 dark:bg-slate-950 text-center text-[10px] font-bold uppercase tracking-wider text-slate-400 py-2">${d}</div>`).join('')}
      ${cells.join('')}
    </div>
    ${__apptData.length === 0 ? `<div class="py-10 text-center text-sm text-slate-400 italic">No appointments yet. Reps book these by moving a vehicle into “Appointment Set” on the pipeline.</div>` : ''}`;

  document.getElementById('appt-prev')?.addEventListener('click', () => { __apptMonth = new Date(view.getFullYear(), view.getMonth() - 1, 1); renderApptCalendar(); });
  document.getElementById('appt-next')?.addEventListener('click', () => { __apptMonth = new Date(view.getFullYear(), view.getMonth() + 1, 1); renderApptCalendar(); });
  document.getElementById('appt-today')?.addEventListener('click', () => { __apptMonth = new Date(); renderApptCalendar(); });
  root.querySelectorAll('[data-appt-idx]').forEach(btn => {
    btn.addEventListener('click', () => openApptDetail(__apptData[Number(btn.dataset.apptIdx)]));
  });
}

function openApptDetail(a) {
  if (!a) return;
  let modal = document.getElementById('appt-detail-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'appt-detail-modal';
    modal.className = 'fixed inset-0 z-50 bg-black/70 flex items-start justify-center p-4 overflow-y-auto';
    document.body.appendChild(modal);
    modal.addEventListener('click', e => { if (e.target === modal) modal.classList.add('hidden'); });
  }
  modal.classList.remove('hidden');

  const money = n => n != null ? '$' + Number(n).toLocaleString() : null;
  const when = new Date(a.appointment_at).toLocaleString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  const specs = [
    a.trim ? esc(a.trim) : null,
    a.exterior_color ? esc(a.exterior_color) : null,
    a.mileage != null ? Number(a.mileage).toLocaleString() + ' km' : null,
    a.condition ? esc(a.condition) : null,
  ].filter(Boolean).join(' · ');

  modal.innerHTML = `
    <div class="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl w-full max-w-md mt-12 mb-12 overflow-hidden shadow-2xl">
      <div class="flex items-center justify-between px-5 py-3.5 border-b border-slate-200 dark:border-slate-800">
        <div class="text-[10px] font-bold uppercase tracking-wider text-indigo-500 flex items-center gap-1.5">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="1.9" viewBox="0 0 24 24"><rect x="3" y="4.5" width="18" height="16" rx="2"/><path stroke-linecap="round" stroke-linejoin="round" d="M3 9.5h18M8 3v3m8-3v3"/></svg>
          Appointment ${a.past ? '· Past' : ''}
        </div>
        <button id="appt-detail-close" class="text-slate-400 hover:text-slate-700 dark:hover:text-white text-2xl leading-none">&times;</button>
      </div>

      <!-- Car card -->
      ${a.image ? `<img src="${esc(a.image)}" alt="" class="w-full h-44 object-cover bg-slate-100 dark:bg-slate-800">` : ''}
      <div class="p-5 space-y-4">
        <div>
          <div class="text-lg font-black text-slate-900 dark:text-white">${esc(a.label)}</div>
          ${specs ? `<div class="text-xs text-slate-500 dark:text-slate-400 mt-0.5">${specs}</div>` : ''}
          <div class="flex items-center gap-3 mt-2">
            ${money(a.price) ? `<span class="text-lg font-black text-slate-900 dark:text-white">${money(a.price)}</span>` : ''}
            ${a.stocknumber ? `<span class="text-[11px] font-bold text-indigo-600 dark:text-indigo-400">#${esc(a.stocknumber)}</span>` : ''}
          </div>
        </div>

        <!-- Appointment details -->
        <div class="rounded-xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 p-3.5 space-y-2">
          <div class="flex items-start gap-2">
            <svg class="w-4 h-4 mt-0.5 text-indigo-500 flex-shrink-0" fill="none" stroke="currentColor" stroke-width="1.9" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M12 6v6l4 2"/><circle cx="12" cy="12" r="9"/></svg>
            <div class="text-sm font-semibold text-slate-900 dark:text-white">${esc(when)}</div>
          </div>
          ${a.rep ? `<div class="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300"><svg class="w-4 h-4 text-slate-400 flex-shrink-0" fill="none" stroke="currentColor" stroke-width="1.9" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.5 20.25a7.5 7.5 0 0115 0"/></svg>Rep: ${esc(a.rep)}</div>` : ''}
        </div>

        <!-- Person / buyer info (from the rep's note) -->
        <div>
          <div class="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1">Buyer / Notes</div>
          <div class="text-sm text-slate-700 dark:text-slate-300 whitespace-pre-wrap">${a.appointment_note ? esc(a.appointment_note) : '<span class="text-slate-400 italic">No buyer details were added.</span>'}</div>
        </div>

        <div class="flex flex-wrap gap-2 pt-1">
          ${a.fb_listing_url ? `<a href="${esc(a.fb_listing_url)}" target="_blank" rel="noopener" class="text-xs font-bold px-3 py-2 rounded-lg bg-[#1877F2]/10 text-[#1877F2] hover:bg-[#1877F2]/20 transition">View on Facebook ↗</a>` : ''}
          ${a.source_url ? `<a href="${esc(a.source_url)}" target="_blank" rel="noopener" class="text-xs font-bold px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 hover:bg-slate-100 dark:hover:bg-slate-800 transition">Vehicle page ↗</a>` : ''}
        </div>
      </div>
    </div>`;
  document.getElementById('appt-detail-close')?.addEventListener('click', () => modal.classList.add('hidden'));
}

// Idempotent restore: makes sure leaderboard / team-insights / sales-team panels live
// in their own page wrappers. (Older code mirrored them into Insights as an overview,
// which made the admin dashboard look cluttered. We now rely on sidebar nav instead.)
function ensurePanelsInOriginalLocations() {
  const lb = document.getElementById('leaderboard-panel');
  const ti = document.getElementById('team-insights-panel');
  const st = document.getElementById('dealer-view-panel');
  const pc = document.getElementById('profile-card');

  const lbWrap = document.querySelector('[data-page-content="leaderboard"]');
  const tiWrap = document.querySelector('[data-page-content="team-insights"]');
  const stWrap = document.querySelector('[data-page-content="sales-team"]');
  const pcWrap = document.querySelector('[data-page-content="profile"]');

  if (lb && lbWrap && lb.parentElement !== lbWrap) lbWrap.appendChild(lb);
  if (ti && tiWrap && ti.parentElement !== tiWrap) tiWrap.appendChild(ti);
  if (st && stWrap && st.parentElement !== stWrap) stWrap.appendChild(st);
  // Profile card is authored in the sidebar; move it into the profile page + reveal.
  if (pc && pcWrap && pc.parentElement !== pcWrap) { pcWrap.appendChild(pc); pc.classList.remove('hidden'); }
}

async function fetchMetrics(path) {
  const r = await fetch(`${API}${path}`, { headers: { 'Authorization': `Bearer ${token}` } });
  return r.ok ? r.json() : [];
}

// Shared insights range — persists in localStorage so the user's choice survives reload
// and applies to every page that shows insight data (Insights + Team Insights).
let insightsRange = localStorage.getItem('insightsRange') || 'lifetime';

// Sync all .range-pill buttons (across every range-toggle on the page) to the current range
function syncRangePillsUI() {
  document.querySelectorAll('.range-pill').forEach(p => {
    const active = p.dataset.range === insightsRange;
    p.classList.toggle('bg-white', active);
    p.classList.toggle('dark:bg-slate-800', active);
    p.classList.toggle('text-indigo-600', active);
    p.classList.toggle('dark:text-indigo-400', active);
    p.classList.toggle('text-slate-600', !active);
    p.classList.toggle('dark:text-slate-300', !active);
  });
}
function syncRangeLabels(label) {
  document.querySelectorAll('.range-label').forEach(el => { el.textContent = label || 'lifetime' });
}

// Surface a nudge when a Cloudflare/extension feed hasn't refreshed in a while.
async function loadSyncHealth() {
  const banner = document.getElementById('sync-health-banner');
  if (!banner) return;
  try {
    const res = await fetch(`${API}/dashboard/sync-health`, { headers: { 'Authorization': `Bearer ${token}` } });
    if (!res.ok) return;
    const d = await res.json();
    if (!d.stale || sessionStorage.getItem('syncHealthDismissed') === '1') { banner.classList.add('hidden'); return; }
    const msg = document.getElementById('sync-health-msg');
    if (msg) msg.textContent = d.message || 'Open MarketSync in Chrome to sync inventory.';
    const openBtn = document.getElementById('sync-health-open');
    if (openBtn) {
      if (d.open_url) { openBtn.href = d.open_url; openBtn.classList.remove('hidden'); }
      else openBtn.classList.add('hidden');
    }
    banner.classList.remove('hidden');
    banner.classList.add('flex');
    const dismiss = document.getElementById('sync-health-dismiss');
    if (dismiss) dismiss.onclick = () => { sessionStorage.setItem('syncHealthDismissed', '1'); banner.classList.add('hidden'); banner.classList.remove('flex'); };
  } catch { /* non-fatal */ }
}

async function loadInsights() {
  loadSyncHealth();
  try {
    const res = await fetch(`${API}/dashboard/insights?range=${insightsRange}`, { headers: { 'Authorization': `Bearer ${token}` } });
    if (!res.ok) {
      const body = await res.text();
      console.error(`Insights endpoint failed: ${res.status}`, body);
      return;
    }
    const data = await res.json();

    // Range label & scope subtext
    syncRangeLabels(data.range_label);
    const scopePrefix = data.scope === 'dealership' ? 'team total' : 'your posts';
    document.getElementById('metric-listings-scope').textContent = `${scopePrefix} · ${data.range_label || 'lifetime'}`;

    // Top row (existing four)
    document.getElementById('metric-synced').textContent = data.inventory_available ?? data.inventory_synced;
    document.getElementById('metric-synced-total').textContent = data.inventory_synced;
    document.getElementById('metric-listings').textContent = data.listings_posted;
    document.getElementById('metric-sold').textContent = data.sold_this_month;
    document.getElementById('metric-active-days').textContent = `${data.active_days_this_week}/7`;

    // Second row (new metrics)
    document.getElementById('metric-time-to-sell').textContent = data.avg_time_to_sell_days ?? '—';
    document.getElementById('metric-posts-per-day').textContent = data.posts_per_day || '—';
    document.getElementById('metric-sell-through').textContent = data.sell_through_rate || 0;
    document.getElementById('metric-aged').textContent = data.inventory_aged_60d ?? 0;

    // Admin-only: show admin vs reps breakdown under Listings Posted
    if (data.scope === 'dealership') {
      const bd = document.getElementById('metric-listings-breakdown');
      bd?.classList.remove('hidden');
      bd?.classList.add('grid');
      document.getElementById('metric-listings-admin').textContent = data.listings_by_admin ?? 0;
      document.getElementById('metric-listings-reps').textContent = data.listings_by_reps ?? 0;
    }

    // Hide the "Posts/Day" tile in Lifetime mode since the rate isn't meaningful there
    const ppdCard = document.getElementById('metric-posts-per-day')?.closest('.bg-white, .dark\\:bg-slate-900');
    if (ppdCard) ppdCard.style.opacity = (data.range === 'lifetime') ? '0.5' : '1';
  } catch (e) {
    console.error('Insights load threw:', e);
  }
}

// Range pill click — sync all pills, persist, reload everything insight-related
document.addEventListener('click', (e) => {
  const pill = e.target.closest?.('.range-pill');
  if (!pill) return;
  insightsRange = pill.dataset.range;
  localStorage.setItem('insightsRange', insightsRange);
  syncRangePillsUI();
  loadInsights();
  // Repaint team charts too if they're loaded (admin only)
  if (typeof loadTeamInsightsCharts === 'function' && __canSeeTeamInsights) {
    loadTeamInsightsCharts();
  }
  // Repaint personal charts for solo/dealer reps.
  if (document.getElementById('chart-my-trend')) loadMyCharts();
});

document.addEventListener('DOMContentLoaded', syncRangePillsUI);

// Install-extension CTA: sits at the top of the dashboard until the user dismisses
// it, then stays hidden forever (persisted in localStorage).
document.addEventListener('DOMContentLoaded', () => {
  const banner = document.getElementById('ext-cta-banner');
  const headerBtn = document.getElementById('ext-header-btn');
  let dismissed = false;
  try { dismissed = localStorage.getItem('ms_ext_cta_dismissed') === '1'; } catch {}
  // Not dismissed → big banner at the top. Dismissed → compact "Install extension"
  // button beside Tour in the header (stays there forever).
  const applyDismissed = () => { banner?.classList.add('hidden'); headerBtn?.classList.remove('hidden'); };
  if (dismissed) applyDismissed();
  else { banner?.classList.remove('hidden'); headerBtn?.classList.add('hidden'); }
  document.getElementById('ext-cta-dismiss')?.addEventListener('click', () => {
    applyDismissed();
    try { localStorage.setItem('ms_ext_cta_dismissed', '1'); } catch {}
  });
});

// DEALER DOMAIN: Real team roster from /dealership/team
async function loadDealerManagementMatrix() {
  const tableBody = document.getElementById('dealer-team-table-body');
  tableBody.innerHTML = `<tr><td colspan="8" class="p-4 text-slate-500 italic">Loading team...</td></tr>`;

  try {
    const res = await fetch(`${API}/dealership/team`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || 'Failed to load team');
    }
    const team = await res.json();

    if (!team.length) {
      tableBody.innerHTML = `<tr><td colspan="8" class="p-4 text-slate-500 italic">No team members yet. Click "Invite Rep" to add one.</td></tr>`;
      return;
    }

    tableBody.innerHTML = team.map(m => {
      const isSelf = m.id === user.id;
      const isAdmin = m.role === 'DEALER_ADMIN' || m.role === 'OWNER';
      const isManager = m.role === 'MANAGER';
      const roleBadge = (isAdmin || isManager)
        ? `<span class="px-2 py-0.5 rounded text-xs font-bold bg-indigo-950 text-indigo-300 border border-indigo-800">${m.role}</span>`
        : `<span class="px-2 py-0.5 rounded text-xs font-bold bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 border border-slate-300 dark:border-slate-700">${m.role}</span>`;
      // One consolidated Edit button per rep — opens a modal with everything.
      const action = `<button class="rep-edit-btn inline-flex items-center gap-1 text-xs font-bold text-indigo-500 hover:text-indigo-400" data-rep-id="${m.id}"><svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/></svg>Edit</button>`;
      const youTag = isSelf ? ' <span class="text-xs text-slate-500 font-normal">(you)</span>' : '';
      const nameCell = `<button class="rep-detail-btn text-left font-bold text-slate-900 dark:text-white hover:text-indigo-400 transition" data-rep-id="${m.id}">${m.full_name || '(no name)'}${youTag}</button>`;
      return `
        <tr class="border-b border-slate-200/60 dark:border-slate-800/40 hover:bg-white/60 dark:bg-slate-900/40 transition">
          <td class="py-3 px-3">${nameCell}</td>
          <td class="py-3 px-3 text-slate-600 dark:text-slate-300 max-w-[160px] truncate">${m.email || '—'}</td>
          <td class="py-3 px-3">${roleBadge}</td>
          <td class="py-3 px-3 text-right text-indigo-600 dark:text-indigo-400 font-mono">${m.listings_posted}</td>
          <td class="py-3 px-3 text-right text-emerald-600 dark:text-emerald-400 font-mono">${m.listings_sold ?? 0}</td>
          <td class="py-3 px-3 text-right text-amber-600 dark:text-amber-400 font-mono">${m.conversion_rate ?? 0}%</td>
          <td class="py-3 px-3 text-right text-slate-600 dark:text-slate-300 font-mono">${m.logins_30d ?? 0}</td>
          <td class="py-3 px-3 text-right">${action}</td>
        </tr>
      `;
    }).join('');

    __dealerTeam = team;   // cache for the edit modal
    document.querySelectorAll('.rep-detail-btn').forEach(btn => {
      btn.addEventListener('click', () => openRepDetail(btn.dataset.repId));
    });
    document.querySelectorAll('.rep-edit-btn').forEach(btn => {
      btn.addEventListener('click', () => openRepEdit(btn.dataset.repId));
    });
    loadLeadRoutingCard();
  } catch (e) {
    tableBody.innerHTML = `<tr><td colspan="8" class="p-4 text-red-400">${e.message}</td></tr>`;
  }
}

// ── Consolidated rep editor — profile (name/bio/photo) + role + routing +
//    appraisal visibility + password reset + remove, all in one modal ──────────
let __dealerTeam = [];
let __repEditAvatar = null;
function openRepEdit(id) {
  const m = (__dealerTeam || []).find(x => x.id === id); if (!m) { showToast('Rep not found — reload the page', 'error'); return; }
  __repEditAvatar = m.avatar_url || null;
  const isSelf = m.id === user.id;
  const isAdmin = m.role === 'DEALER_ADMIN' || m.role === 'OWNER';
  const isManager = m.role === 'MANAGER';
  const viewerAdmin = profileContext?.role === 'DEALER_ADMIN' || profileContext?.role === 'OWNER';
  const ic = 'w-full bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded-lg px-3 py-2 text-sm';
  const lbl = (t) => `<label class="block text-[11px] font-semibold text-slate-500 dark:text-slate-400 mb-1">${t}</label>`;
  const routingRow = (m.role === 'SALES_REP')
    ? `<div>${lbl('Sales lot (for auto-assigned leads)')}<select id="re-team" class="${ic}">${[['', '—'], ['new', 'New'], ['used', 'Used'], ['both', 'Both']].map(o => `<option value="${o[0]}" ${(m.sales_team || '') === o[0] ? 'selected' : ''}>${o[1] === '—' ? 'Not set' : o[1]}</option>`).join('')}</select></div>`
    : `<div>${lbl('Manager scope (lead notifications)')}<select id="re-mgr" class="${ic}">${[['', '—'], ['gsm', 'GSM'], ['new_mgr', 'New-car manager'], ['used_mgr', 'Used-car manager']].map(o => `<option value="${o[0]}" ${(m.mgr_role || '') === o[0] ? 'selected' : ''}>${o[1] === '—' ? 'Not set' : o[1]}</option>`).join('')}</select></div>`;
  crmOverlay(`<div class="p-5 space-y-3">
    <div class="flex items-center justify-between"><div class="text-lg font-black text-slate-900 dark:text-white">Edit ${esc(m.full_name || 'team member')}</div><button onclick="this.closest('.fixed').remove()" class="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"><svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" d="M6 6l12 12M18 6L6 18"/></svg></button></div>
    <div class="flex items-center gap-3">
      <div id="re-avatar-wrap" class="w-16 h-16 rounded-full overflow-hidden bg-slate-200 dark:bg-slate-700 flex items-center justify-center text-lg font-black text-slate-500 shrink-0">${m.avatar_url ? `<img src="${esc(m.avatar_url)}" class="w-full h-full object-cover">` : esc((m.full_name || '?')[0] || '?')}</div>
      <div><input type="file" accept="image/*" id="re-photo-file" class="hidden" onchange="repEditUploadPhoto(this.files[0])"><button type="button" onclick="document.getElementById('re-photo-file').click()" class="text-xs font-bold bg-slate-200 dark:bg-slate-700 px-3 py-1.5 rounded-lg">Upload photo</button><p class="text-[11px] text-slate-400 mt-1">Shows on your website team page.</p></div>
    </div>
    <div class="grid grid-cols-2 gap-2">
      <div>${lbl('Full name')}<input id="re-name" value="${esc(m.full_name || '')}" class="${ic}"></div>
      <div>${lbl('Display name (public)')}<input id="re-display" value="${esc(m.display_name || '')}" placeholder="${esc(m.full_name || '')}" class="${ic}"></div>
    </div>
    <div>${lbl('Bio (public — appears on the website)')}<textarea id="re-bio" rows="3" class="${ic}" placeholder="A sentence or two about this team member.">${esc(m.bio || '')}</textarea></div>
    <div class="grid grid-cols-2 gap-2">
      ${routingRow}
      ${m.role === 'SALES_REP' ? `<div>${lbl('Appraisals')}<label class="flex items-center gap-2 text-sm ${ic}"><input id="re-appr" type="checkbox" class="accent-indigo-600" ${m.can_see_all_appraisals ? 'checked' : ''}>Sees all appraisals</label></div>` : '<div></div>'}
    </div>
    <label class="flex items-center gap-2 text-sm"><input id="re-active" type="checkbox" class="accent-indigo-600" ${m.active !== false ? 'checked' : ''}>Active (uncheck to pause lead assignment &amp; rep sends)</label>
    <div class="border-t border-slate-200 dark:border-slate-700 pt-3 flex flex-wrap items-center gap-2">
      ${(!isSelf && !isAdmin && viewerAdmin) ? `<button onclick="repEditRole('${m.id}', '${isManager ? 'SALES_REP' : 'MANAGER'}', this)" class="text-xs font-bold bg-slate-100 dark:bg-slate-800 border border-slate-300 dark:border-slate-700 px-3 py-2 rounded-lg">${isManager ? 'Make Rep' : 'Make Manager'}</button>` : ''}
      ${(!isSelf && viewerAdmin) ? `<button onclick="repEditPassword('${m.id}', this)" class="text-xs font-bold bg-slate-100 dark:bg-slate-800 border border-slate-300 dark:border-slate-700 px-3 py-2 rounded-lg">Reset password</button>` : ''}
      ${(!isSelf && !isAdmin) ? `<button onclick="repEditRemove('${m.id}','${esc(m.full_name || 'this rep')}')" class="text-xs font-bold text-rose-600 hover:text-rose-500 px-2 py-2">Remove</button>` : ''}
      <div class="flex-1"></div>
      <button onclick="this.closest('.fixed').remove()" class="text-sm font-bold text-slate-500 px-4 py-2">Cancel</button>
      <button onclick="repEditSave('${m.id}', this)" class="text-sm font-bold bg-indigo-600 hover:bg-indigo-500 text-white px-4 py-2 rounded-lg">Save</button>
    </div>
    <p id="re-msg" class="hidden text-xs"></p>
  </div>`, 'max-w-lg');
}
async function repEditUploadPhoto(file) {
  if (!file) return; showToast('Uploading…', 'info');
  try {
    const fd = new FormData(); fd.append('image', file);
    const r = await fetch(`${API}/dealership/site-image`, { method: 'POST', headers: { 'Authorization': `Bearer ${token}` }, body: fd });
    const d = await r.json(); if (!r.ok) throw new Error(d.error || 'Upload failed');
    __repEditAvatar = d.url;
    const w = document.getElementById('re-avatar-wrap'); if (w) w.innerHTML = `<img src="${esc(d.url)}" class="w-full h-full object-cover">`;
    showToast('Photo set — Save to apply', 'success');
  } catch (e) { showToast(e.message, 'error'); }
}
async function repEditSave(id, btn) {
  const val = (i) => (document.getElementById(i)?.value || '').trim();
  const orig = btn.textContent; btn.disabled = true; btn.textContent = 'Saving…';
  try {
    await apiSendJson(`/admin/users/${id}/profile`, 'PUT', { full_name: val('re-name'), display_name: val('re-display'), bio: val('re-bio'), avatar_url: __repEditAvatar });
    const team = {}; const t = document.getElementById('re-team'); const mg = document.getElementById('re-mgr');
    if (t) team.sales_team = t.value; if (mg) team.mgr_role = mg.value;
    const act = document.getElementById('re-active'); if (act) team.active = act.checked;
    if (Object.keys(team).length) await apiSendJson(`/admin/users/${id}/team`, 'PUT', team);
    const appr = document.getElementById('re-appr');
    if (appr) await fetch(`${API}/ai/rep-appraisal-visibility`, { method: 'PUT', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ rep_id: id, can_see_all: appr.checked }) });
    btn.closest('.fixed').remove(); showToast('Saved', 'success'); loadDealerManagementMatrix();
  } catch (e) { btn.disabled = false; btn.textContent = orig; showToast(e.message, 'error'); }
}
async function repEditPassword(id, btn) {
  if (!confirm('Reset this person\'s password to a new temporary one? They\'ll need to use it to sign in.')) return;
  const orig = btn.textContent; btn.disabled = true; btn.textContent = 'Resetting…';
  try {
    const d = await apiSendJson(`/admin/users/${id}/password`, 'PUT', {});
    const msg = document.getElementById('re-msg'); if (msg) { msg.textContent = `New temporary password: ${d.password} — copy it now and share it securely.`; msg.className = 'text-xs text-emerald-600 dark:text-emerald-400 select-all'; msg.classList.remove('hidden'); }
    showToast('Password reset', 'success');
  } catch (e) { showToast(e.message, 'error'); }
  finally { btn.disabled = false; btn.textContent = orig; }
}
async function repEditRole(id, to, btn) {
  const orig = btn.textContent; btn.disabled = true; btn.textContent = '…';
  try { await apiSendJson(`/admin/users/${id}/role`, 'POST', { role: to }); showToast('Role updated', 'success'); btn.closest('.fixed').remove(); loadDealerManagementMatrix(); }
  catch (e) { btn.disabled = false; btn.textContent = orig; showToast(e.message, 'error'); }
}
async function repEditRemove(id, name) {
  if (typeof removeRep === 'function') { document.querySelector('.fixed')?.remove(); removeRep(id, name); }
}
Object.assign(window, { openRepEdit, repEditUploadPhoto, repEditSave, repEditPassword, repEditRole, repEditRemove });

// Lead routing + notification config card (on the Sales Team page).
async function loadLeadRoutingCard() {
  const card = document.getElementById('lead-routing-card'); if (!card) return;
  let d; try { d = await apiGetJson('/leads/routing'); } catch { return; }
  if (!d.can_manage) { card.classList.add('hidden'); return; }
  const r = d.routing || {};
  const targeted = r.mode !== 'all';
  card.classList.remove('hidden');
  card.innerHTML = `<div class="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-4 sm:p-6">
    <h2 class="text-lg font-bold text-slate-900 dark:text-white">Lead routing &amp; notifications</h2>
    <p class="text-slate-500 dark:text-slate-400 text-xs mb-3">New leads are auto-assigned by a random draw within the matching lot. Set each person's lot/scope in the roster below.</p>
    <div class="space-y-2 text-sm">
      <label class="flex items-start gap-2 cursor-pointer"><input type="radio" name="lr-mode" value="targeted" ${targeted ? 'checked' : ''} class="mt-1 accent-indigo-600"><span><b>Targeted</b> — a used lead goes to a random used-car rep + the GSM and used-car manager (new → new rep + new manager).</span></label>
      <label class="flex items-start gap-2 cursor-pointer"><input type="radio" name="lr-mode" value="all" ${targeted ? '' : 'checked'} class="mt-1 accent-indigo-600"><span><b>Everyone</b> — assign to a random rep and notify <b>all management</b>.</span></label>
    </div>
    <div class="border-t border-slate-200 dark:border-slate-800 mt-3 pt-3 space-y-2 text-sm">
      <label class="flex items-center gap-2"><input id="lr-notify-reps" type="checkbox" ${r.notify_reps !== false ? 'checked' : ''} class="accent-indigo-600">Notify the assigned rep</label>
      <label class="flex items-center gap-2"><input id="lr-notify-mgrs" type="checkbox" ${r.notify_managers !== false ? 'checked' : ''} class="accent-indigo-600">Notify management</label>
      <label class="flex items-center gap-2"><input id="lr-notify-all-sales" type="checkbox" ${r.notify_all_sales ? 'checked' : ''} class="accent-indigo-600">Also notify <b>all sales</b> (Everyone mode)</label>
    </div>
    <button onclick="saveLeadRouting(this)" class="mt-3 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold px-4 py-2 rounded transition">Save routing</button>
    <span id="lr-msg" class="hidden text-xs ml-2"></span>
  </div>`;
}
async function saveLeadRouting(btn) {
  const mode = document.querySelector('input[name="lr-mode"]:checked')?.value || 'targeted';
  const body = { mode, notify_reps: document.getElementById('lr-notify-reps')?.checked, notify_managers: document.getElementById('lr-notify-mgrs')?.checked, notify_all_sales: document.getElementById('lr-notify-all-sales')?.checked };
  const msg = document.getElementById('lr-msg'); btn.disabled = true;
  try { await apiSendJson('/leads/routing', 'PUT', body); if (msg) { msg.textContent = '✓ Saved'; msg.className = 'text-xs ml-2 text-emerald-600 dark:text-emerald-400'; msg.classList.remove('hidden'); } }
  catch (e) { if (msg) { msg.textContent = e.message; msg.className = 'text-xs ml-2 text-red-500'; msg.classList.remove('hidden'); } }
  finally { btn.disabled = false; }
}
window.saveLeadRouting = saveLeadRouting;

async function loadGuardrailSettings() {
  try {
    const r = await fetch(`${API}/posting/guardrail`, { headers: { 'Authorization': `Bearer ${token}` } });
    if (!r.ok) return;
    const g = await r.json();
    const en = document.getElementById('gr-enabled');
    const cap = document.getElementById('gr-cap');
    const sp = document.getElementById('gr-spacing');
    const burst = document.getElementById('gr-burst');
    if (en) en.checked = g.enabled !== false;
    if (cap) cap.value = g.daily_cap ?? 25;
    if (sp) sp.value = g.min_spacing_minutes ?? 2;
    if (burst) burst.value = g.burst_size ?? 5;
  } catch {}
  const btn = document.getElementById('gr-save');
  if (btn && !btn._wired) {
    btn._wired = true;
    btn.addEventListener('click', async () => {
      const msg = document.getElementById('gr-msg');
      btn.disabled = true;
      try {
        const r = await fetch(`${API}/posting/guardrail-settings`, {
          method: 'PUT',
          headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            enabled: document.getElementById('gr-enabled').checked,
            daily_cap: Number(document.getElementById('gr-cap').value),
            min_spacing_minutes: Number(document.getElementById('gr-spacing').value),
            burst_size: Number(document.getElementById('gr-burst').value),
          }),
        });
        if (!r.ok) throw new Error((await r.json()).error || 'Failed');
        msg.textContent = '✓ Saved'; msg.className = 'text-xs mt-2 text-emerald-600 dark:text-emerald-400';
      } catch (e) { msg.textContent = e.message; msg.className = 'text-xs mt-2 text-red-500'; }
      finally { msg.classList.remove('hidden'); btn.disabled = false; }
    });
  }
}

async function setRepRole(id, name, to) {
  const label = to === 'MANAGER' ? 'manager' : 'sales rep';
  if (!confirm(`Change ${name} to ${label}? ${to === 'MANAGER' ? 'Managers get full dealer access for this store and can manage reps.' : ''}`)) return;
  try {
    const res = await fetch(`${API}/admin/users/${id}/role`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: to }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Role change failed');
    showInviteResult(`${name} is now a ${label}.`, 'ok');
    loadDealerManagementMatrix();
  } catch (err) {
    showInviteResult(err.message, 'err');
  }
}

async function removeRep(id, name) {
  if (!confirm(`Remove ${name} from your dealership? Their account will be deleted.`)) return;
  try {
    const res = await fetch(`${API}/admin/users/${id}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Remove failed');
    showInviteResult(`Removed ${name}.`, 'ok');
    loadDealerManagementMatrix();
  } catch (err) {
    showInviteResult(err.message, 'err');
  }
}

async function inviteRep(payload) {
  const res = await fetch(`${API}/admin/users/invite`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify(payload)
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Invite failed');
  return data;
}

async function openRepDetail(repId) {
  const modal = document.getElementById('rep-detail-modal');
  modal.classList.remove('hidden');
  // Reset to loading state
  document.getElementById('rep-detail-name').textContent = 'Loading...';
  document.getElementById('rep-detail-email').textContent = '';
  document.getElementById('rep-detail-meta').textContent = '';
  ['total', 'active', 'sold', 'deleted'].forEach(k =>
    document.getElementById(`rep-detail-${k}`).textContent = '—'
  );
  document.getElementById('rep-detail-recent').innerHTML = '<div class="text-xs text-slate-500 italic">Loading...</div>';

  try {
    const res = await fetch(`${API}/dealership/team/${repId}/stats`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || 'Failed to load rep stats');
    }
    const data = await res.json();
    document.getElementById('rep-detail-name').textContent = data.profile.full_name || '(no name)';
    document.getElementById('rep-detail-email').textContent = data.profile.email || '';
    const joined = data.profile.joined_at ? new Date(data.profile.joined_at).toLocaleDateString() : '—';
    document.getElementById('rep-detail-meta').textContent = `${data.profile.role} · joined ${joined}`;
    document.getElementById('rep-detail-total').textContent = data.totals.total;
    document.getElementById('rep-detail-active').textContent = data.totals.active;
    document.getElementById('rep-detail-sold').textContent = data.totals.sold;
    document.getElementById('rep-detail-deleted').textContent = data.totals.deleted;

    // Player card — tier / points / progress (same scoring as the old Insights cards).
    const listings = Number(data.totals.total) || 0;
    const sold = Number(data.totals.sold) || 0;
    const points = listings * 100 + sold * 500;
    const tier = tierFor(points);
    const next = nextTierFor(points);
    const pct = next ? Math.min(100, Math.round(((points - tier.min) / (next.min - tier.min)) * 100)) : 100;
    const conv = listings > 0 ? Math.round((sold / listings) * 100) : 0;
    const tierEl = document.getElementById('rep-detail-tier');
    if (tierEl) {
      tierEl.className = `inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-bold border ${tier.cls}`;
      tierEl.innerHTML = `<span>${tier.icon}</span><span>${tier.name}</span>`;
    }
    const set = (id, txt) => { const e = document.getElementById(id); if (e) e.textContent = txt; };
    set('rep-detail-points', `${points.toLocaleString()} pts`);
    set('rep-detail-conv', `${conv}% conversion`);
    const bar = document.getElementById('rep-detail-progress');
    if (bar) bar.style.width = `${pct}%`;
    set('rep-detail-next', next ? `${(next.min - points).toLocaleString()} pts to ${next.icon} ${next.name}` : 'Top tier');

    renderRecentListings('rep-detail-recent', data.recent);
  } catch (err) {
    document.getElementById('rep-detail-recent').innerHTML = `<div class="text-xs text-red-400">${err.message}</div>`;
  }
}

function closeRepDetail() {
  document.getElementById('rep-detail-modal').classList.add('hidden');
}

function showInviteResult(text, kind) {
  const el = document.getElementById('invite-result');
  el.innerHTML = text;
  el.className = kind === 'ok'
    ? 'mb-3 p-2 text-xs rounded bg-emerald-100 dark:bg-emerald-900/50 border border-emerald-300 dark:border-emerald-700 text-emerald-700 dark:text-emerald-200'
    : 'mb-3 p-2 text-xs rounded bg-red-100 dark:bg-red-900/50 border border-red-300 dark:border-red-700 text-red-700 dark:text-red-200';
  el.classList.remove('hidden');
}

// SALES DOMAIN: Real personal stats from /me/stats
// Fetch ALL listings (not just the truncated "recent" set from /me/stats) filtered
// by status. Reuses the same renderRecentListings() renderer.
async function loadMyListingsFiltered(status) {
  // Update active-tab styling
  ['posted', 'sold', 'all'].forEach(s => {
    const btn = document.getElementById(`rep-listings-filter-${s}`);
    if (!btn) return;
    if (s === status) {
      btn.className = 'text-xs px-2 py-1 rounded border border-indigo-600 bg-indigo-600 text-white';
    } else {
      btn.className = 'text-xs px-2 py-1 rounded border border-slate-300 dark:border-slate-700 text-slate-500 dark:text-slate-400';
    }
  });

  const el = document.getElementById('rep-recent-list');
  el.innerHTML = '<div class="text-xs text-slate-500 italic">Loading...</div>';
  try {
    const res = await fetch(`${API}/listings?status=${status}`, { headers: { 'Authorization': `Bearer ${token}` } });
    if (!res.ok) throw new Error('Failed to load listings');
    const data = await res.json();
    renderRecentListings('rep-recent-list', data, { canEditUrl: true });
  } catch (e) {
    el.innerHTML = `<div class="text-xs text-red-400">${e.message}</div>`;
  }
}
async function loadMyStats() {
  try {
    const res = await fetch(`${API}/me/stats`, { headers: { 'Authorization': `Bearer ${token}` } });
    if (!res.ok) throw new Error('Failed to load stats');
    const data = await res.json();
    document.getElementById('rep-stat-total').textContent = data.totals.total;
    document.getElementById('rep-stat-active').textContent = data.totals.active;
    document.getElementById('rep-stat-sold').textContent = data.totals.sold;
    document.getElementById('rep-stat-deleted').textContent = data.totals.deleted;
    renderRecentListings('rep-recent-list', data.recent, { canEditUrl: true });
  } catch (e) {
    document.getElementById('rep-recent-list').innerHTML = `<div class="text-xs text-red-400">${e.message}</div>`;
  }
  loadMyCharts();
}

// Personal insight charts for solo reps / dealer reps (mirrors the dealer charts).
let __myTrendChart = null, __myStatusChart = null;
async function loadMyCharts() {
  const trendCtx = document.getElementById('chart-my-trend');
  if (!trendCtx || typeof Chart === 'undefined') return;
  let data;
  try {
    const res = await fetch(`${API}/me/charts?range=${insightsRange}`, { headers: { 'Authorization': `Bearer ${token}` } });
    data = res.ok ? await res.json() : null;
  } catch { data = null; }
  if (!data) return;

  const trend = data.trend || [];
  if (__myTrendChart) __myTrendChart.destroy();
  __myTrendChart = new Chart(trendCtx, {
    type: 'line',
    data: {
      labels: trend.map(d => data.monthly ? d.date : d.date.slice(5)),
      datasets: [
        { label: 'Posted', data: trend.map(d => d.posted), borderColor: '#6366f1', backgroundColor: 'rgba(99,102,241,0.15)', fill: true, tension: 0.3, pointRadius: 2 },
        { label: 'Sold', data: trend.map(d => d.sold), borderColor: '#10b981', backgroundColor: 'rgba(16,185,129,0.15)', fill: true, tension: 0.3, pointRadius: 2 }
      ]
    },
    options: { ...chartCommonOptions(), plugins: { legend: { display: true, labels: { boxWidth: 10, font: { size: 10 } } } } }
  });

  const statusCtx = document.getElementById('chart-my-status');
  if (statusCtx) {
    const b = data.breakdown || { active: 0, sold: 0, deleted: 0 };
    if (__myStatusChart) __myStatusChart.destroy();
    __myStatusChart = new Chart(statusCtx, {
      type: 'doughnut',
      data: {
        labels: ['Active', 'Sold', 'Removed'],
        datasets: [{ data: [b.active, b.sold, b.deleted], backgroundColor: ['#6366f1', '#10b981', '#94a3b8'], borderWidth: 0 }]
      },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom', labels: { boxWidth: 10, font: { size: 10 }, color: window.matchMedia('(prefers-color-scheme: dark)').matches ? '#94a3b8' : '#64748b' } } } }
    });
  }
}

// LEADERBOARD: gamified tier system + podium + activity feed
const LB_TIERS = [
  { name: 'Bronze',   min: 0,     icon: '🥉', cls: 'bg-orange-100 dark:bg-orange-900/40 text-orange-700 dark:text-orange-300 border-orange-300 dark:border-orange-700' },
  { name: 'Silver',   min: 500,   icon: '🥈', cls: 'bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-200 border-slate-300 dark:border-slate-600' },
  { name: 'Gold',     min: 2500,  icon: '🥇', cls: 'bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300 border-amber-300 dark:border-amber-700' },
  { name: 'Platinum', min: 7500,  icon: '💎', cls: 'bg-cyan-100 dark:bg-cyan-900/40 text-cyan-700 dark:text-cyan-300 border-cyan-300 dark:border-cyan-700' },
  { name: 'Diamond',  min: 15000, icon: '💠', cls: 'bg-indigo-100 dark:bg-indigo-900/40 text-indigo-700 dark:text-indigo-300 border-indigo-300 dark:border-indigo-700' },
  { name: 'Legend',   min: 30000, icon: '🔥', cls: 'bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300 border-red-300 dark:border-red-700' }
];

// Shared leaderboard legend — "How you earn points" + "The Six Tiers". Rendered
// into both the team and global boards so the scoring rules are always visible.
const TIER_DOT = { Bronze: '#b45309', Silver: '#94a3b8', Gold: '#f59e0b', Platinum: '#22d3ee', Diamond: '#a78bfa', Legend: '#7c6cf6' };
function leaderboardLegendHTML() {
  const rules = [
    { label: 'Post a car to Facebook Marketplace', pts: '+100', cls: 'text-indigo-600 dark:text-indigo-400' },
    { label: 'You sell that car ("I Sold It")', pts: '+500', cls: 'text-emerald-600 dark:text-emerald-400' },
    { label: 'Someone else sold it (no points, just tracked)', pts: '0', cls: 'text-slate-400' }
  ];
  const ruleRows = rules.map((r, i) => `
    <div class="flex items-center justify-between py-3 ${i < rules.length - 1 ? 'border-b border-slate-100 dark:border-slate-800/60' : ''}">
      <span class="text-sm text-slate-700 dark:text-slate-300">${r.label}</span>
      <span class="font-bold ${r.cls}">${r.pts}</span>
    </div>`).join('');
  const tierRows = LB_TIERS.map(t => {
    const isLegend = t.name === 'Legend';
    const marker = isLegend
      ? '<span class="text-indigo-500">👑</span>'
      : `<span class="inline-block w-2.5 h-2.5 rounded-full" style="background:${TIER_DOT[t.name] || '#94a3b8'}"></span>`;
    return `
      <div class="flex items-center justify-between px-3 py-2.5 rounded-lg ${isLegend ? 'bg-indigo-50 dark:bg-indigo-950/40 border border-indigo-200 dark:border-indigo-800' : 'bg-slate-50 dark:bg-slate-950/60'}">
        <span class="flex items-center gap-2.5 ${isLegend ? 'font-bold text-slate-900 dark:text-white' : 'font-medium text-slate-700 dark:text-slate-300'}">${marker}${t.name}</span>
        <span class="text-sm font-medium ${isLegend ? 'text-slate-900 dark:text-white' : 'text-slate-500 dark:text-slate-400'}">${t.min.toLocaleString()} pts</span>
      </div>`;
  }).join('');
  return `
    <div class="lb-legend grid grid-cols-1 md:grid-cols-2 gap-6 mt-8 pt-8 border-t border-slate-200 dark:border-slate-800">
      <div>
        <h3 class="text-lg font-bold text-slate-900 dark:text-white mb-2">How you earn points</h3>
        <div>${ruleRows}</div>
        <p class="text-xs italic text-slate-400 mt-3">It pays to be the one who closes the deal.</p>
      </div>
      <div>
        <h3 class="text-lg font-bold text-slate-900 dark:text-white mb-3">The Six Tiers</h3>
        <div class="space-y-1.5">${tierRows}</div>
      </div>
    </div>`;
}
// Append the legend to a board panel once (idempotent).
function ensureLeaderboardLegend(panelId) {
  const panel = document.getElementById(panelId);
  if (!panel || panel.querySelector('.lb-legend')) return;
  panel.insertAdjacentHTML('beforeend', leaderboardLegendHTML());
}

const calcPoints = (m) => (m.total_listings || 0) * 100 + (m.sold_listings || 0) * 500;
const tierFor = (points) => {
  let current = LB_TIERS[0];
  for (const t of LB_TIERS) if (points >= t.min) current = t;
  return current;
};
const nextTierFor = (points) => LB_TIERS.find(t => t.min > points) || null;

async function loadLeaderboard() {
  const body = document.getElementById('leaderboard-body');
  if (!body) return;
  body.innerHTML = `<tr><td colspan="7" class="p-6 text-center text-slate-500 italic">Loading leaderboard...</td></tr>`;
  try {
    const res = await fetch(`${API}/dealership/leaderboard`, { headers: { 'Authorization': `Bearer ${token}` } });
    if (!res.ok) throw new Error('Leaderboard failed');
    const data = await res.json();

    const setText = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };
    setText('lb-conv', data.team_conversion_rate ?? 0);
    setText('lb-team-sold', data.team_total_sold ?? 0);
    setText('lb-team-total', data.team_total_listings ?? 0);

    const ranking = (data.ranking || []).map(r => {
      const points = calcPoints(r);
      return { ...r, points, tier: tierFor(points) };
    });

    renderPodium(ranking);
    renderYourPosition(ranking);
    renderRankingTable(ranking);
    loadActivity();
    loadAchievements();
  } catch (e) {
    console.warn('Leaderboard failed:', e.message);
    body.innerHTML = `<tr><td colspan="7" class="p-6 text-center text-red-500 italic">Failed to load leaderboard.</td></tr>`;
  }
}

// ── Achievements (gamification badges) ───────────────────────────────────────
async function loadAchievements() {
  const wrap = document.getElementById('lb-achievements');
  if (!wrap) return;
  try {
    const res = await fetch(`${API}/gamification`, { headers: { 'Authorization': `Bearer ${token}` } });
    if (!res.ok) throw new Error('gamification failed');
    const d = await res.json();
    if (!d.me && !d.dealership) { wrap.innerHTML = ''; return; }
    wrap.innerHTML = `
      ${d.me ? `<div class="mb-4">
        <div class="text-xs uppercase font-bold tracking-wider text-slate-500 dark:text-slate-400 mb-2">Your achievements</div>
        <div class="grid grid-cols-2 sm:grid-cols-4 gap-3">${(d.me.badges || []).map(badgeCard).join('')}</div>
      </div>` : ''}
      ${d.dealership ? `<div>
        <div class="text-xs uppercase font-bold tracking-wider text-slate-500 dark:text-slate-400 mb-2">${esc(d.dealership.name || 'Dealership')} achievements</div>
        <div class="grid grid-cols-2 sm:grid-cols-3 gap-3">${(d.dealership.badges || []).map(badgeCard).join('')}</div>
      </div>` : ''}`;
  } catch (e) {
    console.warn('Achievements failed:', e.message);
    wrap.innerHTML = '';
  }
}

// Roman-numeral tier tag for a badge level (I / II / III). Grey when locked.
function badgeCard(b) {
  const tiers = ['', 'I', 'II', 'III', 'IV', 'V'];
  const earned = (b.level || 0) > 0;
  const roman = tiers[b.level] || (b.level ? String(b.level) : '');
  const valLabel = b.unit === '%' ? `${b.value}%`
    : b.unit === 'h' ? (b.value != null ? `${b.value}h` : '—')
    : `${b.value}${b.unit ? ' ' + b.unit : ''}`;
  // Progress line: cumulative badges show a bar to next; descending/maxed show a note.
  const next = b.next;
  const progress = (b.progress_pct != null && next != null)
    ? `<div class="w-full h-1.5 bg-slate-200 dark:bg-slate-800 rounded-full overflow-hidden mt-2">
         <div class="h-full bg-gradient-to-r from-indigo-500 to-purple-500" style="width:${b.progress_pct}%"></div>
       </div>
       <div class="text-[10px] text-slate-400 mt-1">${next}${b.unit === '%' ? '%' : ''} for next tier</div>`
    : (next == null
        ? `<div class="text-[10px] font-bold text-amber-500 mt-2">★ Max tier reached</div>`
        : `<div class="text-[10px] text-slate-400 mt-2">Reach ${next}${b.unit === 'h' ? 'h or less' : ''} to unlock</div>`);
  return `
    <div class="rounded-xl border p-3 ${earned
      ? 'bg-white dark:bg-slate-900 border-indigo-200 dark:border-indigo-800'
      : 'bg-slate-50 dark:bg-slate-950 border-slate-200 dark:border-slate-800'}">
      <div class="flex items-start justify-between gap-2">
        <div class="text-2xl leading-none ${earned ? '' : 'opacity-30 grayscale'}">${b.icon || '🏅'}</div>
        ${earned ? `<span class="text-[10px] font-black px-1.5 py-0.5 rounded-full bg-indigo-100 dark:bg-indigo-900/50 text-indigo-600 dark:text-indigo-300">TIER ${roman}</span>`
          : `<span class="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-slate-200 dark:bg-slate-800 text-slate-400">LOCKED</span>`}
      </div>
      <div class="text-sm font-bold text-slate-900 dark:text-white mt-1.5 leading-tight">${esc(b.label)}</div>
      <div class="text-[11px] text-slate-500 dark:text-slate-400 leading-snug mt-0.5">${esc(b.description || '')}</div>
      <div class="text-lg font-black text-slate-900 dark:text-white mt-1.5 tabular-nums">${valLabel}</div>
      ${progress}
    </div>`;
}

function renderPodium(ranking) {
  const el = document.getElementById('lb-podium');
  if (!el) return;
  if (!ranking.length) {
    el.innerHTML = '<div class="text-center text-xs text-slate-500 italic col-span-3 py-6">No team members yet.</div>';
    return;
  }

  // Visual order: 2nd · 1st · 3rd (1st is centered and tallest).
  // Always render all 3 slots — empty slots become placeholders.
  const positions = [
    { m: ranking[1], rankNum: 2, height: 'h-24', bar: 'from-slate-300 to-slate-400 dark:from-slate-600 dark:to-slate-500', crown: '🥈' },
    { m: ranking[0], rankNum: 1, height: 'h-32', bar: 'from-amber-300 to-amber-500',                                       crown: '👑' },
    { m: ranking[2], rankNum: 3, height: 'h-20', bar: 'from-orange-300 to-orange-500',                                     crown: '🥉' }
  ];

  el.innerHTML = positions.map(p => {
    if (!p.m) {
      return `
        <div class="flex flex-col items-center text-center opacity-40">
          <div class="text-3xl mb-1 grayscale">${p.crown}</div>
          <div class="font-bold text-sm text-slate-400 italic w-full">Open</div>
          <div class="text-xs text-slate-400 mt-1 mb-2">—</div>
          <div class="w-full mt-2 rounded-t-lg bg-slate-200 dark:bg-slate-800 ${p.height} flex items-start justify-center pt-2 text-slate-400 font-black text-xl">${p.rankNum}</div>
        </div>
      `;
    }
    const isMe = p.m.id === user.id;
    return `
      <div class="flex flex-col items-center text-center">
        <div class="text-3xl mb-1">${p.crown}</div>
        <div class="font-bold text-sm text-slate-900 dark:text-white truncate w-full">${p.m.name}${isMe ? ' <span class="text-xs text-indigo-600 dark:text-indigo-400">(you)</span>' : ''}</div>
        <div class="inline-flex items-center gap-1 mt-1 mb-2 px-2 py-0.5 rounded-full text-xs font-bold border ${p.m.tier.cls}">
          <span>${p.m.tier.icon}</span><span>${p.m.tier.name}</span>
        </div>
        <div class="text-xs font-mono text-slate-600 dark:text-slate-300">${p.m.points.toLocaleString()} pts</div>
        <div class="w-full mt-2 rounded-t-lg bg-gradient-to-b ${p.bar} ${p.height} flex items-start justify-center pt-2 text-white font-black text-xl shadow-inner">
          ${p.rankNum}
        </div>
      </div>
    `;
  }).join('');
}

function renderYourPosition(ranking) {
  const me = ranking.find(r => r.id === user.id);
  const card = document.getElementById('lb-you');
  if (!me || !card) return;
  card.classList.remove('hidden');

  const next = nextTierFor(me.points);
  const span = next ? (next.min - me.tier.min) : 1;
  const progressed = me.points - me.tier.min;
  const pct = next ? Math.min(100, Math.round((progressed / span) * 100)) : 100;
  const toNext = next ? next.min - me.points : 0;

  document.getElementById('lb-you-rank').textContent = me.rank;
  document.getElementById('lb-you-total').textContent = ranking.length;
  document.getElementById('lb-you-points').textContent = me.points.toLocaleString();
  document.getElementById('lb-you-current-tier').textContent = `${me.tier.icon} ${me.tier.name}`;
  document.getElementById('lb-you-next-tier').textContent = next ? `${next.icon} ${next.name}` : 'Max tier';
  document.getElementById('lb-you-progress-pct').textContent = pct;
  document.getElementById('lb-you-progress-bar').style.width = pct + '%';
  document.getElementById('lb-you-points-to-next').textContent = next ? toNext.toLocaleString() : 'You\'re at the top tier';

  const badge = document.getElementById('lb-you-tier-badge');
  badge.className = `inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold border ${me.tier.cls}`;
  badge.innerHTML = `<span>${me.tier.icon}</span><span>${me.tier.name}</span>`;
}

function renderRankingTable(ranking) {
  const body = document.getElementById('leaderboard-body');
  if (!body) return;
  if (!ranking.length) {
    body.innerHTML = `<tr><td colspan="7" class="p-6 text-center text-slate-500 italic">No team members yet.</td></tr>`;
    return;
  }
  const medals = { 1: '🥇', 2: '🥈', 3: '🥉' };
  body.innerHTML = ranking.map(r => {
    const isMe = r.id === user.id;
    const rowBg = isMe ? 'bg-indigo-50 dark:bg-indigo-950/30' : '';
    const rankCell = medals[r.rank]
      ? `<span class="text-base">${medals[r.rank]}</span>`
      : `<span class="text-slate-500 dark:text-slate-400 font-mono">${r.rank}</span>`;
    return `
      <tr class="${rowBg} hover:bg-slate-50 dark:hover:bg-slate-900/60 transition">
        <td class="py-3 px-3">${rankCell}</td>
        <td class="py-3 px-3 font-semibold text-slate-900 dark:text-white">
          ${r.name}${isMe ? ' <span class="text-xs font-normal text-indigo-600 dark:text-indigo-400">(you)</span>' : ''}
        </td>
        <td class="py-3 px-3">
          <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-bold border ${r.tier.cls}">
            <span>${r.tier.icon}</span><span>${r.tier.name}</span>
          </span>
        </td>
        <td class="py-3 px-3 text-right font-mono font-bold text-slate-900 dark:text-white">${r.points.toLocaleString()}</td>
        <td class="py-3 px-3 text-right font-mono text-indigo-600 dark:text-indigo-400">${r.total_listings}</td>
        <td class="py-3 px-3 text-right font-mono text-emerald-600 dark:text-emerald-400">${r.sold_listings}</td>
        <td class="py-3 px-3 text-right font-mono text-amber-600 dark:text-amber-400">${r.conversion_rate}%</td>
      </tr>
    `;
  }).join('');
}

async function loadActivity() {
  const el = document.getElementById('lb-activity');
  if (!el) return;
  try {
    const res = await fetch(`${API}/dealership/activity`, { headers: { 'Authorization': `Bearer ${token}` } });
    if (!res.ok) throw new Error('Activity failed');
    const data = await res.json();
    if (!data.events?.length) {
      el.innerHTML = '<div class="text-xs text-slate-500 italic">No activity yet — start posting to fill this up.</div>';
      return;
    }
    el.innerHTML = data.events.map(e => {
      const isSold = e.type === 'sold';
      const icon = isSold ? '🏆' : '🚗';
      const verb = isSold ? 'sold' : 'posted';
      const accent = isSold ? 'text-emerald-600 dark:text-emerald-400' : 'text-indigo-600 dark:text-indigo-400';
      const when = e.timestamp ? timeAgo(new Date(e.timestamp)) : '';
      return `
        <div class="flex items-center gap-3 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded p-2">
          <div class="text-lg">${icon}</div>
          <div class="flex-1 min-w-0 text-sm">
            <span class="font-semibold text-slate-900 dark:text-white">${e.user_name}</span>
            <span class="text-slate-600 dark:text-slate-400">${verb}</span>
            <span class="text-slate-900 dark:text-white">${e.vehicle}</span>
          </div>
          <div class="text-right">
            <div class="text-xs font-bold ${accent}">+${e.points} pts</div>
            <div class="text-xs text-slate-500">${when}</div>
          </div>
        </div>
      `;
    }).join('');
  } catch (e) {
    el.innerHTML = `<div class="text-xs text-red-500">Failed to load activity.</div>`;
  }
}

function timeAgo(date) {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;
  return date.toLocaleDateString();
}

// CHARTS: listings over time + by rep + sold by rep + active days by rep
//          + sell-through % by rep + avg time-to-sell by rep + rep cards
async function loadCharts() {
  try {
    const res = await fetch(`${API}/dealership/charts?range=${insightsRange}`, { headers: { 'Authorization': `Bearer ${token}` } });
    if (!res.ok) return;
    const data = await res.json();
    renderDailyChart(data.daily || []);
    renderByRepChart(data.by_rep || []);
    renderSoldByRepChart(data.sold_by_rep || []);
    renderActiveByRepChart(data.active_days_by_rep || []);
    renderSellThroughByRepChart(data.sell_through_by_rep || []);
    renderTimeToSellByRepChart(data.time_to_sell_by_rep || []);
    // Per-rep "player" cards now live in the Sales Team page's rep-detail modal.
  } catch (e) {
    console.warn('Charts failed:', e.message);
  }
}

// Alias used by the range-pill click handler — `loadTeamInsightsCharts` reads more
// clearly when called from outside this section.
const loadTeamInsightsCharts = loadCharts;

let __dailyChart = null;
let __byRepChart = null;
let __soldByRepChart = null;
let __activeByRepChart = null;
let __sellThroughChart = null;
let __timeToSellChart = null;

function renderDailyChart(daily) {
  const ctx = document.getElementById('chart-listings-daily');
  if (!ctx || typeof Chart === 'undefined') return;
  if (__dailyChart) __dailyChart.destroy();
  __dailyChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: daily.map(d => d.date.slice(5)),  // MM-DD
      datasets: [{
        label: 'Listings',
        data: daily.map(d => d.count),
        borderColor: '#6366f1',
        backgroundColor: 'rgba(99,102,241,0.15)',
        fill: true,
        tension: 0.3,
        pointRadius: 2,
        pointHoverRadius: 5
      }]
    },
    options: chartCommonOptions()
  });
}

function renderByRepChart(byRep) {
  const ctx = document.getElementById('chart-listings-by-rep');
  if (!ctx || typeof Chart === 'undefined') return;
  if (__byRepChart) __byRepChart.destroy();
  __byRepChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: byRep.map(r => r.name),
      datasets: [{
        label: 'Listings',
        data: byRep.map(r => r.count),
        backgroundColor: '#6366f1',
        borderRadius: 4
      }]
    },
    options: chartCommonOptions()
  });
}

function renderSoldByRepChart(soldByRep) {
  const ctx = document.getElementById('chart-sold-by-rep');
  if (!ctx || typeof Chart === 'undefined') return;
  if (__soldByRepChart) __soldByRepChart.destroy();
  __soldByRepChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: soldByRep.map(r => r.name),
      datasets: [{
        label: 'Sold',
        data: soldByRep.map(r => r.count),
        backgroundColor: '#10b981',
        borderRadius: 4
      }]
    },
    options: chartCommonOptions()
  });
}

function renderActiveByRepChart(activeByRep) {
  const ctx = document.getElementById('chart-active-by-rep');
  if (!ctx || typeof Chart === 'undefined') return;
  if (__activeByRepChart) __activeByRepChart.destroy();
  __activeByRepChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: activeByRep.map(r => r.name),
      datasets: [{
        label: 'Active days / 14',
        data: activeByRep.map(r => r.count),
        backgroundColor: '#f59e0b',
        borderRadius: 4
      }]
    },
    options: { ...chartCommonOptions(), scales: { ...chartCommonOptions().scales, y: { ...chartCommonOptions().scales.y, max: 14 } } }
  });
}

function renderSellThroughByRepChart(rows) {
  const ctx = document.getElementById('chart-sell-through-by-rep');
  if (!ctx || typeof Chart === 'undefined') return;
  if (__sellThroughChart) __sellThroughChart.destroy();
  __sellThroughChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: rows.map(r => r.name),
      datasets: [{
        label: 'Sell-through %',
        data: rows.map(r => r.percent),
        backgroundColor: '#10b981',
        borderRadius: 4
      }]
    },
    options: {
      ...chartCommonOptions(),
      scales: {
        ...chartCommonOptions().scales,
        y: { ...chartCommonOptions().scales.y, max: 100, ticks: { callback: v => v + '%' } }
      }
    }
  });
}

function renderTimeToSellByRepChart(rows) {
  const ctx = document.getElementById('chart-time-to-sell-by-rep');
  if (!ctx || typeof Chart === 'undefined') return;
  if (__timeToSellChart) __timeToSellChart.destroy();
  __timeToSellChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: rows.map(r => r.name),
      datasets: [{
        label: 'Avg days to sell',
        data: rows.map(r => r.days),
        backgroundColor: '#a78bfa',
        borderRadius: 4
      }]
    },
    options: chartCommonOptions()
  });
}

// Per-rep cards on the Team Insights page — gamified profile per individual
function renderRepCards(byRep, soldByRep, activeByRep) {
  const el = document.getElementById('ti-rep-cards');
  if (!el) return;
  if (!byRep?.length) {
    el.innerHTML = '<div class="text-xs text-slate-500 italic col-span-full">No team members yet.</div>';
    return;
  }

  // Build lookup maps by name (charts data uses name as identifier)
  const soldMap = new Map(soldByRep.map(s => [s.name, s.count]));
  const activeMap = new Map(activeByRep.map(a => [a.name, a.count]));

  el.innerHTML = byRep.map(r => {
    const listings = r.count;
    const sold = soldMap.get(r.name) || 0;
    const activeDays = activeMap.get(r.name) || 0;
    const points = listings * 100 + sold * 500;
    const tier = tierFor(points);
    const next = nextTierFor(points);
    const progressed = points - tier.min;
    const span = next ? (next.min - tier.min) : 1;
    const pct = next ? Math.min(100, Math.round((progressed / span) * 100)) : 100;
    const conv = listings > 0 ? Math.round((sold / listings) * 100) : 0;
    const initial = (r.name || '?').trim().charAt(0).toUpperCase();

    return `
      <div class="bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg p-4 flex flex-col gap-3">
        <div class="flex items-start justify-between gap-2">
          <div class="flex items-center gap-2.5 min-w-0">
            <div class="w-9 h-9 rounded-full bg-indigo-100 dark:bg-indigo-900/50 text-indigo-700 dark:text-indigo-300 flex items-center justify-center font-black text-sm flex-shrink-0">${initial}</div>
            <div class="min-w-0">
              <button class="rep-card-btn text-sm font-bold text-slate-900 dark:text-white leading-tight break-words hover:text-indigo-500 dark:hover:text-indigo-400 text-left" data-rep-id="${r.id}">${r.name}</button>
              <div class="text-xs text-slate-500 font-mono">${points.toLocaleString()} pts</div>
            </div>
          </div>
          <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-bold border ${tier.cls} flex-shrink-0">
            <span>${tier.icon}</span><span>${tier.name}</span>
          </span>
        </div>

        <div class="grid grid-cols-3 gap-2 text-center">
          <div class="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded p-2">
            <div class="text-xs uppercase font-bold text-slate-500 dark:text-slate-400 tracking-wide leading-tight">Listed</div>
            <div class="text-base font-black text-indigo-600 dark:text-indigo-400">${listings}</div>
          </div>
          <div class="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded p-2">
            <div class="text-xs uppercase font-bold text-slate-500 dark:text-slate-400 tracking-wide leading-tight">Sold</div>
            <div class="text-base font-black text-emerald-600 dark:text-emerald-400">${sold}</div>
          </div>
          <div class="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded p-2">
            <div class="text-xs uppercase font-bold text-slate-500 dark:text-slate-400 tracking-wide leading-tight">Conv</div>
            <div class="text-base font-black text-amber-600 dark:text-amber-400">${conv}%</div>
          </div>
        </div>

        <div>
          <div class="flex justify-between text-sm font-bold uppercase tracking-wider text-slate-500 mb-1">
            <span>${tier.icon} ${tier.name}</span>
            <span>${activeDays}d / 14d active</span>
          </div>
          <div class="w-full h-1.5 bg-slate-200 dark:bg-slate-800 rounded-full overflow-hidden">
            <div class="h-full bg-gradient-to-r from-indigo-500 to-purple-500 transition-all duration-700" style="width:${pct}%"></div>
          </div>
          <div class="text-xs text-slate-500 mt-1">${next ? `${(next.min - points).toLocaleString()} pts to ${next.icon} ${next.name}` : 'Top tier'}</div>
        </div>
      </div>
    `;
  }).join('');

  el.querySelectorAll('.rep-card-btn').forEach(btn => {
    btn.addEventListener('click', () => openRepDetail(btn.dataset.repId));
  });
}

function chartCommonOptions() {
  const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const tickColor = isDark ? '#94a3b8' : '#64748b';
  const gridColor = isDark ? 'rgba(148,163,184,0.08)' : 'rgba(100,116,139,0.12)';
  return {
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { display: false } },
    scales: {
      x: {
        ticks: {
          color: tickColor,
          font: { size: 11 },
          maxRotation: 45,
          minRotation: 30,
          autoSkip: true,
          maxTicksLimit: 10
        },
        grid: { color: gridColor }
      },
      y: {
        ticks: { color: tickColor, font: { size: 11 }, precision: 0 },
        grid: { color: gridColor },
        beginAtZero: true
      }
    }
  };
}

// Re-render charts when the system color preference changes (e.g., macOS auto switch at sunset)
if (typeof window !== 'undefined' && window.matchMedia) {
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (typeof loadCharts === 'function') loadCharts();
  });
}

function renderRecentListings(containerId, items, { canEditUrl = false } = {}) {
  const el = document.getElementById(containerId);
  if (!items?.length) {
    el.innerHTML = '<div class="text-xs text-slate-500 italic">No listings yet.</div>';
    return;
  }
  const badge = (s) => {
    const map = {
      posted: 'bg-emerald-900/40 border-emerald-700 text-emerald-300',
      sold: 'bg-indigo-900/40 border-indigo-700 text-indigo-300',
      deleted: 'bg-slate-100 dark:bg-slate-800 border-slate-300 dark:border-slate-700 text-slate-500 dark:text-slate-400'
    };
    return `<span class="text-xs uppercase font-bold border px-1.5 py-0.5 rounded ${map[s] || map.deleted}">${s}</span>`;
  };
  el.innerHTML = items.map(l => {
    const v = l.inventory || l.vehicle || {};
    const thumb = v.image_urls?.[0]
      ? `<img src="${API}/proxy-image?url=${encodeURIComponent(v.image_urls[0])}" class="w-16 h-12 rounded object-cover bg-slate-50 dark:bg-slate-950" loading="lazy">`
      : `<div class="w-16 h-12 rounded bg-slate-50 dark:bg-slate-950 flex items-center justify-center text-slate-700">⌀</div>`;
    const when = l.posted_at ? new Date(l.posted_at).toLocaleDateString() : '—';
    const vehicleLabel = (v.year || v.make || v.model)
      ? `${v.year || ''} ${v.make || ''} ${v.model || ''} ${v.trim || ''}`.trim()
      : (l.vehicle_label || 'Vehicle no longer in inventory');
    const hasFbLink = l.fb_listing_url && /facebook\.com\/marketplace\/item\/\d+/i.test(l.fb_listing_url);
    const canAdd = canEditUrl && l.id && l.status === 'posted';
    // Every row is clickable: the exact FB permalink when we have it, otherwise a
    // Facebook Marketplace search for this vehicle so it still opens the listing.
    const q = (vehicleLabel && vehicleLabel !== 'Vehicle no longer in inventory') ? vehicleLabel : (l.vehicle_label || '');
    const searchUrl = 'https://www.facebook.com/marketplace/search/?query=' + encodeURIComponent(q);
    const openUrl = hasFbLink ? l.fb_listing_url : searchUrl;
    const subtext = hasFbLink
      ? `Posted ${when} · <span class="text-indigo-500">View on FB ↗</span>`
      : `Posted ${when} · <span class="text-indigo-500">Find on FB ↗</span>`;
    const meta = `<div class="text-xs text-slate-500 dark:text-slate-400">${subtext}</div>`;
    const linkBtn = canAdd
      ? `<button class="set-fb-link flex-shrink-0 text-[10px] font-bold px-2 py-1 rounded border border-slate-300 dark:border-slate-700 ${hasFbLink ? 'text-slate-400' : 'text-amber-500'} hover:bg-slate-100 dark:hover:bg-slate-800 transition" title="Save the exact Facebook listing link">${hasFbLink ? '✎' : '+ Link'}</button>`
      : '';
    const rowContent = `
        ${thumb}
        <div class="flex-1 min-w-0">
          <div class="text-xs font-bold text-slate-900 dark:text-white truncate">${vehicleLabel}</div>
          ${meta}
        </div>
        ${linkBtn}
        ${badge(l.status)}
    `;
    return `<div class="listing-row flex items-center gap-3 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded p-2 cursor-pointer hover:border-indigo-400 dark:hover:border-indigo-500 transition-colors" data-listing-id="${l.id || ''}" data-open-url="${esc(openUrl)}">${rowContent}</div>`;
  }).join('');

  // Row click opens the listing (exact permalink or Marketplace search fallback).
  el.querySelectorAll('.listing-row').forEach(row => {
    row.addEventListener('click', (e) => {
      if (e.target.closest('.set-fb-link')) return;   // the "set exact link" button handles itself
      const u = row.dataset.openUrl;
      if (u) window.open(u, '_blank', 'noopener');
    });
    const setBtn = row.querySelector('.set-fb-link');
    if (setBtn) setBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const url = prompt('Paste the exact Facebook Marketplace listing URL:\n(e.g. https://www.facebook.com/marketplace/item/1234567890)');
      if (!url) return;
      if (!/facebook\.com\/marketplace\/item\/\d+/i.test(url)) {
        alert('That doesn\'t look like a valid Facebook Marketplace item URL.\nIt should look like: https://www.facebook.com/marketplace/item/1234567890');
        return;
      }
      try {
        const r = await fetch(`${API}/listings/${row.dataset.listingId}/fb-url`, {
          method: 'PATCH',
          headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ fb_listing_url: url })
        });
        if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.error || 'Failed'); }
        const item = items.find(i => i.id === row.dataset.listingId);
        if (item) item.fb_listing_url = url;
        renderRecentListings(containerId, items, { canEditUrl });
      } catch (e) { alert('Could not save URL: ' + e.message); }
    });
  });
}

// INVENTORY FEEDS: list, add, remove, manual sync
async function loadInventoryFeeds() {
  const list = document.getElementById('feeds-list');
  list.innerHTML = '<div class="text-xs text-slate-500 italic">Loading feeds...</div>';
  try {
    const res = await fetch(`${API}/inventory-feeds`, { headers: { 'Authorization': `Bearer ${token}` } });
    const feeds = res.ok ? await res.json() : [];
    if (!feeds.length) {
      list.innerHTML = '<div class="text-xs text-slate-500 italic">No feeds yet — add one below to start syncing inventory.</div>';
      return;
    }
    // Anyone who can manage feeds (dealer admins + solo reps with a personal dealership)
    // should see the Remove button. Backend permission is enforced server-side too.
    const isAdmin = profileContext?.role === 'DEALER_ADMIN' || profileContext?.role === 'OWNER' || profileContext?.role === 'MANAGER';
    const isSoloOwner = profileContext?.dealership?.is_personal === true;
    const canManage = isAdmin || isSoloOwner;

    setupExtensionBridge();  // start listening for the extension + announce we're here
    const esc = (s) => String(s == null ? '' : s).replace(/"/g, '&quot;');

    list.innerHTML = feeds.map(f => {
      // Cloudflare-protected feeds are pulled through the browser. Show the full
      // step-by-step box ONLY until the first successful capture; after that
      // (last_extension_sync_at stamped) collapse to a compact confirmation with a
      // small "Pull again" for when inventory changes.
      const flaggedExt = f.platform === 'needs_extension_capture' || f.platform === 'extension_capture';
      const captured = flaggedExt && !!f.last_extension_sync_at;
      const needsExt = flaggedExt && !f.last_extension_sync_at;
      // The page the extension should OPEN to scrape is the dealer's listing page,
      // not the JSON/API feed_url. Prefer source_dealer_url when we have it.
      const dealerPage = f.source_dealer_url || f.feed_url;

      const orangeSteps = `
        <div class="text-sm leading-snug rounded bg-amber-100 dark:bg-amber-900/40 border border-amber-300 dark:border-amber-700 text-amber-800 dark:text-amber-200 px-2 py-1.5">
          🔒 <b>Cloudflare-protected</b> — our servers can't reach it, so it's pulled through your browser:
          <div class="mt-1">1. Click <b>Pull Inventory</b>. &nbsp;2. A dealer tab opens, scans, and closes itself — don't close it. &nbsp;3. Wait ~1–2 min. &nbsp;4. This list and your catalog refresh automatically when done.</div>
        </div>`;
      // Only feeds that actually require the browser extension show the pull box.
      // Server-synced feeds (LeadBox, DealerPage, direct feeds, reachable eDealer)
      // don't need it — no message, just the synced count.
      const extBlock = flaggedExt ? `
        <div class="ms-ext-capture mt-2" data-feed-id="${esc(f.id)}" data-feed-url="${esc(dealerPage)}">
          ${needsExt ? orangeSteps : ''}
          <div class="flex items-center gap-2 mt-2">
            <button class="ms-pull-btn ${needsExt ? 'bg-indigo-600 hover:bg-indigo-500 text-white' : 'bg-slate-200 dark:bg-slate-800 hover:bg-slate-300 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200'} text-xs font-semibold px-3 py-1.5 rounded disabled:opacity-60">${needsExt ? 'Pull Inventory' : '↻ Pull again'}</button>
            <span class="ms-pull-status text-sm text-slate-500 dark:text-slate-400"></span>
          </div>
          <div class="ms-pull-track mt-2 h-1.5 bg-slate-200 dark:bg-slate-800 rounded overflow-hidden" style="display:none"><div class="ms-pull-fill h-full bg-indigo-500" style="width:0%;transition:width .3s"></div></div>
        </div>` : '';

      const borderCls = needsExt ? 'border-amber-300 dark:border-amber-700'
        : captured ? 'border-emerald-300 dark:border-emerald-800'
        : 'border-slate-200 dark:border-slate-800';
      const pill = needsExt
        ? '<span class="text-xs uppercase font-bold bg-amber-200 dark:bg-amber-800 text-amber-800 dark:text-amber-100 px-1.5 py-0.5 rounded flex-shrink-0">Extension</span>'
        : captured
        ? '<span class="text-xs uppercase font-bold bg-emerald-200 dark:bg-emerald-800 text-emerald-800 dark:text-emerald-100 px-1.5 py-0.5 rounded flex-shrink-0">Synced</span>'
        : '';

      return `
      <div class="bg-slate-50 dark:bg-slate-950 border ${borderCls} rounded p-3 overflow-hidden">
        <div class="flex items-center justify-between gap-3 overflow-hidden">
          <div class="flex items-center gap-2 min-w-0 flex-1 overflow-hidden">
            <span class="text-xs uppercase font-bold bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 px-1.5 py-0.5 rounded flex-shrink-0">${f.feed_type || 'all'}</span>
            ${pill}
            <span class="text-xs text-slate-600 dark:text-slate-300 truncate block min-w-0 flex-1" title="${esc(f.feed_url)}">${f.feed_url}</span>
          </div>
          ${canManage ? `<button data-feed-id="${esc(f.id)}" class="feed-delete-btn text-red-400 hover:text-red-300 text-xs font-bold flex-shrink-0">Remove</button>` : ''}
        </div>
        ${extBlock}
      </div>`;
    }).join('');

    document.querySelectorAll('.feed-delete-btn').forEach(btn => {
      btn.addEventListener('click', () => deleteFeed(btn.dataset.feedId));
    });

    // Wire Pull Inventory buttons + reflect extension presence / any running capture.
    document.querySelectorAll('.ms-ext-capture').forEach(wrap => {
      const btn = wrap.querySelector('.ms-pull-btn');
      const st = wrap.querySelector('.ms-pull-status');
      if (!window.__msExtPresent) {
        if (btn) { btn.disabled = true; btn.classList.add('opacity-60'); }
        if (st) st.textContent = 'Install/enable the MarketSync extension to pull this.';
      }
      btn?.addEventListener('click', () => pullViaExtension(wrap.dataset.feedId, wrap.dataset.feedUrl));
    });
    // Reflect any in-flight/last capture state on the freshly-rendered wrap, but
    // DON'T re-trigger catalog/feed reloads here (that belongs to a real state
    // change via the bridge) — otherwise a persisted 'done' state loops reloads.
    if (window.__msLastCaptureState) applyCaptureState(window.__msLastCaptureState, false);
  } catch (err) {
    list.innerHTML = `<div class="text-xs text-red-400">Failed to load feeds: ${err.message}</div>`;
  }
}

// ── Extension bridge: lets the dashboard drive the browser-capture for Cloudflare
// dealers via the MarketSync extension's content script (dashboard-bridge.js). ──
function setupExtensionBridge() {
  if (window.__msBridgeReady) return;
  window.__msBridgeReady = true;
  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || d.__marketsync !== true || d.dir !== 'from-ext') return;
    if (d.type === 'EXT_PRESENT') {
      const was = window.__msExtPresent;
      window.__msExtPresent = true;
      if (!was && typeof loadInventoryFeeds === 'function') loadInventoryFeeds(); // re-render → enable buttons
    } else if (d.type === 'CAPTURE_STATE') {
      // Only react (reload catalog/feeds) when this is a NEW state, not a replay of
      // the same persisted one — guards against a 'done' state looping reloads.
      const key = d.state ? `${d.state.feedId || ''}:${d.state.status}:${d.state.count ?? ''}:${d.state.finishedAt ?? ''}` : '';
      const isNew = key !== window.__msLastCaptureKey;
      window.__msLastCaptureKey = key;
      window.__msLastCaptureState = d.state;
      applyCaptureState(d.state, isNew);
    } else if (d.type === 'PULL_STARTED') {
      handlePullStarted(d);
    }
  });
  // Ask the extension to announce itself (covers the case where its EXT_PRESENT
  // fired before this listener was attached).
  window.postMessage({ __marketsync: true, dir: 'from-page', type: 'PING' }, '*');
}

function pullViaExtension(feedId, feedUrl) {
  const wrap = document.querySelector(`.ms-ext-capture[data-feed-id="${feedId}"]`);
  if (!window.__msExtPresent) {
    setPullUI(wrap, { status: 'Extension not detected — install/enable MarketSync, then reload.', disabled: false });
    return;
  }
  setPullUI(wrap, { status: 'Starting…', disabled: true });
  window.postMessage({ __marketsync: true, dir: 'from-page', type: 'PULL_INVENTORY', feedUrl, feedId }, '*');
}

function handlePullStarted(d) {
  const wrap = document.querySelector(`.ms-ext-capture[data-feed-id="${d.feedId}"]`) || document.querySelector('.ms-ext-capture');
  if (d.ok) { setPullUI(wrap, { status: 'Opening dealer site…', disabled: true }); return; }
  if (d.needsEnable) {
    setPullUI(wrap, { status: 'One-time setup: open the MarketSync extension → "Enable one-click capture", then click Pull Inventory again.', disabled: false });
  } else {
    setPullUI(wrap, { status: d.error || 'Could not start capture.', disabled: false });
  }
}

function applyCaptureState(state, reactToDone = true) {
  if (!state) return;
  const wrap = state.feedId
    ? document.querySelector(`.ms-ext-capture[data-feed-id="${state.feedId}"]`)
    : document.querySelector('.ms-ext-capture');
  if (!wrap) return;
  if (state.status === 'pulling') {
    const label = state.total ? `Pulling… ${state.current || 0}/${state.total}` : 'Pulling inventory…';
    setPullUI(wrap, { status: label, pct: (state.pct != null ? state.pct : null), disabled: true });
  } else if (state.status === 'done') {
    setPullUI(wrap, { status: `✓ Pulled ${state.count != null ? state.count + ' ' : ''}vehicles.`, pct: 100, disabled: false });
    // Only refresh the catalog/feeds when this 'done' is a fresh event — re-rendering
    // re-applies the persisted state with reactToDone=false, so no reload loop.
    if (reactToDone) {
      loadInventoryCatalog?.();
      loadInsights?.();
      setTimeout(() => loadInventoryFeeds?.(), 1500);  // platform/flag changed → collapse the box
    }
  } else if (state.status === 'error') {
    setPullUI(wrap, { status: state.error || 'Capture failed — try again.', pct: null, disabled: false });
  }
}

function setPullUI(wrap, { status, pct, disabled } = {}) {
  if (!wrap) return;
  const btn = wrap.querySelector('.ms-pull-btn');
  const st = wrap.querySelector('.ms-pull-status');
  const track = wrap.querySelector('.ms-pull-track');
  const fill = wrap.querySelector('.ms-pull-fill');
  if (btn && disabled != null) {
    btn.disabled = disabled;
    btn.textContent = disabled ? 'Pulling…' : 'Pull Inventory';
    btn.classList.toggle('opacity-60', disabled);
  }
  if (st && status != null) st.textContent = status;
  if (track && fill) {
    if (pct == null) { track.style.display = 'none'; }
    else { track.style.display = 'block'; fill.style.width = `${Math.max(0, Math.min(100, pct))}%`; }
  }
}

// ── Global leaderboard (platform-wide, anonymized) ──────────────────────────────
let __glData = null;
let __glTab = 'reps';

function initGlobalLeaderboard() {
  if (window.__glWired) return;
  window.__glWired = true;

  // Populate compact tier dots in #lb-legend-tiers
  const tiersEl = document.getElementById('lb-legend-tiers');
  if (tiersEl && !tiersEl.children.length) {
    tiersEl.innerHTML = LB_TIERS.map(t => {
      const isLegend = t.name === 'Legend';
      const marker = isLegend
        ? '<span class="text-indigo-500">👑</span>'
        : `<span class="inline-block w-2 h-2 rounded-full" style="background:${TIER_DOT[t.name] || '#94a3b8'}"></span>`;
      return `<span class="flex items-center gap-1 text-xs text-slate-600 dark:text-slate-400">${marker}${t.name} <span class="text-slate-400">${t.min >= 1000 ? (t.min/1000)+'k' : t.min}pts</span></span>`;
    }).join('');
  }

  // Carousel: My Team ↔ Global
  let __glLoaded = false;
  const tabTeam = document.getElementById('lb-tab-team');
  const tabGlobal = document.getElementById('lb-tab-global');
  const viewTeam = document.getElementById('lb-view-team');
  const viewGlobal = document.getElementById('lb-view-global');
  const convWrap = document.getElementById('lb-conv-wrap');

  function setCarouselTab(tab) {
    const onTeam = tab === 'team';
    [tabTeam, tabGlobal].forEach(b => {
      if (!b) return;
      b.classList.toggle('bg-white', b.id === (onTeam ? 'lb-tab-team' : 'lb-tab-global'));
      b.classList.toggle('dark:bg-slate-800', b.id === (onTeam ? 'lb-tab-team' : 'lb-tab-global'));
      b.classList.toggle('text-indigo-600', b.id === (onTeam ? 'lb-tab-team' : 'lb-tab-global'));
      b.classList.toggle('dark:text-indigo-400', b.id === (onTeam ? 'lb-tab-team' : 'lb-tab-global'));
      b.classList.toggle('text-slate-600', b.id !== (onTeam ? 'lb-tab-team' : 'lb-tab-global'));
      b.classList.toggle('dark:text-slate-300', b.id !== (onTeam ? 'lb-tab-team' : 'lb-tab-global'));
    });
    if (viewTeam) viewTeam.classList.toggle('hidden', !onTeam);
    if (viewGlobal) viewGlobal.classList.toggle('hidden', onTeam);
    if (convWrap) convWrap.classList.toggle('hidden', !onTeam);
    if (!onTeam && !__glLoaded) { __glLoaded = true; loadGlobalLeaderboard(); }
  }

  if (tabTeam) tabTeam.addEventListener('click', () => setCarouselTab('team'));
  if (tabGlobal) tabGlobal.addEventListener('click', () => setCarouselTab('global'));
  setCarouselTab('team'); // default active

  document.querySelectorAll('.gl-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      __glTab = btn.dataset.glTab;
      document.querySelectorAll('.gl-tab').forEach(b => {
        const on = b === btn;
        b.classList.toggle('bg-white', on);
        b.classList.toggle('dark:bg-slate-800', on);
        b.classList.toggle('text-indigo-600', on);
        b.classList.toggle('dark:text-indigo-400', on);
        b.classList.toggle('text-slate-600', !on);
        b.classList.toggle('dark:text-slate-300', !on);
      });
      renderGlobalLeaderboard();
    });
  });
}

async function loadGlobalLeaderboard() {
  const body = document.getElementById('gl-body');
  if (!body) return;
  try {
    const res = await fetch(`${API}/leaderboard/global`, { headers: { 'Authorization': `Bearer ${token}` } });
    __glData = res.ok ? await res.json() : null;
  } catch { __glData = null; }
  renderGlobalLeaderboard();
}

function renderGlobalLeaderboard() {
  const body = document.getElementById('gl-body');
  const youEl = document.getElementById('gl-you');
  if (!body) return;
  if (!__glData) {
    body.innerHTML = '<tr><td colspan="5" class="p-6 text-center text-slate-500 italic">Global leaderboard unavailable right now.</td></tr>';
    if (youEl) youEl.classList.add('hidden');
    return;
  }
  const rows = __glTab === 'dealers' ? __glData.dealers : __glData.reps;
  const you = __glTab === 'dealers' ? __glData.you_dealer : __glData.you_rep;
  const total = __glTab === 'dealers' ? __glData.total_dealers : __glData.total_reps;
  const avgPts = __glTab === 'dealers' ? __glData.avg_dealer_points : __glData.avg_rep_points;
  const avgPosted = __glTab === 'dealers' ? __glData.avg_dealer_posted : __glData.avg_rep_posted;
  const avgConv = __glTab === 'dealers' ? __glData.avg_dealer_conv : __glData.avg_rep_conv;

  // Update avg strip
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v ?? '—'; };
  const yourConv = you && you.posted > 0 ? Math.round((you.sold / you.posted) * 100) : (you ? 0 : null);
  set('gl-your-pts', you != null ? (you.points || 0).toLocaleString() : '—');
  set('gl-avg-pts', avgPts != null ? avgPts.toLocaleString() : '—');
  set('gl-your-posted', you != null ? (you.posted ?? 0) : '—');
  set('gl-avg-posted', avgPosted != null ? avgPosted : '—');
  set('gl-your-conv', yourConv != null ? yourConv + '%' : '—');
  set('gl-avg-conv', avgConv != null ? avgConv + '%' : '—');

  // Render global podium (top 3)
  const podiumEl = document.getElementById('gl-podium');
  if (podiumEl && rows && rows.length) {
    const top3 = rows.slice(0, 3);
    const order = [top3[1], top3[0], top3[2]].filter(Boolean); // 2nd, 1st, 3rd
    const heights = ['h-20', 'h-28', 'h-16'];
    const medals = ['🥈', '👑', '🥉'];
    const gradients = ['from-slate-300 to-slate-400', 'from-yellow-300 to-amber-500', 'from-orange-300 to-orange-500'];
    const nums = ['2', '1', '3'];
    podiumEl.innerHTML = order.map((r, i) => {
      const avatarHtml = r.avatar_url
        ? `<img src="${r.avatar_url}" class="w-10 h-10 rounded-full object-cover border-2 border-white shadow mb-1 mt-1" />`
        : `<div class="w-10 h-10 rounded-full bg-indigo-200 dark:bg-indigo-700 flex items-center justify-center text-indigo-700 dark:text-indigo-200 font-bold text-base mb-1 mt-1">${(r.name || '?')[0].toUpperCase()}</div>`;
      return `
        <div class="flex flex-col items-center text-center">
          <div class="text-3xl mb-1">${medals[i]}</div>
          ${avatarHtml}
          <div class="font-bold text-sm text-slate-900 dark:text-white truncate w-full">${r.name}${r.isYou ? ' <span class="text-xs text-indigo-500 font-normal">(you)</span>' : ''}</div>
          <div class="text-xs font-mono text-slate-600 dark:text-slate-300 mt-1 mb-2">${(r.points || 0).toLocaleString()} pts</div>
          <div class="w-full mt-2 rounded-t-lg bg-gradient-to-b ${gradients[i]} ${heights[i]} flex items-start justify-center pt-2 text-white font-black text-xl shadow-inner">${nums[i]}</div>
        </div>`;
    }).join('');
  } else if (podiumEl) {
    podiumEl.innerHTML = '';
  }

  if (youEl) youEl.classList.add('hidden');

  if (!rows || !rows.length) {
    body.innerHTML = `<tr><td colspan="5" class="p-6 text-center text-slate-500 italic">No ${__glTab} on the board yet.</td></tr>`;
    return;
  }

  const youInList = rows.some(r => r.isYou);
  const makeRow = (r, pinned) => {
    const hl = r.isYou ? 'bg-indigo-50 dark:bg-indigo-950/40 font-semibold' : '';
    const rank = r.rank === 1 ? '🥇' : r.rank === 2 ? '🥈' : r.rank === 3 ? '🥉' : `#${r.rank}`;
    const sep = pinned ? '<tr><td colspan="5" class="py-0"><div class="border-t-2 border-dashed border-indigo-300 dark:border-indigo-700"></div></td></tr>' : '';
    const avatarCell = r.avatar_url
      ? `<img src="${r.avatar_url}" class="w-6 h-6 rounded-full object-cover inline-block mr-1.5 align-middle border ${r.isYou ? 'border-indigo-300' : 'border-slate-300 dark:border-slate-600'}" />`
      : `<span class="inline-flex w-6 h-6 rounded-full bg-slate-200 dark:bg-slate-700 items-center justify-center text-xs font-bold text-slate-500 mr-1.5 align-middle">${(r.name || '?')[0].toUpperCase()}</span>`;
    return `${sep}<tr class="${hl}">
      <td class="py-2.5 px-3 text-left tabular-nums">${rank}</td>
      <td class="py-2.5 px-3 text-left text-slate-900 dark:text-white">${avatarCell}${r.name}${r.isYou ? ' <span class="text-xs text-indigo-500 font-normal">(you)</span>' : ''}</td>
      <td class="py-2.5 px-3 text-right font-mono">${(r.points || 0).toLocaleString()}</td>
      <td class="py-2.5 px-3 text-right font-mono text-slate-500 dark:text-slate-400">${r.posted ?? '—'}</td>
      <td class="py-2.5 px-3 text-right font-mono text-emerald-600 dark:text-emerald-400">${r.sold ?? '—'}</td>
    </tr>`;
  };

  let html = rows.map(r => makeRow(r, false)).join('');
  if (!youInList && you) {
    html += makeRow({ ...you, isYou: true }, true);
  }
  body.innerHTML = html;
}

async function deleteFeed(id) {
  if (!confirm('Remove this inventory feed?\n\nAll synced vehicles from this feed will also be removed from your catalog. This cannot be undone.')) return;
  showSyncStatus('Removing feed and its inventory…', 'info');
  try {
    const res = await fetch(`${API}/inventory-feeds/${id}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Delete failed');
    const n = data.inventory_deleted || 0;
    showSyncStatus(n > 0 ? `✓ Feed removed · ${n} vehicles cleared from catalog.` : '✓ Feed removed.', 'ok');
    loadInventoryFeeds();
    loadInventoryCatalog();   // refresh the catalog grid so deleted vehicles disappear
    loadInsights();           // update the metric strip counts
  } catch (err) {
    showSyncStatus(err.message, 'err');
  }
}

async function addFeed(feedUrl, feedType) {
  // Find the submit button + URL input so we can show loading state.
  // Probing every platform's URL can take 5-30s — without feedback users think nothing's happening.
  const form = document.getElementById('add-feed-form');
  const submitBtn = form?.querySelector('button[type="submit"]');
  const urlInput = document.getElementById('add-feed-url');
  const originalBtnText = submitBtn?.textContent || 'Add Feed';

  showSyncStatus(`Probing ${feedUrl} … this can take 10-30s while we try known dealer platforms.`, 'info');
  if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Adding…'; }
  if (urlInput) urlInput.disabled = true;

  try {
    const res = await fetch(`${API}/inventory-feeds`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ feed_url: feedUrl, feed_type: feedType })
    });
    const data = await res.json();
    if (!res.ok) {
      const attempts = Array.isArray(data.attempted) ? `\nTried: ${data.attempted.join(' · ')}` : '';
      throw new Error((data.error || 'Add failed') + attempts);
    }
    const platform = data.platform ? ` · ${data.platform}` : '';

    // Cloudflare-protected dealer: server can't reach it. The feed was saved flagged
    // for extension capture — guide the user to the browser extension instead of
    // auto-syncing (which would return nothing from the server).
    if (data.needs_extension_capture) {
      showSyncStatus(
        `✓ Feed added${platform}. This dealer blocks server access (Cloudflare). Open the MarketSync browser extension and click "Connect dealer site" to pull inventory from your own browser session.`,
        'ok'
      );
      loadInventoryFeeds();
      if (urlInput) urlInput.value = '';
      return;
    }

    showSyncStatus(`✓ Feed added${platform}. Pulling inventory now…`, 'ok');
    loadInventoryFeeds();
    if (urlInput) urlInput.value = '';

    // Auto-trigger the first sync so the user doesn't have to click Sync Now manually.
    // Skips the dashboard's syncNow() wrapper because we want to keep using the
    // already-disabled submit button to gate the second action.
    try {
      const syncRes = await fetch(`${API}/inventory/sync`, {
        method: 'POST', headers: { 'Authorization': `Bearer ${token}` }
      });
      const syncData = await syncRes.json();
      if (syncRes.ok && syncData.success) {
        const b = syncData.skip_breakdown || {};
        const reasons = []
        if (b.feed_type > 0) reasons.push(`${b.feed_type} wrong condition`)
        if (b.offline > 0) reasons.push(`${b.offline} offline`)
        if (b.no_identifier > 0) reasons.push(`${b.no_identifier} no VIN/stock #`)
        if (b.upsert_error > 0) reasons.push(`${b.upsert_error} DB errors`)
        const skipNote = syncData.skipped > 0
          ? ` · ${syncData.skipped} skipped (${reasons.join(', ') || 'misc'})`
          : ''
        showSyncStatus(
          `✓ Feed added. Synced ${syncData.unique_vehicles} unique vehicles (${syncData.available_after_sync} available)${skipNote}.`,
          'ok'
        );
        loadInsights?.()
        loadInventoryCatalog?.()
      } else {
        showSyncStatus(`✓ Feed added. First sync had an issue — click Sync Now to retry.`, 'err');
      }
    } catch (e) {
      showSyncStatus(`✓ Feed added — click Sync Now to pull inventory.`, 'ok');
    }
  } catch (err) {
    showSyncStatus(err.message, 'err');
  } finally {
    if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = originalBtnText; }
    if (urlInput) urlInput.disabled = false;
  }
}

async function syncNow() {
  const btn = document.getElementById('sync-now-btn');
  btn.disabled = true;
  const originalText = btn.textContent;
  btn.textContent = 'Syncing… 0%';
  showSyncStatus('Sync running — this can take a minute depending on inventory size.', 'info');

  // Poll live progress so the user sees an accurate, moving percentage (and knows
  // the sync isn't frozen). Stops in the finally block when the sync POST resolves.
  const pollProgress = async () => {
    try {
      const r = await fetch(`${API}/inventory/sync/progress`, { headers: { 'Authorization': `Bearer ${token}` } });
      if (!r.ok) return;
      const p = await r.json();
      if (p && typeof p.pct === 'number' && p.phase !== 'idle' && p.phase !== 'done' && p.phase !== 'error') {
        btn.textContent = `Syncing… ${p.pct}%`;
        if (p.message) showSyncStatus(p.message, 'info');
      }
    } catch { /* transient — keep polling */ }
  };
  const progressTimer = setInterval(pollProgress, 900);

  try {
    const res = await fetch(`${API}/inventory/sync`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Sync failed');
    const dupNote = data.duplicates_merged > 0 ? ` · ${data.duplicates_merged} duplicate VINs merged` : '';
    // Build a real skip reason from the breakdown — replaces the misleading "sale-pending / offline" generic
    let skipNote = '';
    if (data.skipped > 0) {
      const b = data.skip_breakdown || {};
      const reasons = [];
      if (b.feed_type > 0) reasons.push(`${b.feed_type} wrong condition`);
      if (b.offline > 0) reasons.push(`${b.offline} offline`);
      if (b.no_identifier > 0) reasons.push(`${b.no_identifier} no VIN/stock #`);
      if (b.upsert_error > 0) reasons.push(`${b.upsert_error} DB errors`);
      skipNote = reasons.length
        ? ` · ${data.skipped} skipped (${reasons.join(', ')})`
        : ` · ${data.skipped} skipped`;
    }
    showSyncStatus(
      `Synced ${data.unique_vehicles} unique vehicles (${data.available_after_sync} available)${dupNote}${skipNote}.`,
      'ok'
    );
    // Refresh insights + catalog after a sync
    loadInsights();
    loadInventoryCatalog();
  } catch (err) {
    showSyncStatus(err.message, 'err');
  } finally {
    clearInterval(progressTimer);
    btn.disabled = false;
    btn.textContent = originalText;
  }
}

function showSyncStatus(text, kind) {
  const el = document.getElementById('sync-status');
  el.textContent = text;
  el.className = kind === 'ok'
    ? 'mb-3 p-2 text-xs rounded bg-emerald-100 dark:bg-emerald-900/50 border border-emerald-300 dark:border-emerald-700 text-emerald-700 dark:text-emerald-200'
    : kind === 'err'
      ? 'mb-3 p-2 text-xs rounded bg-red-100 dark:bg-red-900/50 border border-red-300 dark:border-red-700 text-red-700 dark:text-red-200'
      : 'mb-3 p-2 text-xs rounded bg-slate-100 dark:bg-slate-800 border border-slate-300 dark:border-slate-700 text-slate-600 dark:text-slate-300';
  el.classList.remove('hidden');
}

// INVENTORY CATALOG: full vehicle browser
let __catalogCache = [];
let __marketPositions = {};   // inventory_id → market median (Inventory Intelligence)

// Carfax: open the dealer's embedded Carfax report for this VIN (scraped from the
// vehicle's listing page + cached), falling back to a Carfax Canada VIN search.
async function openCarfax(id, vin) {
  const w = window.open('about:blank', '_blank');
  const fallback = vin ? `${CARFAX_BASE}${encodeURIComponent(vin)}` : 'https://www.carfax.ca/';
  try {
    const r = await fetch(`${API}/inventory/${id}/carfax`, { headers: { 'Authorization': `Bearer ${token}` } });
    const d = await r.json().catch(() => ({}));
    const url = d.url || fallback;
    if (w) w.location.href = url; else window.open(url, '_blank', 'noopener');
    if (d.source === 'fallback') showToast('No Carfax badge on that listing — opened a Carfax search instead.', 'info');
  } catch {
    if (w) w.location.href = fallback; else window.open(fallback, '_blank', 'noopener');
  }
}

// ══ Manual inventory: add/edit a vehicle with photos ═════════════════════════
// MarketSync as the source of truth — dealers load units here, photos and all,
// and everything (website, syndication) reads from this.
let __vehExistingUrls = [];   // already-uploaded photo URLs (editable)
let __vehFormFiles = [];      // File objects staged for upload
// Rendered-car placeholder for photoless stock cards — the car on the dealer's
// chosen background (if set), else a neutral gradient.
function catalogCarPlaceholder(cls) {
  const bg = (typeof __photoBackgroundUrl !== 'undefined' && __photoBackgroundUrl) ? __photoBackgroundUrl : null;
  const style = bg ? `background-image:url('${esc(bg)}');background-size:cover;background-position:center` : 'background:linear-gradient(135deg,#334155,#0f172a)';
  return `<div class="${cls} flex items-center justify-center overflow-hidden" style="${style}"><svg viewBox="0 0 120 46" class="w-3/4 max-w-[150px]" style="opacity:.92"><path d="M10 34 h100 a3 3 0 0 0 3-3 v-6 a4 4 0 0 0-3-4 l-14-3 -9-9 a7 7 0 0 0-5-2 H43 a7 7 0 0 0-5 2 l-9 9 -14 3 a4 4 0 0 0-3 4 v6 a3 3 0 0 0 3 3 z" fill="#ffffff" fill-opacity=".9"/><circle cx="34" cy="35" r="7" fill="#0f172a"/><circle cx="86" cy="35" r="7" fill="#0f172a"/><circle cx="34" cy="35" r="3" fill="#fff"/><circle cx="86" cy="35" r="3" fill="#fff"/></svg></div>`;
}
let __photoBackgroundUrl = null;  // dealership branded background (or null)
let __bgProviderReady = false;    // AI cutout provider key configured server-side

function openVehicleForm(vehicle) {
  const v = vehicle || {};
  const isEdit = !!v.id;
  __vehExistingUrls = Array.isArray(v.image_urls) ? v.image_urls.slice() : [];
  __vehFormFiles = [];
  const inp = (id, val, ph, cls = '') => `<input id="${id}" value="${esc(val == null ? '' : val)}" placeholder="${esc(ph)}" class="${cls} bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded-lg px-3 py-2 text-sm">`;
  const lbl = (t) => `<label class="block text-[11px] font-semibold text-slate-500 dark:text-slate-400 mb-1">${t}</label>`;
  const opts = (cur, arr) => arr.map(o => `<option value="${o[0]}" ${String(cur || '') === o[0] ? 'selected' : ''}>${o[1]}</option>`).join('');
  const selCls = 'w-full bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded-lg px-3 py-2 text-sm';
  crmOverlay(`<div class="p-5 space-y-3">
    <div class="flex items-center justify-between">
      <div class="text-lg font-black text-slate-900 dark:text-white">${isEdit ? 'Edit vehicle' : 'Add vehicle'}</div>
      <button onclick="this.closest('.fixed').remove()" class="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"><svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" d="M6 6l12 12M18 6L6 18"/></svg></button>
    </div>
    <div class="flex gap-2">
      ${inp('veh-vin', v.vin, '17-char VIN (optional — auto-fills specs)', 'flex-1 uppercase')}
      <button type="button" onclick="vehDecode()" class="text-xs font-bold bg-slate-200 dark:bg-slate-700 hover:bg-slate-300 dark:hover:bg-slate-600 text-slate-700 dark:text-slate-200 px-3 rounded-lg">Decode</button>
    </div>
    <div class="grid grid-cols-4 gap-2">
      <div>${lbl('Year')}${inp('veh-year', v.year, '2021', 'w-full')}</div>
      <div>${lbl('Make')}${inp('veh-make', v.make, 'Make', 'w-full')}</div>
      <div>${lbl('Model')}${inp('veh-model', v.model, 'Model', 'w-full')}</div>
      <div>${lbl('Trim')}${inp('veh-trim', v.trim, 'Trim', 'w-full')}</div>
    </div>
    <div class="grid grid-cols-4 gap-2">
      <div>${lbl('Price ($)')}${inp('veh-price', v.price, '', 'w-full')}</div>
      <div>${lbl('Mileage (km)')}${inp('veh-mileage', v.mileage, '', 'w-full')}</div>
      <div>${lbl('Condition')}<select id="veh-condition" class="${selCls}">${opts(v.condition || 'used', [['used', 'Used'], ['new', 'New'], ['demo', 'Demo']])}</select></div>
      <div>${lbl('Stock #')}${inp('veh-stock', v.stocknumber, '', 'w-full')}</div>
    </div>
    <div class="grid grid-cols-4 gap-2">
      <div>${lbl('Ext. colour')}${inp('veh-ext', v.exterior_color, '', 'w-full')}</div>
      <div>${lbl('Int. colour')}${inp('veh-int', v.interior_color, '', 'w-full')}</div>
      <div>${lbl('Drivetrain')}<select id="veh-drive" class="${selCls}">${opts(v.drivetrain, [['', '—'], ['FWD', 'FWD'], ['RWD', 'RWD'], ['AWD', 'AWD'], ['4WD', '4WD']])}</select></div>
      <div>${lbl('Doors')}${inp('veh-doors', v.doors, '', 'w-full')}</div>
    </div>
    <div class="grid grid-cols-4 gap-2">
      <div>${lbl('Transmission')}${inp('veh-trans', v.transmission, '', 'w-full')}</div>
      <div>${lbl('Fuel')}${inp('veh-fuel', v.fuel_type, '', 'w-full')}</div>
      <div>${lbl('Engine')}${inp('veh-engine', v.engine, '', 'w-full')}</div>
      <div>${lbl('Body')}${inp('veh-body', v.body_style, '', 'w-full')}</div>
    </div>
    <div>${lbl('Description')}<textarea id="veh-desc" rows="3" class="w-full bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded-lg px-3 py-2 text-sm">${esc(v.description || '')}</textarea></div>
    <div>
      <div class="flex items-center justify-between mb-1">
        <label class="block text-[11px] font-semibold text-slate-500 dark:text-slate-400">Sales pitch <span class="text-slate-400 font-normal">(shown on your website)</span></label>
        ${isEdit ? `<button type="button" onclick="vehGenPitch('${v.id}', this)" class="text-[11px] font-bold text-violet-600 dark:text-violet-400 hover:text-violet-500">✨ Write with AI</button>` : '<span class="text-[10px] text-slate-400 italic">Save first, then generate</span>'}
      </div>
      <textarea id="veh-pitch" rows="3" placeholder="A compelling pitch for this car. Click ✨ Write with AI, or type your own." class="w-full bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded-lg px-3 py-2 text-sm">${esc(v.sales_pitch || '')}</textarea>
    </div>
    <div class="border-t border-slate-200 dark:border-slate-700 pt-3">
      <div class="text-sm font-black text-slate-900 dark:text-white">Key specs</div>
      <p class="text-[11px] text-slate-400 mb-2">The VIN decode can't provide these — enter what you know. Each shows on your website's vehicle page only if filled in.</p>
      <div class="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <div>${lbl('Towing capacity')}${inp('veh-sp-tow', (v.specs_manual || {}).towing_capacity, 'e.g. 7,700 lb', 'w-full')}</div>
        <div>${lbl('Horsepower')}${inp('veh-sp-hp', (v.specs_manual || {}).horsepower, 'e.g. 310 hp', 'w-full')}</div>
        <div>${lbl('Torque')}${inp('veh-sp-tq', (v.specs_manual || {}).torque, 'e.g. 430 lb-ft', 'w-full')}</div>
        <div>${lbl('Curb weight')}${inp('veh-sp-cw', (v.specs_manual || {}).curb_weight, 'e.g. 4,900 lb', 'w-full')}</div>
        <div>${lbl('Payload')}${inp('veh-sp-pl', (v.specs_manual || {}).payload, 'e.g. 1,550 lb', 'w-full')}</div>
        <div>${lbl('Seating')}${inp('veh-sp-seat', (v.specs_manual || {}).seating, 'e.g. 5', 'w-full')}</div>
        <div>${lbl('Fuel economy')}${inp('veh-sp-fe', (v.specs_manual || {}).fuel_economy, 'e.g. 11.5/8.0 L/100km', 'w-full')}</div>
        <div>${lbl('Cargo / bed')}${inp('veh-sp-cargo', (v.specs_manual || {}).cargo, 'e.g. 5 ft 2 in box', 'w-full')}</div>
      </div>
    </div>
    <div>
      <div class="flex items-center justify-between mb-1">
        ${lbl('Photos')}
        <button type="button" onclick="openPhotoBackgroundUploader()" class="text-[11px] font-bold text-indigo-600 dark:text-indigo-400 hover:underline">${__photoBackgroundUrl ? 'Change branded background' : 'Set branded background'}</button>
      </div>
      <div id="veh-photos" class="grid grid-cols-4 sm:grid-cols-6 gap-2 mb-2"></div>
      <input id="veh-file" type="file" accept="image/*" multiple class="hidden" onchange="vehAddFiles(this.files); this.value='';">
      <input id="veh-cam" type="file" accept="image/*" capture="environment" class="hidden" onchange="vehAddFiles(this.files); this.value='';">
      <div class="grid grid-cols-2 gap-2">
        <button type="button" onclick="document.getElementById('veh-file').click()" class="border-2 border-dashed border-slate-300 dark:border-slate-700 hover:border-indigo-400 rounded-lg py-3 text-sm font-semibold text-slate-500 dark:text-slate-400 transition">+ Add photos</button>
        <button type="button" onclick="document.getElementById('veh-cam').click()" class="border-2 border-dashed border-slate-300 dark:border-slate-700 hover:border-indigo-400 rounded-lg py-3 text-sm font-semibold text-slate-500 dark:text-slate-400 transition flex items-center justify-center gap-1.5"><svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M15 10a3 3 0 11-6 0 3 3 0 016 0z"/><path stroke-linecap="round" stroke-linejoin="round" d="M4 7h3l1.5-2h7L17 7h3a1 1 0 011 1v10a1 1 0 01-1 1H4a1 1 0 01-1-1V8a1 1 0 011-1z"/></svg>Take photo</button>
      </div>
      ${__photoBackgroundUrl ? `<label class="flex items-center gap-2 mt-2 text-xs ${__bgProviderReady ? 'text-slate-600 dark:text-slate-300' : 'text-slate-400'}">
        <input id="veh-bg-toggle" type="checkbox" ${__bgProviderReady ? 'checked' : 'disabled'} class="accent-indigo-600">
        Put these photos on our branded background${__bgProviderReady ? '' : ' (AI background not enabled yet)'}
        <img src="${esc(__photoBackgroundUrl)}" class="w-8 h-6 object-cover rounded ml-auto border border-slate-200 dark:border-slate-700">
      </label>` : ''}
    </div>
    <div class="flex gap-2 items-center justify-between pt-1">
      <div>${isEdit ? `<button onclick="vehDelete('${v.id}')" class="text-sm font-bold text-rose-600 hover:text-rose-500 px-2 py-2">Delete</button>` : ''}</div>
      <div class="flex gap-2">
        <button onclick="this.closest('.fixed').remove()" class="text-sm font-bold text-slate-500 px-4 py-2">Cancel</button>
        <button onclick="vehSave(this, ${isEdit ? `'${v.id}'` : 'null'})" class="text-sm font-bold bg-indigo-600 hover:bg-indigo-500 text-white px-4 py-2 rounded-lg">${isEdit ? 'Save' : 'Add vehicle'}</button>
      </div>
    </div>
  </div>`, 'max-w-2xl');
  renderVehPhotos();
}
function renderVehPhotos() {
  const box = document.getElementById('veh-photos');
  if (!box) return;
  const thumbs = [];
  __vehExistingUrls.forEach((u, i) => thumbs.push(`<div class="relative aspect-square"><img src="${esc(u)}" class="w-full h-full object-cover rounded-lg"><button type="button" onclick="vehRemoveExisting(${i})" class="absolute top-0.5 right-0.5 bg-black/60 hover:bg-black/80 text-white rounded-full w-5 h-5 text-xs leading-none flex items-center justify-center">×</button></div>`));
  __vehFormFiles.forEach((f, i) => thumbs.push(`<div class="relative aspect-square"><img src="${URL.createObjectURL(f)}" class="w-full h-full object-cover rounded-lg opacity-90"><button type="button" onclick="vehRemoveFile(${i})" class="absolute top-0.5 right-0.5 bg-black/60 hover:bg-black/80 text-white rounded-full w-5 h-5 text-xs leading-none flex items-center justify-center">×</button><span class="absolute bottom-0.5 left-0.5 bg-indigo-600 text-white text-[8px] font-bold px-1 rounded">new</span></div>`));
  box.innerHTML = thumbs.join('') || '<div class="col-span-full text-xs text-slate-400 italic py-2">No photos yet — the first one becomes the main photo.</div>';
}
function vehAddFiles(fileList) { __vehFormFiles.push(...Array.from(fileList || [])); renderVehPhotos(); }
function vehRemoveFile(i) { __vehFormFiles.splice(i, 1); renderVehPhotos(); }
function vehRemoveExisting(i) { __vehExistingUrls.splice(i, 1); renderVehPhotos(); }
async function vehDecode() {
  const vin = (document.getElementById('veh-vin')?.value || '').trim().toUpperCase();
  if (vin.length !== 17) { showToast('Enter a 17-character VIN', 'error'); return; }
  try {
    const r = await fetch(`${API}/ai/vin-decode`, { method: 'POST', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ vin }) });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'Decode failed');
    const set = (id, val) => { const el = document.getElementById(id); if (el && val != null && val !== '') el.value = val; };
    set('veh-year', d.year); set('veh-make', d.make); set('veh-model', d.model); set('veh-trim', d.trim);
    set('veh-trans', d.transmission); set('veh-fuel', d.fuel_type); set('veh-engine', d.engine); set('veh-body', d.body_style);
    const dt = document.getElementById('veh-drive');
    if (dt && d.drivetrain) { const u = d.drivetrain.toUpperCase(); dt.value = /AWD|ALL|4MATIC|QUATTRO/.test(u) ? 'AWD' : /4WD|4X4/.test(u) ? '4WD' : /RWD|REAR/.test(u) ? 'RWD' : /FWD|FRONT/.test(u) ? 'FWD' : ''; }
    showToast('VIN decoded', 'success');
  } catch (e) { showToast(e.message, 'error'); }
}
async function vehSave(btn, id) {
  const val = (i) => (document.getElementById(i)?.value || '').trim();
  const body = {
    vin: val('veh-vin'), year: val('veh-year'), make: val('veh-make'), model: val('veh-model'), trim: val('veh-trim'),
    price: val('veh-price'), mileage: val('veh-mileage'), condition: document.getElementById('veh-condition')?.value || 'used',
    stocknumber: val('veh-stock'), exterior_color: val('veh-ext'), interior_color: val('veh-int'),
    drivetrain: document.getElementById('veh-drive')?.value || '', doors: val('veh-doors'),
    transmission: val('veh-trans'), fuel_type: val('veh-fuel'), engine: val('veh-engine'), body_style: val('veh-body'),
    description: val('veh-desc'), sales_pitch: val('veh-pitch'), image_urls: __vehExistingUrls,
    specs_manual: {
      towing_capacity: val('veh-sp-tow'), horsepower: val('veh-sp-hp'), torque: val('veh-sp-tq'), curb_weight: val('veh-sp-cw'),
      payload: val('veh-sp-pl'), seating: val('veh-sp-seat'), fuel_economy: val('veh-sp-fe'), cargo: val('veh-sp-cargo'),
    },
  };
  if (!body.make || !body.model) { showToast('Make and model are required', 'error'); return; }
  const orig = btn.textContent; btn.disabled = true; btn.textContent = 'Saving…';
  try {
    let vehId = id;
    if (id) await apiSendJson(`/inventory/${id}`, 'PUT', body);
    else { const d = await apiSendJson('/inventory', 'POST', body); vehId = d.vehicle?.id; }
    if (vehId && __vehFormFiles.length) {
      const useBg = document.getElementById('veh-bg-toggle')?.checked;
      btn.textContent = useBg ? `Applying background to ${__vehFormFiles.length}…` : `Uploading ${__vehFormFiles.length} photo${__vehFormFiles.length > 1 ? 's' : ''}…`;
      const fd = new FormData();
      __vehFormFiles.forEach(f => fd.append('photos', f));
      if (useBg) fd.append('background', '1');
      const r = await fetch(`${API}/inventory/${vehId}/photos`, { method: 'POST', headers: { 'Authorization': `Bearer ${token}` }, body: fd });
      if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.error || 'Photo upload failed'); }
    }
    btn.closest('.fixed').remove();
    showToast(id ? 'Vehicle updated' : 'Vehicle added', 'success');
    if (typeof loadInventoryCatalog === 'function') loadInventoryCatalog();
  } catch (e) { btn.disabled = false; btn.textContent = orig; showToast(e.message, 'error'); }
}
// Per-car: write an AI sales pitch and drop it into the form's textarea.
async function vehGenPitch(id, btn) {
  const orig = btn.textContent; btn.disabled = true; btn.textContent = '✨ Writing…';
  try {
    const d = await apiSendJson('/ai/sales-pitch', 'POST', { ids: [id] });
    const text = d.pitches && d.pitches[id];
    if (text) { const ta = document.getElementById('veh-pitch'); if (ta) ta.value = text; showToast('Sales pitch written — review & Save', 'success'); }
    else showToast(d.limited ? 'Monthly AI limit reached — resets next month.' : 'Could not generate a pitch', 'error');
  } catch (e) { showToast(e.message === 'AI Boost not active' ? 'Sales pitches need AI Boost (or your free trial).' : e.message, 'error'); }
  finally { btn.disabled = false; btn.textContent = orig; }
}
// Bulk: write pitches for every available car that doesn't have one yet.
async function generateAllPitches(btn) {
  let inv = (typeof __catalogCache !== 'undefined' && __catalogCache?.length) ? __catalogCache : [];
  if (!inv.length) { try { inv = await apiGetJson('/inventory/all', { retries: 1 }); } catch {} }
  const avail = inv.filter(v => String(v.status || 'available').toLowerCase() === 'available');
  const missing = avail.filter(v => !(v.sales_pitch && String(v.sales_pitch).trim()));
  const ids = (missing.length ? missing : avail).map(v => v.id);
  if (!ids.length) { showToast('No available vehicles to write for.', 'info'); return; }
  const verb = missing.length ? `Write AI sales pitches for the ${ids.length} car${ids.length > 1 ? 's' : ''} without one?` : `Every car already has a pitch. Re-write all ${ids.length}?`;
  if (!confirm(`${verb} This uses AI Boost credits.`)) return;
  const orig = btn.textContent; btn.disabled = true; btn.textContent = `✨ Writing ${ids.length}…`;
  try {
    const d = await apiSendJson('/ai/sales-pitch', 'POST', { ids });
    showToast(`Wrote ${d.count} sales pitch${d.count === 1 ? '' : 'es'}${d.limited ? ' — hit the monthly AI limit' : ''}`, d.count ? 'success' : 'error');
    if (typeof loadInventoryCatalog === 'function') loadInventoryCatalog();
  } catch (e) { btn.disabled = false; btn.textContent = orig; showToast(e.message === 'AI Boost not active' ? 'Sales pitches need AI Boost (or your free trial).' : e.message, 'error'); }
}
async function vehDelete(id) {
  if (!id || !confirm('Delete this vehicle and its photos? This cannot be undone.')) return;
  try {
    await apiSendJson(`/inventory/${id}`, 'DELETE');
    showToast('Vehicle deleted', 'success');
    document.querySelector('.fixed')?.remove();
    if (typeof loadInventoryCatalog === 'function') loadInventoryCatalog();
  } catch (e) { showToast(e.message, 'error'); }
}
function editVehicle(id) { const v = (typeof __catalogCache !== 'undefined' ? __catalogCache : []).find(x => x.id === id); if (v) openVehicleForm(v); }

// Upload/replace the dealership's branded photo background (used by the AI swap).
function openPhotoBackgroundUploader() {
  const ov = crmOverlay(`<div class="p-5 space-y-3">
    <div class="flex items-center justify-between">
      <div class="text-lg font-black text-slate-900 dark:text-white">Branded photo background</div>
      <button onclick="this.closest('.fixed').remove()" class="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"><svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" d="M6 6l12 12M18 6L6 18"/></svg></button>
    </div>
    <p class="text-sm text-slate-500 dark:text-slate-400">Upload one background (your lot, a studio backdrop, a branded scene). When you add vehicle photos you can drop them onto it — the AI cuts out the car and places it on this background.</p>
    ${!__bgProviderReady ? '<div class="text-xs bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-900 rounded-lg p-2 text-amber-700 dark:text-amber-300">The AI cutout provider isn\'t enabled yet — set REMOVEBG_API_KEY to turn on background swapping. You can still upload the background now.</div>' : ''}
    <div id="pbg-preview">${__photoBackgroundUrl ? `<img src="${esc(__photoBackgroundUrl)}" class="w-full h-40 object-cover rounded-lg border border-slate-200 dark:border-slate-700">` : '<div class="w-full h-40 rounded-lg bg-slate-100 dark:bg-slate-800 flex items-center justify-center text-sm text-slate-400">No background set</div>'}</div>
    <input id="pbg-file" type="file" accept="image/*" class="hidden" onchange="uploadPhotoBackground(this.files[0])">
    <div class="flex gap-2 justify-between">
      <div>${__photoBackgroundUrl ? '<button onclick="removePhotoBackground()" class="text-sm font-bold text-rose-600 hover:text-rose-500 px-2 py-2">Remove</button>' : ''}</div>
      <button onclick="document.getElementById('pbg-file').click()" class="text-sm font-bold bg-indigo-600 hover:bg-indigo-500 text-white px-4 py-2 rounded-lg">${__photoBackgroundUrl ? 'Replace background' : 'Upload background'}</button>
    </div>
  </div>`, 'max-w-md');
  return ov;
}
async function uploadPhotoBackground(file) {
  if (!file) return;
  showToast('Uploading background…', 'info');
  try {
    const fd = new FormData(); fd.append('background', file);
    const r = await fetch(`${API}/dealership/photo-background`, { method: 'POST', headers: { 'Authorization': `Bearer ${token}` }, body: fd });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'Upload failed');
    __photoBackgroundUrl = d.url;
    showToast('Background saved', 'success');
    document.querySelector('.fixed')?.remove();
  } catch (e) { showToast(e.message, 'error'); }
}
async function removePhotoBackground() {
  try {
    await apiSendJson('/dealership/photo-background', 'DELETE');
    __photoBackgroundUrl = null;
    showToast('Background removed', 'success');
    document.querySelector('.fixed')?.remove();
  } catch (e) { showToast(e.message, 'error'); }
}
// ── Website manager: the public dealer site we host ──────────────────────────
const SITE_BASE = (location.origin && !/^file/.test(location.origin)) ? `${location.origin}/site.html` : 'https://marketsync.link/site.html';
// The settings form body (shared by the Website → Settings tab and the modal).
function siteSettingsFields(cfg) {
  const c = cfg.content || {};
  const publicUrl = cfg.site_slug ? `${SITE_BASE}?d=${encodeURIComponent(cfg.site_slug)}` : null;
  const inp = (id, v, ph, cls = '') => `<input id="${id}" value="${esc(v == null ? '' : v)}" placeholder="${esc(ph)}" class="${cls} bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded-lg px-3 py-2 text-sm">`;
  const lbl = (t) => `<label class="block text-[11px] font-semibold text-slate-500 dark:text-slate-400 mb-1">${t}</label>`;
  const ta = (id, v, ph, rows, mono) => `<textarea id="${id}" rows="${rows}" placeholder="${esc(ph)}" class="w-full ${mono ? 'font-mono text-[11px]' : 'text-sm'} bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded-lg px-3 py-2">${esc(v || '')}</textarea>`;
  return `
    ${publicUrl ? `<div class="flex items-center gap-2 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded-lg px-3 py-2">
      <span class="text-xs text-slate-600 dark:text-slate-300 truncate flex-1">${esc(publicUrl)}</span>
      <button onclick="navigator.clipboard?.writeText('${publicUrl}');showToast('Link copied','success')" class="text-xs font-bold text-indigo-600 dark:text-indigo-400">Copy</button>
      <a href="${publicUrl}" target="_blank" class="text-xs font-bold text-indigo-600 dark:text-indigo-400">Open ↗</a>
    </div>` : ''}
    <div class="flex items-center gap-2">
      <div class="flex-1">${lbl('Site address (letters, numbers, dashes)')}
        <div class="flex items-center gap-1 text-sm"><span class="text-xs text-slate-400 whitespace-nowrap">…/site.html?d=</span>${inp('site-slug', cfg.site_slug, 'welland-chev', 'flex-1')}</div>
      </div>
      <label class="flex items-center gap-1.5 text-sm font-bold mt-4 whitespace-nowrap"><input id="site-pub" type="checkbox" ${cfg.site_published ? 'checked' : ''} class="accent-indigo-600 w-4 h-4">Published</label>
    </div>
    <div class="grid grid-cols-1 gap-2">
      <div>${lbl('Headline / tagline')}${inp('site-tagline', c.tagline, 'Your trusted local dealership', 'w-full')}</div>
      <div>${lbl('About')}${ta('site-about', c.about, 'A sentence or two about your store', 2)}</div>
      <div class="grid grid-cols-2 gap-2">
        <div>${lbl('Phone')}${inp('site-phone', c.phone, '905-555-1234', 'w-full')}</div>
        <div>${lbl('Email')}${inp('site-email', c.email, 'sales@…', 'w-full')}</div>
      </div>
      <div>${lbl('Address')}${inp('site-address', c.address, 'Street, City', 'w-full')}</div>
      <div>${lbl('Hours')}${ta('site-hours', c.hours, 'Mon–Fri 9–6, Sat 9–5', 2)}</div>
      <div class="grid grid-cols-2 gap-2">
        <div>${lbl('Brand colour')}<input id="site-color" type="color" value="${esc(c.primary_color || '#1e3a8a')}" class="w-full h-9 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded-lg"></div>
        <div>${lbl('Hero image')}<div class="flex gap-1">${inp('site-hero', c.hero_url, 'Paste URL or upload', 'flex-1')}<input id="site-hero-file" type="file" accept="image/*" class="hidden" onchange="uploadSiteImage('site-hero', this.files[0])"><button type="button" onclick="document.getElementById('site-hero-file').click()" class="text-xs font-bold bg-slate-200 dark:bg-slate-700 hover:bg-slate-300 dark:hover:bg-slate-600 text-slate-700 dark:text-slate-200 px-3 rounded-lg">Upload</button></div></div>
      </div>
      <div class="grid grid-cols-2 gap-2">
        <div>${lbl('Facebook URL')}${inp('site-fb', c.facebook_url, 'https://facebook.com/…', 'w-full')}</div>
        <div>${lbl('Instagram URL')}${inp('site-ig', c.instagram_url, 'https://instagram.com/…', 'w-full')}</div>
      </div>
    </div>
    <div class="border-t border-slate-200 dark:border-slate-700 pt-3">
      <div class="text-sm font-black text-slate-900 dark:text-white">Build &amp; Price brands</div>
      <p class="text-[11px] text-slate-400 mb-2">Which brands do you sell new? Only these appear on your Build &amp; Price page — keeps used trade-ins and off-brands out. Leave all unchecked to auto-detect from your new inventory.</p>
      <div id="bm-wrap" class="flex flex-wrap gap-x-3 gap-y-1">${(() => { const set = new Set((c.build_makes || []).map(s => String(s).toLowerCase())); return ['Chevrolet', 'GMC', 'Buick', 'Cadillac', 'Ford', 'Lincoln', 'Toyota', 'Honda', 'Nissan', 'Hyundai', 'Kia', 'Mazda', 'Subaru', 'Volkswagen', 'Jeep', 'Ram', 'Dodge', 'Chrysler'].map(b => `<label class="flex items-center gap-1.5 text-xs text-slate-700 dark:text-slate-200"><input type="checkbox" class="bm-check accent-indigo-600" value="${b}" ${set.has(b.toLowerCase()) ? 'checked' : ''}>${b}</label>`).join(''); })()}</div>
    </div>
    <div class="border-t border-slate-200 dark:border-slate-700 pt-3">
      <div class="text-sm font-black text-slate-900 dark:text-white">SEO</div>
      <p class="text-[11px] text-slate-400 mb-2">How your site shows in Google and when shared. Leave blank to auto-generate from your name, city and About.</p>
      <div class="space-y-2">
        <div>${lbl('Page title (Google tab, ~60 chars)')}${inp('seo-title', c.seo_title, 'Welland Chevrolet Buick GMC | New & Used in Welland', 'w-full')}</div>
        <div>${lbl('Meta description (~155 chars)')}${ta('seo-desc', c.seo_description, 'Shop new and used Chevrolet, Buick & GMC in Welland. Build & price, get financing, value your trade.', 2)}</div>
        <div>${lbl('Keywords (comma separated, optional)')}${inp('seo-keywords', c.seo_keywords, 'Chevrolet Welland, used trucks Niagara, GMC dealer', 'w-full')}</div>
        <div>${lbl('Social share image')}<div class="flex gap-1">${inp('seo-image', c.seo_image, 'Paste URL or upload (falls back to hero)', 'flex-1')}<input id="seo-image-file" type="file" accept="image/*" class="hidden" onchange="uploadSiteImage('seo-image', this.files[0])"><button type="button" onclick="document.getElementById('seo-image-file').click()" class="text-xs font-bold bg-slate-200 dark:bg-slate-700 hover:bg-slate-300 dark:hover:bg-slate-600 text-slate-700 dark:text-slate-200 px-3 rounded-lg">Upload</button></div></div>
      </div>
    </div>
    <div class="border-t border-slate-200 dark:border-slate-700 pt-3">
      <div class="text-sm font-black text-slate-900 dark:text-white">Widgets &amp; integrations</div>
      <p class="text-[11px] text-slate-400 mb-2">Paste embed code from Keyloop, Equifax, trade-value tools, chat or AI tools. Global scripts (analytics/chat) go in “site-wide code”; placed embeds appear as blocks in a chosen section.</p>
      ${lbl('Site-wide code — runs in the page &lt;head&gt;')}
      ${ta('site-head', c.head_html, '<script>…</script> — analytics, chat, Keyloop tags', 3, true)}
      <div class="flex items-center justify-between mt-3 mb-1">
        <label class="text-[11px] font-semibold text-slate-500 dark:text-slate-400">Placed widgets</label>
        <button type="button" onclick="addSiteWidget()" class="text-xs font-bold text-indigo-600 dark:text-indigo-400">+ Add widget</button>
      </div>
      <div id="site-widget-list" class="space-y-2"></div>
    </div>
    <div class="text-[11px] text-slate-400">Pages, Team and design live on their own tabs. Logo comes from your branding.</div>`;
}
async function openSiteManager() {
  let cfg = {};
  try { cfg = await apiGetJson('/dealership/site'); } catch (e) { showToast(e.message, 'error'); return; }
  crmOverlay(`<div class="p-5 space-y-3">
    <div class="flex items-center justify-between">
      <div class="text-lg font-black text-slate-900 dark:text-white">Website settings</div>
      <button onclick="this.closest('.fixed').remove()" class="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"><svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" d="M6 6l12 12M18 6L6 18"/></svg></button>
    </div>
    ${siteSettingsFields(cfg)}
    <div class="flex gap-2 justify-end pt-1">
      <button onclick="this.closest('.fixed').remove()" class="text-sm font-bold text-slate-500 px-4 py-2">Cancel</button>
      <button onclick="saveSite(this)" class="text-sm font-bold bg-indigo-600 hover:bg-indigo-500 text-white px-4 py-2 rounded-lg">Save</button>
    </div>
  </div>`, 'max-w-lg');
  __siteWidgets = Array.isArray(cfg.content?.widgets) ? cfg.content.widgets.slice() : [];
  renderSiteWidgets();
}
// Website → Settings tab (same form, inline instead of a modal).
function wsSettings() {
  if (!__siteCfg) return '<div class="mt-4 text-sm text-slate-400">Loading…</div>';
  return `<div class="mt-4 max-w-2xl space-y-3">${siteSettingsFields(__siteCfg)}
    <div class="flex justify-end pt-1"><button onclick="saveSite(this)" class="text-sm font-bold bg-indigo-600 hover:bg-indigo-500 text-white px-5 py-2 rounded-lg">Save settings</button></div>
  </div>`;
}
// Upload an image (hero/page) → returns a public URL into the given input field.
async function uploadSiteImage(targetId, file) {
  if (!file) return;
  showToast('Uploading image…', 'info');
  try {
    const fd = new FormData(); fd.append('image', file);
    const r = await fetch(`${API}/dealership/site-image`, { method: 'POST', headers: { 'Authorization': `Bearer ${token}` }, body: fd });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'Upload failed');
    const el = document.getElementById(targetId); if (el) el.value = d.url;
    showToast('Image uploaded', 'success');
  } catch (e) { showToast(e.message, 'error'); }
}
let __sitePages = [];
// Built-in pages that ship with every site — dealer can rename or switch off.
const BUILTIN_META = [
  ['inventory', 'Inventory', 'Your live stock, searchable & filterable'],
  ['build', 'Build & Price', 'Configure a new vehicle from your franchise lineup'],
  ['trade', 'Value Trade', 'Trade-in appraisal request form'],
  ['finance', 'Financing', 'Get-pre-approved credit application'],
  ['team', 'Team', 'Your staff, grouped by department'],
  ['contact', 'Contact', 'General contact / inquiry form'],
];
let __siteBuiltins = {};
function defaultBuiltins() { const o = {}; for (const [k, label] of BUILTIN_META) o[k] = { enabled: true, label }; return o; }
function normBuiltins(src) {
  const o = defaultBuiltins();
  if (src && typeof src === 'object') for (const [k, def] of BUILTIN_META) { const v = src[k] || {}; o[k] = { enabled: v.enabled !== false, label: (v.label || def).toString().slice(0, 40) }; }
  return o;
}
function collectBuiltins() {
  if (!document.getElementById('builtin-page-list')) return;
  for (const [k] of BUILTIN_META) {
    const row = document.querySelector(`#builtin-page-list [data-bi="${k}"]`); if (!row) continue;
    __siteBuiltins[k] = { enabled: row.querySelector('.bi-on')?.checked !== false, label: (row.querySelector('.bi-label')?.value || '').trim() || __siteBuiltins[k]?.label || k };
  }
}
function renderBuiltinPages() {
  const box = document.getElementById('builtin-page-list'); if (!box) return;
  box.innerHTML = BUILTIN_META.map(([k, def, desc]) => {
    const b = __siteBuiltins[k] || { enabled: true, label: def };
    return `<div data-bi="${k}" class="border border-slate-200 dark:border-slate-700 rounded-lg p-2 flex items-center gap-2 ${b.enabled ? '' : 'opacity-60'}">
      <label class="relative inline-flex items-center cursor-pointer shrink-0"><input type="checkbox" class="bi-on sr-only peer" ${b.enabled ? 'checked' : ''} onchange="collectBuiltins();renderBuiltinPages()"><div class="w-9 h-5 bg-slate-300 dark:bg-slate-600 peer-checked:bg-indigo-600 rounded-full after:content-[''] after:absolute after:top-0.5 after:left-0.5 after:bg-white after:rounded-full after:h-4 after:w-4 after:transition peer-checked:after:translate-x-4"></div></label>
      <input class="bi-label flex-1 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded px-2 py-1 text-xs font-semibold" value="${esc(b.label || def)}" placeholder="${esc(def)}">
      <span class="text-[10px] text-slate-400 hidden sm:block w-56 shrink-0">${esc(desc)}</span>
    </div>`;
  }).join('');
}
function collectSitePages() {
  // Only read from the DOM when the Pages editor is actually rendered; otherwise
  // keep __sitePages as loaded so a save from another tab never wipes pages.
  if (!document.getElementById('site-page-list')) return;
  // Preserve make/model/kind (not shown in the editor) by merging with existing.
  __sitePages = Array.from(document.querySelectorAll('#site-page-list [data-pgx]')).map((r, idx) => ({
    ...(__sitePages[idx] || {}),
    title: r.querySelector('.pg-title')?.value || '',
    nav: r.querySelector('.pg-nav')?.checked !== false,
    menu: (r.querySelector('.pg-menu')?.value || '').trim() || null,
    body_html: r.querySelector('.pg-body')?.value || '',
  }));
}
function renderSitePages() {
  const box = document.getElementById('site-page-list');
  if (!box) return;
  if (!__sitePages.length) { box.innerHTML = '<div class="text-[11px] text-slate-400 italic">No extra pages.</div>'; return; }
  const badge = (p) => p.kind === 'model' ? '<span class="text-[9px] font-bold bg-blue-100 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300 px-1.5 py-0.5 rounded-full">Model · auto-inventory</span>'
    : p.kind === 'incentive' ? '<span class="text-[9px] font-bold bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300 px-1.5 py-0.5 rounded-full">Offer</span>' : '';
  const menus = [...new Set(__sitePages.map(p => p.menu).filter(Boolean))];
  box.innerHTML = __sitePages.map((p, i) => `<div data-pgx="${i}" class="border border-slate-200 dark:border-slate-700 rounded-lg p-2 space-y-1">
    <div class="flex gap-2 items-center">
      <input class="pg-title flex-1 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded px-2 py-1 text-xs" placeholder="Page title (e.g. About Us)" value="${esc(p.title || '')}">
      ${badge(p)}
      <label class="flex items-center gap-1 text-[11px] text-slate-500"><input class="pg-nav" type="checkbox" ${p.nav !== false ? 'checked' : ''}>In nav</label>
      <button type="button" onclick="collectSitePages();wsSetTarget(${i})" title="Build this page's hero, CTAs and sections" class="text-[11px] font-bold text-indigo-600 dark:text-indigo-400 whitespace-nowrap">✎ Customize${(p.sections && p.sections.length) ? ' ('+p.sections.length+')' : ''}</button>
      <button type="button" onclick="removeSitePage(${i})" class="text-rose-500 text-xs font-bold">✕</button>
    </div>
    <div class="flex items-center gap-1"><span class="text-[10px] text-slate-400 shrink-0">Menu group</span><input class="pg-menu flex-1 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded px-2 py-1 text-xs" list="pg-menu-opts" placeholder="(none — top-level link)" value="${esc(p.menu || '')}"></div>
    <textarea class="pg-body w-full text-xs bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded px-2 py-1" rows="${p.kind === 'model' ? 2 : 3}" placeholder="${p.kind === 'model' ? 'Intro blurb (optional) — inventory lists automatically below it. ✨ generate with AI.' : 'Page content — plain text or basic HTML'}">${esc(p.body_html || '')}</textarea>
  </div>`).join('') + `<datalist id="pg-menu-opts">${['New Vehicles','Pre-Owned','Offers','About','Financing'].concat(menus).filter((v,i,a)=>a.indexOf(v)===i).map(m => `<option value="${esc(m)}">`).join('')}</datalist>`;
}
// Auto-build model pages (from your inventory) + standard offer pages.
async function autoBuildPages(btn) {
  const orig = btn.textContent; btn.disabled = true; btn.textContent = 'Building…';
  try {
    let inv = (typeof __catalogCache !== 'undefined' && __catalogCache?.length) ? __catalogCache : [];
    if (!inv.length) { try { inv = await apiGetJson('/inventory/all', { retries: 1 }); } catch {} }
    const avail = inv.filter(v => String(v.status || 'available').toLowerCase() === 'available');
    // Distinct make+model.
    const seen = new Map();
    for (const v of avail) { if (!v.make || !v.model) continue; const key = `${v.make} ${v.model}`.toLowerCase(); if (!seen.has(key)) seen.set(key, { make: v.make, model: v.model }); }
    collectSitePages();
    const have = new Set(__sitePages.map(p => (p.title || '').toLowerCase()));
    let added = 0;
    for (const { make, model } of seen.values()) {
      const title = `${make} ${model}`;
      if (have.has(title.toLowerCase())) continue;
      // Group each model page under its make → becomes a nav dropdown automatically.
      __sitePages.push({ title, make, model, kind: 'model', nav: true, menu: `${make} Lineup`, body_html: '' });
      have.add(title.toLowerCase()); added++;
    }
    for (const t of ['Current Offers', 'Finance Offers', 'Lease Offers', 'EV Rebates']) {
      if (have.has(t.toLowerCase())) continue;
      __sitePages.push({ title: t, kind: 'incentive', nav: true, menu: 'Offers', body_html: '' });
      have.add(t.toLowerCase()); added++;
    }
    renderSitePages();
    showToast(added ? `Added ${added} page${added === 1 ? '' : 's'} — review & Save` : 'Pages already exist', 'success');
  } catch (e) { showToast(e.message, 'error'); }
  finally { btn.disabled = false; btn.textContent = orig; }
}
window.autoBuildPages = autoBuildPages;
function addSitePage() { collectSitePages(); __sitePages.push({ title: '', nav: true, body_html: '' }); renderSitePages(); }
function removeSitePage(i) { collectSitePages(); __sitePages.splice(i, 1); renderSitePages(); }
const SITE_SLOTS = [['top_banner', 'Top banner'], ['hero_below', 'Under hero'], ['above_inventory', 'Above inventory'], ['below_inventory', 'Below inventory'], ['above_footer', 'Above footer']];
let __siteWidgets = [];
function collectSiteWidgets() {
  const rows = document.querySelectorAll('#site-widget-list [data-widx]');
  __siteWidgets = Array.from(rows).map(r => ({
    slot: r.querySelector('.wg-slot')?.value || 'below_inventory',
    title: r.querySelector('.wg-title')?.value || '',
    html: r.querySelector('.wg-html')?.value || '',
    height: parseInt(r.querySelector('.wg-height')?.value) || 400,
  }));
}
function renderSiteWidgets() {
  const box = document.getElementById('site-widget-list');
  if (!box) return;
  if (!__siteWidgets.length) { box.innerHTML = '<div class="text-[11px] text-slate-400 italic">No widgets yet.</div>'; return; }
  box.innerHTML = __siteWidgets.map((w, i) => `<div data-widx="${i}" class="border border-slate-200 dark:border-slate-700 rounded-lg p-2 space-y-1">
    <div class="flex gap-2 items-center">
      <select class="wg-slot bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded px-2 py-1 text-xs">${SITE_SLOTS.map(s => `<option value="${s[0]}" ${w.slot === s[0] ? 'selected' : ''}>${s[1]}</option>`).join('')}</select>
      <input class="wg-title flex-1 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded px-2 py-1 text-xs" placeholder="Title (optional)" value="${esc(w.title || '')}">
      <input class="wg-height bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded px-2 py-1 text-xs" type="number" value="${w.height || 400}" style="width:64px" title="Height (px)">
      <button type="button" onclick="removeSiteWidget(${i})" class="text-rose-500 text-xs font-bold">✕</button>
    </div>
    <textarea class="wg-html w-full font-mono text-[11px] bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded px-2 py-1" rows="2" placeholder="&lt;iframe …&gt; or embed code">${esc(w.html || '')}</textarea>
  </div>`).join('');
}
function addSiteWidget() { collectSiteWidgets(); __siteWidgets.push({ slot: 'below_inventory', title: '', html: '', height: 400 }); renderSiteWidgets(); }
function removeSiteWidget(i) { collectSiteWidgets(); __siteWidgets.splice(i, 1); renderSiteWidgets(); }
async function saveSite(btn) {
  const val = (i) => (document.getElementById(i)?.value || '').trim();
  collectSiteWidgets();
  const body = {
    site_slug: val('site-slug'), site_published: document.getElementById('site-pub')?.checked || false,
    tagline: val('site-tagline'), about: val('site-about'), phone: val('site-phone'), email: val('site-email'),
    address: val('site-address'), hours: val('site-hours'), primary_color: val('site-color'), hero_url: val('site-hero'),
    facebook_url: val('site-fb'), instagram_url: val('site-ig'),
    seo_title: val('seo-title'), seo_description: val('seo-desc'), seo_keywords: val('seo-keywords'), seo_image: val('seo-image'),
    head_html: document.getElementById('site-head')?.value || '',
    widgets: __siteWidgets.filter(w => (w.html || '').trim()),
  };
  if (document.getElementById('bm-wrap')) body.build_makes = Array.from(document.querySelectorAll('.bm-check:checked')).map(el => el.value);
  const orig = btn.textContent; btn.disabled = true; btn.textContent = 'Saving…';
  try {
    await apiSendJson('/dealership/site', 'PUT', body);
    showToast('Website saved', 'success');
    btn.disabled = false; btn.textContent = orig;
    const modal = btn.closest('.fixed');
    if (modal) { modal.remove(); openSiteManager(); }        // modal context: reopen fresh
    else if (typeof loadWebsitePage === 'function') { __wsTab = 'settings'; loadWebsitePage(); } // tab context: refresh in place
  } catch (e) { btn.disabled = false; btn.textContent = orig; showToast(e.message, 'error'); }
}
window.openSiteManager = openSiteManager;
window.saveSite = saveSite;
window.addSiteWidget = addSiteWidget;
window.removeSiteWidget = removeSiteWidget;
window.addSitePage = addSitePage;
window.removeSitePage = removeSitePage;
window.uploadSiteImage = uploadSiteImage;

// ══ Website page builder (Squarespace-simple, dealership-aware) ═══════════════
// __siteSections = the ACTIVE editing buffer. __wsTarget = 'home' or a page index.
// The home layout lives in __homeSections; each page's layout in __sitePages[i].sections.
let __siteCfg = null, __siteSections = [], __homeSections = [], __wsTarget = 'home', __wsTab = 'builder';
const SEC_META = {
  hero:               { label: 'Hero', fields: [['image','Background image','image'],['headline','Headline','text'],['subheadline','Subheadline','text'],['button_label','Button label','text'],['button_target','Button goes to','target'],['button_link','Custom link','text'],['overlay','Image darkness','range'],['height','Height','height']] },
  featured_inventory: { label: 'Featured inventory', fields: [['title','Title','text'],['condition','Show','cond'],['count','How many','number']] },
  inventory_grid:     { label: 'Inventory grid', fields: [['title','Title','text']] },
  trade_cta:          { label: 'Trade-in banner', fields: [['title','Title','text'],['subtitle','Subtitle','text'],['button_label','Button label','text']] },
  finance_cta:        { label: 'Finance banner', fields: [['title','Title','text'],['subtitle','Subtitle','text'],['button_label','Button label','text']] },
  service_cta:        { label: 'Service banner', fields: [['title','Title','text'],['subtitle','Subtitle','text'],['button_label','Button label','text'],['button_target','Button goes to','target'],['button_link','Custom link','text']] },
  cta_banner:         { label: 'Call-to-action banner', fields: [['title','Title','text'],['button_label','Button label','text'],['button_target','Button goes to','target'],['button_link','Custom link','text']] },
  staff:              { label: 'Meet the team', fields: [['title','Title','text']] },
  reviews:            { label: 'Reviews', fields: [['title','Title','text'],['embed_html','Reviews embed code','textarea']] },
  faq:                { label: 'FAQ', fields: [['title','Title','text'],['items','Questions (one per line: Question :: Answer)','faq']] },
  gallery:            { label: 'Photo gallery', fields: [['title','Title','text'],['images','Images','images']] },
  map:                { label: 'Map', fields: [['title','Title','text'],['address','Address (blank = your address)','text']] },
  contact:            { label: 'Contact form', fields: [['title','Title','text']] },
  html:               { label: 'Custom HTML', fields: [['html','HTML','textarea']] },
};
const SEC_ORDER = ['hero','featured_inventory','inventory_grid','trade_cta','finance_cta','service_cta','staff','reviews','faq','gallery','map','contact','cta_banner','html'];

async function loadWebsitePage() {
  const root = document.getElementById('website-root');
  if (!root) return;
  root.innerHTML = '<div class="py-16 text-center text-sm text-slate-400 italic">Loading…</div>';
  try { __siteCfg = await apiGetJson('/dealership/site'); } catch (e) { root.innerHTML = `<div class="py-16 text-center text-sm text-slate-500">Couldn't load: ${esc(e.message)}</div>`; return; }
  __homeSections = Array.isArray(__siteCfg.content?.sections) ? __siteCfg.content.sections.slice() : [];
  __sitePages = Array.isArray(__siteCfg.content?.pages) ? __siteCfg.content.pages.map(p => ({ ...p, sections: Array.isArray(p.sections) ? p.sections : [] })) : [];
  __siteStaff = Array.isArray(__siteCfg.content?.staff) ? __siteCfg.content.staff.slice() : [];
  __siteBuiltins = normBuiltins(__siteCfg.content?.builtins);
  __wsTarget = 'home'; __siteSections = __homeSections;
  renderWebsitePage();
}
// Move the active buffer back onto its source (home or a page) before switching/saving.
function wsFlushTarget() {
  if (__wsTarget === 'home') __homeSections = __siteSections;
  else if (__sitePages[__wsTarget]) __sitePages[__wsTarget].sections = __siteSections;
}
function wsSetTarget(v) {
  wsFlushTarget();
  __wsTarget = v === 'home' ? 'home' : parseInt(v);
  __siteSections = __wsTarget === 'home' ? (__homeSections || []) : (Array.isArray(__sitePages[__wsTarget]?.sections) ? __sitePages[__wsTarget].sections : []);
  __wsTab = 'builder'; renderWsBody();
}
function renderWebsitePage() {
  const root = document.getElementById('website-root'); if (!root) return;
  const c = __siteCfg.content || {};
  const url = __siteCfg.site_slug ? `${SITE_BASE}?d=${encodeURIComponent(__siteCfg.site_slug)}` : null;
  const tab = (id, label) => `<button onclick="wsTab('${id}')" class="px-4 py-2 text-sm font-bold border-b-2 transition ${__wsTab === id ? 'border-indigo-500 text-indigo-600 dark:text-indigo-400' : 'border-transparent text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'}">${label}</button>`;
  root.innerHTML = `
    <div class="flex items-start justify-between gap-3 flex-wrap">
      <div>
        <h2 class="text-xl font-bold text-slate-900 dark:text-white">Website</h2>
        <p class="text-sm text-slate-500 dark:text-slate-400 mt-1">Professional dealership site anyone can edit. Add sections, no code required.</p>
      </div>
      <div class="flex items-center gap-2 flex-wrap">
        ${url ? `<a href="${url}" target="_blank" class="text-xs font-bold bg-slate-100 dark:bg-slate-800 border border-slate-300 dark:border-slate-700 px-3 py-2 rounded-lg">View site ↗</a>` : ''}
        <label class="flex items-center gap-1.5 text-sm font-bold"><input id="ws-pub" type="checkbox" ${__siteCfg.site_published ? 'checked' : ''} class="accent-indigo-600 w-4 h-4">Published</label>
        <button onclick="wsTab('settings')" class="text-xs font-bold bg-slate-100 dark:bg-slate-800 border border-slate-300 dark:border-slate-700 px-3 py-2 rounded-lg">Settings</button>
        <button onclick="saveWebsite(this)" class="text-sm font-bold bg-indigo-600 hover:bg-indigo-500 text-white px-4 py-2 rounded-lg">Save</button>
      </div>
    </div>
    <div class="flex items-center gap-1 border-b border-slate-200 dark:border-slate-800 flex-wrap">${tab('builder', 'Builder')}${tab('design', 'Design')}${tab('pages', 'Pages')}${tab('team', 'Team')}${tab('settings', 'Settings')}</div>
    <div id="ws-body"></div>`;
  renderWsBody();
}
function wsTab(t) { __wsTab = t; renderWsBody(); }
function renderWsBody() {
  const body = document.getElementById('ws-body'); if (!body) return;
  if (__wsTab === 'design') { body.innerHTML = wsDesign(); return; }
  if (__wsTab === 'pages') { body.innerHTML = wsPages(); renderBuiltinPages(); renderSitePages(); return; }
  if (__wsTab === 'team') { body.innerHTML = wsTeam(); renderSiteStaff(); return; }
  if (__wsTab === 'settings') { body.innerHTML = wsSettings(); __siteWidgets = Array.isArray(__siteCfg?.content?.widgets) ? __siteCfg.content.widgets.slice() : []; renderSiteWidgets(); return; }
  // Builder
  const palette = SEC_ORDER.map(t => `<button onclick="addSection('${t}')" class="text-left text-xs font-semibold bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded-lg px-3 py-2 hover:border-indigo-400">+ ${SEC_META[t].label}</button>`).join('');
  const pageOpts = (__sitePages || []).map((p, i) => `<option value="${i}" ${__wsTarget === i ? 'selected' : ''}>${esc(p.title || 'Untitled page')}</option>`).join('');
  body.innerHTML = `
    <div class="flex items-center gap-2 mt-4 mb-2 flex-wrap">
      <span class="text-xs font-bold text-slate-500 dark:text-slate-400">Editing:</span>
      <select onchange="wsSetTarget(this.value)" class="text-sm font-bold bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded-lg px-3 py-1.5">
        <option value="home" ${__wsTarget === 'home' ? 'selected' : ''}>🏠 Home page</option>${pageOpts}
      </select>
      <span class="text-[11px] text-slate-400 flex-1">Build each page with its own hero, CTAs and sections — just like home.</span>
      <button onclick="openTemplatePicker()" class="text-xs font-bold bg-violet-600 hover:bg-violet-500 text-white px-3 py-1.5 rounded-lg">Template</button>
    </div>
    <div class="grid lg:grid-cols-[minmax(0,1fr)_240px] gap-4">
      <div id="ws-sections" class="space-y-2"></div>
      <div class="lg:sticky lg:top-4 self-start">
        <div class="text-[11px] font-bold uppercase tracking-wider text-slate-400 mb-2">+ Add section</div>
        <div class="grid grid-cols-1 gap-1.5">${palette}</div>
      </div>
    </div>`;
  renderWsSections();
}
function renderWsSections() {
  const box = document.getElementById('ws-sections'); if (!box) return;
  if (!__siteSections.length) { box.innerHTML = '<div class="text-sm text-slate-400 italic border-2 border-dashed border-slate-200 dark:border-slate-700 rounded-xl p-8 text-center">No sections yet. Add one from the right →<br><span class="text-xs">(If you leave this empty, your site uses the default layout.)</span></div>'; return; }
  box.innerHTML = __siteSections.map((sec, i) => `
    <div class="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
      <div class="flex items-center gap-2 px-3 py-2 bg-slate-50 dark:bg-slate-950 border-b border-slate-200 dark:border-slate-800">
        <span class="font-bold text-sm text-slate-800 dark:text-slate-100 flex-1">${esc(SEC_META[sec.type]?.label || sec.type)}</span>
        <button onclick="moveSection(${i},-1)" ${i === 0 ? 'disabled' : ''} class="text-slate-400 hover:text-slate-700 disabled:opacity-30 px-1" title="Move up">↑</button>
        <button onclick="moveSection(${i},1)" ${i === __siteSections.length - 1 ? 'disabled' : ''} class="text-slate-400 hover:text-slate-700 disabled:opacity-30 px-1" title="Move down">↓</button>
        <button onclick="dupSection(${i})" class="text-slate-400 hover:text-slate-700 px-1" title="Duplicate">⧉</button>
        <button onclick="delSection(${i})" class="text-rose-500 hover:text-rose-600 px-1" title="Delete">✕</button>
      </div>
      <div class="p-3 grid sm:grid-cols-2 gap-2">${(SEC_META[sec.type]?.fields || []).map(f => wsField(i, sec, f)).join('')}</div>
    </div>`).join('');
}
const WS_AI_KIND = { headline: 'headline', subheadline: 'subheadline', title: 'headline', subtitle: 'subheadline', button_label: 'cta', items: 'faq', html: 'text', embed_html: 'text' };
function wsField(i, sec, [key, label, type]) {
  const v = sec.settings?.[key];
  const aiKind = WS_AI_KIND[key];
  const lbl = `<div class="flex items-center justify-between mb-1"><label class="block text-[11px] font-semibold text-slate-500 dark:text-slate-400">${label}</label>${aiKind ? `<button type="button" onclick="aiMenu(event,${i},'${key}','${aiKind}')" class="text-[11px] font-bold text-violet-600 dark:text-violet-400 hover:text-violet-500">✨ AI</button>` : ''}</div>`;
  const cls = 'w-full bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded-lg px-2 py-1.5 text-sm';
  const wide = ['textarea', 'faq', 'images', 'image', 'html'].includes(type) ? 'sm:col-span-2' : '';
  let input;
  if (type === 'textarea' || type === 'html') input = `<textarea rows="3" oninput="setSec(${i},'${key}',this.value)" class="${cls} font-mono text-xs">${esc(v || '')}</textarea>`;
  else if (type === 'range') input = `<input type="range" min="0" max="90" value="${v == null ? 45 : v}" oninput="setSec(${i},'${key}',+this.value)" class="w-full">`;
  else if (type === 'number') input = `<input type="number" value="${esc(v == null ? 6 : v)}" oninput="setSec(${i},'${key}',+this.value)" class="${cls}">`;
  else if (type === 'target') input = `<select onchange="setSec(${i},'${key}',this.value)" class="${cls}">${[['inquiry','Contact form'],['trade','Trade-in'],['finance','Financing'],['link','Custom link']].map(o => `<option value="${o[0]}" ${v === o[0] ? 'selected' : ''}>${o[1]}</option>`).join('')}</select>`;
  else if (type === 'cond') input = `<select onchange="setSec(${i},'${key}',this.value)" class="${cls}">${[['all','All'],['new','New'],['used','Used']].map(o => `<option value="${o[0]}" ${v === o[0] ? 'selected' : ''}>${o[1]}</option>`).join('')}</select>`;
  else if (type === 'height') input = `<select onchange="setSec(${i},'${key}',this.value)" class="${cls}">${[['sm','Short'],['md','Medium'],['lg','Tall']].map(o => `<option value="${o[0]}" ${(v || 'md') === o[0] ? 'selected' : ''}>${o[1]}</option>`).join('')}</select>`;
  else if (type === 'image') input = `<div class="flex gap-1 items-center">${v ? `<img src="${esc(v)}" class="w-12 h-9 object-cover rounded">` : ''}<input value="${esc(v || '')}" placeholder="URL or upload" oninput="setSec(${i},'${key}',this.value)" class="${cls} flex-1"><input type="file" accept="image/*" class="hidden" id="secimg-${i}-${key}" onchange="uploadToSec(${i},'${key}',this.files[0])"><button type="button" onclick="document.getElementById('secimg-${i}-${key}').click()" class="text-xs font-bold bg-slate-200 dark:bg-slate-700 px-2 rounded">Upload</button></div>`;
  else if (type === 'images') { const arr = Array.isArray(v) ? v : []; input = `<div><div class="flex flex-wrap gap-1 mb-1">${arr.map((u, k) => `<div class="relative"><img src="${esc(u)}" class="w-12 h-9 object-cover rounded"><button onclick="delSecImg(${i},'${key}',${k})" class="absolute -top-1 -right-1 bg-black/60 text-white rounded-full w-4 h-4 text-[10px]">×</button></div>`).join('')}</div><input type="file" accept="image/*" multiple class="hidden" id="secimgs-${i}-${key}" onchange="uploadToSecMulti(${i},'${key}',this.files)"><button type="button" onclick="document.getElementById('secimgs-${i}-${key}').click()" class="text-xs font-bold bg-slate-200 dark:bg-slate-700 px-2 py-1 rounded">+ Add images</button></div>`; }
  else if (type === 'faq') { const lines = (Array.isArray(v) ? v : []).map(it => `${it.q || ''} :: ${it.a || ''}`).join('\n'); input = `<textarea rows="4" oninput="setSecFaq(${i},'${key}',this.value)" placeholder="Question :: Answer" class="${cls} text-xs">${esc(lines)}</textarea>`; }
  else input = `<input value="${esc(v || '')}" oninput="setSec(${i},'${key}',this.value)" class="${cls}">`;
  return `<div class="${wide}">${lbl}${input}</div>`;
}
function setSec(i, key, val) { if (__siteSections[i]) { __siteSections[i].settings = __siteSections[i].settings || {}; __siteSections[i].settings[key] = val; } }
function setSecFaq(i, key, text) { const items = text.split('\n').map(l => { const [q, ...a] = l.split('::'); return { q: (q || '').trim(), a: a.join('::').trim() }; }).filter(x => x.q); setSec(i, key, items); }
function delSecImg(i, key, k) { const arr = (__siteSections[i].settings?.[key] || []).slice(); arr.splice(k, 1); setSec(i, key, arr); renderWsSections(); }
async function uploadToSec(i, key, file) { if (!file) return; showToast('Uploading…', 'info'); try { const fd = new FormData(); fd.append('image', file); const r = await fetch(`${API}/dealership/site-image`, { method: 'POST', headers: { 'Authorization': `Bearer ${token}` }, body: fd }); const d = await r.json(); if (!r.ok) throw new Error(d.error); setSec(i, key, d.url); renderWsSections(); showToast('Uploaded', 'success'); } catch (e) { showToast(e.message, 'error'); } }
async function uploadToSecMulti(i, key, files) { for (const f of Array.from(files || [])) { try { const fd = new FormData(); fd.append('image', f); const r = await fetch(`${API}/dealership/site-image`, { method: 'POST', headers: { 'Authorization': `Bearer ${token}` }, body: fd }); const d = await r.json(); if (r.ok) { const arr = (__siteSections[i].settings?.[key] || []).slice(); arr.push(d.url); setSec(i, key, arr); } } catch {} } renderWsSections(); showToast('Images added', 'success'); }
function addSection(type) { __siteSections.push({ id: 's' + Date.now().toString(36), type, settings: {} }); renderWsSections(); }
function moveSection(i, dir) { const j = i + dir; if (j < 0 || j >= __siteSections.length) return; const [s] = __siteSections.splice(i, 1); __siteSections.splice(j, 0, s); renderWsSections(); }
function dupSection(i) { __siteSections.splice(i + 1, 0, JSON.parse(JSON.stringify(__siteSections[i]))); renderWsSections(); }
function delSection(i) { __siteSections.splice(i, 1); renderWsSections(); }
function wsDesign() {
  const c = __siteCfg.content || {};
  const swatch = (id, label, val) => `<div><label class="block text-[11px] font-semibold text-slate-500 dark:text-slate-400 mb-1">${label}</label><input id="${id}" type="color" value="${esc(val || '#1e3a8a')}" class="w-full h-10 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded-lg"></div>`;
  const typos = [['modern','Modern'],['luxury','Luxury'],['bold','Bold'],['corporate','Corporate'],['minimal','Minimal']];
  return `<div class="mt-4 max-w-lg space-y-4">
    <div>
      <div class="text-sm font-black text-slate-900 dark:text-white mb-2">Brand colours</div>
      <div class="grid grid-cols-3 gap-2">${swatch('ws-c1', 'Primary', c.primary_color)}${swatch('ws-c2', 'Secondary / hero', c.secondary_color)}${swatch('ws-c3', 'Accent', c.accent_color)}</div>
    </div>
    <div>
      <div class="text-sm font-black text-slate-900 dark:text-white mb-2">Typography</div>
      <select id="ws-typo" class="w-full bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded-lg px-3 py-2 text-sm">${typos.map(t => `<option value="${t[0]}" ${(c.typography || 'modern') === t[0] ? 'selected' : ''}>${t[1]}</option>`).join('')}</select>
      <p class="text-[11px] text-slate-400 mt-1">Changes every heading &amp; body font across the site.</p>
    </div>
    <p class="text-[11px] text-slate-400">Logo comes from your branding (Settings). Colours &amp; fonts update the whole site automatically.</p>
  </div>`;
}
// Pages tab: extra content pages + auto-built model/offer pages (moved here from Settings).
function wsPages() {
  return `<div class="mt-4 max-w-2xl space-y-5">
    <div>
      <div class="text-sm font-black text-slate-900 dark:text-white">Built-in pages</div>
      <p class="text-[11px] text-slate-400 mb-2">These ship with your site (and your template). Rename the nav label, or switch off any you don't want. Turning one off removes it from the menu and the whole site.</p>
      <div id="builtin-page-list" class="space-y-2"></div>
    </div>
    <div class="border-t border-slate-200 dark:border-slate-800 pt-4">
      <div class="flex items-center justify-between gap-2">
        <div>
          <div class="text-sm font-black text-slate-900 dark:text-white">Your pages</div>
          <p class="text-[11px] text-slate-400">Extra pages (About, Financing…) that appear in your nav. Auto-build creates a page per model in your inventory (pulls stock automatically) plus standard offer pages.</p>
        </div>
        <div class="flex items-center gap-2 shrink-0">
          <button type="button" onclick="autoBuildPages(this)" class="text-xs font-bold text-violet-600 dark:text-violet-400">✨ Auto-build model &amp; offer pages</button>
          <button type="button" onclick="addSitePage()" class="text-xs font-bold text-indigo-600 dark:text-indigo-400">+ Add page</button>
        </div>
      </div>
      <div id="site-page-list" class="space-y-2 mt-2"></div>
    </div>
  </div>`;
}
// ── Team tab: dealer staff (managers, sales, service, admin…) with dept labels ──
let __siteStaff = [];
const STAFF_DEPTS = ['Management', 'Sales', 'Finance', 'Service', 'Parts', 'Admin', 'Reception', 'Other'];
function wsTeam() {
  return `<div class="mt-4 max-w-2xl space-y-3">
    <div class="flex items-center justify-between gap-2">
      <div>
        <div class="text-sm font-black text-slate-900 dark:text-white">Team</div>
        <p class="text-[11px] text-slate-400">Your logged-in sales team appears on the public Team page automatically (edit their name/photo/bio under <b>Sales Team → Edit</b>). Add anyone else here — finance, service, parts, admin, reception — and they'll show under the right department.</p>
      </div>
      <button type="button" onclick="addSiteStaff()" class="text-xs font-bold text-indigo-600 dark:text-indigo-400 shrink-0">+ Add person</button>
    </div>
    <div id="site-staff-list" class="space-y-2"></div>
  </div>`;
}
function collectSiteStaff() {
  if (!document.getElementById('site-staff-list')) return;
  __siteStaff = Array.from(document.querySelectorAll('#site-staff-list [data-stx]')).map((r, idx) => ({
    ...(__siteStaff[idx] || {}),
    name: r.querySelector('.st-name')?.value || '',
    title: r.querySelector('.st-title')?.value || '',
    department: r.querySelector('.st-dept')?.value || 'Sales',
    phone: r.querySelector('.st-phone')?.value || '',
    email: r.querySelector('.st-email')?.value || '',
  }));
}
function renderSiteStaff() {
  const box = document.getElementById('site-staff-list'); if (!box) return;
  const ic = 'bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded px-2 py-1 text-xs';
  if (!__siteStaff.length) { box.innerHTML = '<div class="text-[11px] text-slate-400 italic">No team members yet. Add managers, sales, service, admin…</div>'; return; }
  box.innerHTML = __siteStaff.map((m, i) => `<div data-stx="${i}" class="border border-slate-200 dark:border-slate-700 rounded-lg p-2 space-y-1">
    <div class="flex gap-2 items-center">
      ${m.photo ? `<img src="${esc(m.photo)}" class="w-9 h-9 rounded-full object-cover shrink-0">` : `<div class="w-9 h-9 rounded-full bg-slate-200 dark:bg-slate-700 flex items-center justify-center text-xs font-bold shrink-0">${esc((m.name || '?')[0] || '?')}</div>`}
      <input class="st-name flex-1 ${ic}" placeholder="Full name" value="${esc(m.name || '')}">
      <select class="st-dept ${ic}">${STAFF_DEPTS.map(d => `<option ${m.department === d ? 'selected' : ''}>${d}</option>`).join('')}</select>
      <button type="button" onclick="removeSiteStaff(${i})" class="text-rose-500 text-xs font-bold shrink-0">✕</button>
    </div>
    <div class="grid grid-cols-2 gap-1">
      <input class="st-title ${ic}" placeholder="Title (e.g. Sales Manager)" value="${esc(m.title || '')}">
      <input class="st-phone ${ic}" placeholder="Phone" value="${esc(m.phone || '')}">
    </div>
    <div class="flex gap-1 items-center">
      <input class="st-email flex-1 ${ic}" placeholder="Email (optional)" value="${esc(m.email || '')}">
      <input type="file" accept="image/*" class="hidden" id="st-file-${i}" onchange="uploadStaffPhoto(${i}, this.files[0])">
      <button type="button" onclick="document.getElementById('st-file-${i}').click()" class="text-xs font-bold bg-slate-200 dark:bg-slate-700 px-2 py-1 rounded shrink-0">${m.photo ? 'Change photo' : 'Photo'}</button>
    </div>
  </div>`).join('');
}
function addSiteStaff() { collectSiteStaff(); __siteStaff.push({ name: '', title: '', department: 'Sales' }); renderSiteStaff(); }
function removeSiteStaff(i) { collectSiteStaff(); __siteStaff.splice(i, 1); renderSiteStaff(); }
async function uploadStaffPhoto(i, file) {
  if (!file) return; collectSiteStaff(); showToast('Uploading photo…', 'info');
  try {
    const fd = new FormData(); fd.append('image', file);
    const r = await fetch(`${API}/dealership/site-image`, { method: 'POST', headers: { 'Authorization': `Bearer ${token}` }, body: fd });
    const d = await r.json(); if (!r.ok) throw new Error(d.error || 'Upload failed');
    __siteStaff[i].photo = d.url; renderSiteStaff(); showToast('Photo added', 'success');
  } catch (e) { showToast(e.message, 'error'); }
}
async function saveWebsite(btn) {
  // Collect design values if on that tab (they persist across tabs via __siteCfg.content).
  const c = __siteCfg.content || (__siteCfg.content = {});
  if (document.getElementById('ws-c1')) { c.primary_color = document.getElementById('ws-c1').value; c.secondary_color = document.getElementById('ws-c2').value; c.accent_color = document.getElementById('ws-c3').value; c.typography = document.getElementById('ws-typo').value; }
  collectSitePages(); collectSiteStaff(); collectBuiltins(); // no-op unless that tab is currently rendered
  wsFlushTarget();                        // push the active buffer onto home / its page
  const body = {
    sections: __homeSections,
    pages: __sitePages.filter(p => (p.title || '').trim()),
    staff: __siteStaff.filter(m => (m.name || '').trim()),
    builtins: Object.keys(__siteBuiltins).length ? __siteBuiltins : defaultBuiltins(),
    site_published: document.getElementById('ws-pub')?.checked || false,
    primary_color: c.primary_color, secondary_color: c.secondary_color, accent_color: c.accent_color, typography: c.typography,
  };
  const orig = btn.textContent; btn.disabled = true; btn.textContent = 'Saving…';
  try { await apiSendJson('/dealership/site', 'PUT', body); showToast('Website saved', 'success'); btn.disabled = false; btn.textContent = orig; }
  catch (e) { btn.disabled = false; btn.textContent = orig; showToast(e.message, 'error'); }
}
// ✨ AI-per-section: one-click Rewrite / Improve / Generate / SEO on copy fields.
function aiMenu(ev, i, key, kind) {
  ev.stopPropagation();
  document.querySelectorAll('.ai-menu').forEach(m => m.remove());
  const acts = kind === 'faq' ? [['faq', 'Generate FAQ']]
    : [['improve', '✨ Improve'], ['rewrite', 'Rewrite'], ['shorten', 'Shorten'], ['expand', 'Expand'], ['generate', 'Generate new'], ['seo', 'SEO version']];
  const m = document.createElement('div');
  m.className = 'ai-menu fixed z-[9999] bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg shadow-xl py-1 min-w-[140px]';
  const r = ev.currentTarget.getBoundingClientRect();
  m.style.top = (r.bottom + 4) + 'px'; m.style.left = Math.max(8, r.right - 150) + 'px';
  m.innerHTML = acts.map(a => `<button class="block w-full text-left px-3 py-1.5 text-sm hover:bg-slate-100 dark:hover:bg-slate-800" onclick="aiRun(${i},'${key}','${kind}','${a[0]}');this.closest('.ai-menu').remove()">${a[1]}</button>`).join('');
  document.body.appendChild(m);
  setTimeout(() => document.addEventListener('click', function h() { m.remove(); document.removeEventListener('click', h); }, { once: true }), 10);
}
const __aiHistory = {}; // per-field recent outputs, so repeated clicks don't repeat
async function aiRun(i, key, kind, task) {
  const cur = __siteSections[i]?.settings?.[key];
  const current = Array.isArray(cur) ? cur.map(x => `${x.q} :: ${x.a}`).join('\n') : (cur || '');
  const secLabel = SEC_META[__siteSections[i]?.type]?.label || '';
  const histKey = `${__siteSections[i]?.id || i}:${key}`;
  const avoid = (__aiHistory[histKey] || []).slice(-5);
  showToast('✨ Writing…', 'info');
  try {
    const d = await apiSendJson('/ai/site-copy', 'POST', { task, kind, current, hint: secLabel, avoid });
    if (kind === 'faq' || key === 'items') setSecFaq(i, key, d.text); else setSec(i, key, d.text);
    (__aiHistory[histKey] = __aiHistory[histKey] || []).push(d.text);
    renderWsSections();
    showToast('✨ Done — review & Save', 'success');
  } catch (e) { showToast(e.message === 'AI Boost not active' ? 'AI editing needs AI Boost (or your free trial).' : e.message, 'error'); }
}
// ── Templates: distinct layouts + copy pre-filled from the dealer's own details ──
const __mk = (type, settings) => ({ id: 's' + Math.random().toString(36).slice(2, 9), type, settings: settings || {} });
const MAKE_THEME = {
  chevrolet: { p: '#0b2a5b', s: '#0a1a33', a: '#d4af37', t: 'bold' }, gmc: { p: '#c8102e', s: '#1a1a1a', a: '#9ea2a2', t: 'bold' },
  buick: { p: '#151a20', s: '#0a0f14', a: '#b08d57', t: 'luxury' }, ford: { p: '#003478', s: '#00142e', a: '#1071e5', t: 'bold' },
  toyota: { p: '#eb0a1e', s: '#121212', a: '#eb0a1e', t: 'modern' }, honda: { p: '#e40521', s: '#121212', a: '#e40521', t: 'modern' },
  nissan: { p: '#c3002f', s: '#121212', a: '#c3002f', t: 'modern' }, hyundai: { p: '#002c5f', s: '#00142e', a: '#00aad2', t: 'modern' },
};
async function dealerCtxAsync() {
  const c = __siteCfg?.content || {};
  let makes = [];
  try { let inv = (typeof __catalogCache !== 'undefined' && __catalogCache?.length) ? __catalogCache : []; if (!inv.length) { try { inv = await apiGetJson('/inventory/all', { retries: 1 }); } catch {} } makes = [...new Set(inv.map(v => v.make).filter(Boolean))]; } catch {}
  return { name: c.name || 'our dealership', city: c.city || '', makes, primaryMake: makes[0] || '', makeList: makes.slice(0, 3).join(', ') };
}
const SITE_TEMPLATES = [
  { id: 'generic', name: 'Generic', primary: '#1e3a8a', secondary: '#0f172a', accent: '#2563eb', typography: 'modern', build: (x) => [
    __mk('hero', { headline: `Welcome to ${x.name}`, subheadline: `Quality new and used vehicles${x.city ? ' in ' + x.city : ''}. Shop, build and finance — all in one place.`, button_label: 'Browse inventory', button_target: 'inquiry', overlay: 45, height: 'md' }),
    __mk('featured_inventory', { title: 'Featured vehicles', condition: 'all', count: 6 }),
    __mk('trade_cta', { title: 'Value your trade', subtitle: 'Get a real number in minutes.', button_label: 'Value my trade' }),
    __mk('finance_cta', { title: 'Get pre-approved', subtitle: 'Fast and secure — no impact to your credit score.', button_label: 'Get pre-approved' }),
    __mk('staff', { title: 'Meet our team' }),
    __mk('faq', { title: 'Frequently asked questions', items: [{ q: 'Do you offer financing?', a: 'Yes — apply online in minutes and our team finds you a competitive rate.' }, { q: 'Can I value my trade online?', a: `Absolutely. Use our trade tool and we'll get you a real offer.` }] }),
    __mk('contact', { title: 'Get in touch' }),
  ] },
  { id: 'manufacturer', name: 'Manufacturer', primary: '#0b2a5b', secondary: '#0a1a33', accent: '#d4af37', typography: 'bold', build: (x) => {
    const mk = x.primaryMake || 'your favourite brands';
    return [
      __mk('hero', { headline: `Your ${mk} destination${x.city ? ' in ' + x.city : ''}`, subheadline: `Explore the full ${mk} lineup, build yours, and drive home with confidence.`, button_label: `Shop ${mk}`, button_target: 'inquiry', overlay: 40, height: 'lg' }),
      __mk('inventory_grid', { title: `${mk} inventory` }),
      __mk('finance_cta', { title: `${mk} finance offers`, subtitle: 'Competitive rates and factory programs.', button_label: 'Get pre-approved' }),
      __mk('service_cta', { title: 'Factory-trained service', subtitle: 'Keep your vehicle running like new.', button_label: 'Book service', button_target: 'inquiry' }),
      __mk('featured_inventory', { title: 'New arrivals', condition: 'new', count: 6 }),
      __mk('contact', { title: 'Talk to a product specialist' }),
    ];
  } },
  { id: 'modern', name: 'Modern', primary: '#4f46e5', secondary: '#0b1020', accent: '#22d3ee', typography: 'modern', build: (x) => [
    __mk('hero', { headline: `Find your next vehicle, faster`, subheadline: `${x.name} makes it simple — search, build and finance online${x.city ? ' in ' + x.city : ''}.`, button_label: 'Start shopping', button_target: 'inquiry', overlay: 35, height: 'lg' }),
    __mk('featured_inventory', { title: 'Trending now', condition: 'all', count: 6 }),
    __mk('cta_banner', { title: 'Build your dream vehicle online', button_label: 'Build & price', button_target: 'inquiry' }),
    __mk('gallery', { title: 'Inside our store', images: [] }),
    __mk('trade_cta', { title: 'Trade up today', subtitle: 'Instant estimate, real offer.', button_label: 'Value my trade' }),
    __mk('finance_cta', { title: 'Financing that fits', subtitle: 'Pre-approval in minutes.', button_label: 'Get pre-approved' }),
    __mk('contact', { title: 'Let\'s talk' }),
  ] },
  { id: 'clean', name: 'Clean', primary: '#0f766e', secondary: '#111827', accent: '#14b8a6', typography: 'minimal', build: (x) => [
    __mk('hero', { headline: x.name, subheadline: `A simpler way to buy your next vehicle${x.city ? ' in ' + x.city : ''}.`, button_label: 'View inventory', button_target: 'inquiry', overlay: 30, height: 'sm' }),
    __mk('featured_inventory', { title: 'Available now', condition: 'all', count: 6 }),
    __mk('finance_cta', { title: 'Get pre-approved', subtitle: 'Quick, secure, no obligation.', button_label: 'Apply now' }),
    __mk('contact', { title: 'Contact us' }),
  ] },
  { id: 'luxury', name: 'Luxury', primary: '#151515', secondary: '#000000', accent: '#b08d57', typography: 'luxury', build: (x) => [
    __mk('hero', { headline: `An elevated ownership experience`, subheadline: `${x.name} — curated vehicles and concierge service${x.city ? ' in ' + x.city : ''}.`, button_label: 'View the collection', button_target: 'inquiry', overlay: 55, height: 'lg' }),
    __mk('featured_inventory', { title: 'The collection', condition: 'all', count: 6 }),
    __mk('html', { html: `<div class="max-w-3xl"><h2 class="text-2xl font-black mb-2">Effortless from first look to delivery</h2><p class="text-slate-600">Private appointments, home delivery and a dedicated advisor for every client.</p></div>` }),
    __mk('staff', { title: 'Your advisors' }),
    __mk('contact', { title: 'Request a private appointment' }),
  ] },
  { id: 'usedlot', name: 'Used car lot', primary: '#b45309', secondary: '#1c1917', accent: '#f59e0b', typography: 'bold', build: (x) => [
    __mk('hero', { headline: `Quality pre-owned, priced to move`, subheadline: `${x.name} — every vehicle inspected and ready to go${x.city ? ' in ' + x.city : ''}.`, button_label: 'Browse used inventory', button_target: 'inquiry', overlay: 45, height: 'md' }),
    __mk('inventory_grid', { title: 'Our pre-owned inventory' }),
    __mk('trade_cta', { title: 'We buy cars', subtitle: 'Get top dollar for your trade — even if you don\'t buy from us.', button_label: 'Get my offer' }),
    __mk('finance_cta', { title: 'Everyone drives', subtitle: 'Good credit, bad credit, no credit — we can help.', button_label: 'Get approved' }),
    __mk('faq', { title: 'Buying with confidence', items: [{ q: 'Are your vehicles inspected?', a: 'Yes — every vehicle goes through a full mechanical and safety inspection.' }, { q: 'Do you help with financing?', a: 'We work with multiple lenders to get you approved, whatever your credit.' }] }),
    __mk('contact', { title: 'Come see us' }),
  ] },
  { id: 'corporate', name: 'Corporate', primary: '#1e40af', secondary: '#0b1220', accent: '#64748b', typography: 'corporate', build: (x) => [
    __mk('hero', { headline: `${x.name}`, subheadline: `Trusted vehicle sales, financing and service${x.city ? ' in ' + x.city : ''}${x.makeList ? ' — ' + x.makeList + ' and more' : ''}.`, button_label: 'Explore inventory', button_target: 'inquiry', overlay: 40, height: 'md' }),
    __mk('featured_inventory', { title: 'Featured inventory', condition: 'all', count: 6 }),
    __mk('finance_cta', { title: 'Financing & leasing', subtitle: 'Flexible terms for every budget.', button_label: 'Get pre-approved' }),
    __mk('service_cta', { title: 'Service & maintenance', subtitle: 'Certified technicians and genuine parts.', button_label: 'Book service', button_target: 'inquiry' }),
    __mk('reviews', { title: 'What our customers say' }),
    __mk('faq', { title: 'Questions, answered', items: [{ q: 'What are your hours?', a: 'See our hours in the footer — or contact us anytime online.' }, { q: 'Do you offer delivery?', a: 'Yes, we offer vehicle delivery in the surrounding area.' }] }),
    __mk('map', { title: 'Find us', address: '' }),
    __mk('contact', { title: 'Get in touch' }),
  ] },
];
function openTemplatePicker() {
  const cards = SITE_TEMPLATES.map(t => `<button onclick="applyTemplate('${t.id}')" class="text-left border border-slate-200 dark:border-slate-700 rounded-xl overflow-hidden hover:border-indigo-400 transition">
    <div class="h-16 flex" style="background:${t.primary}"><div class="w-1/4" style="background:${t.secondary}"></div><div class="w-1/4 self-end m-2 h-4 rounded" style="background:${t.accent}"></div></div>
    <div class="px-3 py-2"><div class="text-sm font-bold text-slate-800 dark:text-slate-100">${esc(t.name)}</div><div class="text-[10px] text-slate-400">${esc(TEMPLATE_BLURB[t.id] || '')}</div></div>
  </button>`).join('');
  crmOverlay(`<div class="p-5">
    <div class="flex items-center justify-between mb-1"><div class="text-lg font-black text-slate-900 dark:text-white">Start from a template</div><button onclick="this.closest('.fixed').remove()" class="text-slate-400 hover:text-slate-600"><svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" d="M6 6l12 12M18 6L6 18"/></svg></button></div>
    <p class="text-sm text-slate-500 dark:text-slate-400 mb-4">Each template applies its own layout, colours, fonts and starter copy — already filled in with your dealership's name, city and brands. Edit everything after.</p>
    <div class="grid grid-cols-2 sm:grid-cols-3 gap-3">${cards}</div>
  </div>`, 'max-w-2xl');
}
const TEMPLATE_BLURB = { generic: 'Balanced, all-purpose', manufacturer: 'Auto-branded to your make', modern: 'Bold & contemporary', clean: 'Minimal & fast', luxury: 'Dark, premium feel', usedlot: 'High-volume pre-owned', corporate: 'Professional & complete' };
async function applyTemplate(id) {
  const t = SITE_TEMPLATES.find(x => x.id === id); if (!t) return;
  const ctx = await dealerCtxAsync();
  let colors = { primary: t.primary, secondary: t.secondary, accent: t.accent, typography: t.typography };
  if (id === 'manufacturer') { const th = MAKE_THEME[(ctx.primaryMake || '').toLowerCase()]; if (th) colors = { primary: th.p, secondary: th.s, accent: th.a, typography: th.t }; }
  __siteSections = t.build(ctx);
  const c = __siteCfg.content || (__siteCfg.content = {});
  c.primary_color = colors.primary; c.secondary_color = colors.secondary; c.accent_color = colors.accent; c.typography = colors.typography;
  if (!Object.keys(__siteBuiltins).length) __siteBuiltins = defaultBuiltins();   // template ships the built-in pages, all on
  document.querySelector('.fixed')?.remove();
  __wsTab = 'builder';
  renderWebsitePage();
  showToast('Template applied — review, then Save', 'success');
}
Object.assign(window, { loadWebsitePage, wsTab, wsSetTarget, addSection, moveSection, dupSection, delSection, setSec, setSecFaq, delSecImg, uploadToSec, uploadToSecMulti, saveWebsite, aiMenu, aiRun, openTemplatePicker, applyTemplate, addSiteStaff, removeSiteStaff, uploadStaffPhoto, collectBuiltins, renderBuiltinPages });

// ══ Automation engine — manager workspace (inline toggles + message boxes) ═══
// State: __autoCfg { campaigns[], settings{}, region{}, can_manage }; __autoHol = working holiday rows.
let __autoCfg = { campaigns: [], settings: {}, region: {}, can_manage: false };
let __autoHol = [];
const AUTO_CATS = [['pipeline', 'Sales pipeline'], ['retention', 'Post-delivery retention'], ['reviews', 'Reviews'], ['referrals', 'Referrals'], ['equity', 'Lease pull-ahead'], ['calendar', 'Birthdays'], ['custom', 'Custom']];
const AUTO_TRIGGER_LABEL = { internet_lead: 'New internet lead', appointment_booked: 'Appointment booked', show_no_sale: 'Showed — no sale', delivered: 'Vehicle delivered', birthday: 'Birthday', holiday: 'Holiday' };
const AUTO_VARS = ['customer.first_name', 'vehicle.ymm', 'vehicle.model', 'rep.first_name', 'dealership.name', 'review_url', 'referral_bonus', 'service_url'];
function autoDelayLabel(c) {
  if (c.interval_months?.length) return `Months ${c.interval_months[0]}–${c.interval_months[c.interval_months.length - 1]}`;
  const m = c.delay_minutes || 0;
  if (m < 60) return m <= 2 ? 'Immediately' : `${m} min`;
  if (m < 1440) return `${Math.round(m / 60)} hr`;
  return `${Math.round(m / 1440)} day${Math.round(m / 1440) === 1 ? '' : 's'}`;
}
// Region-aware fixed-date holiday presets (floating holidays can be added manually).
const HOLIDAY_PRESETS = {
  CA: [
    ["New Year's Day", '01-01', "Happy New Year from all of us at {{dealership.name}}! Wishing you a safe and healthy year ahead."],
    ["Valentine's Day", '02-14', "Happy Valentine's Day from {{dealership.name}}! Thanks for being part of our family."],
    ['Canada Day', '07-01', "Happy Canada Day from {{dealership.name}}! Enjoy the long weekend — please note our holiday hours."],
    ['Halloween', '10-31', "Happy Halloween from {{dealership.name}} — stay safe out there tonight! 🎃"],
    ['Remembrance Day', '11-11', "Today we remember and honour those who served. — {{dealership.name}}"],
    ['Christmas Eve', '12-24', "Merry Christmas from everyone at {{dealership.name}}! Wishing you a warm and happy holiday."],
    ['Christmas Day', '12-25', "Merry Christmas from {{dealership.name}}! We hope your day is filled with family and joy."],
    ['Boxing Day', '12-26', "Happy Boxing Day from {{dealership.name}}! Check our website for holiday hours before visiting."],
    ["New Year's Eve", '12-31', "Happy New Year's Eve from {{dealership.name}}! Thank you for a wonderful year — see you in the new one."],
  ],
  US: [
    ["New Year's Day", '01-01', "Happy New Year from all of us at {{dealership.name}}! Wishing you a great year ahead."],
    ["Valentine's Day", '02-14', "Happy Valentine's Day from {{dealership.name}}! Thanks for being part of our family."],
    ['Independence Day', '07-04', "Happy 4th of July from {{dealership.name}}! Enjoy the holiday — please note our hours."],
    ['Halloween', '10-31', "Happy Halloween from {{dealership.name}} — stay safe tonight! 🎃"],
    ['Veterans Day', '11-11', "Today we honor all who served. Thank you. — {{dealership.name}}"],
    ['Christmas Eve', '12-24', "Merry Christmas from everyone at {{dealership.name}}! Wishing you a warm holiday."],
    ['Christmas Day', '12-25', "Merry Christmas from {{dealership.name}}! We hope your day is filled with family and joy."],
    ["New Year's Eve", '12-31', "Happy New Year's Eve from {{dealership.name}}! Thank you for a wonderful year."],
  ],
};
const US_STATES = ['al', 'ak', 'az', 'ar', 'ca', 'co', 'ct', 'de', 'fl', 'ga', 'hi', 'id', 'il', 'in', 'ia', 'ks', 'ky', 'la', 'me', 'md', 'ma', 'mi', 'mn', 'ms', 'mo', 'mt', 'ne', 'nv', 'nh', 'nj', 'nm', 'ny', 'nc', 'nd', 'oh', 'ok', 'or', 'pa', 'ri', 'sc', 'sd', 'tn', 'tx', 'ut', 'vt', 'va', 'wa', 'wv', 'wi', 'wy'];
function autoRegionKey() {
  const r = __autoCfg.region || {};
  const c = String(r.country || '').toLowerCase(), p = String(r.province || '').toLowerCase();
  if (/(^us$|usa|united states|america)/.test(c)) return 'US';
  if (US_STATES.includes(p)) return 'US';
  return 'CA';
}
async function loadAutomationPage() {
  const root = document.getElementById('automation-root'); if (!root) return;
  root.innerHTML = '<div class="py-16 text-center text-sm text-slate-400 italic">Loading…</div>';
  try { __autoCfg = await apiGetJson('/automation/campaigns'); }
  catch (e) {
    if (String(e.message).toLowerCase().includes('manager')) { root.innerHTML = '<div class="py-16 text-center text-sm text-slate-500">Automation is available to managers only.</div>'; return; }
    root.innerHTML = `<div class="py-16 text-center text-sm text-slate-500">Couldn't load: ${esc(e.message)}</div>`; return;
  }
  if (!__autoCfg.can_manage) { root.innerHTML = '<div class="py-16 text-center text-sm text-slate-500">Automation is available to managers only.</div>'; return; }
  autoInitHolidays();
  renderAutomationPage();
}
function autoInitHolidays() {
  const saved = Array.isArray(__autoCfg.settings.holidays) ? __autoCfg.settings.holidays : [];
  const presets = HOLIDAY_PRESETS[autoRegionKey()] || HOLIDAY_PRESETS.CA;
  const byKey = {}; for (const h of saved) byKey[`${h.name}|${h.date}`] = h;
  const rows = presets.map(([name, date, message]) => {
    const sv = byKey[`${name}|${date}`];
    return { name, date, message: sv?.message || message, subject: sv?.subject || `Happy ${name} from {{dealership.name}}`, enabled: sv ? sv.enabled !== false : false, preset: true };
  });
  for (const h of saved) { const k = `${h.name}|${h.date}`; if (!presets.some(p => `${p[0]}|${p[1]}` === k)) rows.push({ name: h.name, date: h.date, message: h.message || `Happy ${h.name} from {{dealership.name}}`, subject: h.subject || `Happy ${h.name} from {{dealership.name}}`, enabled: h.enabled !== false, preset: false }); }
  __autoHol = rows;
}
function renderAutomationPage() {
  const root = document.getElementById('automation-root'); if (!root) return;
  const s = __autoCfg.settings || {};
  const byCat = {}; for (const c of (__autoCfg.campaigns || [])) (byCat[c.category] = byCat[c.category] || []).push(c);
  root.innerHTML = `
    <div class="flex items-start justify-between gap-3 flex-wrap">
      <div>
        <h2 class="text-xl font-bold text-slate-900 dark:text-white">Automation</h2>
        <p class="text-sm text-slate-500 dark:text-slate-400 mt-1">Every automated text &amp; email in one place — flip them on, edit the wording, or rewrite with AI. Compliance kill switches run behind the scenes.</p>
      </div>
      <label class="flex items-center gap-1.5 text-sm font-bold"><input type="checkbox" ${s.enabled !== false ? 'checked' : ''} onchange="autoToggleEngine(this.checked)" class="accent-indigo-600 w-4 h-4">Engine on</label>
    </div>
    ${autoGlobalsHtml(s)}
    ${AUTO_CATS.filter(([k]) => byCat[k]?.length).map(([k, label]) => `<div><div class="text-xs font-black uppercase tracking-wider text-slate-400 mb-2 mt-4">${label}</div><div class="space-y-2">${byCat[k].map(autoCardHtml).join('')}</div></div>`).join('')}
    ${autoHolidaysHtml()}`;
}
function autoGlobalsHtml(s) {
  const inp = (id, v, ph, t = 'text') => `<input id="${id}" type="${t}" value="${esc(v == null ? '' : v)}" placeholder="${esc(ph)}" class="w-full bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded-lg px-3 py-2 text-sm">`;
  const lbl = (t) => `<label class="block text-[11px] font-semibold text-slate-500 dark:text-slate-400 mb-1">${t}</label>`;
  return `<div class="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4">
    <div class="text-sm font-black text-slate-900 dark:text-white mb-2">Global settings</div>
    <div class="grid sm:grid-cols-2 gap-2">
      <div>${lbl('Google review link')}${inp('ag-review', s.review_url, 'https://g.page/r/…/review')}</div>
      <div>${lbl('Referral bonus phrase')}${inp('ag-bonus', s.referral_bonus, 'a $200 referral bonus')}</div>
      <div>${lbl('Service booking URL')}${inp('ag-service', s.service_url, 'https://…/book-service')}</div>
      <div>${lbl('House SMS number')}${inp('ag-sms', s.house_sms, '+1 905 555 1234', 'tel')}</div>
      <div>${lbl('House email')}${inp('ag-email', s.house_email, 'sales@…', 'email')}</div>
      <div class="grid grid-cols-3 gap-2"><div>${lbl('Open (hr)')}${inp('ag-bstart', s.business_start ?? 8, '8', 'number')}</div><div>${lbl('Close (hr)')}${inp('ag-bend', s.business_end ?? 19, '19', 'number')}</div><div>${lbl('TZ')}${inp('ag-tz', s.timezone || 'America/Toronto', 'America/Toronto')}</div></div>
    </div>
    <button onclick="autoSaveGlobals(this)" class="mt-3 text-sm font-bold bg-indigo-600 hover:bg-indigo-500 text-white px-4 py-2 rounded-lg">Save settings</button>
    <span id="ag-msg" class="hidden text-xs ml-2"></span>
  </div>`;
}
function autoVarChips(cid) {
  return `<div class="flex flex-wrap gap-1 mt-1">${AUTO_VARS.map(v => `<button type="button" onclick="autoInsertVar('${cid}','${v}')" class="text-[10px] font-mono bg-slate-100 dark:bg-slate-800 hover:bg-indigo-100 dark:hover:bg-indigo-950/40 rounded px-1.5 py-0.5">{{${v}}}</button>`).join('')}</div>`;
}
function autoCardHtml(c) {
  const ta = 'w-full bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded-lg px-3 py-2 text-sm';
  const senderOpts = [['rep', 'Salesperson'], ['house', 'Dealership'], ['dynamic_smart_switch', 'Smart switch']].map(o => `<option value="${o[0]}" ${c.sender_identity === o[0] ? 'selected' : ''}>${o[1]}</option>`).join('');
  return `<div class="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4" data-cid="${c.id}">
    <div class="flex items-center gap-3 mb-2">
      <button onclick="autoToggleCard('${c.id}', ${!c.is_active})" title="${c.is_active ? 'On — click to pause' : 'Off — click to turn on'}" class="shrink-0 w-9 h-5 rounded-full transition ${c.is_active ? 'bg-emerald-500' : 'bg-slate-300 dark:bg-slate-700'} relative"><span class="absolute top-0.5 w-4 h-4 bg-white rounded-full transition" style="left:${c.is_active ? '18px' : '2px'}"></span></button>
      <div class="min-w-0 flex-1"><div class="font-bold text-sm text-slate-900 dark:text-white truncate">${esc(c.name)}</div>
        <div class="flex flex-wrap items-center gap-1.5 mt-0.5">
          <span class="text-[10px] font-bold uppercase px-1.5 py-0.5 rounded-full ${c.channel === 'sms' ? 'bg-sky-100 text-sky-700 dark:bg-sky-950/40 dark:text-sky-300' : 'bg-violet-100 text-violet-700 dark:bg-violet-950/40 dark:text-violet-300'}">${c.channel}</span>
          <span class="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300">${esc(autoDelayLabel(c))}</span>
        </div>
      </div>
      <select onchange="autoCardField('${c.id}','sender_identity',this.value)" class="text-xs bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded px-1.5 py-1">${senderOpts}</select>
    </div>
    ${c.channel === 'email' ? `<input id="am-subj-${c.id}" value="${esc(c.subject_template || '')}" placeholder="Email subject" class="${ta} mb-2">` : ''}
    <textarea id="am-body-${c.id}" rows="3" class="${ta}">${esc(c.message_body_template || '')}</textarea>
    ${autoVarChips(c.id)}
    <div class="flex flex-wrap items-center gap-2 mt-2">
      <input id="am-ai-${c.id}" placeholder="✨ Tell AI how to rewrite (e.g. more casual, mention the $250 bonus)" class="flex-1 min-w-[200px] bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded-lg px-3 py-1.5 text-xs">
      <button onclick="autoAiCard('${c.id}',this)" class="text-xs font-bold bg-violet-600 hover:bg-violet-500 text-white px-3 py-1.5 rounded-lg">✨ Rewrite</button>
      <button onclick="autoSaveCard('${c.id}',this)" class="text-xs font-bold bg-indigo-600 hover:bg-indigo-500 text-white px-3 py-1.5 rounded-lg">Save</button>
    </div>
  </div>`;
}
function autoInsertVar(cid, v) {
  const el = document.getElementById(`am-body-${cid}`); if (!el) return;
  const tag = `{{${v}}}`, at = el.selectionStart ?? el.value.length;
  el.value = el.value.slice(0, at) + tag + el.value.slice(el.selectionEnd ?? at); el.focus();
}
function autoCardField(cid, field, val) { const c = __autoCfg.campaigns.find(x => x.id === cid); if (c) c[field] = val; }
async function autoToggleCard(cid, active) {
  try { await apiSendJson(`/automation/campaigns/${cid}`, 'PUT', { is_active: active }); const c = __autoCfg.campaigns.find(x => x.id === cid); if (c) c.is_active = active; renderAutomationPage(); }
  catch (e) { showToast(e.message, 'error'); }
}
async function autoSaveCard(cid, btn) {
  const c = __autoCfg.campaigns.find(x => x.id === cid); if (!c) return;
  const body = { message_body_template: document.getElementById(`am-body-${cid}`)?.value || '', sender_identity: c.sender_identity };
  const subj = document.getElementById(`am-subj-${cid}`); if (subj) body.subject_template = subj.value;
  const orig = btn.textContent; btn.disabled = true; btn.textContent = 'Saving…';
  try { const d = await apiSendJson(`/automation/campaigns/${cid}`, 'PUT', body); Object.assign(c, d.campaign || body); showToast('Saved', 'success'); }
  catch (e) { showToast(e.message, 'error'); }
  finally { btn.disabled = false; btn.textContent = 'Save'; }
}
async function autoAiCard(cid, btn) {
  const c = __autoCfg.campaigns.find(x => x.id === cid); if (!c) return;
  const instr = document.getElementById(`am-ai-${cid}`)?.value.trim();
  if (!instr) { showToast('Tell the AI what you want first', 'info'); return; }
  const orig = btn.textContent; btn.disabled = true; btn.textContent = '✨ Writing…';
  try {
    const d = await apiSendJson('/automation/ai-copy', 'POST', { instruction: instr, context: { campaign_type: c.category, channel: c.channel, sender_identity: c.sender_identity, interval_marker: c.interval_months?.length ? 'per-touch' : null, strict_guardrails: true } });
    const el = document.getElementById(`am-body-${cid}`); if (el) el.value = d.text; showToast('✨ Rewritten — review & Save', 'success');
  } catch (e) { showToast(e.message === 'AI Boost not active' ? 'AI copy needs AI Boost (or your free trial).' : e.message, 'error'); }
  finally { btn.disabled = false; btn.textContent = orig; }
}
function autoHolidaysHtml() {
  const rows = __autoHol.map((h, i) => `<div class="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-3" data-hk="${i}">
    <div class="flex items-center gap-2 mb-1">
      <input type="checkbox" onchange="autoHolToggle(${i},this.checked)" ${h.enabled ? 'checked' : ''} class="accent-indigo-600 w-4 h-4">
      <div class="font-bold text-sm text-slate-900 dark:text-white flex-1">${esc(h.name)} <span class="text-[11px] font-normal text-slate-400">${esc(h.date)}</span></div>
      <button onclick="autoHolAi(${i},this)" class="text-xs font-bold text-violet-600 dark:text-violet-400">✨ Rewrite</button>
    </div>
    <textarea id="am-hol-${i}" rows="2" oninput="__autoHol[${i}].message=this.value" class="w-full bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded-lg px-3 py-2 text-sm">${esc(h.message)}</textarea>
  </div>`).join('');
  return `<div><div class="flex items-center justify-between mt-4 mb-2"><div class="text-xs font-black uppercase tracking-wider text-slate-400">Holidays <span class="normal-case font-normal text-slate-400">· auto-filled for your region — flip on the ones you want</span></div><button onclick="autoAddHolidayRow()" class="text-xs font-bold text-indigo-600 dark:text-indigo-400">+ Add holiday</button></div>
    <div class="space-y-2">${rows || '<div class="text-xs text-slate-400 italic">No holidays.</div>'}</div>
    <button onclick="autoSaveHolidays(this)" class="mt-3 text-sm font-bold bg-indigo-600 hover:bg-indigo-500 text-white px-4 py-2 rounded-lg">Save holidays</button>
    <span id="am-hol-msg" class="hidden text-xs ml-2"></span></div>`;
}
function autoHolToggle(i, on) { if (__autoHol[i]) __autoHol[i].enabled = on; }
async function autoHolAi(i, btn) {
  const h = __autoHol[i]; if (!h) return;
  const orig = btn.textContent; btn.disabled = true; btn.textContent = '✨…';
  try {
    const d = await apiSendJson('/automation/ai-copy', 'POST', { instruction: `Write a short, warm holiday greeting email for ${h.name}.`, context: { campaign_type: 'calendar', channel: 'email', sender_identity: 'house', strict_guardrails: true } });
    h.message = d.text; const el = document.getElementById(`am-hol-${i}`); if (el) el.value = d.text; showToast('✨ Rewritten', 'success');
  } catch (e) { showToast(e.message === 'AI Boost not active' ? 'AI copy needs AI Boost (or your free trial).' : e.message, 'error'); }
  finally { btn.disabled = false; btn.textContent = orig; }
}
function autoAddHolidayRow() {
  const name = prompt('Holiday name (e.g. Thanksgiving)'); if (!name) return;
  const date = prompt('Date as MM-DD (e.g. 10-13)'); if (!date || !/^\d{2}-\d{2}$/.test(date)) { showToast('Use MM-DD format', 'error'); return; }
  __autoHol.push({ name: name.trim(), date, message: `Happy ${name.trim()} from {{dealership.name}}!`, subject: `Happy ${name.trim()} from {{dealership.name}}`, enabled: true, preset: false });
  renderAutomationPage();
}
async function autoSaveHolidays(btn) {
  __autoHol.forEach((h, i) => { const el = document.getElementById(`am-hol-${i}`); if (el) h.message = el.value; });
  const holidays = __autoHol.map(h => ({ name: h.name, date: h.date, enabled: h.enabled, message: h.message, subject: h.subject }));
  const msg = document.getElementById('am-hol-msg'); const orig = btn.textContent; btn.disabled = true; btn.textContent = 'Saving…';
  try { const d = await apiSendJson('/automation/settings', 'PUT', { holidays }); __autoCfg.settings = d.settings; if (msg) { msg.textContent = '✓ Saved'; msg.className = 'text-xs ml-2 text-emerald-600 dark:text-emerald-400'; msg.classList.remove('hidden'); } }
  catch (e) { if (msg) { msg.textContent = e.message; msg.className = 'text-xs ml-2 text-red-500'; msg.classList.remove('hidden'); } }
  finally { btn.disabled = false; btn.textContent = orig; }
}
async function autoToggleEngine(on) { try { const d = await apiSendJson('/automation/settings', 'PUT', { enabled: on }); __autoCfg.settings = d.settings; showToast(on ? 'Automation on' : 'Automation paused', 'success'); } catch (e) { showToast(e.message, 'error'); } }
async function autoSaveGlobals(btn) {
  const val = (i) => (document.getElementById(i)?.value || '').trim();
  const body = { review_url: val('ag-review'), referral_bonus: val('ag-bonus'), service_url: val('ag-service'), house_sms: val('ag-sms'), house_email: val('ag-email'), timezone: val('ag-tz'), business_start: +val('ag-bstart') || 0, business_end: +val('ag-bend') || 19 };
  const msg = document.getElementById('ag-msg'); const orig = btn.textContent; btn.disabled = true; btn.textContent = 'Saving…';
  try { const d = await apiSendJson('/automation/settings', 'PUT', body); __autoCfg.settings = d.settings; if (msg) { msg.textContent = '✓ Saved'; msg.className = 'text-xs ml-2 text-emerald-600 dark:text-emerald-400'; msg.classList.remove('hidden'); } }
  catch (e) { if (msg) { msg.textContent = e.message; msg.className = 'text-xs ml-2 text-red-500'; msg.classList.remove('hidden'); } }
  finally { btn.disabled = false; btn.textContent = orig; }
}
Object.assign(window, { loadAutomationPage, autoToggleEngine, autoToggleCard, autoCardField, autoInsertVar, autoSaveCard, autoAiCard, autoHolToggle, autoHolAi, autoAddHolidayRow, autoSaveHolidays, autoSaveGlobals });

// ══ Equity Radar — lease pull-ahead / equity mining (managers) ═══════════════
let __equity = { radar: [], leases: [], settings: {}, tab: 'radar' };
const eqMoney = (n) => (n == null || isNaN(n)) ? '—' : (n < 0 ? '-$' : '$') + Math.abs(Math.round(n)).toLocaleString();
const eqUnit = () => (__equity.settings && __equity.settings.unit) || 'km';
let __eqVehicles = null;
async function eqEnsureVehicles() {
  if (!__eqVehicles) { try { __eqVehicles = await apiGetJson('/inventory/all', { retries: 1 }); } catch { __eqVehicles = []; } }
  return __eqVehicles;
}
// Vehicle <option>s for linking a lease. Keeps the currently-linked vehicle
// selectable even if it's aged out of the 2-week sold window.
function eqVehicleOptions(sel, label) {
  const list = __eqVehicles || [];
  const found = sel && list.some(v => v.id === sel);
  let opts = '<option value="">— No vehicle linked —</option>';
  if (sel && !found) opts += `<option value="${esc(sel)}" selected>${esc(label || 'Currently linked vehicle')}</option>`;
  for (const v of list) {
    const t = [v.year, v.make, v.model, v.trim].filter(Boolean).join(' ')
      + (v.vin ? ` · …${String(v.vin).slice(-6)}` : '')
      + (v.status && String(v.status).toLowerCase() !== 'available' ? ` (${v.status})` : '');
    opts += `<option value="${v.id}" ${v.id === sel ? 'selected' : ''}>${esc(t)}</option>`;
  }
  return opts;
}
async function loadEquityPage() {
  const root = document.getElementById('equity-root'); if (!root) return;
  root.innerHTML = '<div class="py-16 text-center text-sm text-slate-400 italic">Loading…</div>';
  try {
    const [radar, leases, settings] = await Promise.all([apiGetJson('/equity/radar'), apiGetJson('/equity/leases'), apiGetJson('/equity/settings'), eqEnsureVehicles()]);
    __equity = { radar: radar.radar || [], leases: leases.leases || [], settings: settings.settings || radar.settings || {}, tab: __equity.tab || 'radar' };
  } catch (e) {
    root.innerHTML = String(e.message).toLowerCase().includes('manager')
      ? '<div class="py-16 text-center text-sm text-slate-500">Equity Radar is available to managers only.</div>'
      : `<div class="py-16 text-center text-sm text-slate-500">Couldn't load: ${esc(e.message)}</div>`;
    return;
  }
  renderEquityPage();
}
function renderEquityPage() {
  const root = document.getElementById('equity-root'); if (!root) return;
  const tab = (id, label, n) => `<button onclick="eqTab('${id}')" class="px-4 py-2 text-sm font-bold border-b-2 transition ${__equity.tab === id ? 'border-indigo-500 text-indigo-600 dark:text-indigo-400' : 'border-transparent text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'}">${label}${n != null ? ` <span class="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-slate-100 dark:bg-slate-800">${n}</span>` : ''}</button>`;
  root.innerHTML = `
    <div>
      <h2 class="text-xl font-bold text-slate-900 dark:text-white">Equity Radar</h2>
      <p class="text-sm text-slate-500 dark:text-slate-400 mt-1">Lease <b>and finance</b> customers who can likely trade up early. All figures are <b>estimates</b> from your deal inputs + a tunable value model — confirm on the desk before quoting.</p>
    </div>
    <div class="flex items-center gap-1 border-b border-slate-200 dark:border-slate-800 flex-wrap">${tab('radar', 'Radar', __equity.radar.length)}${tab('leases', 'Customer deals', __equity.leases.length)}${tab('settings', 'Assumptions')}</div>
    <div id="equity-body"></div>`;
  renderEquityBody();
}
function eqTab(t) { __equity.tab = t; renderEquityBody(); }
function renderEquityBody() {
  const body = document.getElementById('equity-body'); if (!body) return;
  if (__equity.tab === 'settings') { body.innerHTML = eqSettingsHtml(); return; }
  if (__equity.tab === 'leases') { body.innerHTML = eqLeasesHtml(); return; }
  body.innerHTML = eqRadarHtml();
}
function eqRadarHtml() {
  if (!__equity.radar.length) return `<div class="py-12 text-center text-sm text-slate-400 italic">No pull-ahead opportunities yet. Add deal details on the <button onclick="eqTab('leases')" class="text-indigo-500 font-bold">Customer deals</button> tab — delivered customers in equity or nearing lease-end appear here automatically.</div>`;
  const rows = __equity.radar.map(r => `<tr class="border-b border-slate-100 dark:border-slate-800/60 hover:bg-slate-50 dark:hover:bg-slate-800/40 cursor-pointer" onclick="eqWorksheet('${r.id}')">
    <td class="py-2 px-3"><div class="font-semibold text-slate-900 dark:text-white">${esc(r.name)}</div><div class="text-xs text-slate-400">${esc(r.vehicle)}${r.reachable ? '' : ' · <span class="text-rose-500">opted out</span>'}</div></td>
    <td class="py-2 px-3 text-center">${r.months_remaining ?? '—'}</td>
    <td class="py-2 px-3 text-right text-slate-600 dark:text-slate-300">${eqMoney(r.wholesale)}</td>
    <td class="py-2 px-3 text-right text-slate-600 dark:text-slate-300">${eqMoney(r.payoff)}</td>
    <td class="py-2 px-3 text-right font-bold ${r.equity >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}">${eqMoney(r.equity)}</td>
    <td class="py-2 px-3 text-xs whitespace-nowrap">${esc(r.tier)}</td>
    <td class="py-2 px-3 text-right"><button onclick="event.stopPropagation();eqWorksheet('${r.id}')" class="text-xs font-bold bg-indigo-600 hover:bg-indigo-500 text-white px-3 py-1.5 rounded-lg whitespace-nowrap">View deal →</button></td>
  </tr>`).join('');
  return `<div class="text-xs text-slate-400 mt-3 mb-1">Click a customer to open the upgrade worksheet.</div>
  <div class="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden"><div class="overflow-x-auto"><table class="w-full text-sm text-left min-w-[720px]">
    <thead><tr class="border-b border-slate-200 dark:border-slate-800 text-slate-500 dark:text-slate-400 uppercase text-xs tracking-wider"><th class="py-2 px-3">Customer</th><th class="py-2 px-3 text-center">Mos left</th><th class="py-2 px-3 text-right">Est. wholesale</th><th class="py-2 px-3 text-right">Est. payoff</th><th class="py-2 px-3 text-right">Equity</th><th class="py-2 px-3">Tier</th><th class="py-2 px-3 text-right">Action</th></tr></thead>
    <tbody>${rows}</tbody></table></div></div>`;
}
// AutoAlert-style upgrade worksheet: current lease vs a matched replacement, with the payment delta.
async function eqWorksheet(ownershipId) {
  let ov = document.getElementById('eq-ws-overlay');
  if (!ov) { ov = document.createElement('div'); ov.id = 'eq-ws-overlay'; ov.className = 'fixed inset-0 bg-black/50 z-[70] flex items-start sm:items-center justify-center p-0 sm:p-4 overflow-y-auto'; document.body.appendChild(ov); }
  ov.innerHTML = `<div class="bg-slate-50 dark:bg-slate-950 w-full sm:max-w-3xl sm:rounded-2xl shadow-2xl"><div class="p-10 text-center text-sm text-slate-400 italic">Loading worksheet…</div></div>`;
  ov.onclick = (e) => { if (e.target === ov) ov.remove(); };
  let w;
  try { w = await apiGetJson(`/equity/worksheet/${ownershipId}`); }
  catch (e) { ov.innerHTML = `<div class="bg-white dark:bg-slate-900 w-full sm:max-w-md sm:rounded-2xl p-6 text-center"><div class="text-sm text-rose-600 mb-3">${esc(e.message)}</div><button onclick="document.getElementById('eq-ws-overlay').remove()" class="text-sm font-bold bg-slate-200 dark:bg-slate-800 px-4 py-2 rounded-lg">Close</button></div>`; return; }
  ov.innerHTML = eqWorksheetHtml(w);
}
function eqWsPhoto(url, alt) {
  return url ? `<img src="${esc(url)}" alt="${esc(alt || '')}" class="w-full h-32 object-cover rounded-lg mb-2" onerror="this.style.display='none'">`
    : `<div class="w-full h-32 rounded-lg mb-2 bg-slate-100 dark:bg-slate-800 flex items-center justify-center text-slate-300 dark:text-slate-600"><svg class="w-10 h-10" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M8 17l3-9 4 4 2-3 3 8H6zm-2 3h14a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"/></svg></div>`;
}
function eqWorksheetHtml(w) {
  const cu = w.current, rep = w.replacement, cust = w.customer, unit = (w.settings && w.settings.unit) || 'km';
  const line = (k, v, cls = '') => `<div class="flex justify-between gap-2 py-0.5"><span class="text-slate-400">${k}</span><span class="font-semibold text-slate-800 dark:text-slate-100 ${cls}">${v}</span></div>`;
  const equityCls = cu.equity >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400';
  const deltaBadge = rep && rep.payment_delta != null
    ? `<div class="text-center py-3 px-4 rounded-xl ${rep.payment_delta <= 0 ? 'bg-emerald-50 dark:bg-emerald-950/30' : 'bg-amber-50 dark:bg-amber-950/30'} border ${rep.payment_delta <= 0 ? 'border-emerald-200 dark:border-emerald-900' : 'border-amber-200 dark:border-amber-900'}">
        <div class="text-3xl font-black ${rep.payment_delta <= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'}">${rep.payment_delta <= 0 ? '−' : '+'}${eqMoney(Math.abs(rep.payment_delta)).replace('$', '$')}/mo</div>
        <div class="text-xs text-slate-500 mt-0.5">${rep.payment_delta <= 0 ? 'LESS' : 'more'} than their current payment to get into a newer vehicle</div>
      </div>` : '';
  return `<div class="bg-slate-50 dark:bg-slate-950 w-full sm:max-w-3xl sm:rounded-2xl shadow-2xl max-h-screen overflow-y-auto">
    <div class="sticky top-0 bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 px-5 py-3 flex items-center justify-between z-10">
      <div>
        <div class="text-base font-black text-slate-900 dark:text-white">${esc(cust.name)}</div>
        <div class="text-xs text-slate-400">Upgrade worksheet · ${esc(cu.tier)}</div>
      </div>
      <button onclick="document.getElementById('eq-ws-overlay').remove()" class="text-slate-400 hover:text-slate-600"><svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" d="M6 6l12 12M18 6L6 18"/></svg></button>
    </div>
    <div class="p-4 space-y-3">
      ${deltaBadge}
      <div class="grid sm:grid-cols-2 gap-3">
        <div class="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-3">
          <div class="text-[11px] font-black uppercase tracking-wider text-slate-400 mb-1">Current vehicle</div>
          ${eqWsPhoto(cu.image, cu.vehicle)}
          <div class="font-bold text-sm text-slate-900 dark:text-white mb-2">${esc(cu.vehicle)}${cu.deal_type ? ` <span class="text-[10px] font-bold text-indigo-500">${esc(String(cu.deal_type).toUpperCase())}</span>` : ''}</div>
          <div class="text-sm space-y-0.5">
            ${cu.monthly_payment ? line('Payment', `${eqMoney(cu.monthly_payment)}/mo`) : ''}
            ${cu.months_remaining != null ? line('Payments left', `${cu.months_remaining} of ${cu.term || '?'}`) : ''}
            ${line('Est. mileage', `${Number(cu.est_mileage || 0).toLocaleString()} ${unit}`)}
            ${line('Est. payoff', eqMoney(cu.payoff))}
            ${line('Est. wholesale', eqMoney(cu.wholesale))}
            <div class="border-t border-slate-100 dark:border-slate-800 mt-1 pt-1">${line('Estimated equity', eqMoney(cu.equity), equityCls)}</div>
          </div>
        </div>
        <div class="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-3">
          <div class="text-[11px] font-black uppercase tracking-wider text-indigo-500 mb-1">Suggested replacement</div>
          ${rep ? `${eqWsPhoto(rep.image, rep.vehicle)}
            <div class="font-bold text-sm text-slate-900 dark:text-white mb-2">${esc(rep.vehicle)}${rep.condition ? ` <span class="text-[10px] font-bold text-slate-400 uppercase">${esc(rep.condition)}</span>` : ''}</div>
            <div class="text-sm space-y-0.5">
              ${line('Price', eqMoney(rep.price))}
              ${line('Equity applied', `−${eqMoney(rep.equity_applied)}`)}
              ${rep.down ? line('Cash down', `−${eqMoney(rep.down)}`) : ''}
              ${line('Financed', eqMoney(rep.financed))}
              <div class="border-t border-slate-100 dark:border-slate-800 mt-1 pt-1">${line('Est. payment', `${eqMoney(rep.est_payment)}/mo`, 'text-indigo-600 dark:text-indigo-400')}</div>
              <div class="text-[10px] text-slate-400 text-right">est. ${rep.apr}% APR · ${rep.term} mo — confirm on desk</div>
            </div>`
            : `<div class="py-8 text-center text-sm text-slate-400 italic">No matching in-stock vehicle to suggest right now. Add inventory and reopen.</div>`}
        </div>
      </div>
      <div class="flex flex-wrap gap-2 justify-end pt-1">
        ${cust.phone ? `<a href="tel:${esc(cust.phone)}" class="text-sm font-bold bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200 px-4 py-2 rounded-lg">Call</a>` : ''}
        <button onclick="eqPullAhead('${cu.ownership_id}', this)" ${cust.reachable ? '' : 'disabled'} class="text-sm font-bold ${cust.reachable ? 'bg-indigo-600 hover:bg-indigo-500 text-white' : 'bg-slate-200 text-slate-400 dark:bg-slate-800'} px-4 py-2 rounded-lg">Start pull-ahead</button>
      </div>
      <p class="text-[11px] text-slate-400">Every figure is an <b>estimate</b> from the lease inputs, a tunable value model, and your assumed rate — not a lender quote. Confirm on the desk before presenting.</p>
    </div>
  </div>`;
}
// Deal-type field visibility: which deal types each input applies to.
function eqDealTypeToggle(sel) {
  const card = sel.closest('[data-lease]'); if (!card) return;
  const dt = sel.value;
  card.querySelectorAll('[data-dt]').forEach(el => { el.style.display = el.dataset.dt.split(' ').includes(dt) ? '' : 'none'; });
}
const eqDvis = (applies, dt) => applies.split(' ').includes(dt) ? '' : 'style="display:none"';
const DEAL_LABELS = { lease: 'Lease', finance: 'Finance', cash: 'Cash / owned' };
// The deal-detail fields, shared by the Customer-deals tab and the CRM shortcut.
function eqDealFields(l, ic, prefix, dt, settings) {
  const s = settings || __equity.settings || {};
  const unit = s.unit || 'km', km = s.annual_km_allowance || (unit === 'mi' ? 15000 : 20000);
  const f = (applies, label, cls, val, ph) => `<div data-dt="${applies}" ${eqDvis(applies, dt)}><label class="text-[10px] text-slate-400">${label}</label><input class="${prefix}${cls} ${ic}" type="number" value="${val ?? ''}" placeholder="${ph}"></div>`;
  return [
    f('lease finance', 'Term (months)', 'term', l.lease_term_months, dt === 'lease' ? '48' : '72'),
    f('lease finance', 'Monthly payment', 'pay', l.monthly_payment, '680'),
    f('lease', 'Residual value', 'res', l.residual_value, '24000'),
    f('finance', 'Amount financed', 'loan', l.loan_amount, '52000'),
    f('finance', 'APR (%)', 'apr', l.loan_apr, '6.9'),
    f('finance cash', 'Purchase price', 'price', l.purchase_price, '54900'),
    f('lease finance', 'Payoff (blank = est.)', 'payoff', l.payoff_amount, 'auto'),
    f('lease finance cash', `Delivery mileage (${unit})`, 'miles', l.delivery_mileage, '20'),
    f('lease finance cash', `Annual ${unit} allowance`, 'km', l.annual_km_allowance, String(km)),
  ].join('');
}
function eqLeasesHtml() {
  if (!__equity.leases.length) return `<div class="py-12 text-center text-sm text-slate-400 italic">No delivered customers yet. When you mark a deal <b>Delivered</b> in the CRM, it shows up here to add lease or finance details.</div>`;
  const ic = 'bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded px-2 py-1 text-xs w-full';
  return `<div class="space-y-2 mt-3">${__equity.leases.map(l => { const dt = l.deal_type || (l.is_leased ? 'lease' : 'finance'); return `<div class="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-3" data-lease="${l.id}">
    <div class="flex items-center gap-2 mb-2 flex-wrap">
      <select class="lz-dtype bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded px-2 py-1 text-xs font-bold" onchange="eqDealTypeToggle(this)">${Object.keys(DEAL_LABELS).map(t => `<option value="${t}" ${dt === t ? 'selected' : ''}>${DEAL_LABELS[t]}</option>`).join('')}</select>
      <div class="font-bold text-sm text-slate-900 dark:text-white flex-1 truncate min-w-0">${esc(l.name)} <span class="text-[11px] font-normal text-slate-400">${esc(l.vehicle)}</span></div>
      ${l.equity != null ? `<span class="text-xs font-bold ${l.equity >= 0 ? 'text-emerald-600' : 'text-rose-600'}">${eqMoney(l.equity)} equity${l.months_remaining != null ? ` · ${l.months_remaining} mo left` : ''}</span>` : ''}
    </div>
    <div class="mb-2"><label class="text-[10px] text-slate-400">Vehicle purchased</label><select class="lz-vehicle ${ic}">${eqVehicleOptions(l.vehicle_id, l.vehicle)}</select></div>
    <div class="grid grid-cols-2 sm:grid-cols-4 gap-2">
      ${eqDealFields(l, ic, 'lz-', dt, __equity.settings)}
      <div class="sm:col-span-4 flex items-end justify-end"><button onclick="eqSaveLease('${l.id}', this)" class="text-xs font-bold bg-indigo-600 hover:bg-indigo-500 text-white px-4 py-1.5 rounded-lg">Save</button></div>
    </div>
  </div>`; }).join('')}</div>`;
}
function eqSettingsHtml() {
  const s = __equity.settings || {};
  const inp = (id, v, ph) => `<input id="${id}" type="number" step="any" value="${v == null ? '' : v}" placeholder="${ph}" class="w-full bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded-lg px-3 py-2 text-sm">`;
  const lbl = (t) => `<label class="block text-[11px] font-semibold text-slate-500 dark:text-slate-400 mb-1">${t}</label>`;
  return `<div class="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 mt-3 max-w-lg space-y-2">
    <p class="text-[11px] text-slate-400">These drive the estimates. Wholesale haircut is the retail→wholesale spread (0.12 = 12%). Lower it to be more aggressive (closer to retail trade value).</p>
    <div class="grid grid-cols-2 gap-2">
      <div>${lbl('Annual ' + eqUnit() + ' allowance')}${inp('eq-km', s.annual_km_allowance, eqUnit() === 'mi' ? '15000' : '20000')}</div>
      <div>${lbl('Wholesale haircut (0–0.5)')}${inp('eq-haircut', s.wholesale_haircut, '0.12')}</div>
      <div>${lbl('Min equity to flag ($)')}${inp('eq-min', s.equity_min, '500')}</div>
      <div>${lbl('High-equity threshold ($)')}${inp('eq-high', s.high_equity, '1000')}</div>
      <div>${lbl('Maturity window (months)')}${inp('eq-window', s.months_window, '6')}</div>
    </div>
    <div class="pt-2 border-t border-slate-100 dark:border-slate-800">
      <p class="text-[11px] text-slate-400 mb-2">Assumed financing for the <b>upgrade worksheet</b> — used only to estimate the replacement vehicle's payment. Not a lender quote.</p>
      <div class="grid grid-cols-3 gap-2">
        <div>${lbl('Assumed APR (%)')}${inp('eq-apr', s.default_apr, '6.9')}</div>
        <div>${lbl('Term (months)')}${inp('eq-term', s.default_term_months, '60')}</div>
        <div>${lbl('Cash down ($)')}${inp('eq-down', s.default_down, '0')}</div>
      </div>
      <div class="grid grid-cols-2 gap-2 mt-2">
        <div>${lbl('Retail depreciation / mo (0–0.1)')}${inp('eq-dep', s.depreciation_per_month, '0.015')}</div>
      </div>
      <p class="text-[10px] text-slate-400 mt-1">Depreciation estimates a financed/owned vehicle's current value from its purchase price. 0.015 ≈ 18%/yr.</p>
    </div>
    <button onclick="eqSaveSettings(this)" class="text-sm font-bold bg-indigo-600 hover:bg-indigo-500 text-white px-4 py-2 rounded-lg">Save assumptions</button>
  </div>`;
}
async function eqSaveLease(id, btn) {
  const card = btn.closest('[data-lease]'); const g = (c) => card.querySelector(c)?.value.trim();
  const body = {
    deal_type: card.querySelector('.lz-dtype')?.value || 'lease',
    vehicle_id: card.querySelector('.lz-vehicle')?.value || '',
    lease_term_months: g('.lz-term'), monthly_payment: g('.lz-pay'), residual_value: g('.lz-res'),
    loan_amount: g('.lz-loan'), loan_apr: g('.lz-apr'), purchase_price: g('.lz-price'),
    payoff_amount: g('.lz-payoff'), delivery_mileage: g('.lz-miles'), annual_km_allowance: g('.lz-km'),
  };
  const orig = btn.textContent; btn.disabled = true; btn.textContent = 'Saving…';
  try { await apiSendJson(`/equity/lease/${id}`, 'PUT', body); showToast('Deal saved', 'success'); loadEquityPage(); }
  catch (e) { btn.disabled = false; btn.textContent = orig; showToast(e.message, 'error'); }
}
async function eqSaveSettings(btn) {
  const v = (i) => document.getElementById(i)?.value;
  const orig = btn.textContent; btn.disabled = true; btn.textContent = 'Saving…';
  try { const d = await apiSendJson('/equity/settings', 'PUT', { annual_km_allowance: v('eq-km'), wholesale_haircut: v('eq-haircut'), equity_min: v('eq-min'), high_equity: v('eq-high'), months_window: v('eq-window'), default_apr: v('eq-apr'), default_term_months: v('eq-term'), default_down: v('eq-down'), depreciation_per_month: v('eq-dep') }); __equity.settings = d.settings; showToast('Saved — refreshing radar', 'success'); loadEquityPage(); }
  catch (e) { btn.disabled = false; btn.textContent = orig; showToast(e.message, 'error'); }
}
async function eqPullAhead(id, btn) {
  if (!confirm('Start a pull-ahead? This texts the customer an equity offer (through the compliance checks) and creates a high-priority task for the rep.')) return;
  const orig = btn.textContent; btn.disabled = true; btn.textContent = '…';
  try { await apiSendJson(`/equity/pull-ahead/${id}`, 'POST', {}); showToast('Pull-ahead started — message queued + task created', 'success'); btn.textContent = '✓ Started'; }
  catch (e) { btn.disabled = false; btn.textContent = orig; showToast(e.message, 'error'); }
}
Object.assign(window, { loadEquityPage, eqTab, eqSaveLease, eqSaveSettings, eqPullAhead, eqWorksheet, eqDealTypeToggle });

window.openVehicleForm = openVehicleForm;
window.vehDelete = vehDelete;
window.vehGenPitch = vehGenPitch;
window.generateAllPitches = generateAllPitches;
window.editVehicle = editVehicle;
window.openPhotoBackgroundUploader = openPhotoBackgroundUploader;
window.uploadPhotoBackground = uploadPhotoBackground;
window.removePhotoBackground = removePhotoBackground;

async function loadInventoryCatalog() {
  const list = document.getElementById('catalog-list');
  list.innerHTML = '<div class="text-xs text-slate-500 italic col-span-full">Loading catalog...</div>';
  try {
    const res = await fetch(`${API}/inventory/all`, { headers: { 'Authorization': `Bearer ${token}` } });
    const body = await res.json().catch(() => []);
    if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
    __catalogCache = Array.isArray(body) ? body : [];
    // Inventory Intelligence add-on: pull each used car's market median (from the
    // last Inventory Scan) so cards can show a "% to market" badge.
    if (__invIntelActive) {
      try {
        const pr = await fetch(`${API}/ai/market-positions`, { headers: { 'Authorization': `Bearer ${token}` } });
        if (pr.ok) __marketPositions = (await pr.json()).positions || {};
      } catch {}
    }
    renderCatalog();
  } catch (err) {
    list.innerHTML = `<div class="text-xs text-red-400 col-span-full">Failed to load catalog: ${err.message}</div>`;
  }
}

let __catalogStatusFilter = 'all';
let __catalogTypeFilter = 'all';
let __catalogSegmentFilter = 'all';

function renderCatalog() {
  const list = document.getElementById('catalog-list');
  const q = document.getElementById('catalog-search').value.trim().toLowerCase();
  const statusFilter = __catalogStatusFilter;
  const typeFilter = __catalogTypeFilter;
  const segmentFilter = __catalogSegmentFilter;

  const conditionRank = (v) => {
    const c = (v.condition || '').toLowerCase();
    if (c === 'used') return 0;
    if (c === 'demo') return 1;
    if (c === 'new') return 2;
    return 3; // unknown
  };
  const catalogSortRank = (v) => {
    const s = v.status;
    if (s === 'sold') return 400 + conditionRank(v);
    if (s === 'pending') return 300 + conditionRank(v);
    // available / posted: Used → Demo → New
    return conditionRank(v);
  };

  let filtered = __catalogCache;
  if (statusFilter !== 'all') {
    filtered = filtered.filter(v => v.status === statusFilter);
  }
  if (typeFilter !== 'all') {
    filtered = filtered.filter(v => (v.condition || '').toLowerCase() === typeFilter);
  }
  if (segmentFilter !== 'all') {
    filtered = filtered.filter(v => {
      const mm = `${v.make} ${v.model}`.toLowerCase();
      return segmentFilter === 'hot' ? __hotMakeModels.has(mm) : __coldMakeModels.has(mm);
    });
  }
  if (q) {
    filtered = filtered.filter(v =>
      `${v.year} ${v.make} ${v.model} ${v.trim || ''} ${v.vin || ''} ${v.stocknumber || ''} ${v.exterior_color || ''}`
        .toLowerCase()
        .includes(q)
    );
  }
  filtered = [...filtered].sort((a, b) => catalogSortRank(a) - catalogSortRank(b));

  if (!filtered.length) {
    list.innerHTML = '<div class="text-xs text-slate-500 italic col-span-full">No vehicles match.</div>';
    return;
  }

  // Glass tag base — translucent fill + subtle border + blur, rounded rectangle.
  const TAG = 'inline-flex items-center text-[10px] uppercase font-bold px-2 py-0.5 rounded-md border backdrop-blur-sm';
  const statusBadge = (s) => {
    const map = {
      available: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30',
      pending:   'bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30',
      sold:      'bg-slate-500/15 text-slate-600 dark:text-slate-300 border-slate-500/30'
    };
    return `<span class="${TAG} ${map[s] || map.sold}">${s || 'unknown'}</span>`;
  };
  const conditionBadge = (c) => {
    if (!c) return '';
    const lc = c.toLowerCase();
    const cls = lc === 'new'
      ? 'bg-blue-500/15 text-blue-700 dark:text-blue-300 border-blue-500/30'
      : lc === 'demo'
        ? 'bg-purple-500/15 text-purple-700 dark:text-purple-300 border-purple-500/30'
        : 'bg-orange-500/15 text-orange-700 dark:text-orange-300 border-orange-500/30';
    return `<span class="${TAG} ${cls}">${c}</span>`;
  };

  list.innerHTML = filtered.map(v => {
    const img = v.image_urls?.[0]
      ? `<img src="${API}/proxy-image?url=${encodeURIComponent(v.image_urls[0])}" loading="lazy" class="w-full h-32 object-cover rounded bg-slate-50 dark:bg-slate-950">`
      : catalogCarPlaceholder('w-full h-32 rounded');
    const price = v.price ? `$${Number(v.price).toLocaleString()}` : '—';
    const mileage = v.mileage ? `${Number(v.mileage).toLocaleString()} km` : 'New';
    // Every card is clickable. Prefer the vehicle's source_url (harvested or per-feed),
    // fall back to a stock-number search on the dealer's site so the click still does
    // something useful even when we don't have a direct URL.
    const fallbackUrl = (() => {
      try {
        const base = v.source_url ? new URL(v.source_url).origin : null;
        if (base && v.stocknumber) return `${base}/?s=${encodeURIComponent(v.stocknumber)}`;
        return null;
      } catch { return null; }
    })();
    const href = v.source_url || fallbackUrl;
    const tag = href ? 'a' : 'div';
    const linkAttrs = href
      ? `href="${href}" target="_blank" rel="noopener" title="Open on dealer site ↗"`
      : '';
    const externalIcon = href
      ? `<svg class="w-3 h-3 text-slate-400 dark:text-slate-500 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"/></svg>`
      : '';
    return `
      <${tag} ${linkAttrs} class="relative bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded p-3 flex flex-col gap-2 ${href ? 'hover:border-indigo-400 dark:hover:border-indigo-500 transition no-underline' : ''}">
        ${v.source === 'manual' ? `<button onclick="event.preventDefault();event.stopPropagation();editVehicle('${v.id}')" title="Edit vehicle" class="absolute top-1.5 right-1.5 z-10 bg-white/90 dark:bg-slate-800/90 hover:bg-white dark:hover:bg-slate-700 rounded-md p-1 shadow border border-slate-200 dark:border-slate-700"><svg class="w-3.5 h-3.5 text-slate-600 dark:text-slate-300" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M11 4H4a1 1 0 00-1 1v14a1 1 0 001 1h14a1 1 0 001-1v-7M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>` : ''}
        ${img}
        <div class="text-xs font-bold text-slate-900 dark:text-white truncate" title="${v.year} ${v.make} ${v.model} ${v.trim || ''}">${v.year} ${v.make} ${v.model}</div>
        <div class="flex items-center gap-1 flex-wrap">
          ${conditionBadge(v.condition)}
          ${statusBadge(v.status)}
          ${(() => {
            const makeModel = `${v.make} ${v.model}`.toLowerCase()
            const gtag = 'inline-flex items-center text-[10px] font-bold px-2 py-0.5 rounded-md border backdrop-blur-sm'
            const hotColdTag = __aiBoostActive
              ? (__hotMakeModels.has(makeModel) ? `<span class="${gtag} bg-orange-500/15 text-orange-700 dark:text-orange-300 border-orange-500/30">🔥 Hot</span>`
                : __coldMakeModels.has(makeModel) ? `<span class="${gtag} bg-sky-500/15 text-sky-700 dark:text-sky-300 border-sky-500/30">❄️ Cold</span>`
                : '')
              : ''
            const healthScore = __aiBoostActive && __vehicleHealthScores[v.id] != null ? __vehicleHealthScores[v.id] : null
            const healthBadge = healthScore != null ? (() => {
              const cls = healthScore >= 80 ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30'
                : healthScore >= 50 ? 'bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30'
                : 'bg-red-500/15 text-red-700 dark:text-red-300 border-red-500/30'
              return `<span class="${gtag} ${cls}">⚡ ${healthScore}/100</span>`
            })() : ''
            const recallCount = Array.isArray(v.recalls) ? v.recalls.length : 0
            const recallBadge = recallCount > 0
              ? `<span class="${gtag} bg-red-500/15 text-red-700 dark:text-red-300 border-red-500/30" title="${recallCount} open recall${recallCount > 1 ? 's' : ''} — open VIN Decode for details">⚠ ${recallCount} Recall${recallCount > 1 ? 's' : ''}</span>`
              : ''
            // "% to market" — used cars only, from the last Inventory Scan's market median.
            const mktMedian = __invIntelActive ? __marketPositions[v.id] : null
            const isUsedCar = (v.condition || '').toLowerCase() === 'used'
            let marketBadge = ''
            if (mktMedian && isUsedCar && v.price > 0) {
              const pct = Math.round((Number(v.price) / mktMedian) * 100)
              // Suppress implausible values (thin/noisy comps) — only show a sane band.
              if (pct >= 60 && pct <= 160) {
                const cls = pct > 103 ? 'bg-red-500/15 text-red-700 dark:text-red-300 border-red-500/30'
                  : pct < 97 ? 'bg-sky-500/15 text-sky-700 dark:text-sky-300 border-sky-500/30'
                  : 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30'
                marketBadge = `<span class="${gtag} ${cls}" title="Your price vs live market median $${Number(mktMedian).toLocaleString()}">${pct}% to market</span>`
              }
            }
            return hotColdTag + healthBadge + recallBadge + marketBadge
          })()}
        </div>
        <div class="text-xs text-slate-500 dark:text-slate-400 truncate flex items-center gap-1">
          <span class="truncate">${v.trim || ''} ${v.exterior_color ? '· ' + v.exterior_color : ''}</span>
          ${externalIcon}
        </div>
        <div class="flex items-center justify-between text-xs mt-auto">
          <span class="font-bold text-indigo-600 dark:text-indigo-400">${price}</span>
          ${v.stocknumber ? `<span class="font-mono text-slate-400 dark:text-slate-500">#${v.stocknumber}</span>` : ''}
          <span class="text-slate-500">${mileage}</span>
        </div>
        ${__vinStickerActive ? (() => {
          // Recall status + VIN/sticker/brochure actions live on the card for
          // Inventory Intelligence dealers (no separate page).
          const rc = Array.isArray(v.recalls) ? v.recalls.length : 0;
          const recallLine = rc > 0
            ? `<div class="text-[11px] font-bold text-red-600 dark:text-red-400">⚠ ${rc} open recall${rc > 1 ? 's' : ''}</div>`
            : v.recalls_checked_at
              ? `<div class="text-[11px] font-semibold text-emerald-600 dark:text-emerald-400">✓ No open recalls</div>`
              : `<div class="text-[11px] text-slate-400 dark:text-slate-500">Recalls not checked yet</div>`;
          const b = 'text-[10px] font-bold px-2 py-1 rounded transition';
          const vinAttr = v.vin ? `data-vin="${v.vin}"` : '';
          const lbl = `${v.year} ${v.make} ${v.model}${v.trim ? ' ' + v.trim : ''}`.replace(/"/g, '&quot;');
          return `
            <div class="mt-1.5 pt-2 border-t border-slate-200 dark:border-slate-800 flex flex-col gap-1.5" onclick="event.preventDefault();event.stopPropagation();">
              ${recallLine}
              ${v.vin ? `<div class="flex flex-wrap gap-1">
                <button class="inv-vin-btn ${b} bg-slate-200 dark:bg-slate-800 text-slate-700 dark:text-slate-200 hover:bg-slate-300 dark:hover:bg-slate-700" data-id="${v.id}" ${vinAttr}>Decode VIN</button>
                <button class="inv-sticker-btn ${b} bg-emerald-600 hover:bg-emerald-500 text-white" data-id="${v.id}" data-label="${lbl}" data-oem-url="${v.window_sticker_oem_url || ''}" data-gen-url="${v.window_sticker_gen_url || ''}">Sticker ▾</button>
                <button class="inv-brochure-btn ${b} bg-indigo-600 hover:bg-indigo-500 text-white" data-id="${v.id}" data-label="${lbl}" data-oem-url="${v.brochure_oem_url || ''}" data-gen-url="${v.brochure_gen_url || ''}">Brochure ▾</button>
                <button type="button" onclick="event.preventDefault();event.stopPropagation();openCarfax('${v.id}','${v.vin}')" class="${b} bg-[#0a1e3f] hover:bg-[#122a52] text-white flex items-center gap-1 tracking-tight" title="Pull the Carfax report for this VIN">CARFAX<span class="text-red-500 leading-none">🍁</span></button>
              </div>` : `<div class="text-[10px] text-slate-400 italic">No VIN on file — can't decode or build docs.</div>`}
            </div>`;
        })() : ''}
      </${tag}>
    `;
  }).join('');

  // One-click AI listing copy (AI Boost). Non-subscribers get the upgrade modal.
  list.querySelectorAll('.inv-aiwrite-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      if (__aiBoostActive) openAIEnrich(btn.dataset.id);
      else openUpgradeModal('ai_boost');
    });
  });

  // Wire the on-card Inventory-Intelligence actions (VIN decode, sticker, brochure).
  if (__vinStickerActive) {
    list.querySelectorAll('.inv-vin-btn').forEach(btn => {
      btn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); openVinDecode(btn.dataset.id, btn.dataset.vin); });
    });
    list.querySelectorAll('.inv-sticker-btn').forEach(btn => {
      btn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); showStickerChoice(btn); });
    });
    list.querySelectorAll('.inv-brochure-btn').forEach(btn => {
      btn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); showBrochureChoice(btn); });
    });
  }
}

function setupActionListeners() {
  // Profile & Settings is its own nav page now — make sure the card is relocated
  // into the profile page (in case this runs before the first switchPage).
  ensurePanelsInOriginalLocations();

  // Profile update form (full identity + workspace)
  document.getElementById('profile-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = document.getElementById('profile-msg');
    // Handle avatar upload if a new file was selected
    let avatarUrl = profileContext.avatar_url || null;
    const avatarFile = document.getElementById('prof-avatar-file').files[0];
    if (avatarFile) {
      try {
        const fd = new FormData(); fd.append('avatar', avatarFile);
        const upRes = await fetch(`${API}/profile/avatar`, {
          method: 'POST', headers: { 'Authorization': `Bearer ${token}` }, body: fd
        });
        const upData = await upRes.json().catch(() => ({}));
        if (upRes.ok) avatarUrl = upData.url;
        else {
          showMsg(`Avatar upload failed: ${upData.error || upRes.status}`, 'err');
          return;
        }
      } catch (e) {
        showMsg(`Avatar upload error: ${e.message}`, 'err');
        return;
      }
    } else if (!document.getElementById('prof-avatar-img').src && profileContext.avatar_url) {
      avatarUrl = null; // user removed it
    }

    const payload = {
      fullName: document.getElementById('prof-name').value.trim(),
      displayName: document.getElementById('prof-display-name').value.trim(),
      phone: document.getElementById('prof-phone')?.value.trim() || '',
      email: document.getElementById('prof-email').value.trim(),
      password: document.getElementById('prof-password').value,
      dealershipName: document.getElementById('prof-dealername').value.trim(),
      websiteUrl: document.getElementById('prof-website').value.trim(),
      avatarUrl,
    };
    // Strip empties so we only send fields the user actually changed
    Object.keys(payload).forEach(k => { if (!payload[k]) delete payload[k]; });

    const showMsg = (text, kind) => {
      msg.textContent = text;
      msg.className = kind === 'ok'
        ? 'mb-3 p-2 bg-emerald-100 dark:bg-emerald-900/50 border border-emerald-300 dark:border-emerald-700 text-emerald-700 dark:text-emerald-200 text-xs rounded'
        : 'mb-3 p-2 bg-red-100 dark:bg-red-900/50 border border-red-300 dark:border-red-700 text-red-700 dark:text-red-200 text-xs rounded';
      msg.classList.remove('hidden');
    };

    try {
      const res = await fetch(`${API}/profile/update`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Update failed');

      showMsg('Profile updated successfully.', 'ok');
      if (payload.fullName) document.getElementById('ui-profile-name').textContent = payload.fullName;
      if (payload.dealershipName) document.getElementById('ui-dealership-name').textContent = payload.dealershipName;
      document.getElementById('prof-password').value = '';
    } catch (err) {
      showMsg(err.message || 'Failed to update profile.', 'err');
    }
  });

  // Inventory feed add form
  document.getElementById('add-feed-form')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const url = document.getElementById('add-feed-url').value.trim();
    const type = document.getElementById('add-feed-type').value;
    if (url) addFeed(url, type);
  });

  // Manual sync trigger
  document.getElementById('sync-now-btn')?.addEventListener('click', syncNow);

  // Catalog search + pill filters
  document.getElementById('catalog-search')?.addEventListener('input', renderCatalog);

  document.getElementById('catalog-status-pills')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.catalog-status-pill');
    if (!btn) return;
    __catalogStatusFilter = btn.dataset.status;
    document.querySelectorAll('.catalog-status-pill').forEach(b => {
      const active = b.dataset.status === __catalogStatusFilter;
      b.className = active
        ? 'catalog-status-pill active px-3 py-1 rounded-full text-xs font-semibold bg-indigo-600 text-white transition'
        : 'catalog-status-pill px-3 py-1 rounded-full text-xs font-semibold border border-slate-300 dark:border-slate-600 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition';
    });
    renderCatalog();
  });

  document.getElementById('catalog-type-pills')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.catalog-type-pill');
    if (!btn) return;
    __catalogTypeFilter = btn.dataset.type;
    document.querySelectorAll('.catalog-type-pill').forEach(b => {
      const active = b.dataset.type === __catalogTypeFilter;
      b.className = active
        ? 'catalog-type-pill active px-3 py-1 rounded-full text-xs font-semibold bg-indigo-600 text-white transition'
        : 'catalog-type-pill px-3 py-1 rounded-full text-xs font-semibold border border-slate-300 dark:border-slate-600 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition';
    });
    renderCatalog();
  });

  document.getElementById('catalog-segment-pills')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.catalog-segment-pill');
    if (!btn) return;
    __catalogSegmentFilter = btn.dataset.seg;
    document.querySelectorAll('.catalog-segment-pill').forEach(b => {
      const active = b.dataset.seg === __catalogSegmentFilter;
      b.className = active
        ? 'catalog-segment-pill active px-3 py-1 rounded-full text-xs font-semibold bg-indigo-600 text-white transition'
        : 'catalog-segment-pill px-3 py-1 rounded-full text-xs font-semibold border border-slate-300 dark:border-slate-600 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition';
    });
    renderCatalog();
  });

  // Rep drill-down modal close
  document.getElementById('rep-detail-close')?.addEventListener('click', closeRepDetail);
  document.getElementById('rep-detail-modal')?.addEventListener('click', (e) => {
    if (e.target.id === 'rep-detail-modal') closeRepDetail();
  });

  // Team invite toggle + form
  const inviteForm = document.getElementById('invite-rep-form');
  const openInvite = (role) => {
    document.getElementById('invite-role').value = role;
    document.getElementById('invite-form-title').textContent = role === 'MANAGER' ? 'Invite a manager' : 'Invite a sales rep';
    document.getElementById('invite-submit-btn').textContent = role === 'MANAGER' ? 'Create Manager' : 'Create Rep';
    document.getElementById('invite-email').placeholder = role === 'MANAGER' ? 'manager@dealership.com' : 'rep@dealership.com';
    inviteForm.classList.remove('hidden');
    document.getElementById('invite-result').classList.add('hidden');
  };
  document.getElementById('invite-rep-btn')?.addEventListener('click', () => openInvite('SALES_REP'));
  document.getElementById('invite-manager-btn')?.addEventListener('click', () => openInvite('MANAGER'));
  document.getElementById('invite-cancel-btn')?.addEventListener('click', () => {
    inviteForm.classList.add('hidden');
  });
  inviteForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const payload = {
      full_name: document.getElementById('invite-name').value.trim(),
      email: document.getElementById('invite-email').value.trim(),
      password: document.getElementById('invite-password').value || undefined,
      role: document.getElementById('invite-role').value || 'SALES_REP'
    };
    try {
      const data = await inviteRep(payload);
      showInviteResult(
        `Created <b>${data.email}</b>. Temporary password: <code class="bg-slate-100 dark:bg-slate-800 px-1 py-0.5 rounded">${data.temp_password}</code> — share securely.`,
        'ok'
      );
      inviteForm.reset();
      inviteForm.classList.add('hidden');
      loadDealerManagementMatrix();
    } catch (err) {
      showInviteResult(err.message, 'err');
    }
  });

  // Launch Dedicated Stripe Gateway Session
  document.getElementById('launch-portal-btn')?.addEventListener('click', launchStripeLifecycle);

  // Global Session Exits
  document.getElementById('logout-btn').addEventListener('click', () => {
    // Tell the extension bridge this is a deliberate sign-out so it logs the
    // extension out too instead of auto-logging the site back in.
    sessionStorage.setItem('ms_logged_out', '1');
    clearLocalStorage();
    window.location.href = 'login.html';
  });
}

async function launchStripeLifecycle() {
  const btn = document.getElementById('launch-portal-btn');
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Connecting to billing...";
  }

  try {
    let res = await fetch(`${API}/billing/portal`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` }
    });

    if (res.status === 400 || !res.ok) {
      res = await fetch(`${API}/billing/checkout`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` }
      });
    }

    const data = await res.json();
    if (data.complimentary) {
      alert("You're on a complimentary MarketSync plan — there's nothing to manage in billing. Reach out if you have questions.");
      return;
    }
    if (data.url) {
      window.open(data.url, '_blank', 'noopener,noreferrer');
    } else {
      throw new Error(data.error || 'No billing URL returned');
    }
  } catch (err) {
    alert('Could not open billing settings. Please contact support.');
    if (btn) { btn.disabled = false; }
  } finally {
    if (btn) btn.textContent = 'Manage Billing';
  }
}
async function fetchInsights() {
  const response = await fetch(`${API}/dealership/team-insights`, {
    headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
  });

  if (response.status === 402) {
    // Automatically redirect to upgrade page if subscription is inactive
    window.location.href = '/upgrade.html';
    return;
  }
  
  const data = await response.json();
  // ... render your data
}

// ──────────────────────────────────────────────────────────────────────────────
// SECURITY PANEL — extra login code (2FA), backup codes, passkeys, sign-in history
// ──────────────────────────────────────────────────────────────────────────────
async function initSecurityPanel() {
  await refreshMfaStatus();
  await loadPasskeys();

  document.getElementById('mfa-toggle-btn')?.addEventListener('click', async () => {
    const btn = document.getElementById('mfa-toggle-btn');
    const isOn = btn.textContent.toLowerCase().includes('off');  // "Turn Off" = currently on
    if (isOn) {
      if (!confirm("Turn off the extra login code? Your account will be easier for someone else to break into.")) return;
      btn.disabled = true; btn.textContent = 'Turning off…';
      try {
        await fetch(`${API}/auth/2fa/disable`, {
          method: 'POST', headers: { 'Authorization': `Bearer ${token}` }
        });
        await refreshMfaStatus();
      } finally { btn.disabled = false; }
    } else {
      btn.disabled = true; btn.textContent = 'Loading…';
      try {
        const res = await fetch(`${API}/auth/2fa/enroll`, {
          method: 'POST', headers: { 'Authorization': `Bearer ${token}` }
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Could not start.');
        currentEnrollment = { factor_id: data.factor_id, secret: data.secret };
        document.getElementById('mfa-enroll-panel').classList.remove('hidden');
        document.getElementById('mfa-secret-text').textContent = data.secret;
        const canvas = document.getElementById('mfa-qr-canvas');
        if (data.qr_code_uri && window.QRCode) {
          QRCode.toCanvas(canvas, data.qr_code_uri, { width: 180, margin: 1 }, (qrErr) => {
            if (qrErr) console.error('QR render failed:', qrErr);
          });
        } else if (data.qr_code_uri) {
          // QR library failed to load — keep enrollment usable via the typed code.
          const note = document.getElementById('mfa-qr-container');
          if (note) note.innerHTML = '<p class="text-xs text-slate-600 p-4">Can\'t show the picture right now — use the code below to add it by hand.</p>';
        }
        btn.textContent = 'Cancel';
      } catch (err) {
        alert(err.message);
        btn.disabled = false; btn.textContent = 'Turn On';
      }
    }
  });

  document.getElementById('mfa-enroll-verify-btn')?.addEventListener('click', async () => {
    const code = document.getElementById('mfa-enroll-code').value.trim();
    const errEl = document.getElementById('mfa-enroll-error');
    errEl.classList.add('hidden');
    if (!/^\d{6}$/.test(code)) {
      errEl.textContent = 'Type the 6 numbers from your app.';
      errEl.classList.remove('hidden'); return;
    }
    try {
      const res = await fetch(`${API}/auth/2fa/verify-enroll`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ factor_id: currentEnrollment.factor_id, code })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'That code did not work.');

      document.getElementById('mfa-enroll-panel').classList.add('hidden');
      document.getElementById('mfa-enroll-code').value = '';
      await refreshMfaStatus();

      // Show the backup codes ONCE — user must copy or download them
      if (Array.isArray(data.recovery_codes) && data.recovery_codes.length) {
        showBackupCodes(data.recovery_codes);
      }
    } catch (err) {
      errEl.textContent = err.message;
      errEl.classList.remove('hidden');
    }
  });

  // "Make new backup codes" button — visible once 2FA is on
  document.getElementById('regen-codes-btn')?.addEventListener('click', async () => {
    if (!confirm("Make a new set of backup codes? Your old codes will stop working right away.")) return;
    try {
      const res = await fetch(`${API}/auth/2fa/regenerate-recovery-codes`, {
        method: 'POST', headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not make new codes.');
      showBackupCodes(data.recovery_codes);
    } catch (err) { alert(err.message); }
  });

  // Add passkey button
  document.getElementById('add-passkey-btn')?.addEventListener('click', registerNewPasskey);

  document.getElementById('show-sessions-btn')?.addEventListener('click', () => {
    const panel = document.getElementById('sessions-panel');
    const wasHidden = panel.classList.contains('hidden');
    panel.classList.toggle('hidden');
    if (wasHidden) loadSessions();
  });

  document.getElementById('revoke-sessions-btn')?.addEventListener('click', async () => {
    if (!confirm('Sign out all other devices? You will stay signed in here.')) return;
    try {
      const res = await fetch(`${API}/me/sessions/revoke-others`, {
        method: 'POST', headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = await res.json();
      alert(data.message || 'Other devices signed out.');
      if (data.scope === 'all') {
        sessionStorage.setItem('ms_logged_out', '1');
        clearLocalStorage();
        window.location.href = '/login.html';
      }
    } catch (err) {
      alert('Could not revoke other sessions: ' + err.message);
    }
  });
}

let currentEnrollment = null;

async function refreshMfaStatus() {
  try {
    const res = await fetch(`${API}/auth/2fa/status`, { headers: { 'Authorization': `Bearer ${token}` } });
    const data = await res.json();
    const statusText = document.getElementById('mfa-status-text');
    const btn = document.getElementById('mfa-toggle-btn');
    const regenBtn = document.getElementById('regen-codes-btn');
    if (data.enabled) {
      statusText.innerHTML = '<span class="text-emerald-600 dark:text-emerald-400 font-semibold">✓ On</span> — asks for a 6-digit code from your phone each time you sign in.';
      btn.textContent = 'Turn Off';
      btn.classList.remove('bg-indigo-600', 'hover:bg-indigo-500');
      btn.classList.add('bg-slate-200', 'dark:bg-slate-700', 'text-slate-900', 'dark:text-white', 'hover:bg-slate-300');
      regenBtn?.classList.remove('hidden');
    } else {
      statusText.textContent = 'Off. We strongly suggest turning this on — it stops people from getting in even if they know your password.';
      btn.textContent = 'Turn On';
      btn.classList.add('bg-indigo-600', 'hover:bg-indigo-500');
      btn.classList.remove('bg-slate-200', 'dark:bg-slate-700', 'text-slate-900', 'dark:text-white', 'hover:bg-slate-300');
      regenBtn?.classList.add('hidden');
    }
    btn.disabled = false;
  } catch (e) {
    document.getElementById('mfa-status-text').textContent = "Couldn't load status. Try refreshing the page.";
  }
}

// ── Backup codes (shown once after enrollment) ──────────────────────────────
function showBackupCodes(codes) {
  const panel = document.getElementById('backup-codes-panel');
  const grid = document.getElementById('backup-codes-grid');
  grid.innerHTML = codes.map(c => `<div class="bg-white dark:bg-slate-900 border border-amber-300 dark:border-amber-700 rounded px-2 py-1.5 text-center select-all">${c}</div>`).join('');
  panel.classList.remove('hidden');

  const userEmail = JSON.parse(localStorage.getItem('user') || '{}').email || 'me';
  const textContent = [
    'MarketSync Backup Codes',
    `For: ${userEmail}`,
    `Saved: ${new Date().toLocaleString()}`,
    '',
    'Keep these somewhere safe (password manager, printed copy in a drawer).',
    'If you lose your phone, type one of these instead of the 6-digit code.',
    'Each code works ONCE.',
    '',
    ...codes
  ].join('\n');

  document.getElementById('backup-codes-download').onclick = () => {
    const blob = new Blob([textContent], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'marketsync-backup-codes.txt';
    a.click();
    URL.revokeObjectURL(a.href);
  };

  document.getElementById('backup-codes-copy').onclick = async () => {
    try {
      await navigator.clipboard.writeText(codes.join('\n'));
      const btn = document.getElementById('backup-codes-copy');
      const original = btn.textContent;
      btn.textContent = '✓ Copied!';
      setTimeout(() => { btn.textContent = original; }, 1500);
    } catch { alert('Copy did not work — please write them down or download the file.'); }
  };

  document.getElementById('backup-codes-done').onclick = () => {
    if (confirm("Did you save your backup codes somewhere safe? We won't show them again.")) {
      panel.classList.add('hidden');
    }
  };
}

// ── Passkeys (fingerprint / face / hardware key) ────────────────────────────
async function loadPasskeys() {
  const listEl = document.getElementById('passkey-list');
  if (!listEl) return;
  try {
    const res = await fetch(`${API}/auth/passkey/list`, { headers: { 'Authorization': `Bearer ${token}` } });
    const data = await res.json();
    const items = data.passkeys || [];
    if (!items.length) {
      listEl.innerHTML = '<p class="text-xs text-slate-500 italic">No passkeys yet. Tap "+ Add" to set up your first one.</p>';
      return;
    }
    listEl.innerHTML = items.map(p => {
      const when = new Date(p.created_at).toLocaleDateString();
      const lastUsed = p.last_used_at ? new Date(p.last_used_at).toLocaleDateString() : 'never';
      return `
        <div class="flex items-center justify-between gap-2 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded px-2 py-1.5">
          <div class="min-w-0">
            <div class="text-xs font-semibold text-slate-900 dark:text-white truncate">${p.device_name || 'My passkey'}</div>
            <div class="text-sm text-slate-500">Added ${when} · Last used ${lastUsed}</div>
          </div>
          <button data-passkey-id="${p.id}" class="passkey-remove text-xs text-rose-600 dark:text-rose-400 hover:underline whitespace-nowrap">Remove</button>
        </div>
      `;
    }).join('');
    listEl.querySelectorAll('.passkey-remove').forEach(btn => {
      btn.addEventListener('click', () => removePasskey(btn.dataset.passkeyId));
    });
  } catch (err) {
    listEl.innerHTML = '<p class="text-xs text-red-500">Could not load passkeys.</p>';
  }
}

async function registerNewPasskey() {
  const errEl = document.getElementById('passkey-error');
  errEl.classList.add('hidden');

  if (!window.SimpleWebAuthnBrowser) {
    errEl.textContent = 'Passkeys are not loaded. Refresh the page and try again.';
    errEl.classList.remove('hidden'); return;
  }
  if (!window.PublicKeyCredential) {
    errEl.textContent = "Your browser doesn't support passkeys. Try a recent Chrome, Safari, or Edge.";
    errEl.classList.remove('hidden'); return;
  }

  const btn = document.getElementById('add-passkey-btn');
  btn.disabled = true; btn.textContent = 'Setting up…';

  try {
    const beginRes = await fetch(`${API}/auth/passkey/register/begin`, {
      method: 'POST', headers: { 'Authorization': `Bearer ${token}` }
    });
    const options = await beginRes.json();
    if (!beginRes.ok) throw new Error(options.error || 'Could not start.');

    // Browser prompts: Touch ID / Face ID / passkey picker
    const credential = await SimpleWebAuthnBrowser.startRegistration({ optionsJSON: options });

    // Friendly name — derive from the device
    const deviceName = (navigator.userAgent.match(/Mac OS X/) ? 'Mac' :
                       navigator.userAgent.match(/Windows/) ? 'Windows PC' :
                       navigator.userAgent.match(/iPhone|iPad/) ? 'iPhone/iPad' :
                       navigator.userAgent.match(/Android/) ? 'Android' :
                       'My device') + ' (' + new Date().toLocaleDateString() + ')';

    const finishRes = await fetch(`${API}/auth/passkey/register/finish`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ response: credential, device_name: deviceName })
    });
    const data = await finishRes.json();
    if (!finishRes.ok) throw new Error(data.error || 'Could not save passkey.');

    await loadPasskeys();
    alert('✓ Passkey saved! Next time you sign in, you can tap "Use fingerprint or face" instead of typing a password.');
  } catch (err) {
    const msg = err.name === 'NotAllowedError' || err.name === 'AbortError'
      ? 'Cancelled.'
      : (err.message || 'Could not add passkey.');
    errEl.textContent = msg;
    errEl.classList.remove('hidden');
  } finally {
    btn.disabled = false; btn.textContent = '+ Add';
  }
}

async function removePasskey(passkeyId) {
  if (!confirm("Remove this passkey? You won't be able to sign in with it anymore.")) return;
  try {
    const res = await fetch(`${API}/auth/passkey/${passkeyId}`, {
      method: 'DELETE', headers: { 'Authorization': `Bearer ${token}` }
    });
    if (!res.ok) throw new Error('Could not remove.');
    await loadPasskeys();
  } catch (err) { alert(err.message); }
}

async function loadSessions() {
  const list = document.getElementById('sessions-list');
  list.innerHTML = '<span class="text-slate-500 italic">Loading…</span>';
  try {
    const res = await fetch(`${API}/me/sessions`, { headers: { 'Authorization': `Bearer ${token}` } });
    const data = await res.json();
    const events = data.events || [];
    if (!events.length) { list.innerHTML = '<span class="text-slate-500 italic">No sign-in history yet.</span>'; return; }
    list.innerHTML = events.map((e, idx) => {
      const friendlyTime = friendlyAgo(new Date(e.timestamp));
      return `
      <div class="flex items-start justify-between gap-2 py-1 border-b border-slate-200 dark:border-slate-800 last:border-0">
        <div class="min-w-0">
          <div class="text-slate-900 dark:text-white truncate">${e.browser} on ${e.os}${idx === 0 ? ' <span class="text-emerald-600 font-semibold">· this device</span>' : ''}</div>
          <div class="text-slate-500">${friendlyTime}${e.ip ? ' · ' + e.ip : ''}</div>
        </div>
      </div>
    `;
    }).join('');
  } catch (err) {
    list.innerHTML = '<span class="text-red-500">Could not load sign-in history.</span>';
  }
}

// ── AI BOOST ────────────────────────────────────────────────────────────────

let __aiBoostActive = false;
let __aiBoostConfigLoaded = false;
let __vinStickerActive = false;   // VIN decode + OEM docs — core (always true)
let __aiDocsActive = false;       // generated/branded sticker & brochure — AI Boost
let __invIntelActive = false;
let __aiVisionActive = false;     // now equals AI Boost

async function loadAIActivity() {
  const loading = document.getElementById('ai-activity-loading');
  const empty = document.getElementById('ai-activity-empty');
  const errorEl = document.getElementById('ai-activity-error');
  const list = document.getElementById('ai-activity-list');
  const countEl = document.getElementById('ai-activity-count');
  // Inventory Scan now lives on the Inventory page and is part of the Inventory
  // Intelligence add-on. Toggle the scan controls/results vs the upgrade CTA.
  const controls = document.getElementById('inv-scan-controls');
  const activeWrap = document.getElementById('inv-scan-active');
  const upsell = document.getElementById('inv-scan-upsell');

  // Wait for /ai/config so we know the add-on state before flipping visibility.
  // loadAIBoostSection() calls loadAIActivity() again once config resolves.
  if (!__aiBoostConfigLoaded) {
    if (loading) loading.classList.remove('hidden');
    return;
  }

  const active = !!__invIntelActive;
  if (controls) controls.classList.toggle('hidden', !active);
  if (activeWrap) activeWrap.classList.toggle('hidden', !active);
  if (upsell) upsell.classList.toggle('hidden', active);
  if (!active) {
    if (loading) loading.classList.add('hidden');
    return;
  }

  loadScanUsage();

  if (!list) return;

  if (loading) loading.classList.remove('hidden');
  if (empty) empty.classList.add('hidden');
  if (errorEl) errorEl.classList.add('hidden');
  list.classList.add('hidden');

  try {
    const res = await fetch(`${API}/ai/activity`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to load activity');

    const items = data.activity || [];
    if (loading) loading.classList.add('hidden');

    // Summary stats
    const totalEl = document.getElementById('ai-stat-total');
    const warnEl = document.getElementById('ai-stat-warnings');
    const priceEl = document.getElementById('ai-stat-price-flags');
    const copyEl = document.getElementById('ai-stat-copies');
    if (totalEl) totalEl.textContent = items.length;
    if (warnEl) warnEl.textContent = items.filter(i => i.warnings?.length > 0).length;
    if (priceEl) priceEl.textContent = items.filter(i => i.price_flagged).length;
    if (copyEl) copyEl.textContent = items.filter(i => i.copy_generated).length;

    if (items.length === 0) { if (empty) empty.classList.remove('hidden'); return; }

    __aiActivityItems = items;
    renderAiActivity();
  } catch (err) {
    if (loading) loading.classList.add('hidden');
    if (errorEl) { errorEl.textContent = err.message; errorEl.classList.remove('hidden'); }
  }
}

// Today's Briefing — AI daily operator digest on the Insights (home) page.
async function loadDailyDigest() {
  const card = document.getElementById('daily-digest');
  if (!card) return;
  try {
    const r = await fetch(`${API}/ai/daily-digest`, { headers: { 'Authorization': `Bearer ${token}` } });
    if (!r.ok) return;
    const d = await r.json();
    const summaryEl = document.getElementById('digest-summary');
    const itemsEl = document.getElementById('digest-items');
    const dateEl = document.getElementById('digest-date');
    if (dateEl && d.date) dateEl.textContent = new Date(d.date + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
    if (summaryEl) summaryEl.textContent = d.summary || '';
    if (itemsEl) {
      itemsEl.innerHTML = (d.items || []).map(it =>
        `<button type="button" class="digest-item flex items-center gap-1.5 text-xs font-semibold bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 px-3 py-1.5 rounded-full transition" data-page="${esc(it.page)}"><span>${it.icon}</span>${esc(it.text)}</button>`
      ).join('');
      itemsEl.querySelectorAll('.digest-item').forEach(b => b.addEventListener('click', () => switchPage(b.dataset.page)));
    }
    card.classList.remove('hidden');
  } catch {}
}

// Daily briefing email opt-in toggle (Reports & Alerts section).
async function loadDigestToggle() {
  const el = document.getElementById('daily-digest-toggle');
  if (!el) return;
  try {
    const r = await fetch(`${API}/ai/config`, { headers: { 'Authorization': `Bearer ${token}` } });
    if (r.ok) { const cfg = await r.json(); el.checked = cfg.daily_digest_enabled !== false; }
  } catch {}
  if (!el._wired) {
    el._wired = true;
    el.addEventListener('change', async () => {
      try {
        const r = await fetch(`${API}/ai/config`, {
          method: 'PUT', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ daily_digest_enabled: el.checked }),
        });
        if (!r.ok) throw new Error();
        showToast(el.checked ? 'Daily briefing email on' : 'Daily briefing email off', 'success');
      } catch { el.checked = !el.checked; showToast('Could not save that', 'error'); }
    });
  }
}

// Your Lot at a Glance — vehicle count + price range for competitor comparison.
async function loadLotOverview() {
  const countEl = document.getElementById('lot-ov-count');
  if (!countEl) return;
  try {
    const inv = await apiGetJson('/inventory/all', { retries: 1 });
    const avail = (inv || []).filter(v => String(v.status || 'available').toLowerCase() === 'available');
    const prices = avail.map(v => Number(v.price)).filter(p => p > 0).sort((a, b) => a - b);
    const money = n => '$' + Math.round(n).toLocaleString();
    const set = (id, t) => { const e = document.getElementById(id); if (e) e.textContent = t; };
    const rangeTxt = prices.length ? `${money(prices[0])}–${money(prices[prices.length - 1])}` : '—';
    const avgTxt = prices.length ? money(prices.reduce((a, b) => a + b, 0) / prices.length) : '—';
    set('lot-ov-count', avail.length.toLocaleString());
    set('lot-ov-range', rangeTxt);
    set('lot-ov-avg', avgTxt);
    const yr = new Date().getFullYear();
    const isNew = v => String(v.condition || '').toLowerCase() === 'new' || Number(v.year) >= yr;
    const nu = avail.filter(isNew).length;
    set('lot-ov-split', `${nu} / ${avail.length - nu}`);
    // Compact copy inside the Competitor Monitoring card.
    set('lot-mini-count', avail.length.toLocaleString());
    set('lot-mini-range', rangeTxt);
    set('lot-mini-avg', avgTxt);
  } catch {}
}

// Monthly live-market usage vs the soft cap (cached lookups don't count).
async function loadScanUsage() {
  const el = document.getElementById('inv-scan-usage');
  if (!el) return;
  try {
    const r = await fetch(`${API}/ai/usage`, { headers: { 'Authorization': `Bearer ${token}` } });
    if (!r.ok) return;
    const u = await r.json();
    if (!u?.marketcheck) return;
    const { used, limit } = u.marketcheck;
    el.textContent = `Live market lookups this month: ${used.toLocaleString()} / ${limit.toLocaleString()} · cached lookups are free`;
    el.classList.remove('hidden');
  } catch {}
}

// Which category the Inventory Scan Results list is filtered to.
let __aiActivityItems = [];
let __aiActivityFilter = 'all';

// Priority rank for ordering: price flags first, then missing info, then copies
// written, then everything else — so the units that need action float to the top.
function aiRowPriority(i) {
  if (i.price_flagged) return 0;
  if (i.warnings?.length > 0) return 1;
  if (i.copy_generated) return 2;
  return 3;
}

function renderAiActivity() {
  const list = document.getElementById('ai-activity-list');
  const empty = document.getElementById('ai-activity-empty');
  const countEl = document.getElementById('ai-activity-count');
  if (!list) return;

  // Highlight the active filter card.
  document.querySelectorAll('.ai-stat-card').forEach(c => {
    const on = c.dataset.aiFilter === __aiActivityFilter;
    c.classList.toggle('ring-2', on);
    c.classList.toggle('ring-indigo-500', on);
  });

  const f = __aiActivityFilter;
  const filtered = __aiActivityItems.filter(i =>
    f === 'all' ? true :
    f === 'price' ? i.price_flagged :
    f === 'missing' ? (i.warnings?.length > 0) :
    f === 'copies' ? i.copy_generated : true
  );
  // Sort by priority, then newest first within a group.
  filtered.sort((a, b) => aiRowPriority(a) - aiRowPriority(b) || new Date(b.created_at) - new Date(a.created_at));

  if (countEl) countEl.textContent = f === 'all' ? `${filtered.length} checks` : `${filtered.length} of ${__aiActivityItems.length}`;

  if (!filtered.length) {
    list.innerHTML = `<li class="px-4 py-8 text-center text-sm text-slate-400">No vehicles in this category.</li>`;
    list.classList.remove('hidden');
    if (empty) empty.classList.add('hidden');
    return;
  }

  list.innerHTML = filtered.map(item => {
    const date = new Date(item.created_at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    const stock = item.stocknumber ? `<span class="text-[11px] font-bold text-indigo-600 dark:text-indigo-400">#${esc(item.stocknumber)}</span>` : '';
    const badges = [];
    if (item.price_flagged) {
      const dir = (item.price_pct_diff || 0) > 0 ? 'overpriced' : 'underpriced';
      const pct = Math.abs(item.price_pct_diff || 0);
      badges.push(`<span class="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300">${pct}% ${dir}</span>`);
    }
    if (item.warnings?.length > 0) badges.push(`<span class="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300">${item.warnings.length} alert${item.warnings.length > 1 ? 's' : ''}</span>`);
    if (item.copy_generated) badges.push(`<span class="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full bg-indigo-100 dark:bg-indigo-900/40 text-indigo-700 dark:text-indigo-300">Copy written</span>`);
    const warningList = item.warnings?.length > 0
      ? `<ul class="mt-1.5 text-xs text-amber-700 dark:text-amber-300 space-y-0.5 list-disc list-inside">${item.warnings.map(w => `<li>${esc(w)}</li>`).join('')}</ul>`
      : '';
    const clickable = !!item.inventory_id;
    const hint = item.price_flagged ? 'Click for full price report →' : 'View price comparison →';
    return `<li class="px-4 py-3.5 ${clickable ? 'cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/60 transition-colors' : ''}" ${clickable ? `data-price-report="${item.inventory_id}"` : ''}>
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0">
          <div class="flex items-center gap-2 flex-wrap">
            <span class="font-semibold text-sm text-slate-900 dark:text-white">${esc(item.vehicle_label || 'Unknown vehicle')}</span>
            ${stock}
          </div>
          <div class="flex flex-wrap gap-1.5 mt-1.5">${badges.join('') || '<span class="text-xs text-slate-400">No issues found</span>'}</div>
          ${warningList}
          ${clickable ? `<div class="text-[10px] text-indigo-500 dark:text-indigo-400 mt-1">${hint}</div>` : ''}
        </div>
        <div class="text-xs text-slate-400 whitespace-nowrap flex-shrink-0 mt-0.5">${date}</div>
      </div>
    </li>`;
  }).join('');
  list.classList.remove('hidden');
  if (empty) empty.classList.add('hidden');

  list.querySelectorAll('[data-price-report]').forEach(li => {
    li.addEventListener('click', () => openPriceReport(li.dataset.priceReport));
  });
}

// Wire the stat cards as category filters.
document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.ai-stat-card').forEach(card => {
    card.addEventListener('click', () => {
      __aiActivityFilter = card.dataset.aiFilter || 'all';
      renderAiActivity();
    });
  });
});

// ── Reusable Upgrade / Purchase Modal ───────────────────────────────────────
// Opened by every locked AI / Inventory-Intelligence CTA. Shows the add-on's
// feature list + price and starts checkout — replaces the old AI Boost page.
const UPGRADE_PLANS = {
  inv_intel: {
    eyebrow: 'Flagship add-on',
    title: 'Inventory Intelligence',
    tagline: 'Know exactly where every unit sits vs the live market — and value every trade.',
    price: '$299',
    cta: 'Start 30-Day Free Trial',
    endpoint: 'subscribe-inv-intel',
    features: [
      '“% to market” on every used vehicle',
      'Inventory Scan — live market comps across your whole lot',
      'vAuto-style trade appraisals with printable PDF',
      'Lot Average Report — your lot vs the market',
      'Hot / cold detection, turn rate & health scores',
      'Duplicate VIN detection & automated repricing rules',
      'Competitor lot monitoring',
      'VIN decoder, recalls & factory window stickers',
    ],
  },
  ai_boost: {
    eyebrow: 'Add-on',
    title: 'AI Boost',
    tagline: 'AI listing tools that write, check and polish every vehicle.',
    price: '$129',
    cta: 'Start 30-Day Free Trial',
    endpoint: 'subscribe-ai-boost',
    features: [
      'AI listing copy in your dealership’s tone',
      'Missing-info alerts (photos, price, mileage)',
      'AI Vision photo scoring 0–100',
      'Branded window stickers & AI dealer brochures',
      'Price intelligence flags on every unit',
    ],
  },
};

function openUpgradeModal(addon) {
  const plan = UPGRADE_PLANS[addon];
  const modal = document.getElementById('upgrade-modal');
  if (!plan || !modal) return;
  document.getElementById('upgrade-modal-eyebrow').textContent = plan.eyebrow;
  document.getElementById('upgrade-modal-title').textContent = plan.title;
  document.getElementById('upgrade-modal-tagline').textContent = plan.tagline;
  document.getElementById('upgrade-modal-price').textContent = plan.price;
  document.getElementById('upgrade-modal-features').innerHTML = plan.features.map(f =>
    `<li class="flex items-start gap-2.5 text-sm text-slate-700 dark:text-slate-300"><svg class="w-4 h-4 text-violet-500 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M4.5 12.75l6 6 9-13.5"/></svg><span>${esc(f)}</span></li>`
  ).join('');
  const buy = document.getElementById('upgrade-modal-buy');
  buy.textContent = plan.cta;
  buy.disabled = false;
  buy.onclick = async () => {
    buy.disabled = true;
    buy.textContent = 'Redirecting…';
    try {
      const res = await fetch(`${API}/billing/${plan.endpoint}`, {
        method: 'POST', headers: { 'Authorization': `Bearer ${token}` },
      });
      const data = await res.json();
      if (data.url) { window.location.href = data.url; return; }
      throw new Error(data.error || 'Failed to start checkout');
    } catch (e) {
      buy.disabled = false;
      buy.textContent = plan.cta;
      alert('Could not start checkout: ' + e.message);
    }
  };
  modal.classList.remove('hidden');
}

function closeUpgradeModal() {
  document.getElementById('upgrade-modal')?.classList.add('hidden');
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('upgrade-modal')?.addEventListener('click', e => {
    if (e.target === e.currentTarget) closeUpgradeModal();
  });
});
window.openUpgradeModal = openUpgradeModal;
window.closeUpgradeModal = closeUpgradeModal;

// Shared checkout starter (30-day trial, no card required) — used by the modal + hub.
async function startAddonCheckout(endpoint, btn, ctaText) {
  if (btn) { btn.disabled = true; btn.textContent = 'Redirecting…'; }
  try {
    const res = await fetch(`${API}/billing/${endpoint}`, { method: 'POST', headers: { 'Authorization': `Bearer ${token}` } });
    const data = await res.json();
    if (data.url) { window.location.href = data.url; return; }
    throw new Error(data.error || 'Failed to start checkout');
  } catch (e) {
    if (btn) { btn.disabled = false; btn.textContent = ctaText || 'Start 30-day free trial'; }
    alert('Could not start checkout: ' + e.message);
  }
}

// Trial countdown badge on the ✦ Upgrades icon (days left in the 30-day trial).
function updateTrialBadge(daysLeft) {
  const b = document.getElementById('upg-days-badge');
  if (!b) return;
  if (daysLeft > 0) {
    b.textContent = daysLeft + 'd';
    b.classList.remove('hidden');
    const btn = document.getElementById('open-upgrades');
    if (btn) btn.title = `Free trial — ${daysLeft} day${daysLeft === 1 ? '' : 's'} left · Upgrades & add-ons`;
  } else {
    b.classList.add('hidden');
  }
}
window.updateTrialBadge = updateTrialBadge;

// ── Upgrades hub (header ✦ icon) ─────────────────────────────────────────────
// One place to see every add-on, what you already have, pricing, and start a
// 30-day free trial. Reads live entitlements from /ai/config.
async function openUpgradesHub() {
  const isAdmin = ['DEALER_ADMIN', 'OWNER'].includes(profileContext?.role);
  let cfg = {};
  try { cfg = await (await fetch(`${API}/ai/config`, { headers: { 'Authorization': `Bearer ${token}` } })).json(); } catch {}
  const paid = { inv_intel: !!cfg.inv_intel_paid, ai_boost: !!cfg.ai_boost_paid };
  const fullAccess = !!cfg.full_access;
  const daysLeft = cfg.trial_days_left || 0;
  const order = ['inv_intel', 'ai_boost'];
  const check = '<svg class="w-3.5 h-3.5 text-violet-500 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M4.5 12.75l6 6 9-13.5"/></svg>';
  const cards = order.map(key => {
    const p = UPGRADE_PLANS[key];
    const isPaid = paid[key];
    const on = isPaid || fullAccess;   // usable right now?
    let statusHtml;
    if (isPaid) statusHtml = `<span class="inline-flex items-center gap-1.5 text-sm font-bold text-emerald-600 dark:text-emerald-400">${check.replace('w-3.5 h-3.5', 'w-4 h-4')}You have this</span>`;
    else if (fullAccess) statusHtml = `<div class="flex items-center justify-between gap-2"><span class="inline-flex items-center gap-1.5 text-sm font-bold text-violet-600 dark:text-violet-400">${check.replace('w-3.5 h-3.5 text-violet-500', 'w-4 h-4 text-violet-500')}Included in your trial</span>${isAdmin ? `<button data-endpoint="${p.endpoint}" class="upg-hub-buy text-xs font-bold text-violet-600 dark:text-violet-400 underline hover:no-underline">Keep it →</button>` : ''}</div>`;
    else statusHtml = isAdmin
      ? `<button data-endpoint="${p.endpoint}" class="upg-hub-buy w-full bg-violet-600 hover:bg-violet-500 text-white font-bold px-4 py-2.5 rounded-lg text-sm transition">Start 30-day free trial</button>`
      : '<span class="text-xs text-slate-400">Ask your admin to start a trial.</span>';
    return `<div class="border ${on ? 'border-emerald-300 dark:border-emerald-800 bg-emerald-50/40 dark:bg-emerald-950/10' : 'border-slate-200 dark:border-slate-700'} rounded-xl p-4 flex flex-col">
      <div class="flex items-start justify-between gap-2">
        <div><div class="text-[10px] font-bold uppercase tracking-wider text-violet-500">${esc(p.eyebrow)}</div>
          <div class="text-lg font-black text-slate-900 dark:text-white leading-tight">${esc(p.title)}</div></div>
        <div class="text-right flex-shrink-0"><div class="text-xl font-black text-slate-900 dark:text-white">${esc(p.price)}</div><div class="text-[10px] text-slate-400">/month</div></div>
      </div>
      <p class="text-sm text-slate-600 dark:text-slate-300 mt-1">${esc(p.tagline)}</p>
      <ul class="mt-2 space-y-1 flex-1">${p.features.slice(0, 6).map(f => `<li class="flex items-start gap-2 text-xs text-slate-600 dark:text-slate-300">${check}<span>${esc(f)}</span></li>`).join('')}</ul>
      <div class="mt-3">${statusHtml}</div>
    </div>`;
  }).join('');
  const banner = fullAccess
    ? `<div class="mb-4 rounded-xl bg-violet-600 text-white px-4 py-3">
        <div class="font-black text-sm">🎉 You're on your 30-day free trial — every feature is unlocked.</div>
        <div class="text-xs text-violet-100 mt-0.5">${daysLeft} day${daysLeft === 1 ? '' : 's'} left. After that, you keep only the add-ons you subscribe to.</div>
      </div>`
    : `<p class="text-sm text-slate-500 dark:text-slate-400 mb-4">Every add-on includes a <span class="font-bold text-slate-700 dark:text-slate-200">30-day free trial</span> — no credit card required, cancel anytime.</p>`;
  const ov = crmOverlay(`<div class="p-5">
    <div class="flex items-center justify-between mb-2">
      <div class="text-lg font-black text-slate-900 dark:text-white">Upgrades &amp; add-ons</div>
      <button onclick="this.closest('.fixed').remove()" class="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"><svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" d="M6 6l12 12M18 6L6 18"/></svg></button>
    </div>
    ${banner}
    <div class="grid sm:grid-cols-2 gap-3">${cards}</div>
  </div>`, 'max-w-3xl');
  ov.querySelectorAll('.upg-hub-buy').forEach(b => b.addEventListener('click', () => startAddonCheckout(b.dataset.endpoint, b, 'Start 30-day free trial')));
}
window.openUpgradesHub = openUpgradesHub;

// ── Price Report Modal ──────────────────────────────────────────────────────

let __prChart = null;
let __prData = null; // store last report data for PDF export

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('pr-close')?.addEventListener('click', closePriceReport);
  document.getElementById('price-report-modal')?.addEventListener('click', e => {
    if (e.target === e.currentTarget) closePriceReport();
  });
  document.getElementById('pr-pdf-btn')?.addEventListener('click', exportPriceReportPDF);
});

function closePriceReport() {
  document.getElementById('price-report-modal')?.classList.add('hidden');
  if (__prChart) { __prChart.destroy(); __prChart = null; }
  __prData = null;
}

// ── Lot Average Report ──────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('ai-lot-report-btn')?.addEventListener('click', openLotReport);
  document.getElementById('lr-close')?.addEventListener('click', () =>
    document.getElementById('lot-report-modal')?.classList.add('hidden'));
  document.getElementById('lot-report-modal')?.addEventListener('click', e => {
    if (e.target === e.currentTarget) e.currentTarget.classList.add('hidden');
  });
});

async function openLotReport() {
  const modal = document.getElementById('lot-report-modal');
  const loading = document.getElementById('lr-loading');
  const content = document.getElementById('lr-content');
  const errorEl = document.getElementById('lr-error');
  if (!modal) return;
  modal.classList.remove('hidden');
  loading?.classList.remove('hidden');
  content?.classList.add('hidden');
  errorEl?.classList.add('hidden');

  const money = n => '$' + Number(n || 0).toLocaleString();
  try {
    const res = await fetch(`${API}/ai/lot-report`, { headers: { 'Authorization': `Bearer ${token}` } });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not build lot report');
    loading?.classList.add('hidden');

    if (!data.count) {
      if (errorEl) {
        errorEl.textContent = 'No comparable vehicles yet — run "Scan All Inventory" first so we can pull market comps for your lot.';
        errorEl.classList.remove('hidden');
      }
      return;
    }

    const sub = document.getElementById('lr-subtitle');
    if (sub) sub.textContent = `${data.count} vehicle${data.count === 1 ? '' : 's'} with market comps · from your latest scan`;
    document.getElementById('lr-count').textContent = data.count;
    document.getElementById('lr-lot-avg').textContent = money(data.lot_avg);
    document.getElementById('lr-market-avg').textContent = money(data.market_avg);

    const diffEl = document.getElementById('lr-diff');
    const p = data.overall_pct_diff || 0;
    diffEl.textContent = (p > 0 ? '+' : '') + p + '%';
    diffEl.className = 'text-2xl font-black ' + (p > 5 ? 'text-red-600 dark:text-red-400' : p < -5 ? 'text-amber-600 dark:text-amber-400' : 'text-emerald-600 dark:text-emerald-400');

    document.getElementById('lr-over').textContent = data.over;
    document.getElementById('lr-fair').textContent = data.fair;
    document.getElementById('lr-under').textContent = data.under;

    const rowColor = pct => pct > 5 ? 'text-red-600 dark:text-red-400' : pct < -5 ? 'text-amber-600 dark:text-amber-400' : 'text-emerald-600 dark:text-emerald-400';
    document.getElementById('lr-rows').innerHTML = (data.vehicles || []).map(v => `
      <tr class="hover:bg-slate-50 dark:hover:bg-slate-800/60 cursor-pointer" data-lr-report="${v.inventory_id}">
        <td class="px-3 py-2 font-medium text-slate-900 dark:text-white">${esc(v.label)}</td>
        <td class="px-3 py-2 text-right tabular-nums text-slate-700 dark:text-slate-300">${money(v.your_price)}</td>
        <td class="px-3 py-2 text-right tabular-nums text-slate-500 dark:text-slate-400">${money(v.market_avg)}</td>
        <td class="px-3 py-2 text-right tabular-nums font-bold ${rowColor(v.pct_diff)}">${(v.pct_diff > 0 ? '+' : '') + v.pct_diff}%</td>
      </tr>`).join('');

    // Click a row to open that vehicle's full price report
    document.getElementById('lr-rows').querySelectorAll('[data-lr-report]').forEach(tr => {
      tr.addEventListener('click', () => { modal.classList.add('hidden'); openPriceReport(tr.dataset.lrReport); });
    });

    content?.classList.remove('hidden');
  } catch (err) {
    loading?.classList.add('hidden');
    if (errorEl) { errorEl.textContent = err.message; errorEl.classList.remove('hidden'); }
  }
}

function exportPriceReportPDF() {
  if (!__prData) return;
  const { vehicle, estimate, pct_diff, label, currency, data_source } = __prData;
  const cl = currency === 'USD' ? 'USD' : 'CAD';
  const distUnit = cl === 'USD' ? 'mi' : 'km';
  const fmt = n => n != null ? '$' + Number(n).toLocaleString() + ' ' + cl : '—';
  const fmtMi = n => n != null ? Number(n).toLocaleString() + ' ' + distUnit : '—';

  const over = pct_diff != null && pct_diff > 0;
  const diffColor = pct_diff == null ? '#94a3b8' : over ? '#ef4444' : '#7c3aed';
  const diffText = pct_diff != null ? (over ? '+' : '') + pct_diff + '%' : '—';

  const avgs = estimate?.marketplace_averages || [];
  const sourceNames = avgs.length ? avgs.map(m => m.name) : [];
  const ma = estimate?.mileage_analysis;
  const isNew = vehicle.condition === 'new' || Number(vehicle.year) >= new Date().getFullYear();

  const ptm = estimate?.price_to_market_pct;
  const ptmColor = ptm == null ? '#94a3b8' : ptm > 105 ? '#ef4444' : ptm < 95 ? '#7c3aed' : '#0f172a';
  const dom = estimate?.days_on_market_estimate;

  const ratingColorMap = {
    'well below average': '#7c3aed', 'below average': '#c4b5fd',
    'average': '#94a3b8', 'above average': '#f59e0b', 'well above average': '#ef4444'
  };
  const mileageImpact = ma?.mileage_price_impact != null ? Number(ma.mileage_price_impact) : null;
  const mileageImpactColor = mileageImpact == null ? '#94a3b8' : mileageImpact > 0 ? '#7c3aed' : '#ef4444';
  const mileageImpactText = mileageImpact != null
    ? (mileageImpact >= 0 ? '+' : '') + '$' + Math.abs(mileageImpact).toLocaleString() + ' ' + cl
    : '—';

  const canvas = document.getElementById('pr-chart');
  const chartImg = canvas ? canvas.toDataURL('image/png') : null;

  const win = window.open('', '_blank');
  if (!win) return;

  const html = `<!DOCTYPE html><html><head>
<title>Market Price Report – ${label}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
@page{size:letter portrait;margin:13mm 13mm 11mm}
body{font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;color:#0f172a;font-size:10.5px;line-height:1.35;background:#fff}
/* On-screen (the auto-opened tab): render as a centered letter-width page so the
   preview matches the print and never stretches full browser width. Print uses @page. */
@media screen{html{background:#e5e7eb}body{width:8.5in;max-width:100%;min-height:11in;margin:20px auto;padding:13mm;background:#fff;box-shadow:0 1px 6px rgba(0,0,0,.15)}}
.header{display:flex;align-items:flex-start;justify-content:space-between;border-bottom:2.5px solid #6366f1;padding-bottom:7px;margin-bottom:8px}
.header h1{font-size:14px;font-weight:900;letter-spacing:-.3px;margin-bottom:1px}
.header .sub{font-size:9.5px;color:#64748b}
.header-right{text-align:right;font-size:8.5px;color:#94a3b8;line-height:1.7}
.badge{display:inline-block;background:#eef2ff;color:#6366f1;font-size:7.5px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;padding:2px 6px;border-radius:99px;border:1px solid #c7d2fe}
.sl{font-size:7.5px;font-weight:800;text-transform:uppercase;letter-spacing:.09em;color:#94a3b8;margin:7px 0 4px}
.strip5{display:grid;grid-template-columns:repeat(5,1fr);gap:5px;margin-bottom:7px}
.tile{background:#f8fafc;border:1px solid #e2e8f0;border-radius:5px;padding:6px 5px;text-align:center}
.tile .tl{font-size:7px;text-transform:uppercase;font-weight:700;letter-spacing:.06em;color:#94a3b8;margin-bottom:2px}
.tile .tv{font-size:13px;font-weight:900}
.mkt3{display:grid;grid-template-columns:repeat(3,1fr);gap:5px;margin-bottom:7px}
.mkt-card{background:#f8fafc;border:1px solid #e2e8f0;border-radius:5px;padding:6px 7px}
.mkt-name{font-size:7.5px;font-weight:800;color:#6366f1;text-transform:uppercase;letter-spacing:.05em;margin-bottom:3px;border-bottom:1px solid #e2e8f0;padding-bottom:2px}
.mkt-row{display:flex;justify-content:space-between;align-items:center;padding:1.5px 0}
.mkt-lbl{font-size:8px;color:#64748b}
.mkt-val{font-size:9px;font-weight:800}
.mkt-cnt{font-size:7.5px;color:#94a3b8;margin-top:2px}
.two-col{display:grid;grid-template-columns:3fr 2fr;gap:7px;margin-bottom:7px}
.chart-wrap{border:1px solid #e2e8f0;border-radius:5px;padding:5px;background:#fafafa}
.chart-wrap img{width:100%;display:block;max-height:150px;object-fit:contain}
.mi-panel{background:#f8fafc;border:1px solid #e2e8f0;border-radius:5px;padding:7px}
.mi-row{display:flex;justify-content:space-between;align-items:center;padding:2.5px 0;border-bottom:1px solid #f1f5f9}
.mi-row:last-of-type{border-bottom:none}
.mi-key{font-size:8px;color:#64748b}
.mi-val{font-size:9px;font-weight:800}
.mi-note{font-size:7.5px;color:#64748b;margin-top:4px;line-height:1.5;border-top:1px solid #f1f5f9;padding-top:4px}
.range-header{display:flex;justify-content:space-between;font-size:8.5px;color:#64748b;font-family:monospace;margin-bottom:2px}
.range-track{height:9px;border-radius:99px;background:#e2e8f0;position:relative;overflow:visible;margin-bottom:2px}
.range-band{position:absolute;top:0;height:100%;border-radius:99px}
.range-marker{position:absolute;top:50%;transform:translate(-50%,-50%);width:11px;height:11px;border-radius:50%;border:2px solid #fff;box-shadow:0 1px 3px rgba(0,0,0,.3)}
.range-ends{display:flex;justify-content:space-between;font-size:7.5px;color:#94a3b8;margin-bottom:7px}
.insight{background:#eef2ff;border:1px solid #c7d2fe;border-radius:5px;padding:7px 9px;margin-bottom:6px}
.insight .il{font-size:7.5px;font-weight:800;text-transform:uppercase;letter-spacing:.06em;color:#6366f1;margin-bottom:2px}
.insight p{font-size:9.5px;color:#1e293b;line-height:1.5}
.insight .ic{font-size:8px;color:#94a3b8;margin-top:2px}
.footer{border-top:1px solid #e2e8f0;padding-top:5px;margin-top:5px;font-size:7.5px;color:#94a3b8;line-height:1.55;display:flex;justify-content:space-between;gap:10px}
.footer .fl{flex:1}
.footer .fr{text-align:right;white-space:nowrap}
.printbar{margin-bottom:12px;text-align:right}
.printbar button{background:#6366f1;color:#fff;border:none;font-size:12px;font-weight:700;padding:8px 16px;border-radius:6px;cursor:pointer}
.printbar button:hover{background:#4f46e5}
@media print{.printbar{display:none!important}}
</style></head><body>

<div class="printbar"><button onclick="window.print()">🖨 Print / Save as PDF</button></div>

<div class="header">
  <div>
    <h1>${label}</h1>
    <div class="sub">${[
      vehicle.stocknumber ? 'Stock #' + vehicle.stocknumber : null,
      vehicle.condition ? vehicle.condition.charAt(0).toUpperCase() + vehicle.condition.slice(1) : null,
      vehicle.mileage ? fmtMi(vehicle.mileage) : null,
      vehicle.exterior_color || null
    ].filter(Boolean).join(' · ')}</div>
  </div>
  <div class="header-right">
    <div class="badge">AI Market Report</div><br>
    ${new Date().toLocaleDateString('en-CA', { year:'numeric', month:'long', day:'numeric' })}<br>
    MarketSync AI Boost
  </div>
</div>

<div class="sl">Price Summary</div>
<div class="strip5">
  <div class="tile"><div class="tl">Your Price</div><div class="tv">${fmt(vehicle.price)}</div></div>
  <div class="tile"><div class="tl">Market Average</div><div class="tv">${(() => {
    const _ap = (estimate?.marketplace_averages || []).map(m => Number(m.avg)).filter(p => p > 0).sort((a,b)=>a-b);
    const _m = _ap.length ? (_ap.length%2===0?(_ap[Math.floor(_ap.length/2)-1]+_ap[Math.floor(_ap.length/2)])/2:_ap[Math.floor(_ap.length/2)]):null;
    const _vp = _m ? _ap.filter(p=>p>=_m*0.55&&p<=_m*1.8) : _ap;
    const _avg = _vp.length ? Math.round(_vp.reduce((a,b)=>a+b,0)/_vp.length) : estimate?.mid;
    return fmt(_avg);
  })()}</div></div>
  <div class="tile"><div class="tl">Difference</div><div class="tv" style="color:${diffColor}">${diffText}</div></div>
  <div class="tile"><div class="tl">Price to Market</div><div class="tv" style="color:${ptmColor}">${ptm != null ? ptm + '%' : '—'}</div></div>
  <div class="tile"><div class="tl">Est. Days to Sell</div><div class="tv">${dom != null ? dom + 'd' : '—'}</div></div>
</div>

${avgs.length ? `
<div class="sl">Average Price by Marketplace</div>
<div class="mkt3">
  ${avgs.map(m => {
    const mAvg = Number(m.avg);
    const vp = Number(vehicle.price);
    const vs = mAvg ? Math.round(((vp - mAvg) / mAvg) * 100) : null;
    const vsColor = vs == null ? '#94a3b8' : vs > 0 ? '#ef4444' : '#7c3aed';
    return `<div class="mkt-card">
      <div class="mkt-name">${m.name}</div>
      <div class="mkt-row"><span class="mkt-lbl">Avg Price</span><span class="mkt-val">${fmt(m.avg)}</span></div>
      ${m.avg_mileage ? `<div class="mkt-row"><span class="mkt-lbl">Avg Mileage</span><span class="mkt-val">${fmtMi(m.avg_mileage)}</span></div>` : ''}
      <div class="mkt-row"><span class="mkt-lbl">Your vs Avg</span><span class="mkt-val" style="color:${vsColor}">${vs != null ? (vs > 0 ? '+' : '') + vs + '%' : '—'}</span></div>
      <div class="mkt-cnt">${m.estimated_listings || ''}</div>
    </div>`;
  }).join('')}
</div>` : ''}

<div class="two-col">
  <div>
    <div class="sl">Marketplace Averages vs Your Price</div>
    <div class="chart-wrap">${chartImg ? `<img src="${chartImg}" alt="Price chart"/>` : '<div style="height:130px;display:flex;align-items:center;justify-content:center;color:#94a3b8;font-size:9px">Chart unavailable</div>'}</div>
  </div>
  <div>
    <div class="sl">Mileage Analysis</div>
    <div class="mi-panel">
      <div class="mi-row"><span class="mi-key">Your Mileage</span><span class="mi-val">${vehicle.mileage ? fmtMi(vehicle.mileage) : 'N/A'}</span></div>
      <div class="mi-row"><span class="mi-key">Market Avg</span><span class="mi-val">${ma?.market_avg_mileage ? fmtMi(ma.market_avg_mileage) : '—'}</span></div>
      ${avgs.filter(m => m.avg_mileage).map(m =>
        `<div class="mi-row"><span class="mi-key">${m.name}</span><span class="mi-val">${fmtMi(m.avg_mileage)}</span></div>`
      ).join('')}
      <div class="mi-row"><span class="mi-key">Rating</span><span class="mi-val" style="color:${ratingColorMap[ma?.mileage_rating] || '#94a3b8'}">${ma?.mileage_rating ? ma.mileage_rating.charAt(0).toUpperCase() + ma.mileage_rating.slice(1) : '—'}</span></div>
      <div class="mi-row"><span class="mi-key">Price Impact</span><span class="mi-val" style="color:${mileageImpactColor}">${mileageImpactText}</span></div>
      ${ma?.mileage_note ? `<div class="mi-note">${ma.mileage_note}</div>` : ''}
    </div>
  </div>
</div>

${estimate ? `
<div class="sl">Overall Market Range (${cl})</div>
<div class="range-header">
  <span>${fmt(estimate.low)}</span>
  <span style="font-weight:700;color:#0f172a">${fmt(estimate.mid)}&nbsp;avg</span>
  <span>${fmt(estimate.high)}</span>
</div>
${(() => {
  const lo = estimate.low, hi = estimate.high, vp = Number(vehicle.price);
  const span = (hi - lo) || 1;
  const markerPct = Math.min(97, Math.max(3, ((vp - lo) / span) * 100));
  return `<div class="range-track"><div class="range-band" style="left:0%;width:100%;background:#c7d2fe"></div><div class="range-marker" style="left:${markerPct}%;background:#6366f1"></div></div>`;
})()}
<div class="range-ends"><span>Market Low</span><span style="font-weight:700;color:#6366f1">▲ Your Price</span><span>Market High</span></div>` : ''}

${estimate?.note ? `
<div class="insight">
  <div class="il">AI Market Insight</div>
  <p>${estimate.note}</p>
  ${estimate.confidence ? `<div class="ic">Confidence: ${estimate.confidence.charAt(0).toUpperCase() + estimate.confidence.slice(1)}</div>` : ''}
</div>` : ''}

<div class="footer">
  <div class="fl"><strong>Sources:</strong> ${sourceNames.join(' · ') || 'AI market analysis'}&nbsp;&nbsp;·&nbsp;&nbsp;${data_source === 'marketcheck' ? 'Live market data from MarketCheck.' : 'AI-analyzed from marketplace listings. Not a live data feed.'} ${isNew ? 'New vehicles matched by same year.' : 'Used vehicles matched by same year and trim.'} Not a guarantee of resale value.</div>
  <div class="fr">Generated ${new Date().toLocaleDateString('en-CA', { year:'numeric', month:'short', day:'numeric' })}</div>
</div>

</body></html>`;

  win.document.write(html);
  win.document.close();
  win.focus();
  // No auto-print — let the user review, then click Print / Save as PDF when ready.
}

async function openPriceReport(inventoryId, forceRefresh = false) {
  const modal = document.getElementById('price-report-modal');
  const loading = document.getElementById('pr-loading');
  const content = document.getElementById('pr-content');
  if (!modal) return;

  modal.classList.remove('hidden');
  loading.classList.remove('hidden');
  loading.textContent = forceRefresh ? 'Refreshing AI market estimate…' : 'Generating AI market estimate…';
  content.classList.add('hidden');
  if (__prChart) { __prChart.destroy(); __prChart = null; }
  __prData = null;

  try {
    const res = await fetch(`${API}/ai/price-report/${inventoryId}${forceRefresh ? '?refresh=1' : ''}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (!res.ok) {
      let msg = 'Could not load report';
      try { const e = await res.json(); if (e?.error) msg = e.error; } catch {}
      throw new Error(msg);
    }
    const { vehicle, estimate, pct_diff, data_source, skipped, reason, cached, generated_at } = await res.json();

    // New / current-year / demo vehicles have no reliable used-market comp set —
    // the backend returns skipped:true with a reason instead of a bogus report.
    if (skipped || !estimate) {
      const lbl = [vehicle.year, vehicle.make, vehicle.model, vehicle.trim].filter(Boolean).join(' ');
      document.getElementById('pr-title').textContent = lbl;
      document.getElementById('pr-subtitle').textContent = vehicle.stocknumber ? `Stock #${vehicle.stocknumber} · ${vehicle.condition || ''}` : (vehicle.condition || '');
      loading.classList.remove('hidden');
      loading.innerHTML = `<div class="py-8 text-center text-sm text-slate-500 dark:text-slate-400 max-w-md mx-auto leading-relaxed">${esc(reason || 'A market price report isn’t available for this vehicle.')}</div>`;
      content.classList.add('hidden');
      return;
    }

    const currency = estimate?.currency || 'CAD';
    const currencyLabel = currency === 'USD' ? 'USD' : 'CAD';
    const fmt = n => n != null ? '$' + Number(n).toLocaleString() + ' ' + currencyLabel : '—';
    const label = [vehicle.year, vehicle.make, vehicle.model, vehicle.trim].filter(Boolean).join(' ');
    __prData = { vehicle, estimate, pct_diff, label, currency, data_source };

    document.getElementById('pr-title').textContent = label;
    const subBase = vehicle.stocknumber ? `Stock #${vehicle.stocknumber} · ${vehicle.condition || ''}` : (vehicle.condition || '');
    const subEl = document.getElementById('pr-subtitle');
    if (cached && generated_at) {
      const days = Math.floor((Date.now() - new Date(generated_at)) / 86400000);
      const ago = days <= 0 ? 'today' : days === 1 ? '1 day ago' : `${days} days ago`;
      subEl.innerHTML = `${esc(subBase)} · <span class="text-slate-400">cached ${ago}</span> · <button id="pr-refresh" class="text-indigo-500 hover:text-indigo-400 font-semibold">Refresh</button>`;
      setTimeout(() => document.getElementById('pr-refresh')?.addEventListener('click', () => openPriceReport(inventoryId, true)), 0);
    } else {
      subEl.textContent = subBase;
    }

    // Compute market average from valid (non-outlier) marketplace bars
    const _avgsAll = estimate?.marketplace_averages || [];
    const _rawPrices = _avgsAll.map(m => Number(m.avg)).filter(p => p > 0).sort((a, b) => a - b);
    const _med = _rawPrices.length ? (_rawPrices.length % 2 === 0
      ? (_rawPrices[Math.floor(_rawPrices.length / 2) - 1] + _rawPrices[Math.floor(_rawPrices.length / 2)]) / 2
      : _rawPrices[Math.floor(_rawPrices.length / 2)]) : null;
    const _validPrices = _med
      ? _avgsAll.map(m => Number(m.avg)).filter(p => p > 0 && p >= _med * 0.55 && p <= _med * 1.8)
      : _rawPrices;
    const computedMarketAvgForTiles = _validPrices.length
      ? Math.round(_validPrices.reduce((a, b) => a + b, 0) / _validPrices.length)
      : estimate?.mid;

    document.getElementById('pr-your-price').textContent = fmt(vehicle.price);
    document.getElementById('pr-median').textContent = fmt(computedMarketAvgForTiles);

    const diffEl = document.getElementById('pr-diff');
    if (pct_diff != null) {
      const over = pct_diff > 0;
      diffEl.textContent = (over ? '+' : '') + pct_diff + '%';
      diffEl.className = 'text-xl font-black ' + (over ? 'text-red-500' : 'text-amber-500');
      diffEl.title = over ? 'Priced above AI market estimate' : 'Priced below AI market estimate';
    } else {
      diffEl.textContent = '—';
      diffEl.className = 'text-xl font-black text-slate-400';
    }

    // Range bar
    if (estimate) {
      document.getElementById('pr-range-low').textContent = fmt(estimate.low);
      document.getElementById('pr-range-mid').textContent = fmt(estimate.mid);
      document.getElementById('pr-range-high').textContent = fmt(estimate.high);

      const lo = estimate.low, hi = estimate.high;
      const span = (hi - lo) || 1;
      const vp = Number(vehicle.price);
      const markerPct = Math.min(100, Math.max(0, ((vp - lo) / span) * 100));
      document.getElementById('pr-range-band').style.cssText = 'left:0%;width:100%';
      document.getElementById('pr-price-marker').style.left = markerPct + '%';
    }

    // Market velocity
    const ptmEl = document.getElementById('pr-ptm');
    const daysEl = document.getElementById('pr-days');
    if (ptmEl) {
      const ptm = estimate?.price_to_market_pct;
      ptmEl.textContent = ptm != null ? ptm + '%' : '—';
      ptmEl.className = 'text-xl font-black ' + (ptm == null ? 'text-slate-400' : ptm > 105 ? 'text-red-500' : ptm < 95 ? 'text-emerald-500' : 'text-slate-900 dark:text-white');
    }
    if (daysEl) daysEl.textContent = estimate?.days_on_market_estimate != null ? estimate.days_on_market_estimate + ' days' : '—';

    // Mileage panel
    const ma = estimate?.mileage_analysis;
    const distUnit = currencyLabel === 'USD' ? 'mi' : 'km';
    const fmtMi = n => n != null ? Number(n).toLocaleString() + ' ' + distUnit : '—';
    document.getElementById('pr-your-mileage').textContent = vehicle.mileage ? fmtMi(vehicle.mileage) : 'N/A';
    document.getElementById('pr-market-mileage').textContent = ma?.market_avg_mileage ? fmtMi(ma.market_avg_mileage) : '—';

    const ratingEl = document.getElementById('pr-mileage-rating');
    const ratingColorMap = {
      'well below average': 'text-emerald-500', 'below average': 'text-emerald-400',
      'average': 'text-slate-500', 'above average': 'text-amber-500', 'well above average': 'text-red-500'
    };
    if (ratingEl && ma?.mileage_rating) {
      ratingEl.textContent = ma.mileage_rating.charAt(0).toUpperCase() + ma.mileage_rating.slice(1);
      ratingEl.className = 'text-xs font-bold ' + (ratingColorMap[ma.mileage_rating] || 'text-slate-400');
    }

    const impactEl = document.getElementById('pr-mileage-impact');
    if (impactEl && ma?.mileage_price_impact != null) {
      const imp = Number(ma.mileage_price_impact);
      impactEl.textContent = (imp >= 0 ? '+' : '') + '$' + Math.abs(imp).toLocaleString() + ' ' + currencyLabel;
      impactEl.className = 'text-xs font-bold ' + (imp > 0 ? 'text-emerald-500' : imp < 0 ? 'text-red-500' : 'text-slate-400');
      if (imp > 0) impactEl.title = 'Premium for low mileage vs market average';
      else if (imp < 0) impactEl.title = 'Discount for high mileage vs market average';
    }
    document.getElementById('pr-mileage-note').textContent = ma?.mileage_note || '';

    // Mileage range bar: position marker at your mileage vs market avg
    if (ma?.market_avg_mileage && vehicle.mileage) {
      const marketAvgMi = Number(ma.market_avg_mileage);
      const yourMi = Number(vehicle.mileage);
      // Range: 0 to 2x market avg
      const rangeMax = marketAvgMi * 2;
      const markerPct = Math.min(100, Math.max(0, (yourMi / rangeMax) * 100));
      const marker = document.getElementById('pr-mileage-marker');
      if (marker) {
        marker.style.left = markerPct + '%';
        marker.className = 'absolute top-1/2 -translate-y-1/2 w-3 h-3 rounded-full border-2 border-white shadow ' +
          (yourMi < marketAvgMi * 0.8 ? 'bg-emerald-500' : yourMi > marketAvgMi * 1.2 ? 'bg-red-500' : 'bg-amber-400');
      }
    }

    // AI insight
    document.getElementById('pr-ai-note').textContent = estimate?.note || '—';
    const confLabel = document.getElementById('pr-confidence-label');
    if (estimate?.confidence) {
      const confMap = { high: 'High confidence', medium: 'Medium confidence', low: 'Low confidence — limited comparable data' };
      const srcBadge = data_source === 'marketcheck'
        ? '<span class="ml-2 inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-bold bg-violet-100 dark:bg-violet-900/40 text-violet-700 dark:text-violet-300">● MarketCheck live data</span>'
        : data_source === 'live'
        ? '<span class="ml-2 inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-bold bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300">● Live data</span>'
        : '<span class="ml-2 inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-bold bg-slate-100 dark:bg-slate-700 text-slate-500 dark:text-slate-400">AI estimate</span>';
      confLabel.innerHTML = (confMap[estimate.confidence] || estimate.confidence) + srcBadge;
    } else {
      confLabel.textContent = '';
    }

    // Per-marketplace average cards
    const cardsEl = document.getElementById('pr-marketplace-cards');
    const marketplaceAvgs = estimate?.marketplace_averages || [];
    if (cardsEl && marketplaceAvgs.length) {
      const yourPrice = Number(vehicle.price);
      cardsEl.innerHTML = marketplaceAvgs.map(m => {
        const mAvg = Number(m.avg);
        const vs = mAvg ? Math.round(((yourPrice - mAvg) / mAvg) * 100) : null;
        const vsColor = vs == null ? 'text-slate-400' : vs > 5 ? 'text-red-500' : vs < -5 ? 'text-emerald-500' : 'text-amber-500';
        const vsText = vs != null ? (vs > 0 ? '+' : '') + vs + '% vs avg' : '';
        return `<div class="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg p-3 text-center shadow-sm">
          <div class="text-[10px] font-bold text-indigo-500 dark:text-indigo-400 uppercase tracking-wider mb-1 truncate">${m.name}</div>
          <div class="text-lg font-black text-slate-900 dark:text-white">${fmt(m.avg)}</div>
          <div class="text-[10px] text-slate-400 mt-0.5">${m.estimated_listings || ''}</div>
          ${vs != null ? `<div class="text-[10px] font-bold mt-1 ${vsColor}">${vsText}</div>` : ''}
        </div>`;
      }).join('');
    }

    // Methodology note
    const isNew = vehicle.condition === 'new' || Number(vehicle.year) >= new Date().getFullYear();
    document.getElementById('pr-match-note').textContent = isNew
      ? `new ${vehicle.year} ${vehicle.make} ${vehicle.model} (same year)`
      : `used ${vehicle.year} ${vehicle.make} ${vehicle.model}${vehicle.trim ? ' ' + vehicle.trim : ''} (same year and trim)`;

    // Chart — marketplace averages + your price
    const ctx = document.getElementById('pr-chart');
    if (ctx && typeof Chart !== 'undefined' && estimate) {
      const yourPrice = Number(vehicle.price);
      const avgs = estimate.marketplace_averages || [];

      // Filter out marketplace averages that are outliers (< 55% or > 180% of
      // the median) — bad scrape data on one source shouldn't skew the chart.
      const rawAvgPrices = avgs.map(m => Number(m.avg)).filter(p => p > 0).sort((a, b) => a - b);
      const medIdx = Math.floor(rawAvgPrices.length / 2);
      const avgMedian = rawAvgPrices.length ? (rawAvgPrices.length % 2 === 0
        ? (rawAvgPrices[medIdx - 1] + rawAvgPrices[medIdx]) / 2
        : rawAvgPrices[medIdx]) : null;
      const validAvgs = avgMedian
        ? avgs.filter(m => { const p = Number(m.avg); return p >= avgMedian * 0.55 && p <= avgMedian * 1.8; })
        : avgs;

      // Build labels and data: one bar per valid marketplace avg, then Your Price
      const chartLabels = [...validAvgs.map(m => m.name), 'Your Price'];
      const chartData = [...validAvgs.map(m => Number(m.avg)), yourPrice];
      const chartColors = [
        'rgba(99,102,241,0.25)', 'rgba(99,102,241,0.35)', 'rgba(99,102,241,0.20)',
        '#6366f1' // your price always solid indigo
      ].slice(0, chartData.length);
      // Last bar (Your Price) is always solid indigo
      chartColors[chartData.length - 1] = '#6366f1';
      const chartBorders = chartColors.map((_, i) => i === chartData.length - 1 ? '#4f46e5' : '#818cf8');

      // Market average = mean of the valid marketplace bars (excludes Your Price and outliers)
      const validPrices = validAvgs.map(m => Number(m.avg)).filter(p => p > 0);
      const computedMarketAvg = validPrices.length
        ? Math.round(validPrices.reduce((a, b) => a + b, 0) / validPrices.length)
        : estimate.mid;
      const midLine = chartData.map(() => computedMarketAvg);

      __prChart = new Chart(ctx, {
        type: 'bar',
        data: {
          labels: chartLabels,
          datasets: [
            {
              label: `Price (${currencyLabel})`,
              data: chartData,
              backgroundColor: chartColors,
              borderColor: chartBorders,
              borderWidth: 2,
              borderRadius: 6,
              order: 2
            },
            {
              label: 'Market Average',
              data: midLine,
              type: 'line',
              borderColor: '#f59e0b',
              borderWidth: 2,
              borderDash: [5, 4],
              pointRadius: 0,
              fill: false,
              tension: 0,
              order: 1
            }
          ]
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: {
            legend: { display: true, labels: { boxWidth: 12, font: { size: 10 }, padding: 12 } },
            tooltip: { callbacks: { label: c => '$' + Number(c.raw).toLocaleString() + ' ' + currencyLabel } }
          },
          scales: {
            y: {
              beginAtZero: true,
              ticks: { callback: v => '$' + Number(v).toLocaleString(), font: { size: 10 } },
              grid: { color: 'rgba(148,163,184,0.15)' }
            },
            x: { ticks: { font: { size: 10 } }, grid: { display: false } }
          }
        }
      });
    }

    loading.classList.add('hidden');
    content.classList.remove('hidden');
  } catch (err) {
    loading.textContent = 'Failed to load report: ' + err.message;
  }
}

async function verifyAIBoostSession(sessionId) {
  try {
    const res = await fetch(`${API}/billing/ai-boost-verify?session_id=${encodeURIComponent(sessionId)}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (!res.ok) return; // webhook will still handle it; fail silently
    showToast('🎉 AI Boost activated! Its AI tools are now live on every vehicle.', 'success', 6000);
    switchPage('inventory');
  } catch {}
}

async function loadAIBoostSection() {
  const section = document.getElementById('ai-boost-section');
  if (!section) return;
  try {
    const res = await fetch(`${API}/ai/config`, { headers: { 'Authorization': `Bearer ${token}` } });
    if (!res.ok) return;
    const cfg = await res.json();
    __aiBoostActive = !!cfg.ai_boost_active;
    __vinStickerActive = !!cfg.vin_sticker_active;           // = Inventory Intelligence tier
    __aiDocsActive = !!cfg.ai_docs_active;                   // generated docs = AI Boost
    __invIntelActive = !!cfg.inv_intel_active;
    // Trial countdown badge on the ✦ Upgrades icon during the 30-day full-access window.
    updateTrialBadge(cfg.full_access ? (cfg.trial_days_left || 0) : 0);
    // Photo tools state (branded background + AI cutout provider) for the add-vehicle form.
    __photoBackgroundUrl = cfg.photo_background_url || null;
    __bgProviderReady = !!cfg.background_provider_ready;
    // Trade Appraisal is part of the Inventory Intelligence add-on — hide otherwise.
    document.getElementById('nav-appraisal')?.classList.toggle('hidden', !__invIntelActive);
    // Reveal the floating AI assistant dock for entitled dealers (owner exempt).
    updateAiDockVisibility();
    // Reveal the fixed Reports quick-access rail for Inventory Intelligence dealers.
    updateReportRailVisibility();
    // Stash dealership location for the appraisal PDFs' header.
    __apprDealerInfo = { city: cfg.city, province: cfg.province, postal_code: cfg.postal_code, country: cfg.country };
    __aiVisionActive = !!cfg.ai_vision_active;               // = AI Boost
    renderAiVisionNav();
    __aiBoostConfigLoaded = true;
    // Hot/cold + health tags load lazily the first time Inventory is opened
    // (prefetchInvIntelTags), instead of on login — keeps the initial burst small.
    // If the user is already on the Inventory page, prime them now.
    if (__invIntelActive && !document.querySelector('[data-page-content="inventory"]')?.classList.contains('hidden')) {
      prefetchInvIntelTags();
    }
    renderAIBoostSection(cfg);
    initVinStickerPage();
    renderInvIntelSidebar(cfg);
    if (__vinStickerActive) loadBrandingSettings();
    // If the user is already on the Inventory Intelligence page (navigated there
    // before config loaded), refresh the Inventory Scan card now that flags are set.
    const iiPage = document.querySelector('[data-page-content="inv-intel"]');
    if (iiPage && !iiPage.classList.contains('hidden')) loadAIActivity();
  } catch {}
}

function renderAIBoostSection(cfg) {
  const badge = document.getElementById('ai-boost-badge');
  const inactive = document.getElementById('ai-boost-inactive');
  const activePanel = document.getElementById('ai-boost-active');
  if (!badge || !inactive || !activePanel) return;

  const upsellBanner = document.getElementById('ai-boost-upsell-banner');
  if (upsellBanner) {
    const isAdmin = profileContext?.role === 'DEALER_ADMIN' || profileContext?.role === 'OWNER' || profileContext?.role === 'MANAGER';
    const dismissed = (() => { try { return localStorage.getItem('ms_ai_boost_banner_dismissed') === '1'; } catch { return false; } })();
    const showBanner = isAdmin && !cfg.ai_boost_active && !dismissed;
    upsellBanner.classList.toggle('hidden', !showBanner);
    const closeBtn = document.getElementById('ai-boost-upsell-close');
    if (closeBtn && !closeBtn._wired) {
      closeBtn._wired = true;
      closeBtn.addEventListener('click', () => {
        upsellBanner.classList.add('hidden');
        try { localStorage.setItem('ms_ai_boost_banner_dismissed', '1'); } catch {}
      });
    }
  }

  // AI Boost no longer has a sidebar nav item or dedicated page — it's sold via
  // the in-context upgrade modal and configured in this Profile section.

  if (cfg.ai_boost_active) {
    badge.textContent = 'Active';
    badge.className = 'text-xs font-bold px-2 py-0.5 rounded-full border border-emerald-500 bg-emerald-900/30 text-emerald-300';
    badge.classList.remove('hidden');
    inactive.classList.add('hidden');
    activePanel.classList.remove('hidden');

    // Pre-fill form
    const toneEl = document.getElementById('ai-tone');
    if (toneEl) toneEl.value = cfg.ai_tone || 'professional';
    const emailEl = document.getElementById('ai-manager-email');
    if (emailEl) emailEl.value = cfg.ai_manager_email || '';
    const cty = document.getElementById('ai-country'); if (cty) cty.value = (cfg.country || 'CA').toUpperCase() === 'US' ? 'US' : 'CA';
    const prov = document.getElementById('ai-province'); if (prov) prov.value = cfg.province || '';
    const cityEl = document.getElementById('ai-city'); if (cityEl) cityEl.value = cfg.city || '';
    const postal = document.getElementById('ai-postal'); if (postal) postal.value = cfg.postal_code || '';

    const reqFields = cfg.ai_required_fields || [];
    ['price', 'mileage', 'image_urls', 'description'].forEach(f => {
      const idMap = { price: 'ai-req-price', mileage: 'ai-req-mileage', image_urls: 'ai-req-photos', description: 'ai-req-description' };
      const el = document.getElementById(idMap[f]);
      if (el) el.checked = reqFields.includes(f);
    });
  } else {
    badge.textContent = 'Not Active';
    badge.className = 'text-xs font-bold px-2 py-0.5 rounded-full border border-slate-500 bg-slate-800 text-slate-400';
    badge.classList.remove('hidden');
    inactive.classList.remove('hidden');
    activePanel.classList.add('hidden');
  }
}

async function startAIBoostCheckout(btn, resetLabel) {
  btn.disabled = true;
  btn.textContent = 'Redirecting...';
  try {
    const res = await fetch(`${API}/billing/subscribe-ai-boost`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const data = await res.json();
    if (data.url) { window.location.href = data.url; return; }
    throw new Error(data.error || 'Failed to start checkout');
  } catch (err) {
    btn.disabled = false;
    btn.textContent = resetLabel;
    alert('Could not start AI Boost checkout: ' + err.message);
  }
}

function setupAIBoostListeners() {
  document.getElementById('ai-boost-upgrade-btn')?.addEventListener('click', (e) => {
    startAIBoostCheckout(e.currentTarget, 'Start 30-Day Free Trial — $129/month after');
  });

  document.getElementById('ai-boost-upsell-btn')?.addEventListener('click', (e) => {
    startAIBoostCheckout(e.currentTarget, 'Try Free for 30 Days');
  });

  document.getElementById('ai-boost-page-upgrade-btn')?.addEventListener('click', (e) => {
    startAIBoostCheckout(e.currentTarget, 'Try Free for 30 Days');
  });
  document.getElementById('ai-boost-manage-btn')?.addEventListener('click', launchStripeLifecycle);

  document.getElementById('ai-activity-refresh')?.addEventListener('click', loadAIActivity);

  document.getElementById('ai-boost-goto-page-btn')?.addEventListener('click', () => {
    switchPage('inventory');
  });

  document.getElementById('ai-sync-all-btn')?.addEventListener('click', async () => {
    const btn = document.getElementById('ai-sync-all-btn');
    const status = document.getElementById('ai-sync-status');
    const statusText = document.getElementById('ai-sync-status-text');
    const progressBar = document.getElementById('ai-sync-progress-bar');
    const progressLabel = document.getElementById('ai-sync-progress-label');

    const resetBtn = () => {
      btn.disabled = false;
      btn.innerHTML = `<svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg> Scan All Inventory`;
      if (status) status.classList.add('hidden');
      if (progressBar) progressBar.style.width = '0%';
    };

    btn.disabled = true;
    btn.textContent = 'Scanning…';
    if (status) status.classList.remove('hidden');
    if (statusText) statusText.textContent = 'Starting scan…';
    if (progressBar) progressBar.style.width = '0%';
    if (progressLabel) progressLabel.textContent = '';

    try {
      const res = await fetch(`${API}/ai/sync-all`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Sync failed');

      const total = data.queued || 0;
      if (statusText) statusText.textContent = `Scanning ${total} vehicles…`;

      if (total === 0) { resetBtn(); return; }

      // Start the counting window slightly in the past. The rows are stamped with
      // the SERVER clock; scanStartedAt is the CLIENT clock. If the phone runs even
      // a second ahead, the first vehicle's row lands just before the window and is
      // never counted — so the bar caps one short (e.g. "161 of 162") and never
      // finishes. A 15s buffer absorbs normal clock skew.
      const scanStartedAt = new Date(Date.now() - 15000);

      // Finish either when every vehicle reported in, OR when the count stops
      // advancing for a while (backend loop is done but a row or two fell outside
      // the window) — never hang forever at 99%.
      let lastProcessed = -1;
      let lastAdvanceAt = Date.now();
      const STALL_MS = 45000;

      const finishScan = (label) => {
        clearInterval(pollInterval);
        if (statusText) statusText.textContent = label;
        if (progressBar) progressBar.style.width = '100%';
        if (progressLabel) progressLabel.textContent = `${total} of ${total} checked (100%)`;
        loadAIActivity();
        setTimeout(resetBtn, 3000);
      };

      // Poll every 3 seconds — count only activity items newer than scan start
      const pollInterval = setInterval(async () => {
        try {
          const r = await fetch(`${API}/ai/activity?limit=500`, { headers: { 'Authorization': `Bearer ${token}` } });
          const d = r.ok ? await r.json() : {};
          const processed = (d.activity || []).filter(a => new Date(a.created_at) >= scanStartedAt).length;
          if (processed > lastProcessed) { lastProcessed = processed; lastAdvanceAt = Date.now(); }
          const pct = Math.min(100, Math.round((processed / total) * 100));
          if (progressBar) progressBar.style.width = pct + '%';
          if (progressLabel) progressLabel.textContent = `${Math.min(processed, total)} of ${total} checked (${pct}%)`;
          if (statusText) statusText.textContent = `Scanning ${total} vehicles…`;
          loadAIActivity();
          if (processed >= total) {
            finishScan(`Done — ${total} vehicles scanned`);
          } else if (processed > 0 && (Date.now() - lastAdvanceAt) > STALL_MS) {
            finishScan(`Done — ${processed} of ${total} scanned`);
          }
        } catch {}
      }, 3000);

      // Safety timeout — stop polling after 10 minutes regardless
      setTimeout(() => { clearInterval(pollInterval); resetBtn(); }, 600000);

    } catch (err) {
      resetBtn();
      showToast('Scan failed: ' + err.message, 'error');
    }
  });

  document.getElementById('ai-config-save-btn')?.addEventListener('click', async () => {
    const btn = document.getElementById('ai-config-save-btn');
    const msg = document.getElementById('ai-config-msg');
    btn.disabled = true;
    btn.textContent = 'Saving...';

    const reqFields = [];
    if (document.getElementById('ai-req-price')?.checked) reqFields.push('price');
    if (document.getElementById('ai-req-mileage')?.checked) reqFields.push('mileage');
    if (document.getElementById('ai-req-photos')?.checked) reqFields.push('image_urls');
    if (document.getElementById('ai-req-description')?.checked) reqFields.push('description');

    const payload = {
      ai_tone: document.getElementById('ai-tone')?.value || 'professional',
      ai_manager_email: document.getElementById('ai-manager-email')?.value.trim() || null,
      ai_required_fields: reqFields,
      country: document.getElementById('ai-country')?.value || 'CA',
      province: document.getElementById('ai-province')?.value.trim() || null,
      city: document.getElementById('ai-city')?.value.trim() || null,
      postal_code: document.getElementById('ai-postal')?.value.trim() || null,
    };

    try {
      const res = await fetch(`${API}/ai/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Save failed');
      msg.textContent = '✓ Saved';
      msg.className = 'text-xs font-medium px-2.5 py-1 rounded-md bg-emerald-100 dark:bg-emerald-900/50 text-emerald-700 dark:text-emerald-300';
      msg.classList.remove('hidden');
    } catch (err) {
      msg.textContent = err.message;
      msg.className = 'text-xs font-medium px-2.5 py-1 rounded-md bg-red-100 dark:bg-red-900/50 text-red-700 dark:text-red-300';
      msg.classList.remove('hidden');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Save AI Settings';
      setTimeout(() => msg.classList.add('hidden'), 4000);
    }
  });

  document.getElementById('ai-enrich-close')?.addEventListener('click', closeAIEnrichModal);
  document.getElementById('ai-enrich-modal')?.addEventListener('click', (e) => {
    if (e.target.id === 'ai-enrich-modal') closeAIEnrichModal();
  });
  document.getElementById('ai-enrich-copy-btn')?.addEventListener('click', () => {
    const text = document.getElementById('ai-enrich-copy')?.textContent;
    if (text) navigator.clipboard.writeText(text).catch(() => {});
  });
}

function closeAIEnrichModal() {
  document.getElementById('ai-enrich-modal')?.classList.add('hidden');
}

async function openAIEnrich(inventoryId) {
  const modal = document.getElementById('ai-enrich-modal');
  if (!modal) return;
  modal.classList.remove('hidden');
  document.getElementById('ai-enrich-loading').classList.remove('hidden');
  document.getElementById('ai-enrich-content').classList.add('hidden');
  document.getElementById('ai-enrich-error').classList.add('hidden');

  try {
    const res = await fetch(`${API}/ai/enrich-listing`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ inventory_id: inventoryId })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Enrichment failed');

    document.getElementById('ai-enrich-loading').classList.add('hidden');
    document.getElementById('ai-enrich-content').classList.remove('hidden');

    // Warnings
    const warningsBlock = document.getElementById('ai-enrich-warnings');
    const warningsList = document.getElementById('ai-enrich-warnings-list');
    if (data.warnings && data.warnings.length > 0) {
      warningsList.innerHTML = data.warnings.map(w => `<li>${w}</li>`).join('');
      warningsBlock.classList.remove('hidden');
    } else {
      warningsBlock.classList.add('hidden');
    }

    // Price flag
    const priceFlag = document.getElementById('ai-enrich-price-flag');
    const priceFlagText = document.getElementById('ai-enrich-price-flag-text');
    if (data.price_flag?.flagged) {
      const dir = data.price_flag.pct_diff > 0 ? 'above' : 'below';
      const pct = Math.abs(data.price_flag.pct_diff);
      priceFlagText.textContent = `This vehicle is priced ${pct}% ${dir} the median of ${data.price_flag.comp_count} comparable vehicle${data.price_flag.comp_count !== 1 ? 's' : ''} ($${Number(data.price_flag.median).toLocaleString()} median).`;
      priceFlag.classList.remove('hidden');
    } else {
      priceFlag.classList.add('hidden');
    }

    // Copy
    document.getElementById('ai-enrich-copy').textContent = data.copy || '(No copy generated)';
  } catch (err) {
    document.getElementById('ai-enrich-loading').classList.add('hidden');
    const errEl = document.getElementById('ai-enrich-error');
    errEl.textContent = err.message;
    errEl.classList.remove('hidden');
  }
}

// "5 minutes ago", "2 days ago", etc — easier to scan than a date string
function friendlyAgo(date) {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return 'Just now';
  if (seconds < 3600) return Math.floor(seconds / 60) + ' min ago';
  if (seconds < 86400) return Math.floor(seconds / 3600) + ' hr ago';
  if (seconds < 604800) return Math.floor(seconds / 86400) + ' days ago';
  return date.toLocaleDateString();
}

// ── VIN Decode & PDF (VIN Sticker add-on) ────────────────────────────────────

let __vinDecodeVehicleId = null;
let __vinDecodeData = null;

function openVinDecode(vehicleId, existingVin) {
  __vinDecodeVehicleId = vehicleId;
  __vinDecodeData = null;
  const modal = document.getElementById('vin-decode-modal');
  document.getElementById('vin-decode-results').classList.add('hidden');
  document.getElementById('vin-decode-error').classList.add('hidden');
  document.getElementById('vin-decode-loading').classList.add('hidden');
  const vinLabel = document.getElementById('vin-decode-vin');
  if (vinLabel) vinLabel.textContent = existingVin ? `VIN ${existingVin}` : '';
  modal.classList.remove('hidden');
  // Auto-load the full decode from the vehicle's VIN — no manual step.
  if (existingVin && existingVin.length >= 11) runVinDecode(existingVin);
  else showVinError('This vehicle has no VIN on file to decode.');
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('vin-decode-modal')?.addEventListener('click', (e) => {
    if (e.target.id === 'vin-decode-modal') e.target.classList.add('hidden');
  });

  // Branding Settings wiring
  const primaryPicker = document.getElementById('branding-primary-color');
  const primaryHex = document.getElementById('branding-primary-color-hex');
  const secondaryPicker = document.getElementById('branding-secondary-color');
  const secondaryHex = document.getElementById('branding-secondary-color-hex');

  const syncSwatch = () => {
    const p = primaryHex?.value || '#1a2e4a';
    const s = secondaryHex?.value || '#c8a84b';
    document.getElementById('branding-swatch-header')?.style.setProperty('background', p);
    document.getElementById('branding-swatch-accent')?.style.setProperty('background', s);
  };

  primaryPicker?.addEventListener('input', () => { if (primaryHex) primaryHex.value = primaryPicker.value; syncSwatch(); });
  primaryHex?.addEventListener('input', () => { if (/^#[0-9a-f]{6}$/i.test(primaryHex.value)) { primaryPicker.value = primaryHex.value; syncSwatch(); } });
  secondaryPicker?.addEventListener('input', () => { if (secondaryHex) secondaryHex.value = secondaryPicker.value; syncSwatch(); });
  secondaryHex?.addEventListener('input', () => { if (/^#[0-9a-f]{6}$/i.test(secondaryHex.value)) { secondaryPicker.value = secondaryHex.value; syncSwatch(); } });

  document.getElementById('branding-logo-input')?.addEventListener('change', uploadBrandingLogo);
  document.getElementById('branding-save-btn')?.addEventListener('click', saveBrandingSettings);
});

async function runVinDecode(vinArg) {
  const vin = String(vinArg || '').trim().toUpperCase();
  if (!vin || vin.length < 11) {
    showVinError('This vehicle has no VIN on file to decode.');
    return;
  }
  const token = localStorage.getItem('token');
  document.getElementById('vin-decode-loading').classList.remove('hidden');
  document.getElementById('vin-decode-results').classList.add('hidden');
  document.getElementById('vin-decode-error').classList.add('hidden');
  try {
    const res = await fetch(`${API}/vin/decode/${encodeURIComponent(vin)}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Decode failed');
    __vinDecodeData = data;
    renderVinResults(data);

    // Persist the recall check to this vehicle so its Inventory card stops saying
    // "not checked yet" and shows ✓/⚠. Only stores vin_data + recalls — it does not
    // overwrite the vehicle's year/make/model.
    if (__vinDecodeVehicleId) {
      const recalls = Array.isArray(data.recalls) ? data.recalls : [];
      fetch(`${API}/vin/apply/${__vinDecodeVehicleId}`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ decoded: { vin_data: data.decoded?.vin_data ?? null }, recalls }),
      }).then(() => {
        const v = (typeof __catalogCache !== 'undefined' ? __catalogCache : []).find(x => x.id === __vinDecodeVehicleId);
        if (v) { v.recalls = recalls; v.recalls_checked_at = new Date().toISOString(); if (typeof renderCatalog === 'function') renderCatalog(); }
      }).catch(() => {});
    }
  } catch (e) {
    showVinError(e.message);
  } finally {
    document.getElementById('vin-decode-loading').classList.add('hidden');
  }
}

function showVinError(msg) {
  const el = document.getElementById('vin-decode-error');
  el.textContent = msg;
  el.classList.remove('hidden');
}

function renderVinResults({ decoded, recalls, all_fields }) {
  const grid = document.getElementById('vin-decoded-grid');
  const escv = (s) => String(s == null ? '' : s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

  const coreFields = [
    ['Year',         decoded.year],
    ['Make',         decoded.make],
    ['Model',        decoded.model],
    ['Trim',         decoded.trim],
    ['Body Style',   decoded.body_style],
    ['Doors',        decoded.doors],
    ['Fuel Type',    decoded.fuel_type],
    ['Drivetrain',   decoded.drivetrain],
    ['Transmission', decoded.transmission],
    ['Engine',       decoded.engine],
  ].filter(([, v]) => v);

  const card = (label, value) => `
    <div class="bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg px-3 py-2">
      <div class="text-xs text-slate-400 uppercase tracking-wide">${escv(label)}</div>
      <div class="text-sm font-bold text-slate-900 dark:text-white mt-0.5">${escv(value)}</div>
    </div>`;

  // Summary tiles up top, then EVERY field NHTSA returned (full deep dive).
  let html = coreFields.map(([l, v]) => card(l, v)).join('');
  const all = Array.isArray(all_fields) ? all_fields : [];
  if (all.length) {
    html += `<div class="col-span-2 sm:col-span-3 mt-1 pt-2 border-t border-slate-200 dark:border-slate-700 text-xs font-bold text-slate-400 uppercase tracking-widest">Full Build Data — ${all.length} fields (NHTSA)</div>`;
    html += all.map(f => card(f.label, f.value)).join('');
  }
  grid.innerHTML = html;

  const recallSection = document.getElementById('vin-recalls-section');
  const recallHeader = document.getElementById('vin-recalls-header');
  const recallList = document.getElementById('vin-recalls-list');
  if (recalls?.length) {
    recallHeader.innerHTML = `<span class="text-red-600 dark:text-red-400">⚠ ${recalls.length} Open Recall${recalls.length > 1 ? 's' : ''}</span>`;
    recallList.innerHTML = recalls.map(r => `
      <div class="bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 rounded-lg px-3 py-2 text-xs">
        <div class="font-bold text-red-700 dark:text-red-400">${r.Component || 'Component'}</div>
        <div class="text-slate-600 dark:text-slate-400 mt-1">${r.Summary || r.Consequence || ''}</div>
        ${r.Remedy ? `<div class="text-emerald-700 dark:text-emerald-400 mt-1 font-medium">Remedy: ${r.Remedy}</div>` : ''}
      </div>`).join('');
    recallSection.classList.remove('hidden');
  } else {
    recallHeader.innerHTML = `<span class="text-emerald-600 dark:text-emerald-400">✓ No open recalls found</span>`;
    recallList.innerHTML = '';
    recallSection.classList.remove('hidden');
  }

  document.getElementById('vin-decode-results').classList.remove('hidden');
}

async function generatePdf(vehicleId, type, btn, opts = {}) {
  const token = localStorage.getItem('token');
  const origText = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Generating…';
  const label = type === 'window-sticker' ? 'Window Sticker' : 'Brochure';
  // oemOnly = fetch the factory sticker only (no fallback); forceGenerate = branded.
  const genQuery = opts.oemOnly ? '?source=oem'
    : opts.forceGenerate ? '?source=generate&regen=1' : '';
  // Status polling must check the SAME variant's cache (OEM vs generated).
  const statusQuery = opts.oemOnly ? '?source=oem' : '?source=generate';

  const openUrl = (url, source) => {
    window.open(url, '_blank');
    // For window stickers, tell the dealer whether it's the authentic factory
    // document or one we generated.
    let msg = `${label} ready — opened in new tab`;
    if (type === 'window-sticker') {
      msg = source === 'oem'
        ? 'Official manufacturer window sticker — opened in new tab'
        : 'MarketSync-generated window sticker — opened in new tab';
    }
    showToast(msg, 'success');
    btn.disabled = false;
    btn.textContent = origText;
  };

  const pollStatus = async (deadline) => {
    if (Date.now() > deadline) {
      showToast(`${label} is still generating — check back in a minute and click again to open it`, 'info', 8000);
      btn.disabled = false;
      btn.textContent = origText;
      return;
    }
    try {
      const r = await fetch(`${API}/pdf/${type}/${vehicleId}/status${statusQuery}`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      const d = await r.json();
      if (d.status === 'ready' && d.url) {
        openUrl(d.url, d.source);
      } else {
        setTimeout(() => pollStatus(deadline), 4000);
      }
    } catch {
      setTimeout(() => pollStatus(deadline), 4000);
    }
  };

  try {
    showToast(`Generating ${label} — this takes 15–30 seconds on first run…`, 'info', 35000);
    const res = await fetch(`${API}/pdf/${type}/${vehicleId}${genQuery}`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    });
    const data = await res.json();
    // OEM-only requested but none exists → offer to generate one instead.
    if (res.status === 404 && data.error === 'no_oem') {
      btn.disabled = false;
      btn.textContent = origText;
      showNoOemPrompt(vehicleId, btn, type);
      return;
    }
    if (!res.ok) throw new Error(data.error || 'PDF generation failed');
    if (data.url) {
      // Cached — open immediately
      openUrl(data.url, data.source);
    } else {
      // Generation started — poll for completion (150s deadline)
      pollStatus(Date.now() + 150_000);
    }
  } catch (e) {
    showToast(e.message, 'error');
    btn.disabled = false;
    btn.textContent = origText;
  }
}

// Shown when "Get OEM" finds no factory document — explains and offers to generate
// a branded dealer one instead. Works for both window stickers and brochures.
function showNoOemPrompt(vehicleId, btn, type = 'window-sticker') {
  const isBrochure = type === 'brochure';
  const noun = isBrochure ? 'brochure' : 'window sticker';
  const genLabel = isBrochure ? 'Generate Dealer Brochure' : 'Generate Dealer Sticker';
  const detail = isBrochure
    ? "There's no manufacturer brochure on file for this vehicle (factory brochures are available up to 2023). You can generate a branded dealer brochure instead."
    : "There's no authentic OEM window sticker available for this VIN. You can generate a branded dealer sticker instead.";
  document.getElementById('no-oem-modal')?.remove();
  const modal = document.createElement('div');
  modal.id = 'no-oem-modal';
  modal.className = 'fixed inset-0 z-[70] bg-black/60 flex items-center justify-center p-4';
  modal.innerHTML = `
    <div class="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl w-full max-w-sm p-6 shadow-2xl text-center">
      <div class="w-11 h-11 mx-auto rounded-full bg-amber-100 dark:bg-amber-900/40 flex items-center justify-center mb-3">
        <svg class="w-6 h-6 text-amber-600 dark:text-amber-400" fill="none" stroke="currentColor" stroke-width="1.9" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z"/></svg>
      </div>
      <h3 class="text-base font-bold text-slate-900 dark:text-white mb-1">No factory ${noun} found</h3>
      <p class="text-xs text-slate-500 dark:text-slate-400 mb-4">${detail}</p>
      <button data-act="generate" class="w-full bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-bold px-4 py-2.5 rounded-lg transition flex items-center justify-center gap-1.5">
        ${genLabel} <svg viewBox="0 0 24 24" width="14" height="14" class="inline-block flex-shrink-0" aria-hidden="true"><title>AI Boost feature</title><path d="M12 2.5l2.4 6.6 6.6 2.4-6.6 2.4L12 20.5l-2.4-6.6L3 11.5l6.6-2.4z" fill="#c4b5fd" fill-opacity="0.5" stroke="#6d28d9" stroke-width="1.4" stroke-linejoin="round"/></svg>
      </button>
      <button data-act="cancel" class="mt-2.5 w-full text-xs font-bold text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 py-1.5 transition">Cancel</button>
    </div>`;
  const close = () => modal.remove();
  modal.addEventListener('click', (e) => {
    if (e.target === modal) return close();
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act) return;
    close();
    if (act === 'generate') {
      if (!__aiDocsActive) { openUpgradeModal('ai_boost'); return; }
      generatePdf(vehicleId, type, btn, { forceGenerate: true });
    }
  });
  document.body.appendChild(modal);
}

// Brochure button → OEM (factory brochure from Auto-Brochures) vs generated dealer
// brochure. Mirrors the sticker choice.
function showBrochureChoice(btn) {
  const id = btn.dataset.id;
  const label = btn.dataset.label || 'this vehicle';
  const oemUrl = btn.dataset.oemUrl || '';
  const genUrl = btn.dataset.genUrl || '';
  const savedTag = '<span class="text-[10px] font-bold uppercase bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300 px-1.5 py-0.5 rounded">Saved</span>';
  document.getElementById('brochure-choice-modal')?.remove();
  const modal = document.createElement('div');
  modal.id = 'brochure-choice-modal';
  modal.className = 'fixed inset-0 z-[60] bg-black/60 flex items-center justify-center p-4';
  modal.innerHTML = `
    <div class="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl w-full max-w-sm p-6 shadow-2xl">
      <h3 class="text-base font-bold text-slate-900 dark:text-white mb-1">Brochure</h3>
      <p class="text-xs text-slate-500 dark:text-slate-400 mb-4 truncate" title="${label}">${label} — OEM &amp; AI brochures save separately.</p>
      <div class="space-y-2.5">
        <button data-choice="oem" class="w-full text-left px-4 py-3 rounded-lg border border-slate-200 dark:border-slate-700 hover:border-emerald-400 dark:hover:border-emerald-600 hover:bg-emerald-50 dark:hover:bg-emerald-950/30 transition">
          <div class="text-sm font-bold text-slate-900 dark:text-white flex items-center gap-1.5">${oemUrl ? 'View OEM Brochure' : 'Get OEM Brochure'} ${oemUrl ? savedTag : ''}</div>
          <div class="text-xs text-slate-500 dark:text-slate-400 mt-0.5">${oemUrl ? 'Open your saved factory brochure.' : 'Pull the authentic manufacturer sales brochure (available up to 2023).'}</div>
        </button>
        <button data-choice="generate" class="w-full text-left px-4 py-3 rounded-lg border border-slate-200 dark:border-slate-700 hover:border-indigo-400 dark:hover:border-indigo-600 hover:bg-indigo-50 dark:hover:bg-indigo-950/30 transition ${__aiDocsActive ? '' : 'opacity-70'}">
          <div class="text-sm font-bold text-slate-900 dark:text-white flex items-center gap-1.5">${genUrl ? 'View Dealer Brochure' : 'Generate Dealer Brochure'} <svg viewBox="0 0 24 24" width="14" height="14" class="inline-block flex-shrink-0" aria-hidden="true"><title>AI Boost feature — included in your plan</title><path d="M12 2.5l2.4 6.6 6.6 2.4-6.6 2.4L12 20.5l-2.4-6.6L3 11.5l6.6-2.4z" fill="#c4b5fd" fill-opacity="0.5" stroke="#6d28d9" stroke-width="1.4" stroke-linejoin="round"/></svg> ${genUrl ? savedTag : (__aiDocsActive ? '' : '<span class="text-[10px] font-bold uppercase bg-violet-100 text-violet-700 dark:bg-violet-950/60 dark:text-violet-300 px-1.5 py-0.5 rounded">AI Boost</span>')}</div>
          <div class="text-xs text-slate-500 dark:text-slate-400 mt-0.5">${genUrl ? 'Open your saved branded brochure, or regenerate.' : 'Build a branded MarketSync brochure.'}${(!genUrl && !__aiDocsActive) ? ' Included with AI Boost.' : ''}</div>
        </button>
        ${genUrl ? '<button data-choice="regen" class="w-full text-center text-xs font-bold text-indigo-500 hover:text-indigo-400 py-1 transition">↻ Regenerate dealer brochure</button>' : ''}
      </div>
      <button data-choice="cancel" class="mt-4 w-full text-xs font-bold text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 py-1.5 transition">Cancel</button>
    </div>`;
  const close = () => modal.remove();
  modal.addEventListener('click', (e) => {
    if (e.target === modal) return close();
    const choice = e.target.closest('[data-choice]')?.dataset.choice;
    if (!choice) return;
    if ((choice === 'generate' || choice === 'regen') && !__aiDocsActive) { close(); openUpgradeModal('ai_boost'); return; }
    close();
    if (choice === 'oem') { if (oemUrl) window.open(oemUrl, '_blank'); else generatePdf(id, 'brochure', btn, { oemOnly: true }); }
    else if (choice === 'generate') { if (genUrl) window.open(genUrl, '_blank'); else generatePdf(id, 'brochure', btn, { forceGenerate: true }); }
    else if (choice === 'regen') generatePdf(id, 'brochure', btn, { forceGenerate: true });
  });
  document.body.appendChild(modal);
}

async function loadBrandingSettings() {
  // The old AI Boost branding card was removed — branding is now managed in
  // Profile & Settings (loadProfileBranding / prof-brand-*). If those legacy
  // elements aren't in the DOM, there's nothing to populate here.
  if (!document.getElementById('branding-primary-color')) return;
  const token = localStorage.getItem('token');
  try {
    const res = await fetch(`${API}/branding`, { headers: { 'Authorization': `Bearer ${token}` } });
    if (!res.ok) return;
    const data = await res.json();
    const b = data.branding || {};
    if (b.primary_color) {
      document.getElementById('branding-primary-color').value = b.primary_color;
      document.getElementById('branding-primary-color-hex').value = b.primary_color;
      document.getElementById('branding-swatch-header')?.style.setProperty('background', b.primary_color);
    }
    if (b.secondary_color) {
      document.getElementById('branding-secondary-color').value = b.secondary_color;
      document.getElementById('branding-secondary-color-hex').value = b.secondary_color;
      document.getElementById('branding-swatch-accent')?.style.setProperty('background', b.secondary_color);
    }
    if (b.tagline) document.getElementById('branding-tagline').value = b.tagline;
    if (b.logo_url) {
      const preview = document.getElementById('branding-logo-preview');
      preview.innerHTML = `<img src="${b.logo_url}" alt="Logo" class="max-h-full max-w-full object-contain p-2">`;
    }
  } catch {}
}

async function uploadBrandingLogo() {
  const file = document.getElementById('branding-logo-input').files[0];
  if (!file) return;
  const token = localStorage.getItem('token');
  const msg = document.getElementById('branding-save-msg');
  const formData = new FormData();
  formData.append('logo', file);
  try {
    const res = await fetch(`${API}/branding/logo`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` },
      body: formData,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Upload failed');
    const preview = document.getElementById('branding-logo-preview');
    preview.innerHTML = `<img src="${data.url}" alt="Logo" class="max-h-full max-w-full object-contain p-2">`;
    showBrandingMsg('✓ Logo uploaded', true);
  } catch (e) {
    showBrandingMsg(e.message, false);
  }
}

async function saveBrandingSettings() {
  const token = localStorage.getItem('token');
  const payload = {
    primary_color: document.getElementById('branding-primary-color-hex')?.value || '',
    secondary_color: document.getElementById('branding-secondary-color-hex')?.value || '',
    tagline: document.getElementById('branding-tagline')?.value || '',
  };
  try {
    const res = await fetch(`${API}/branding`, {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Save failed');
    showBrandingMsg('✓ Branding saved', true);
  } catch (e) {
    showBrandingMsg(e.message, false);
  }
}

function showBrandingMsg(text, ok) {
  const el = document.getElementById('branding-save-msg');
  el.textContent = text;
  el.className = `text-xs font-medium px-2.5 py-1 rounded-md ${ok ? 'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300' : 'bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300'}`;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 4000);
}

// ── VIN Sticker & Brochure page ───────────────────────────────────────────────

function initVinStickerPage() {
  renderVinStickerNav();
  renderInvIntelNav();
  loadVinStickerPage();

  document.getElementById('vin-page-decode-btn')?.addEventListener('click', runVinPageDecode);
  document.getElementById('vin-page-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') runVinPageDecode();
  });
  document.getElementById('vin-sticker-page-upgrade-btn')?.addEventListener('click', startVinStickerTrial);
  document.getElementById('vin-sticker-manage-btn')?.addEventListener('click', launchStripeLifecycle);
}

function renderVinStickerNav() {
  const btn = document.getElementById('nav-vin-sticker');
  const pill = document.getElementById('nav-vin-sticker-pill');
  if (!btn) return;

  // Show for everyone (roles: admins + dealer reps). The hidden class was set
  // by the pre-render CSS; now that config is loaded we can reveal it.
  btn.classList.remove('hidden');

  if (__vinStickerActive) {
    btn.classList.remove('text-slate-400', 'dark:text-slate-600');
    btn.classList.add('text-slate-700', 'dark:text-slate-300', 'hover:bg-slate-100', 'dark:hover:bg-slate-800');
    if (pill) pill.classList.add('hidden');
  } else {
    btn.classList.add('text-slate-700', 'dark:text-slate-300', 'hover:bg-slate-100', 'dark:hover:bg-slate-800');
    if (pill) pill.classList.remove('hidden');
  }

  if (!btn._clickWired) {
    btn._clickWired = true;
    btn.addEventListener('click', () => switchPage('vin-sticker'));
  }
}

function renderInvIntelNav() {
  const btn = document.getElementById('nav-inv-intel');
  if (!btn) return;
  const isAdmin = profileContext?.role === 'DEALER_ADMIN' || profileContext?.role === 'OWNER' || profileContext?.role === 'MANAGER';
  if (!isAdmin) { btn.classList.add('hidden'); return; }

  btn.classList.remove('hidden');
  const pill = document.getElementById('nav-inv-intel-pill');
  if (__invIntelActive) {
    btn.classList.remove('text-slate-400', 'dark:text-slate-600');
    btn.classList.add('text-slate-700', 'dark:text-slate-300', 'hover:bg-slate-100', 'dark:hover:bg-slate-800');
    if (pill) pill.classList.add('hidden');
  } else {
    btn.classList.add('text-slate-700', 'dark:text-slate-300', 'hover:bg-slate-100', 'dark:hover:bg-slate-800');
    if (pill) pill.classList.remove('hidden');
  }

  if (!btn._clickWired) {
    btn._clickWired = true;
    btn.addEventListener('click', () => switchPage('inv-intel'));
  }
}

async function loadVinStickerPage() {
  const upsell = document.getElementById('vin-sticker-page-upsell');
  const active = document.getElementById('vin-sticker-active-content');
  if (!upsell || !active) return;

  if (__vinStickerActive) {
    upsell.classList.add('hidden');
    active.classList.remove('hidden');
    loadVinStickerInventory();
  } else {
    upsell.classList.remove('hidden');
    active.classList.add('hidden');
  }
}

function renderInvIntelSidebar(cfg) {
  const badge = document.getElementById('inv-intel-badge');
  const inactive = document.getElementById('inv-intel-sidebar-inactive');
  const activeEl = document.getElementById('inv-intel-sidebar-active');
  if (!badge || !inactive || !activeEl) return;

  if (__invIntelActive) {
    const trialEnd = cfg?.inv_intel_trial_ends_at;
    const inTrial = trialEnd && new Date(trialEnd) > new Date();
    badge.textContent = inTrial ? 'Trial' : 'Active';
    badge.className = `text-[9px] font-black uppercase px-1.5 py-0.5 rounded-full ${inTrial ? 'bg-violet-600 text-white' : 'bg-emerald-600 text-white'}`;
    badge.classList.remove('hidden');
    inactive.classList.add('hidden');
    activeEl.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
    inactive.classList.remove('hidden');
    activeEl.classList.add('hidden');
  }
}

function loadInvIntelPage() {
  const upsell = document.getElementById('inv-intel-page-upsell');
  const active = document.getElementById('inv-intel-active-content');
  if (!upsell || !active) return;

  if (__invIntelActive) {
    upsell.classList.add('hidden');
    active.classList.remove('hidden');
    if (typeof window._loadIntel === 'function') window._loadIntel();
    loadStockingRecommendations(false);
    loadMarketcheckStatus();
    loadAIActivity();   // Inventory Scan now lives on this page
    loadLotOverview();  // Your Lot at a Glance
    loadDigestToggle(); // Daily briefing email opt-in
  } else {
    upsell.classList.remove('hidden');
    active.classList.add('hidden');
  }
}

// Show whether the licensed MarketCheck feed is connected & live, so the dealer can
// tell at a glance that pricing/competitor data is using real data (not the scraper).
async function loadMarketcheckStatus() {
  const el = document.getElementById('marketcheck-status');
  if (!el) return;
  let s;
  try {
    const r = await fetch(`${API}/ai/marketcheck-status`, { headers: { 'Authorization': `Bearer ${token}` } });
    s = await r.json();
  } catch { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  const dot = (c) => `<span class="w-2 h-2 rounded-full ${c} flex-shrink-0"></span>`;
  if (!s.configured) {
    el.className = 'text-xs font-semibold px-3 py-2 rounded-lg border flex items-center gap-2 bg-amber-50 dark:bg-amber-950/30 border-amber-200 dark:border-amber-900 text-amber-800 dark:text-amber-200';
    el.innerHTML = `${dot('bg-amber-500')} MarketCheck not connected — pricing & competitor data fall back to an AI estimate. Add MARKETCHECK_API_KEY in your Render backend environment for live market data.`;
  } else if (s.ok) {
    el.className = 'text-xs font-semibold px-3 py-2 rounded-lg border flex items-center gap-2 bg-emerald-50 dark:bg-emerald-950/30 border-emerald-200 dark:border-emerald-900 text-emerald-800 dark:text-emerald-200';
    el.innerHTML = `${dot('bg-emerald-500')} MarketCheck connected — live market data is active${s.sample_found ? ` (test query returned ${Number(s.sample_found).toLocaleString()} comps)` : ''}.`;
  } else {
    el.className = 'text-xs font-semibold px-3 py-2 rounded-lg border flex items-center gap-2 bg-red-50 dark:bg-red-950/30 border-red-200 dark:border-red-900 text-red-800 dark:text-red-200';
    el.innerHTML = `${dot('bg-red-500')} MarketCheck key is set but the test call failed${s.status ? ` (HTTP ${s.status})` : ''}. Check the key or your plan/endpoint access.`;
  }
}

async function startInvIntelCheckout() {
  const btn = document.getElementById('inv-intel-page-upgrade-btn');
  if (!btn) return;
  btn.disabled = true;
  btn.textContent = 'Opening checkout…';
  try {
    const res = await fetch(`${API}/billing/subscribe-inv-intel`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` },
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed');
    window.location.href = data.url;
  } catch (e) {
    alert(e.message);
    btn.disabled = false;
    btn.textContent = 'Start 30-Day Free Trial';
  }
}

function setupInvIntelListeners() {
  document.getElementById('inv-intel-page-upgrade-btn')?.addEventListener('click', startInvIntelCheckout);
  document.getElementById('inv-intel-upgrade-btn')?.addEventListener('click', startInvIntelCheckout);
  document.getElementById('inv-intel-goto-page-btn')?.addEventListener('click', () => switchPage('inv-intel'));
}

// ── AI Vision ──────────────────────────────────────────────────────────────
function renderAiVisionNav() {
  const btn = document.getElementById('nav-ai-vision');
  if (!btn) return;
  const isAdmin = profileContext?.role === 'DEALER_ADMIN' || profileContext?.role === 'OWNER' || profileContext?.role === 'MANAGER';
  if (!isAdmin) { btn.classList.add('hidden'); return; }
  btn.classList.remove('hidden');
  btn.classList.add('text-slate-700', 'dark:text-slate-300', 'hover:bg-slate-100', 'dark:hover:bg-slate-800');
  document.getElementById('nav-ai-vision-pill')?.classList.toggle('hidden', __aiVisionActive);
  if (!btn._clickWired) { btn._clickWired = true; btn.addEventListener('click', () => switchPage('ai-vision')); }
}

// AI Vision is part of AI Boost — open the AI Boost purchase modal to subscribe.
function startAiVisionCheckout() {
  openUpgradeModal('ai_boost');
}

function scoreColor(s) {
  if (s >= 75) return 'text-emerald-600 dark:text-emerald-400';
  if (s >= 50) return 'text-amber-600 dark:text-amber-400';
  return 'text-red-600 dark:text-red-400';
}

function renderAiVisionResults(data) {
  const stats = document.getElementById('ai-vision-stats');
  const list = document.getElementById('ai-vision-list');
  if (!stats || !list) return;
  const s = data.summary || {};
  const tile = (label, val, cls = '') => `
    <div class="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg px-4 py-3">
      <div class="text-[10px] uppercase font-bold tracking-wider text-slate-400">${label}</div>
      <div class="text-xl font-black mt-0.5 ${cls}">${val}</div>
    </div>`;
  stats.innerHTML = [
    tile('Avg photo score', s.avg_score != null ? `${s.avg_score}` : '—', s.avg_score != null ? scoreColor(s.avg_score) : ''),
    tile('Need attention', s.needs_attention ?? 0, 'text-red-600 dark:text-red-400'),
    tile('No photos', s.no_photos ?? 0, (s.no_photos ? 'text-red-600 dark:text-red-400' : '')),
    tile('Scanned', `${s.scored ?? 0}/${s.total ?? 0}`),
  ].join('');

  const vehicles = data.vehicles || [];
  if (!vehicles.length) {
    list.innerHTML = '<div class="px-5 py-10 text-center text-sm text-slate-400 italic">No scored listings yet — run a scan.</div>';
    return;
  }
  list.innerHTML = vehicles.map(v => {
    const flags = (v.flags || []).map(f => `<span class="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-red-50 dark:bg-red-950/40 text-red-600 dark:text-red-400">${esc(f)}</span>`).join(' ');
    const thumb = v.thumb
      ? `<img src="${esc(v.thumb)}" alt="" class="w-14 h-14 rounded object-cover flex-shrink-0 bg-slate-100 dark:bg-slate-800">`
      : `<div class="w-14 h-14 rounded bg-slate-100 dark:bg-slate-800 flex items-center justify-center text-slate-400 text-lg flex-shrink-0">🚗</div>`;
    return `
      <div class="px-5 py-3.5 flex items-center gap-3.5">
        ${thumb}
        <div class="flex-1 min-w-0">
          <div class="text-sm font-semibold text-slate-900 dark:text-white truncate">${esc(v.label)}${v.stocknumber ? ` <span class="text-slate-400 font-normal">· #${esc(v.stocknumber)}</span>` : ''}</div>
          <div class="text-xs text-slate-400 mt-0.5">${v.photo_count} photo${v.photo_count === 1 ? '' : 's'}</div>
          ${flags ? `<div class="flex flex-wrap gap-1 mt-1.5">${flags}</div>` : ''}
        </div>
        <div class="text-right flex-shrink-0">
          <div class="text-2xl font-black ${scoreColor(v.score)}">${v.score}</div>
          <div class="text-[10px] uppercase font-bold tracking-wider text-slate-400">/100</div>
        </div>
      </div>`;
  }).join('');
}

async function loadAiVisionResults() {
  try {
    const res = await fetch(`${API}/ai/vision/results`, { headers: { 'Authorization': `Bearer ${token}` } });
    if (!res.ok) return;
    renderAiVisionResults(await res.json());
  } catch {}
}

let __aiVisionScanning = false;
// "Score photos" button inside Vehicle Health Scores — runs the same AI Vision scan
// and refreshes the health table so the new photo grades show inline (no separate page).
document.addEventListener('DOMContentLoaded', () => {
  const b = document.getElementById('health-score-photos-btn');
  if (!b) return;
  b.addEventListener('click', async () => {
    if (b._busy) return;
    b._busy = true; b.disabled = true;
    const orig = b.textContent; b.textContent = 'Scoring photos…';
    try {
      const res = await fetch(`${API}/ai/vision/scan`, { method: 'POST', headers: { 'Authorization': `Bearer ${token}` } });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Scan failed');
      const total = data.total || 0;
      if (!total) { showToast('All photos are already scored.', 'info'); }
      else { showToast(`Scoring photos on ${total} listing${total === 1 ? '' : 's'} — refresh in a moment to see grades fill in.`, 'info', 6000); }
      try { if (typeof loadIntel === 'function') await loadIntel(true); } catch {}
      // Refresh again after the background batch has had time to run.
      if (total > (data.scored_now || 0)) setTimeout(() => { try { loadIntel(true); } catch {} }, 20000);
    } catch (e) {
      showToast(e.message, 'error');
    } finally {
      b._busy = false; b.disabled = false; b.textContent = orig;
    }
  });
});

async function runAiVisionScan() {
  const btn = document.getElementById('ai-vision-scan-btn');
  if (!btn || __aiVisionScanning) return;
  __aiVisionScanning = true;
  btn.disabled = true;
  const orig = btn.innerHTML;
  btn.textContent = 'Scanning…';
  try {
    const res = await fetch(`${API}/ai/vision/scan`, {
      method: 'POST', headers: { 'Authorization': `Bearer ${token}` },
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Scan failed');
    const total = data.total || 0;
    if (!total) { showToast('All photos are already scored — nothing new to scan.', 'info'); await loadAiVisionResults(); return; }
    // The first few were scored synchronously — show them right away.
    await loadAiVisionResults();
    if (total <= (data.scored_now || 0)) { showToast(`Scored ${total} listing${total === 1 ? '' : 's'}.`, 'info'); return; }
    showToast(`Scanning photos on ${total} listing${total === 1 ? '' : 's'} — the rest fills in over the next couple of minutes.`, 'info', 6000);
    // Poll results for ~2 min as the background scan fills in scores.
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 6000));
      await loadAiVisionResults();
    }
  } catch (e) {
    showToast(e.message, 'error');
  } finally {
    __aiVisionScanning = false;
    btn.disabled = false;
    btn.innerHTML = orig;
  }
}

function loadAiVisionPage() {
  const upsell = document.getElementById('ai-vision-page-upsell');
  const active = document.getElementById('ai-vision-active-content');
  if (!upsell || !active) return;
  if (__aiVisionActive) {
    upsell.classList.add('hidden');
    active.classList.remove('hidden');
    loadAiVisionResults();
  } else {
    upsell.classList.remove('hidden');
    active.classList.add('hidden');
  }
}

function setupAiVisionListeners() {
  document.getElementById('ai-vision-upgrade-btn')?.addEventListener('click', startAiVisionCheckout);
  document.getElementById('ai-vision-scan-btn')?.addEventListener('click', runAiVisionScan);
}

async function loadVinStickerInventory() {
  const loading = document.getElementById('vin-sticker-inventory-loading');
  const empty = document.getElementById('vin-sticker-inventory-empty');
  const list = document.getElementById('vin-sticker-inventory-list');
  const token = localStorage.getItem('token');
  try {
    const res = await fetch(`${API}/inventory/all`, { headers: { 'Authorization': `Bearer ${token}` } });
    const vehicles = await res.json();
    if (!res.ok) throw new Error(vehicles?.error || `HTTP ${res.status}`);
    loading.classList.add('hidden');
    if (!vehicles.length) { empty.classList.remove('hidden'); return; }

    list.innerHTML = vehicles.map(v => {
      const label   = [v.year, v.make, v.model, v.trim].filter(Boolean).join(' ');
      const price   = v.price   ? `$${Number(v.price).toLocaleString()}` : 'No price';
      const mileage = v.mileage ? `${Number(v.mileage).toLocaleString()} km` : (v.condition === 'new' ? 'New' : '');
      const cap     = s => s ? s.charAt(0).toUpperCase() + s.slice(1) : '';

      const recallBadge = v.recalls?.length
        ? `<span class="inline-flex items-center gap-1 text-xs font-bold text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800 rounded px-1.5 py-0.5">⚠ ${v.recalls.length} recall${v.recalls.length > 1 ? 's' : ''}</span>`
        : (v.recalls_checked_at ? `<span class="inline-flex items-center gap-1 text-xs font-medium text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800 rounded px-1.5 py-0.5">✓ No recalls</span>` : '');

      const hasVin      = !!(v.vin_data);
      const hasSticker  = !!(v.window_sticker_oem_url || v.window_sticker_gen_url || v.window_sticker_url);
      const hasBrochure = !!(v.brochure_oem_url || v.brochure_gen_url || v.brochure_url);
      const allDone     = hasVin && hasSticker && hasBrochure;

      const statusDot = allDone
        ? `<div class="w-1.5 self-stretch rounded-full bg-purple-500 flex-shrink-0" title="VIN decoded · Sticker · Brochure — all complete"></div>`
        : hasSticker
          ? `<div class="w-1.5 self-stretch rounded-full bg-emerald-500 flex-shrink-0" title="Window sticker generated"></div>`
          : `<div class="w-1.5 self-stretch rounded-full bg-slate-200 dark:bg-slate-700 flex-shrink-0"></div>`;

      const cardBg = allDone
        ? 'bg-purple-50/40 dark:bg-purple-950/10'
        : hasSticker
          ? 'bg-emerald-50/40 dark:bg-emerald-950/10'
          : '';

      // Status communicated via action button states — no separate badge row needed

      // Spec detail is available in the VIN Decode modal, so we keep the card
      // clean and don't repeat it here.
      const chips = '';

      const vinBtnCls = hasVin
        ? 'bg-emerald-50 dark:bg-emerald-900/40 hover:bg-emerald-100 dark:hover:bg-emerald-800/60 border border-emerald-300 dark:border-emerald-700 text-emerald-700 dark:text-emerald-300'
        : 'bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300';
      const vinBtnLabel = hasVin ? `&#10003; VIN` : `VIN`;
      const decodeBtn = `<button class="vs-decode-btn text-xs ${vinBtnCls} px-3 py-1.5 rounded-lg transition font-semibold" data-id="${v.id}" data-vin="${v.vin || ''}">${vinBtnLabel}</button>`;

      const stickerBtnCls   = hasSticker ? 'bg-emerald-600 hover:bg-emerald-500' : 'bg-emerald-600 hover:bg-emerald-500';
      const stickerBtnLabel = hasSticker ? `&#10003; Sticker` : `Sticker`;
      const brochureBtnCls  = hasBrochure ? 'bg-indigo-500 hover:bg-indigo-400' : 'bg-indigo-600 hover:bg-indigo-500';
      const brochureBtnLabel = hasBrochure ? `&#10003; Brochure` : `Brochure`;

      const thumbUrl = v.image_urls?.[0] || null;
      const thumbHtml = thumbUrl
        ? `<div class="flex-shrink-0 w-24 h-16 bg-slate-900 dark:bg-slate-950 overflow-hidden rounded-sm self-center"><img src="${thumbUrl}" alt="" class="w-full h-full object-contain" loading="lazy"></div>`
        : `<div class="flex-shrink-0 w-24 h-16 bg-slate-100 dark:bg-slate-800 rounded-sm self-center flex items-center justify-center"><span class="text-slate-400 dark:text-slate-600 text-xs">No photo</span></div>`;

      return `<li class="flex gap-0 border-b border-slate-100 dark:border-slate-800 last:border-0 ${cardBg}">
        ${statusDot}
        <div class="flex-1 px-3 py-3">
          <div class="flex gap-3 items-start">
            ${thumbHtml}
            <div class="flex-1 min-w-0 flex flex-col sm:flex-row sm:items-start gap-2">
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2 flex-wrap">
                <span class="text-sm font-bold text-slate-900 dark:text-white">${label}</span>
                ${v.stocknumber ? `<span class="text-xs font-mono text-slate-400 dark:text-slate-500">#${v.stocknumber}</span>` : ''}
                ${recallBadge}
              </div>
              <div class="flex items-center gap-2 mt-0.5 text-xs text-slate-500 dark:text-slate-400 flex-wrap">
                <span class="font-semibold text-slate-700 dark:text-slate-200">${price}</span>
                ${mileage ? `<span>· ${mileage}</span>` : ''}
                ${v.vin ? `<span class="font-mono text-slate-400 dark:text-slate-500">${v.vin}</span>` : ''}
              </div>
              ${chips ? `<div class="flex flex-wrap gap-1 mt-1.5">${chips}</div>` : ''}
            </div>
            <div class="flex gap-2 flex-shrink-0 items-start pt-0.5">
              ${decodeBtn}
              <button class="vs-sticker-btn text-xs bg-emerald-600 hover:bg-emerald-500 text-white px-3 py-1.5 rounded-lg transition font-bold" data-id="${v.id}" data-label="${label.replace(/"/g, '&quot;')}" data-oem-url="${v.window_sticker_oem_url || ''}" data-gen-url="${v.window_sticker_gen_url || ''}">${stickerBtnLabel} ▾</button>
              <button class="vs-brochure-btn text-xs ${brochureBtnCls} text-white px-3 py-1.5 rounded-lg transition font-bold" data-id="${v.id}" data-label="${label.replace(/"/g, '&quot;')}" data-oem-url="${v.brochure_oem_url || ''}" data-gen-url="${v.brochure_gen_url || ''}">${brochureBtnLabel} ▾</button>
            </div>
            </div>
          </div>
        </div>
      </li>`;
    }).join('');
    list.classList.remove('hidden');

    list.querySelectorAll('.vs-decode-btn').forEach(btn => {
      btn.addEventListener('click', () => openVinDecode(btn.dataset.id, btn.dataset.vin));
    });
    list.querySelectorAll('.vs-sticker-btn').forEach(btn => {
      btn.addEventListener('click', () => showStickerChoice(btn));
    });
    list.querySelectorAll('.vs-brochure-btn').forEach(btn => {
      btn.addEventListener('click', () => showBrochureChoice(btn));
    });
  } catch {
    loading.textContent = 'Failed to load inventory.';
  }
}

// Sticker button → small popup letting the user pick the factory (OEM) window
// sticker or an AI-generated MarketSync dealer sticker. The Brochure button just
// generates a brochure directly (no popup).
function showStickerChoice(btn) {
  const id = btn.dataset.id;
  const label = btn.dataset.label || 'this vehicle';
  const oemUrl = btn.dataset.oemUrl || '';
  const genUrl = btn.dataset.genUrl || '';
  const savedTag = '<span class="text-[10px] font-bold uppercase bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300 px-1.5 py-0.5 rounded">Saved</span>';
  document.getElementById('sticker-choice-modal')?.remove();
  const modal = document.createElement('div');
  modal.id = 'sticker-choice-modal';
  modal.className = 'fixed inset-0 z-[60] bg-black/60 flex items-center justify-center p-4';
  modal.innerHTML = `
    <div class="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl w-full max-w-sm p-6 shadow-2xl">
      <h3 class="text-base font-bold text-slate-900 dark:text-white mb-1">Window Sticker</h3>
      <p class="text-xs text-slate-500 dark:text-slate-400 mb-4 truncate" title="${label}">${label} — OEM &amp; AI stickers save separately.</p>
      <div class="space-y-2.5">
        <button data-choice="oem" class="w-full text-left px-4 py-3 rounded-lg border border-slate-200 dark:border-slate-700 hover:border-emerald-400 dark:hover:border-emerald-600 hover:bg-emerald-50 dark:hover:bg-emerald-950/30 transition">
          <div class="text-sm font-bold text-slate-900 dark:text-white flex items-center gap-1.5">${oemUrl ? 'View OEM Sticker' : 'Get OEM Sticker'} ${oemUrl ? savedTag : ''}</div>
          <div class="text-xs text-slate-500 dark:text-slate-400 mt-0.5">${oemUrl ? 'Open your saved factory window sticker.' : 'Pull the authentic factory window sticker for this VIN, when available.'}</div>
        </button>
        <button data-choice="generate" class="w-full text-left px-4 py-3 rounded-lg border border-slate-200 dark:border-slate-700 hover:border-indigo-400 dark:hover:border-indigo-600 hover:bg-indigo-50 dark:hover:bg-indigo-950/30 transition ${__aiDocsActive ? '' : 'opacity-70'}">
          <div class="text-sm font-bold text-slate-900 dark:text-white flex items-center gap-1.5">${genUrl ? 'View Dealer Sticker' : 'Generate Dealer Sticker'} <svg viewBox="0 0 24 24" width="14" height="14" class="inline-block flex-shrink-0" aria-hidden="true"><title>AI Boost feature — included in your plan</title><path d="M12 2.5l2.4 6.6 6.6 2.4-6.6 2.4L12 20.5l-2.4-6.6L3 11.5l6.6-2.4z" fill="#c4b5fd" fill-opacity="0.5" stroke="#6d28d9" stroke-width="1.4" stroke-linejoin="round"/></svg> ${genUrl ? savedTag : (__aiDocsActive ? '' : '<span class="text-[10px] font-bold uppercase bg-violet-100 text-violet-700 dark:bg-violet-950/60 dark:text-violet-300 px-1.5 py-0.5 rounded">AI Boost</span>')}</div>
          <div class="text-xs text-slate-500 dark:text-slate-400 mt-0.5">${genUrl ? 'Open your saved branded sticker, or regenerate.' : 'Build a branded MarketSync window sticker.'}${(!genUrl && !__aiDocsActive) ? ' Included with AI Boost.' : ''}</div>
        </button>
        ${genUrl ? '<button data-choice="regen" class="w-full text-center text-xs font-bold text-indigo-500 hover:text-indigo-400 py-1 transition">↻ Regenerate dealer sticker</button>' : ''}
      </div>
      <button data-choice="cancel" class="mt-4 w-full text-xs font-bold text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 py-1.5 transition">Cancel</button>
    </div>`;
  const close = () => modal.remove();
  modal.addEventListener('click', (e) => {
    if (e.target === modal) return close();
    const choice = e.target.closest('[data-choice]')?.dataset.choice;
    if (!choice) return;
    if ((choice === 'generate' || choice === 'regen') && !__aiDocsActive) { close(); openUpgradeModal('ai_boost'); return; }
    close();
    if (choice === 'oem') { if (oemUrl) window.open(oemUrl, '_blank'); else generatePdf(id, 'window-sticker', btn, { oemOnly: true }); }
    else if (choice === 'generate') { if (genUrl) window.open(genUrl, '_blank'); else generatePdf(id, 'window-sticker', btn, { forceGenerate: true }); }
    else if (choice === 'regen') generatePdf(id, 'window-sticker', btn, { forceGenerate: true });
  });
  document.body.appendChild(modal);
}

async function runVinPageDecode() {
  const vin = (document.getElementById('vin-page-input')?.value || '').trim().toUpperCase();
  if (!vin || vin.length < 11) {
    document.getElementById('vin-page-error').textContent = 'Enter a valid VIN (at least 11 characters).';
    document.getElementById('vin-page-error').classList.remove('hidden');
    return;
  }
  const token = localStorage.getItem('token');
  document.getElementById('vin-page-loading').classList.remove('hidden');
  document.getElementById('vin-page-results').classList.add('hidden');
  document.getElementById('vin-page-error').classList.add('hidden');
  try {
    const res = await fetch(`${API}/vin/decode/${encodeURIComponent(vin)}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Decode failed');
    renderVinPageResults(data);
  } catch (e) {
    document.getElementById('vin-page-error').textContent = e.message;
    document.getElementById('vin-page-error').classList.remove('hidden');
  } finally {
    document.getElementById('vin-page-loading').classList.add('hidden');
  }
}

function renderVinPageResults({ decoded, recalls }) {
  const grid = document.getElementById('vin-page-grid');
  const vd = decoded.vin_data || {};
  const plantStr = [vd.plant_city, vd.plant_state, vd.plant_country].filter(Boolean).join(', ') || null;

  const coreFields = [
    ['Year',         decoded.year],
    ['Make',         decoded.make],
    ['Model',        decoded.model],
    ['Trim',         decoded.trim],
    ['Body Style',   decoded.body_style],
    ['Doors',        decoded.doors],
    ['Fuel Type',    decoded.fuel_type],
    ['Drivetrain',   decoded.drivetrain],
    ['Transmission', decoded.transmission],
    ['Engine',       decoded.engine],
  ].filter(([, v]) => v);

  const extFields = [
    ['Manufacturer',      vd.manufacturer],
    ['Vehicle Type',      vd.vehicle_type],
    ['Series',            vd.series],
    ['Built In',          plantStr],
    ['Plant',             vd.plant_company],
    ['Horsepower',        vd.horsepower ? vd.horsepower + ' HP' : null],
    ['Cylinders',         vd.cylinders],
    ['Displacement',      vd.displacement_l ? vd.displacement_l + 'L' : null],
    ['Displ. (cc)',       vd.displacement_cc ? vd.displacement_cc + 'cc' : null],
    ['Engine Config',     vd.engine_config],
    ['Valve Train',       vd.valve_train],
    ['Turbo',             vd.turbo],
    ['Engine Model',      vd.engine_model],
    ['Engine Mfr',        vd.engine_manufacturer],
    ['Fuel Injection',    vd.fuel_injection],
    ['Alt Fuel',          vd.fuel_type_secondary],
    ['Electrification',   vd.electrification],
    ['Trans Speeds',      vd.transmission_speeds],
    ['Wheel Base',        vd.wheel_base],
    ['Wheel Size (F)',    vd.wheel_size_front],
    ['Wheel Size (R)',    vd.wheel_size_rear],
    ['Wheels',            vd.wheels],
    ['Axles',             vd.axles],
    ['Windows',           vd.windows],
    ['Seat Rows',         vd.seat_rows],
    ['Seats',             vd.seats],
    ['GVWR',              vd.gvwr],
    ['Curb Weight',       vd.curb_weight_lb ? vd.curb_weight_lb + ' lbs' : null],
    ['Brakes',            vd.brake_system],
    ['Steering',          vd.steering_location],
    ['ABS',               vd.abs],
    ['ESC',               vd.esc],
    ['TPMS',              vd.tpms],
    ['Fwd Collision Warn',vd.forward_collision],
    ['Lane Departure',    vd.lane_departure],
    ['Lane Keep',         vd.lane_keep],
    ['Blind Spot Mon',    vd.blind_spot_mon],
    ['Adaptive Cruise',   vd.adaptive_cruise],
    ['Auto Emergency Brk',vd.auto_brake],
    ['Adaptive Hdlts',    vd.adaptive_headlights],
    ['Airbags (Front)',   vd.airbag_front],
    ['Airbags (Side)',    vd.airbag_side],
    ['Airbags (Curtain)', vd.airbag_curtain],
    ['Airbags (Knee)',    vd.airbag_knee],
    ['Keyless Ignition',  vd.keyless_ignition],
    ['SAE Auto Level',    vd.sae_automation],
  ].filter(([, v]) => v);

  const card = (label, value) => `
    <div class="bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg px-3 py-2">
      <div class="text-xs text-slate-400 uppercase tracking-wide">${label}</div>
      <div class="text-sm font-bold text-slate-900 dark:text-white mt-0.5">${value}</div>
    </div>`;

  let html = coreFields.map(([l, v]) => card(l, v)).join('');
  if (extFields.length) {
    html += `<div class="col-span-2 mt-1 pt-2 border-t border-slate-200 dark:border-slate-700 text-xs font-bold text-slate-400 uppercase tracking-widest">Extended Build Data (NHTSA)</div>`;
    html += extFields.map(([l, v]) => card(l, v)).join('');
  }
  grid.innerHTML = html;

  const recallEl = document.getElementById('vin-page-recalls');
  if (recalls?.length) {
    recallEl.innerHTML = `<div class="text-sm font-bold text-red-600 dark:text-red-400 mb-2">⚠ ${recalls.length} Open Recall${recalls.length > 1 ? 's' : ''}</div>` +
      recalls.map(r => `<div class="bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 rounded-lg px-3 py-2 text-xs mb-2">
        <div class="font-bold text-red-700 dark:text-red-400">${r.Component || ''}</div>
        <div class="text-slate-600 dark:text-slate-400 mt-1">${r.Summary || ''}</div>
      </div>`).join('');
    recallEl.classList.remove('hidden');
  } else {
    recallEl.innerHTML = `<div class="text-sm font-medium text-emerald-600 dark:text-emerald-400">✓ No open recalls found</div>`;
    recallEl.classList.remove('hidden');
  }
  document.getElementById('vin-page-results').classList.remove('hidden');
}

// The VIN decoder is part of the Inventory Intelligence tier — send the user there.
async function startVinStickerTrial() {
  switchPage('inv-intel');
}

// Handle return from Stripe Checkout for VIN Sticker
(async () => {
  const params = new URLSearchParams(window.location.search);
  const sessionId = params.get('vin_sticker_session');
  if (!sessionId) return;
  const token = localStorage.getItem('token');
  if (!token) return;
  try {
    const res = await fetch(`${API}/billing/vin-sticker-verify?session_id=${encodeURIComponent(sessionId)}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (res.ok) {
      __vinStickerActive = true;
      history.replaceState({}, '', window.location.pathname);
      switchPage('vin-sticker');
    }
  } catch {}
})();

// Handle return from Stripe Checkout for Inventory Intelligence
(async () => {
  const params = new URLSearchParams(window.location.search);
  const sessionId = params.get('inv_intel_session');
  if (!sessionId) return;
  const tk = localStorage.getItem('token');
  if (!tk) return;
  try {
    const res = await fetch(`${API}/billing/inv-intel-verify?session_id=${encodeURIComponent(sessionId)}`, {
      headers: { 'Authorization': `Bearer ${tk}` }
    });
    if (res.ok) {
      __invIntelActive = true;
      history.replaceState({}, '', window.location.pathname);
      switchPage('inv-intel');
    }
  } catch {}
})();

// Handle return from Stripe Checkout for AI Vision
(async () => {
  const params = new URLSearchParams(window.location.search);
  const sessionId = params.get('ai_vision_session');
  if (!sessionId) return;
  const tk = localStorage.getItem('token');
  if (!tk) return;
  try {
    const res = await fetch(`${API}/billing/ai-vision-verify?session_id=${encodeURIComponent(sessionId)}`, {
      headers: { 'Authorization': `Bearer ${tk}` }
    });
    if (res.ok) {
      __aiVisionActive = true;
      renderAiVisionNav();
      history.replaceState({}, '', window.location.pathname);
      switchPage('ai-vision');
    }
  } catch {}
})();

// ── Profile page: Branding + Tone ──────────────────────────────────────────

let _profBrandingLoaded = false;

function _syncProfBrandSwatch() {
  const p = document.getElementById('prof-brand-primary-hex')?.value || '#1a2e4a';
  const a = document.getElementById('prof-brand-accent-hex')?.value || '#c8a84b';
  document.getElementById('prof-brand-swatch-header')?.style.setProperty('background', p);
  document.getElementById('prof-brand-swatch-accent')?.style.setProperty('background', a);
}

async function loadProfileBranding() {
  // Wire up colour pickers once
  if (!_profBrandingLoaded) {
    _profBrandingLoaded = true;

    const primaryPicker = document.getElementById('prof-brand-primary-color');
    const primaryHex    = document.getElementById('prof-brand-primary-hex');
    const accentPicker  = document.getElementById('prof-brand-accent-color');
    const accentHex     = document.getElementById('prof-brand-accent-hex');

    primaryPicker?.addEventListener('input', () => { if (primaryHex) primaryHex.value = primaryPicker.value; _syncProfBrandSwatch(); });
    primaryHex?.addEventListener('input',   () => { if (/^#[0-9a-fA-F]{6}$/.test(primaryHex.value)) { if (primaryPicker) primaryPicker.value = primaryHex.value; _syncProfBrandSwatch(); } });
    accentPicker?.addEventListener('input', () => { if (accentHex) accentHex.value = accentPicker.value; _syncProfBrandSwatch(); });
    accentHex?.addEventListener('input',   () => { if (/^#[0-9a-fA-F]{6}$/.test(accentHex.value)) { if (accentPicker) accentPicker.value = accentHex.value; _syncProfBrandSwatch(); } });

    document.getElementById('prof-brand-logo-input')?.addEventListener('change', uploadProfileLogo);
    document.getElementById('prof-brand-save-btn')?.addEventListener('click', saveProfileBranding);
  }

  const t = localStorage.getItem('token');
  if (!t) return;

  try {
    // Load branding
    const res = await fetch(`${API}/branding`, { headers: { 'Authorization': `Bearer ${t}` } });
    if (res.ok) {
      const data = await res.json();
      const b = data.branding || {};
      if (b.primary_color) {
        document.getElementById('prof-brand-primary-color').value = b.primary_color;
        document.getElementById('prof-brand-primary-hex').value   = b.primary_color;
      }
      if (b.secondary_color) {
        document.getElementById('prof-brand-accent-color').value = b.secondary_color;
        document.getElementById('prof-brand-accent-hex').value   = b.secondary_color;
      }
      if (b.tagline) document.getElementById('prof-brand-tagline').value = b.tagline;
      const ovEn = document.getElementById('prof-overlay-enabled');
      if (ovEn) ovEn.checked = !!b.overlay_enabled;
      const ovPh = document.getElementById('prof-overlay-phone');
      if (ovPh) ovPh.value = b.overlay_phone || '';
      const ovPos = document.getElementById('prof-overlay-position');
      if (ovPos) ovPos.value = b.overlay_position === 'top' ? 'top' : 'bottom';
      const ovLogo = document.getElementById('prof-overlay-logo');
      if (ovLogo) ovLogo.checked = b.overlay_logo !== false;
      if (b.logo_url) {
        const preview = document.getElementById('prof-brand-logo-preview');
        if (preview) preview.innerHTML = `<img src="${b.logo_url}" class="max-h-16 max-w-full object-contain p-1" alt="logo">`;
      }
      _syncProfBrandSwatch();
    }

    // Load AI tone
    const cfgRes = await fetch(`${API}/ai/config`, { headers: { 'Authorization': `Bearer ${t}` } });
    if (cfgRes.ok) {
      const cfg = await cfgRes.json();
      const toneEl = document.getElementById('prof-ai-tone');
      if (toneEl && cfg.tone) toneEl.value = cfg.tone;
    }
  } catch {}
}

async function uploadProfileLogo() {
  const file = document.getElementById('prof-brand-logo-input').files[0];
  if (!file) return;
  const msg = document.getElementById('prof-brand-save-msg');
  const t = localStorage.getItem('token');
  try {
    const fd = new FormData();
    fd.append('logo', file);
    const res = await fetch(`${API}/branding/logo`, { method: 'POST', headers: { 'Authorization': `Bearer ${t}` }, body: fd });
    const data = await res.json();
    if (data.url) {
      const preview = document.getElementById('prof-brand-logo-preview');
      if (preview) preview.innerHTML = `<img src="${data.url}" class="max-h-16 max-w-full object-contain p-1" alt="logo">`;
    }
    if (msg) { msg.textContent = res.ok ? 'Logo uploaded' : (data.error || 'Upload failed'); msg.className = `text-xs font-medium px-2.5 py-1 rounded-md ${res.ok ? 'text-emerald-700 bg-emerald-50' : 'text-red-700 bg-red-50'}`; msg.classList.remove('hidden'); setTimeout(() => msg.classList.add('hidden'), 3000); }
  } catch { if (msg) { msg.textContent = 'Upload failed'; msg.className = 'text-xs font-medium px-2.5 py-1 rounded-md text-red-700 bg-red-50'; msg.classList.remove('hidden'); } }
}

async function saveProfileBranding() {
  const t = localStorage.getItem('token');
  const msg = document.getElementById('prof-brand-save-msg');
  const tone = document.getElementById('prof-ai-tone')?.value || 'professional';

  // Save branding colours + tagline
  const brandPayload = {
    primary_color:   document.getElementById('prof-brand-primary-hex')?.value || '',
    secondary_color: document.getElementById('prof-brand-accent-hex')?.value || '',
    tagline:         document.getElementById('prof-brand-tagline')?.value || '',
    overlay_enabled:  !!document.getElementById('prof-overlay-enabled')?.checked,
    overlay_phone:    document.getElementById('prof-overlay-phone')?.value || '',
    overlay_position: document.getElementById('prof-overlay-position')?.value || 'bottom',
    overlay_logo:     document.getElementById('prof-overlay-logo')?.checked !== false,
  };
  try {
    const [brandRes, toneRes] = await Promise.all([
      fetch(`${API}/branding`, { method: 'PUT', headers: { 'Authorization': `Bearer ${t}`, 'Content-Type': 'application/json' }, body: JSON.stringify(brandPayload) }),
      fetch(`${API}/ai/config`, { method: 'POST', headers: { 'Authorization': `Bearer ${t}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ tone }) }),
    ]);
    const ok = brandRes.ok && toneRes.ok;
    // Mirror tone into AI Boost settings element if visible
    const aiToneEl = document.getElementById('ai-tone');
    if (aiToneEl) aiToneEl.value = tone;
    if (msg) { msg.textContent = ok ? 'Saved!' : 'Save failed'; msg.className = `text-xs font-medium px-2.5 py-1 rounded-md ${ok ? 'text-emerald-700 bg-emerald-50' : 'text-red-700 bg-red-50'}`; msg.classList.remove('hidden'); setTimeout(() => msg.classList.add('hidden'), 3000); }
  } catch { if (msg) { msg.textContent = 'Save failed'; msg.className = 'text-xs font-medium px-2.5 py-1 rounded-md text-red-700 bg-red-50'; msg.classList.remove('hidden'); } }
}

// ── Repricing Rules ──────────────────────────────────────────────────────────

async function loadRepricingRules() {
  try {
    const res = await fetch(`${API}/ai/repricing-rules`, { headers: { 'Authorization': `Bearer ${token}` } });
    if (!res.ok) return;
    const { rules } = await res.json();
    const enabledEl = document.getElementById('repricing-enabled');
    const daysEl = document.getElementById('repricing-days');
    const dropEl = document.getElementById('repricing-drop-pct');
    const overEl = document.getElementById('repricing-overprice-pct');
    if (enabledEl) enabledEl.checked = !!rules.enabled;
    if (daysEl) daysEl.value = rules.days_on_lot_threshold ?? 45;
    if (dropEl) dropEl.value = rules.price_drop_pct ?? 5;
    if (overEl) overEl.value = rules.overprice_threshold_pct ?? 20;
  } catch {}
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('repricing-save-btn')?.addEventListener('click', async () => {
    const btn = document.getElementById('repricing-save-btn');
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
      const res = await fetch(`${API}/ai/repricing-rules`, {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enabled: document.getElementById('repricing-enabled')?.checked,
          days_on_lot_threshold: Number(document.getElementById('repricing-days')?.value),
          price_drop_pct: Number(document.getElementById('repricing-drop-pct')?.value),
          overprice_threshold_pct: Number(document.getElementById('repricing-overprice-pct')?.value),
        })
      });
      if (!res.ok) throw new Error((await res.json()).error || 'Save failed');
      showToast('Repricing rules saved', 'success');
    } catch (e) { showToast(e.message, 'error'); }
    finally { btn.disabled = false; btn.textContent = 'Save Rules'; }
  });

  document.getElementById('repricing-apply-btn')?.addEventListener('click', async () => {
    const btn = document.getElementById('repricing-apply-btn');
    btn.disabled = true; btn.textContent = 'Applying…';
    try {
      const res = await fetch(`${API}/ai/repricing-apply`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed');
      showToast(`${data.flagged} vehicle${data.flagged !== 1 ? 's' : ''} flagged for repricing`, data.flagged > 0 ? 'info' : 'success');
      if (data.flagged > 0) loadAIActivity();
    } catch (e) { showToast(e.message, 'error'); }
    finally { btn.disabled = false; btn.textContent = 'Apply Rules Now'; }
  });

  // Load rules when the section is first visible. It can start open (default
  // expanded), so load immediately in that case; otherwise wait for the first open.
  const repricingBody = document.getElementById('repricing-days')?.closest('.rounded-xl');
  if (repricingBody) {
    if (repricingBody.classList.contains('ai-accordion-open')) {
      loadRepricingRules();
    } else {
      const repricingObs = new MutationObserver(() => {
        if (repricingBody.classList.contains('ai-accordion-open')) {
          loadRepricingRules();
          repricingObs.disconnect();
        }
      });
      repricingObs.observe(repricingBody, { attributes: true, attributeFilter: ['class'] });
    }
  }
});

// ── Stocking Recommendations ─────────────────────────────────────────────────

const STOCKING_CACHE_KEY = 'ms_stocking_recs';
const STOCKING_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours (matches the server-side cache)

async function loadStockingRecommendations(force = false) {
  const btn = document.getElementById('stocking-generate-btn');
  const results = document.getElementById('stocking-results');
  if (!btn || !results) return;

  // Use cache unless forcing a refresh
  if (!force) {
    try {
      const cached = JSON.parse(localStorage.getItem(STOCKING_CACHE_KEY) || 'null');
      if (cached && Date.now() - cached.ts < STOCKING_CACHE_TTL) {
        renderStockingResults(cached.recs, results);
        return;
      }
    } catch {}
  }

  btn.disabled = true;
  btn.textContent = 'Generating…';
  try {
    const res = await fetch(`${API}/ai/stocking-recommendations${force ? '?refresh=1' : ''}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed');
      const recs = data.recommendations || [];
      if (!recs.length) { showToast('No recommendations generated — add more inventory history.', 'info'); return; }
      try { localStorage.setItem(STOCKING_CACHE_KEY, JSON.stringify({ ts: Date.now(), recs })); } catch {}
      renderStockingResults(recs, results);
      if (force) showToast('Recommendations refreshed', 'success');
    } catch (e) { showToast(e.message, 'error'); }
    finally {
      btn.disabled = false;
      btn.innerHTML = '<svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z"/></svg> Refresh';
    }
}

function renderStockingResults(recs, results) {
  const priorityColors = { high: 'bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300', medium: 'bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300', low: 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400' };
  results.innerHTML = `<div class="max-h-[420px] overflow-y-auto space-y-2 pr-1">${recs.map((r, i) => {
    const units = Array.isArray(r.existing_units) ? r.existing_units.filter(u => u?.id) : [];
    const linksHtml = units.length
      ? `<div class="mt-1.5 flex flex-wrap gap-1.5">${units.map(u => {
          const label = u.stocknumber ? `#${u.stocknumber}` : 'View unit';
          const search = u.stocknumber || u.id;
          return `<a href="#" onclick="switchPage('inventory');document.getElementById('catalog-search').value='${search}';renderCatalog();return false;" class="text-[10px] font-semibold text-sky-600 dark:text-sky-400 hover:underline">${label} →</a>`;
        }).join('')}</div>`
      : '';
    return `<div class="bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg px-4 py-3">
      <div class="flex items-start justify-between gap-2">
        <div class="min-w-0 flex items-start gap-2.5">
          <span class="text-xs font-black text-slate-400 mt-0.5 w-4 text-right flex-shrink-0">${i + 1}</span>
          <div class="min-w-0">
            <div class="text-sm font-bold text-slate-900 dark:text-white">${r.make} ${r.model} <span class="font-normal text-slate-500">${r.year_range || ''}</span></div>
            <div class="text-xs text-slate-500 dark:text-slate-400 mt-1 leading-relaxed">${r.reason}</div>
            ${linksHtml}
          </div>
        </div>
        <span class="flex-shrink-0 text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full ${priorityColors[r.priority] || priorityColors.low}">${r.priority}</span>
      </div>
    </div>`;
  }).join('')}</div>`;
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('stocking-generate-btn')?.addEventListener('click', () => loadStockingRecommendations(true));
  // Auto-load (cache-first) the first time the section scrolls into view, so it's
  // always populated without the user having to hit Refresh. Firing on visibility
  // (rather than page load) avoids an API call for users who never open Inv Intel.
  const stockingEl = document.getElementById('stocking-accordion');
  if (stockingEl && 'IntersectionObserver' in window) {
    let stockingLoaded = false;
    const io = new IntersectionObserver((entries) => {
      if (!stockingLoaded && entries.some(e => e.isIntersecting)) {
        stockingLoaded = true;
        loadStockingRecommendations(false);
        io.disconnect();
      }
    }, { threshold: 0.1 });
    io.observe(stockingEl);
  }
});

// ── Competitor Monitoring ─────────────────────────────────────────────────────

async function loadCompetitors() {
  const listEl = document.getElementById('competitors-list');
  const loadingEl = document.getElementById('competitors-loading');
  if (!listEl) return;
  let competitors;
  try {
    const data = await apiGetJson('/ai/competitors', { onRetry: () => {
      if (loadingEl) loadingEl.textContent = 'Still loading…';
    }});
    competitors = data.competitors || [];
  } catch (e) {
    // Always clear the spinner and offer a retry — a silent return here is what
    // left "Loading…" hanging forever.
    if (loadingEl) loadingEl.remove();
    listEl.innerHTML = `<div class="text-xs text-slate-500 dark:text-slate-400">Couldn't load competitors: ${esc(e.message)} <button onclick="loadCompetitors()" class="text-indigo-500 hover:text-indigo-400 font-bold ml-1">Retry</button></div>`;
    return;
  }
  try {
    if (loadingEl) loadingEl.remove();
    if (!competitors.length) {
      listEl.innerHTML = '<div class="text-xs text-slate-400 italic">No competitors added yet.</div>';
      return;
    }
    listEl.innerHTML = competitors.map(c => {
      const sr = c.last_scan_result || {};
      const scannedAt = c.last_scanned_at ? new Date(c.last_scanned_at).toLocaleDateString() : 'Never scanned';
      const hasData = sr.listing_count != null || sr.avg_price != null;
      const count = sr.listing_count != null ? `${sr.listing_count} listings` : '—';
      const priceRange = sr.min_price && sr.max_price ? `$${Number(sr.min_price).toLocaleString()} – $${Number(sr.max_price).toLocaleString()}` : '—';
      const platformBadge = sr.platform ? `<span class="text-[10px] text-indigo-400 font-semibold ml-1">(${sr.platform})</span>` : '';
      const isBlocked = sr.error && /WAF|bot|block|protect/i.test(sr.error);
      const atQuery = encodeURIComponent(c.name + ' Ontario');
      const atSearchUrl = `https://www.autotrader.ca/dealers/?search=${atQuery}`;
      const errorLine = sr.error
        ? isBlocked
          ? `<div class="text-xs text-amber-500 mt-1 leading-snug">Couldn't read this site — no public sitemap and the page is bot-protected. For pricing detail, paste their AutoTrader or CarGurus dealer page below.</div>
            <div class="mt-2 flex gap-1.5 competitor-url-edit hidden" id="url-edit-${c.id}">
              <input type="url" placeholder="AutoTrader, CarGurus, or dealer URL…" class="flex-1 text-xs border border-slate-300 dark:border-slate-600 rounded px-2 py-1 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-200" id="url-input-${c.id}" value="${c.autotrader_url || ''}">
              <button class="competitor-url-save-btn text-xs bg-indigo-600 hover:bg-indigo-500 text-white px-2 py-1 rounded font-semibold" data-id="${c.id}">Save</button>
            </div>`
          : `<div class="text-xs text-amber-500 mt-1 leading-snug">⚠ ${sr.error}</div>`
        : '';
      return `<div class="bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg px-3 py-2.5" data-competitor-id="${c.id}">
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0 flex-1">
            <div class="text-sm font-semibold text-slate-800 dark:text-slate-200 truncate">${c.name}</div>
            <div class="text-xs text-slate-400 mt-0.5">${scannedAt}${hasData ? ` · ${count} · ${priceRange}` : ''}${platformBadge}</div>
            ${c.autotrader_url ? `<a href="${c.autotrader_url}" target="_blank" rel="noopener" class="text-xs text-indigo-500 hover:underline truncate block max-w-xs">${c.autotrader_url}</a>` : '<span class="text-xs text-slate-400">No URL set</span>'}
            ${errorLine}
          </div>
          <div class="flex items-center gap-2 flex-shrink-0">
            ${isBlocked ? `<button class="competitor-url-toggle-btn text-xs text-indigo-500 hover:text-indigo-700 font-semibold" data-id="${c.id}">Update URL</button>` : ''}
            <button class="competitor-delete-btn text-red-400 hover:text-red-600 transition" data-id="${c.id}" title="Remove">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>
            </button>
          </div>
        </div>
      </div>`;
    }).join('');

    listEl.querySelectorAll('.competitor-url-toggle-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const editRow = document.getElementById(`url-edit-${btn.dataset.id}`);
        if (editRow) editRow.classList.toggle('hidden');
      });
    });

    listEl.querySelectorAll('.competitor-url-save-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const input = document.getElementById(`url-input-${btn.dataset.id}`);
        const newUrl = input?.value.trim();
        if (!newUrl) return;
        btn.textContent = 'Saving…'; btn.disabled = true;
        try {
          const res = await fetch(`${API}/ai/competitors/${btn.dataset.id}`, {
            method: 'PATCH',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ autotrader_url: newUrl })
          });
          if (!res.ok) throw new Error((await res.json()).error);
          showToast('URL updated — run Scan All to refresh', 'success');
          loadCompetitors();
        } catch (e) { showToast(e.message, 'error'); btn.textContent = 'Save'; btn.disabled = false; }
      });
    });

    listEl.querySelectorAll('.competitor-delete-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Remove this competitor?')) return;
        try {
          const res = await fetch(`${API}/ai/competitors/${btn.dataset.id}`, { method: 'DELETE', headers: { 'Authorization': `Bearer ${token}` } });
          if (!res.ok) throw new Error((await res.json()).error);
          loadCompetitors();
          showToast('Competitor removed', 'success');
        } catch (e) { showToast(e.message, 'error'); }
      });
    });
  } catch {}
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('competitor-add-btn')?.addEventListener('click', async () => {
    const name = document.getElementById('competitor-name-input')?.value.trim();
    const url = document.getElementById('competitor-url-input')?.value.trim();
    if (!name) { showToast('Dealership name required', 'error'); return; }
    try {
      const res = await fetch(`${API}/ai/competitors`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, autotrader_url: url || null })
      });
      if (!res.ok) throw new Error((await res.json()).error || 'Failed');
      document.getElementById('competitor-name-input').value = '';
      document.getElementById('competitor-url-input').value = '';
      loadCompetitors();
      showToast('Competitor added', 'success');
    } catch (e) { showToast(e.message, 'error'); }
  });

  document.getElementById('competitors-scan-btn')?.addEventListener('click', async () => {
    const btn = document.getElementById('competitors-scan-btn');
    const compPanel = document.getElementById('competitor-comparison');
    btn.disabled = true; btn.textContent = 'Scanning…';
    compPanel?.classList.add('hidden');
    try {
      // Kick off the background scan on its own. Scan returns immediately with
      // { status: 'scanning', total }. One retry for iOS cold-start / dropped
      // connections so a transient network blip doesn't read as "scan failed".
      let scanRes;
      for (let i = 0; i < 2; i++) {
        try {
          scanRes = await fetch(`${API}/ai/competitors/scan`, { method: 'POST', headers: { 'Authorization': `Bearer ${token}` } });
          break;
        } catch (netErr) {
          if (i === 1) throw new Error('Could not reach the server to start the scan. Check your connection and try again.');
          await new Promise(r => setTimeout(r, 2500));
        }
      }
      const scanData = await scanRes.json();
      if (!scanRes.ok) throw new Error(scanData.error || 'Scan failed');

      // Our own lot stats — fetched separately and tolerantly. A failure here
      // must NOT abort the competitor scan (it's only used for the comparison).
      let ourRes = null;
      try { ourRes = await fetch(`${API}/inventory/all`, { headers: { 'Authorization': `Bearer ${token}` } }); }
      catch { ourRes = null; }

      // Poll GET /ai/competitors until all entries have a fresh last_scanned_at
      const total = scanData.total || 1;
      // Backdate 15s: last_scanned_at is stamped with the SERVER clock, scanStarted
      // is the CLIENT clock. If the phone runs ahead, freshly-scanned rows look
      // "older" than start and never count as done — the button sticks on
      // "Scanning 0/N…" for minutes even though the data already landed.
      const scanStarted = Date.now() - 15000;
      let competitors = [];
      btn.textContent = `Scanning 0/${total}…`;
      for (let attempt = 0; attempt < 40; attempt++) {
        await new Promise(r => setTimeout(r, 7000));
        let pollRes;
        try { pollRes = await fetch(`${API}/ai/competitors`, { headers: { 'Authorization': `Bearer ${token}` } }); }
        catch { continue; } // network/CORS during cold-start — keep waiting
        if (!pollRes.ok) continue;
        const pollData = await pollRes.json();
        competitors = pollData.competitors || [];
        const done = competitors.filter(c => c.last_scanned_at && new Date(c.last_scanned_at) > new Date(scanStarted)).length;
        btn.textContent = `Scanning ${done}/${total}…`;
        if (done >= total) break;
      }

      // Build comparison using freshly-scanned competitor data
      const scanDataFinal = { results: competitors.map(c => ({ id: c.id, name: c.name, result: c.last_scan_result })) };

      // Build our lot stats from available inventory
      const ourVehicles = (ourRes && ourRes.ok) ? (await ourRes.json()).filter(v => v.status === 'available' && v.price > 0) : [];
      const ourPrices = ourVehicles.map(v => Number(v.price)).filter(p => p > 0).sort((a, b) => a - b);
      const ourAvg = ourPrices.length ? Math.round(ourPrices.reduce((a, b) => a + b, 0) / ourPrices.length) : null;
      const ourMin = ourPrices[0] || null;
      const ourMax = ourPrices[ourPrices.length - 1] || null;
      const ourCount = ourVehicles.length;

      const results = (scanDataFinal.results || []).filter(r => r.result && !r.result.error);
      if (results.length && compPanel) {
        const fmt = n => n != null ? `$${Number(n).toLocaleString()}` : '—';
        const pct = (a, b) => (a != null && b != null && b !== 0) ? Math.round(((a - b) / b) * 100) : null;

        const rows = results.map(r => {
          const s = r.result;
          const avgDiff = pct(s.avg_price, ourAvg);
          const flags = [];
          if (avgDiff != null && avgDiff < -5) flags.push(`<span class="text-amber-500 font-semibold">⚠ Avg price ${Math.abs(avgDiff)}% below yours</span>`);
          if (avgDiff != null && avgDiff > 10) flags.push(`<span class="text-emerald-500 font-semibold">✓ You're priced ${avgDiff}% cheaper on avg</span>`);
          if (s.listing_count != null && ourCount > 0 && s.listing_count > ourCount * 1.5) flags.push(`<span class="text-amber-500 font-semibold">⚠ They have ${s.listing_count - ourCount} more units</span>`);
          if (s.min_price != null && ourMin != null && s.min_price < ourMin * 0.9) flags.push(`<span class="text-amber-500 font-semibold">⚠ Their lowest price is ${fmt(s.min_price)} vs your ${fmt(ourMin)}</span>`);

          return `
            <div class="bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 rounded-lg overflow-hidden">
              <div class="px-4 py-2.5 border-b border-slate-200 dark:border-slate-700 font-bold text-sm text-slate-900 dark:text-white">${r.name}</div>
              <div class="grid grid-cols-2 divide-x divide-slate-200 dark:divide-slate-700">
                <div class="px-4 py-3 space-y-2">
                  <div class="text-[10px] uppercase font-bold tracking-wider text-slate-400">Your Lot</div>
                  <div class="text-xs text-slate-700 dark:text-slate-300 space-y-1">
                    <div><span class="text-slate-400">Units:</span> <span class="font-semibold">${ourCount}</span></div>
                    <div><span class="text-slate-400">Avg price:</span> <span class="font-semibold">${fmt(ourAvg)}</span></div>
                    <div><span class="text-slate-400">Range:</span> <span class="font-semibold">${fmt(ourMin)} – ${fmt(ourMax)}</span></div>
                  </div>
                </div>
                <div class="px-4 py-3 space-y-2">
                  <div class="text-[10px] uppercase font-bold tracking-wider text-slate-400">${r.name}</div>
                  <div class="text-xs text-slate-700 dark:text-slate-300 space-y-1">
                    <div><span class="text-slate-400">Units:</span> <span class="font-semibold">${s.listing_count ?? '—'}</span></div>
                    <div><span class="text-slate-400">Avg price:</span> <span class="font-semibold">${fmt(s.avg_price)}</span></div>
                    <div><span class="text-slate-400">Range:</span> <span class="font-semibold">${fmt(s.min_price)} – ${fmt(s.max_price)}</span></div>
                  </div>
                </div>
              </div>
              ${flags.length ? `<div class="px-4 py-2.5 border-t border-slate-200 dark:border-slate-700 flex flex-col gap-1 text-xs">${flags.join('')}</div>` : ''}
            </div>`;
        }).join('');

        compPanel.innerHTML = `
          <div class="pt-1">
            <div class="flex items-center justify-between mb-3">
              <div class="text-xs uppercase font-bold tracking-wider text-slate-400">Lot Comparison</div>
              <button id="competitor-pdf-btn" class="flex items-center gap-1.5 text-xs font-bold text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200 transition-colors">
                <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/></svg>
                Download PDF
              </button>
            </div>
            <div class="space-y-3 max-h-[480px] overflow-y-auto pr-1">${rows}</div>
          </div>`;
        compPanel.classList.remove('hidden');
        document.getElementById('competitor-pdf-btn')?.addEventListener('click', () => {
          const panel = document.getElementById('competitor-comparison');
          if (!panel || panel.classList.contains('hidden')) return;
          const inner = panel.querySelector('.space-y-3')?.innerHTML || panel.innerHTML;
          const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Competitor Lot Comparison</title>
<style>
  @media print { .no-print{display:none!important} @page{margin:0.75in} }
  body{font-family:Arial,sans-serif;background:#f8fafc;padding:24px;color:#0f172a}
  .no-print{display:flex;justify-content:flex-end;gap:10px;margin-bottom:16px}
  .no-print button{padding:8px 18px;border-radius:6px;border:none;cursor:pointer;font-weight:700;font-size:13px}
  h1{font-size:18px;font-weight:900;color:#1a2e4a;margin:0 0 4px}
  .sub{font-size:12px;color:#64748b;margin-bottom:20px}
  .card{background:#fff;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;margin-bottom:16px}
  .card-head{background:#1a2e4a;color:#fff;font-weight:700;font-size:14px;padding:10px 14px}
  .grid{display:grid;grid-template-columns:1fr 1fr;border-top:1px solid #e2e8f0}
  .col{padding:14px;font-size:13px}
  .col:first-child{border-right:1px solid #e2e8f0}
  .col-label{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:#64748b;margin-bottom:8px}
  .row{margin-bottom:4px}.row .l{color:#64748b}.row .v{font-weight:700}
  .flags{padding:10px 14px;border-top:1px solid #e2e8f0;font-size:12px}
</style></head><body>
<div class="no-print">
  <button onclick="window.close()" style="background:#f1f5f9;color:#334155">✕ Close</button>
  <button onclick="window.print()" style="background:#1a2e4a;color:#fff">🖨 Print / Save as PDF</button>
</div>
<h1>Competitor Lot Comparison</h1>
<div class="sub">Generated ${new Date().toLocaleDateString('en-CA', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}</div>
${inner}
</body></html>`;
          const blob = new Blob([html], { type: 'text/html' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `competitor-comparison-${new Date().toISOString().slice(0,10)}.html`;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          setTimeout(() => URL.revokeObjectURL(url), 5000);
          showToast('Comparison downloaded — open in browser then Print → Save as PDF', 'success', 5000);
        });
      }

      showToast(`Scanned ${total} competitor${total !== 1 ? 's' : ''}`, 'success');
      loadCompetitors();
    } catch (e) { showToast(e.message, 'error'); }
    finally { btn.disabled = false; btn.innerHTML = '<svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z"/><path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/></svg> Scan All'; }
  });

  // Load competitors when the accordion opens. It can now START open (default
  // expanded), in which case the "class added" observer never fires — so load
  // immediately if it's already open, and otherwise wait for the first open.
  const competitorAccordion = document.getElementById('competitors-list')?.closest('.rounded-xl');
  if (competitorAccordion) {
    if (competitorAccordion.classList.contains('ai-accordion-open')) {
      loadCompetitors();
    } else {
      new MutationObserver((_, obs) => {
        if (competitorAccordion.classList.contains('ai-accordion-open')) {
          loadCompetitors();
          obs.disconnect();
        }
      }).observe(competitorAccordion, { attributes: true, attributeFilter: ['class'] });
    }
  }
});

// ── Weekly Lot Health Report ──────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  const lastSentEl = document.getElementById('weekly-report-last-sent');
  const stored = localStorage.getItem('weekly-report-last-sent');
  if (lastSentEl && stored) lastSentEl.textContent = `Last sent: ${new Date(stored).toLocaleDateString()}`;

  document.getElementById('weekly-report-btn')?.addEventListener('click', async () => {
    const btn = document.getElementById('weekly-report-btn');
    btn.disabled = true; btn.textContent = 'Sending…';
    try {
      const res = await fetch(`${API}/ai/weekly-report`, { method: 'POST', headers: { 'Authorization': `Bearer ${token}` } });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed');
      const now = new Date().toISOString();
      localStorage.setItem('weekly-report-last-sent', now);
      if (lastSentEl) lastSentEl.textContent = `Last sent: ${new Date(now).toLocaleDateString()}`;
      showToast(`Report sent to ${data.recipient}`, 'success', 5000);
    } catch (e) { showToast(e.message, 'error'); }
    finally { btn.disabled = false; btn.innerHTML = '<svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M21.75 6.75v10.5a2.25 2.25 0 01-2.25 2.25h-15a2.25 2.25 0 01-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25m19.5 0v.243a2.25 2.25 0 01-1.07 1.916l-7.5 4.615a2.25 2.25 0 01-2.36 0L3.32 8.91a2.25 2.25 0 01-1.07-1.916V6.75"/></svg> Send Report Now'; }
  });

  // PDF download — opens the report HTML in a new tab with a Print button
  document.getElementById('weekly-report-pdf-btn')?.addEventListener('click', async () => {
    const btn = document.getElementById('weekly-report-pdf-btn');
    btn.disabled = true; btn.textContent = 'Generating…';
    try {
      const res = await fetch(`${API}/ai/weekly-report/html`, { headers: { 'Authorization': `Bearer ${token}` } });
      if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || 'Failed'); }
      const html = await res.text();
      const blob = new Blob([html], { type: 'text/html' });
      const url = URL.createObjectURL(blob);
      const w = window.open(url, '_blank');
      if (w) setTimeout(() => URL.revokeObjectURL(url), 30000);
      else showToast('Pop-up blocked — allow pop-ups and try again', 'error');
    } catch (e) { showToast(e.message, 'error'); }
    finally { btn.disabled = false; btn.innerHTML = '<svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3"/></svg> Download PDF'; }
  });

});

// ── Notification Center ────────────────────────────────────────────────────
;(function() {
  const bell    = document.getElementById('notif-bell')
  const badge   = document.getElementById('notif-badge')
  const panel   = document.getElementById('notif-panel')
  const backdrop = document.getElementById('notif-backdrop')
  const list    = document.getElementById('notif-list')
  const closeBtn = document.getElementById('notif-close')
  const readAllBtn = document.getElementById('notif-read-all')

  if (!bell || !panel) return

  async function authFetch(url, opts = {}) {
    const tk = localStorage.getItem('token')
    const res = await fetch(url, { ...opts, headers: { 'Authorization': `Bearer ${tk}`, ...(opts.headers || {}) } })
    if (!res.ok) throw new Error(res.status)
    return res.json()
  }

  const TYPE_META = {
    aging:        { icon: '⏱', color: 'text-orange-500' },
    price_drift:  { icon: '💰', color: 'text-amber-500' },
    missing_info: { icon: '📷', color: 'text-blue-500' },
    new_arrival:  { icon: '🚗', color: 'text-emerald-500' },
    competitor:   { icon: '🔍', color: 'text-purple-500' },
    billing:      { icon: '💳', color: 'text-indigo-500' },
    weekly_report:{ icon: '📊', color: 'text-slate-500' },
    window_sticker:{ icon: '🪟', color: 'text-cyan-500' },
    brochure:     { icon: '📄', color: 'text-rose-500' },
    email_sent:   { icon: '📧', color: 'text-teal-500' },
    appointment:  { icon: '📅', color: 'text-indigo-500' },
  }

  function timeAgo(iso) {
    const diff = Date.now() - new Date(iso).getTime()
    const m = Math.floor(diff / 60000)
    if (m < 1)  return 'Just now'
    if (m < 60) return `${m}m ago`
    const h = Math.floor(m / 60)
    if (h < 24) return `${h}h ago`
    return `${Math.floor(h / 24)}d ago`
  }

  function renderList(items) {
    if (!items.length) {
      list.innerHTML = '<div class="flex flex-col items-center justify-center h-48 text-slate-400 text-sm gap-2"><span class="text-3xl">🔔</span>No notifications yet</div>'
      return
    }
    list.innerHTML = items.map(n => {
      const meta = TYPE_META[n.type] || { icon: '•', color: 'text-slate-400' }
      return `
        <div class="notif-item flex gap-3 px-5 py-4 hover:bg-slate-50 dark:hover:bg-slate-800/50 transition cursor-pointer ${n.read ? 'opacity-60' : ''}" data-id="${n.id}" data-page="${n.link_page || ''}" data-filter="${n.link_filter || ''}" data-url="${n.link_url || ''}">
          <span class="text-xl mt-0.5 flex-shrink-0">${meta.icon}</span>
          <div class="flex-1 min-w-0">
            <div class="flex items-start justify-between gap-2">
              <p class="text-sm font-semibold text-slate-900 dark:text-white leading-snug ${n.read ? '' : 'font-bold'}">${n.title}</p>
              <span class="text-[10px] text-slate-400 whitespace-nowrap flex-shrink-0 mt-0.5">${timeAgo(n.created_at)}</span>
            </div>
            ${n.body ? `<p class="text-xs text-slate-500 dark:text-slate-400 mt-0.5 leading-snug">${n.body}</p>` : ''}
            ${n.link_url ? `<span class="inline-flex items-center gap-1 mt-1.5 text-[11px] font-semibold text-indigo-600 dark:text-indigo-400">Open PDF
              <svg class="w-3 h-3" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"/></svg>
            </span>` : ''}
          </div>
          ${!n.read ? '<span class="w-2 h-2 rounded-full bg-indigo-500 flex-shrink-0 mt-1.5"></span>' : '<span class="w-2 h-2 flex-shrink-0"></span>'}
        </div>`
    }).join('')

    list.querySelectorAll('.notif-item').forEach(el => {
      el.addEventListener('click', async () => {
        const id   = el.dataset.id
        const page = el.dataset.page
        const filter = el.dataset.filter
        const url  = el.dataset.url
        // Mark read
        await authFetch(`${API}/notifications/${id}/read`, { method: 'POST' }).catch(() => {})
        el.classList.add('opacity-60')
        el.querySelector('span.bg-indigo-500')?.classList.replace('bg-indigo-500', 'bg-transparent')
        updateBadge()
        // External link (e.g. a generated PDF) → open in a new tab.
        if (url) {
          window.open(url, '_blank', 'noopener');
          return;
        }
        // Navigate if page set
        if (page) {
          closePanel()
          switchPage(page)
          if (filter && document.getElementById('catalog-search')) {
            document.getElementById('catalog-search').value = filter
            if (typeof renderCatalog === 'function') renderCatalog()
          }
        }
      })
    })
  }

  let _notifications = []

  async function loadNotifications() {
    try {
      const data = await authFetch(`${API}/notifications`)
      _notifications = Array.isArray(data) ? data : []
      renderList(_notifications)
    } catch {
      list.innerHTML = '<div class="px-5 py-8 text-center text-sm text-slate-400">Could not load notifications.</div>'
    }
  }

  async function updateBadge() {
    try {
      const { count } = await authFetch(`${API}/notifications/unread-count`)
      if (count > 0) {
        badge.textContent = count > 99 ? '99+' : count
        badge.classList.remove('hidden')
      } else {
        badge.classList.add('hidden')
      }
    } catch {}
  }

  function openPanel() {
    panel.classList.remove('hidden')
    document.body.style.overflow = 'hidden'
    loadNotifications()
  }

  function closePanel() {
    panel.classList.add('hidden')
    document.body.style.overflow = ''
    updateBadge()
  }

  bell.addEventListener('click', () => panel.classList.contains('hidden') ? openPanel() : closePanel())
  closeBtn.addEventListener('click', closePanel)
  backdrop.addEventListener('click', closePanel)

  readAllBtn.addEventListener('click', async () => {
    await authFetch(`${API}/notifications/read-all`, { method: 'POST' }).catch(() => {})
    _notifications.forEach(n => n.read = true)
    renderList(_notifications)
    badge.classList.add('hidden')
  })

  // Poll for badge count every 60s after login
  function startPolling() {
    updateBadge()
    setInterval(updateBadge, 60000)
  }

  // Start after auth resolves — wait for API constant to be ready
  const authWait = setInterval(() => {
    if (typeof API !== 'undefined' && localStorage.getItem('token')) {
      clearInterval(authWait)
      startPolling()
    }
  }, 500)
})()

// ── Inventory Intelligence Page ────────────────────────────────────────────
;(function() {
  let _intelData = null
  let _intelLoaded = false

  async function authFetch(url, opts = {}) {
    const tk = localStorage.getItem('token')
    const res = await fetch(url, { ...opts, headers: { 'Authorization': `Bearer ${tk}`, ...(opts.headers || {}) } })
    if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || res.status) }
    return res.json()
  }

  function scoreColor(s) {
    if (s >= 80) return 'text-emerald-600 dark:text-emerald-400'
    if (s >= 60) return 'text-amber-600 dark:text-amber-400'
    return 'text-red-600 dark:text-red-400'
  }

  function scoreBg(s) {
    if (s >= 80) return 'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300'
    if (s >= 60) return 'bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300'
    return 'bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300'
  }

  function supplyColor(mos) {
    if (mos === null) return 'text-slate-400'
    if (mos <= 1.5) return 'text-emerald-600 dark:text-emerald-400 font-bold'
    if (mos <= 3)   return 'text-amber-600 dark:text-amber-400'
    return 'text-red-500 dark:text-red-400'
  }

  function statCard(label, value, sub, accent) {
    return `<div class="bg-white dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 rounded-xl p-4">
      <div class="text-xs font-bold uppercase tracking-wider text-slate-400 mb-1">${label}</div>
      <div class="text-2xl font-black ${accent || 'text-slate-900 dark:text-white'}">${value}</div>
      ${sub ? `<div class="text-xs text-slate-500 mt-0.5">${sub}</div>` : ''}
    </div>`
  }

  function renderIntel(data) {
    const { summary, velocity, hot_segments, cold_segments, duplicate_vins, vehicles } = data

    // Populate module-level caches so renderCatalog can show hot/cold tags and health scores
    __hotMakeModels = new Set(hot_segments.map(s => `${s.make} ${s.model}`.toLowerCase()))
    __coldMakeModels = new Set(cold_segments.map(s => `${s.make} ${s.model}`.toLowerCase()))
    __vehicleHealthScores = Object.fromEntries(vehicles.map(v => [v.id, v.score]))
    if (__hotMakeModels.size > 0 || __coldMakeModels.size > 0) {
      document.getElementById('catalog-segment-pills')?.classList.remove('hidden');
    }

    // Stats
    const sa = summary.avg_score
    document.getElementById('inv-intel-stats').innerHTML = [
      statCard('Total Units', summary.total, 'available'),
      statCard('Avg Health Score', sa + '/100', '', scoreColor(sa)),
      statCard('Need Attention', summary.needs_attention, 'score < 50', summary.needs_attention > 0 ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400'),
      statCard('Duplicate VINs', summary.duplicate_vins, duplicate_vins.length ? 'action required' : 'none found', duplicate_vins.length ? 'text-red-600 dark:text-red-400' : 'text-slate-900 dark:text-white'),
    ].join('')

    // Narrative is loaded async by loadNarrative() — hide until it arrives
    document.getElementById('inv-intel-narrative')?.classList.add('hidden')

    // Hot / Cold segments
    const hotEl = document.getElementById('inv-intel-hot')
    hotEl.innerHTML = hot_segments.length
      ? hot_segments.map((s, i) => `<div class="flex items-center justify-between py-1.5 border-b border-slate-100 dark:border-slate-700 last:border-0">
          <div class="flex items-center gap-2">
            <span class="text-[10px] font-bold text-slate-400 w-4 text-right">${i + 1}</span>
            <span class="font-medium text-slate-900 dark:text-white">${s.make} ${s.model}</span>
          </div>
          <div class="text-right">
            <div class="text-sm font-bold text-emerald-600 dark:text-emerald-400">${s.monthly_velocity}/mo</div>
            <div class="text-sm text-slate-400">${s.current_stock} in stock</div>
          </div>
        </div>`).join('')
      : '<p class="text-slate-400 text-sm">No hot vehicles detected</p>'

    const coldEl = document.getElementById('inv-intel-cold')
    coldEl.innerHTML = cold_segments.length
      ? cold_segments.map((s, i) => `<div class="flex items-center justify-between py-1.5 border-b border-slate-100 dark:border-slate-700 last:border-0">
          <div class="flex items-center gap-2">
            <span class="text-[10px] font-bold text-slate-400 w-4 text-right">${i + 1}</span>
            <span class="font-medium text-slate-900 dark:text-white">${s.make} ${s.model}</span>
          </div>
          <div class="text-right">
            <div class="text-sm font-bold text-red-600 dark:text-red-400">${s.monthly_velocity}/mo sold</div>
            <div class="text-sm text-slate-400">${s.current_stock} units in stock</div>
          </div>
        </div>`).join('')
      : '<p class="text-slate-400 text-sm">No cold vehicles detected</p>'

    // Duplicates
    const dupsWrap = document.getElementById('inv-intel-dups-wrap')
    const dupsEl = document.getElementById('inv-intel-dups')
    if (duplicate_vins.length) {
      dupsEl.innerHTML = duplicate_vins.map(d => `<div class="bg-white dark:bg-slate-800 rounded-lg px-3 py-2">
        <div class="font-mono text-xs font-bold text-red-700 dark:text-red-400 mb-1">VIN: ${d.vin}</div>
        <div class="flex flex-wrap gap-2">${d.units.map(u => `<span class="text-xs bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300 px-2 py-0.5 rounded">${u.year} ${u.make} ${u.model}${u.stock ? ' · ' + u.stock : ''}</span>`).join('')}</div>
      </div>`).join('')
      dupsWrap.classList.remove('hidden')
    } else {
      dupsWrap.classList.add('hidden')
    }

    // Velocity table — wrap parent in scroll container with fade edge
    const velWrap = document.getElementById('inv-intel-velocity-body')?.closest('.overflow-x-auto')
    if (velWrap) {
      velWrap.style.cssText = 'overflow-x:auto;-webkit-overflow-scrolling:touch;position:relative'
      velWrap.parentElement.style.position = 'relative'
    }
    const tbody = document.getElementById('inv-intel-velocity-body')
    tbody.innerHTML = velocity.map(s => `<tr class="hover:bg-slate-50 dark:hover:bg-slate-800/40 transition">
      <td class="px-4 py-2.5 font-medium text-slate-900 dark:text-white whitespace-nowrap">${s.make} ${s.model}</td>
      <td class="px-4 py-2.5 text-right tabular-nums">${s.sold_30d}</td>
      <td class="px-4 py-2.5 text-right tabular-nums font-bold">${s.sold_90d}</td>
      <td class="px-4 py-2.5 text-right tabular-nums">${s.current_stock}</td>
      <td class="px-4 py-2.5 text-right tabular-nums whitespace-nowrap ${supplyColor(s.months_of_supply)}">${s.months_of_supply != null ? s.months_of_supply + ' mo' : '—'}</td>
    </tr>`).join('') || '<tr><td colspan="5" class="px-4 py-6 text-center text-slate-400">No sell-through data yet</td></tr>'

    // Health scores table — with score breakdown sub-row
    const hbody = document.getElementById('inv-intel-health-body')
    hbody.innerHTML = vehicles.map((v, idx) => {
      const b = v.breakdown || {}
      const scoreColor = v.score >= 80 ? '#10b981' : v.score >= 60 ? '#f59e0b' : '#ef4444'
      const issueList = v.issues.length
        ? v.issues.map(i => `<span class="inline-flex text-[10px] bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300 px-1.5 py-0.5 rounded">${i}</span>`).join(' ')
        : '<span class="text-emerald-500 text-xs font-semibold">✓ Good</span>'
      const stockNum = v.stock || v.id?.slice(0, 8) || '—'
      const vehicleLine = [v.year, v.make, v.model, v.trim].filter(Boolean).join(' ')

      // Score bar segments
      const segments = [
        { label: 'Photos',      val: b.photos,      max: 30, icon: '📷' },
        { label: 'Days on lot', val: b.days,         max: 25, icon: '📅' },
        { label: 'Price',       val: b.price,        max: 15, icon: '💰' },
        { label: 'Mileage',     val: b.mileage,      max: 10, icon: '🔢' },
        { label: 'Description', val: b.description,  max: 10, icon: '📝' },
        { label: 'Fields',      val: b.fields,       max: 10, icon: '✅' },
      ].filter(s => s.val != null)

      const breakdownId = `hbd-${idx}`
      const breakdownHtml = `
        <div id="${breakdownId}" class="hidden col-span-5 bg-slate-50 dark:bg-slate-800/60 border-t border-slate-200 dark:border-slate-700 px-6 py-4">
          <div class="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-3">
            ${segments.map(s => {
              const pct = Math.round((s.val / s.max) * 100)
              const barColor = pct >= 80 ? 'bg-emerald-500' : pct >= 50 ? 'bg-amber-400' : 'bg-red-400'
              return `<div>
                <div class="flex justify-between text-[10px] font-semibold text-slate-500 dark:text-slate-400 mb-1">
                  <span>${s.icon} ${s.label}</span><span>${s.val}/${s.max}</span>
                </div>
                <div class="h-1.5 rounded-full bg-slate-200 dark:bg-slate-700">
                  <div class="h-1.5 rounded-full ${barColor}" style="width:${pct}%"></div>
                </div>
              </div>`
            }).join('')}
          </div>
          ${(() => {
            // AI Vision photo quality — folded in here instead of a separate page.
            const flags0 = Array.isArray(v.photo_flags) ? v.photo_flags : [];
            const staleNoPhotos = (v.photos > 0) && flags0.some(f => /no photos/i.test(f));
            if ((v.photo_checked_at == null && v.photo_score == null) || staleNoPhotos) {
              // Never scored, OR scored "no photos" before the photos synced — either
              // way the score is stale. It re-scores automatically on the next sync.
              return `<div class="mb-3 text-[11px] text-slate-400 dark:text-slate-500">AI Vision: photos not scored yet — will score on the next sync, or click “Score photos”.</div>`;
            }
            const ps = Number(v.photo_score || 0);
            const barColor = ps >= 80 ? 'bg-emerald-500' : ps >= 50 ? 'bg-amber-400' : 'bg-red-400';
            const flags = Array.isArray(v.photo_flags) ? v.photo_flags : [];
            return `<div class="mb-3 rounded-lg bg-white dark:bg-slate-900/60 border border-slate-200 dark:border-slate-700 p-2.5">
              <div class="flex justify-between text-[10px] font-semibold text-slate-500 dark:text-slate-400 mb-1">
                <span class="flex items-center gap-1"><svg viewBox="0 0 24 24" width="12" height="12" class="inline-block flex-shrink-0" aria-hidden="true"><path d="M12 2.5l2.4 6.6 6.6 2.4-6.6 2.4L12 20.5l-2.4-6.6L3 11.5l6.6-2.4z" fill="#c4b5fd" fill-opacity="0.5" stroke="#6d28d9" stroke-width="1.4" stroke-linejoin="round"/></svg> AI Vision — Photo Quality</span>
                <span>${ps}/100</span>
              </div>
              <div class="h-1.5 rounded-full bg-slate-200 dark:bg-slate-700"><div class="h-1.5 rounded-full ${barColor}" style="width:${ps}%"></div></div>
              ${flags.length ? `<div class="flex flex-wrap gap-1 mt-1.5">${flags.map(f => `<span class="text-[10px] bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300 px-1.5 py-0.5 rounded">${esc(f)}</span>`).join('')}</div>` : '<div class="text-[10px] text-emerald-500 font-semibold mt-1.5">✓ Photos look good</div>'}
            </div>`;
          })()}
          ${v.issues.length ? `<div class="flex flex-wrap gap-1">${issueList}</div>` : '<div class="text-emerald-500 text-xs font-semibold">✓ No issues</div>'}
        </div>`

      return `<tr class="cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/40 transition border-t border-slate-100 dark:border-slate-800" onclick="
        const bd = document.getElementById('${breakdownId}');
        const row = this.nextElementSibling;
        if (bd) { bd.classList.toggle('hidden'); this.querySelector('.hbd-arrow')?.classList.toggle('rotate-90'); }
      ">
        <td class="px-4 py-5">
          <div class="font-semibold text-sm text-indigo-600 dark:text-indigo-400">${stockNum}</div>
          <div class="text-xs text-slate-500 dark:text-slate-400 mt-0.5">${vehicleLine}</div>
        </td>
        <td class="px-4 py-5 text-center">
          <div class="inline-flex items-baseline gap-1">
            <span class="text-3xl font-black leading-none" style="color:${scoreColor}">${v.score}</span>
            <span class="text-xs text-slate-400 font-semibold">/100</span>
          </div>
        </td>
        <td class="px-4 py-5 text-center tabular-nums text-base text-slate-700 dark:text-slate-300">${v.photos}</td>
        <td class="px-4 py-5 text-center tabular-nums text-base font-semibold ${v.days >= 60 ? 'text-red-500' : v.days >= 30 ? 'text-amber-500' : 'text-slate-700 dark:text-slate-300'}">${v.days}d</td>
        <td class="px-4 py-5 text-right pr-2">
          <svg class="hbd-arrow w-4 h-4 text-slate-400 inline transition-transform duration-150" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7"/></svg>
        </td>
      </tr>
      <tr class="border-0"><td colspan="5" class="p-0">${breakdownHtml}</td></tr>`
    }).join('') || '<tr><td colspan="5" class="px-4 py-6 text-center text-slate-400">No vehicles found</td></tr>'

    document.getElementById('inv-intel-content').classList.remove('hidden')
  }

  async function loadIntel(force = false) {
    if (_intelLoaded && !force) return
    const loading = document.getElementById('inv-intel-loading')
    const content = document.getElementById('inv-intel-content')
    loading.classList.remove('hidden')
    content.classList.add('hidden')
    try {
      const data = await authFetch(`${API}/ai/inventory-intelligence`)
      _intelData = data
      _intelLoaded = true
      renderIntel(data)
      // Fire AI narrative separately so it doesn't block the page load
      loadNarrative(data)
    } catch (err) {
      showToast('Could not load inventory intelligence: ' + err.message, 'error')
    } finally {
      loading.classList.add('hidden')
    }
  }

  async function loadNarrative(data) {
    const narEl = document.getElementById('inv-intel-narrative')
    const narList = document.getElementById('inv-intel-narrative-list')
    if (!narEl || !narList) return
    const { summary, hot_segments, cold_segments, velocity, vehicles } = data
    try {
      const payload = {
        total: summary.total,
        avg_score: summary.avg_score,
        needs_attention: summary.needs_attention,
        duplicate_vins: summary.duplicate_vins,
        hot: hot_segments.map(s => `${s.make} ${s.model} (${s.monthly_velocity}/mo, ${s.current_stock} in stock)`),
        cold: cold_segments.map(s => `${s.make} ${s.model} (${s.current_stock} units, ${s.monthly_velocity}/mo)`),
        top_movers: velocity.slice(0, 5).map(s => `${s.make} ${s.model}: ${s.sold_90d} sold`),
        no_photos: vehicles.filter(v => v.photos === 0).length,
        stale: vehicles.filter(v => v.days >= 60).length,
      }
      const result = await authFetch(`${API}/ai/inventory-narrative`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (result.narrative?.length) {
        narList.innerHTML = result.narrative.map(b => `<li class="flex gap-2 text-sm text-slate-700 dark:text-slate-300"><span class="text-indigo-500 flex-shrink-0 mt-0.5">›</span>${b}</li>`).join('')
        narEl.classList.remove('hidden')
      }
    } catch {
      // narrative is optional — fail silently
    }
  }

  // Wire refresh button
  document.getElementById('inv-intel-refresh-btn')?.addEventListener('click', () => {
    _intelLoaded = false
    loadIntel(true)
  })

  // Manage subscription button → Stripe portal
  document.getElementById('inv-intel-manage-btn')?.addEventListener('click', launchStripeLifecycle)

  window._loadIntel = loadIntel
  window._invIntelPageHook = () => loadInvIntelPage()
})()

// ── AI Assistant dock ────────────────────────────────────────────────────────
// Floating "Ask MarketSync" chat, grounded in the dealer's live data via
// POST /ai/assistant. Visibility is gated to AI Boost / Inventory Intelligence
// (owner exempt); the launcher is flipped on once /ai/config resolves — see the
// updateAiDockVisibility() call in loadAIBoostSection().
let aiDockMessages = [];
let aiDockBusy = false;

// ── Reports rail — fixed right-edge quick access to every lot-wide report ─────
let __reportRailWired = false;

function updateReportRailVisibility() {
  const rail = document.getElementById('report-rail');
  if (!rail) return;
  // All four reports are Inventory Intelligence features, so the rail rides on
  // that entitlement (owner already resolves to active in /ai/config).
  // Step aside while the AI chat panel is open — it occupies the same right edge.
  const panel = document.getElementById('ai-dock-panel');
  const panelOpen = panel && !panel.classList.contains('hidden');
  const show = !!__invIntelActive && !panelOpen;
  rail.classList.toggle('lg:flex', show);   // lg:flex + base `hidden` = desktop-only when shown
  if (__invIntelActive) wireReportRail();
}

function wireReportRail() {
  if (__reportRailWired) return;
  const rail = document.getElementById('report-rail');
  if (!rail) return;
  __reportRailWired = true;

  // Briefly ring-highlight a control after we jump to its page, so the user can
  // see where the rail took them.
  const flash = (id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('ring-2', 'ring-indigo-500', 'ring-offset-2', 'dark:ring-offset-slate-900', 'rounded-lg');
    setTimeout(() => el.classList.remove('ring-2', 'ring-indigo-500', 'ring-offset-2', 'dark:ring-offset-slate-900', 'rounded-lg'), 2200);
  };

  rail.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-report]');
    if (!btn) return;
    const kind = btn.dataset.report;
    if (kind === 'lot') {
      // Lot Average Report opens as a modal — works from any page.
      if (typeof openLotReport === 'function') openLotReport();
    } else if (kind === 'scan') {
      switchPage('inv-intel');
      setTimeout(() => flash('inv-scan-controls'), 120);
    } else if (kind === 'snapshot') {
      switchPage('inv-intel');
      setTimeout(() => flash('msnap-run'), 120);
    } else if (kind === 'weekly') {
      switchPage('profile');
      setTimeout(() => flash('weekly-report-btn'), 120);
    }
  });
}

function updateAiDockVisibility() {
  const btn = document.getElementById('ai-dock-btn');
  const panel = document.getElementById('ai-dock-panel');
  if (!btn) return;
  const show = !!(__aiBoostActive || __invIntelActive);
  const panelOpen = panel && !panel.classList.contains('hidden');
  // Launcher hides while the panel is open, or when not entitled.
  btn.classList.toggle('hidden', !show || panelOpen);
  if (!show && panel) panel.classList.add('hidden');
}

function renderAiDockMessages() {
  const box = document.getElementById('ai-dock-messages');
  if (!box) return;
  box.innerHTML = '';
  if (!aiDockMessages.length) {
    const intro = document.createElement('div');
    intro.className = 'text-slate-500 dark:text-slate-400';
    intro.innerHTML =
      '<div class="mb-3 leading-relaxed">Hi 👋 Ask me anything about your store — I can see your live inventory, leads and pricing.</div>' +
      '<div class="flex flex-wrap gap-1.5">' +
      ['Which units are aging 60+ days?', 'What should I restock?', 'How many leads need follow-up?', 'Anything priced off market?']
        .map(s => `<button type="button" data-ai-suggest="${s}" class="text-xs bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 border border-slate-200 dark:border-slate-700 rounded-full px-3 py-1.5 text-slate-700 dark:text-slate-200 transition">${s}</button>`)
        .join('') +
      '</div>';
    box.appendChild(intro);
  }
  for (const m of aiDockMessages) {
    const row = document.createElement('div');
    row.className = m.role === 'user' ? 'flex justify-end' : 'flex justify-start';
    const bubble = document.createElement('div');
    bubble.className = m.role === 'user'
      ? 'max-w-[85%] bg-indigo-600 text-white rounded-2xl rounded-br-sm px-3.5 py-2 whitespace-pre-wrap break-words'
      : 'max-w-[85%] bg-slate-100 dark:bg-slate-800 text-slate-800 dark:text-slate-100 rounded-2xl rounded-bl-sm px-3.5 py-2 whitespace-pre-wrap break-words';
    bubble.textContent = m.content;
    row.appendChild(bubble);
    box.appendChild(row);
  }
  if (aiDockBusy) {
    const row = document.createElement('div');
    row.className = 'flex justify-start';
    const b = document.createElement('div');
    b.className = 'bg-slate-100 dark:bg-slate-800 text-slate-400 rounded-2xl px-3.5 py-2 text-xs';
    b.textContent = 'Thinking…';
    row.appendChild(b);
    box.appendChild(row);
  }
  box.scrollTop = box.scrollHeight;
}

async function sendAiDock(text) {
  text = (text || '').trim();
  if (!text || aiDockBusy) return;
  aiDockMessages.push({ role: 'user', content: text });
  aiDockBusy = true;
  renderAiDockMessages();
  const input = document.getElementById('ai-dock-input');
  if (input) { input.value = ''; input.style.height = 'auto'; }
  try {
    const r = await fetch(`${API}/ai/assistant`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: aiDockMessages.slice(-10) }),
    });
    const d = await r.json().catch(() => ({}));
    aiDockMessages.push({ role: 'assistant', content: r.ok ? (d.reply || 'No reply.') : (d.error || 'Something went wrong. Try again.') });
  } catch {
    aiDockMessages.push({ role: 'assistant', content: 'Network error — please try again.' });
  } finally {
    aiDockBusy = false;
    renderAiDockMessages();
  }
}

function openAiDock() {
  const p = document.getElementById('ai-dock-panel');
  if (!p) return;
  p.classList.remove('hidden');
  document.getElementById('ai-dock-btn')?.classList.add('hidden');
  updateReportRailVisibility();   // hide the reports rail while the chat covers the right edge
  renderAiDockMessages();
  setTimeout(() => document.getElementById('ai-dock-input')?.focus(), 50);
}

function closeAiDock() {
  document.getElementById('ai-dock-panel')?.classList.add('hidden');
  updateAiDockVisibility();
  updateReportRailVisibility();   // restore the reports rail
}

function initAiDock() {
  const btn = document.getElementById('ai-dock-btn');
  if (!btn || btn.dataset.wired) return;
  btn.dataset.wired = '1';
  btn.addEventListener('click', openAiDock);
  document.getElementById('ai-dock-close')?.addEventListener('click', closeAiDock);
  document.getElementById('ai-dock-clear')?.addEventListener('click', () => {
    aiDockMessages = [];
    renderAiDockMessages();
    document.getElementById('ai-dock-input')?.focus();
  });
  const form = document.getElementById('ai-dock-form');
  const input = document.getElementById('ai-dock-input');
  form?.addEventListener('submit', (e) => { e.preventDefault(); sendAiDock(input?.value); });
  input?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendAiDock(input.value); }
  });
  input?.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 112) + 'px';
  });
  document.getElementById('ai-dock-messages')?.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-ai-suggest]');
    if (chip) sendAiDock(chip.getAttribute('data-ai-suggest'));
  });
}
document.addEventListener('DOMContentLoaded', initAiDock);

// ── Market Snapshot (Inventory Intelligence) ─────────────────────────────────
// On-demand days-on-market + price stats for any make/model, via /ai/market-snapshot.
async function runMarketSnapshot() {
  const btn = document.getElementById('msnap-run');
  const out = document.getElementById('msnap-result');
  if (!btn || !out) return;
  const make = document.getElementById('msnap-make')?.value.trim();
  const model = document.getElementById('msnap-model')?.value.trim();
  const year = document.getElementById('msnap-year')?.value.trim();
  const trim = document.getElementById('msnap-trim')?.value.trim();
  if (!make || !model) { out.innerHTML = '<div class="text-xs text-amber-600 dark:text-amber-400">Enter at least a make and model.</div>'; return; }
  btn.disabled = true; btn.textContent = 'Loading…'; out.innerHTML = '';
  try {
    const q = new URLSearchParams({ make, model });
    if (year) q.set('year', year);
    if (trim) q.set('trim', trim);
    const r = await fetch(`${API}/ai/market-snapshot?${q.toString()}`, { headers: { 'Authorization': `Bearer ${token}` } });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { out.innerHTML = `<div class="text-xs text-rose-500">${esc(d.error || 'Lookup failed.')}</div>`; return; }
    if (!d.found) { out.innerHTML = `<div class="text-xs text-slate-500 dark:text-slate-400">No active listings found for ${esc([year, make, model, trim].filter(Boolean).join(' '))}.</div>`; return; }
    const money = n => n != null ? '$' + Math.round(Number(n)).toLocaleString() : '—';
    const days = n => n != null ? Math.round(Number(n)) + ' days' : '—';
    const tile = (label, val, sub) => `<div class="bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg p-3">
      <div class="text-[10px] uppercase font-bold tracking-wider text-slate-400">${label}</div>
      <div class="text-lg font-black text-slate-900 dark:text-white mt-0.5">${val}</div>
      ${sub ? `<div class="text-[11px] text-slate-400">${sub}</div>` : ''}</div>`;
    out.innerHTML = `
      <div class="text-xs font-semibold text-slate-600 dark:text-slate-300 mb-2">${esc([d.year, d.make, d.model, d.trim].filter(Boolean).join(' '))} · ${esc(d.currency || '')}</div>
      <div class="grid grid-cols-2 sm:grid-cols-4 gap-2">
        ${tile('Active listings', d.count != null ? d.count.toLocaleString() : '—', 'in market')}
        ${tile('Median price', money(d.price?.median), d.price ? `${money(d.price.min)}–${money(d.price.max)}` : '')}
        ${tile('Avg days on market', days(d.dom?.mean ?? d.dom?.median), 'lower = hotter')}
        ${tile('Median mileage', d.miles?.median != null ? Math.round(d.miles.median).toLocaleString() : '—', 'across comps')}
      </div>`;
  } catch {
    out.innerHTML = '<div class="text-xs text-rose-500">Network error — try again.</div>';
  } finally {
    btn.disabled = false; btn.textContent = 'Get snapshot';
  }
}
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('msnap-run')?.addEventListener('click', runMarketSnapshot);
  ['msnap-make', 'msnap-model', 'msnap-year', 'msnap-trim'].forEach(id => {
    document.getElementById(id)?.addEventListener('keydown', e => { if (e.key === 'Enter') runMarketSnapshot(); });
  });
});

// ── Trade appraisal: Deal Details (customer, disclosure, salesperson, PDFs) ───
const APPR_FEATURES = ['Power Windows', 'Power Door Locks', 'Power Seats', 'DVD Player', 'Navigation System', 'Air Conditioning', 'Sunroof', 'Alloy Wheels', 'Leather', 'Heated Seats', 'Ventilated Seats', 'MP3 Player', 'Park Assist', 'Towing Package', 'Snow Tires', '2 Keyless Remotes', 'Backup Camera', 'Remote Start', 'Apple CarPlay / Android Auto', 'Blind Spot Monitor', 'Adaptive Cruise'];

// The full trade-in disclosure — every question from the standard statement,
// grouped into sections. Types: 'yesno' (default), 'select', 'money'.
const APPR_DISCLOSURE_SECTIONS = [
  { title: 'Vehicle History', items: [
    { id: 'accident', q: 'Has the vehicle been in an accident?', money: true, moneyLabel: 'Amount $', detail: true },
    { id: 'panels', q: 'Have any panels been repaired, repainted or replaced?', detail: true },
    { id: 'abs', q: 'Is the ABS operational?', detail: true, detailLabel: 'If "No," details' },
    { id: 'accident_type', q: 'Vehicle accident type', type: 'select', options: ['Minor', 'Moderate', 'Severe', 'Other'], detail: true, detailLabel: 'If "Other," details' },
    { id: 'original_owner', q: 'Customer is original owner?', detail: true, detailLabel: 'If "No," where was it purchased' },
    { id: 'airbags', q: 'Are all of the air bags operational?', detail: true, detailLabel: 'If "No," details' },
    { id: 'import', q: 'Is this a US or out-of-province vehicle?', where: true, whereLabel: 'Which province / state', detail: true },
    { id: 'odometer', q: 'Odometer broken, faulty, replaced, repaired, disconnected or rolled back?', detail: true },
    { id: 'factory_warranty', q: 'Does the vehicle have a factory warranty?', detail: true },
    { id: 'extended_warranty', q: 'Does the vehicle have an extended warranty?', detail: true },
    { id: 'mechanical', q: 'Mechanical issues?', detail: true },
    { id: 'maintenance_6mo', q: 'Dollar value of maintenance in the last 6 months', type: 'money' },
  ] },
  { title: 'Disclosure Declaration', intro: 'Has this vehicle…', items: [
    { id: 'decl_rental', q: 'Been used as a daily rental, police cruiser, emergency services vehicle, taxi or limousine?' },
    { id: 'decl_flood_fire', q: 'Sustained damage caused by flood or fire?' },
    { id: 'decl_modified', q: 'Been modified, including badging or decals, from its original specifications?' },
    { id: 'decl_total_loss', q: 'Been declared a total loss by an insurer?' },
    { id: 'decl_stolen', q: 'Been recovered after being reported stolen?' },
    { id: 'decl_warranty_cancelled', q: "Had the manufacturer's warranty cancelled?" },
    { id: 'decl_damage_3000', q: 'Had any previous damage repaired exceeding $3,000?' },
  ] },
  { title: 'Structural', items: [
    { id: 'structural', q: 'Does this vehicle have any structural parts that are damaged, altered or repaired?', detail: true },
  ] },
  { title: 'Repairs required', intro: 'Does this vehicle require any repairs to the…', items: [
    { id: 'rep_engine', q: 'Engine, transmission, or powertrain?' },
    { id: 'rep_suspension', q: 'Subframe or suspension?' },
    { id: 'rep_computer', q: 'Computer equipment?' },
    { id: 'rep_electrical', q: 'Electrical system?' },
    { id: 'rep_fuel', q: 'Fuel operating system?' },
    { id: 'rep_ac', q: 'Air conditioning system?' },
  ] },
  { title: 'Other', items: [
    { id: 'other', q: 'Are there any other important facts about this vehicle that need to be disclosed?', detail: true },
  ] },
];
const APPR_DISCLOSURE_ITEMS = APPR_DISCLOSURE_SECTIONS.flatMap(s => s.items);
const APPR_INPUT_CLS = 'w-full bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded-lg px-3 py-2 text-sm';

// One disclosure row in the form.
function apprDiscItemHtml(item) {
  if (item.type === 'money') {
    return `<div class="flex items-center justify-between gap-3">
      <label class="text-sm text-slate-700 dark:text-slate-200">${esc(item.q)}</label>
      <input id="disc-${item.id}" inputmode="numeric" placeholder="$" class="w-32 flex-shrink-0 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded-lg px-3 py-2 text-sm"></div>`;
  }
  let control;
  if (item.type === 'select') {
    control = `<select id="disc-${item.id}" class="w-40 flex-shrink-0 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded-lg px-2 py-1.5 text-sm"><option value="">—</option>${item.options.map(o => `<option value="${esc(o)}">${esc(o)}</option>`).join('')}</select>`;
  } else {
    control = `<select id="disc-${item.id}" class="w-24 flex-shrink-0 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded-lg px-2 py-1.5 text-sm"><option value="">—</option><option value="yes">Yes</option><option value="no">No</option></select>`;
  }
  const extras = [];
  if (item.money) extras.push(`<input id="disc-${item.id}-amount" inputmode="numeric" placeholder="${esc(item.moneyLabel || 'Amount $')}" class="${APPR_INPUT_CLS}">`);
  if (item.where) extras.push(`<input id="disc-${item.id}-where" placeholder="${esc(item.whereLabel || 'Which province / state')}" class="${APPR_INPUT_CLS}">`);
  if (item.detail) extras.push(`<input id="disc-${item.id}-details" placeholder="${esc(item.detailLabel || 'Details (optional)')}" class="${APPR_INPUT_CLS}">`);
  const cols = extras.length >= 2 ? 'sm:grid-cols-2' : '';
  return `<div>
    <div class="flex items-center justify-between gap-3"><label class="text-sm text-slate-700 dark:text-slate-200">${esc(item.q)}</label>${control}</div>
    ${extras.length ? `<div class="grid ${cols} gap-2 mt-2">${extras.join('')}</div>` : ''}
  </div>`;
}

// Answer cell for the disclosure PDF.
function apprDiscAns(item, q) {
  if (!q) return '—';
  if (item.type === 'money') return q.value ? '$' + esc(q.value) : '—';
  if (item.type === 'select') return q.answer ? esc(q.answer) : '—';
  return q.answer === 'yes' ? '<span class="yes">YES</span>' : q.answer === 'no' ? '<span class="no">No</span>' : '—';
}

let __apprDealWired = false;
function initApprDeal() {
  const sp = document.getElementById('appr-salesperson-input');
  if (sp && !sp.value) sp.value = (typeof profileContext !== 'undefined' && profileContext?.full_name) ? profileContext.full_name : (profileContext?.email || '');

  const fWrap = document.getElementById('appr-features');
  if (fWrap && !fWrap.children.length) {
    fWrap.innerHTML = APPR_FEATURES.map(f => `<label class="flex items-center gap-2 cursor-pointer"><input type="checkbox" value="${esc(f)}" class="accent-indigo-600"> <span>${esc(f)}</span></label>`).join('');
  }

  const qWrap = document.getElementById('appr-disclosure-qa');
  if (qWrap && !qWrap.children.length) {
    qWrap.innerHTML = APPR_DISCLOSURE_SECTIONS.map(sec => `
      <div class="space-y-3 pt-4 border-t border-slate-100 dark:border-slate-800 first:pt-0 first:border-0">
        <div class="text-xs font-bold uppercase tracking-wider text-slate-400">${esc(sec.title)}</div>
        ${sec.intro ? `<div class="text-sm font-medium text-slate-600 dark:text-slate-300">${esc(sec.intro)}</div>` : ''}
        ${sec.items.map(apprDiscItemHtml).join('')}
      </div>`).join('');
  }

  loadApprAppraisers();

  if (__apprDealWired) return;
  __apprDealWired = true;
  document.getElementById('appr-save-deal')?.addEventListener('click', apprSaveDeal);
  document.getElementById('appr-pdf-summary')?.addEventListener('click', apprCustomerSummaryPdf);
  document.getElementById('appr-pdf-disclosure')?.addEventListener('click', apprDisclosurePdf);
}

async function loadApprAppraisers() {
  const box = document.getElementById('appr-notify-list');
  if (!box) return;
  try {
    const r = await fetch(`${API}/ai/appraisers`, { headers: { 'Authorization': `Bearer ${token}` } });
    const list = await r.json().catch(() => []);
    if (!Array.isArray(list) || !list.length) { box.innerHTML = '<div class="text-xs text-slate-400 italic col-span-full">No managers to notify.</div>'; return; }
    box.innerHTML = list.map(m => `<label class="flex items-center gap-2 cursor-pointer"><input type="checkbox" class="appr-notify accent-indigo-600" value="${esc(m.id)}"> <span>${esc(m.name)}</span></label>`).join('');
  } catch { box.innerHTML = '<div class="text-xs text-rose-500 col-span-full">Could not load managers.</div>'; }
}

function apprDealMsg(msg, kind) {
  const el = document.getElementById('appr-deal-msg');
  if (!el) return;
  el.textContent = msg;
  el.classList.remove('hidden');
  el.className = 'text-sm rounded-lg px-3 py-2 ' + (kind === 'error'
    ? 'bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300 border border-rose-200 dark:border-rose-900'
    : 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-900');
}

function apprCollectDeal() {
  const val = id => (document.getElementById(id)?.value || '').trim();
  const disposition = document.querySelector('input[name="appr-disposition"]:checked')?.value || 'retail';
  const features = [...document.querySelectorAll('#appr-features input:checked')].map(c => c.value);
  const qa = APPR_DISCLOSURE_ITEMS.map(item => {
    const o = { id: item.id, question: item.q, type: item.type || 'yesno' };
    if (item.type === 'money') o.value = val('disc-' + item.id) || null;
    else o.answer = val('disc-' + item.id) || null;
    if (item.money) o.amount = val('disc-' + item.id + '-amount') || null;
    if (item.where) o.where = val('disc-' + item.id + '-where') || null;
    if (item.detail) o.details = val('disc-' + item.id + '-details') || null;
    return o;
  });
  return {
    disposition,
    customer: {
      first_name: val('cust-first'), last_name: val('cust-last'),
      home_phone: val('cust-home-phone'), mobile_phone: val('cust-mobile-phone'),
      email: val('cust-email'), address: val('cust-address'), postal_code: val('cust-postal'),
    },
    disclosure: { features, qa, notes: val('disc-notes') },
  };
}

function apprVehicleForSave() {
  const specs = __apprDecodedSpecs || {};
  if (__apprData && __apprData.vehicle) return { ...specs, ...__apprData.vehicle };
  const g = id => (document.getElementById(id)?.value || '').trim();
  return { ...specs, vin: g('appr-vin').toUpperCase() || null, year: g('appr-year'), make: g('appr-make'), model: g('appr-model'), trim: g('appr-trim'), mileage: g('appr-mileage') };
}

async function apprSaveDeal() {
  const btn = document.getElementById('appr-save-deal');
  const deal = apprCollectDeal();
  const notify = [...document.querySelectorAll('#appr-notify-list input:checked')].map(c => c.value);
  const payload = {
    id: __apprDealId || undefined,
    vehicle: apprVehicleForSave(),
    appraisal: __apprData?.appraisal ? { ...__apprData.appraisal } : null,
    currency: __apprData?.currency || null,
    disposition: deal.disposition, customer: deal.customer, disclosure: deal.disclosure,
    notify,
    salesperson_name: (document.getElementById('appr-salesperson-input')?.value || '').trim() || null,
  };
  if (!payload.vehicle.make || !payload.vehicle.model) { apprDealMsg('Add at least the vehicle make and model (or run an appraisal) before saving.', 'error'); return; }
  btn.disabled = true; const t = btn.textContent; btn.textContent = 'Saving…';
  try {
    const r = await fetch(`${API}/ai/appraisals`, { method: 'POST', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || 'Save failed');
    __apprDealId = j.id;
    apprDealMsg('Saved and attached to ' + ((profileContext?.full_name) || 'you') + '.' + (j.notified ? ` Notified ${j.notified} appraiser${j.notified > 1 ? 's' : ''}.` : ''), 'success');
  } catch (e) { apprDealMsg(e.message, 'error'); }
  finally { btn.disabled = false; btn.textContent = t; }
}

// Shared print-to-PDF window (mirrors generateAppraisalPdf's approach).
function apprPrintWindow(title, inner) {
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title><style>
    @media print { .no-print{display:none!important} @page{margin:0.55in} }
    *{box-sizing:border-box} body{font-family:-apple-system,Segoe UI,Arial,sans-serif;color:#0f172a;background:#fff;margin:0 auto;padding:24px;max-width:780px;font-size:13px;line-height:1.45}
    h1{font-size:21px;margin:0} h2{font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:#64748b;margin:22px 0 8px;border-bottom:1px solid #e2e8f0;padding-bottom:4px}
    .head{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #0f172a;padding-bottom:12px}
    table{width:100%;border-collapse:collapse} td{padding:4px 0;vertical-align:top}
    .kv td:first-child{color:#64748b;width:40%} .kv td:last-child{font-weight:600}
    .grid2{display:grid;grid-template-columns:1fr 1fr;gap:4px 28px}
    .offer{background:#4f46e5;color:#fff;border-radius:10px;padding:14px 18px;margin-top:6px}
    .offer .n{font-size:26px;font-weight:900}
    .feat{display:grid;grid-template-columns:1fr 1fr 1fr;gap:2px 16px;font-size:12px}
    .qa td{border-bottom:1px solid #f1f5f9;padding:6px 0}
    .yes{color:#b91c1c;font-weight:700} .no{color:#15803d;font-weight:700}
    .sig{display:grid;grid-template-columns:1fr 1fr;gap:24px;margin-top:34px}
    .sig div{border-top:1px solid #94a3b8;padding-top:4px;font-size:11px;color:#64748b}
    .btn{padding:9px 18px;border-radius:8px;border:none;cursor:pointer;font-weight:700;font-size:13px;background:#4f46e5;color:#fff}
    .muted{font-size:11px;color:#94a3b8}
  </style></head><body>
    <div class="no-print" style="display:flex;justify-content:flex-end;gap:10px;margin-bottom:14px">
      <button class="btn" onclick="window.print()">Print / Save as PDF</button>
      <button class="btn" style="background:#e2e8f0;color:#0f172a" onclick="window.close()">Close</button>
    </div>
    ${inner}
    <div style="margin-top:24px;text-align:center;font-size:10px;color:#94a3b8;border-top:1px solid #e2e8f0;padding-top:8px">Powered by Market<span style="color:#6366f1;font-weight:700">Sync</span></div>
  </body></html>`;
  const w = window.open('', '_blank');
  if (!w) { showToast('Allow pop-ups to open the PDF view', 'error'); return; }
  w.document.write(html); w.document.close();
}

function apprDealMeta() {
  const deal = apprCollectDeal();
  const v = apprVehicleForSave();
  const cust = deal.customer;
  const custName = [cust.first_name, cust.last_name].filter(Boolean).join(' ') || '—';
  const today = new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
  const dealer = (typeof profileContext !== 'undefined' && profileContext?.dealership?.name) || 'Dealership';
  // Salesperson = whatever's in the (editable) salesperson field, else the loaded
  // record's salesperson, else the logged-in user's name.
  const sales = (document.getElementById('appr-salesperson-input')?.value || '').trim()
    || __apprSalesperson || (profileContext?.full_name) || (profileContext?.email) || '—';
  const vlabel = [v.year, v.make, v.model, v.trim].filter(Boolean).join(' ') || 'Vehicle';
  const info = __apprDealerInfo || {};
  const dealerAddr = [info.city, info.province, info.postal_code].filter(Boolean).join(', ');
  const logo = __apprBranding?.logo_url || null;
  return { deal, v, cust, custName, today, dealer, dealerAddr, logo, sales, vlabel };
}

// Fetch dealership branding (logo) once, for the PDF header.
async function apprEnsureBranding() {
  if (__apprBranding !== null) return __apprBranding;
  try {
    const r = await fetch(`${API}/branding`, { headers: { 'Authorization': `Bearer ${token}` } });
    const d = await r.json().catch(() => ({}));
    __apprBranding = (d && d.branding) ? d.branding : {};
  } catch { __apprBranding = {}; }
  return __apprBranding;
}

// Branded PDF header: dealership logo (their logo) left, title center, dealership
// name + address right. MarketSync wordmark sits in the footer of apprPrintWindow.
function apprBrandedHeader(title, subtitle, dealer, dealerAddr, logo, today) {
  const left = logo
    ? `<img src="${logo}" alt="logo" style="max-height:52px;max-width:190px;object-fit:contain">`
    : `<div style="font-size:20px;font-weight:900;letter-spacing:-.02em;color:#0f172a">Market<span style="color:#4f46e5">Sync</span></div>`;
  return `<div class="head" style="align-items:center">
    <div style="flex:0 0 auto">${left}</div>
    <div style="flex:1;text-align:center;padding:0 12px"><h1 style="font-size:19px">${esc(title)}</h1>${subtitle ? `<div style="font-size:11px;color:#64748b">${esc(subtitle)}</div>` : ''}</div>
    <div style="flex:0 0 auto;text-align:right;font-size:11px;color:#334155"><div style="font-weight:800;color:#0f172a">${esc(dealer)}</div>${dealerAddr ? `<div>${esc(dealerAddr)}</div>` : ''}${today ? `<div style="color:#94a3b8;margin-top:2px">${esc(today)}</div>` : ''}</div>
  </div>`;
}

// Customer Appraisal Summary — laid out like the vAuto sheet, branded MarketSync
// with the dealership's logo. Pre-fills what we know; leaves the rest as blank lines.
function apprCustomerSummaryPdf() {
  const { deal, v, cust, custName, dealer, dealerAddr, logo, sales, vlabel } = apprDealMeta();
  const d = __apprData, ap = d?.appraisal;
  const money2 = n => n != null ? '$' + Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
  const short = new Date().toLocaleDateString();
  const goodUntil = new Date(Date.now() + 7 * 86400000).toLocaleDateString();
  const qById = Object.fromEntries((deal.disclosure.qa || []).map(q => [q.id, q]));
  const ynv = id => { const q = qById[id]; return q ? (q.answer === 'yes' ? 'Yes' : q.answer === 'no' ? 'No' : '') : ''; };
  const mi = v.mileage ? Number(String(v.mileage).replace(/[^0-9]/g, '')).toLocaleString() : '';
  const fld = (label, value, w) => `<div class="fld" style="${w ? 'flex:0 0 ' + w : 'flex:1'}"><span class="fl">${label}</span><span class="fv">${value != null ? esc(String(value)) : ''}</span></div>`;
  const style = `<style>
    .sec{font-size:15px;font-weight:800;border-bottom:2px solid #0f172a;margin:16px 0 8px;padding-bottom:2px}
    .row{display:flex;gap:18px;margin:6px 0;align-items:flex-end;flex-wrap:wrap}
    .fld{display:flex;align-items:flex-end;gap:6px;min-width:0}
    .fl{font-size:12px;color:#0f172a;white-space:nowrap;text-align:right}
    .fv{flex:1;border-bottom:1px solid #0f172a;min-width:60px;min-height:15px;font-size:12px;padding:0 3px;font-weight:600}
    .consent{border:1.5px solid #0f172a;padding:10px 12px;font-size:11px}
    .consent .ln{border-bottom:1px solid #0f172a;height:22px;margin-top:14px}
    .consent .cap{font-size:10px;color:#334155;text-align:center;margin-top:2px}
    .amt{background:#e5e7eb;border:1px solid #cbd5e1;padding:12px 14px;display:flex;gap:24px;align-items:flex-end;margin-top:26px}
  </style>`;
  const inner = style + `
    ${apprBrandedHeader('Customer Appraisal Summary', vlabel + (v.vin ? ' - ' + v.vin : ''), dealer, dealerAddr, logo, '')}
    <div style="display:flex;gap:20px;margin-top:14px">
      <div style="flex:0 0 40%">
        <div class="consent">
          <div style="display:flex;justify-content:space-between;align-items:flex-end;gap:8px"><span>You may drive and appraise my vehicle</span><span style="border-bottom:1px solid #0f172a;width:64px">&nbsp;</span></div>
          <div style="text-align:right;font-size:9px;color:#334155">Initials</div>
          <div class="ln"></div><div class="cap">Customer signature${custName !== '—' ? ' — ' + esc(custName) : ''}</div>
          <div class="ln"></div><div class="cap">Manager signature</div>
        </div>
      </div>
      <div style="flex:1">
        <div class="sec" style="text-align:center">Customer Information</div>
        <div class="row">${fld('Name:', custName === '—' ? '' : custName)}</div>
        <div class="row">${fld('Address:', cust.address)}</div>
        <div class="row">${fld('City:', '')}</div>
        <div class="row">${fld('Province/Territory:', '', '52%')}${fld('Postal Code:', cust.postal_code)}</div>
        <div class="row">${fld('Email:', cust.email)}</div>
        <div class="row">${fld('Phone (Home):', cust.home_phone)}</div>
        <div class="row">${fld('Phone (Work):', '')}</div>
        <div class="row">${fld('Phone (Mobile):', cust.mobile_phone)}</div>
      </div>
    </div>
    <div class="sec">Vehicle Information</div>
    <div style="display:flex;gap:24px">
      <div style="flex:1">
        <div class="row">${fld('VIN:', v.vin)}</div>
        <div class="row">${fld('Year:', v.year)}</div>
        <div class="row">${fld('Make:', v.make)}</div>
        <div class="row">${fld('Model:', v.model)}</div>
        <div class="row">${fld('Series:', v.trim)}</div>
      </div>
      <div style="flex:1">
        <div class="row">${fld('Odometer:', mi)}</div>
        <div class="row">${fld('Interior Colour:', '')}</div>
        <div class="row">${fld('Exterior Colour:', v.color)}</div>
        <div class="row">${fld('Transmission:', v.transmission)}</div>
        <div class="row">${fld('Condition:', '')}</div>
      </div>
    </div>
    <div class="sec">Additional Information</div>
    <div class="row">${fld('Comments:', deal.disclosure.notes)}</div>
    <div class="row">${fld('Extended Warranty:', ynv('extended_warranty'), '30%')}${fld('Factory Warranty:', ynv('factory_warranty'), '30%')}</div>
    <div class="row">${fld('Vehicle Salvaged:', ynv('decl_total_loss'), '30%')}${fld('Flood Damage:', ynv('decl_flood_fire'), '30%')}${fld('Odometer Replaced:', ynv('odometer'), '30%')}</div>
    <div class="row">${fld('Improvements:', '')}</div>
    <div class="row">${fld('Lien Holder:', '', '58%')}${fld('Phone:', '')}</div>
    <div class="row">${fld('Lien Payoff:', '', '38%')}${fld('Good Until:', '', '26%')}${fld('Per Diem:', '', '26%')}</div>
    <div class="row" style="margin-top:12px;border-top:1px solid #cbd5e1;padding-top:12px">${fld('Salesperson:', sales, '33%')}${fld('Appraisal Date:', short, '30%')}${fld('Est. Recond.:', ap && ap.recon != null ? '$' + Number(ap.recon).toLocaleString() : '')}</div>
    <div class="amt">
      ${fld('Appraiser:', '', '38%')}
      ${fld('Good Until:', goodUntil, '26%')}
      <div class="fld" style="flex:1"><span class="fl" style="font-weight:800">Appraisal Amount:</span><span class="fv" style="font-weight:800">${ap ? money2(ap.suggested_offer) : ''}</span></div>
    </div>`;
  apprPrintWindow('Customer Summary — ' + vlabel, inner);
}

// Trade-In Disclosure Statement — EVERY question, grouped by section, branded, with
// customer + dealer signature lines that carry their printed names.
function apprDisclosurePdf() {
  const { deal, v, cust, custName, today, dealer, dealerAddr, logo, sales, vlabel } = apprDealMeta();
  const d = __apprData;
  const kv = (l, value) => `<tr><td>${esc(l)}</td><td>${value ? esc(value) : '—'}</td></tr>`;
  const feats = deal.disclosure.features;
  const mi = v.mileage ? String(v.mileage).replace(/[^0-9]/g, '') + ' ' + (d?.distance_unit || 'km') : '';
  const qById = Object.fromEntries((deal.disclosure.qa || []).map(q => [q.id, q]));
  const sections = APPR_DISCLOSURE_SECTIONS.map(sec => {
    const rows = sec.items.map(item => {
      const q = qById[item.id];
      const extra = [q?.amount ? 'Est. $' + q.amount : '', q?.where || '', q?.details || ''].filter(Boolean).join(' — ');
      return `<tr><td>${esc(item.q)}${extra ? `<div class="muted">${esc(extra)}</div>` : ''}</td><td style="text-align:right;white-space:nowrap">${apprDiscAns(item, q)}</td></tr>`;
    }).join('');
    return `<h2>${esc(sec.title)}</h2>${sec.intro ? `<div style="font-size:12px;color:#334155;margin:-2px 0 4px">${esc(sec.intro)}</div>` : ''}<table class="qa">${rows}</table>`;
  }).join('');
  const inner = `
    ${apprBrandedHeader('Trade-In Disclosure Statement', vlabel + (v.vin ? ' · ' + v.vin : ''), dealer, dealerAddr, logo, today)}
    <div style="text-align:right;font-size:11px;color:#64748b;margin-top:4px">Salesperson: <b>${esc(sales)}</b></div>
    <h2>Vehicle</h2>
    <div class="grid2"><table class="kv">${kv('Vehicle', vlabel)}${kv('VIN', v.vin)}${kv('Odometer', mi)}</table>
      <table class="kv">${kv('Engine', v.engine)}${kv('Transmission', v.transmission)}${kv('Drivetrain', v.drivetrain)}</table></div>
    <h2>Customer</h2>
    <div class="grid2"><table class="kv">${kv('Name', custName)}${kv('Home phone', cust.home_phone)}${kv('Mobile', cust.mobile_phone)}</table>
      <table class="kv">${kv('Email', cust.email)}${kv('Address', cust.address)}${kv('Postal / ZIP', cust.postal_code)}</table></div>
    ${feats.length ? `<h2>Equipment &amp; features</h2><div class="feat">${feats.map(f => `<div>✓ ${esc(f)}</div>`).join('')}</div>` : ''}
    ${sections}
    ${deal.disclosure.notes ? `<h2>Additional notes</h2><div>${esc(deal.disclosure.notes)}</div>` : ''}
    <div class="muted" style="margin-top:16px">The customer certifies the above is true and complete to the best of their knowledge.</div>
    <div class="sig">
      <div>${custName !== '—' ? esc(custName) + ' — ' : ''}Customer signature / date</div>
      <div>${esc(sales)} — Dealer representative signature / date</div>
    </div>`;
  apprPrintWindow('Disclosure — ' + vlabel, inner);
}

// ── Appraisals list (team-wide, filterable, with rep-visibility toggle) ───────
let __apprListWired = false;
let __apprListDebounce = null;
let __apprSalespeopleLoaded = false;
function initApprList() {
  if (__apprListWired) return;
  __apprListWired = true;
  const reload = () => loadApprList();
  document.getElementById('appr-list-search')?.addEventListener('input', () => { clearTimeout(__apprListDebounce); __apprListDebounce = setTimeout(reload, 300); });
  document.getElementById('appr-list-salesperson')?.addEventListener('change', reload);
  document.getElementById('appr-list-disposition')?.addEventListener('change', reload);
  document.getElementById('appr-list')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-appr-id]');
    if (btn) loadAppraisalRecord(btn.getAttribute('data-appr-id'));
  });
}

async function loadApprList() {
  initApprList();
  const box = document.getElementById('appr-list');
  if (!box) return;
  const q = document.getElementById('appr-list-search')?.value.trim() || '';
  const sp = document.getElementById('appr-list-salesperson')?.value || '';
  const disp = document.getElementById('appr-list-disposition')?.value || '';
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  if (sp) params.set('salesperson', sp);
  if (disp) params.set('disposition', disp);
  try {
    const r = await fetch(`${API}/ai/appraisals?${params.toString()}`, { headers: { 'Authorization': `Bearer ${token}` } });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { box.innerHTML = `<div class="text-xs text-rose-500 py-4">${esc(d.error || 'Could not load appraisals.')}</div>`; return; }
    const meta = d.meta || {};
    const scope = document.getElementById('appr-list-scope');
    if (scope) {
      scope.textContent = '· ' + (meta.restricted ? 'your appraisals only' : 'all salespeople');
      scope.classList.remove('hidden');
    }
    const spSel = document.getElementById('appr-list-salesperson');
    if (spSel) {
      if (meta.salespeople && meta.salespeople.length && !meta.restricted) {
        spSel.classList.remove('hidden');
        if (!__apprSalespeopleLoaded) {
          const cur = spSel.value;
          spSel.innerHTML = '<option value="">All salespeople</option>' + meta.salespeople.map(p => `<option value="${esc(p.id)}">${esc(p.name || '—')}</option>`).join('');
          spSel.value = cur;
          __apprSalespeopleLoaded = true;
        }
      } else {
        spSel.classList.add('hidden');
      }
    }
    const items = d.items || [];
    if (!items.length) { box.innerHTML = '<div class="text-xs text-slate-400 italic py-4">No appraisals match.</div>'; return; }
    box.innerHTML = items.map(it => {
      const date = it.created_at ? new Date(it.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '';
      const offer = it.offer != null ? '$' + Number(it.offer).toLocaleString() + (it.currency ? ' ' + esc(it.currency) : '') : '—';
      const disp2 = it.disposition === 'wholesale'
        ? '<span class="text-[9px] font-black uppercase tracking-wider bg-amber-100 dark:bg-amber-950 text-amber-700 dark:text-amber-300 px-1.5 py-0.5 rounded-full leading-none">Wholesale</span>'
        : '<span class="text-[9px] font-black uppercase tracking-wider bg-emerald-100 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-300 px-1.5 py-0.5 rounded-full leading-none">Retail</span>';
      return `<button type="button" data-appr-id="${esc(it.id)}" class="w-full text-left py-2.5 px-2 -mx-2 rounded flex items-center justify-between gap-3 hover:bg-slate-50 dark:hover:bg-slate-800/40 transition">
        <div class="min-w-0">
          <div class="text-sm font-semibold text-slate-900 dark:text-white truncate flex items-center gap-2">${esc(it.label || 'Vehicle')} ${disp2}</div>
          <div class="text-xs text-slate-400 truncate">${esc(it.customer_name || 'No customer')} · ${esc(it.salesperson || '—')} · ${esc(date)}</div>
        </div>
        <div class="text-sm font-bold text-slate-900 dark:text-white whitespace-nowrap">${offer}</div>
      </button>`;
    }).join('');
  } catch {
    box.innerHTML = '<div class="text-xs text-rose-500 py-4">Network error loading appraisals.</div>';
  }
}

async function loadAppraisalRecord(id) {
  try {
    const r = await fetch(`${API}/ai/appraisals/${encodeURIComponent(id)}`, { headers: { 'Authorization': `Bearer ${token}` } });
    const row = await r.json().catch(() => ({}));
    if (!r.ok) { showToast(row.error || 'Could not load appraisal', 'error'); return; }
    const setv = (elId, val) => { const el = document.getElementById(elId); if (el) el.value = (val != null ? val : ''); };
    setv('appr-vin', row.vin); setv('appr-year', row.year); setv('appr-make', row.make);
    setv('appr-model', row.model); setv('appr-trim', row.trim); setv('appr-mileage', row.mileage);
    __apprDecodedSpecs = { body_type: row.body_type || null, engine: row.engine || null, transmission: row.transmission || null, drivetrain: row.drivetrain || null, fuel_type: row.fuel_type || null, color: row.color || null };
    const c = row.customer || {};
    setv('cust-first', c.first_name); setv('cust-last', c.last_name); setv('cust-home-phone', c.home_phone);
    setv('cust-mobile-phone', c.mobile_phone); setv('cust-email', c.email); setv('cust-address', c.address); setv('cust-postal', c.postal_code);
    const dispInput = document.querySelector(`input[name="appr-disposition"][value="${row.disposition === 'wholesale' ? 'wholesale' : 'retail'}"]`);
    if (dispInput) dispInput.checked = true;
    const disc = row.disclosure || {};
    document.querySelectorAll('#appr-features input[type=checkbox]').forEach(cb => { cb.checked = Array.isArray(disc.features) && disc.features.includes(cb.value); });
    (disc.qa || []).forEach(qq => {
      setv('disc-' + qq.id, qq.type === 'money' ? (qq.value || '') : (qq.answer || ''));
      if (qq.details != null) setv('disc-' + qq.id + '-details', qq.details || '');
      if (qq.amount != null) setv('disc-' + qq.id + '-amount', qq.amount || '');
      if (qq.where != null) setv('disc-' + qq.id + '-where', qq.where || '');
    });
    setv('disc-notes', disc.notes || '');
    __apprDealId = row.id;
    __apprSalesperson = row.salesperson_name || null;  // print the record's salesperson, not the viewer
    const spEl = document.getElementById('appr-salesperson-input');
    if (spEl) spEl.value = row.salesperson_name || '';
    __apprData = row.appraisal ? {
      vehicle: { vin: row.vin, year: row.year, make: row.make, model: row.model, trim: row.trim, mileage: row.mileage, engine: row.engine, transmission: row.transmission, drivetrain: row.drivetrain, body_type: row.body_type, fuel_type: row.fuel_type },
      appraisal: row.appraisal, currency: row.currency, distance_unit: row.currency === 'USD' ? 'mi' : 'km',
    } : null;
    const money = n => n != null ? '$' + Number(n).toLocaleString() : '—';
    const resEl = document.getElementById('appr-result');
    if (resEl) {
      const label = [row.year, row.make, row.model, row.trim].filter(Boolean).join(' ') || 'Vehicle';
      resEl.innerHTML = `<div class="bg-white dark:bg-slate-900 border border-indigo-200 dark:border-indigo-900 rounded-xl p-4 flex items-center justify-between gap-3 flex-wrap">
        <div><div class="text-xs font-bold uppercase tracking-wider text-indigo-500">Loaded saved appraisal</div>
        <div class="text-sm font-semibold text-slate-900 dark:text-white mt-0.5">${esc(label)}</div></div>
        ${row.appraisal ? `<div class="text-right"><div class="text-[10px] uppercase tracking-wider text-slate-400">Suggested offer</div><div class="text-lg font-black text-slate-900 dark:text-white">${money(row.appraisal.suggested_offer)} ${esc(row.currency || '')}</div></div>` : ''}
      </div>`;
    }
    apprDealMsg('Loaded — edit and Save to update, or print a PDF. Salesperson: ' + (row.salesperson_name || '—') + '.', 'success');
    document.getElementById('appr-result')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  } catch { showToast('Could not load appraisal', 'error'); }
}

// Google Translate widget: when the rep picks a language, persist it so their
// AI-written Facebook listing copy comes out in that language too.
document.addEventListener('change', (e) => {
  const el = e.target;
  if (el && el.classList && el.classList.contains('goog-te-combo')) {
    try {
      fetch(`${API}/ai/my-language`, {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ language: el.value || '' }),
      }).catch(() => {});
    } catch {}
  }
});
