// tour.js — MarketSync in-app guided tour.
// A dependency-free spotlight walkthrough for the dashboard. Auto-runs once for
// new users (tracked in localStorage) and can be replayed from the "Tour" button.
// Steps target real dashboard elements when present and fall back to a centered
// card otherwise, so a missing element never breaks the tour.
(() => {
  const DONE_KEY = 'ms_tour_done';
  const PAD = 8;

  // Click a sidebar nav button to switch SPA pages before a step that needs it.
  const goPage = (page) => {
    const btn = document.querySelector(`#dashboard-nav [data-page="${page}"]`);
    if (btn) btn.click();
  };

  const STEPS = [
    {
      target: null,
      title: '👋 Welcome to MarketSync',
      body: `This 60-second tour shows you how to turn your dealer inventory into Facebook Marketplace listings — and keep them in sync automatically. You can skip anytime.`
    },
    {
      target: '#dashboard-nav',
      title: 'Your control center',
      body: `Switch between <b>Insights</b>, <b>Inventory</b>, your <b>Leaderboard</b>, and <b>Sales Team</b> from here.`
    },
    {
      target: '#add-feed-form',
      before: () => goPage('inventory'),
      title: '1. Connect your dealer website',
      body: `Paste your dealership inventory URL here. MarketSync auto-syncs every vehicle — year, make, model, price, mileage and photos — so you never re-type a listing.`
    },
    {
      target: '#catalog-panel',
      before: () => goPage('inventory'),
      title: '2. Your synced inventory',
      body: `Every vehicle we pull in shows up here, ready to post. Use the search box to find a specific car fast.`
    },
    {
      target: null,
      title: '3. Install the Chrome extension',
      body: `Add the <b>MarketSync</b> Chrome extension, then sign in once. Open it on Facebook, pick a vehicle, and click <b>Post</b> — it fills out the entire Marketplace listing for you. There's now a <b>search bar</b> right beside the New / Used / Demo filters to jump to any car.`
    },
    {
      target: null,
      title: '4. Sold? It clears Facebook for you ✨',
      body: `When you mark a car <b>Sold</b> in MarketSync, the extension automatically marks that listing <b>Sold on Facebook</b>. And if you <b>delete</b> a vehicle, it's <b>removed from Facebook Marketplace</b> too — no more stale listings. (Runs while Chrome is open and you're signed into Facebook.)`
    },
    {
      target: null,
      title: '5. One login, everywhere',
      body: `Sign in once and the dashboard and the extension stay logged in together. Log out of one and you're logged out of both.`
    },
    {
      target: '#dashboard-nav [data-page="leaderboard"]',
      before: () => goPage('leaderboard'),
      title: '6. Track your wins',
      body: `Every sale earns points. Watch the leaderboard to see how your team — or you — stacks up.`
    },
    {
      target: null,
      title: "🎉 You're all set",
      body: `Connect a feed, install the extension, and start posting. You can replay this tour anytime from the <b>Tour</b> button. Happy selling!`
    }
  ];

  let idx = 0;
  let els = null;

  function buildUI() {
    if (els) return els;
    const css = document.createElement('style');
    css.textContent = `
      .ms-tour-backdrop{position:fixed;inset:0;z-index:99998;pointer-events:auto;}
      .ms-tour-hole{position:fixed;z-index:99998;border-radius:10px;
        box-shadow:0 0 0 9999px rgba(15,23,42,0.72);transition:all .25s ease;pointer-events:none;}
      .ms-tour-card{position:fixed;z-index:100000;max-width:340px;width:calc(100vw - 32px);
        background:#0f172a;color:#e2e8f0;border:1px solid #334155;border-radius:14px;
        padding:18px 18px 14px;box-shadow:0 20px 50px rgba(0,0,0,.5);
        font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;transition:all .2s ease;}
      .ms-tour-card h3{margin:0 0 8px;font-size:16px;font-weight:800;color:#fff;}
      .ms-tour-card p{margin:0 0 14px;font-size:13.5px;line-height:1.55;color:#cbd5e1;}
      .ms-tour-card b{color:#fff;}
      .ms-tour-foot{display:flex;align-items:center;justify-content:space-between;gap:10px;}
      .ms-tour-dots{display:flex;gap:5px;}
      .ms-tour-dot{width:6px;height:6px;border-radius:99px;background:#334155;}
      .ms-tour-dot.on{background:#6366f1;}
      .ms-tour-btns{display:flex;gap:8px;}
      .ms-tour-btn{border:none;cursor:pointer;font-size:13px;font-weight:700;padding:7px 14px;border-radius:8px;}
      .ms-tour-next{background:#6366f1;color:#fff;}
      .ms-tour-next:hover{background:#4f46e5;}
      .ms-tour-back{background:#1e293b;color:#cbd5e1;}
      .ms-tour-skip{position:absolute;top:12px;right:14px;background:none;border:none;color:#64748b;
        font-size:18px;cursor:pointer;line-height:1;}
      .ms-tour-skip:hover{color:#cbd5e1;}
    `;
    document.head.appendChild(css);

    const backdrop = document.createElement('div');
    backdrop.className = 'ms-tour-backdrop';
    const hole = document.createElement('div');
    hole.className = 'ms-tour-hole';
    const card = document.createElement('div');
    card.className = 'ms-tour-card';
    card.innerHTML = `
      <button class="ms-tour-skip" aria-label="Close tour">×</button>
      <h3></h3><p></p>
      <div class="ms-tour-foot">
        <div class="ms-tour-dots"></div>
        <div class="ms-tour-btns">
          <button class="ms-tour-btn ms-tour-back">Back</button>
          <button class="ms-tour-btn ms-tour-next">Next</button>
        </div>
      </div>`;
    document.body.appendChild(backdrop);
    document.body.appendChild(hole);
    document.body.appendChild(card);

    card.querySelector('.ms-tour-skip').onclick = end;
    backdrop.onclick = end;
    card.querySelector('.ms-tour-back').onclick = () => { if (idx > 0) { idx--; render(); } };
    card.querySelector('.ms-tour-next').onclick = () => { idx < STEPS.length - 1 ? (idx++, render()) : end(); };

    els = { backdrop, hole, card };
    return els;
  }

  function render() {
    const { hole, card } = buildUI();
    const step = STEPS[idx];
    if (step.before) { try { step.before(); } catch {} }

    const finish = () => {
      card.querySelector('h3').innerHTML = step.title;
      card.querySelector('p').innerHTML = step.body;
      const dots = card.querySelector('.ms-tour-dots');
      dots.innerHTML = STEPS.map((_, i) => `<span class="ms-tour-dot ${i === idx ? 'on' : ''}"></span>`).join('');
      card.querySelector('.ms-tour-back').style.visibility = idx === 0 ? 'hidden' : 'visible';
      card.querySelector('.ms-tour-next').textContent = idx === STEPS.length - 1 ? 'Finish' : 'Next';

      const target = step.target ? document.querySelector(step.target) : null;
      if (target) {
        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        // Let the smooth scroll settle before measuring.
        setTimeout(() => positionTo(target), 280);
      } else {
        hole.style.opacity = '0';
        hole.style.width = hole.style.height = '0px';
        centerCard();
      }
    };

    // Give step.before() (page switch) a beat to render its panel.
    step.before ? setTimeout(finish, 120) : finish();
  }

  function positionTo(target) {
    const { hole, card } = els;
    const r = target.getBoundingClientRect();
    hole.style.opacity = '1';
    hole.style.top = (r.top - PAD) + 'px';
    hole.style.left = (r.left - PAD) + 'px';
    hole.style.width = (r.width + PAD * 2) + 'px';
    hole.style.height = (r.height + PAD * 2) + 'px';

    const cw = card.offsetWidth, ch = card.offsetHeight;
    const vw = window.innerWidth, vh = window.innerHeight;
    let top = r.bottom + 14, left = r.left;
    if (top + ch > vh - 12) top = Math.max(12, r.top - ch - 14);      // flip above
    if (top + ch > vh - 12) top = Math.max(12, (vh - ch) / 2);        // last resort
    left = Math.min(Math.max(12, left), vw - cw - 12);
    card.style.top = top + 'px';
    card.style.left = left + 'px';
    card.style.transform = 'none';
  }

  function centerCard() {
    const { card } = els;
    card.style.top = '50%';
    card.style.left = '50%';
    card.style.transform = 'translate(-50%,-50%)';
  }

  function start() {
    idx = 0;
    buildUI();
    els.backdrop.style.display = els.hole.style.display = els.card.style.display = 'block';
    render();
  }

  function end() {
    if (els) els.backdrop.style.display = els.hole.style.display = els.card.style.display = 'none';
    try { localStorage.setItem(DONE_KEY, '1'); } catch {}
  }

  // Public entry point (used by the Tour button).
  window.startMarketSyncTour = start;

  // Wire the replay button + auto-run for first-time users once the dashboard
  // has rendered its nav.
  function init() {
    const nav = document.getElementById('dashboard-nav');
    if (nav && !document.getElementById('ms-tour-btn')) {
      const btn = document.createElement('button');
      btn.id = 'ms-tour-btn';
      btn.type = 'button';
      btn.textContent = '❓ Tour';
      btn.className = 'nav-item flex-shrink-0 md:w-full text-left whitespace-nowrap px-3 py-2 rounded font-medium text-indigo-600 dark:text-indigo-400 hover:bg-slate-100 dark:hover:bg-slate-800 transition';
      btn.onclick = start;
      nav.appendChild(btn);
    }
    let done = false;
    try { done = localStorage.getItem(DONE_KEY) === '1'; } catch {}
    if (!done) setTimeout(start, 900);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(init, 600));
  } else {
    setTimeout(init, 600);
  }
})();
