/* RINKSENSE MLB methods page: fills validation numbers from data/models.js. */
(() => {
  'use strict';
  const M = window.RS_MLB_MODELS || {}, G = window.RS_MLB_GAMES || [];
  const $ = (id) => document.getElementById(id);
  const stat = (v, l, s) => `<div class="mstat"><div class="gl">${l}</div><div class="kv">${v}</div>${s ? `<small>${s}</small>` : ''}</div>`;
  const n = (x) => Number(x).toLocaleString('en-US');
  const d3 = (x) => Number(x).toFixed(3).replace(/^0/, '');

  if (M.wp) {
    const w = M.wp;
    $('dataStats').innerHTML = stat(n(w.train_pitches + w.post_pitches), 'Pitches', '2026 season + playoffs') +
      stat(n(w.train_games), 'Regular-season games', 'model training') + stat(G.length || w.post_games, 'Playoff games', 'on the site');
    $('wpStats').innerHTML = stat(w.cv_brier.toFixed(3), 'Brier, cross-validated', `vs ${w.base_brier.toFixed(3)} always guessing the base rate`) +
      stat(w.post_brier.toFixed(3), 'Brier, 2026 playoffs', `${n(w.post_pitches)} pitches it never saw`) +
      stat(w.post_brier_mlb.toFixed(3), "Statcast's own model", 'same playoff pitches') +
      stat(w.post_brier_base.toFixed(3), 'Coin flip', 'always 50%');
    // calibration chart
    const X = (p) => 40 + p * 300, Y = (p) => 200 - p * 180;
    let s = `<rect x="40" y="20" width="300" height="180" fill="none" stroke="#1b2740"/>`;
    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      s += `<line x1="${X(t)}" y1="200" x2="${X(t)}" y2="204" stroke="#26344f"/><text x="${X(t)}" y="216" font-size="10" fill="#5a6883" text-anchor="middle">${t * 100}%</text>`;
      s += `<text x="34" y="${Y(t) + 3}" font-size="10" fill="#5a6883" text-anchor="end">${t * 100}%</text>`;
    }
    s += `<line x1="${X(0)}" y1="${Y(0)}" x2="${X(1)}" y2="${Y(1)}" stroke="#26344f" stroke-dasharray="4 4"/>`;
    s += `<polyline fill="none" stroke="#ffd166" stroke-width="1.6" points="${w.calib.map(([p, a]) => `${X(p)},${Y(a)}`).join(' ')}"/>`;
    s += w.calib.map(([p, a]) => `<circle cx="${X(p)}" cy="${Y(a)}" r="3.5" fill="#ffd166"><title>Predicted ${Math.round(p * 100)}%, actual ${Math.round(a * 100)}%</title></circle>`).join('');
    s += `<text x="190" y="229" font-size="10" fill="#8593ad" text-anchor="middle">Predicted</text>`;
    $('calib').innerHTML = s;
  }
  if (M.xwoba) {
    const x = M.xwoba;
    $('xwStats').innerHTML = stat(x.test_rmse.toFixed(3), 'Per-ball RMSE', `${n(x.test_bbe)} Aug–Sep batted balls`) +
      stat(x.test_rmse_savant.toFixed(3), "Savant's xwOBA RMSE", 'same balls') +
      stat(x.test_auc_hit.toFixed(3), 'AUC, hit vs out') + stat(x.test_auc_hr.toFixed(3), 'AUC, home run') +
      stat(x.batter_r.toFixed(2), 'Batter-level r', `xwOBA vs actual wOBA on contact, ${x.batters} batters, 50+ balls`);
  }
  if (M.stuff) {
    const t = M.stuff;
    $('stStats').innerHTML = stat(t.r_stuff_rv2.toFixed(2), 'Stuff+ → 2nd-half run value', 'correlation') +
      stat(t.r_rv1_rv2.toFixed(2), '1st-half run value → 2nd half', 'what it beats') +
      stat(t.r_xwhiff_whiff2.toFixed(2), 'xWhiff → 2nd-half whiff%', '') +
      stat(t.r_whiff1_whiff2.toFixed(2), '1st-half whiff% → 2nd half', '') +
      stat(n(t.pitch_types), 'Pitcher pitch types', '100+ pitches in each half');
  }
  if (M.profiles) {
    const p = M.profiles;
    $('priorPA').textContent = p.prior_pa;
    $('ttoTxt').textContent = `+${d3(p.tto_penalty[2])} xwOBA the 2nd time through, +${d3(p.tto_penalty[3])} the 3rd, +${d3(p.tto_penalty[4])} the 4th, vs the 1st; league xwOBA ${d3(p.lg_xwoba)}`;
  }
})();
