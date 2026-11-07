/* RINKSENSE MLB players list: sortable pitchers / hitters tables -> player.html?p=<id>. */
(() => {
  'use strict';
  const ALL = window.RS_MLB_PLAYERS || [];
  const { esc, ptName } = window.RSM;
  const $ = (id) => document.getElementById(id);
  const d3 = (v) => (v == null ? '<span class="na">–</span>' : v.toFixed(3).replace(/^0/, ''));
  const ip = (o) => `${Math.floor(o / 3)}.${o % 3}`;
  const wpa = (v) => (v == null ? '–' : `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(2)}`);

  const COLS = {
    p: [
      ['Pitcher', (r) => r.name, null, 'text'],
      ['G', (r) => r.p.g], ['IP', (r) => r.p.outs, (r) => ip(r.p.outs)],
      ['K%', (r) => r.p.k, (r) => `${Math.round(r.p.k * 100)}%`],
      ['Top velo', (r) => r.p.top, (r) => r.p.top.toFixed(1)],
      ['Stuff+', (r) => r.p.st ?? -1, (r) => (r.p.st == null ? '–' : `<span class="${r.p.st >= 115 ? 'gold' : ''}">${r.p.st}</span>`)],
      ['xwOBA', (r) => -(r.p.xw ?? 1), (r) => d3(r.p.xw)],
      ['WPA', (r) => r.p.wpa, (r) => wpa(r.p.wpa)],
      ['Best pitch', (r) => (r.p.best ? r.p.best[1] : -1), (r) => (r.p.best ? `${esc(ptName(r.p.best[0]))} · ${Math.round(r.p.best[1])}` : '–')],
    ],
    h: [
      ['Hitter', (r) => r.name, null, 'text'],
      ['G', (r) => r.h.g], ['PA', (r) => r.h.pa],
      ['AVG / OBP / SLG', (r) => r.h.slg ?? 0, (r) => `${d3(r.h.avg)} / ${d3(r.h.obp)} / ${d3(r.h.slg)}`],
      ['HR', (r) => r.h.hr],
      ['xwOBA', (r) => r.h.xw ?? -1, (r) => `<span class="${r.h.xw >= 0.4 ? 'gold' : ''}">${d3(r.h.xw)}</span>`],
      ['Max EV', (r) => r.h.maxev ?? 0, (r) => (r.h.maxev == null ? '–' : r.h.maxev.toFixed(1))],
      ['WPA', (r) => r.h.wpa, (r) => wpa(r.h.wpa)],
    ],
  };
  const FOOT = {
    p: 'Postseason only. Stuff+ rates pitch shape (100 = league average). xwOBA allowed is per batter faced. WPA = win probability added. <a href="methods.html#stuff">How these are built</a>',
    h: 'Postseason only. xwOBA comes from exit velo, launch angle and spray angle. WPA = win probability added. <a href="methods.html#xwoba">How these are built</a>',
  };

  let role = 'p', sortI = 0, dir = 1, q = '', team = '';
  const teams = [...new Set(ALL.map((r) => r.team))].sort();
  $('plTeam').innerHTML += teams.map((t) => `<option>${esc(t)}</option>`).join('');

  function draw() {
    const cols = COLS[role];
    let rows = ALL.filter((r) => r[role] && (!team || r.team === team) && (!q || r.name.toLowerCase().includes(q)));
    const [, key, , type] = cols[sortI];
    rows.sort((a, b) => {
      const x = key(a), y = key(b);
      return (type === 'text' ? String(x).split(' ').pop().localeCompare(String(y).split(' ').pop()) : y - x) * dir;
    });
    $('plTable').innerHTML = `<thead><tr>${cols.map((c, i) => `<th class="${i === sortI ? 'sorted' : ''}"><button data-i="${i}">${c[0]}${i === sortI ? (dir === 1 ? ' ↓' : ' ↑') : ''}</button></th>`).join('')}</tr></thead><tbody>` +
      rows.map((r) => `<tr data-id="${r.id}">${cols.map((c, i) => i === 0
        ? `<td><a href="player.html?p=${r.id}"><b>${esc(r.name)}</b><span>${esc(r.team)}</span></a></td>`
        : `<td>${c[2] ? c[2](r) : c[1](r)}</td>`).join('')}</tr>`).join('') + '</tbody>';
    $('plCount').textContent = `${rows.length} ${role === 'p' ? 'pitchers' : 'hitters'}`;
    $('plFoot').innerHTML = FOOT[role];
  }
  $('plTable').addEventListener('click', (e) => {
    const b = e.target.closest('th button');
    if (b) { const i = +b.dataset.i; dir = i === sortI ? -dir : 1; sortI = i; draw(); return; }
    const tr = e.target.closest('tr[data-id]');
    if (tr && !e.target.closest('a')) location.href = `player.html?p=${tr.dataset.id}`;
  });
  document.querySelectorAll('#plRole button').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('#plRole button').forEach((x) => x.classList.toggle('on', x === b));
    role = b.dataset.v; sortI = role === 'p' ? 2 : 2; dir = 1; draw();
  }));
  $('plSearch').addEventListener('input', (e) => { q = e.target.value.trim().toLowerCase(); draw(); });
  $('plTeam').addEventListener('change', (e) => { team = e.target.value; draw(); });
  const want = new URLSearchParams(location.search).get('role');
  if (want === 'h') document.querySelector('#plRole [data-v="h"]').click();
  sortI = 2; draw();
  window.RS_MLB_PLAYERS_PAGE = { count: ALL.length };
})();
