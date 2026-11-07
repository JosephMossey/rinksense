/* RINKSENSE player page (player.html?p=team-a-63): one skater across every tracked game. */
(() => {
  'use strict';
  const { D, esc, fmt, pName, color, gameById, day, url, chip } = window.RSP;
  const $ = (id) => document.getElementById(id);
  const ID = new URLSearchParams(location.search).get('p') || '';
  const P = D.players.find((p) => p.id === ID);
  if (!P) {
    $('pdName').textContent = 'Player not found';
    $('pdMeta').innerHTML = '<a href="players.html">Browse all players</a>';
    $('pdBody').hidden = true;
    window.RS_PLAYER_PAGE = { player: null };
    return;
  }
  const C = color(P.team);
  const mates = Object.fromEntries(D.players.filter((p) => p.team === P.team).map((p) => [p.j, p]));
  const replay = (gid, p, lead) => `game.html?g=${encodeURIComponent(gid)}#p${p}-${lead}`;
  const report = (gid) => `report.html?g=${encodeURIComponent(gid)}`;

  // ---------- header ----------
  document.title = `#${P.j} ${P.team} · RINKSENSE`;
  $('pdName').innerHTML = `<i class="dot" style="background:${C}"></i>#${esc(P.j)} <span>${esc(P.team)}</span>`;
  $('pdMeta').innerHTML = `<span>${P.gp} game${P.gp === 1 ? '' : 's'}</span><span class="sep">·</span><span>${fmt(P.toi)} TOI</span><span class="sep">·</span><span>${P.tmin.toFixed(1)} tracked min</span>` +
    `<span class="sep">·</span><a href="players.html?team=${encodeURIComponent(P.team)}">${esc(P.team)} roster</a>`;
  const line = [['G', P.g], ['A*', P.a], ['xG', P.xg.toFixed(2)], ['SOG', P.sog], ['TWP', fmt(P.twp)]];
  $('pdLine').innerHTML = line.map(([l, v]) => `<div class="gstat"><div class="gl">${l}</div><div class="gv">${v}</div></div>`).join('');

  // ---------- percentiles ----------
  const M = [
    ['top', 'Top speed', (v) => `${v.toFixed(1)} mph`, 'Faster than'],
    ['acc', 'Burst accel', (v) => `+${v.toFixed(1)} mph/s`, 'Accelerates harder than'],
    ['xg60', 'xG per 60', (v) => v.toFixed(2), 'Creates more xG per 60 minutes than'],
    ['ftm', 'Ft / min', (v) => v.toLocaleString(), 'Covers more ice per minute than'],
    ['twpPct', 'Time with puck', (v) => `${v.toFixed(1)}%`, 'Has the puck more often than'],
  ];
  $('cmpSub').textContent = `vs ${D.qualified} skaters with ${D.minTracked}+ tracked min`;
  $('pctl').innerHTML = M.map(([k, l, f]) => {
    const v = P[k], pc = P.pct[k];
    return `<div class="prow${P.q ? '' : ' small'}"><span class="plab">${l}</span><span class="pval">${v == null ? '–' : f(v)}</span>` +
      `<span class="pbarw"><i style="width:${pc == null ? 0 : Math.max(2, pc)}%;background:${C}"></i><b style="left:50%"></b></span>` +
      `<span class="ppct">${pc == null ? '–' : ordinal(pc)}</span></div>`;
  }).join('');
  const best = M.filter(([k]) => P.pct[k] != null).sort((a, b) => P.pct[b[0]] - P.pct[a[0]])[0];
  if (best && P.q) $('callout').innerHTML = `${best[3]} <b>${P.pct[best[0]]}%</b> of skaters`;
  else if (best) $('callout').innerHTML = `Only ${P.tmin.toFixed(1)} tracked minutes, so these are rough: <b>${best[3].toLowerCase()} ${P.pct[best[0]]}%</b> of skaters`;
  else $('callout').textContent = 'Not enough tracking to compare this player.';
  $('pctNote').textContent = `Percentile = share of the ${D.qualified} skaters with ${D.minTracked}+ tracked minutes that this player beats. xG per 60 uses time on ice; the rest are per tracked minute. Line marks the median.`;
  function ordinal(n) { const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); }

  // ---------- shot map: right half of the rink, 4 px per foot (same drawing as the games page) ----------
  const X = (x) => 20 + Math.max(0, Math.min(100, x)) * 4;
  const Y = (y) => 190 - Math.max(-42, Math.min(42, y)) * 4;
  const red = '#e8646a', blue = '#4a7dff';
  let m = `<defs><clipPath id="half"><path d="M20,20 H308 A112,112 0 0 1 420,132 V248 A112,112 0 0 1 308,360 H20 Z"/></clipPath></defs>
    <path d="M20,20 H308 A112,112 0 0 1 420,132 V248 A112,112 0 0 1 308,360 H20 Z" fill="#0d1626"/>
    <g clip-path="url(#half)">
      <rect x="${X(0) - 1.25}" y="20" width="2.5" height="340" fill="${red}" opacity=".55"/>
      <rect x="${X(25) - 1.75}" y="20" width="3.5" height="340" fill="${blue}" opacity=".6"/>
      <line x1="${X(89)}" y1="20" x2="${X(89)}" y2="360" stroke="${red}" stroke-width="1" opacity=".5"/>
      <path d="M${X(89)},166 A24,24 0 0 0 ${X(89)},214 Z" fill="rgba(74,125,255,.14)" stroke="${red}" stroke-width="1" opacity=".6"/>
      <rect x="${X(89)}" y="178" width="13" height="24" fill="none" stroke="#8fa1c4" stroke-width="1.2" opacity=".7"/>
      <circle cx="${X(69)}" cy="${Y(22)}" r="60" fill="none" stroke="${red}" stroke-width="1.2" opacity=".4"/>
      <circle cx="${X(69)}" cy="${Y(-22)}" r="60" fill="none" stroke="${red}" stroke-width="1.2" opacity=".4"/>
      <circle cx="${X(0)}" cy="190" r="60" fill="none" stroke="${blue}" stroke-width="1.2" opacity=".45"/>
    </g>
    <path d="M20,20 H308 A112,112 0 0 1 420,132 V248 A112,112 0 0 1 308,360 H20" fill="none" stroke="#2a3a5a" stroke-width="2"/>`;
  const KIND = ['Missed', 'On net', 'Blocked', 'Goal'];
  // draw goals last so they sit on top; big chances above small ones
  const shots = P.shots.map(([gi, p, c, x, y, xg, kind, d1, lead]) => ({ g: D.games[gi], p, c, x, y, xg, kind, d1, lead }))
    .sort((a, b) => (a.kind === 3) - (b.kind === 3) || (b.xg || 0) - (a.xg || 0));
  for (const s of shots) {
    const r = s.xg != null ? 3.5 + Math.sqrt(s.xg) * 16 : 3;
    const cls = ['miss', 'on', 'blk', 'goal'][s.kind];
    const opp = s.g.home === P.team ? s.g.away : s.g.home;
    const tip = `${KIND[s.kind]}${s.d1 ? ' · ' + s.d1.toLowerCase() : ''} · xG ${s.xg != null ? s.xg.toFixed(2) : 'n/a (blocked)'} · ${pName(s.p)} ${fmt(s.c)} vs ${opp}, ${day(s.g.date)} · watch it`;
    m += `<a class="shot ${cls}" href="${replay(s.g.id, s.p, s.lead)}"><title>${esc(tip)}</title>` +
      `<circle cx="${X(s.x).toFixed(1)}" cy="${Y(s.y).toFixed(1)}" r="${r.toFixed(1)}" style="--c:${C}"/></a>`;
  }
  $('shotSvg').innerHTML = m;
  $('shotSub').textContent = P.att ? `${P.att} attempts · ${P.g} goal${P.g === 1 ? '' : 's'} · ${P.xg.toFixed(2)} xG` : 'No shot attempts';

  // ---------- skating by game ----------
  const SK = [
    ['top', 'Top speed', 'mph', (v) => v.toFixed(1)],
    ['ftm', 'Ft / min', 'ft', (v) => Math.round(v).toLocaleString()],
    ['sprint', 'Sprint %', '%', (v) => `${v.toFixed(1)}`],
    ['entry', 'Shift-start speed', 'mph', (v) => v.toFixed(1)],
  ];
  let skSel = 'top';
  $('skPick').innerHTML = SK.map(([k, l]) => `<button data-v="${k}" class="${k === skSel ? 'on' : ''}">${l}</button>`).join('');
  $('skPick').addEventListener('click', (ev) => {
    const b = ev.target.closest('button'); if (!b) return;
    skSel = b.dataset.v;
    [...$('skPick').children].forEach((x) => x.classList.toggle('on', x === b));
    drawSkate();
  });
  function drawSkate() {
    const [k, l, unit, f] = SK.find((s) => s[0] === skSel);
    const pts = P.log.map((g, i) => ({ g, i, v: g[k] })).filter((d) => d.v != null);
    const W = 520, H = 210, pl = 44, pr = 18, pt = 22, pb = 38;
    const n = P.log.length;
    const x = (i) => (n === 1 ? (pl + W - pr) / 2 : pl + (i / (n - 1)) * (W - pl - pr));
    let s = '';
    if (!pts.length) {
      $('skSvg').innerHTML = `<text x="${W / 2}" y="${H / 2}" text-anchor="middle" font-size="13" fill="#5a6883">Not enough tracking for this stat</text>`;
      $('skNote').textContent = '';
      return;
    }
    const vs = pts.map((d) => d.v), lo0 = Math.min(...vs), hi0 = Math.max(...vs);
    const padv = Math.max((hi0 - lo0) * 0.25, Math.abs(hi0) * 0.06, 0.5);
    const lo = lo0 - padv, hi = hi0 + padv;
    const y = (v) => pt + (1 - (v - lo) / (hi - lo)) * (H - pt - pb);
    for (const t of [lo + (hi - lo) * 0.15, (lo + hi) / 2, hi - (hi - lo) * 0.15]) {
      s += `<line x1="${pl}" x2="${W - pr}" y1="${y(t).toFixed(1)}" y2="${y(t).toFixed(1)}" stroke="#1b2740" stroke-dasharray="2 4"/>` +
        `<text x="${pl - 8}" y="${(y(t) + 4).toFixed(1)}" text-anchor="end" font-size="10" fill="#5a6883">${f(t)}</text>`;
    }
    // season average across the player's games (gold dashed)
    const avg = P[k];
    if (avg != null) s += `<line x1="${pl}" x2="${W - pr}" y1="${y(avg).toFixed(1)}" y2="${y(avg).toFixed(1)}" stroke="#ffd166" stroke-width="1" stroke-dasharray="5 4" opacity=".7"/>`;
    if (pts.length > 1) s += `<path d="M${pts.map((d) => `${x(d.i).toFixed(1)},${y(d.v).toFixed(1)}`).join('L')}" fill="none" stroke="${C}" stroke-width="2" stroke-linejoin="round"/>`;
    P.log.forEach((g, i) => {
      const G = gameById[g.g];
      s += `<text x="${x(i).toFixed(1)}" y="${H - 20}" text-anchor="middle" font-size="10" fill="#8593ad">${esc(day(G.date))}</text>` +
        `<text x="${x(i).toFixed(1)}" y="${H - 7}" text-anchor="middle" font-size="9.5" fill="#5a6883">${g.home ? 'vs' : '@'} ${esc(g.opp.replace(/^Team /, ''))}</text>`;
    });
    for (const d of pts) {
      s += `<circle cx="${x(d.i).toFixed(1)}" cy="${y(d.v).toFixed(1)}" r="4.5" fill="${C}" stroke="#0e1626" stroke-width="1.5"><title>${esc(day(gameById[d.g.g].date))}: ${f(d.v)} ${unit}</title></circle>` +
        `<text x="${x(d.i).toFixed(1)}" y="${(y(d.v) - 10).toFixed(1)}" text-anchor="middle" font-size="11" fill="#e6ecf7">${f(d.v)}</text>`;
    }
    $('skSvg').innerHTML = s;
    $('skSub').textContent = `${l}, ${unit === '%' ? 'share of tracked time over 22 ft/s' : unit} · gold line = all games`;
    const miss = P.log.length - pts.length;
    $('skNote').textContent = (P.log.length === 1 ? 'One game so far, so no trend yet. ' : '') +
      (miss ? `${miss} game${miss === 1 ? '' : 's'} left out (under ${D.minGameTracked} tracked minutes).` : '');
  }
  drawSkate();

  // ---------- chemistry ----------
  const maxM = Math.max(1, ...P.mates.map((x) => x[1]));
  $('mates').innerHTML = P.mates.map(([j, n]) => {
    const mp = mates[j];
    const who = mp ? `<a href="${url(mp)}">#${esc(j)}</a>` : `#${esc(j)}`;
    return `<li><span class="mwho">${chip(P)}${who}</span><span class="mbar"><i style="width:${((n / maxM) * 100).toFixed(1)}%;background:${C}"></i></span><b>${n}</b></li>`;
  }).join('') || '<li class="none">No completed passes logged.</li>';
  $('secMates').querySelector('.csub').textContent = `${P.passes} completed passes with teammates, all games`;

  // ---------- game log ----------
  const LC = ['Date', 'Opp', 'Result', 'TOI', 'G', 'A*', 'SOG', 'xG', 'Top speed'];
  $('logTable').innerHTML = `<thead><tr>${LC.map((c) => `<th>${c}</th>`).join('')}</tr></thead><tbody>` + P.log.map((g) => {
    const G = gameById[g.g];
    const res = g.res === 'SO' ? `SO ${g.score[0]}–${g.score[1]}` : `${g.res} ${g.score[0]}–${g.score[1]}`;
    return `<tr data-g="${esc(g.g)}"><td><a href="${report(g.g)}">${esc(day(G.date, { month: 'short', day: 'numeric', year: 'numeric' }))}</a></td>` +
      `<td>${g.home ? 'vs' : '@'} ${esc(g.opp)}</td><td class="res ${g.res === 'W' ? 'w' : ''}">${res}</td><td>${fmt(g.toi)}</td>` +
      `<td>${g.gl}</td><td>${g.a}</td><td>${g.sog}</td><td>${g.xg.toFixed(2)}</td><td>${g.top != null ? g.top.toFixed(1) + ' mph' : '–'}</td></tr>`;
  }).join('') + '</tbody>';
  $('logTable').addEventListener('click', (ev) => {
    const tr = ev.target.closest('tr[data-g]');
    if (tr && !ev.target.closest('a')) location.href = report(tr.dataset.g);
  });

  window.RS_PLAYER_PAGE = { player: P, shots };   // test hook
})();
