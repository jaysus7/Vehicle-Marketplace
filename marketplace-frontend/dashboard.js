const API = 'https://vehicle-marketplace-s0e4.onrender.com';

// Local Security Handshake Validations
const token = localStorage.getItem('token');
const userRaw = localStorage.getItem('user');

if (!token || !userRaw) {
  localStorage.clear();
  window.location.href = 'login.html';
}

const user = JSON.parse(userRaw);
let profileContext = null;

// Page permission flags (set after profile loads, read by switchPage to mirror panels into Insights)
let __canSeeLeaderboard = false;
let __canSeeTeamInsights = false;
let __canSeeSalesTeam = false;

// Run Engine Boot Lifecycle
document.addEventListener('DOMContentLoaded', () => {
  initializeDashboardEcosystem();
  setupActionListeners();
});


async function initializeDashboardEcosystem() {
  try {
    // Fetch unified server profile context
    const res = await fetch(`${API}/auth/me`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    
    if (res.status === 401 || res.status === 402) {
      throw new Error(res.status === 402 ? 'SUBSCRIPTION_REQUIRED' : 'SESSION_EXPIRED');
    }
    
    profileContext = await res.json();

    // Render Shared Header Components
    document.getElementById('ui-profile-name').textContent = profileContext.full_name || user.email;
    const isPersonalDealership = profileContext.dealership?.is_personal === true;
    document.getElementById('ui-dealership-name').textContent = isPersonalDealership
      ? 'Independent'
      : (profileContext.dealership?.name || 'Independent');

    // Pre-fill profile form
    document.getElementById('prof-name').value = profileContext.full_name || '';
    document.getElementById('prof-email').value = profileContext.email || user.email || '';
    document.getElementById('prof-dealername').value = profileContext.dealership?.name || '';
    document.getElementById('prof-website').value = profileContext.dealership?.website_url || '';

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

    // Leaderboard is visible to all team members (admin + reps), not just admin
    if (inDealership && !isPersonal) {
      loadLeaderboard();
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

    if (isAdmin) {
      document.getElementById('leaderboard-panel')?.classList.remove('hidden');
      document.getElementById('dealer-view-panel')?.classList.remove('hidden');
      loadCharts();
      loadDealerManagementMatrix();
    } else {
      document.getElementById('rep-view-panel').classList.remove('hidden');
      loadMyStats();
    }

  } catch (err) {
    if (err.message === 'SUBSCRIPTION_REQUIRED') {
      alert('Subscription required to access system. Redirecting to billing...');
      launchStripeLifecycle();
    } else {
      localStorage.clear();
      window.location.href = 'login.html';
    }
  }
}

// Sidebar nav page switcher — also moves panels INTO Insights so it acts as an overview.
// Each panel exists in only one DOM location at a time (no duplication, no ID clashes).
function switchPage(pageId) {
  arrangePanelsForPage(pageId);

  document.querySelectorAll('[data-page-content]').forEach(el => {
    el.classList.toggle('hidden', el.dataset.pageContent !== pageId);
  });
  document.querySelectorAll('#dashboard-nav .nav-item').forEach(btn => {
    const active = btn.dataset.page === pageId;
    btn.classList.toggle('bg-indigo-100', active);
    btn.classList.toggle('dark:bg-indigo-950/50', active);
    btn.classList.toggle('text-indigo-700', active);
    btn.classList.toggle('dark:text-indigo-300', active);
    btn.classList.toggle('text-slate-700', !active);
    btn.classList.toggle('dark:text-slate-300', !active);
  });
}

function arrangePanelsForPage(pageId) {
  const lb = document.getElementById('leaderboard-panel');
  const ti = document.getElementById('team-insights-panel');
  const st = document.getElementById('dealer-view-panel');

  const lbWrap = document.querySelector('[data-page-content="leaderboard"]');
  const tiWrap = document.querySelector('[data-page-content="team-insights"]');
  const stWrap = document.querySelector('[data-page-content="sales-team"]');

  // Always return panels to their dedicated wrappers first.
  if (lb && lbWrap) lbWrap.appendChild(lb);
  if (ti && tiWrap) tiWrap.appendChild(ti);
  if (st && stWrap) stWrap.appendChild(st);

  // On Insights, mirror panels INTO the first insights wrapper (the one with the metrics strip).
  if (pageId === 'insights') {
    const insights = document.querySelector('[data-page-content="insights"]');
    if (!insights) return;
    if (__canSeeLeaderboard && lb) insights.appendChild(lb);
    if (__canSeeTeamInsights && ti) insights.appendChild(ti);
    if (__canSeeSalesTeam && st) insights.appendChild(st);
  }
}

async function fetchMetrics(path) {
  const r = await fetch(`${API}${path}`, { headers: { 'Authorization': `Bearer ${token}` } });
  return r.ok ? r.json() : [];
}

async function loadInsights() {
  try {
    const res = await fetch(`${API}/dashboard/insights`, { headers: { 'Authorization': `Bearer ${token}` } });
    if (!res.ok) {
      const body = await res.text();
      console.error(`Insights endpoint failed: ${res.status}`, body);
      return;
    }
    const data = await res.json();
    document.getElementById('metric-synced').textContent = data.inventory_available ?? data.inventory_synced;
    document.getElementById('metric-synced-total').textContent = data.inventory_synced;
    document.getElementById('metric-listings').textContent = data.listings_posted;
    document.getElementById('metric-sold').textContent = data.sold_this_month;
    document.getElementById('metric-active-days').textContent = `${data.active_days_this_week}/7`;
    document.getElementById('metric-listings-scope').textContent =
      data.scope === 'dealership' ? 'team total · lifetime' : 'your posts · lifetime';
    // Admin-only: show admin vs reps breakdown under Listings Posted
    if (data.scope === 'dealership') {
      const bd = document.getElementById('metric-listings-breakdown');
      bd?.classList.remove('hidden');
      bd?.classList.add('grid');
      document.getElementById('metric-listings-admin').textContent = data.listings_by_admin ?? 0;
      document.getElementById('metric-listings-reps').textContent = data.listings_by_reps ?? 0;
    }
  } catch (e) {
    console.error('Insights load threw:', e);
  }
}

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
        ? `<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-indigo-950 text-indigo-300 border border-indigo-800">${m.role}</span>`
        : `<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 border border-slate-300 dark:border-slate-700">${m.role}</span>`;
      const action = (isSelf || isAdmin)
        ? `<span class="text-[10px] text-slate-600">—</span>`
        : `<button class="rep-remove-btn text-red-400 hover:text-red-300 text-xs font-bold" data-rep-id="${m.id}" data-rep-name="${m.full_name || m.email || 'this rep'}">Remove</button>`;
      const nameCell = isAdmin && isSelf
        ? `<span class="font-bold text-slate-900 dark:text-white">${m.full_name || '(no name)'}</span><span class="text-[10px] text-slate-500 ml-1">(you)</span>`
        : `<button class="rep-detail-btn text-left font-bold text-slate-900 dark:text-white hover:text-indigo-300" data-rep-id="${m.id}">${m.full_name || '(no name)'}</button>`;
      return `
        <tr class="border-b border-slate-200/60 dark:border-slate-800/40 hover:bg-white/60 dark:bg-slate-900/40 transition">
          <td class="py-3 px-4">${nameCell}</td>
          <td class="py-3 px-4 text-slate-600 dark:text-slate-300">${m.email || '—'}</td>
          <td class="py-3 px-4">${roleBadge}</td>
          <td class="py-3 px-4 text-indigo-600 dark:text-indigo-400 font-mono">${m.listings_posted}</td>
          <td class="py-3 px-4 text-emerald-600 dark:text-emerald-400 font-mono">${m.listings_sold ?? 0}</td>
          <td class="py-3 px-4 text-amber-600 dark:text-amber-400 font-mono">${m.conversion_rate ?? 0}%</td>
          <td class="py-3 px-4 text-slate-600 dark:text-slate-300 font-mono">${m.logins_30d ?? 0}</td>
          <td class="py-3 px-4 text-right">${action}</td>
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
async function loadMyStats() {
  try {
    const res = await fetch(`${API}/me/stats`, { headers: { 'Authorization': `Bearer ${token}` } });
    if (!res.ok) throw new Error('Failed to load stats');
    const data = await res.json();
    document.getElementById('rep-stat-total').textContent = data.totals.total;
    document.getElementById('rep-stat-active').textContent = data.totals.active;
    document.getElementById('rep-stat-sold').textContent = data.totals.sold;
    document.getElementById('rep-stat-deleted').textContent = data.totals.deleted;
    renderRecentListings('rep-recent-list', data.recent);
  } catch (e) {
    document.getElementById('rep-recent-list').innerHTML = `<div class="text-xs text-red-400">${e.message}</div>`;
  }
}

// LEADERBOARD: PGA-style ranked table of everyone in the dealership
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

    if (!data.ranking?.length) {
      body.innerHTML = `<tr><td colspan="7" class="p-6 text-center text-slate-500 italic">No team members yet.</td></tr>`;
      return;
    }

    const medals = { 1: '🥇', 2: '🥈', 3: '🥉' };
    body.innerHTML = data.ranking.map(r => {
      const isMe = r.id === user.id;
      const rowBg = isMe ? 'bg-indigo-50 dark:bg-indigo-950/30' : '';
      const roleBadge = (r.role === 'DEALER_ADMIN' || r.role === 'OWNER')
        ? '<span class="text-[9px] uppercase font-bold bg-indigo-100 dark:bg-indigo-950/60 text-indigo-700 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-800 px-1.5 py-0.5 rounded">Admin</span>'
        : '<span class="text-[9px] uppercase font-bold bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 border border-slate-200 dark:border-slate-700 px-1.5 py-0.5 rounded">Sales rep</span>';
      const rankCell = medals[r.rank]
        ? `<span class="text-base">${medals[r.rank]}</span>`
        : `<span class="text-slate-500 dark:text-slate-400 font-mono">${r.rank}</span>`;
      return `
        <tr class="${rowBg} hover:bg-slate-50 dark:hover:bg-slate-900/60 transition">
          <td class="py-3 px-3">${rankCell}</td>
          <td class="py-3 px-3 font-semibold text-slate-900 dark:text-white">
            ${r.name}${isMe ? ' <span class="text-[10px] font-normal text-indigo-600 dark:text-indigo-400">(you)</span>' : ''}
          </td>
          <td class="py-3 px-3">${roleBadge}</td>
          <td class="py-3 px-3 text-right font-mono text-indigo-600 dark:text-indigo-400">${r.total_listings}</td>
          <td class="py-3 px-3 text-right font-mono text-emerald-600 dark:text-emerald-400">${r.sold_listings}</td>
          <td class="py-3 px-3 text-right font-mono text-amber-600 dark:text-amber-400">${r.conversion_rate}%</td>
          <td class="py-3 px-3 text-right font-mono text-slate-600 dark:text-slate-300">${r.recent_logins}</td>
        </tr>
      `;
    }).join('');
  } catch (e) {
    console.warn('Leaderboard failed:', e.message);
    body.innerHTML = `<tr><td colspan="7" class="p-6 text-center text-red-500 italic">Failed to load leaderboard.</td></tr>`;
  }
}

// CHARTS: listings over time + listings by rep (Chart.js)
async function loadCharts() {
  try {
    const res = await fetch(`${API}/dealership/charts`, { headers: { 'Authorization': `Bearer ${token}` } });
    if (!res.ok) return;
    const data = await res.json();
    renderDailyChart(data.daily || []);
    renderByRepChart(data.by_rep || []);
  } catch (e) {
    console.warn('Charts failed:', e.message);
  }
}

let __dailyChart = null;
let __byRepChart = null;

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
        backgroundColor: '#10b981',
        borderRadius: 4
      }]
    },
    options: chartCommonOptions()
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
      x: { ticks: { color: tickColor, font: { size: 10 } }, grid: { color: gridColor } },
      y: { ticks: { color: tickColor, font: { size: 10 }, precision: 0 }, grid: { color: gridColor }, beginAtZero: true }
    }
  };
}

// Re-render charts when the system color preference changes (e.g., macOS auto switch at sunset)
if (typeof window !== 'undefined' && window.matchMedia) {
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (typeof loadCharts === 'function') loadCharts();
  });
}

function renderRecentListings(containerId, items) {
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
    return `<span class="text-[9px] uppercase font-bold border px-1.5 py-0.5 rounded ${map[s] || map.deleted}">${s}</span>`;
  };
  el.innerHTML = items.map(l => {
    const v = l.vehicle || {};
    const thumb = v.image_urls?.[0]
      ? `<img src="${API}/proxy-image?url=${encodeURIComponent(v.image_urls[0])}" class="w-16 h-12 rounded object-cover bg-slate-50 dark:bg-slate-950" loading="lazy">`
      : `<div class="w-16 h-12 rounded bg-slate-50 dark:bg-slate-950 flex items-center justify-center text-slate-700">⌀</div>`;
    const when = l.posted_at ? new Date(l.posted_at).toLocaleDateString() : '—';
    const fbLink = l.fb_listing_url
      ? `<a href="${l.fb_listing_url}" target="_blank" class="text-[10px] text-indigo-600 dark:text-indigo-400 hover:underline">View on FB ↗</a>`
      : '';
    return `
      <div class="flex items-center gap-3 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded p-2">
        ${thumb}
        <div class="flex-1 min-w-0">
          <div class="text-xs font-bold text-slate-900 dark:text-white truncate">${v.year || ''} ${v.make || ''} ${v.model || ''} ${v.trim || ''}</div>
          <div class="text-[10px] text-slate-500 dark:text-slate-400">Posted ${when} ${fbLink ? '· ' + fbLink : ''}</div>
        </div>
        ${badge(l.status)}
      </div>
    `;
  }).join('');
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
    const isAdmin = profileContext?.role === 'DEALER_ADMIN' || profileContext?.role === 'OWNER';
    list.innerHTML = feeds.map(f => `
      <div class="flex items-center justify-between bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded p-3 gap-3">
        <div class="flex items-center gap-2 min-w-0 flex-1">
          <span class="text-[10px] uppercase font-bold bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 px-1.5 py-0.5 rounded">${f.feed_type || 'all'}</span>
          <span class="text-xs text-slate-600 dark:text-slate-300 truncate" title="${f.feed_url}">${f.feed_url}</span>
        </div>
        ${isAdmin ? `<button data-feed-id="${f.id}" class="feed-delete-btn text-red-400 hover:text-red-300 text-xs font-bold">Remove</button>` : ''}
      </div>
    `).join('');
    document.querySelectorAll('.feed-delete-btn').forEach(btn => {
      btn.addEventListener('click', () => deleteFeed(btn.dataset.feedId));
    });
  } catch (err) {
    list.innerHTML = `<div class="text-xs text-red-400">Failed to load feeds: ${err.message}</div>`;
  }
}

async function deleteFeed(id) {
  if (!confirm('Remove this inventory feed?')) return;
  try {
    const res = await fetch(`${API}/inventory-feeds/${id}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || 'Delete failed');
    }
    loadInventoryFeeds();
  } catch (err) {
    showSyncStatus(err.message, 'err');
  }
}

