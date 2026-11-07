/* RINKSENSE MLB hub: 2026 postseason games, series results, links to game.html?g=<pk>. */
(() => {
  'use strict';
  const GAMES = window.RS_MLB_GAMES || [];
  const { esc, round, roundLabel, day, arrow } = window.RSM;
  const $ = (id) => document.getElementById(id);
  const url = (g) => `game.html?g=${g.pk}`;

  if (!GAMES.length) {
    $('grid').innerHTML = '<p class="empty">No games found. Run scripts/mlb_preprocess.py to build the data.</p>';
    return;
  }

  // ---------- series ----------
  const seriesKey = (g) => (g.desc || '').replace(/,.*$/, '').trim().replace(/\s*Game \d+$/, '');
  const series = new Map();
  for (const g of [...GAMES].sort((a, b) => a.date.localeCompare(b.date) || a.pk - b.pk)) {
    const k = seriesKey(g);
    if (!series.has(k)) series.set(k, { key: k, games: [], wins: {} });
    const s = series.get(k);
    s.games.push(g);
    const [a, h] = g.final;
    const w = a > h ? g.teams.away.abbr : g.teams.home.abbr;
    s.wins[w] = (s.wins[w] || 0) + 1;
    for (const t of [g.teams.away.abbr, g.teams.home.abbr]) s.wins[t] = s.wins[t] || 0;
  }
  const clinchers = new Set([...series.values()].map((s) => s.games[s.games.length - 1].pk));
  const order = (k) => (/World Series/.test(k) ? 0 : /CS/.test(k) ? 1 : /DS/.test(k) ? 2 : 3);
  const sl = [...series.values()].sort((a, b) => order(a.key) - order(b.key) || a.key.localeCompare(b.key));
  $('series').innerHTML = sl.map((s) => {
    const [w, l] = Object.entries(s.wins).sort((a, b) => b[1] - a[1]);
    return `<li class="${order(s.key) === 0 ? 'ws' : ''}"><span class="sname">${esc(s.key.replace(/'([AB])'/, '$1'))}</span>` +
      `<span class="sres"><b>${esc(w[0])}</b> def. ${esc(l[0])} · ${w[1]}–${l[1]}</span></li>`;
  }).join('');

  // ---------- hero ----------
  const latest = [...GAMES].sort((a, b) => b.date.localeCompare(a.date) || b.pk - a.pk)[0];
  $('ctaLatest').href = url(latest);
  const pitches = GAMES.reduce((n, g) => n + g.pitches, 0);
  const fastest = GAMES.reduce((m, g) => (g.topVelo[0] > m[0] ? g.topVelo : m), [0, '']);
  const kpis = [
    [GAMES.length, 'Games'],
    [pitches.toLocaleString('en-US'), 'Pitches'],
    [fastest[0].toFixed(1), `Top velo · ${esc(window.RSM.last(fastest[1]))}`],
    [GAMES.filter((g) => g.walkoff).length, 'Walk-offs'],
  ];
  $('kpis').innerHTML = kpis.map(([v, l]) => `<div class="kpi"><div class="kv">${v}</div><div class="kl">${l}</div></div>`).join('');

  // ---------- cards ----------
  const spark = (g) => {
    const W = 300, H = 46, n = g.spark.length - 1;
    const pts = g.spark.map((p, i) => `${(i / n * W).toFixed(1)},${((1 - p) * H).toFixed(1)}`).join(' ');
    const id = `c${g.pk}`;
    return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
      <defs><clipPath id="${id}t"><rect x="0" y="0" width="${W}" height="${H / 2}"/></clipPath>
      <clipPath id="${id}b"><rect x="0" y="${H / 2}" width="${W}" height="${H / 2}"/></clipPath></defs>
      <polygon points="0,${H / 2} ${pts} ${W},${H / 2}" fill="rgba(47,107,255,.22)" clip-path="url(#${id}t)"/>
      <polygon points="0,${H / 2} ${pts} ${W},${H / 2}" fill="rgba(255,138,128,.2)" clip-path="url(#${id}b)"/>
      <line x1="0" y1="${H / 2}" x2="${W}" y2="${H / 2}" stroke="#26344f" stroke-dasharray="3 4" vector-effect="non-scaling-stroke"/>
      <polyline points="${pts}" fill="none" stroke="#b7c2d8" stroke-width="1.4" vector-effect="non-scaling-stroke"/>
    </svg>`;
  };
  const firstSentence = (s) => {
    const t = String(s).split(/(?<=\.)\s/)[0];
    return t.length > 96 ? t.slice(0, 94) + '…' : t;
  };
  const card = (g) => {
    const [a, h] = g.final;
    const row = (side, sc, win) => `<div class="trow${win ? '' : ' lose'}">
      <span class="tbadge ${side === 'home' ? 'h' : 'a'}">${esc(g.teams[side].abbr)}</span>
      <span class="tn">${esc(g.teams[side].name)}<small>${side === 'home' ? 'Home' : 'Away'}</small></span>
      <span class="ts">${sc}</span></div>`;
    const sw = g.swing;
    const forHome = sw.d >= 0;
    const who = forHome ? g.teams.home.abbr : g.teams.away.abbr;
    const tags = [];
    if (clinchers.has(g.pk)) tags.push('<span class="gtag">Clincher</span>');
    if (g.walkoff) tags.push('<span class="gtag">Walk-off</span>');
    if (g.innings > 9) tags.push(`<span class="gtag dim">${g.innings} inn</span>`);
    return `<article class="gcard">
      <a class="cover" href="${url(g)}" aria-label="Replay ${esc(g.teams.away.name)} at ${esc(g.teams.home.name)}, ${esc(roundLabel(g))}"></a>
      <div class="gtop"><span class="gdate">${esc(roundLabel(g))} · ${day(g.date)}</span><span class="gtags">${tags.join('')}</span></div>
      ${row('away', a, a > h)}${row('home', h, h > a)}
      ${spark(g)}
      <div class="swing"><span>Biggest swing · ${arrow(sw.top)}${sw.inn}</span> ${esc(firstSentence(sw.desc))} <b>${who} +${Math.abs(Math.round(sw.d * 100))}%</b></div>
      <div class="gfoot">
        <span class="gstat"><b>${g.pitches}</b> pitches</span>
        <span class="gstat"><b>${g.topVelo[0].toFixed(1)}</b> top mph</span>
        <span class="gstat"><b>${g.decisions}</b> pitching changes</span>
        <span class="watch">Replay<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg></span>
      </div>
    </article>`;
  };

  let sort = 'new', rf = '';
  const draw = () => {
    let list = GAMES.filter((g) => !rf || round(g) === rf);
    list.sort(sort === 'drama' ? (x, y) => y.drama - x.drama
      : sort === 'old' ? (x, y) => x.date.localeCompare(y.date) || x.pk - y.pk
        : (x, y) => y.date.localeCompare(x.date) || y.pk - x.pk);
    $('grid').innerHTML = list.map(card).join('') || '<p class="empty">No games in this round.</p>';
    $('countLine').textContent = `${list.length} game${list.length === 1 ? '' : 's'} · ${rf || 'Wild Card through World Series'}` +
      (sort === 'drama' ? ' · sorted by total win-probability movement' : '');
  };
  document.querySelectorAll('.segmented button').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('.segmented button').forEach((x) => x.classList.toggle('on', x === b));
    sort = b.dataset.sort; draw();
  }));
  $('roundFilter').addEventListener('change', (e) => { rf = e.target.value; draw(); });
  draw();
  window.RS_MLB_HUB = { games: GAMES.length, series: sl.length };
})();
