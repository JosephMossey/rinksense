/* RINKSENSE viewer: SVG rink + requestAnimationFrame playback over preprocessed tracking data. */
(() => {
  'use strict';

  const META = window.RS_META;
  const HOME = META.home, AWAY = META.away;            // "Team D", "Team A"
  const SVGNS = 'http://www.w3.org/2000/svg';
  const CARRIER_MAX_FT = 8;      // nearest skater only counts as the carrier within this distance
  const BANNER_SECONDS = 6;      // how long the GOAL banner stays up (tracking time)
  const PUCK_HOLD_FRAMES = 8;    // bridge short gaps where the puck isn't tracked
  const COLORS = { [HOME]: { fill: '#2f6bff', text: '#ffffff' }, [AWAY]: { fill: '#ff8a80', text: '#0b1220' } };

  const $ = (id) => document.getElementById(id);
  const px = (x) => 420 + x * 4;
  const py = (y) => 190 - y * 4;
  const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  const svgEl = (tag, attrs, parent) => {
    const el = document.createElementNS(SVGNS, tag);
    for (const k in attrs) el.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(el);
    return el;
  };

  // ---------- state ----------
  const S = { period: 1, pos: 0, playing: false, speed: 1, data: {}, last: 0, key: '', dragging: false };
  const events = META.events;   // sorted by (period, frame)

  // ---------- data loading (script tags so file:// works too) ----------
  const loading = {};
  function loadPeriod(p) {
    if (S.data[p]) return Promise.resolve(S.data[p]);
    if (!loading[p]) {
      loading[p] = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = `data/p${p}.js`;
        s.onload = () => { S.data[p] = window[`RS_P${p}`]; resolve(S.data[p]); };
        s.onerror = () => reject(new Error(`could not load data/p${p}.js`));
        document.head.appendChild(s);
      });
    }
    return loading[p];
  }

  // ---------- rink ----------
  function drawRink() {
    const g = $('rinkLines');
    svgEl('rect', { x: 20, y: 20, width: 800, height: 340, rx: 112, fill: '#0f1930' }, g);
    const c = svgEl('g', { 'clip-path': 'url(#boards)' }, g);
    const red = '#e8646a', blue = '#2f6bff';
    // creases
    for (const gx of [64, 776]) {
      const dir = gx < 420 ? 1 : 0;
      svgEl('path', { d: `M${gx},166 A24,24 0 0 ${dir} ${gx},214 Z`, fill: 'rgba(47,107,255,.22)', stroke: red, 'stroke-width': 1.5 }, c);
      const nx = gx < 420 ? gx - 13 : gx;
      svgEl('rect', { x: nx, y: 178, width: 13, height: 24, fill: 'none', stroke: '#9fb0cf', 'stroke-width': 1.5 }, c);
    }
    // goal lines, blue lines, red line
    for (const gx of [64, 776]) svgEl('line', { x1: gx, y1: 20, x2: gx, y2: 360, stroke: red, 'stroke-width': 1.5, opacity: .8 }, c);
    for (const bx of [320, 520]) svgEl('rect', { x: bx - 2.5, y: 20, width: 5, height: 340, fill: blue }, c);
    svgEl('rect', { x: 418, y: 20, width: 4, height: 340, fill: red }, c);
    // faceoff circles + dots
    for (const fx of [144, 696]) for (const fy of [102, 278]) {
      svgEl('circle', { cx: fx, cy: fy, r: 60, fill: 'none', stroke: red, 'stroke-width': 2 }, c);
      svgEl('circle', { cx: fx, cy: fy, r: 5, fill: red }, c);
    }
    for (const fx of [340, 500]) for (const fy of [102, 278]) svgEl('circle', { cx: fx, cy: fy, r: 4, fill: red }, c);
    svgEl('circle', { cx: 420, cy: 190, r: 60, fill: 'none', stroke: blue, 'stroke-width': 2 }, c);
    svgEl('circle', { cx: 420, cy: 190, r: 4, fill: blue }, c);
    svgEl('rect', { x: 20, y: 20, width: 800, height: 340, rx: 112, fill: 'none', stroke: '#3b4d72', 'stroke-width': 3 }, g);
  }

  // ---------- players / puck ----------
  const pool = new Map();   // key "team|jersey" -> {g, ring, glow}
  const playersLayer = $('players');
  const puck = svgEl('circle', { r: 4.5, fill: '#000', stroke: '#fff', 'stroke-width': 2, visibility: 'hidden' }, $('puckLayer'));

  function token(team, jersey) {
    const key = team + '|' + jersey;
    let t = pool.get(key);
    if (t) return t;
    const g = svgEl('g', {}, playersLayer);
    const glow = svgEl('circle', { r: 17, fill: '#ffd166', opacity: .32, filter: 'url(#glow)', visibility: 'hidden' }, g);
    const ring = svgEl('circle', { r: 14, fill: 'none', stroke: '#ffd166', 'stroke-width': 3, visibility: 'hidden' }, g);
    const col = COLORS[team] || COLORS[HOME];
    svgEl('circle', { r: 10.5, fill: col.fill, stroke: '#0b1220', 'stroke-width': 1 }, g);
    const label = jersey === 'Go' ? 'G' : jersey;
    const txt = svgEl('text', { 'text-anchor': 'middle', y: 3.6, fill: col.text, 'font-size': label.length > 1 ? 9.5 : 10.5, 'font-weight': 700, 'font-family': 'Inter, sans-serif' }, g);
    txt.textContent = label;
    t = { g, ring, glow, shown: false };
    pool.set(key, t);
    return t;
  }

  function framePositions(D, k) {
    const out = new Map();
    const f = D.frames[k];
    if (!f) return out;
    for (let i = 0; i < f.length; i += 3) out.set(f[i], [f[i + 1] / 10, f[i + 2] / 10]);
    return out;
  }

  function puckAt(D, k) {
    for (let j = k; j >= Math.max(0, k - PUCK_HOLD_FRAMES); j--) {
      if (D.px[j] !== null) return [D.px[j] / 10, D.py[j] / 10, j];
    }
    return null;
  }

  function renderTracking(D) {
    const k0 = Math.min(Math.floor(S.pos), D.n - 1);
    const k1 = Math.min(k0 + 1, D.n - 1);
    const a = S.pos - k0;
    const A = framePositions(D, k0), B = framePositions(D, k1);

    // puck (interpolate only when both neighbouring frames are real)
    let pk = null;
    const p0 = puckAt(D, k0);
    if (p0) {
      pk = [p0[0], p0[1]];
      if (p0[2] === k0 && D.px[k1] !== null) {
        pk = [p0[0] + (D.px[k1] / 10 - p0[0]) * a, p0[1] + (D.py[k1] / 10 - p0[1]) * a];
      }
    }

    const seen = new Set();
    let carrier = null, best = CARRIER_MAX_FT;
    const placed = [];
    for (const [e, p] of A) {
      const [team, jersey] = D.ents[e];
      const q = B.get(e);
      const x = q ? p[0] + (q[0] - p[0]) * a : p[0];
      const y = q ? p[1] + (q[1] - p[1]) * a : p[1];
      const t = token(team, jersey);
      seen.add(t);
      t.g.setAttribute('transform', `translate(${px(x).toFixed(1)},${py(y).toFixed(1)})`);
      placed.push(t);
      if (pk && jersey !== 'Go') {
        const d = Math.hypot(x - pk[0], y - pk[1]);
        if (d < best) { best = d; carrier = t; }
      }
    }
    for (const t of pool.values()) {
      const vis = seen.has(t);
      if (vis !== t.shown) { t.g.style.display = vis ? '' : 'none'; t.shown = vis; }
      const isC = t === carrier;
      if (isC !== t.isC) {
        t.ring.setAttribute('visibility', isC ? 'visible' : 'hidden');
        t.glow.setAttribute('visibility', isC ? 'visible' : 'hidden');
        t.isC = isC;
      }
    }
    if (carrier && playersLayer.lastChild !== carrier.g) playersLayer.appendChild(carrier.g);

    if (pk) {
      puck.setAttribute('cx', px(pk[0]).toFixed(1));
      puck.setAttribute('cy', py(pk[1]).toFixed(1));
      puck.setAttribute('visibility', 'visible');
    } else puck.setAttribute('visibility', 'hidden');
  }

  // ---------- game state through current time ----------
  function pastCount(period, frame) {
    let lo = 0, hi = events.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1, e = events[m];
      if (e.p < period || (e.p === period && e.f <= frame)) lo = m + 1; else hi = m;
    }
    return lo;
  }

  function computeStats(nPast, period, clock) {
    const st = {};
    const row = (team, j) => {
      const k = team + '|' + j;
      return st[k] || (st[k] = { team, j, toi: 0, sog: 0, g: 0, a: 0, pen: 0 });
    };
    for (const team of [HOME, AWAY]) for (const j of META.roster[team]) row(team, j);
    for (const [team, j, per, start, end] of META.shifts) {
      const r = row(team, j);
      if (per < period) r.toi += start - end;
      else if (per === period && clock < start) r.toi += start - Math.max(end, clock);
    }
    for (let i = 0; i < nPast; i++) {
      const e = events[i];
      if (!e.pl) continue;
      const r = row(e.t, e.pl);
      if (e.ev === 'Goal') {
        r.g++; r.sog++;
        for (const a of e.ast || []) row(e.t, a).a++;
      } else if (e.ev === 'Shot' && e.d2 === 'On Net') r.sog++;
      else if (e.ev === 'Penalty Taken') r.pen++;
    }
    return st;
  }

  function scoreAt(nPast) {
    const s = { [HOME]: 0, [AWAY]: 0 };
    let lastGoal = null;
    for (let i = 0; i < nPast; i++) {
      const e = events[i];
      if (e.ev === 'Goal') { s[e.t]++; lastGoal = { e, score: { ...s } }; }
    }
    return { s, lastGoal };
  }

  function describe(e) {
    const n = e.pl ? `#${e.pl === 'Go' ? 'G' : e.pl}` : '';
    const n2 = e.pl2 ? `#${e.pl2}` : '';
    switch (e.ev) {
      case 'Goal': return `<span class="what">Goal</span> ${n} · ${e.d1 || ''}`;
      case 'Shot': return `Shot ${n} · ${e.d1 || ''}${e.d2 && e.d2 !== 'On Net' ? ' · ' + e.d2.toLowerCase() : ''}`;
      case 'Play': return `Pass ${n}${n2 ? ' to ' + n2 : ''}`;
      case 'Incomplete Play': return `Incomplete pass ${n}`;
      case 'Puck Recovery': return `Puck recovery ${n}`;
      case 'Zone Entry': return `Zone entry ${n}${e.d1 ? ' · ' + e.d1.toLowerCase() : ''}`;
      case 'Dump In/Out': return `Dump in/out ${n}`;
      case 'Faceoff Win': return `Faceoff win ${n}`;
      case 'Takeaway': return `Takeaway ${n}`;
      case 'Penalty Taken': return `Penalty ${n}${e.d1 ? ' · ' + e.d1 : ''}`;
      default: return `${e.ev} ${n}`;
    }
  }

  // Heavier DOM updates only run when the game second or the event count changes.
  function renderGameState(D) {
    const k = Math.min(Math.floor(S.pos), D.n - 1);
    const clock = D.clock[k];
    const nPast = pastCount(S.period, k);
    const { s, lastGoal } = scoreAt(nPast);

    // GOAL banner (checked every frame so it fades on time)
    const b = $('goalBanner');
    const showBanner = lastGoal && lastGoal.e.p === S.period && (k - lastGoal.e.f) <= BANNER_SECONDS * D.fps;
    if (showBanner) {
      const e = lastGoal.e;
      $('gWho').textContent = `#${e.pl} · ${e.t}`;
      $('gWhat').textContent = `${e.d1 || 'Goal'} · now ${lastGoal.score[HOME]}–${lastGoal.score[AWAY]}`;
    }
    b.classList.toggle('show', !!showBanner);

    const key = `${S.period}|${clock}|${nPast}`;
    if (key === S.key) return;
    S.key = key;

    $('scoreD').textContent = s[HOME];
    $('scoreA').textContent = s[AWAY];
    $('plabel').textContent = `PERIOD ${S.period}`;
    $('clock').textContent = fmt(clock);
    $('leftTime').textContent = `${fmt(clock)} left`;
    $('statsThrough').textContent = `through ${fmt(clock)} of P${S.period}`;

    // stats table
    const st = computeStats(nPast, S.period, clock);
    let html = '';
    for (const team of [HOME, AWAY]) {
      const rows = Object.values(st).filter((r) => r.team === team && (r.toi > 0 || r.j === 'Go' || r.sog || r.g || r.a || r.pen));
      rows.sort((x, y) => (x.j === 'Go' ? -1 : y.j === 'Go' ? 1 : y.toi - x.toi || (+x.j) - (+y.j)));
      const tot = rows.reduce((t, r) => ({ sog: t.sog + r.sog, g: t.g + r.g, pen: t.pen + r.pen }), { sog: 0, g: 0, pen: 0 });
      html += `<tr class="thead"><td colspan="2"><i style="background:${COLORS[team].fill}"></i>${team.toUpperCase()}</td>` +
        `<td colspan="4" class="tot">SOG ${tot.sog} · G ${tot.g} · PEN ${tot.pen}</td></tr>`;
      for (const r of rows) {
        if (r.j === 'Go') {
          html += `<tr><td>G</td><td>${fmt(r.toi)}</td><td>–</td><td>–</td><td>–</td><td>–</td></tr>`;
        } else {
          html += `<tr><td>${r.j}</td><td>${fmt(r.toi)}</td><td>${r.sog}</td><td${r.g ? ' class="hl"' : ''}>${r.g}</td><td>${r.a}</td><td>${r.pen}</td></tr>`;
        }
      }
    }
    $('statsBody').innerHTML = html;

    // play-by-play, newest first, with period dividers
    let list = '';
    let curP = null;
    const start = Math.max(0, nPast - 80);
    for (let i = nPast - 1; i >= start; i--) {
      const e = events[i];
      if (e.p !== curP) {
        if (curP !== null || e.p !== S.period) list += `<li class="empty">PERIOD ${e.p}</li>`;
        curP = e.p;
      }
      list += `<li class="${e.ev === 'Goal' ? 'goal' : ''}"><span class="t">${fmt(e.c)}</span>` +
        `<span class="b" style="background:${e.ev === 'Goal' ? '#ffd166' : COLORS[e.t].fill}"></span>` +
        `<span>${describe(e)}</span></li>`;
    }
    $('pbpList').innerHTML = list || '<li class="empty">Press play to start the game.</li>';
  }

  // ---------- controls ----------
  function setPlaying(on) {
    S.playing = on;
    $('playIcon').innerHTML = on ? '<path d="M7 5h4v14H7zM13 5h4v14h-4z"/>' : '<path d="M8 5v14l11-7z"/>';
    $('playBtn').setAttribute('aria-label', on ? 'Pause' : 'Play');
  }

  function markButtons() {
    document.querySelectorAll('[data-period]').forEach((b) => b.classList.toggle('on', +b.dataset.period === S.period));
    document.querySelectorAll('[data-speed]').forEach((b) => b.classList.toggle('on', +b.dataset.speed === S.speed));
  }

  function drawTicks(D) {
    const t = $('ticks');
    t.innerHTML = '';
    for (const e of events) {
      if (e.p === S.period && e.ev === 'Goal') {
        const d = document.createElement('div');
        d.className = 'tick';
        d.style.left = `${(e.f / (D.n - 1)) * 100}%`;
        d.title = `Goal ${fmt(e.c)} #${e.pl} ${e.t}`;
        t.appendChild(d);
      }
    }
  }

  async function goPeriod(p, pos = 0) {
    $('loading').classList.remove('hide');
    const D = await loadPeriod(p);
    $('loading').classList.add('hide');
    S.period = p;
    S.pos = pos;
    S.key = '';
    for (const t of pool.values()) { t.g.remove(); }
    pool.clear();
    markButtons();
    drawTicks(D);
    render();
    if (p < 3) loadPeriod(p + 1).catch(() => {});   // prefetch
  }

  function render() {
    const D = S.data[S.period];
    if (!D) return;
    renderTracking(D);
    renderGameState(D);
    const pct = (S.pos / (D.n - 1)) * 100;
    $('fill').style.width = pct + '%';
    $('knob').style.left = pct + '%';
  }

  function tick(ts) {
    const dt = S.last ? Math.min(ts - S.last, 100) / 1000 : 0;
    S.last = ts;
    const D = S.data[S.period];
    if (D && S.playing && !S.dragging) {
      S.pos += dt * D.fps * S.speed;
      if (S.pos >= D.n - 1) {
        S.pos = D.n - 1;
        if (S.period < 3) { if (!S.switching) { S.switching = true; goPeriod(S.period + 1).finally(() => { S.switching = false; }); } }
        else setPlaying(false);
      }
    }
    render();
    requestAnimationFrame(tick);
  }

  $('playBtn').addEventListener('click', () => {
    const D = S.data[S.period];
    if (!S.playing && D && S.pos >= D.n - 1 && S.period === 3) S.pos = 0;
    setPlaying(!S.playing);
  });
  $('stopBtn').addEventListener('click', () => { setPlaying(false); S.pos = 0; S.key = ''; });
  document.querySelectorAll('[data-speed]').forEach((b) => b.addEventListener('click', () => {
    S.speed = +b.dataset.speed;   // only the rate changes; position and play state are untouched
    markButtons();
  }));
  document.querySelectorAll('[data-period]').forEach((b) => b.addEventListener('click', () => goPeriod(+b.dataset.period)));

  const scrub = $('scrub');
  const seek = (ev) => {
    const D = S.data[S.period];
    if (!D) return;
    const r = scrub.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width));
    S.pos = f * (D.n - 1);
  };
  scrub.addEventListener('pointerdown', (ev) => { S.dragging = true; scrub.setPointerCapture(ev.pointerId); seek(ev); });
  scrub.addEventListener('pointermove', (ev) => { if (S.dragging) seek(ev); });
  const endDrag = () => { S.dragging = false; };
  scrub.addEventListener('pointerup', endDrag);
  scrub.addEventListener('pointercancel', endDrag);

  document.addEventListener('keydown', (ev) => {
    if (ev.target.closest('button') && ev.code === 'Space') return;
    const D = S.data[S.period];
    if (!D) return;
    if (ev.code === 'Space') { ev.preventDefault(); $('playBtn').click(); }
    if (ev.code === 'ArrowRight') S.pos = Math.min(D.n - 1, S.pos + 5 * D.fps);
    if (ev.code === 'ArrowLeft') S.pos = Math.max(0, S.pos - 5 * D.fps);
  });

  // ---------- boot ----------
  const d = new Date(META.date + 'T12:00:00');
  const dateTxt = isNaN(d) ? META.date : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  $('gameinfo').textContent = `Big Data Cup 2026 · ${dateTxt} · ${AWAY} @ ${HOME}`;
  drawRink();
  markButtons();
  goPeriod(1).then(() => requestAnimationFrame(tick)).catch((err) => { $('loading').textContent = err.message; });

  // test hook (used by the headless check; harmless for viewers)
  window.RINKSENSE = { state: S, goPeriod, setPlaying };
})();
