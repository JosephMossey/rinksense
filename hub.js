/* RINKSENSE NHL hub: lists every processed game and links each one to game.html?g=<id>. */
(() => {
  'use strict';
  const GAMES = window.RS_GAMES || [];
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const fmt = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  const pName = (p) => (p === 4 ? 'OT' : `P${p}`);
  const url = (g) => `game.html?g=${encodeURIComponent(g.id)}`;
  const day = (g, opts) => {
    const d = new Date(g.date + 'T12:00:00');
    return isNaN(d) ? g.date : d.toLocaleDateString('en-US', opts);
  };
  const letter = (team) => team.replace(/^Team\s+/i, '').slice(0, 2);
  const total = (g) => g.score[g.home] + g.score[g.away];
  const compact = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'K' : String(n));

  if (!GAMES.length) {
    $('grid').innerHTML = '<p class="empty">No games found. Run scripts/preprocess.py to build the data.</p>';
    return;
  }

  // ---------- hero ----------
  const latest = [...GAMES].sort((a, b) => b.date.localeCompare(a.date))[0];
  $('ctaLatest').href = url(latest);
  const goals = GAMES.reduce((n, g) => n + g.goals.length, 0);
  const kpis = [
    [GAMES.length, 'Full games'],
    [goals, 'Goals'],
    [compact(GAMES.reduce((n, g) => n + g.frames, 0)), 'Tracked frames'],
    [compact(GAMES.reduce((n, g) => n + g.events, 0)), 'Logged events'],
  ];
  $('kpis').innerHTML = kpis.map(([v, l]) => `<div class="kpi"><div class="kv">${v}</div><div class="kl">${l}</div></div>`).join('');

  // ---------- goal map: right half of the rink, 4 px per foot ----------
  const svg = $('goalSvg');
  const X = (x) => 20 + x * 4;          // x: 0..100 ft  -> 20..420
  const Y = (y) => 190 - y * 4;         // y: -42.5..42.5 -> 360..20
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
      <circle cx="${X(69)}" cy="${Y(22)}" r="3.5" fill="${red}" opacity=".6"/><circle cx="${X(69)}" cy="${Y(-22)}" r="3.5" fill="${red}" opacity=".6"/>
      <circle cx="${X(0)}" cy="190" r="60" fill="none" stroke="${blue}" stroke-width="1.2" opacity=".45"/>
    </g>
    <path d="M20,20 H308 A112,112 0 0 1 420,132 V248 A112,112 0 0 1 308,360 H20" fill="none" stroke="#2a3a5a" stroke-width="2"/>`;
  let plotted = 0;
  for (const g of GAMES) {
    for (const gl of g.goals) {
      if (!gl.xy) continue;
      plotted++;
      const label = `${gl.t} #${gl.pl}${gl.d1 ? ' · ' + gl.d1 : ''} · ${pName(gl.p)} ${fmt(gl.c)} · ${g.away} @ ${g.home}, ${day(g, { month: 'short', day: 'numeric' })}`;
      m += `<a href="${url(g)}" class="gdot"><title>${esc(label)}</title>` +
        `<circle cx="${X(gl.xy[0]).toFixed(1)}" cy="${Y(gl.xy[1]).toFixed(1)}" r="6"/></a>`;
    }
  }
  svg.innerHTML = m;
  $('mapSub').textContent = `${plotted} goals across ${GAMES.length} games, mirrored to one net`;

  // ---------- game cards ----------
  const teams = [...new Set(GAMES.flatMap((g) => [g.home, g.away]))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  $('teamFilter').insertAdjacentHTML('beforeend', teams.map((t) => `<option value="${esc(t)}">${esc(t)}</option>`).join(''));
  const view = { team: '', sort: 'new' };

  function timeline(g) {
    const periods = Object.keys(g.periodLength).map(Number).sort((a, b) => a - b);
    const segs = periods.map((p) => {
      const len = g.periodLength[p] || 1200;
      const dots = g.goals.filter((gl) => gl.p === p).map((gl) => {
        const side = gl.t === g.home ? 'h' : 'a';
        const left = Math.min(100, Math.max(0, ((len - gl.c) / len) * 100));
        return `<i class="tg ${side}" style="left:${left.toFixed(1)}%" title="${esc(`${gl.t} #${gl.pl} · ${pName(p)} ${fmt(gl.c)}`)}"></i>`;
      }).join('');
      // hatch the part of the period that has no tracking data
      const ts = (g.trackStart || {})[p];
      const gap = ts != null && ts < len - 5 ? ((len - ts) / len) * 100 : 0;
      const hatch = gap ? `<b class="nogap" style="width:${gap.toFixed(1)}%" title="No tracking before ${fmt(ts)}"></b>` : '';
      return `<div class="tseg${p === 4 ? ' ot' : ''}" style="flex:${len}"><div class="segbar">${hatch}${dots}</div><span>${pName(p)}</span></div>`;
    });
    return `<div class="timeline" aria-hidden="true">${segs.join('')}</div>`;
  }

  function teamRow(g, team, side) {
    const mine = g.score[team], theirs = g.score[team === g.home ? g.away : g.home];
    const cls = mine > theirs ? 'win' : mine < theirs ? 'lose' : '';
    return `<div class="trow ${cls}">
      <span class="tbadge ${side}">${esc(letter(team))}</span>
      <span class="tn">${esc(team)}<small>${side === 'h' ? 'Home' : 'Away'}</small></span>
      <span class="ts">${mine}</span>
    </div>`;
  }

  function card(g) {
    return `<a class="gcard" href="${url(g)}" aria-label="${esc(`Replay ${g.away} at ${g.home}, ${day(g, { month: 'long', day: 'numeric' })}`)}">
      <div class="gtop">
        <span class="gdate">${esc(day(g, { weekday: 'short', month: 'short', day: 'numeric' }))}</span>
        <span class="gstatus${g.ot ? ' ot' : ''}">${!g.ot ? 'Final' : g.score[g.home] === g.score[g.away] ? 'Final / SO' : 'Final / OT'}</span>
      </div>
      ${teamRow(g, g.away, 'a')}
      ${teamRow(g, g.home, 'h')}
      ${timeline(g)}
      <div class="gfoot">
        <span class="gstat">SOG <b>${g.sog[g.away]}–${g.sog[g.home]}</b></span>        <span class="watch">Watch replay<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg></span>
      </div>
    </a>`;
  }

  function renderGrid() {
    let list = GAMES.filter((g) => !view.team || g.home === view.team || g.away === view.team);
    const byDate = (a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id);
    if (view.sort === 'new') list.sort((a, b) => byDate(b, a));
    else if (view.sort === 'old') list.sort(byDate);
    else list.sort((a, b) => total(b) - total(a) || byDate(b, a));
    $('grid').innerHTML = list.map(card).join('') || '<p class="empty">No games for that team.</p>';
    $('countLine').textContent = view.team
      ? `${list.length} of ${GAMES.length} games with ${view.team}`
      : `${GAMES.length} games · ${GAMES.filter((g) => g.ot).length} went to overtime`;
  }

  $('teamFilter').addEventListener('change', (e) => { view.team = e.target.value; renderGrid(); });
  document.querySelectorAll('[data-sort]').forEach((b) => b.addEventListener('click', () => {
    view.sort = b.dataset.sort;
    document.querySelectorAll('[data-sort]').forEach((x) => x.classList.toggle('on', x === b));
    renderGrid();
  }));
  renderGrid();
})();
