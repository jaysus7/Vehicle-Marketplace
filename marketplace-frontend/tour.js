// tour.js — MarketSync in-app guided tour.
// A dependency-free spotlight walkthrough for the dashboard. Auto-runs once for
// new users (tracked in localStorage) and can be replayed from the "Tour" button.
// Steps target real dashboard elements when present and fall back to a centered
// card otherwise, so a missing/hidden element never breaks the tour.
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
      target: '#feeds-panel',
      before: () => goPage('inventory'),
      title: '1. Connect your dealer website',
      body: `Your dealership inventory feed lives here. MarketSync auto-syncs every vehicle — year, make, model, price, mileage and photos — so you never re-type a listing. Hit <b>Sync Now</b> to pull the latest.`
    },
    {
      target: '#catalog-search',
      before: () => goPage('inventory'),
      title: '2. Find any synced car',
      body: `Every vehicle we pull in shows up in your catalog below. Use this search box to jump to a specific car by make, model, VIN or stock #.`
    },
    {
      target: '#install-ext-btn',
      before: () => goPage('inventory'),
      title: '3. Post with the Chrome extension',
      body: `Install the <b>MarketSync</b> Chrome extension and sign in once. Open it on Facebook, pick a car, and click <b>Post</b> — it fills out the entire Marketplace listing for you. The extension also has a <b>search bar</b> beside the New / Used / Demo filters.`
    },
    {
      target: '#catalog-status',
      before: () => goPage('inventory'),
      title: '4. Sold? It clears Facebook for you ✨',
      body: `When you mark a car <b>Sold</b>, the extension automatically marks that listing <b>Sold on Facebook</b>. <b>Delete</b> a vehicle and it's <b>removed from Facebook Marketplace</b> too — no more stale listings. (Runs while Chrome is open and you're signed into Facebook.)`
    },
    {
      target: '#logout-btn',
      title: '5. One login, everywhere',
      body: `Sign in once and the dashboard and the extension stay logged in together. Sign out here and you're signed out of both.`
    },
    {
      target: '#dashboard-nav [data-page="leaderboard"]',
      before: () => goPage('leaderboard'),
      title: '6. Track your wins',
      body: `Every listing and sale earns points. The <b>Global Leaderboard</b> ranks you against every dealer and rep on MarketSync (everyone else stays anonymous) — so even solo reps can see how they stack up.`
    },
    {
      target: null,
      title: "🎉 You're all set",
      body: `Connect a feed, install the extension, and start posting. You can replay this tour anytime from the <b>Tour</b> button. Happy selling!`
    }
  ];

  let idx = 0;
  let els = null;
  let reposition = null;   // active scroll/resize handler for the current step
  let roObserver = null;   // ResizeObserver that repositions when the target resizes
  let renderToken = 0;     // guards against a stale async render repositioning

  function buildUI() {
    if (els) return els;
    const css = document.createElement('style');
    css.textContent = `
      .ms-tour-backdrop{position:fixed;inset:0;z-index:99998;pointer-events:auto;}
      .ms-tour-hole{position:fixed;z-index:99998;border-radius:10px;
        box-shadow:0 0 0 9999px rgba(15,23,42,0.72);transition:top .2s ease,left .2s ease,width .2s ease,height .2s ease,opacity .2s ease;pointer-events:none;}
      .ms-tour-card{position:fixed;z-index:100000;max-width:400px;width:calc(100vw - 32px);
        background:#0f172a;color:#e2e8f0;border:1px solid #334155;border-radius:14px;
        padding:22px 22px 16px;box-shadow:0 20px 50px rgba(0,0,0,.5);
        font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;}
      .ms-tour-card h3{margin:0 0 10px;font-size:21px;font-weight:800;color:#fff;line-height:1.25;}
      .ms-tour-card p{margin:0 0 18px;font-size:16px;line-height:1.6;color:#cbd5e1;}
      .ms-tour-card b{color:#fff;}
      .ms-tour-foot{display:flex;align-items:center;justify-content:space-between;gap:10px;}
      .ms-tour-dots{display:flex;gap:6px;margin-bottom:14px;}
      .ms-tour-dot{width:7px;height:7px;border-radius:99px;background:#334155;}
      .ms-tour-dot.on{background:#6366f1;}
      .ms-tour-dontshow{display:flex;align-items:center;gap:6px;font-size:13px;color:#94a3b8;cursor:pointer;user-select:none;}
      .ms-tour-dontshow input{accent-color:#6366f1;width:15px;height:15px;cursor:pointer;margin:0;}
      .ms-tour-btns{display:flex;gap:8px;}
      .ms-tour-btn{border:none;cursor:pointer;font-size:15px;font-weight:700;padding:9px 18px;border-radius:9px;}
      .ms-tour-next{background:#6366f1;color:#fff;}
      .ms-tour-next:hover{background:#4f46e5;}
      .ms-tour-back{background:#1e293b;color:#cbd5e1;}
      .ms-tour-skip{position:absolute;top:12px;right:16px;background:none;border:none;color:#64748b;
        font-size:22px;cursor:pointer;line-height:1;}
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
      <div class="ms-tour-dots"></div>
      <div class="ms-tour-foot">
        <label class="ms-tour-dontshow"><input type="checkbox" class="ms-tour-dontshow-cb" checked> Don't show again</label>
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

    els = { backdrop, hole, card, dontShow: card.querySelector('.ms-tour-dontshow-cb') };
    return els;
  }

  const isVisible = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 1 || r.height <= 1) return false;
    const cs = getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0';
  };

  // Poll for the target to become laid-out & visible (it may be on a not-yet-shown
  // SPA page that step.before() just switched to).
  const waitForVisible = (selector, timeout) => new Promise((resolve) => {
    const start = Date.now();
    (function poll() {
      const el = document.querySelector(selector);
      if (el && isVisible(el)) return resolve(el);
      if (Date.now() - start > timeout) return resolve(el && isVisible(el) ? el : null);
      setTimeout(poll, 60);
    })();
  });

  function detachReposition() {
    if (reposition) {
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
      reposition = null;
    }
    if (roObserver) { roObserver.disconnect(); roObserver = null; }
  }

  async function render() {
    const { hole, card } = buildUI();
    const step = STEPS[idx];
    const token = ++renderToken;
    detachReposition();

    // Hide the old spotlight immediately so it never lingers on the previous
    // target while we locate the new one (that caused the "jumps to two spots").
    hole.style.opacity = '0';
    hole.style.pointerEvents = 'none';

    if (step.before) { try { step.before(); } catch {} }

    // Fill text + chrome immediately so the card never looks frozen.
    card.querySelector('h3').innerHTML = step.title;
    card.querySelector('p').innerHTML = step.body;
    card.querySelector('.ms-tour-dots').innerHTML =
      STEPS.map((_, i) => `<span class="ms-tour-dot ${i === idx ? 'on' : ''}"></span>`).join('');
    card.querySelector('.ms-tour-back').style.visibility = idx === 0 ? 'hidden' : 'visible';
    card.querySelector('.ms-tour-next').textContent = idx === STEPS.length - 1 ? 'Finish' : 'Next';

    let target = null;
    if (step.target) target = await waitForVisible(step.target, step.before ? 2200 : 1200);
    if (token !== renderToken) return;   // user advanced while we were waiting

    if (target) {
      // Instant scroll (no smooth-scroll race), then a brief settle, then reveal
      // the spotlight directly on the final position so it never visibly jumps.
      target.scrollIntoView({ behavior: 'auto', block: 'center', inline: 'nearest' });
      await new Promise(r => setTimeout(r, 220));
      if (token !== renderToken) return;
      positionTo(target);
      reposition = () => { if (token === renderToken) positionTo(target); };
      window.addEventListener('scroll', reposition, true);
      window.addEventListener('resize', reposition);
      // Reposition only when the target's box actually changes (e.g. catalog
      // images finish loading) — no blind interval, so no drifting.
      if (window.ResizeObserver) {
        roObserver = new ResizeObserver(() => reposition());
        try { roObserver.observe(target); } catch {}
      }
    } else {
      hole.style.opacity = '0';
      hole.style.width = hole.style.height = '0px';
      centerCard();
    }

    if (idx === STEPS.length - 1) setTimeout(() => { if (token === renderToken) fireConfetti(); }, 250);
  }

  function positionTo(target) {
    const { hole, card } = els;
    if (!isVisible(target)) { hole.style.opacity = '0'; centerCard(); return; }
    const r = target.getBoundingClientRect();
    hole.style.opacity = '1';
    hole.style.top = (r.top - PAD) + 'px';
    hole.style.left = (r.left - PAD) + 'px';
    hole.style.width = (r.width + PAD * 2) + 'px';
    hole.style.height = (r.height + PAD * 2) + 'px';

    const cw = card.offsetWidth, ch = card.offsetHeight;
    const vw = window.innerWidth, vh = window.innerHeight;
    let top = r.bottom + 14, left = r.left;
    if (top + ch > vh - 12) top = r.top - ch - 14;          // flip above
    if (top < 12) top = Math.max(12, (vh - ch) / 2);        // last resort: vertical center
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

  // Self-contained confetti — real popping burst, rendered ON TOP of everything.
  // Two side cannons fire inward/upward (party-popper style) plus a center pop.
  function fireConfetti() {
    const canvas = document.createElement('canvas');
    // Above the card (100000) so it visibly pops in front, not behind the modal.
    canvas.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;z-index:100002;pointer-events:none;';
    const dpr = window.devicePixelRatio || 1;
    const W = window.innerWidth, H = window.innerHeight;
    canvas.width = W * dpr; canvas.height = H * dpr;
    document.body.appendChild(canvas);
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);

    const colors = ['#6366f1', '#22c55e', '#f59e0b', '#ef4444', '#3b82f6', '#ec4899', '#a855f7', '#fff'];
    const parts = [];
    const burst = (ox, oy, angle, count, power) => {
      for (let i = 0; i < count; i++) {
        const a = angle + (Math.random() - 0.5) * 0.9;     // spread cone
        const speed = power * (0.55 + Math.random() * 0.7);
        parts.push({
          x: ox, y: oy,
          vx: Math.cos(a) * speed,
          vy: Math.sin(a) * speed,
          w: 7 + Math.random() * 7,
          h: 9 + Math.random() * 9,
          rot: Math.random() * Math.PI * 2,
          vrot: (Math.random() - 0.5) * 0.5,
          color: colors[(Math.random() * colors.length) | 0],
          round: Math.random() < 0.3
        });
      }
    };
    // Two corner cannons aiming up-and-inward + a center pop upward.
    burst(0, H, -Math.PI / 3.2, 120, 26);              // bottom-left → up-right
    burst(W, H, -Math.PI + Math.PI / 3.2, 120, 26);    // bottom-right → up-left
    burst(W / 2, H * 0.62, -Math.PI / 2, 90, 22);      // center → straight up

    const start = Date.now();
    (function frame() {
      const t = Date.now() - start;
      ctx.clearRect(0, 0, W, H);
      let alive = 0;
      parts.forEach(p => {
        p.vy += 0.42;        // gravity
        p.vx *= 0.992;
        p.vy *= 0.992;
        p.x += p.vx;
        p.y += p.vy;
        p.rot += p.vrot;
        const alpha = Math.max(0, 1 - t / 3200);
        if (alpha <= 0 || p.y > H + 40) return;
        alive++;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.globalAlpha = alpha;
        ctx.fillStyle = p.color;
        if (p.round) { ctx.beginPath(); ctx.arc(0, 0, p.w / 2, 0, Math.PI * 2); ctx.fill(); }
        else ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        ctx.restore();
      });
      if (t < 3200 && alive > 0) requestAnimationFrame(frame);
      else canvas.remove();
    })();
  }

  function start() {
    idx = 0;
    buildUI();
    els.backdrop.style.display = els.hole.style.display = els.card.style.display = 'block';
    render();
  }

  function end() {
    renderToken++;
    detachReposition();
    if (els) els.backdrop.style.display = els.hole.style.display = els.card.style.display = 'none';
    // "Don't show again" (checked by default) controls whether the tour auto-runs
    // on future visits. Unchecking it re-enables the auto-tour. The ❓ Tour button
    // always replays it regardless.
    try {
      if (!els || els.dontShow?.checked) localStorage.setItem(DONE_KEY, '1');
      else localStorage.removeItem(DONE_KEY);
    } catch {}
  }

  // Public entry point (used by the Tour button).
  window.startMarketSyncTour = start;

  // Wire the replay button + auto-run for first-time users once the dashboard
  // has rendered its nav.
  function init() {
    // Place a "Tour" button in the header, just to the left of Sign Out.
    const logout = document.getElementById('logout-btn');
    if (logout && !document.getElementById('ms-tour-btn')) {
      const btn = document.createElement('button');
      btn.id = 'ms-tour-btn';
      btn.type = 'button';
      btn.textContent = 'Tour';
      btn.className = 'bg-indigo-50 dark:bg-indigo-950/40 hover:bg-indigo-100 dark:hover:bg-indigo-900/50 text-indigo-700 dark:text-indigo-300 px-2.5 sm:px-3 py-1.5 rounded text-[11px] sm:text-xs font-medium border border-indigo-200 dark:border-indigo-800 transition whitespace-nowrap';
      btn.onclick = start;
      logout.parentNode.insertBefore(btn, logout);
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
