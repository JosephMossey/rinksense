/* RINKSENSE game report: full-game analytics for report.html?g=<game-id>. */
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const GAME_ID = new URLSearchParams(location.search).get('g');
  if (!GAME_ID || !/^[\w-]+$/.test(GAME_ID)) { location.replace('index.html'); return; }
  const BASE = `data/games/${GAME_ID}`;
  const loadScript = (src) => new Promise((ok, bad) => {
    const s = document.createElement('script');
    s.src = src; s.onload = ok; s.onerror = () => bad(new Error(src));
    document.head.appendChild(s);
  });
  Promise.all([loadScript(`${BASE}/meta.js`), loadScript(`${BASE}/report.js`)])
    .then(() => start(window.RS_META, window.RS_REPORT))
    .catch(() => { $('rHeadline').textContent = 'That game could not be found.'; });

  const MPH = 0.681818;
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
  const pName = (p) => (p === 4 ? 'OT' : `P${p}`);
  const CLR = { home: '#2f6bff', away: '#ff8a80', gold: '#ffd166', line: '#26344f', dim: '#5a6883', text: '#e6ecf7', muted: '#8593ad' };

  function start(M, R) {
    const HOME = M.home, AWAY = M.away;
    const col = (t) => (t === HOME ? CLR.home : CLR.away);
    const PER = Object.keys(M.periods).map(Number).sort((a, b) => a - b);
    const LEN = (p) => M.periods[p].len || 1200;
    const goals = M.events.filter((e) => e.ev === 'Goal');
    const score = { [HOME]: goals.filter((g) => g.t === HOME).length, [AWAY]: goals.filter((g) => g.t === AWAY).length };
    const ot = PER.includes(4);
    const so = ot && score[HOME] === score[AWAY];
    const momentLink = (p, c) => `game.html?g=${encodeURIComponent(GAME_ID)}#p${p}-${Math.min(LEN(p), c + 5)}`;

    // ---------- header ----------
    const d = new Date(M.date + 'T12:00:00');
    const dateTxt = isNaN(d) ? M.date : d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
    document.title = `${AWAY} @ ${HOME} report · RINKSENSE`;
    $('replayLink').href = `game.html?g=${encodeURIComponent(GAME_ID)}`;
    $('rStatus').textContent = so ? 'Final / SO' : ot ? 'Final / OT' : 'Final';
    $('rDate').textContent = dateTxt;
    $('rAway').textContent = AWAY; $('rHome').textContent = HOME;
    $('rScoreA').textContent = score[AWAY]; $('rScoreH').textContent = score[HOME];
    $('wpHomeName').textContent = HOME; $('wpAwayName').textContent = AWAY;

    // ---------- team totals ----------
    const tot = { [HOME]: { xg: 0, sog: 0, att: 0, pen: 0 }, [AWAY]: { xg: 0, sog: 0, att: 0, pen: 0 } };
    for (const e of M.events) {
      const r = tot[e.t]; if (!r) continue;
      if (e.xg) r.xg += e.xg;
      if (e.ev === 'Goal') { r.sog++; r.att++; } else if (e.ev === 'Shot') { r.att++; if (e.d2 === 'On Net') r.sog++; } else if (e.ev === 'Penalty Taken') r.pen++;
    }
    const possF = PER.reduce((a, p) => [a[0] + (M.periods[p].poss || [0, 0])[0], a[1] + (M.periods[p].poss || [0, 0])[1]], [0, 0]);
    const ppc = { [HOME]: [0, 0], [AWAY]: [0, 0] };
    for (const w of M.pp || []) { ppc[w.team][0] += w.goals; ppc[w.team][1]++; }

    // ---------- headline ----------
    const W = score[HOME] > score[AWAY] ? HOME : AWAY, L = W === HOME ? AWAY : HOME;
    const ws = score[W], ls = score[L];
    const wpAll = PER.flatMap((p) => R.winProb.wp[p]);
    const winnerLow = Math.min(...wpAll.map((v) => (W === HOME ? v : 1 - v)));
    // a comeback means the winner actually trailed on the scoreboard, not just on win probability
    let diff = 0, worst = 0;
    for (const g of goals) { diff += g.t === W ? 1 : -1; worst = Math.min(worst, diff); }
    const comeback = worst <= -2 || (worst <= -1 && ws - ls < 3 && winnerLow < 0.25);
    let headline;
    if (so) headline = `${AWAY} and ${HOME} needed a shootout after ${score[HOME]}–${score[AWAY]}`;
    else if (ot) headline = `${W} won it in overtime, ${ws}–${ls}`;
    else if (comeback) headline = `${W} came back from ${-worst} down to beat ${L} ${ws}–${ls}`;
    else if (tot[W].xg < tot[L].xg - 0.3) headline = `${W} won ${ws}–${ls} despite losing the chance battle`;
    else if (ws - ls >= 3) headline = `${W} rolled past ${L}, ${ws}–${ls}`;
    else headline = `${W} beat ${L} ${ws}–${ls}`;
    $('rHeadline').textContent = headline;

    // ---------- win probability ----------
    const WPW = 900, WPH = 240, padL = 34, padR = 10, padT = 14, padB = 26;
    const total = PER.reduce((a, p) => a + LEN(p), 0);
    const tAt = (p, c) => PER.filter((q) => q < p).reduce((a, q) => a + LEN(q), 0) + (LEN(p) - c);
    const X = (s) => padL + (s / total) * (WPW - padL - padR);
    const Y = (v) => padT + (1 - v) * (WPH - padT - padB);
    let svg = '';
    for (const w of M.pp || []) {
      const x1 = X(tAt(w.p, w.start)), x2 = X(tAt(w.p, w.end));
      svg += `<rect x="${x1.toFixed(1)}" y="${padT}" width="${Math.max(1.5, x2 - x1).toFixed(1)}" height="${WPH - padT - padB}" fill="${CLR.gold}" opacity=".09"/>`;
    }
    for (const v of [0, 0.25, 0.5, 0.75, 1]) {
      svg += `<line x1="${padL}" x2="${WPW - padR}" y1="${Y(v)}" y2="${Y(v)}" stroke="${CLR.line}" stroke-width="1" ${v === 0.5 ? '' : 'stroke-dasharray="2 4"'}/>` +
        `<text x="${padL - 6}" y="${Y(v) + 4}" text-anchor="end" font-size="10" fill="${CLR.dim}">${Math.round(v * 100)}%</text>`;
    }
    let acc = 0;
    for (const p of PER) {
      if (acc) svg += `<line x1="${X(acc)}" x2="${X(acc)}" y1="${padT}" y2="${WPH - padB}" stroke="${CLR.line}"/>`;
      svg += `<text x="${X(acc + LEN(p) / 2)}" y="${WPH - 8}" text-anchor="middle" font-size="10" fill="${CLR.dim}" letter-spacing="1">${pName(p)}</text>`;
      acc += LEN(p);
    }
    const pts = [];
    for (const p of PER) {
      // sample every 3 s, but always keep the second before and of every goal so the jump lands on the dot
      const keep = new Set();
      for (const g of goals) if (g.p === p) { keep.add(LEN(p) - g.c); keep.add(LEN(p) - g.c - 1); }
      R.winProb.wp[p].forEach((v, i) => { if (i % 3 === 0 || keep.has(i) || i === R.winProb.wp[p].length - 1) pts.push(`${X(tAt(p, LEN(p) - i)).toFixed(1)},${Y(v).toFixed(1)}`); });
    }
    svg += `<path d="M${pts.join('L')}" fill="none" stroke="${CLR.text}" stroke-width="1.8" stroke-linejoin="round"/>`;
    for (const g of goals) {
      const v = R.winProb.wp[g.p][LEN(g.p) - g.c];
      svg += `<circle cx="${X(tAt(g.p, g.c)).toFixed(1)}" cy="${Y(v).toFixed(1)}" r="4.5" fill="${col(g.t)}" stroke="#0e1626" stroke-width="1.5"><title>Goal ${esc(g.t)} #${esc(g.pl)} · ${pName(g.p)} ${fmt(g.c)}</title></circle>`;
    }
    R.winProb.turning.forEach((t, i) => {
      const x = X(tAt(t.p, t.c)), y = Y(t.after);
      svg += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="9" fill="none" stroke="${CLR.gold}" stroke-width="1.5"/><text x="${x.toFixed(1)}" y="${(y - 13).toFixed(1)}" text-anchor="middle" font-size="11" font-weight="600" fill="${CLR.gold}">${i + 1}</text>`;
    });
    svg += `<line id="wpGuide" x1="0" x2="0" y1="${padT}" y2="${WPH - padB}" stroke="${CLR.gold}" stroke-width="1" opacity="0"/>`;
    $('wpChart').innerHTML = svg;
    const fin = R.winProb.outcome;
    $('wpNow').textContent = fin === 0.5 ? 'Decided in a shootout' : `Final: ${fin === 1 ? HOME : AWAY} 100%`;

    // hover readout
    const chart = $('wpChart'), tip = $('wpTip'), guide = $('wpGuide');
    chart.addEventListener('pointermove', (ev) => {
      const r = chart.getBoundingClientRect();
      const sx = ((ev.clientX - r.left) / r.width) * WPW;
      const s = Math.min(total, Math.max(0, ((sx - padL) / (WPW - padL - padR)) * total));
      let rem = s, p = PER[0];
      for (const q of PER) { if (rem <= LEN(q)) { p = q; break; } rem -= LEN(q); }
      const c = Math.round(LEN(p) - Math.min(rem, LEN(p)));
      const v = R.winProb.wp[p][LEN(p) - c];
      guide.setAttribute('x1', X(tAt(p, c))); guide.setAttribute('x2', X(tAt(p, c))); guide.setAttribute('opacity', '.8');
      tip.style.left = `${(X(tAt(p, c)) / WPW) * 100}%`;
      tip.innerHTML = `<b>${pName(p)} ${fmt(c)}</b> ${esc(HOME)} ${Math.round(v * 100)}% · ${esc(AWAY)} ${Math.round((1 - v) * 100)}%`;
      tip.classList.add('show');
    });
    chart.addEventListener('pointerleave', () => { tip.classList.remove('show'); guide.setAttribute('opacity', '0'); });

    $('turning').innerHTML = R.winProb.turning.map((t, i) => {
      const who = t.ev === 'Goal' ? `Goal #${esc(t.pl)} ${esc(t.t)}${t.d1 ? ' · ' + esc(t.d1.toLowerCase()) : ''}` : `Penalty #${esc(t.pl)} ${esc(t.t)}${t.d1 ? ' · ' + esc(t.d1.toLowerCase()) : ''}`;
      const homeBefore = Math.round(t.before * 100), homeAfter = Math.round(t.after * 100);
      const sign = t.delta >= 0 ? '+' : '−';
      return `<li><span class="tpn">${i + 1}</span><span class="tpt">${pName(t.p)} ${fmt(t.c)}</span>` +
        `<span class="tpw"><i class="dot" style="background:${col(t.t)}"></i>${who}</span>` +
        `<span class="tpd">${esc(HOME)} ${homeBefore}% → ${homeAfter}% <b>${sign}${Math.abs(Math.round(t.delta * 100))}</b></span>` +
        `<a class="pill" href="${momentLink(t.p, t.c)}">Watch this moment</a></li>`;
    }).join('');

    // ---------- team comparison ----------
    const sh = R.shape;
    const rows = [
      ['Expected goals', tot[AWAY].xg, tot[HOME].xg, (v) => v.toFixed(2)],
      ['Shots on goal', tot[AWAY].sog, tot[HOME].sog, String],
      ['Shot attempts', tot[AWAY].att, tot[HOME].att, String],
      ['Tracked possession', possF[1], possF[0], (v, o) => `${Math.round((v / Math.max(1, v + o)) * 100)}%`],
      ['Power plays', ppc[AWAY][0], ppc[HOME][0], (v, o, t) => `${ppc[t][0]}/${ppc[t][1]}`],
      ['Offensive-zone time', sh[AWAY].ozSeconds, sh[HOME].ozSeconds, (v) => fmt(v)],
      ['Team spacing', sh[AWAY].spacing, sh[HOME].spacing, (v) => (v == null ? '–' : `${v.toFixed(0)} ft`)],
      ['Reaction burst', sh[AWAY].react, sh[HOME].react, (v) => (v == null ? '–' : `+${(v * MPH).toFixed(1)} mph/s`)],
    ];
    const notes = { 'Tracked possession': 'nearest skater within 6 ft of the puck', 'Offensive-zone time': 'team has the puck in its attacking zone, tracked time', 'Team spacing': 'average gap between tracked teammates', 'Reaction burst': 'best 1-s speed gain in the 2 s after losing the puck', 'Power plays': 'goals / chances' };
    $('compare').innerHTML = rows.map(([label, a, h, f]) => {
      const av = a || 0, hv = h || 0, sum = av + hv || 1;
      return `<div class="cmprow"><span class="cmpv a">${f(a, h, AWAY)}</span><div class="cmpmid"><div class="cmplabel">${label}${notes[label] ? `<small>${notes[label]}</small>` : ''}</div>` +
        `<div class="cmpbar"><i class="a" style="width:${((av / sum) * 100).toFixed(1)}%"></i><i class="h" style="width:${((hv / sum) * 100).toFixed(1)}%"></i></div></div><span class="cmpv h">${f(h, a, HOME)}</span></div>`;
    }).join('');

    // ---------- movement ----------
    const players = Object.entries(R.players).map(([key, v]) => {
      const [team, j] = key.split('|');
      const min = v.frames / R.fps / 60;
      return {
        key, team, j, min, v,
        top: v.top != null ? v.top * MPH : null,
        acc: v.acc != null ? v.acc * MPH : null,
        b10: v.bursts / Math.max(min / 10, 1e-9),
        ftm: v.dist / Math.max(min, 1e-9),
        sprint: (v.zones[3] / Math.max(1, v.frames)) * 100,
        withm: v.with[0] > R.fps * 20 ? v.with[1] / (v.with[0] / R.fps / 60) : null,
        withoutm: v.without[0] > R.fps * 20 ? v.without[1] / (v.without[0] / R.fps / 60) : null,
      };
    }).filter((r) => r.min >= 2 && r.team !== 'undefined');
    const MV = { team: 'both', sort: 'top', dir: -1, sel: null };
    const cols = [
      ['j', '#'], ['min', 'Tracked'], ['top', 'Top speed'], ['acc', 'Burst accel'], ['b10', 'Bursts / 10 min'],
      ['ftm', 'Ft / min'], ['sprint', 'Sprint %'], ['withm', 'With puck'], ['withoutm', 'Without'],
    ];
    const cell = (k, r) => {
      const v = r[k];
      if (k === 'j') return `<i class="dot" style="background:${col(r.team)}"></i>${esc(r.j)}`;
      if (v == null || Number.isNaN(v)) return '–';
      if (k === 'min') return `${v.toFixed(1)} min`;
      if (k === 'top') return `${v.toFixed(1)} mph`;
      if (k === 'acc') return `+${v.toFixed(1)}`;
      if (k === 'b10') return v.toFixed(1);
      if (k === 'sprint') return `${v.toFixed(0)}%`;
      return Math.round(v).toLocaleString();
    };
    $('mvTeam').innerHTML = [['both', 'Both teams'], [AWAY, AWAY], [HOME, HOME]].map(([v, l]) => `<button data-v="${esc(v)}" class="${v === 'both' ? 'on' : ''}">${esc(l)}</button>`).join('');
    $('mvTeam').addEventListener('click', (ev) => {
      const b = ev.target.closest('button'); if (!b) return;
      MV.team = b.dataset.v;
      [...$('mvTeam').children].forEach((x) => x.classList.toggle('on', x === b));
      renderTable();
    });
    function renderTable() {
      const list = players.filter((r) => MV.team === 'both' || r.team === MV.team)
        .sort((a, b) => {
          const x = a[MV.sort], y = b[MV.sort];
          if (MV.sort === 'j') return MV.dir * ((+x) - (+y));
          return MV.dir * ((x ?? -1) - (y ?? -1));
        });
      $('mvTable').innerHTML = `<thead><tr>${cols.map(([k, l]) => `<th data-k="${k}" class="${MV.sort === k ? 'sorted' : ''}" aria-sort="${MV.sort === k ? (MV.dir < 0 ? 'descending' : 'ascending') : 'none'}"><button type="button">${l}${MV.sort === k ? (MV.dir < 0 ? ' ↓' : ' ↑') : ''}</button></th>`).join('')}</tr></thead>` +
        `<tbody>${list.map((r) => `<tr data-key="${esc(r.key)}" class="${MV.sel === r.key ? 'sel' : ''}" tabindex="0">${cols.map(([k]) => `<td>${cell(k, r)}</td>`).join('')}</tr>`).join('')}</tbody>`;
      if (!MV.sel && list.length) { MV.sel = list[0].key; renderTable(); return; }
      renderProfile();
    }
    $('mvTable').addEventListener('click', (ev) => {
      const th = ev.target.closest('th');
      if (th) { const k = th.dataset.k; MV.dir = MV.sort === k ? -MV.dir : -1; MV.sort = k; renderTable(); return; }
      const tr = ev.target.closest('tr[data-key]');
      if (tr) { MV.sel = tr.dataset.key; renderTable(); }
    });
    $('mvTable').addEventListener('keydown', (ev) => {
      const tr = ev.target.closest('tr[data-key]');
      if (tr && (ev.key === 'Enter' || ev.key === ' ')) { ev.preventDefault(); MV.sel = tr.dataset.key; renderTable(); }
    });

    function renderProfile() {
      const r = players.find((x) => x.key === MV.sel);
      if (!r) { $('profile').innerHTML = ''; return; }
      const z = r.v.zones, zt = Math.max(1, z.reduce((a, b) => a + b, 0));
      const zn = ['Standing', 'Cruising', 'Striding', 'Sprinting'], zc = ['#26344f', '#3d5a99', '#4a7dff', CLR.gold];
      const maxW = Math.max(r.withm || 0, r.withoutm || 0, 1);
      // shift entry speed across the game, with a least-squares trend line
      const E = r.v.entry.map(([p, start, v]) => ({ s: tAt(p, start), v: v * MPH, p, start }));
      let trend = '', decay = '';
      const EW = 320, EH = 110, ex = (s) => 8 + (s / total) * (EW - 16), vmin = Math.min(...E.map((e) => e.v), 8), vmax = Math.max(...E.map((e) => e.v), 16);
      const ey = (v) => EH - 10 - ((v - vmin) / Math.max(1, vmax - vmin)) * (EH - 24);
      if (E.length >= 4) {
        const n = E.length, mx = E.reduce((a, e) => a + e.s, 0) / n, my = E.reduce((a, e) => a + e.v, 0) / n;
        const b = E.reduce((a, e) => a + (e.s - mx) * (e.v - my), 0) / Math.max(1e-9, E.reduce((a, e) => a + (e.s - mx) ** 2, 0));
        const y0 = my + b * (0 - mx), y1 = my + b * (total - mx);
        trend = `<line x1="${ex(0)}" y1="${ey(y0)}" x2="${ex(total)}" y2="${ey(y1)}" stroke="${CLR.gold}" stroke-width="1.5" stroke-dasharray="4 4"/>`;
        const per20 = b * 1200;
        decay = per20 < -0.3 ? `Slows by ${Math.abs(per20).toFixed(1)} mph per 20 minutes at the start of shifts.` : per20 > 0.3 ? `Gets quicker as the game goes: +${per20.toFixed(1)} mph per 20 minutes.` : 'Holds the same shift-start speed all game.';
      } else decay = 'Not enough tracked shift starts to show a trend.';
      let acc2 = 0; let perLines = '';
      for (const p of PER) { if (acc2) perLines += `<line x1="${ex(acc2)}" x2="${ex(acc2)}" y1="4" y2="${EH - 6}" stroke="${CLR.line}" stroke-dasharray="2 3"/>`; acc2 += LEN(p); }
      $('profile').innerHTML = `
        <div class="phead"><span class="pname"><i class="dot" style="background:${col(r.team)}"></i>#${esc(r.j)} · ${esc(r.team)}</span><span class="pmin">${r.min.toFixed(1)} tracked min</span></div>
        <div class="pkpis">
          <div><div class="gl">Top speed</div><div class="kv">${r.top ? r.top.toFixed(1) : '–'}<small> mph</small></div></div>
          <div><div class="gl">Burst accel</div><div class="kv">${r.acc ? '+' + r.acc.toFixed(1) : '–'}<small> mph/s</small></div></div>
          <div><div class="gl">Bursts</div><div class="kv">${r.v.bursts}</div></div>
          <div><div class="gl">Ft / min</div><div class="kv">${Math.round(r.ftm)}</div></div>
        </div>
        <div class="gl ptitle">Speed zones</div>
        <div class="zbar">${z.map((v, i) => `<i style="width:${((v / zt) * 100).toFixed(1)}%;background:${zc[i]}" title="${zn[i]} ${Math.round((v / zt) * 100)}%"></i>`).join('')}</div>
        <div class="zlab">${z.map((v, i) => `<span${i === 3 ? ' class="gold"' : ''}>${zn[i]} ${Math.round((v / zt) * 100)}%</span>`).join('')}</div>
        <div class="gl ptitle">With vs without the puck <small>ft / min</small></div>
        <div class="wwrow"><span>Team has it</span><span class="wwbar"><i style="width:${(((r.withm || 0) / maxW) * 100).toFixed(1)}%;background:${col(r.team)}"></i></span><b>${r.withm ? Math.round(r.withm).toLocaleString() : '–'}</b></div>
        <div class="wwrow"><span>Opponent has it</span><span class="wwbar"><i style="width:${(((r.withoutm || 0) / maxW) * 100).toFixed(1)}%;background:${col(r.team)};opacity:.55"></i></span><b>${r.withoutm ? Math.round(r.withoutm).toLocaleString() : '–'}</b></div>
        <div class="gl ptitle">Shift-start speed <small>first 10 s of each shift</small></div>
        <svg viewBox="0 0 ${EW} ${EH}" class="entry" role="img" aria-label="Shift start speed across the game">${perLines}${E.map((e) => `<circle cx="${ex(e.s).toFixed(1)}" cy="${ey(e.v).toFixed(1)}" r="3.2" fill="${col(r.team)}"><title>${pName(e.p)} ${fmt(e.start)} · ${e.v.toFixed(1)} mph</title></circle>`).join('')}${trend}</svg>
        <p class="pnote">${decay}</p>`;
    }
    renderTable();

    // ---------- pass network ----------
    const PN = { team: AWAY, per: 'all' };
    $('pnTeam').innerHTML = [AWAY, HOME].map((t, i) => `<button data-v="${esc(t)}" class="${i ? '' : 'on'}">${esc(t)}</button>`).join('');
    $('pnPer').innerHTML = [['all', 'Game'], ...PER.map((p) => [String(p), pName(p)])].map(([v, l], i) => `<button data-v="${v}" class="${i ? '' : 'on'}">${l}</button>`).join('');
    const seg = (id, key) => $(id).addEventListener('click', (ev) => {
      const b = ev.target.closest('button'); if (!b) return;
      PN[key] = b.dataset.v;
      [...$(id).children].forEach((x) => x.classList.toggle('on', x === b));
      renderPN();
    });
    seg('pnTeam', 'team'); seg('pnPer', 'per');
    const rinkBase = (() => {
      const red = '#e8646a', blue = '#4a7dff';
      let s = `<defs><clipPath id="pnClip"><rect x="20" y="20" width="800" height="340" rx="112"/></clipPath></defs><rect x="20" y="20" width="800" height="340" rx="112" fill="#0d1626"/><g clip-path="url(#pnClip)" opacity=".8">`;
      for (const gx of [64, 776]) s += `<line x1="${gx}" y1="20" x2="${gx}" y2="360" stroke="${red}" opacity=".45"/>`;
      for (const bx of [320, 520]) s += `<rect x="${bx - 1.75}" y="20" width="3.5" height="340" fill="${blue}" opacity=".55"/>`;
      s += `<rect x="418.75" y="20" width="2.5" height="340" fill="${red}" opacity=".5"/>`;
      for (const fx of [144, 696]) for (const fy of [102, 278]) s += `<circle cx="${fx}" cy="${fy}" r="60" fill="none" stroke="${red}" stroke-opacity=".35"/>`;
      s += `<circle cx="420" cy="190" r="60" fill="none" stroke="${blue}" stroke-opacity=".4"/></g><rect x="20" y="20" width="800" height="340" rx="112" fill="none" stroke="#2a3a5a" stroke-width="2"/>`;
      return s;
    })();
    function renderPN() {
      const net = ((R.passes[PN.team] || {})[PN.per]) || { nodes: [], edges: [] };
      const pos = Object.fromEntries(net.nodes.map(([j, x, y, n]) => [j, { x: 420 + x * 4, y: 190 - y * 4, n }]));
      const maxE = Math.max(1, ...net.edges.map((e) => e[2])), maxN = Math.max(1, ...net.nodes.map((n) => n[3]));
      const minE = net.edges.length > 25 ? 2 : 1;
      const c = col(PN.team), txt = PN.team === HOME ? '#fff' : '#0b1220';
      let s = rinkBase;
      for (const [a, b, k] of [...net.edges].reverse()) {
        if (k < minE || !pos[a] || !pos[b]) continue;
        s += `<line class="pe" data-a="${esc(a)}" data-b="${esc(b)}" x1="${pos[a].x.toFixed(1)}" y1="${pos[a].y.toFixed(1)}" x2="${pos[b].x.toFixed(1)}" y2="${pos[b].y.toFixed(1)}" stroke="${c}" stroke-width="${(1 + (k / maxE) * 9).toFixed(1)}" stroke-linecap="round" opacity="${(0.25 + (k / maxE) * 0.6).toFixed(2)}"><title>#${esc(a)} ↔ #${esc(b)}: ${k} passes</title></line>`;
      }
      for (const [j, p] of Object.entries(pos)) {
        const r = 7 + (p.n / maxN) * 9;
        s += `<g class="pnode" data-j="${esc(j)}" tabindex="0" role="button" aria-label="#${esc(j)}: ${p.n} passes made or received. Show connections"><circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${r.toFixed(1)}" fill="${c}" stroke="#0a101d" stroke-width="1.5"/><text x="${p.x.toFixed(1)}" y="${(p.y + 3.5).toFixed(1)}" text-anchor="middle" font-size="${r > 11 ? 10 : 9}" font-weight="600" fill="${txt}" font-family="Inter, sans-serif">${esc(j)}</text><title>#${esc(j)}: ${p.n} passes made or received</title></g>`;
      }
      $('pnChart').innerHTML = s;
      PN.sel = null;
      PN.net = net;
      highlightPN(null);
    }

    // Hover (or tap / keyboard) a player: light up their connections in gold, fade everything else,
    // and switch the side list to who they pass with. Tapping again (or tapping the ice) clears it.
    function highlightPN(j) {
      const svg = $('pnChart'), net = PN.net || { edges: [] };
      if (!j) {
        svg.classList.remove('focus');
        svg.querySelectorAll('.pnode, .pe').forEach((el) => el.classList.remove('on'));
        $('pnTopTitle').textContent = 'Top connections';
        $('pnTop').innerHTML = net.edges.slice(0, 6).map(([a, b, k]) => `<li><span>#${esc(a)} ↔ #${esc(b)}</span><b>${k}</b></li>`).join('') || '<li><span>No completed passes logged.</span></li>';
        return;
      }
      const mates = new Set([j]);
      svg.classList.add('focus');
      svg.querySelectorAll('.pe').forEach((l) => {
        const on = l.dataset.a === j || l.dataset.b === j;
        l.classList.toggle('on', on);
        if (on) mates.add(l.dataset.a === j ? l.dataset.b : l.dataset.a);
      });
      svg.querySelectorAll('.pnode').forEach((g) => g.classList.toggle('on', mates.has(g.dataset.j)));
      const list = net.edges.filter(([a, b]) => a === j || b === j).map(([a, b, k]) => [a === j ? b : a, k]);
      const total = list.reduce((n, [, k]) => n + k, 0);
      $('pnTopTitle').textContent = `#${j} passes with · ${total} total`;
      $('pnTop').innerHTML = list.slice(0, 8).map(([m, k]) => `<li><span>#${esc(m)}</span><b>${k}</b></li>`).join('') || '<li><span>No completed passes.</span></li>';
    }
    const pnSvg = $('pnChart');
    pnSvg.addEventListener('pointerover', (ev) => {
      const g = ev.target.closest('.pnode');
      if (g && !PN.sel && ev.pointerType === 'mouse') highlightPN(g.dataset.j);
    });
    pnSvg.addEventListener('pointerleave', () => { if (!PN.sel) highlightPN(null); });
    pnSvg.addEventListener('click', (ev) => {
      const g = ev.target.closest('.pnode');
      PN.sel = g && PN.sel !== g.dataset.j ? g.dataset.j : null;
      highlightPN(PN.sel);
    });
    pnSvg.addEventListener('keydown', (ev) => {
      const g = ev.target.closest('.pnode');
      if (g && (ev.key === 'Enter' || ev.key === ' ')) { ev.preventDefault(); PN.sel = PN.sel === g.dataset.j ? null : g.dataset.j; highlightPN(PN.sel); }
      if (ev.key === 'Escape') { PN.sel = null; highlightPN(null); }
    });
    pnSvg.addEventListener('focusin', (ev) => { const g = ev.target.closest('.pnode'); if (g && !PN.sel) highlightPN(g.dataset.j); });
    renderPN();

    // ---------- share card ----------
    const cv = $('shareCanvas'), ctx = cv.getContext('2d');
    const drawCard = () => {
      const w = 1200, h = 630;
      ctx.fillStyle = '#0a101d'; ctx.fillRect(0, 0, w, h);
      ctx.strokeStyle = 'rgba(255,209,102,.45)'; ctx.lineWidth = 3; ctx.strokeRect(18, 18, w - 36, h - 36);
      ctx.fillStyle = CLR.text; ctx.font = '400 54px "Bebas Neue", Impact, sans-serif'; ctx.textBaseline = 'alphabetic';
      ctx.fillText('RINKSENSE', 70, 112);
      ctx.fillStyle = CLR.muted; ctx.font = '500 22px Inter, sans-serif';
      ctx.fillText(`${dateTxt.replace(/^\w+, /, '')} · ${AWAY} @ ${HOME} · ${$('rStatus').textContent}`, 70, 156);
      // headline, wrapped to two lines
      ctx.fillStyle = CLR.text; ctx.font = '600 52px Inter, sans-serif';
      const words = headline.split(' '); let line = '', y = 252; const lines = [];
      for (const wd of words) { const t = line ? line + ' ' + wd : wd; if (ctx.measureText(t).width > 760 && line) { lines.push(line); line = wd; } else line = t; }
      lines.push(line);
      lines.slice(0, 3).forEach((l, i) => ctx.fillText(l, 70, y + i * 64));
      // stat row
      const stats = [['xG', `${tot[AWAY].xg.toFixed(2)} – ${tot[HOME].xg.toFixed(2)}`], ['Shots', `${tot[AWAY].sog} – ${tot[HOME].sog}`],
        ['Possession', `${Math.round((possF[1] / Math.max(1, possF[0] + possF[1])) * 100)}% – ${Math.round((possF[0] / Math.max(1, possF[0] + possF[1])) * 100)}%`], ['Power plays', `${ppc[AWAY][0]}/${ppc[AWAY][1]} – ${ppc[HOME][0]}/${ppc[HOME][1]}`]];
      stats.forEach(([l, v], i) => {
        const x = 70 + i * 200;
        ctx.fillStyle = CLR.dim; ctx.font = '600 17px Inter, sans-serif'; ctx.fillText(l.toUpperCase(), x, 500);
        ctx.fillStyle = CLR.text; ctx.font = '400 30px Inter, sans-serif'; ctx.fillText(v, x, 540);
      });
      // win probability sparkline (right side)
      const bx = 870, by = 210, bw = 270, bh = 210;
      ctx.strokeStyle = CLR.line; ctx.lineWidth = 1; ctx.setLineDash([3, 5]);
      ctx.beginPath(); ctx.moveTo(bx, by + bh / 2); ctx.lineTo(bx + bw, by + bh / 2); ctx.stroke(); ctx.setLineDash([]);
      ctx.strokeStyle = CLR.text; ctx.lineWidth = 3; ctx.beginPath();
      let first = true;
      for (const p of PER) R.winProb.wp[p].forEach((v, i) => {
        if (i % 6) return;
        const x = bx + (tAt(p, LEN(p) - i) / total) * bw, yy = by + (1 - v) * bh;
        if (first) { ctx.moveTo(x, yy); first = false; } else ctx.lineTo(x, yy);
      });
      ctx.stroke();
      for (const g of goals) {
        const v = R.winProb.wp[g.p][LEN(g.p) - g.c];
        ctx.fillStyle = col(g.t); ctx.beginPath(); ctx.arc(bx + (tAt(g.p, g.c) / total) * bw, by + (1 - v) * bh, 7, 0, Math.PI * 2); ctx.fill();
      }
      ctx.fillStyle = CLR.dim; ctx.font = '600 15px Inter, sans-serif';
      ctx.fillText(`${HOME.toUpperCase()} WIN %`, bx, by - 14);
      ctx.fillStyle = CLR.muted; ctx.font = '500 18px Inter, sans-serif';
      ctx.fillText('Replay the game at RINKSENSE', 70, 590);
    };
    (document.fonts && document.fonts.load ? Promise.all([document.fonts.load('54px "Bebas Neue"'), document.fonts.load('600 52px Inter')]).catch(() => {}) : Promise.resolve()).then(drawCard);
    drawCard();
    $('shareText').textContent = `${headline}. xG ${tot[AWAY].xg.toFixed(2)}–${tot[HOME].xg.toFixed(2)}, shots ${tot[AWAY].sog}–${tot[HOME].sog}.`;
    const status = (m) => { $('shareStatus').textContent = m; };
    $('dlCard').addEventListener('click', () => {
      try {
        cv.toBlob((b) => {
          if (!b) { status('Could not create the image in this browser.'); return; }
          const a = document.createElement('a');
          a.href = URL.createObjectURL(b); a.download = `rinksense-${GAME_ID}.png`;
          document.body.appendChild(a); a.click(); a.remove();
          setTimeout(() => URL.revokeObjectURL(a.href), 2000);
          status('Image downloaded.');
        });
      } catch (e) { status('Could not create the image here. Right-click the card to save it instead.'); }
    });
    $('copyLink').addEventListener('click', () => {
      const url = location.href.split('#')[0];
      (navigator.clipboard && navigator.clipboard.writeText ? navigator.clipboard.writeText(url) : Promise.reject())
        .then(() => status('Report link copied.'), () => status(url));
    });

    window.RS_REPORT_PAGE = { players, headline, tot };   // test hook
  }
})();
