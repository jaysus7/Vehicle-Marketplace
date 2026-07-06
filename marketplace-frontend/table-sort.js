/* ─────────────────────────────────────────────────────────────────────────
   table-sort.js — makes every <table> on the page click-to-sort by column.

   Design goals:
   • Zero config. Any <table> with a <thead> and <tbody> becomes sortable.
   • Works with tables whose rows are rendered LATER by JS (leaderboard, team,
     inventory intelligence, etc.) — we read the rows at click time, so it does
     not matter when they were added.
   • Smart value detection: numbers ($1,200 · 45,000 km · 87% · 3.2) sort
     numerically; everything else sorts alphabetically (case-insensitive).
   • First click on a column sorts ascending, second click descending. A little
     ▲ / ▼ appears on the active column.
   • Columns can opt out with class="no-sort" on the <th> (used for Action /
     button columns). Empty-label headers are skipped automatically.
   ───────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  // Turn "$12,500", "45,000 km", "88%", "3.2" → a Number; otherwise NaN.
  function numify(raw) {
    if (raw == null) return NaN;
    const cleaned = String(raw)
      .replace(/[$,%]/g, '')
      .replace(/[^0-9.\-]+/g, ' ')  // strip units like "km", "days"
      .trim()
      .split(/\s+/)[0];             // take the first number-ish token
    if (cleaned === '' || cleaned === '-' || cleaned === '.') return NaN;
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : NaN;
  }

  // A cell's sort key: prefer an explicit data-sort attribute, else its text.
  function cellValue(row, index) {
    const cell = row.children[index];
    if (!cell) return '';
    return cell.getAttribute('data-sort') != null
      ? cell.getAttribute('data-sort')
      : cell.textContent.trim();
  }

  function sortBy(table, colIndex, ascending) {
    const tbody = table.tBodies[0];
    if (!tbody) return;
    const headerCount = table.tHead ? table.tHead.rows[0].children.length : 0;

    // Only sort "real" data rows — skip placeholder rows (Loading…, empty state)
    // which typically use a single colspanned cell.
    const rows = Array.from(tbody.rows).filter(
      r => r.children.length > 1 || r.children.length === headerCount
    );
    const placeholders = Array.from(tbody.rows).filter(r => !rows.includes(r));
    if (rows.length < 2) return;

    // Decide numeric vs text once, from the column's non-empty values.
    const sampleNumeric = rows.every(r => {
      const v = cellValue(r, colIndex);
      return v === '' || !Number.isNaN(numify(v));
    });

    const dir = ascending ? 1 : -1;
    rows.sort((a, b) => {
      const av = cellValue(a, colIndex);
      const bv = cellValue(b, colIndex);
      if (sampleNumeric) {
        const an = numify(av), bn = numify(bv);
        // Push blanks to the bottom regardless of direction.
        if (Number.isNaN(an) && Number.isNaN(bn)) return 0;
        if (Number.isNaN(an)) return 1;
        if (Number.isNaN(bn)) return -1;
        return (an - bn) * dir;
      }
      return av.localeCompare(bv, undefined, { numeric: true, sensitivity: 'base' }) * dir;
    });

    // Re-append in the new order; keep placeholder rows at the end.
    rows.forEach(r => tbody.appendChild(r));
    placeholders.forEach(r => tbody.appendChild(r));
  }

  function initTable(table) {
    if (table.__sortInit) return;
    const thead = table.tHead;
    if (!thead || !thead.rows.length || !table.tBodies[0]) return;
    table.__sortInit = true;

    const headerRow = thead.rows[0];
    Array.from(headerRow.children).forEach((th, index) => {
      const label = th.textContent.trim();
      if (!label || th.classList.contains('no-sort')) return;   // skip Action/empty
      // Skip obvious action columns even if unlabelled-by-class.
      if (/^(action|actions)$/i.test(label)) return;

      th.style.cursor = 'pointer';
      th.style.userSelect = 'none';
      th.setAttribute('title', 'Click to sort');

      // Indicator element appended once.
      const arrow = document.createElement('span');
      arrow.className = 'ts-arrow';
      arrow.style.cssText = 'display:inline-block;width:1em;opacity:.35;font-size:.85em;';
      arrow.textContent = '↕';
      th.appendChild(document.createTextNode(' '));
      th.appendChild(arrow);

      th.addEventListener('click', () => {
        const ascending = table.__sortCol === index ? !table.__sortAsc : true;
        table.__sortCol = index;
        table.__sortAsc = ascending;
        sortBy(table, index, ascending);

        // Reset every arrow, then mark the active one.
        headerRow.querySelectorAll('.ts-arrow').forEach(a => {
          a.textContent = '↕'; a.style.opacity = '.35';
        });
        arrow.textContent = ascending ? '▲' : '▼';
        arrow.style.opacity = '1';
      });
    });
  }

  function initAll() {
    document.querySelectorAll('table').forEach(initTable);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initAll);
  } else {
    initAll();
  }

  // Tables can be inserted after load (tab panels, lazy sections). A light
  // observer picks up any new <table> and wires it up automatically.
  if ('MutationObserver' in window) {
    const mo = new MutationObserver(muts => {
      for (const m of muts) {
        for (const node of m.addedNodes) {
          if (node.nodeType !== 1) continue;
          if (node.tagName === 'TABLE') initTable(node);
          else if (node.querySelectorAll) node.querySelectorAll('table').forEach(initTable);
        }
      }
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });
  }
})();