async function addFeed(feedUrl, feedType) {
  try {
    const res = await fetch(`${API}/inventory-feeds`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ feed_url: feedUrl, feed_type: feedType })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Add failed');
    loadInventoryFeeds();
    document.getElementById('add-feed-url').value = '';
  } catch (err) {
    showSyncStatus(err.message, 'err');
  }
}

async function syncNow() {
  const btn = document.getElementById('sync-now-btn');
  btn.disabled = true;
  const originalText = btn.textContent;
  btn.textContent = 'Syncing...';
  showSyncStatus('Sync running — this can take a minute depending on inventory size.', 'info');
  try {
    const res = await fetch(`${API}/inventory/sync`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Sync failed');
    const dupNote = data.duplicates_merged > 0 ? ` · ${data.duplicates_merged} duplicate VINs merged` : '';
    const skipNote = data.skipped > 0 ? ` · ${data.skipped} skipped (sale-pending / offline)` : '';
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
    __catalogCache = res.ok ? await res.json() : [];
    renderCatalog();
  } catch (err) {
    list.innerHTML = `<div class="text-xs text-red-400 col-span-full">Failed to load catalog: ${err.message}</div>`;
  }
}

function renderCatalog() {
  const list = document.getElementById('catalog-list');
  const q = document.getElementById('catalog-search').value.trim().toLowerCase();
  const statusFilter = document.getElementById('catalog-status').value;

  let filtered = __catalogCache;
  if (statusFilter !== 'all') filtered = filtered.filter(v => v.status === statusFilter);
  if (q) {
    filtered = filtered.filter(v =>
      `${v.year} ${v.make} ${v.model} ${v.trim || ''} ${v.vin || ''} ${v.exterior_color || ''}`
        .toLowerCase()
        .includes(q)
    );
  }

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
    return `<span class="text-[9px] uppercase font-bold border px-1.5 py-0.5 rounded ${map[s] || map.sold}">${s || 'unknown'}</span>`;
  };

  list.innerHTML = filtered.map(v => {
    const img = v.image_urls?.[0]
      ? `<img src="${API}/proxy-image?url=${encodeURIComponent(v.image_urls[0])}" loading="lazy" class="w-full h-32 object-cover rounded bg-slate-50 dark:bg-slate-950">`
      : `<div class="w-full h-32 rounded bg-slate-50 dark:bg-slate-950 flex items-center justify-center text-slate-700 text-2xl">⌀</div>`;
    const price = v.price ? `$${Number(v.price).toLocaleString()}` : '—';
    const mileage = v.mileage ? `${Number(v.mileage).toLocaleString()} km` : 'New';
    return `
      <div class="bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded p-3 flex flex-col gap-2">
        ${img}
        <div class="flex items-center justify-between gap-2">
          <span class="text-xs font-bold text-slate-900 dark:text-white truncate flex-1" title="${v.year} ${v.make} ${v.model} ${v.trim || ''}">${v.year} ${v.make} ${v.model}</span>
          ${statusBadge(v.status)}
        </div>
        <div class="text-[11px] text-slate-500 dark:text-slate-400 truncate">${v.trim || ''} ${v.exterior_color ? '· ' + v.exterior_color : ''}</div>
        <div class="flex items-center justify-between text-xs">
          <span class="font-bold text-indigo-600 dark:text-indigo-400">${price}</span>
          <span class="text-slate-500">${mileage}</span>
        </div>
      </div>
    `;
  }).join('');
}

function setupActionListeners() {
  // Collapsible profile panel
  const toggle = document.getElementById('profile-toggle');
  const panel = document.getElementById('profile-panel');
  const chevron = document.getElementById('profile-chevron');
  toggle?.addEventListener('click', () => {
    const open = !panel.classList.contains('hidden');
    panel.classList.toggle('hidden', open);
    chevron.style.transform = open ? '' : 'rotate(180deg)';
  });

  // Profile update form (full identity + workspace)
  document.getElementById('profile-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = document.getElementById('profile-msg');
    const payload = {
      fullName: document.getElementById('prof-name').value.trim(),
      email: document.getElementById('prof-email').value.trim(),
      password: document.getElementById('prof-password').value,
      dealershipName: document.getElementById('prof-dealername').value.trim(),
      websiteUrl: document.getElementById('prof-website').value.trim()
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
    if (data.url) {
      window.location.href = data.url;
    } else {
      throw new Error(data.error || 'No billing URL returned');
    }
  } catch (err) {
    if (btn) {
      btn.textContent = "Connection Failure";
      btn.disabled = false;
    }
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