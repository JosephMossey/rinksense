/* RINKSENSE MLB player page: player.html?p=<id>. Pitching and/or hitting sections. */
(() => {
  'use strict';
  const { color, ptName, esc, arrow } = window.RSM;
  const $ = (id) => document.getElementById(id);
  const id = new URLSearchParams(location.search).get('p');
  const d3 = (v) => (v == null ? '–' : v.toFixed(3).replace(/^0/, ''));
  const ip = (o) => `${Math.floor(o / 3)}.${o % 3}`;
  const sg = (v, n = 2) => (v == null ? '–' : Math.abs(v) < 0.5 * 10 ** -n ? (0).toFixed(n) : `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(n)}`);
  const pc = (v) => (v == null ? '–' : `${Math.round(v * 100)}%`);
  const watch = (pk, step) => `game.html?g=${pk}#s-${step}`;
  const stat = (l, v, s) => `<div class="gstat"><div class="gl">${l}</div><div class="gv">${v}</div>${s ? `<div class="psub">${s}</div>` : ''}</div>`;
  const sec = (title, sub, body, cls = '') => `<section class="card rsec ${cls}"><div class="chead"><span class="ctitle">${title}</span><span class="csub">${sub || ''}</span></div>${body}</section>`;

  const fail = (m) => { $('pdBody').innerHTML = `<p class="empty">${m} <a href="players.html" style="color:var(--gold)">All players</a></p>`; };
  if (!id || !/^\d+$/.test(id)) { fail('No player picked.'); return; }
  const s = document.createElement('script');
  s.src = `data/players/${id}.js`;
  s.onload = () => render(window.RS_MLB_PLAYER);
  s.onerror = () => fail('That player could not be found.');
  document.head.appendChild(s);

  function render(P) {
    document.title = `${P.name} · MLB · RINKSENSE`;
    $('pdName').textContent = P.name;
    $('pdRole').textContent = `${P.pit && P.bat ? 'Pitcher and hitter' : P.pit ? 'Pitcher' : 'Hitter'} · ${P.team} · 2026 postseason`;
    let line = '', html = '';
    if (P.pit) {
      const p = P.pit;
      line += stat('IP', ip(p.outs), `${p.bf} batters`) + stat('K%', pc(p.k / Math.max(p.bf, 1)), `${p.k} K · ${p.bb} BB`) +
        stat('Stuff+', p.st ?? '–', p.sst != null ? `${p.sst} in the season` : '') + stat('xwOBA', d3(p.xw), 'allowed') + stat('WPA', sg(p.wpa), 'win prob added');
      html += pitching(p);
    }
    if (P.bat) {
      const b = P.bat;
      if (!P.pit) {
        line += stat('PA', b.pa, `${b.h} H · ${b.hr} HR · ${b.rbi} RBI`) + stat('Slash', `${d3(b.avg)}/${d3(b.obp)}/${d3(b.slg)}`) +
          stat('xwOBA', d3(b.xw), `wOBA ${d3(b.woba)}`) + stat('Max EV', b.maxev ?? '–', 'mph') + stat('WPA', sg(b.wpa), 'win prob added');
      }
      html += hitting(b, !!P.pit);
    }
    $('pdLine').innerHTML = line;
    $('pdBody').innerHTML = html;
  }

  // ---------------- pitcher ----------------
  function pitching(p) {
    const ars = `<div class="tablescroll" style="margin:0 8px"><table class="pltable"><thead><tr>${['Pitch', '#', 'Use', 'Velo', 'Rise', 'Arm side', 'Spin', 'Stuff+', 'xWhiff', 'Whiff%'].map((h) => `<th><button tabindex="-1">${h}</button></th>`).join('')}</tr></thead><tbody>` +
      p.arsenal.map((a) => {
        const vd = a.v != null && a.sv != null ? a.v - a.sv : null;
        return `<tr><td><span class="ptdot" style="background:${color(a.t)}"></span>${esc(ptName(a.t))}</td><td>${a.n}</td><td>${pc(a.use)}</td>` +
          `<td>${a.v ?? '–'}${vd != null && Math.abs(vd) >= 0.3 ? ` <small class="${vd > 0 ? 'up' : 'down'}">${sg(vd, 1)}</small>` : ''}</td>` +
          `<td>${a.iv != null ? Math.round(a.iv) : '–'}"</td><td>${a.hb != null ? Math.round(a.hb) : '–'}"</td><td>${a.s ?? '–'}</td>` +
          `<td><span class="${a.st >= 115 ? 'gold' : ''}">${a.st ?? '–'}</span>${a.sst != null ? ` <small>(${a.sst})</small>` : ''}</td>` +
          `<td>${a.xw != null ? a.xw + '%' : '–'}</td><td>${a.sw ? pc(a.wh / a.sw) : '–'}${a.swh != null ? ` <small>(${pc(a.swh)})</small>` : ''}</td></tr>`;
      }).join('') + '</tbody></table></div><p class="foot">Postseason averages; regular season in brackets, with velo shown as the change from his season average. Rise is induced vertical break, arm side is horizontal break toward his throwing arm, both in inches.</p>';

    // movement plot: x = arm-side break, y = induced vertical break, inches
    const X = (v) => 160 + v * 6.2, Y = (v) => 130 - v * 5.2;
    let mv = `<line x1="${X(-24)}" y1="${Y(0)}" x2="${X(24)}" y2="${Y(0)}" stroke="#1b2740"/><line x1="${X(0)}" y1="${Y(22)}" x2="${X(0)}" y2="${Y(-22)}" stroke="#1b2740"/>`;
    for (const t of [-20, -10, 10, 20]) mv += `<text x="${X(t)}" y="${Y(0) + 12}" font-size="9" fill="#5a6883" text-anchor="middle">${t}</text><text x="${X(0) - 4}" y="${Y(t) + 3}" font-size="9" fill="#5a6883" text-anchor="end">${t}</text>`;
    mv += `<text x="${X(24)}" y="${Y(0) - 5}" font-size="9" fill="#8593ad" text-anchor="end">arm side →</text><text x="${X(-24)}" y="${Y(0) - 5}" font-size="9" fill="#8593ad">← glove side</text><text x="${X(0) + 5}" y="${Y(22) + 4}" font-size="9" fill="#8593ad">rise ↑</text>`;
    mv += p.move.map(([t, hb, iv]) => `<circle cx="${X(Math.max(-24, Math.min(24, hb))).toFixed(1)}" cy="${Y(Math.max(-22, Math.min(22, iv))).toFixed(1)}" r="2.6" fill="${color(t)}" opacity=".55"/>`).join('');
    for (const a of p.arsenal) if (a.hb != null && a.iv != null) mv += `<circle cx="${X(a.hb)}" cy="${Y(a.iv)}" r="6" fill="${color(a.t)}" stroke="#0e1626" stroke-width="2"/>`;
    const legend = `<div class="ptlegend" style="padding:0 18px 4px">${p.arsenal.map((a) => `<span><i style="background:${color(a.t)}"></i>${esc(ptName(a.t))}</span>`).join('')}</div>`;
    const move = `<svg viewBox="0 0 320 260" style="display:block;width:100%;max-width:420px;margin:0 auto">${mv}</svg>${legend}<p class="foot">Every postseason pitch; big dots are each pitch type's average.</p>`;

    // tunnels
    const [sw1, wh1, sw2, wh2] = p.tun;
    const tun = (p.pairs.length ? `<ul class="tplist">${p.pairs.map((x) => `<li style="cursor:default"><span class="tpi">${x.n}×</span><span><span class="ptdot" style="background:${color(x.a)}"></span>${esc(ptName(x.a))} → <span class="ptdot" style="background:${color(x.b)}"></span>${esc(ptName(x.b))}</span><span class="tpd" style="color:var(--soft);font-weight:400">${x.dec}" → ${x.pl}"</span></li>`).join('')}</ul>`
      : '<p class="pnote" style="padding:0 18px">Not enough back-to-back pitch pairs yet (3+ of a pair needed).</p>') +
      `<p class="foot">Back-to-back pitches of different types in the same at-bat: how far apart at the hitter's decision point → at the plate, averaged. Ranked by how much they split. ` +
      (sw1 >= 5 ? `On swings after a strong tunnel (within 6" early, 10"+ apart late) he got a whiff ${pc(wh1 / sw1)} of the time (${wh1} of ${sw1}), vs ${pc(sw2 ? wh2 / sw2 : 0)} on other pairs (${wh2} of ${sw2}). Small samples.` : '') + '</p>';

    // velo by inning
    const logs = p.log.filter((l) => Object.keys(l.iv).length >= 2);
    let vel = '';
    if (logs.length) {
      const vals = logs.flatMap((l) => Object.values(l.iv));
      const lo = Math.floor(Math.min(...vals) - 0.5), hi = Math.ceil(Math.max(...vals) + 0.5);
      const maxInn = Math.max(...logs.flatMap((l) => Object.keys(l.iv).map(Number)));
      const minInn = Math.min(...logs.flatMap((l) => Object.keys(l.iv).map(Number)));
      const span = Math.max(1, maxInn - minInn);
      const VX = (i) => 34 + ((i - minInn) / span) * 270, VY = (v) => 14 + (1 - (v - lo) / Math.max(hi - lo, 1)) * 120;
      let sv = `<text x="28" y="${VY(hi) + 4}" font-size="9" fill="#5a6883" text-anchor="end">${hi}</text><text x="28" y="${VY(lo) + 4}" font-size="9" fill="#5a6883" text-anchor="end">${lo}</text>`;
      for (let i = minInn; i <= maxInn; i++) sv += `<text x="${VX(i)}" y="150" font-size="9" fill="#5a6883" text-anchor="middle">${i}</text>`;
      logs.forEach((l, j) => {
        const pts = Object.entries(l.iv).map(([i, v]) => [VX(+i), VY(v)]).sort((a, b) => a[0] - b[0]);
        const last = j === logs.length - 1;
        sv += `<polyline points="${pts.map((q) => q.join(',')).join(' ')}" fill="none" stroke="${last ? '#ffd166' : '#5a6883'}" stroke-width="${last ? 2 : 1.2}" opacity="${last ? 1 : 0.7}"><title>${esc(l.g)}</title></polyline>`;
        pts.forEach(([x, y]) => { sv += `<circle cx="${x}" cy="${y}" r="${last ? 3 : 2}" fill="${last ? '#ffd166' : '#5a6883'}"/>`; });
      });
      vel = `<svg viewBox="0 0 320 156" style="display:block;width:100%;max-width:420px;margin:0 auto">${sv}</svg><p class="foot">Average fastball velo by inning in each outing with 2+ innings (mph). Gold is his last one: ${esc(logs[logs.length - 1].g)}.</p>`;
    } else vel = '<p class="pnote" style="padding:0 18px 6px">No outings of 2+ innings.</p>';

    const pulled = p.pulled.length ? `<ul class="declist">${p.pulled.map((d) => `<li><div class="dtop"><span class="who">${esc(d.g)}</span><span class="when">${arrow(d.top)}${d.inn} · ${d.pitches} pitches</span></div>
      <div class="dgrades"><span class="dg">Process<b class="${d.proc > 0.0025 ? 'good' : d.proc < -0.0025 ? 'bad' : 'meh'}">${Math.abs(d.proc) <= 0.0025 ? 'toss-up' : sg(d.proc * 100, 1) + '%'}</b></span><span class="dg">Result<b class="${d.res > 0.0025 ? 'good' : d.res < -0.0025 ? 'bad' : 'meh'}">${sg(d.res * 100, 1)}%</b></span><a class="dg" style="text-decoration:none" href="${watch(d.pk, d.step)}">Watch<b class="meh">→</b></a></div></li>`).join('')}</ul>
      <p class="foot">Grades are for the manager's move to take him out. <a href="methods.html#decisions">How they're graded</a></p>`
      : '<p class="pnote" style="padding:0 18px 6px">Never pulled mid-inning or between innings by a graded change.</p>';

    const log = `<div class="tablescroll" style="margin:0 8px"><table class="pltable"><thead><tr>${['Game', 'Opp', 'IP', 'P', 'H', 'BB', 'K', 'Stuff+', 'WPA', ''].map((h) => `<th><button tabindex="-1">${h}</button></th>`).join('')}</tr></thead><tbody>` +
      p.log.map((l) => `<tr><td>${esc(l.g)}</td><td>${esc(l.opp)}</td><td>${ip(l.outs)}</td><td>${l.p}</td><td>${l.h}</td><td>${l.bb}</td><td>${l.k}</td><td>${l.st ?? '–'}</td><td>${sg(l.wpa)}</td><td><a class="gold" href="${watch(l.pk, l.step)}">Watch</a></td></tr>`).join('') + '</tbody></table></div>';

    return `<div class="pdgrid">${sec('Arsenal', 'Postseason (regular season)', ars, 'wide')}${sec('Movement', "Catcher's view, inches", move)}${sec('Tunnels', 'Best pitch pairs', tun)}${sec('Velo by inning', 'Does he hold it?', vel)}${sec('When he was pulled', 'Bullpen decisions', pulled)}${sec('Game log', `${p.log.length} games`, log, 'wide')}</div>`;
  }

  // ---------------- hitter ----------------
  function hitting(b, twoWay) {
    const FIELD = `<path d="M125.4,198.3 L32,105 Q125.4,-29 218.8,105 Z" fill="#0f2419" stroke="#1d4a35" stroke-width="1"/>
      <path d="M125.4,198.3 L95,168 A43,43 0 0 1 155.8,168 Z" fill="#2a2418" opacity=".85"/>
      <path d="M125.4,198.3 L150.9,172.8 L125.4,147.3 L99.9,172.8 Z" fill="#0f2419" stroke="#3a3322" stroke-width=".8"/>`;
    const HIT = new Set(['single', 'double', 'triple', 'home_run']);
    const dots = b.spray.map(([x, y, ev, et, pk, step]) => {
      const r = Math.max(2, Math.min(7, (ev - 60) / 8));
      const c = et === 'home_run' ? '#ffd166' : HIT.has(et) ? '#7aa7ff' : 'none';
      return `<a href="${watch(pk, step)}"><circle cx="${x}" cy="${y}" r="${r.toFixed(1)}" fill="${c}" stroke="${c === 'none' ? '#8593ad' : '#0e1626'}" stroke-width="1.2"><title>${esc(et.replace(/_/g, ' '))}, ${ev} mph</title></circle></a>`;
    }).join('');
    const spray = `<div class="spraybox"><svg viewBox="12 18 226 190" style="display:block;width:100%;max-width:340px;margin:0 auto">${FIELD}${dots}</svg>
      <div class="ptlegend"><span><i style="background:#ffd166"></i>Home run</span><span><i style="background:#7aa7ff"></i>Hit</span><span><i style="border:1.5px solid #8593ad"></i>Out</span><span>Size = exit velo · click to watch</span></div></div>`;

    const luck = b.woba != null && b.xw != null ? b.woba - b.xw : null;
    const call = luck == null ? '' : `<p class="callout">${Math.abs(luck) < 0.02 ? 'Got about what his contact deserved:' : luck > 0 ? 'Outperformed his contact:' : 'Hit better than his results show:'} <b>${d3(b.woba)}</b> wOBA vs <b>${d3(b.xw)}</b> xwOBA.</p>`;
    const moments = b.moments.length ? `<ul class="tplist">${b.moments.map(([d, pk, step, g, inn, top, desc]) => `<li data-href="${watch(pk, step)}"><span class="tpi">${esc(g)}<br>${arrow(top)}${inn}</span><span>${esc(desc)}</span><span class="tpd gold">+${Math.round(d * 100)}%</span></li>`).join('')}</ul>`
      : '<p class="pnote" style="padding:0 18px">No plate appearance raised his team\'s win probability.</p>';

    const dp = b.disc.post, dr = b.disc.reg;
    const row = (l, k) => `<tr><td>${l}</td><td>${dp ? pc(dp[k]) : '–'}</td><td>${dr ? pc(dr[k]) : '–'}</td></tr>`;
    const disc = `<div class="tablescroll" style="margin:0 8px"><table class="pltable"><thead><tr><th><button tabindex="-1"></button></th><th><button tabindex="-1">Postseason</button></th><th><button tabindex="-1">Season</button></th></tr></thead><tbody>${row('Chase rate', 'chase')}${row('Whiff rate', 'whiff')}${row('Hard-hit rate', 'hard')}</tbody></table></div>` +
      `<p class="foot">Chase = swings at pitches outside the zone. Whiff = misses per swing. Hard-hit = batted balls at 95+ mph${dp ? ` (${dp.bbe} in the postseason)` : ''}.</p>`;
    const grp = ['Fastball', 'Breaking', 'Offspeed'].map((k) => b.grp[k] ? `<div class="gstat"><div class="gl">vs ${k}</div><div class="gv">${d3(b.grp[k][0])}</div><div class="psub">${b.grp[k][1]} PA</div></div>` : '').join('');
    const grpBox = `<div class="gstats" style="grid-template-columns:repeat(3,minmax(0,1fr));margin:0 18px">${grp || '<div class="gstat">–</div>'}</div><p class="foot">xwOBA by the type of pitch that ended the plate appearance. Tiny samples, for flavor.</p>`;

    const log = `<div class="tablescroll" style="margin:0 8px"><table class="pltable"><thead><tr>${['Game', 'Opp', 'PA', 'AB', 'H', 'HR', 'RBI', 'BB', 'K', 'WPA', ''].map((h) => `<th><button tabindex="-1">${h}</button></th>`).join('')}</tr></thead><tbody>` +
      b.log.map((l) => `<tr><td>${esc(l.g)}</td><td>${esc(l.opp)}</td><td>${l.pa}</td><td>${l.ab}</td><td>${l.h}</td><td>${l.hr}</td><td>${l.rbi}</td><td>${l.bb}</td><td>${l.k}</td><td>${sg(l.wpa)}</td><td><a class="gold" href="${watch(l.pk, l.step)}">Watch</a></td></tr>`).join('') + '</tbody></table></div>';

    const head = twoWay ? `<h2 class="pdsection">Hitting · ${b.pa} PA · ${d3(b.avg)}/${d3(b.obp)}/${d3(b.slg)} · ${b.hr} HR</h2>` : '';
    setTimeout(() => document.querySelectorAll('[data-href]').forEach((li) => li.addEventListener('click', () => { location.href = li.dataset.href; })), 0);
    return `${head}<div class="pdgrid">${sec('Spray chart', `${b.spray.length} batted balls`, spray)}${sec('Contact quality', 'Results vs expected', call + `<div class="gstats" style="grid-template-columns:repeat(2,minmax(0,1fr));margin:0 18px 12px">${stat('Hits', b.h, `${b.h - b.d2 - b.d3 - b.hr} 1B · ${b.d2} 2B · ${b.d3} 3B · ${b.hr} HR`)}${stat('BB / K', `${b.bb} / ${b.k}`, `in ${b.pa} PA`)}</div>`)}${sec('Biggest moments', 'Win probability added', moments)}${sec('Plate discipline', 'Postseason vs regular season', disc + grpBox)}${sec('Game log', `${b.log.length} games`, log, 'wide')}</div>`;
  }
})();
