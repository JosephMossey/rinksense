/* RINKSENSE game replay: SVG rink + requestAnimationFrame playback over preprocessed tracking data.
   Opened as game.html?g=<game-id>; the game's files live in data/games/<game-id>/. */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const GAME_ID = new URLSearchParams(location.search).get('g');
  if (!GAME_ID || !/^[\w-]+$/.test(GAME_ID)) { location.replace('index.html'); return; }
  const BASE = `data/games/${GAME_ID}`;

  // Data files are plain <script>s so the site also works from file:// with no server.
  const loadScript = (src) => new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`Could not load ${src}`));
    document.head.appendChild(s);
  });

  loadScript(`${BASE}/meta.js`)
    .then(() => start(window.RS_META))
    .catch(() => {
      $('loading').innerHTML = 'That game could not be found. <a href="index.html">Back to all games</a>';
    });

  function start(META) {
    const HOME = META.home, AWAY = META.away;
    const SVGNS = 'http://www.w3.org/2000/svg';
    const CARRIER_MAX_FT = 8;      // nearest skater only counts as the carrier within this distance
    const BANNER_SECONDS = 6;      // how long the GOAL banner stays up (tracking time)
    const PUCK_HOLD_FRAMES = 8;    // bridge short gaps where the puck isn't tracked
    // Broadcast tracking only sees players inside the camera shot, so players drop in and out.
    const BRIDGE_SECONDS = 3;      // glide a player across dropouts up to this long
    const HOLD_SECONDS = 1.5;      // after a player leaves the shot, keep them (faded) this long
    const GHOST_AFTER_FRAMES = 5;  // dropouts longer than ~1/3 s are drawn faded (position is a guess)
    const LIMITED_VIEW_PLAYERS = 4; // show the "limited camera view" chip at or below this many
    const PP_MINOR = 120;           // a minor penalty's power play runs 2:00
    const TRAIL_FRAMES = 15;       // puck trail length (1 s of tracking at 15 fps)
    const MOMENTUM_BIN = 120;       // momentum chart bin size in seconds
    const CARRIER_STICKY_FT = 1.5;  // a new skater must be this much closer to take the gold ring...
    const CARRIER_SWITCH_SECONDS = 0.3; // ...for this long (tracking time)
    const COLORS = { [HOME]: { fill: '#2f6bff', text: '#ffffff' }, [AWAY]: { fill: '#ff8a80', text: '#0b1220' } };
    const PERIODS = Object.keys(META.periods).map(Number).sort((a, b) => a - b);
    const LAST = PERIODS[PERIODS.length - 1];
    const pName = (p) => (p === 4 ? 'OT' : `P${p}`);
    const pLong = (p) => (p === 4 ? 'OVERTIME' : `PERIOD ${p}`);

    const px = (x) => 420 + x * 4;
    const py = (y) => 190 - y * 4;
    const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const svgEl = (tag, attrs, parent) => {
      const el = document.createElementNS(SVGNS, tag);
      for (const k in attrs) el.setAttribute(k, attrs[k]);
      if (parent) parent.appendChild(el);
      return el;
    };

    // ---------- state ----------
    const S = { period: PERIODS[0], pos: 0, playing: false, speed: 1, data: {}, last: 0, key: '', dragging: false, statsTeam: HOME };
    const events = META.events;   // sorted by (period, frame)

    // ---------- page chrome ----------
    const d = new Date(META.date + 'T12:00:00');
    const dateTxt = isNaN(d) ? META.date : d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
    document.title = `${AWAY} @ ${HOME} · RINKSENSE`;
    $('matchup').textContent = `${AWAY} @ ${HOME}`;
    $('gameinfo').textContent = `${dateTxt}${PERIODS.includes(4) ? ' · Went to overtime' : ''}`;
    // ---------- power plays ----------
    // Windows come from preprocessing (penalty -> expiry, PP goal, or back to even strength).
    // Link each to its penalty event (when it starts) and, if a goal ended it, that goal event.
    const PP = (META.pp || []).map((w) => {
      const ei = events.findIndex((e) => e.ev === 'Penalty Taken' && e.p === w.p && e.c === w.start && e.t === w.opp && e.pl === w.pl);
      const gi = w.reason === 'goal' ? events.findIndex((e, i) => i > ei && e.ev === 'Goal' && e.p === w.p && e.c === w.end && e.t === w.team) : -1;
      let endSeq = gi >= 0 ? gi + 0.5 : -1;
      if (endSeq < 0) events.forEach((e, i) => { if (e.p === w.p && e.c >= w.end) endSeq = i + 0.5; });
      return { ...w, ei, gi, endSeq };
    });
    // which power-play window (if any) each event happened inside, for its own team
    const evPP = events.map((e, i) => PP.find((w) => w.team === e.t && w.p === e.p && i > w.ei && e.c <= w.start && e.c >= w.end && (w.gi < 0 || i <= w.gi)) || null);
    const ppStarted = (w, nPast) => w.ei >= 0 && nPast > w.ei;
    const ppOver = (w, nPast, clock) => w.gi >= 0 ? nPast > w.gi : (w.p < S.period || (w.p === S.period && clock <= w.end));
    const ppActive = (nPast, clock) => PP.filter((w) => w.p === S.period && ppStarted(w, nPast) && !ppOver(w, nPast, clock));

    function renderPowerPlay(nPast, clock) {
      const act = ppActive(nPast, clock);
      const n = { [HOME]: 0, [AWAY]: 0 };   // active penalties against each team
      for (const w of act) n[w.opp]++;
      const base = S.period === 4 ? 3 : 5;
      let team = null;
      if (n[HOME] > n[AWAY]) team = AWAY; else if (n[AWAY] > n[HOME]) team = HOME;
      const on = !!team;
      $('ppBadge').classList.toggle('show', on);
      $('ppNote').classList.toggle('show', on);
      $('ppTint').classList.toggle('show', on);
      if (!on) return;
      const opp = team === HOME ? AWAY : HOME;
      // Count down to when the penalty would expire on its own (2:00), never to how it actually
      // ended: a goal or offsetting penalty just makes the badge disappear early, no spoilers.
      const expiry = (x) => Math.max(0, x.start - PP_MINOR);
      const mine = act.filter((w) => w.team === team).sort((a, b) => expiry(b) - expiry(a));
      const w = mine[0];                       // the penalty that expires first
      const left = Math.max(0, clock - expiry(w));
      const ppSk = S.period === 4 ? base + n[opp] : base - n[team];
      const shSk = S.period === 4 ? base : base - n[opp];
      $('ppTeam').textContent = team;
      $('ppTeam').style.color = COLORS[team].fill;
      $('ppStr').textContent = `${ppSk} on ${shSk}`;
      $('ppTime').textContent = fmt(left);
      $('ppBar').style.width = `${Math.min(100, (left / Math.max(1, w.start - expiry(w))) * 100)}%`;
      $('ppNote').innerHTML = `<b>Power play</b> ${esc(team)} · #${esc(w.pl || '?')} ${esc(w.opp)}${w.why ? ', ' + esc(w.why.toLowerCase()) : ''}`;
    }

    const XG = window.RS_XG;
    if (XG) $('xgNote').textContent = `xG model: logistic regression on ${XG.attempts} unblocked shots (${XG.goals} goals) from ${XG.games} games, using distance, angle, rebound, one-timer, traffic, deflection and power play. Tested on games it never saw: AUC ${XG.cv.auc}.`;
    for (const [id, v] of [['homeName', HOME], ['awayName', AWAY], ['legHome', HOME], ['legAway', AWAY], ['momHome', HOME], ['momAway', AWAY]]) $(id).textContent = v;
    $('statsTabs').innerHTML = [HOME, AWAY].map((t, i) =>
      `<button class="tab${i ? '' : ' on'}" role="tab" aria-selected="${!i}" data-team="${esc(t)}"><i class="dot ${i ? 'a' : 'd'}"></i>${esc(t)}</button>`).join('');
    $('periodBtns').insertAdjacentHTML('beforeend', PERIODS.map((p) => `<button class="pill" data-period="${p}">${pName(p)}</button>`).join(''));

    // ---------- data loading ----------
    const loading = {};
    function loadPeriod(p) {
      if (S.data[p]) return Promise.resolve(S.data[p]);
      if (!loading[p]) loading[p] = loadScript(`${BASE}/p${p}.js`).then(() => (S.data[p] = buildTracks(window[`RS_P${p}`])));
      return loading[p];
    }

    // Per-player position history, so we can bridge the moments a player drops out of the
    // broadcast camera view instead of making them pop in and out.
    function buildTracks(D) {
      const tmp = D.ents.map(() => ({ k: [], x: [], y: [] }));
      D.frames.forEach((f, k) => {
        for (let i = 0; i < f.length; i += 3) {
          const t = tmp[f[i]];
          t.k.push(k); t.x.push(f[i + 1] / 10); t.y.push(f[i + 2] / 10);
        }
      });
      D.tracks = tmp.map((t) => ({ k: Int32Array.from(t.k), x: Float32Array.from(t.x), y: Float32Array.from(t.y) }));
      D.cuts = Int32Array.from(D.cuts || []);
      // each player's on-ice windows this period, from the shift chart: [[startClock, endClock], ...]
      const byKey = {};
      for (const [team, j, per, start, end] of META.shifts) {
        if (per === D.period) (byKey[team + '|' + j] = byKey[team + '|' + j] || []).push([start, end]);
      }
      D.shiftWin = D.ents.map(([team, j]) => byKey[team + '|' + j] || []);
      D.teamWins = {};
      for (const [team, , per, start, end] of META.shifts) {
        if (per === D.period) (D.teamWins[team] = D.teamWins[team] || []).push([start, end]);
      }
      return D;
    }

    // how many players the shift chart has on the ice for a team at this clock
    function onIceCount(D, team, clock) {
      let n = 0;
      for (const w of D.teamWins[team] || []) if (clock <= w[0] && clock >= w[1]) n++;
      return n;
    }

    // true if a camera cut sits between frames a and b (a < b): nothing may be interpolated across it
    function cutBetween(D, a, b) {
      if (b <= a || !D.cuts.length) return false;
      const i = lastAtOrBefore(D.cuts, b - 1);
      return i >= 0 && D.cuts[i] >= a;
    }

    // the shift window the player is in at this clock, or null if they're on the bench
    function shiftAt(wins, clock) {
      for (const w of wins) if (clock <= w[0] && clock >= w[1]) return w;
      return null;
    }

    // index of the last sample at or before frame `pos` (-1 if none)
    function lastAtOrBefore(arr, pos) {
      let lo = 0, hi = arr.length;
      while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] <= pos) lo = m + 1; else hi = m; }
      return lo - 1;
    }

    // ---------- rink ----------
    function drawRink() {
      const g = $('rinkLines');
      // Quiet, analytic rink: thin translucent markings so players and the puck carry the eye.
      svgEl('rect', { x: 20, y: 20, width: 800, height: 340, rx: 112, fill: '#0d1626' }, g);
      const c = svgEl('g', { 'clip-path': 'url(#boards)' }, g);
      const red = '#e8646a', blue = '#4a7dff';
      const line = (o) => ({ opacity: o });
      for (const gx of [64, 776]) {
        const dir = gx < 420 ? 1 : 0;
        svgEl('path', { d: `M${gx},166 A24,24 0 0 ${dir} ${gx},214 Z`, fill: 'rgba(74,125,255,.14)', stroke: red, 'stroke-width': 1, ...line(.6) }, c);
        const nx = gx < 420 ? gx - 13 : gx;
        svgEl('rect', { x: nx, y: 178, width: 13, height: 24, fill: 'none', stroke: '#8fa1c4', 'stroke-width': 1.2, ...line(.7) }, c);
      }
      for (const gx of [64, 776]) svgEl('line', { x1: gx, y1: 20, x2: gx, y2: 360, stroke: red, 'stroke-width': 1, ...line(.5) }, c);
      for (const bx of [320, 520]) svgEl('rect', { x: bx - 1.75, y: 20, width: 3.5, height: 340, fill: blue, ...line(.6) }, c);
      svgEl('rect', { x: 418.75, y: 20, width: 2.5, height: 340, fill: red, ...line(.55) }, c);
      for (const fx of [144, 696]) for (const fy of [102, 278]) {
        svgEl('circle', { cx: fx, cy: fy, r: 60, fill: 'none', stroke: red, 'stroke-width': 1.2, ...line(.4) }, c);
        svgEl('circle', { cx: fx, cy: fy, r: 3.5, fill: red, ...line(.6) }, c);
      }
      for (const fx of [340, 500]) for (const fy of [102, 278]) svgEl('circle', { cx: fx, cy: fy, r: 3, fill: red, ...line(.5) }, c);
      svgEl('circle', { cx: 420, cy: 190, r: 60, fill: 'none', stroke: blue, 'stroke-width': 1.2, ...line(.45) }, c);
      svgEl('circle', { cx: 420, cy: 190, r: 3, fill: blue, ...line(.7) }, c);
      svgEl('rect', { x: 20, y: 20, width: 800, height: 340, rx: 112, fill: 'none', stroke: '#2a3a5a', 'stroke-width': 2 }, g);
    }

    // ---------- players / puck ----------
    const pool = new Map();   // key "team|jersey" -> token
    const playersLayer = $('players');
    const puck = svgEl('circle', { r: 4.5, fill: '#000', stroke: '#fff', 'stroke-width': 2, visibility: 'hidden' }, $('puckLayer'));

    function token(team, jersey) {
      const key = team + '|' + jersey;
      let t = pool.get(key);
      if (t) return t;
      const g = svgEl('g', {}, playersLayer);
      const glow = svgEl('circle', { r: 16, fill: '#ffd166', opacity: .22, filter: 'url(#glow)', visibility: 'hidden' }, g);
      const ring = svgEl('circle', { r: 14.5, fill: 'none', stroke: '#ffd166', 'stroke-width': 2.2, visibility: 'hidden' }, g);
      const col = COLORS[team] || COLORS[HOME];
      svgEl('circle', { r: 10.5, fill: col.fill, stroke: '#0a101d', 'stroke-width': 1.5 }, g);
      const label = jersey === 'Go' ? 'G' : jersey;
      const txt = svgEl('text', { 'text-anchor': 'middle', y: 3.5, fill: col.text, 'font-size': label.length > 1 ? 9.5 : 10.5, 'font-weight': 600, 'font-family': 'Inter, sans-serif' }, g);
      txt.textContent = label;
      t = { g, ring, glow, shown: true };
      pool.set(key, t);
      return t;
    }

    // Puck: the data already has short gaps filled (preprocessing). Interpolate between real
    // samples, never across a camera cut; across a missing stretch, briefly hold then hide.
    function puckAt(D, k0, k1, a) {
      if (D.px[k0] !== null) {
        const x0 = D.px[k0] / 10, y0 = D.py[k0] / 10;
        if (k1 !== k0 && D.px[k1] !== null && !cutBetween(D, k0, k1)) {
          return { x: x0 + (D.px[k1] / 10 - x0) * a, y: y0 + (D.py[k1] / 10 - y0) * a, held: false };
        }
        return { x: x0, y: y0, held: false };
      }
      for (let j = k0 - 1; j >= Math.max(0, k0 - PUCK_HOLD_FRAMES); j--) {
        if (cutBetween(D, j, k0)) break;
        if (D.px[j] !== null) return { x: D.px[j] / 10, y: D.py[j] / 10, held: true };
      }
      return null;
    }

    function renderTracking(D) {
      const k0 = Math.min(Math.floor(S.pos), D.n - 1);
      const k1 = Math.min(k0 + 1, D.n - 1);
      const a = S.pos - k0;
      const clock = D.clock[k0];

      // quick fade at a camera cut so the jump reads as a camera change, not a glitch
      if (S.lastK !== undefined && k0 > S.lastK && k0 - S.lastK < 30 && cutBetween(D, S.lastK, k0)) {
        for (const id of ['players', 'puckLayer']) $(id).animate([{ opacity: 0.1 }, { opacity: 1 }], { duration: 280, easing: 'ease-out' });
      }
      S.lastK = k0;

      const pk = puckAt(D, k0, k1, a);

      // short fading trail of where the puck has just been (never across a camera cut)
      let trail = '';
      if (pk) {
        const pts = [];
        for (let j = Math.max(0, k0 - TRAIL_FRAMES); j <= k0; j++) {
          if (D.px[j] === null || cutBetween(D, j, k0)) { pts.length = 0; continue; }
          pts.push(`${px(D.px[j] / 10).toFixed(1)},${py(D.py[j] / 10).toFixed(1)}`);
        }
        pts.push(`${px(pk.x).toFixed(1)},${py(pk.y).toFixed(1)}`);
        if (pts.length > 2) trail = 'M' + pts.join('L');
      }
      if (trail !== S.trail) { $('puckTrail').setAttribute('d', trail); S.trail = trail; }

      const list = [];          // candidates to draw: {e, x, y, faded, prio, age}
      let tracked = 0;
      const bridge = BRIDGE_SECONDS * D.fps, hold = HOLD_SECONDS * D.fps;
      D.tracks.forEach((tr, e) => {
        const i = lastAtOrBefore(tr.k, S.pos);
        const kA = i >= 0 ? tr.k[i] : -Infinity;
        const hasNext = i + 1 < tr.k.length;
        const kB = hasNext ? tr.k[i + 1] : Infinity;
        // prio: 3 tracked now, 2 short glide, 1 faded but on the ice per shifts, 0 fading off
        let x, y, faded, prio, age = 0;
        if (i >= 0 && kA === k0 && kB === k1 && k1 !== k0 && !cutBetween(D, k0, k1)) {   // tracked now
          x = tr.x[i] + (tr.x[i + 1] - tr.x[i]) * a;
          y = tr.y[i] + (tr.y[i + 1] - tr.y[i]) * a;
          faded = false; prio = 3;
        } else if (i >= 0 && kA === k0) {                                      // tracked now, no next step
          x = tr.x[i]; y = tr.y[i]; faded = false; prio = 3;
        } else if (i >= 0 && hasNext && kB - kA <= bridge && !cutBetween(D, kA, kB)) {  // short dropout: glide
          const f = (S.pos - kA) / (kB - kA);
          x = tr.x[i] + (tr.x[i + 1] - tr.x[i]) * f;
          y = tr.y[i] + (tr.y[i + 1] - tr.y[i]) * f;
          faded = kB - kA > GHOST_AFTER_FRAMES;
          prio = faded ? 2 : 3;
        } else {
          // Not tracked right now. If the shift chart says they're on the ice, keep them on the
          // rink (faded) at their last spot from this shift, or where they next appear in it.
          const w = shiftAt(D.shiftWin[e], clock);
          if (w && i >= 0 && D.clock[kA] <= w[0] && !cutBetween(D, kA, k0)) {
            x = tr.x[i]; y = tr.y[i]; faded = true; prio = 1; age = S.pos - kA;
          } else if (w && hasNext && D.clock[kB] >= w[1] && !cutBetween(D, k0, kB)) {
            x = tr.x[i + 1]; y = tr.y[i + 1]; faded = true; prio = 1; age = kB - S.pos;
          } else if (!w && i >= 0 && S.pos - kA <= hold && !cutBetween(D, kA, k0)) {   // heading off: fade out
            x = tr.x[i]; y = tr.y[i]; faded = true; prio = 0; age = S.pos - kA;
          } else return;
        }
        if (prio === 3) tracked++;
        list.push({ e, x, y, faded, prio, age });
      });

      // Never draw more players per team than the shift chart has on the ice (jersey misreads can
      // otherwise put the same skater on the rink twice). Tracked players win, then the freshest.
      const byTeam = {};
      for (const it of list) (byTeam[D.ents[it.e][0]] = byTeam[D.ents[it.e][0]] || []).push(it);
      const seen = new Map();   // token -> faded?
      const cand = [];          // [token, distance to puck] for carrier selection
      for (const team in byTeam) {
        const items = byTeam[team].sort((p1, p2) => p2.prio - p1.prio || p1.age - p2.age);
        const nTracked = items.filter((it) => it.prio === 3).length;
        const cap = Math.max(nTracked, onIceCount(D, team, clock) || 6);
        for (const it of items.slice(0, cap)) {
          const [tm, jersey] = D.ents[it.e];
          const t = token(tm, jersey);
          seen.set(t, it.faded);
          t.g.setAttribute('transform', `translate(${px(it.x).toFixed(1)},${py(it.y).toFixed(1)})`);
          if (pk && !pk.held && !it.faded && jersey !== 'Go') cand.push([t, Math.hypot(it.x - pk.x, it.y - pk.y)]);
        }
      }

      // Carrier = nearest skater within range, but sticky: a challenger has to be clearly closer
      // (CARRIER_STICKY_FT) for a moment (CARRIER_SWITCH_SECONDS) before the ring moves to them.
      let carrier = null;
      let best = null;
      for (const c of cand) if (c[1] < CARRIER_MAX_FT && (!best || c[1] < best[1])) best = c;
      const prev = cand.find((c) => c[0] === S.carrier);
      if (prev && prev[1] < CARRIER_MAX_FT) {
        carrier = prev[0];
        if (best && best[0] !== prev[0] && best[1] + CARRIER_STICKY_FT < prev[1]) {
          if (S.challenger !== best[0] || S.pos < S.challengeFrom) { S.challenger = best[0]; S.challengeFrom = S.pos; }
          if (S.pos - S.challengeFrom >= CARRIER_SWITCH_SECONDS * D.fps) { carrier = best[0]; S.challenger = null; }
        } else S.challenger = null;
      } else if (best) {
        carrier = best[0];
        S.challenger = null;
      } else if (pk && pk.held) {
        carrier = seen.has(S.carrier) && !seen.get(S.carrier) ? S.carrier : null;   // puck briefly lost: keep ring
      }
      S.carrier = carrier;
      // only flip the chip after the state has held for ~0.5 s, so it doesn't flicker
      const limited = tracked <= LIMITED_VIEW_PLAYERS;
      if (limited === S.limited) S.limitedFrom = S.pos;
      else if (Math.abs(S.pos - (S.limitedFrom ?? S.pos)) >= D.fps / 2 || S.limited === undefined) {
        S.limited = limited; S.limitedFrom = S.pos;
        $('camNote').classList.toggle('show', limited);
      }
      for (const t of pool.values()) {
        const vis = seen.has(t);
        if (vis !== t.shown) { t.g.style.display = vis ? '' : 'none'; t.shown = vis; }
        const fd = vis && seen.get(t);
        if (fd !== t.faded) { t.g.style.opacity = fd ? '0.38' : ''; t.faded = fd; }
        const isC = t === carrier;
        if (isC !== t.isC) {
          t.ring.setAttribute('visibility', isC ? 'visible' : 'hidden');
          t.glow.setAttribute('visibility', isC ? 'visible' : 'hidden');
          t.isC = isC;
        }
      }
      if (carrier && playersLayer.lastChild !== carrier.g) playersLayer.appendChild(carrier.g);

      if (pk) {
        puck.setAttribute('cx', px(pk.x).toFixed(1));
        puck.setAttribute('cy', py(pk.y).toFixed(1));
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

    // Puck control through frame k: frames each player "had it" (nearest skater within 6 ft),
    // earlier periods from per-period totals, this period counted from the per-frame owner array.
    function puckControl(D, k) {
      const byKey = {};
      let home = 0, away = 0;
      for (const p of PERIODS) {
        if (p >= S.period) break;
        const pm = META.periods[p];
        if (pm.poss) { home += pm.poss[0]; away += pm.poss[1]; }
        for (const key in pm.twp || {}) byKey[key] = (byKey[key] || 0) + pm.twp[key];
      }
      if (D.own) {
        const cnt = new Int32Array(D.ents.length);
        for (let f = 0; f <= k; f++) if (D.own[f] >= 0) cnt[D.own[f]]++;
        cnt.forEach((c, e) => {
          if (!c) return;
          const [team, j] = D.ents[e];
          byKey[team + '|' + j] = (byKey[team + '|' + j] || 0) + c;
          if (team === HOME) home += c; else if (team === AWAY) away += c;
        });
      }
      return { byKey, home, away };
    }

    function computeStats(nPast, period, clock, pc) {
      const st = {};
      const row = (team, j) => {
        const k = team + '|' + j;
        return st[k] || (st[k] = { team, j, toi: 0, sog: 0, g: 0, a: 0, pen: 0, xg: 0, twp: 0 });
      };
      for (const team of [HOME, AWAY]) for (const j of META.roster[team] || []) row(team, j);
      for (const [team, j, per, start, end] of META.shifts) {
        const r = row(team, j);
        if (per < period) r.toi += start - end;
        else if (per === period && clock < start) r.toi += start - Math.max(end, clock);
      }
      for (let i = 0; i < nPast; i++) {
        const e = events[i];
        if (!e.pl || !COLORS[e.t]) continue;
        const r = row(e.t, e.pl);
        if (e.xg) r.xg += e.xg;
        if (e.ev === 'Goal') {
          r.g++; r.sog++;
          for (const a of e.ast || []) row(e.t, a).a++;
        } else if (e.ev === 'Shot' && e.d2 === 'On Net') r.sog++;
        else if (e.ev === 'Penalty Taken') r.pen++;
      }
      const fps = META.periods[period].fps || 15;
      for (const key in pc.byKey) {
        const [team, j] = key.split('|');
        if (COLORS[team]) row(team, j).twp += pc.byKey[key] / fps;
      }
      return st;
    }

    function scoreAt(nPast) {
      const s = { [HOME]: 0, [AWAY]: 0 };
      let lastGoal = null;
      for (let i = 0; i < nPast; i++) {
        const e = events[i];
        if (e.ev === 'Goal') { s[e.t]++; lastGoal = e.pre ? null : { e, score: { ...s } }; }
      }
      return { s, lastGoal };
    }

    function describe(e) {
      const n = e.pl ? `#${e.pl === 'Go' ? 'G' : esc(e.pl)}` : '';
      const n2 = e.pl2 ? `#${esc(e.pl2)}` : '';
      const d1 = e.d1 ? esc(e.d1) : '';
      switch (e.ev) {
        case 'Goal': return `<span class="what">Goal</span> ${n}${d1 ? ' · ' + d1 : ''}`;
        case 'Shot': return `Shot ${n}${d1 ? ' · ' + d1 : ''}${e.d2 && e.d2 !== 'On Net' ? ' · ' + esc(e.d2.toLowerCase()) : ''}`;
        case 'Play': return `Pass ${n}${n2 ? ' to ' + n2 : ''}`;
        case 'Incomplete Play': return `Incomplete pass ${n}`;
        case 'Puck Recovery': return `Puck recovery ${n}`;
        case 'Zone Entry': return `Zone entry ${n}${d1 ? ' · ' + d1.toLowerCase() : ''}`;
        case 'Dump In/Out': return `Dump in/out ${n}`;
        case 'Faceoff Win': return `Faceoff win ${n}`;
        case 'Takeaway': return `Takeaway ${n}`;
        case 'Penalty Taken': return `Penalty ${n}${d1 ? ' · ' + d1 : ''}`;
        default: return `${esc(e.ev)} ${n}`;
      }
    }

    // Team stat strip in the header: SOG, shot attempts, penalties (events) and tracked possession.
    function renderHeaderStats(D, k, nPast, pc) {
      const t = { [HOME]: { sog: 0, att: 0, pen: 0, xg: 0 }, [AWAY]: { sog: 0, att: 0, pen: 0, xg: 0 } };
      for (let i = 0; i < nPast; i++) {
        const e = events[i], r = t[e.t];
        if (!r) continue;
        if (e.xg) r.xg += e.xg;
        if (e.ev === 'Goal') { r.sog++; r.att++; }
        else if (e.ev === 'Shot') { r.att++; if (e.d2 === 'On Net') r.sog++; }
        else if (e.ev === 'Penalty Taken') r.pen++;
      }
      // power plays: goals / chances so far, and xG generated on the power play
      const pp = { [HOME]: { g: 0, n: 0, xg: 0 }, [AWAY]: { g: 0, n: 0, xg: 0 } };
      for (const w of PP) if (ppStarted(w, nPast)) pp[w.team].n++;
      for (let i = 0; i < nPast; i++) {
        const w = evPP[i];
        if (!w) continue;
        if (events[i].ev === 'Goal') pp[w.team].g++;
        if (events[i].xg) pp[w.team].xg += events[i].xg;
      }
      for (const [id, v] of [['sogA', t[AWAY].sog], ['sogH', t[HOME].sog], ['attA', t[AWAY].att], ['attH', t[HOME].att],
        ['xgA', t[AWAY].xg.toFixed(2)], ['xgH', t[HOME].xg.toFixed(2)],
        ['ppA', `${pp[AWAY].g}/${pp[AWAY].n}`], ['ppH', `${pp[HOME].g}/${pp[HOME].n}`],
        ['ppxgA', pp[AWAY].xg.toFixed(2)], ['ppxgH', pp[HOME].xg.toFixed(2)]]) $(id).textContent = v;
      const ph = pc.home, pa = pc.away;
      $('twpH').textContent = fmt(ph / D.fps);
      $('twpA').textContent = fmt(pa / D.fps);
      const tot = ph + pa;
      if (tot > 0) {
        const sh = Math.round((ph / tot) * 100);
        $('possH').textContent = sh + '%';
        $('possA').textContent = (100 - sh) + '%';
        $('possBarH').style.width = sh + '%';
        $('possBarA').style.width = (100 - sh) + '%';
      } else {
        $('possH').textContent = $('possA').textContent = '–';
        $('possBarH').style.width = $('possBarA').style.width = '50%';
      }
    }

    // Momentum: shot attempts per 2-minute bin across the whole game (home up, away down).
    // Bins after the current moment stay empty, so nothing is revealed ahead of time.
    const MOM = (() => {
      const bins = [];
      for (const p of PERIODS) {
        const len = META.periods[p].len || 1200;
        for (let s = 0; s < len; s += MOMENTUM_BIN) bins.push({ p, from: len - s, to: Math.max(0, len - s - MOMENTUM_BIN) });
      }
      const count = (bin, team) => events.filter((e) => e.p === bin.p && e.t === team && (e.ev === 'Shot' || e.ev === 'Goal') && e.c <= bin.from && e.c > bin.to).length;
      let max = 1;
      for (const b of bins) { b.allH = count(b, HOME); b.allA = count(b, AWAY); max = Math.max(max, b.allH, b.allA); }
      return { bins, max };
    })();
    function renderMomentum(clock, nPast) {
      const W = 300, H = 92, mid = 46, maxH = 38, gap = 1.5;
      const n = MOM.bins.length;
      const bw = (W - gap * (n - 1)) / n;
      const live = { H: new Array(n).fill(0), A: new Array(n).fill(0) };
      for (let i = 0; i < nPast; i++) {
        const e = events[i];
        if (e.ev !== 'Shot' && e.ev !== 'Goal') continue;
        const bi = MOM.bins.findIndex((b) => b.p === e.p && e.c <= b.from && e.c > b.to);
        if (bi >= 0) live[e.t === HOME ? 'H' : 'A'][bi]++;
      }
      const curBin = MOM.bins.findIndex((b) => b.p === S.period && clock <= b.from && clock >= b.to);
      // x position of a (period, clock) moment on the chart
      const xAt = (p, c) => {
        const bi = MOM.bins.findIndex((b) => b.p === p && c <= b.from && c >= b.to);
        if (bi < 0) return null;
        const b = MOM.bins[bi];
        return bi * (bw + gap) + bw * ((b.from - c) / Math.max(1, b.from - b.to));
      };
      let out = '';
      for (const w of PP) {                // power plays shaded gold, only as far as they've happened
        if (!ppStarted(w, nPast)) continue;
        const end = ppOver(w, nPast, clock) ? w.end : clock;
        const x1 = xAt(w.p, w.start), x2 = xAt(w.p, end);
        if (x1 === null || x2 === null) continue;
        out += `<rect x="${x1.toFixed(1)}" y="0" width="${Math.max(1, x2 - x1).toFixed(1)}" height="${H}" fill="#ffd166" opacity=".12"/>`;
      }
      out += `<line x1="0" y1="${mid}" x2="${W}" y2="${mid}" stroke="#26344f" stroke-width="1"/>`;
      MOM.bins.forEach((b, i) => {
        const x = i * (bw + gap);
        if (i > 0 && MOM.bins[i - 1].p !== b.p) out += `<line x1="${(x - gap / 2).toFixed(1)}" y1="4" x2="${(x - gap / 2).toFixed(1)}" y2="${H - 4}" stroke="#26344f" stroke-dasharray="2 3"/>`;
        const hh = (live.H[i] / MOM.max) * maxH, ha = (live.A[i] / MOM.max) * maxH;
        const future = curBin >= 0 && i > curBin;
        if (!future) {
          if (hh) out += `<rect x="${x.toFixed(1)}" y="${(mid - hh).toFixed(1)}" width="${bw.toFixed(1)}" height="${hh.toFixed(1)}" rx="1" fill="#2f6bff"/>`;
          if (ha) out += `<rect x="${x.toFixed(1)}" y="${mid}" width="${bw.toFixed(1)}" height="${ha.toFixed(1)}" rx="1" fill="#ff8a80"/>`;
        }
        if (i === curBin) {
          const frac = (b.from - clock) / (b.from - b.to);
          const cx = x + bw * Math.min(1, Math.max(0, frac));
          out += `<line x1="${cx.toFixed(1)}" y1="2" x2="${cx.toFixed(1)}" y2="${H - 2}" stroke="#ffd166" stroke-width="1.2"/>`;
        }
      });
      $('momentum').innerHTML = out;
      $('momPer').textContent = PERIODS.map(pName).join(' · ');
    }

    // Heavier DOM updates only run when the game second or the event count changes.
    function renderGameState(D) {
      const k = Math.min(Math.floor(S.pos), D.n - 1);
      const clock = D.clock[k];
      const nPast = pastCount(S.period, k);
      const { s, lastGoal } = scoreAt(nPast);

      const b = $('goalBanner');
      const showBanner = lastGoal && lastGoal.e.p === S.period && (k - lastGoal.e.f) <= BANNER_SECONDS * D.fps;
      if (showBanner) {
        const e = lastGoal.e;
        $('gWho').textContent = `#${e.pl} · ${e.t}`;
        const h = lastGoal.score[HOME], aw = lastGoal.score[AWAY];
        const state = h === aw ? `tied ${h}–${aw}` : h > aw ? `${HOME} leads ${h}–${aw}` : `${AWAY} leads ${aw}–${h}`;
        $('gWhat').textContent = `${e.d1 || 'Goal'} · ${state}`;
      }
      b.classList.toggle('show', !!showBanner);

      const key = `${S.period}|${clock}|${nPast}|${S.statsTeam}`;
      if (key === S.key) return;
      S.key = key;

      $('scoreD').textContent = s[HOME];
      $('scoreA').textContent = s[AWAY];
      $('plabel').textContent = pLong(S.period);
      $('clock').textContent = fmt(clock);
      $('leftTime').textContent = `${fmt(clock)} left`;
      $('statsThrough').textContent = `through ${fmt(clock)} of ${pName(S.period)}`;
      const pc = puckControl(D, k);
      renderHeaderStats(D, k, nPast, pc);
      renderMomentum(clock, nPast);
      renderPowerPlay(nPast, clock);

      const st = computeStats(nPast, S.period, clock, pc);
      const team = S.statsTeam;
      const rows = Object.values(st).filter((r) => r.team === team && (r.toi > 0 || r.j === 'Go' || r.sog || r.g || r.a || r.pen));
      rows.sort((x, y) => (x.j === 'Go' ? -1 : y.j === 'Go' ? 1 : y.toi - x.toi || (+x.j) - (+y.j)));
      const tot = rows.reduce((t, r) => ({ sog: t.sog + r.sog, g: t.g + r.g, pen: t.pen + r.pen, xg: t.xg + r.xg }), { sog: 0, g: 0, pen: 0, xg: 0 });
      let html = `<tr class="thead"><td colspan="3"><i style="background:${COLORS[team].fill}"></i>${esc(team.toUpperCase())}</td>` +
        `<td colspan="5" class="tot">SOG ${tot.sog} · xG ${tot.xg.toFixed(2)} · G ${tot.g} · PEN ${tot.pen}</td></tr>`;
      for (const r of rows) {
        html += r.j === 'Go'
          ? `<tr><td>G</td><td>${fmt(r.toi)}</td><td>–</td><td>–</td><td>–</td><td>–</td><td>–</td><td>–</td></tr>`
          : `<tr><td>${esc(r.j)}</td><td>${fmt(r.toi)}</td><td class="twp">${r.twp >= 1 ? fmt(Math.round(r.twp)) : '0:00'}</td><td>${r.sog}</td>` +
            `<td class="xg">${r.xg ? r.xg.toFixed(2) : '0.00'}</td><td${r.g ? ' class="hl"' : ''}>${r.g}</td><td>${r.a}</td><td>${r.pen}</td></tr>`;
      }
      $('statsBody').innerHTML = html;

      // newest first: past events plus a recap line for each power play that has ended
      const startI = Math.max(0, nPast - 80);
      const items = [];
      for (let i = startI; i < nPast; i++) items.push({ seq: i, e: events[i] });
      for (const w of PP) if (ppStarted(w, nPast) && ppOver(w, nPast, clock) && w.endSeq >= startI) items.push({ seq: w.endSeq, w });
      items.sort((a, b) => b.seq - a.seq);
      let list = '';
      let curP = null;
      for (const it of items) {
        const p = it.e ? it.e.p : it.w.p;
        if (p !== curP) {
          if (curP !== null || p !== S.period) list += `<li class="empty">${pLong(p)}</li>`;
          curP = p;
        }
        if (it.w) {
          const w = it.w;
          const res = `${w.goals} goal${w.goals === 1 ? '' : 's'}, ${w.att} attempt${w.att === 1 ? '' : 's'}, ${w.xg.toFixed(2)} xG`;
          list += `<li class="ppend"><span class="t">${fmt(w.end)}</span><span class="b" style="background:#5a6883"></span>` +
            `<span>Power play over · ${esc(w.team)} · ${res}${w.shg ? ` · ${w.shg} shorthanded goal against` : ''}</span></li>`;
          continue;
        }
        const e = it.e;
        const col = e.ev === 'Goal' ? '#ffd166' : (COLORS[e.t] || COLORS[HOME]).fill;
        const tag = e.ev === 'Penalty Taken' && PP.some((w) => w.ei === it.seq) ? '<span class="pptag">PP starts</span>'
          : e.ev === 'Goal' && evPP[it.seq] ? '<span class="pptag">PP goal</span>' : '';
        list += `<li class="${e.ev === 'Goal' ? 'goal' : ''}"><span class="t">${fmt(e.c)}</span>` +
          `<span class="b" style="background:${col}"></span><span>${describe(e)}</span>${tag}</li>`;
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
          const dv = document.createElement('div');
          dv.className = 'tick';
          dv.style.left = `${(e.f / Math.max(1, D.n - 1)) * 100}%`;
          dv.title = `Goal ${fmt(e.c)} #${e.pl} ${e.t}`;
          t.appendChild(dv);
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
      const pm = META.periods[p];
      const late = pm.len && pm.start < pm.len - 5;
      $('covNote').textContent = late ? `Tracking for ${pName(p)} starts at ${fmt(pm.start)}. Earlier events still count.` : '';
      $('covNote').classList.toggle('show', !!late);
      for (const t of pool.values()) t.g.remove();
      pool.clear();
      S.lastK = undefined;
      S.carrier = null;
      markButtons();
      drawTicks(D);
      render();
      const next = PERIODS[PERIODS.indexOf(p) + 1];
      if (next) loadPeriod(next).catch(() => {});   // prefetch
    }

    function render() {
      const D = S.data[S.period];
      if (!D) return;
      renderTracking(D);
      renderGameState(D);
      const pct = (S.pos / Math.max(1, D.n - 1)) * 100;
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
          const next = PERIODS[PERIODS.indexOf(S.period) + 1];
          if (next) {
            if (!S.switching) { S.switching = true; goPeriod(next).finally(() => { S.switching = false; }); }
          } else setPlaying(false);
        }
      }
      render();
      requestAnimationFrame(tick);
    }

    $('playBtn').addEventListener('click', () => {
      const D = S.data[S.period];
      if (!S.playing && D && S.pos >= D.n - 1 && S.period === LAST) S.pos = 0;
      setPlaying(!S.playing);
    });
    $('stopBtn').addEventListener('click', () => { setPlaying(false); S.pos = 0; S.key = ''; });
    document.querySelectorAll('[data-speed]').forEach((b) => b.addEventListener('click', () => {
      S.speed = +b.dataset.speed;   // only the rate changes; position and play state are untouched
      markButtons();
    }));
    document.querySelectorAll('[data-period]').forEach((b) => b.addEventListener('click', () => goPeriod(+b.dataset.period)));
    document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => {
      S.statsTeam = b.dataset.team;
      document.querySelectorAll('.tab').forEach((t) => {
        const on = t === b;
        t.classList.toggle('on', on);
        t.setAttribute('aria-selected', on);
      });
      $('tablebox').scrollTop = 0;
    }));

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
    drawRink();
    markButtons();
    goPeriod(PERIODS[0]).then(() => requestAnimationFrame(tick)).catch((err) => { $('loading').textContent = err.message; });

    // test hook (used by the headless check; harmless for viewers)
    window.RINKSENSE = { state: S, goPeriod, setPlaying, meta: META };
  }
})();
