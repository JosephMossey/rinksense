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
    $('homeName').textContent = HOME.toUpperCase();
    $('awayName').textContent = AWAY.toUpperCase();
    $('legHome').textContent = HOME;
    $('legAway').textContent = AWAY;
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
      svgEl('rect', { x: 20, y: 20, width: 800, height: 340, rx: 112, fill: '#0f1930' }, g);
      const c = svgEl('g', { 'clip-path': 'url(#boards)' }, g);
      const red = '#e8646a', blue = '#2f6bff';
      for (const gx of [64, 776]) {
        const dir = gx < 420 ? 1 : 0;
        svgEl('path', { d: `M${gx},166 A24,24 0 0 ${dir} ${gx},214 Z`, fill: 'rgba(47,107,255,.22)', stroke: red, 'stroke-width': 1.5 }, c);
        const nx = gx < 420 ? gx - 13 : gx;
        svgEl('rect', { x: nx, y: 178, width: 13, height: 24, fill: 'none', stroke: '#9fb0cf', 'stroke-width': 1.5 }, c);
      }
      for (const gx of [64, 776]) svgEl('line', { x1: gx, y1: 20, x2: gx, y2: 360, stroke: red, 'stroke-width': 1.5, opacity: .8 }, c);
      for (const bx of [320, 520]) svgEl('rect', { x: bx - 2.5, y: 20, width: 5, height: 340, fill: blue }, c);
      svgEl('rect', { x: 418, y: 20, width: 4, height: 340, fill: red }, c);
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
    const pool = new Map();   // key "team|jersey" -> token
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

    function computeStats(nPast, period, clock) {
      const st = {};
      const row = (team, j) => {
        const k = team + '|' + j;
        return st[k] || (st[k] = { team, j, toi: 0, sog: 0, g: 0, a: 0, pen: 0 });
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
        $('gWhat').textContent = `${e.d1 || 'Goal'} · now ${lastGoal.score[HOME]}–${lastGoal.score[AWAY]}`;
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

      const st = computeStats(nPast, S.period, clock);
      const team = S.statsTeam;
      const rows = Object.values(st).filter((r) => r.team === team && (r.toi > 0 || r.j === 'Go' || r.sog || r.g || r.a || r.pen));
      rows.sort((x, y) => (x.j === 'Go' ? -1 : y.j === 'Go' ? 1 : y.toi - x.toi || (+x.j) - (+y.j)));
      const tot = rows.reduce((t, r) => ({ sog: t.sog + r.sog, g: t.g + r.g, pen: t.pen + r.pen }), { sog: 0, g: 0, pen: 0 });
      let html = `<tr class="thead"><td colspan="2"><i style="background:${COLORS[team].fill}"></i>${esc(team.toUpperCase())}</td>` +
        `<td colspan="4" class="tot">SOG ${tot.sog} · G ${tot.g} · PEN ${tot.pen}</td></tr>`;
      for (const r of rows) {
        html += r.j === 'Go'
          ? `<tr><td>G</td><td>${fmt(r.toi)}</td><td>–</td><td>–</td><td>–</td><td>–</td></tr>`
          : `<tr><td>${esc(r.j)}</td><td>${fmt(r.toi)}</td><td>${r.sog}</td><td${r.g ? ' class="hl"' : ''}>${r.g}</td><td>${r.a}</td><td>${r.pen}</td></tr>`;
      }
      $('statsBody').innerHTML = html;

      let list = '';
      let curP = null;
      const startI = Math.max(0, nPast - 80);
      for (let i = nPast - 1; i >= startI; i--) {
        const e = events[i];
        if (e.p !== curP) {
          if (curP !== null || e.p !== S.period) list += `<li class="empty">${pLong(e.p)}</li>`;
          curP = e.p;
        }
        const col = e.ev === 'Goal' ? '#ffd166' : (COLORS[e.t] || COLORS[HOME]).fill;
        list += `<li class="${e.ev === 'Goal' ? 'goal' : ''}"><span class="t">${fmt(e.c)}</span>` +
          `<span class="b" style="background:${col}"></span><span>${describe(e)}</span></li>`;
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
