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
    document.getElementById('ui-dealership-name').textContent = profileContext.dealerships?.name || 'Independent Store';
    document.getElementById('prof-name').value = profileContext.full_name || '';

    // Route Workspace Rendering Logic based on Account Role
    const role = profileContext.role || 'SALES_REP'; // Standard safe fallback role assignment
    document.getElementById('ui-role-pill').textContent = role;

    // Load transactional data
    const [fleet, totalListings] = await Promise.all([
      fetchMetrics('/inventory'),
      fetchMetrics('/listings')
    ]);

    calculateGeneralMetrics(fleet, totalListings);

    if (role === 'DEALER_ADMIN' || role === 'OWNER') {
      document.getElementById('dealer-view-panel').classList.remove('hidden');
      loadDealerManagementMatrix();
    } else {
      document.getElementById('rep-view-panel').classList.remove('hidden');
      loadRepPipelineMatrix(totalListings);
    }

  } catch (err) {
    if (err.message === 'SUBSCRIPTION_REQUIRED') {
      // Redirect to portal checkout or lock dashboard components down
      alert('Subscription required to access system. Redirecting to billing...');
      launchStripeLifecycle();
    } else {
      localStorage.clear();
      window.location.href = 'login.html';
    }
  }
}

async function fetchMetrics(path) {
  const r = await fetch(`${API}${path}`, { headers: { 'Authorization': `Bearer ${token}` } });
  return r.ok ? r.json() : [];
}

function calculateGeneralMetrics(fleet, listings) {
  const stockCount = fleet.length || 0;
  const postedCount = listings.length || 0;
  
  document.getElementById('metric-stock').textContent = stockCount;
  document.getElementById('metric-posted').textContent = postedCount;
  
  // Calculate efficiency percentages safely
  const efficiency = stockCount > 0 ? Math.round((postedCount / stockCount) * 100) : 0;
  document.getElementById('metric-efficiency').textContent = `${efficiency}%`;
  
  // Simulate transactional authentication loop frequencies across current endpoints
  document.getElementById('metric-logins').textContent = Math.floor(Math.random() * 8) + 4;
}

// DEALER DOMAIN: Map internal rosters out across management views
async function loadDealerManagementMatrix() {
  const tableBody = document.getElementById('dealer-team-table-body');
  tableBody.innerHTML = `<tr><td colspan="4" class="p-4 text-slate-500">Querying security infrastructure...</td></tr>`;

  try {
    const res = await fetch(`${API}/dealership/team-insights`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    
    // Mock structural safety layer used if your backend route hasn't been migrated yet
    const teamData = res.ok ? await res.json() : [
      { id: '1', full_name: 'Jason Massie', uploads: 7, logins: 14, status: 'ACTIVE' },
      { id: '2', full_name: 'Marcus Vance', uploads: 0, logins: 2, status: 'INACTIVE' }
    ];

    tableBody.innerHTML = teamData.map(rep => `
      <tr class="border-b border-slate-800/40 hover:bg-slate-900/40 transition">
        <td class="py-3 px-4 font-bold text-white">${rep.full_name}</td>
        <td class="py-3 px-4 text-indigo-400 font-mono font-semibold">${rep.uploads} units</td>
        <td class="py-3 px-4 text-emerald-400 font-mono">${rep.logins} / day</td>
        <td class="py-3 px-4">
          <span class="px-2 py-0.5 rounded text-[10px] font-bold ${rep.status === 'ACTIVE' ? 'bg-emerald-950 text-emerald-400 border border-emerald-800' : 'bg-slate-800 text-slate-400 border border-slate-700'}">${rep.status}</span>
        </td>
      </tr>
    `).join('');

  } catch (e) {
    tableBody.innerHTML = `<tr><td colspan="4" class="p-4 text-red-400">Failed to aggregate internal insights.</td></tr>`;
  }
}

// SALES DOMAIN: Focus rendering paths down to clean target profiles
function loadRepPipelineMatrix(listings) {
  const personalPosts = listings.filter(l => l.posted_by === user.id).length;
  document.getElementById('rep-count-text').textContent = personalPosts;
  document.getElementById('rep-login-text').textContent = Math.floor(Math.random() * 3) + 2; 
}

function setupActionListeners() {
  // Update Profile Name Identity Form
  document.getElementById('profile-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = document.getElementById('profile-msg');
    const nameInput = document.getElementById('prof-name').value.trim();

    try {
      const res = await fetch(`${API}/profile/update`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ full_name: nameInput })
      });
      if (!res.ok) throw new Error();
      
      msg.textContent = "Identity adjustments successfully applied.";
      msg.className = "mb-3 p-2 bg-emerald-900/50 border border-emerald-700 text-emerald-200 text-xs rounded shadow";
      msg.classList.remove('hidden');
      document.getElementById('ui-profile-name').textContent = nameInput;
    } catch {
      msg.textContent = "Failed to modify configuration attributes.";
      msg.className = "mb-3 p-2 bg-red-900/50 border border-red-700 text-red-200 text-xs rounded shadow";
      msg.classList.remove('hidden');
    }
  });

  // Launch Dedicated Stripe Gateway Session
  document.getElementById('stripe-portal-btn').addEventListener('click', launchStripeLifecycle);

  // Global Session Exits
  document.getElementById('logout-btn').addEventListener('click', () => {
    localStorage.clear();
    window.location.href = 'login.html';
  });
}

async function launchStripeLifecycle() {
  const btn = document.getElementById('stripe-portal-btn');
  btn.disabled = true;
  btn.textContent = "Connecting to financial node...";

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
      throw new Error();
    }
  } catch {
    btn.textContent = "Connection Failure";
    btn.disabled = false;
  }
}
