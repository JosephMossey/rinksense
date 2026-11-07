/* RINKSENSE players list (players.html): one sortable table of every skater. */
(() => {
  'use strict';
  const { D, esc, fmt, teams, url, chip } = window.RSP;
  const $ = (id) => document.getElementById(id);
  const P = D.players;
  if (!P.length) { $('plTable').innerHTML = '<tbody><tr><td class="mvempty">No player data. Run scripts/preprocess.py.</td></tr></tbody>'; return; }

  $('plLede').textContent = `${P.length} skaters across ${D.games.length} tracked games. Players are identified by team and jersey number only. Click a player for their full page.`;
  $('plTeam').insertAdjacentHTML('beforeend', teams.map((t) => `<option value="${esc(t)}">${esc(t)}</option>`).join(''));

  const COLS = [
    ['player', 'Player'], ['gp', 'GP'], ['g', 'G'], ['xg', 'xG'], ['sog', 'SOG'],
    ['twp', 'TWP'], ['top', 'Top speed'], ['ftm', 'Ft / min'],
  ];
  const V = { q: '', team: '', gp: 1, sort: 'xg', dir: -1 };
  const cell = (k, p) => {
    const v = p[k];
    if (k === 'player') return `<a href="${url(p)}">${chip(p)}<b>#${esc(p.j)}</b><span>${esc(p.team)}</span></a>`;
    if (v == null) return '<span class="na">–</span>';
    if (k === 'xg') return v.toFixed(2);
    if (k === 'twp') return fmt(v);
    if (k === 'top') return `${v.toFixed(1)}<small> mph</small>`;
    if (k === 'ftm') return v.toLocaleString();
    return String(v);
  };
  const jn = (p) => (/^\d+$/.test(p.j) ? +p.j : 999);
  const cmp = (a, b) => {
    if (V.sort === 'player') return V.dir * (a.team.localeCompare(b.team, undefined, { numeric: true }) || jn(a) - jn(b));
    const x = a[V.sort], y = b[V.sort];
    if (x == null && y == null) return 0;
    if (x == null) return 1;            // missing values always sink
    if (y == null) return -1;
    return V.dir * (x - y) || a.team.localeCompare(b.team) || jn(a) - jn(b);
  };

  function render() {
    const q = V.q.trim().toLowerCase().replace(/^#/, '');
    const rows = P.filter((p) => (!V.team || p.team === V.team) && p.gp >= V.gp &&
      (!q || p.j === q || `#${p.j} ${p.team}`.toLowerCase().includes(q) || p.team.toLowerCase().includes(q)))
      .sort(cmp);
    $('plTable').innerHTML = `<thead><tr>${COLS.map(([k, l]) => `<th data-k="${k}" class="${V.sort === k ? 'sorted' : ''}" aria-sort="${V.sort === k ? (V.dir < 0 ? 'descending' : 'ascending') : 'none'}"><button type="button">${l}${V.sort === k ? (V.dir < 0 ? ' ↓' : ' ↑') : ''}</button></th>`).join('')}</tr></thead>` +
      `<tbody>${rows.map((p) => `<tr data-id="${esc(p.id)}">${COLS.map(([k]) => `<td>${cell(k, p)}</td>`).join('')}</tr>`).join('') ||
        `<tr><td colspan="${COLS.length}" class="mvempty">No skaters match.</td></tr>`}</tbody>`;
    $('plCount').textContent = rows.length === P.length ? `${P.length} skaters` : `${rows.length} of ${P.length} skaters`;
    window.RS_PLAYERS_PAGE = { rows, view: V };   // test hook
  }

  $('plTable').addEventListener('click', (ev) => {
    const th = ev.target.closest('th');
    if (th) { const k = th.dataset.k; V.dir = V.sort === k ? -V.dir : (k === 'player' ? 1 : -1); V.sort = k; render(); return; }
    const tr = ev.target.closest('tr[data-id]');
    if (tr && !ev.target.closest('a')) location.href = tr.querySelector('a').href;
  });
  $('plSearch').addEventListener('input', (e) => { V.q = e.target.value; render(); });
  $('plTeam').addEventListener('change', (e) => { V.team = e.target.value; render(); });
  $('plGp').addEventListener('click', (ev) => {
    const b = ev.target.closest('button'); if (!b) return;
    V.gp = +b.dataset.v;
    [...$('plGp').children].forEach((x) => x.classList.toggle('on', x === b));
    render();
  });
  const t0 = new URLSearchParams(location.search).get('team');
  if (t0 && teams.includes(t0)) { V.team = t0; $('plTeam').value = t0; }
  render();
})();
