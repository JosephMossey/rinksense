/* RINKSENSE MLB replay: game.html?g=<pk>. Steps through a game pitch by pitch.
   Everything on screen is computed from steps 0..k only, so nothing ahead of the replay leaks. */
(() => {
  'use strict';
  const { color, ptName, esc, ord, pct, last, arrow, roundLabel, day } = window.RSM;
  const $ = (id) => document.getElementById(id);
  const pk = new URLSearchParams(location.search).get('g');

  const load = (src) => new Promise((ok, bad) => {
    const s = document.createElement('script');
    s.src = src; s.onload = ok; s.onerror = () => bad(new Error(src));
    document.head.appendChild(s);
  });
  const fail = (msg) => {
    $('pitchCard').innerHTML = `<p class="pnote">${msg} <a href="index.html" style="color:var(--gold)">Back to all games</a></p>`;
  };
  if (!pk || !/^\d+$/.test(pk)) { fail('No game picked.'); return; }
  load(`data/games/${pk}.js`).then(() => start(window.RS_MLB_GAME)).catch(() => fail('That game could not be loaded.'));

  const HITS = new Set(['single', 'double', 'triple', 'home_run']);
  const NON_PA = /caught_stealing|pickoff|stolen_base|wild_pitch|passed_ball|balk|other_advance|runner|defensive_indiff|other_out/;
  const NO_AB = new Set(['walk', 'intent_walk', 'hit_by_pitch', 'sac_fly', 'sac_bunt', 'catcher_interf', 'sac_fly_double_play', 'sac_bunt_double_play']);
  const SWING_MISS = new Set(['S', 'W', 'T', 'M', 'O']);
  const STRIKE = new Set(['C', 'S', 'W', 'T', 'M', 'O', 'F', 'L']);

  function start(G) {
    const S = G.steps, P = G.pas, N = S.length;
    const T = G.teams;
    const name = (id) => G.names[id] || `#${id}`;
    const abbr = (side) => T[side].abbr;
    const batSide = (pa) => (pa.top ? 'away' : 'home');
    let k = -1, playing = false, speed = 1, timer = null, zoneView = 'pa', boxTab = 'away';

    // ---------- static header ----------
    document.title = `${abbr('away')} @ ${abbr('home')} · ${roundLabel(G)} · RINKSENSE`;
    $('awayName').textContent = T.away.name; $('homeName').textContent = T.home.name;
    $('tabA').textContent = T.away.abbr; $('tabH').textContent = T.home.abbr;
    $('sprA').textContent = T.away.abbr; $('sprH').textContent = T.home.abbr;
    $('matchup').textContent = `${T.away.full} at ${T.home.full}`;
    $('gameinfo').textContent = `${roundLabel(G)} · ${day(G.date, { month: 'short', day: 'numeric', year: 'numeric' })} · ${G.venue}`;

    // ---------- derived state ----------
    const paDone = (pa) => pa.p1 <= k;
    const donePAs = () => P.filter(paDone);
    const wpAt = (i) => (i < 0 ? G.wp0 : S[i].wp);
    const isBatterPA = (pa) => !NON_PA.test(pa.et || '');

    // ---------- scoreboard ----------
    function drawBoard() {
      const s = S[k], pa = s ? P[s.a] : P[0];
      const sc = s ? s.sc : [0, 0];
      $('scoreA').textContent = sc[0]; $('scoreH').textContent = sc[1];
      const cnt = s ? s.cnt : [0, 0], outs = s ? Math.min(s.o, 3) : 0, bb = s ? s.bb : 0;
      $('count').textContent = `${cnt[0]}–${cnt[1]}`;
      $('outs').innerHTML = [0, 1].map((i) => `<i class="${i < outs ? 'on' : ''}"></i>`).join('') + (outs >= 3 ? '<i class="on"></i>' : '');
      [1, 2, 3].forEach((b) => $(`b${b}`).classList.toggle('on', !!(bb & (1 << (b - 1)))));
      let lab = 'Pregame';
      if (s) lab = s.o >= 3 && k === pa.p1 ? `${pa.top ? 'Mid' : 'End'} ${ord(pa.inn)}` : `${pa.top ? 'Top' : 'Bot'} ${ord(pa.inn)}`;
      if (k === N - 1) lab = `Final${G.innings !== 9 ? `/${G.innings}` : ''}`;
      $('innLabel').textContent = lab;
      $('pitchLabel').textContent = `Pitch ${S.slice(0, k + 1).filter((x) => x.t).length}`;
      drawLine();
    }

    function drawLine() {
      const halves = new Map(); // "inn-top" -> {r,h}
      let prev = [0, 0];
      for (const pa of P) {
        if (pa.p0 > k) break;
        const key = `${pa.inn}-${pa.top ? 1 : 0}`;
        if (!halves.has(key)) halves.set(key, { r: 0, h: 0 });
        const h = halves.get(key), bi = pa.top ? 0 : 1;
        const now = paDone(pa) ? pa.sc : S[k].sc;
        h.r += now[bi] - prev[bi];
        prev = now;
        if (paDone(pa) && HITS.has(pa.et)) h.h += 1;
      }
      const reached = P.filter((pa) => pa.p0 <= k).reduce((m, pa) => Math.max(m, pa.inn), 1);
      const cols = Math.max(9, reached);
      const curKey = k >= 0 && k < N - 1 ? `${P[S[k].a].inn}-${P[S[k].a].top ? 1 : 0}` : '';
      const halfOver = (inn, top) => {
        const nxt = P.find((pa) => pa.inn > inn || (pa.inn === inn && top && !pa.top));
        return k === N - 1 || (nxt && nxt.p0 <= k);
      };
      const row = (top) => {
        let R = 0, H = 0, E = 0, cells = '';
        for (let i = 1; i <= cols; i++) {
          const key = `${i}-${top ? 1 : 0}`, h = halves.get(key);
          if (h) { R += h.r; H += h.h; }
          // errors belong to the fielding team; reveal them once the half they happened in is over
          const fieldHalfTop = !top;
          if (G.line[i - 1] && halfOver(i, fieldHalfTop)) E += G.line[i - 1][top ? 'a' : 'h'][2];
          const skipBottom = !top && i >= 9 && k === N - 1 && !h;
          cells += `<td class="${key === curKey ? 'cur' : ''}">${h ? h.r : skipBottom && i === G.innings ? 'x' : ''}</td>`;
        }
        return `<tr><td>${esc(abbr(top ? 'away' : 'home'))}</td>${cells}<td class="tot sep">${R}</td><td class="tot">${H}</td><td class="tot">${E}</td></tr>`;
      };
      $('linescore').innerHTML = `<table><thead><tr><th></th>${Array.from({ length: cols }, (_, i) => `<th>${i + 1}</th>`).join('')}<th class="sep">R</th><th>H</th><th>E</th></tr></thead><tbody>${row(true)}${row(false)}</tbody></table>`;
    }

    // ---------- strike zone ----------
    const ZX = (x) => 150 + x * 64, ZY = (z) => 300 - (z - 0.3) * 64;
    function drawZone() {
      const s = S[k];
      const pa = s ? P[s.a] : P[0];
      let list = [];
      if (s) {
        if (zoneView === 'pa') list = S.slice(pa.p0, k + 1).map((p, i) => ({ p, n: i + 1 }));
        else list = S.slice(0, k + 1).filter((p) => p.pit === s.pit).map((p) => ({ p, n: 0 }));
      }
      list = list.filter((o) => o.p.t && o.p.x != null);
      const ref = list.length ? list[list.length - 1].p : null;
      const zt = ref && ref.zt ? ref.zt : 3.4, zb = ref && ref.zb ? ref.zb : 1.6;
      const hw = 17 / 24;
      let svg = `<rect x="0" y="0" width="300" height="330" fill="transparent"/>`;
      // thirds grid + zone
      for (let i = 1; i < 3; i++) {
        const x = ZX(-hw + (2 * hw * i) / 3), z = ZY(zb + ((zt - zb) * i) / 3);
        svg += `<line x1="${x}" y1="${ZY(zt)}" x2="${x}" y2="${ZY(zb)}" stroke="#1b2740"/><line x1="${ZX(-hw)}" y1="${z}" x2="${ZX(hw)}" y2="${z}" stroke="#1b2740"/>`;
      }
      svg += `<rect x="${ZX(-hw)}" y="${ZY(zt)}" width="${ZX(hw) - ZX(-hw)}" height="${ZY(zb) - ZY(zt)}" fill="none" stroke="#5a6883" stroke-width="1.5"/>`;
      svg += `<path d="M${ZX(-hw)},312 L${ZX(hw)},312 L${ZX(hw)},318 L150,326 L${ZX(-hw)},318 Z" fill="none" stroke="#26344f" stroke-width="1.5"/>`;
      if (s) svg += `<text x="${pa.bs === 'L' ? 286 : 14}" y="28" font-size="10" fill="#5a6883" text-anchor="${pa.bs === 'L' ? 'end' : 'start'}" letter-spacing="1.2">${pa.bs === 'L' ? 'LHB' : 'RHB'}</text>`;
      const r = zoneView === 'pa' ? 9 : 5;
      list.forEach(({ p, n }, i) => {
        const cur = i === list.length - 1;
        const cx = Math.max(6, Math.min(294, ZX(p.x))), cy = Math.max(6, Math.min(324, ZY(p.z)));
        const c = color(p.t);
        const op = zoneView === 'pit' && !cur ? 0.55 : 1;
        svg += `<circle cx="${cx}" cy="${cy}" r="${cur ? r + 1.5 : r}" fill="${c}" opacity="${op}" stroke="${cur ? '#ffd166' : '#0e1626'}" stroke-width="${cur ? 2.5 : 1}"><title>${esc(ptName(p.t))} ${p.v ?? ''} mph · ${esc(p.d)}</title></circle>`;
        if (n) svg += `<text x="${cx}" y="${cy + 3.5}" font-size="10" font-weight="600" fill="#0a101d" text-anchor="middle">${n}</text>`;
      });
      $('zone').innerHTML = svg;
      const types = [...new Set(S.slice(0, Math.max(k + 1, 0)).filter((p) => s && p.pit === s.pit && p.t).map((p) => p.t))];
      $('ptLegend').innerHTML = types.map((t) => `<span><i style="background:${color(t)}"></i>${esc(ptName(t))}</span>`).join('');
      $('zoneSub').textContent = zoneView === 'pa' ? "Catcher's view · this at-bat" : `Catcher's view · ${s ? esc(last(name(s.pit))) : ''} today`;
    }

    // ---------- matchup + pitch card ----------
    function batterToday(id, beforeStep) {
      let ab = 0, h = 0;
      for (const pa of P) {
        if (pa.p1 >= beforeStep) break;
        if (pa.bat !== id || !isBatterPA(pa)) continue;
        if (!NO_AB.has(pa.et)) ab++;
        if (HITS.has(pa.et)) h++;
      }
      return ab || h ? `${h}-for-${ab} today` : 'first PA today';
    }
    function drawMatchup() {
      const s = S[k];
      const pa = s ? P[s.a] : P[0];
      const thrown = S.slice(0, Math.max(k + 1, 0)).filter((p) => p.pit === pa.pit && p.t).length;
      $('matchupLine').innerHTML = `<span><b>${esc(name(pa.pit))}</b> ${pa.ph}HP · ${thrown} pitches</span>` +
        `<span><b>${esc(name(pa.bat))}</b> ${pa.bs}HB · ${batterToday(pa.bat, pa.p0)}</span>`;
    }

    function drawPitch() {
      const s = S[k];
      if (!s) {
        const pa = P[0];
        $('pitchCard').innerHTML = `<div class="pchead"><span class="ptname">First pitch</span><span class="pcall">${esc(T.away.abbr)} @ ${esc(T.home.abbr)}</span></div>
          <p class="pnote">${esc(name(pa.pit))} starts for ${esc(T.home.name)}. ${esc(name(pa.bat))} leads off for ${esc(T.away.name)}.</p>
          <p class="pnote dimmed">Press play or use the arrow keys. Win probability, the box score and every chart only show what has happened so far.</p>
          <div><span class="gl">Pregame win probability</span><div class="pv">${pct(G.wp0)}<small>${esc(T.home.abbr)}</small></div><div class="psub2">Home-field edge from the model, before any pitch</div></div>`;
        return;
      }
      const pa = P[s.a];
      if (!s.t) {
        $('pitchCard').innerHTML = `<div class="pchead"><span class="ptname">${esc(s.d || 'No pitch')}</span></div><p class="pnote">${esc(pa.desc)}</p>`;
        return;
      }
      const isEnd = k === pa.p1;
      const callCls = SWING_MISS.has(s.c) ? 'hl' : STRIKE.has(s.c) ? 'strike' : '';
      const dv = s.dv == null ? '' : `<span class="${s.dv >= 0 ? 'up' : 'down'}">${s.dv >= 0 ? '+' : '−'}${Math.abs(s.dv).toFixed(1)}</span> vs his season avg`;
      const prev = S[k - 1] && S[k - 1].a === s.a && S[k - 1].t ? S[k - 1] : null;
      let tun = '';
      if (s.tu && prev) {
        const [dec, pl] = s.tu, mx = Math.max(24, pl, dec) * 1.1;
        const good = dec <= 6 && pl >= 10 && prev.t !== s.t;
        tun = `<div class="tunnel"><div class="pchead"><span class="gl">Tunnel vs pitch ${k - pa.p0} (${esc(ptName(prev.t))})</span></div>
          <div class="tbar"><div class="ln"></div><span class="mk dec" style="left:${(dec / mx) * 100}%"></span><span class="mk pl" style="left:${(pl / mx) * 100}%"></span></div>
          <div class="tlabels"><span>Apart at decision point <b>${dec.toFixed(1)} in</b></span><span>at the plate <b>${pl.toFixed(1)} in</b></span></div>
          <p class="pnote" style="margin:6px 0 0">${good ? 'Strong tunnel: the two pitches looked almost the same when the hitter had to decide, then split apart.' : prev.t === s.t ? 'Same pitch type back to back.' : dec > 10 ? 'Different looks out of the hand: easy to tell apart early.' : 'Similar early path, small split at the plate.'}</p></div>`;
      }
      const res = isEnd ? `<p class="pnote"><b style="color:var(--text);font-weight:500">${esc(pa.ev)}.</b> ${esc(pa.desc)}</p>` : '';
      const notes = (s.n || []).map((n) => `<p class="pnote dimmed" style="margin:0">${esc(n)}</p>`).join('');
      $('pitchCard').innerHTML = `${notes}<div class="pchead"><span class="ptname"><i style="background:${color(s.t)}"></i>${esc(ptName(s.t))}</span><span class="pcall ${callCls}">Pitch ${k - pa.p0 + 1} · ${esc(s.d)}</span></div>
        <div class="pgrid">
          <div><span class="gl">Velo</span><div class="pv">${s.v ?? '–'}<small>mph</small></div><div class="psub2">${dv}</div></div>
          <div><span class="gl">Spin</span><div class="pv">${s.s ?? '–'}<small>rpm</small></div></div>
          <div><span class="gl">Movement</span><div class="pv" style="font-size:20px">${s.iv != null ? s.iv.toFixed(0) : '–'}<small>in rise</small> ${s.hb != null ? Math.abs(s.hb).toFixed(0) : '–'}<small>in ${s.hb != null && s.hb < 0 ? 'glove' : 'arm'} side</small></div><div class="psub2">Induced vertical · horizontal break</div></div>
          <div><span class="gl">Stuff+</span><div class="pv" style="${s.st >= 115 ? 'color:var(--gold)' : ''}">${s.st ?? '–'}</div><div class="psub2">${s.xw != null ? `xWhiff ${s.xw}% if swung at` : ''}</div></div>
        </div>${tun}${res}`;
    }

    // ---------- result banner ----------
    let bannerT = null;
    function banner() {
      const s = S[k];
      const el = $('resBanner');
      if (!s || k !== P[s.a].p1 || !playing) { el.classList.remove('show'); return; }
      const pa = P[s.a];
      let word = '';
      if (pa.et === 'home_run') word = (pa.rbi === 4 ? 'GRAND SLAM' : 'HOME RUN');
      if (k === N - 1 && !pa.top && pa.sc[1] > pa.sc[0]) word = 'WALK-OFF';
      if (!word) { el.classList.remove('show'); return; }
      $('resWord').textContent = word;
      $('resWho').textContent = name(pa.bat);
      $('resWhat').textContent = pa.hit ? `${pa.hit.ev} mph · ${pa.hit.la}° · ${pa.hit.d ?? '–'} ft` : pa.ev;
      el.classList.add('show');
      clearTimeout(bannerT);
      bannerT = setTimeout(() => el.classList.remove('show'), 2600 / speed);
    }

    // ---------- win probability ----------
    const WX = (i) => ((i + 1) / N) * 800, WY = (p) => 8 + (1 - p) * 134;
    function drawWP() {
      let svg = `<line x1="0" y1="${WY(0.5)}" x2="800" y2="${WY(0.5)}" stroke="#26344f" stroke-dasharray="4 5" vector-effect="non-scaling-stroke"/>`;
      let labels = `<span class="wl" style="top:6px;left:4px">${esc(abbr('home'))} 100%</span><span class="wl" style="bottom:12px;left:4px">${esc(abbr('away'))} 100%</span>`;
      // inning markers up to now
      let lastInn = 0;
      for (const pa of P) {
        if (pa.p0 > k) break;
        if (pa.inn !== lastInn && pa.top) {
          lastInn = pa.inn;
          const x = WX(pa.p0 - 1);
          svg += `<line x1="${x}" y1="8" x2="${x}" y2="142" stroke="#152036" vector-effect="non-scaling-stroke"/>`;
          labels += `<span class="wl inn" style="left:${(x / 800) * 100}%">${pa.inn}</span>`;
        }
      }
      const pts = [[WX(-1), WY(G.wp0)]];
      for (let i = 0; i <= k; i++) pts.push([WX(i), WY(S[i].wp)]);
      const line = pts.map((p) => p.map((v) => v.toFixed(1)).join(',')).join(' ');
      const endX = pts[pts.length - 1][0];
      svg += `<defs><clipPath id="wpT"><rect x="0" y="0" width="800" height="${WY(0.5)}"/></clipPath><clipPath id="wpB"><rect x="0" y="${WY(0.5)}" width="800" height="150"/></clipPath></defs>`;
      svg += `<polygon points="0,${WY(0.5)} ${line} ${endX},${WY(0.5)}" fill="rgba(47,107,255,.2)" clip-path="url(#wpT)"/>`;
      svg += `<polygon points="0,${WY(0.5)} ${line} ${endX},${WY(0.5)}" fill="rgba(255,138,128,.18)" clip-path="url(#wpB)"/>`;
      svg += `<polyline points="${line}" fill="none" stroke="#e6ecf7" stroke-width="1.6" vector-effect="non-scaling-stroke"/>`;
      for (const i of G.turning) {
        const pa = P[i];
        if (pa.p1 <= k) svg += `<circle cx="${WX(pa.p1)}" cy="${WY(pa.wp1)}" r="3.5" fill="#ffd166"/>`;
      }
      const [ex, ey] = pts[pts.length - 1];
      svg += `<circle cx="${ex}" cy="${ey}" r="4" fill="#ffd166" stroke="#0e1626" stroke-width="1.5"/>`;
      $('wpSvg').innerHTML = svg;
      $('wpLabels').innerHTML = labels;
      const w = wpAt(k);
      $('wpNow').innerHTML = `<b style="color:var(--teamD)">${esc(abbr('home'))} ${pct(w)}</b> · <b style="color:var(--teamA)">${esc(abbr('away'))} ${pct(1 - w)}</b>`;
      const tps = G.turning.map((i) => P[i]).filter(paDone).sort((a, b) => a.p1 - b.p1);
      $('tpList').innerHTML = tps.length ? tps.map((pa) => {
        const d = pa.wp1 - pa.wp0, side = d >= 0 ? 'home' : 'away';
        return `<li data-step="${pa.p1}"><span class="tpi">${arrow(pa.top)}${pa.inn}</span><span>${esc(pa.desc)}</span><span class="tpd" style="color:var(--${side === 'home' ? 'teamD' : 'teamA'})">${esc(abbr(side))} +${Math.round(Math.abs(d) * 100)}%</span></li>`;
      }).join('') : '<li class="empty">None yet. The six biggest swings of the game show up here once they happen.</li>';
    }

    // ---------- spray chart ----------
    const FIELD = `<path d="M125.4,198.3 L32,105 Q125.4,-29 218.8,105 Z" fill="#0f2419" stroke="#1d4a35" stroke-width="1"/>
      <path d="M125.4,198.3 L95,168 A43,43 0 0 1 155.8,168 Z" fill="#2a2418" opacity=".85"/>
      <path d="M125.4,198.3 L150.9,172.8 L125.4,147.3 L99.9,172.8 Z" fill="#0f2419" stroke="#3a3322" stroke-width=".8"/>
      <line x1="125.4" y1="198.3" x2="32" y2="105" stroke="#3a5a4a" stroke-width=".8"/><line x1="125.4" y1="198.3" x2="218.8" y2="105" stroke="#3a5a4a" stroke-width=".8"/>`;
    function drawSpray() {
      const balls = P.filter((pa) => pa.hit && pa.hit.x != null && paDone(pa));
      let svg = FIELD;
      balls.forEach((pa, i) => {
        const cur = i === balls.length - 1 && pa.p1 === k;
        const c = pa.top ? '#ff8a80' : '#2f6bff';
        const hit = HITS.has(pa.et);
        svg += `<circle cx="${pa.hit.x}" cy="${pa.hit.y}" r="${cur ? 5 : 3.4}" fill="${hit ? c : 'none'}" stroke="${cur ? '#ffd166' : c}" stroke-width="${cur ? 2 : 1.2}" opacity="${cur ? 1 : 0.85}"><title>${esc(name(pa.bat))}: ${esc(pa.ev)}, ${pa.hit.ev} mph, ${pa.hit.la}°</title></circle>`;
      });
      $('spray').innerHTML = svg;
      const lb = balls[balls.length - 1];
      $('bbLine').innerHTML = lb ? `<b>${esc(name(lb.bat))}</b> · ${esc(lb.ev)} · ${lb.hit.ev} mph, ${lb.hit.la}°${lb.hit.d ? `, ${lb.hit.d} ft` : ''}<br>` +
        `<span class="x">xBA ${lb.hit.xba.toFixed(3).replace(/^0/, '')}</span> · xwOBA ${lb.hit.xw.toFixed(3).replace(/^0/, '')}${lb.hit.hr >= 0.05 ? ` · HR chance ${Math.round(lb.hit.hr * 100)}%` : ''}`
        : '<span style="color:var(--dim)">No balls in play yet.</span>';
    }

    // ---------- bullpen decisions ----------
    function drawDecisions() {
      const ds = G.decisions.filter((d) => d.step <= k).reverse();
      if (!ds.length) { $('decList').innerHTML = '<li class="empty">No pitching changes yet. Each one gets graded here: was it the right call with what the manager knew, and how did it turn out?</li>'; return; }
      const grade = (v) => (v > 0.0025 ? 'good' : v < -0.0025 ? 'bad' : 'meh');
      const sgn = (v) => `${v >= 0 ? '+' : '−'}${Math.abs(v * 100).toFixed(1)}%`;
      $('decList').innerHTML = ds.map((d) => {
        const done = k > d.endStep || k === N - 1;
        const why = [`${d.pitches} pitches`, `${ord(d.trip)} time through`];
        if (d.fbdv != null) why.push(`fastball ${d.fbdv >= 0 ? '+' : '−'}${Math.abs(d.fbdv).toFixed(1)} mph vs season`);
        if (d.stuff != null) why.push(`Stuff+ ${d.stuff} lately`);
        const base = ['empty', '1B', '2B', '1B+2B', '3B', '1B+3B', '2B+3B', 'loaded'][d.b[0] + 2 * d.b[1] + 4 * d.b[2]];
        return `<li><div class="dtop"><span class="who">${esc(last(name(d.out)))} → ${esc(last(name(d.in)))}</span><span class="when">${arrow(d.top)}${d.inn} · ${d.outs} out · ${base}</span></div>
          <div class="dwhy">${esc(abbr(d.side))} pulls ${esc(last(name(d.out)))} after ${why.join(', ')}. Next 3 batters, projected xwOBA: ${esc(last(name(d.out)))} ${d.xw_out.toFixed(3).replace(/^0/, '')} vs ${esc(last(name(d.in)))} ${d.xw_in.toFixed(3).replace(/^0/, '')}.</div>
          <div class="dgrades"><span class="dg">Process<b class="${grade(d.proc)}">${grade(d.proc) === 'meh' ? 'toss-up' : sgn(d.proc)}</b></span>
          <span class="dg">Result<b class="${done ? grade(d.res) : ''}">${done ? sgn(d.res) : 'in progress'}</b></span>
          <span class="dg">1 run is worth<b class="meh">${Math.round(d.runwp * 100)}%</b></span></div></li>`;
      }).join('');
    }

    // ---------- box score ----------
    function drawBox() {
      const done = donePAs();
      if (boxTab === 'pit') {
        const rows = { away: new Map(), home: new Map() };
        const ensure = (side, id) => {
          if (!rows[side].has(id)) rows[side].set(id, { outs: 0, p: 0, h: 0, bb: 0, k: 0, wh: 0, top: 0, st: [] });
          return rows[side].get(id);
        };
        for (let i = 0; i <= k; i++) {
          const s = S[i]; if (!s.t) continue;
          const side = P[s.a].top ? 'home' : 'away', r = ensure(side, s.pit);
          r.p++; if (SWING_MISS.has(s.c)) r.wh++; if (s.v > r.top) r.top = s.v; if (s.st != null) r.st.push(s.st);
        }
        let prevOuts = 0, prevHalf = '';
        for (const pa of done) {
          const half = `${pa.inn}${pa.top}`;
          if (half !== prevHalf) { prevOuts = 0; prevHalf = half; }
          const r = ensure(pa.top ? 'home' : 'away', pa.pit);
          r.outs += Math.max(0, Math.min(pa.o, 3) - prevOuts); prevOuts = Math.min(pa.o, 3);
          if (HITS.has(pa.et)) r.h++;
          if (pa.et === 'walk' || pa.et === 'intent_walk') r.bb++;
          if (/strikeout/.test(pa.et)) r.k++;
        }
        const ip = (o) => `${Math.floor(o / 3)}.${o % 3}`;
        let html = '<thead><tr><th>Pitcher</th><th>IP</th><th>P</th><th>H</th><th>BB</th><th>K</th><th>Whf</th><th>Top</th><th>Stf+</th></tr></thead><tbody>';
        for (const side of ['away', 'home']) {
          html += `<tr class="thead"><td colspan="9"><i style="background:var(--${side === 'home' ? 'teamD' : 'teamA'})"></i>${esc(T[side].name)}</td></tr>`;
          for (const [id, r] of rows[side]) {
            const st = r.st.length ? Math.round(r.st.reduce((a, b) => a + b, 0) / r.st.length) : '–';
            html += `<tr><td title="${esc(name(id))}">${esc(last(name(id)))}</td><td>${ip(r.outs)}</td><td>${r.p}</td><td>${r.h}</td><td>${r.bb}</td><td>${r.k}</td><td>${r.wh}</td><td>${r.top ? r.top.toFixed(1) : '–'}</td><td class="${st >= 115 ? 'hl' : ''}">${st}</td></tr>`;
          }
          if (!rows[side].size) html += '<tr><td colspan="9" class="mvempty">No pitches yet.</td></tr>';
        }
        $('boxTable').innerHTML = html + '</tbody>';
        return;
      }
      const side = boxTab, top = side === 'away';
      const rows = new Map();
      for (const pa of P) {
        if (pa.top !== top || pa.p0 > k) continue;
        if (!rows.has(pa.bat)) rows.set(pa.bat, { pa: 0, ab: 0, h: 0, hr: 0, rbi: 0, bb: 0, k: 0, xw: [] });
        if (!paDone(pa) || !isBatterPA(pa)) continue;
        const r = rows.get(pa.bat);
        r.pa++; if (!NO_AB.has(pa.et)) r.ab++;
        if (HITS.has(pa.et)) r.h++;
        if (pa.et === 'home_run') r.hr++;
        r.rbi += pa.rbi || 0;
        if (pa.et === 'walk' || pa.et === 'intent_walk') r.bb++;
        if (/strikeout/.test(pa.et)) r.k++;
        if (pa.xw != null) r.xw.push(pa.xw);
      }
      let html = '<thead><tr><th>Batter</th><th>AB</th><th>H</th><th>HR</th><th>RBI</th><th>BB</th><th>K</th><th>xwOBA</th></tr></thead><tbody>';
      for (const [id, r] of rows) {
        const xw = r.xw.length ? (r.xw.reduce((a, b) => a + b, 0) / r.xw.length).toFixed(3).replace(/^0/, '') : '–';
        html += `<tr><td title="${esc(name(id))}">${esc(last(name(id)))}</td><td>${r.ab}</td><td class="${r.h ? 'hl' : ''}">${r.h}</td><td>${r.hr}</td><td>${r.rbi}</td><td>${r.bb}</td><td>${r.k}</td><td>${xw}</td></tr>`;
      }
      if (!rows.size) html += '<tr><td colspan="8" class="mvempty">Hasn\'t batted yet.</td></tr>';
      $('boxTable').innerHTML = html + '</tbody>';
    }

    // ---------- play-by-play ----------
    function drawPBP() {
      const items = [];
      for (const pa of P) {
        if (pa.p0 > k) break;
        for (let i = pa.p0; i <= Math.min(pa.p1, k); i++) for (const n of S[i].n || []) if (/Pitching Change/i.test(n)) items.push({ note: n, step: i });
        if (paDone(pa)) items.push({ pa });
      }
      const recent = items.slice(-80).reverse();
      $('pbpList').innerHTML = recent.length ? recent.map((it) => {
        if (it.note) return `<li data-step="${it.step}"><span class="t">·</span><span class="what" style="color:var(--dim)">${esc(it.note)}</span></li>`;
        const pa = it.pa, d = (pa.wp1 - pa.wp0) * (pa.top ? -1 : 1);
        const big = Math.abs(d) >= 0.1;
        return `<li data-step="${pa.p1}" class="${big ? 'big' : ''}"><span class="t">${arrow(pa.top)}${pa.inn}</span><span class="b" style="background:var(--${pa.top ? 'teamA' : 'teamD'})"></span><span class="what">${esc(pa.desc)}</span><span class="wpd">${d >= 0 ? '+' : '−'}${Math.abs(Math.round(d * 100))}%</span></li>`;
      }).join('') : '<li class="empty">PLAY BALL</li>';
    }

    // ---------- scrubber ----------
    function drawScrub() {
      const f = N ? (k + 1) / N : 0;
      $('fill').style.width = `${f * 100}%`;
      $('knob').style.left = `${f * 100}%`;
      $('stepLabel').textContent = `${k + 1} / ${N}`;
      let ticks = '', lastInn = 0;
      for (const pa of P) {
        if (pa.p0 > k) break;
        if (pa.inn !== lastInn && pa.top) { lastInn = pa.inn; if (pa.p0 > 0) ticks += `<span class="tick inn" style="left:${(pa.p0 / N) * 100}%"></span>`; }
      }
      for (const i of G.turning) if (P[i].p1 <= k) ticks += `<span class="tick tp" style="left:${((P[i].p1 + 1) / N) * 100}%"></span>`;
      $('ticks').innerHTML = ticks;
    }

    // ---------- render + controls ----------
    function render() {
      drawBoard(); drawZone(); drawMatchup(); drawPitch(); drawWP(); drawSpray(); drawDecisions(); drawBox(); drawPBP(); drawScrub(); banner();
    }
    function setStep(i) {
      k = Math.max(-1, Math.min(N - 1, i));
      render();
      if (k === N - 1) pause();
    }
    const delay = () => {
      const s = S[k], nx = S[k + 1];
      let ms = 1300;
      if (s && k === P[s.a].p1) ms += 900;
      if (s && nx && P[nx.a].top !== P[s.a].top) ms += 1100;
      if (s && P[s.a].et === 'home_run' && k === P[s.a].p1) ms += 1400;
      return ms / speed;
    };
    function tickPlay() { if (!playing) return; setStep(k + 1); if (playing) timer = setTimeout(tickPlay, delay()); }
    function play() {
      if (k >= N - 1) k = -1;
      playing = true; $('playIcon').innerHTML = '<path d="M7 5h4v14H7zM13 5h4v14h-4z"/>'; $('playBtn').setAttribute('aria-label', 'Pause');
      timer = setTimeout(tickPlay, 250);
    }
    function pause() {
      playing = false; clearTimeout(timer);
      $('playIcon').innerHTML = '<path d="M8 5v14l11-7z"/>'; $('playBtn').setAttribute('aria-label', 'Play');
    }
    $('playBtn').addEventListener('click', () => (playing ? pause() : play()));
    $('prevBtn').addEventListener('click', () => { pause(); setStep(k - 1); });
    $('nextBtn').addEventListener('click', () => { pause(); setStep(k + 1); });
    const curPA = () => (k < 0 ? -1 : S[k].a);
    $('nextPA').addEventListener('click', () => {
      pause();
      const a = curPA();
      if (a >= 0 && k < P[a].p1) setStep(P[a].p1); else if (a + 1 < P.length) setStep(P[a + 1].p1);
    });
    $('prevPA').addEventListener('click', () => { pause(); const a = curPA(); setStep(a <= 0 ? -1 : P[a - 1].p1); });
    $('nextHalf').addEventListener('click', () => {
      pause();
      const a = Math.max(curPA(), 0), cur = P[a];
      const nx = P.find((pa) => pa.i > a && (pa.inn !== cur.inn || pa.top !== cur.top));
      setStep(nx ? nx.p0 - 1 : N - 1);
    });
    document.querySelectorAll('[data-speed]').forEach((b) => b.addEventListener('click', () => {
      speed = +b.dataset.speed;
      document.querySelectorAll('[data-speed]').forEach((x) => x.classList.toggle('on', x === b));
    }));
    document.querySelectorAll('[data-zv]').forEach((b) => b.addEventListener('click', () => {
      zoneView = b.dataset.zv;
      document.querySelectorAll('[data-zv]').forEach((x) => x.classList.toggle('on', x === b));
      drawZone();
    }));
    document.querySelectorAll('[data-box]').forEach((b) => b.addEventListener('click', () => {
      boxTab = b.dataset.box;
      document.querySelectorAll('[data-box]').forEach((x) => x.classList.toggle('on', x === b));
      drawBox();
    }));
    const scrubTo = (e) => {
      const r = $('scrub').getBoundingClientRect();
      const f = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
      setStep(Math.round(f * N) - 1);
    };
    let dragging = false;
    $('scrub').addEventListener('pointerdown', (e) => { pause(); dragging = true; $('scrub').setPointerCapture(e.pointerId); scrubTo(e); });
    $('scrub').addEventListener('pointermove', (e) => { if (dragging) scrubTo(e); });
    $('scrub').addEventListener('pointerup', () => { dragging = false; });
    $('wpSvg').addEventListener('click', (e) => {
      const r = $('wpSvg').getBoundingClientRect();
      const i = Math.round(((e.clientX - r.left) / r.width) * N) - 1;
      if (i <= k) { pause(); setStep(i); }   // only jump back: the chart never reveals the future
    });
    const jump = (e) => { const li = e.target.closest('[data-step]'); if (li) { pause(); setStep(+li.dataset.step); } };
    $('tpList').addEventListener('click', jump);
    $('pbpList').addEventListener('click', jump);
    document.addEventListener('keydown', (e) => {
      if (e.target.closest('input, select, textarea')) return;
      if (e.key === ' ') { e.preventDefault(); playing ? pause() : play(); }
      else if (e.key === 'ArrowRight') { pause(); e.shiftKey ? $('nextPA').click() : setStep(k + 1); }
      else if (e.key === 'ArrowLeft') { pause(); e.shiftKey ? $('prevPA').click() : setStep(k - 1); }
    });

    const h = location.hash.match(/^#s-(\d+)$/);
    setStep(h ? +h[1] : -1);
    window.RS_MLB = {
      N, get step() { return k; }, setStep, play, pause,
      state: () => ({ score: k >= 0 ? S[k].sc : [0, 0], wp: wpAt(k), decisionsShown: G.decisions.filter((d) => d.step <= k).length }),
      final: G.final,
    };
  }
})();
