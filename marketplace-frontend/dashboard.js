const API = 'https://vehicle-marketplace-s0e4.onrender.com';

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

// Local Security Handshake Validations
const token = localStorage.getItem('token');
const userRaw = localStorage.getItem('user');

if (!token) {
  localStorage.clear();
  window.location.href = 'login.html';
}

const user = userRaw ? JSON.parse(userRaw) : {};
let profileContext = null;

// Page permission flags (set after profile loads, read by switchPage to mirror panels into Insights)
let __canSeeLeaderboard = false;
let __canSeeTeamInsights = false;
let __canSeeSalesTeam = false;

// Run Engine Boot Lifecycle
document.addEventListener('DOMContentLoaded', () => {
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
    clearTimeout(timeoutId);
    
    if (res.status === 401 || res.status === 402) {
      if (res.status === 402) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error === 'TRIAL_EXPIRED' ? 'TRIAL_EXPIRED' : 'SUBSCRIPTION_REQUIRED')
      }
      throw new Error('SESSION_EXPIRED')
    }
    
    profileContext = await res.json();

    // Render Shared Header Components
    // For dealer admins: lead with the DEALERSHIP NAME (so it visually distinguishes the
    // dealer admin view from rep views). Person's name moves to the subtitle line.
    // For reps / solo: lead with the person's name (their own dashboard, not the team's).
    const personName = profileContext.full_name || user.email;
    const isPersonalDealership = profileContext.dealership?.is_personal === true;
    const dealershipName = isPersonalDealership
      ? 'Independent'
      : (profileContext.dealership?.name || 'Independent');
    const isAdminHeader = profileContext.role === 'DEALER_ADMIN' || profileContext.role === 'OWNER';

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
    if (role !== 'DEALER_ADMIN' && role !== 'OWNER') {
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

    const isAdmin = role === 'DEALER_ADMIN' || role === 'OWNER';
    const inDealership = !!profileContext.dealership?.id;
    const isPersonal = profileContext.dealership?.is_personal === true;
    const isSolo = role === 'SALES_REP' && (isPersonal || !inDealership);
    const isDealerRep = role === 'SALES_REP' && inDealership && !isPersonal;
    const canManageFeeds = isAdmin || isSolo;

    // Feeds + Catalog visible to anyone with a dealership (team or personal)
    if (inDealership) {
      document.getElementById('feeds-panel').classList.remove('hidden');
      document.getElementById('catalog-panel').classList.remove('hidden');
      loadInventoryFeeds();
      loadInventoryCatalog();
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
      loadLeaderboard();
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
      alert('Your 7-day free trial has ended. Add a payment method to keep using MarketSync.');
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
      localStorage.clear();
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

  document.querySelectorAll('[data-page-content]').forEach(el => {
    el.classList.toggle('hidden', el.dataset.pageContent !== pageId);
  });
  document.querySelectorAll('#dashboard-nav .nav-item, #nav-ai-boost').forEach(btn => {
    const active = btn.dataset.page === pageId;
    btn.classList.toggle('bg-indigo-100', active);
    btn.classList.toggle('dark:bg-indigo-950/50', active);
    btn.classList.toggle('text-indigo-700', active);
    btn.classList.toggle('dark:text-indigo-300', active);
    btn.classList.toggle('text-slate-700', !active);
    btn.classList.toggle('dark:text-slate-300', !active);
  });

  if (pageId === 'ai-boost') loadAIActivity();
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

async function loadInsights() {
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
    document.getElementById('metric-clicks').textContent = data.link_clicks ?? 0;

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
      const roleBadge = isAdmin
        ? `<span class="px-2 py-0.5 rounded text-xs font-bold bg-indigo-950 text-indigo-300 border border-indigo-800">${m.role}</span>`
        : `<span class="px-2 py-0.5 rounded text-xs font-bold bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 border border-slate-300 dark:border-slate-700">${m.role}</span>`;
      const action = (isSelf || isAdmin)
        ? `<span class="text-xs text-slate-600">—</span>`
        : `<button class="rep-remove-btn text-red-400 hover:text-red-300 text-xs font-bold" data-rep-id="${m.id}" data-rep-name="${m.full_name || m.email || 'this rep'}">Remove</button>`;
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

    document.querySelectorAll('.rep-remove-btn').forEach(btn => {
      btn.addEventListener('click', () => removeRep(btn.dataset.repId, btn.dataset.repName));
    });
    document.querySelectorAll('.rep-detail-btn').forEach(btn => {
      btn.addEventListener('click', () => openRepDetail(btn.dataset.repId));
    });
  } catch (e) {
    tableBody.innerHTML = `<tr><td colspan="8" class="p-4 text-red-400">${e.message}</td></tr>`;
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
  } catch (e) {
    console.warn('Leaderboard failed:', e.message);
    body.innerHTML = `<tr><td colspan="7" class="p-6 text-center text-red-500 italic">Failed to load leaderboard.</td></tr>`;
  }
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
    renderRepCards(data.by_rep || [], data.sold_by_rep || [], data.active_days_by_rep || []);
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
    const subtext = hasFbLink
      ? `Posted ${when} · <span class="text-indigo-500">View on FB ↗</span>`
      : canAdd
        ? `Posted ${when} · <span class="text-amber-500">+ Add FB link</span>`
        : `Posted ${when}`;
    const meta = `<div class="text-xs text-slate-500 dark:text-slate-400">${subtext}</div>`;
    const rowContent = `
        ${thumb}
        <div class="flex-1 min-w-0">
          <div class="text-xs font-bold text-slate-900 dark:text-white truncate">${vehicleLabel}</div>
          ${meta}
        </div>
        ${badge(l.status)}
    `;
    const rowCls = (hasFbLink || canAdd) ? 'cursor-pointer hover:border-indigo-400 dark:hover:border-indigo-500 transition-colors' : '';
    return `<div class="listing-row flex items-center gap-3 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded p-2 ${rowCls}" data-listing-id="${l.id || ''}" data-fb-url="${hasFbLink ? l.fb_listing_url : ''}" data-can-add="${canAdd ? '1' : ''}">${rowContent}</div>`;
  }).join('');

  // Row clicks: open FB URL, or prompt to add one
  el.querySelectorAll('.listing-row').forEach(row => {
    const fbUrl = row.dataset.fbUrl;
    const canAdd = row.dataset.canAdd === '1';
    if (fbUrl) {
      row.addEventListener('click', () => window.open(fbUrl, '_blank', 'noopener'));
    } else if (canAdd) {
      row.addEventListener('click', async () => {
        const url = prompt('Paste the Facebook Marketplace listing URL:\n(e.g. https://www.facebook.com/marketplace/item/1234567890)');
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
    }
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
    const isAdmin = profileContext?.role === 'DEALER_ADMIN' || profileContext?.role === 'OWNER';
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

      const orangeSteps = `
        <div class="text-sm leading-snug rounded bg-amber-100 dark:bg-amber-900/40 border border-amber-300 dark:border-amber-700 text-amber-800 dark:text-amber-200 px-2 py-1.5">
          🔒 <b>Cloudflare-protected</b> — our servers can't reach it, so it's pulled through your browser:
          <div class="mt-1">1. Click <b>Pull Inventory</b>. &nbsp;2. A dealer tab opens, scans, and closes itself — don't close it. &nbsp;3. Wait ~1–2 min. &nbsp;4. This list and your catalog refresh automatically when done.</div>
        </div>`;
      // After a successful capture we drop the whole instructional box and leave only
      // a discreet "Pull again" button (the "Synced" pill in the header shows status).
      const extBlock = flaggedExt ? `
        <div class="ms-ext-capture mt-2" data-feed-id="${esc(f.id)}" data-feed-url="${esc(f.feed_url)}">
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

async function loadInventoryCatalog() {
  const list = document.getElementById('catalog-list');
  list.innerHTML = '<div class="text-xs text-slate-500 italic col-span-full">Loading catalog...</div>';
  try {
    const res = await fetch(`${API}/inventory/all`, { headers: { 'Authorization': `Bearer ${token}` } });
    const body = await res.json().catch(() => []);
    if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
    __catalogCache = Array.isArray(body) ? body : [];
    renderCatalog();
  } catch (err) {
    list.innerHTML = `<div class="text-xs text-red-400 col-span-full">Failed to load catalog: ${err.message}</div>`;
  }
}

function renderCatalog() {
  const list = document.getElementById('catalog-list');
  const q = document.getElementById('catalog-search').value.trim().toLowerCase();
  const statusFilter = document.getElementById('catalog-status').value;

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

  const CONDITION_FILTERS = new Set(['new', 'used', 'demo']);
  let filtered = __catalogCache;
  if (statusFilter !== 'all') {
    if (CONDITION_FILTERS.has(statusFilter)) {
      filtered = filtered.filter(v => (v.condition || '').toLowerCase() === statusFilter);
    } else {
      filtered = filtered.filter(v => v.status === statusFilter);
    }
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

  const statusBadge = (s) => {
    const map = {
      available: 'bg-emerald-900/40 border-emerald-700 text-emerald-300',
      pending: 'bg-amber-900/40 border-amber-700 text-amber-300',
      sold: 'bg-slate-100 dark:bg-slate-800 border-slate-300 dark:border-slate-700 text-slate-500 dark:text-slate-400'
    };
    return `<span class="text-xs uppercase font-bold border px-1.5 py-0.5 rounded ${map[s] || map.sold}">${s || 'unknown'}</span>`;
  };
  const conditionBadge = (c) => {
    if (!c) return '';
    const lc = c.toLowerCase();
    const cls = lc === 'new'
      ? 'bg-blue-900/40 border-blue-700 text-blue-300'
      : lc === 'demo'
        ? 'bg-purple-900/40 border-purple-700 text-purple-300'
        : 'bg-orange-900/40 border-orange-700 text-orange-300';
    return `<span class="text-xs uppercase font-bold border px-1.5 py-0.5 rounded ${cls}">${c}</span>`;
  };

  list.innerHTML = filtered.map(v => {
    const img = v.image_urls?.[0]
      ? `<img src="${API}/proxy-image?url=${encodeURIComponent(v.image_urls[0])}" loading="lazy" class="w-full h-32 object-cover rounded bg-slate-50 dark:bg-slate-950">`
      : `<div class="w-full h-32 rounded bg-slate-50 dark:bg-slate-950 flex items-center justify-center text-slate-700 text-2xl">⌀</div>`;
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
      <${tag} ${linkAttrs} class="bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded p-3 flex flex-col gap-2 ${href ? 'hover:border-indigo-400 dark:hover:border-indigo-500 transition no-underline' : ''}">
        ${img}
        <div class="text-xs font-bold text-slate-900 dark:text-white truncate" title="${v.year} ${v.make} ${v.model} ${v.trim || ''}">${v.year} ${v.make} ${v.model}</div>
        <div class="flex items-center gap-1 flex-wrap">
          ${conditionBadge(v.condition)}
          ${statusBadge(v.status)}
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
        ${__aiBoostActive ? `<button class="ai-enrich-btn mt-1 w-full text-xs bg-indigo-900/40 hover:bg-indigo-800/60 border border-indigo-700 text-indigo-300 rounded py-1 transition" data-id="${v.id}">AI Enrichment</button>` : ''}
      </${tag}>
    `;
  }).join('');

  // Attach AI Enrichment button listeners after render
  if (__aiBoostActive) {
    list.querySelectorAll('.ai-enrich-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        openAIEnrich(btn.dataset.id);
      });
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

  // Catalog search + status filter
  document.getElementById('catalog-search')?.addEventListener('input', renderCatalog);
  document.getElementById('catalog-status')?.addEventListener('change', renderCatalog);

  // Rep drill-down modal close
  document.getElementById('rep-detail-close')?.addEventListener('click', closeRepDetail);
  document.getElementById('rep-detail-modal')?.addEventListener('click', (e) => {
    if (e.target.id === 'rep-detail-modal') closeRepDetail();
  });

  // Team invite toggle + form
  const inviteForm = document.getElementById('invite-rep-form');
  document.getElementById('invite-rep-btn')?.addEventListener('click', () => {
    inviteForm.classList.toggle('hidden');
    document.getElementById('invite-result').classList.add('hidden');
  });
  document.getElementById('invite-cancel-btn')?.addEventListener('click', () => {
    inviteForm.classList.add('hidden');
  });
  inviteForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const payload = {
      full_name: document.getElementById('invite-name').value.trim(),
      email: document.getElementById('invite-email').value.trim(),
      password: document.getElementById('invite-password').value || undefined
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
    localStorage.clear();
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
        localStorage.clear();
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

async function loadAIActivity() {
  const loading = document.getElementById('ai-activity-loading');
  const empty = document.getElementById('ai-activity-empty');
  const errorEl = document.getElementById('ai-activity-error');
  const list = document.getElementById('ai-activity-list');
  const countEl = document.getElementById('ai-activity-count');
  const upsell = document.getElementById('ai-boost-page-upsell');
  const activeContent = document.getElementById('ai-boost-active-content');

  // Always show/hide the right section regardless of list presence
  const active = !!__aiBoostActive;
  if (upsell) upsell.classList.toggle('hidden', active);
  if (activeContent) activeContent.classList.toggle('hidden', !active);
  if (!active) {
    if (loading) loading.classList.add('hidden');
    return;
  }

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

    if (countEl) countEl.textContent = `${items.length} checks`;
    list.innerHTML = items.map(item => {
      const date = new Date(item.created_at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      const badges = [];
      if (item.warnings?.length > 0) badges.push(`<span class="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300">⚠ ${item.warnings.length} alert${item.warnings.length > 1 ? 's' : ''}</span>`);
      if (item.price_flagged) {
        const dir = (item.price_pct_diff || 0) > 0 ? 'overpriced' : 'underpriced';
        const pct = Math.abs(item.price_pct_diff || 0);
        badges.push(`<span class="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300">💰 ${pct}% ${dir}</span>`);
      }
      if (item.copy_generated) badges.push(`<span class="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full bg-indigo-100 dark:bg-indigo-900/40 text-indigo-700 dark:text-indigo-300">✦ Copy written</span>`);
      const warningList = item.warnings?.length > 0
        ? `<ul class="mt-1.5 text-xs text-amber-700 dark:text-amber-300 space-y-0.5 list-disc list-inside">${item.warnings.map(w => `<li>${w}</li>`).join('')}</ul>`
        : '';
      return `<li class="px-4 py-3.5">
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <div class="font-semibold text-sm text-slate-900 dark:text-white truncate">${item.vehicle_label || 'Unknown vehicle'}</div>
            <div class="flex flex-wrap gap-1.5 mt-1.5">${badges.join('') || '<span class="text-xs text-slate-400">No issues found</span>'}</div>
            ${warningList}
          </div>
          <div class="text-xs text-slate-400 whitespace-nowrap flex-shrink-0 mt-0.5">${date}</div>
        </div>
      </li>`;
    }).join('');
    list.classList.remove('hidden');
  } catch (err) {
    if (loading) loading.classList.add('hidden');
    if (errorEl) { errorEl.textContent = err.message; errorEl.classList.remove('hidden'); }
  }
}

async function verifyAIBoostSession(sessionId) {
  try {
    const res = await fetch(`${API}/billing/ai-boost-verify?session_id=${encodeURIComponent(sessionId)}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (!res.ok) return; // webhook will still handle it; fail silently
    showToast('🎉 AI Boost activated! Your settings are ready below.', 'success', 6000);
    switchPage('ai-boost');
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
    renderAIBoostSection(cfg);
  } catch {}
}

function renderAIBoostSection(cfg) {
  const badge = document.getElementById('ai-boost-badge');
  const inactive = document.getElementById('ai-boost-inactive');
  const activePanel = document.getElementById('ai-boost-active');
  if (!badge || !inactive || !activePanel) return;

  const upsellBanner = document.getElementById('ai-boost-upsell-banner');
  if (upsellBanner) {
    const isAdmin = profileContext?.role === 'DEALER_ADMIN' || profileContext?.role === 'OWNER';
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

  // Sidebar nav item — reps only see it when the dealer has purchased AI Boost
  const navBtn = document.getElementById('nav-ai-boost');
  const navPill = document.getElementById('nav-ai-boost-pill');
  if (navBtn) {
    const isAdmin = profileContext?.role === 'DEALER_ADMIN' || profileContext?.role === 'OWNER';
    const showNav = cfg.ai_boost_active || isAdmin;
    navBtn.classList.toggle('hidden', !showNav);
    if (cfg.ai_boost_active) {
      navBtn.classList.remove('hidden', 'text-slate-400', 'dark:text-slate-600', 'hover:bg-indigo-50', 'dark:hover:bg-indigo-950/30');
      navBtn.classList.add('text-slate-700', 'dark:text-slate-300', 'hover:bg-slate-100', 'dark:hover:bg-slate-800');
      if (navPill) navPill.classList.add('hidden');
      navBtn.dataset.page = 'ai-boost';
      navBtn.onclick = null;
      if (!navBtn._clickWired) {
        navBtn._clickWired = true;
        navBtn.addEventListener('click', () => switchPage('ai-boost'));
      }
    } else if (isAdmin) {
      navBtn.classList.remove('hidden', 'text-slate-700', 'dark:text-slate-300', 'hover:bg-slate-100', 'dark:hover:bg-slate-800');
      navBtn.classList.add('text-slate-400', 'dark:text-slate-600', 'hover:bg-indigo-50', 'dark:hover:bg-indigo-950/30', 'cursor-pointer');
      if (navPill) navPill.classList.remove('hidden');
      delete navBtn.dataset.page;
      navBtn.onclick = () => startAIBoostCheckout(navBtn, 'Try Free for 3 Days');
    }
  }

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
    startAIBoostCheckout(e.currentTarget, 'Start 3-Day Free Trial — $199/month after');
  });

  document.getElementById('ai-boost-upsell-btn')?.addEventListener('click', (e) => {
    startAIBoostCheckout(e.currentTarget, 'Try Free for 3 Days');
  });

  document.getElementById('ai-boost-page-upgrade-btn')?.addEventListener('click', (e) => {
    startAIBoostCheckout(e.currentTarget, 'Try Free for 3 Days');
  });

  document.getElementById('ai-activity-refresh')?.addEventListener('click', loadAIActivity);

  document.getElementById('ai-boost-goto-page-btn')?.addEventListener('click', () => {
    switchPage('ai-boost');
  });

  document.getElementById('ai-sync-all-btn')?.addEventListener('click', async () => {
    const btn = document.getElementById('ai-sync-all-btn');
    const status = document.getElementById('ai-sync-status');
    const statusText = document.getElementById('ai-sync-status-text');
    btn.disabled = true;
    btn.textContent = 'Scanning…';
    if (status) status.classList.remove('hidden');
    if (statusText) statusText.textContent = 'Starting scan…';
    try {
      const res = await fetch(`${API}/ai/sync-all`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Sync failed');
      if (statusText) statusText.textContent = data.message || 'Sync running…';
      // Poll activity log after a short delay to show first results
      setTimeout(() => loadAIActivity(), 4000);
      setTimeout(() => loadAIActivity(), 12000);
      setTimeout(() => {
        if (status) status.classList.add('hidden');
        btn.disabled = false;
        btn.innerHTML = `<svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg> Scan All Inventory`;
      }, 20000);
    } catch (err) {
      if (status) status.classList.add('hidden');
      btn.disabled = false;
      btn.textContent = 'Scan All Inventory';
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
      ai_required_fields: reqFields
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
