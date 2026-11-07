/* RINKSENSE MLB shared helpers (pitch types, formatting). */
window.RSM = (() => {
  'use strict';
  const PT = {
    FF: ['4-seam fastball', '--ff'], SI: ['Sinker', '--si'], FC: ['Cutter', '--fc'],
    SL: ['Slider', '--sl'], ST: ['Sweeper', '--st'], SV: ['Slurve', '--cu'], CU: ['Curveball', '--cu'],
    KC: ['Knuckle curve', '--cu'], CS: ['Slow curve', '--cu'], CH: ['Changeup', '--ch'],
    FS: ['Splitter', '--fs'], FO: ['Forkball', '--fs'], SC: ['Screwball', '--ch'], KN: ['Knuckleball', '--kn'],
    EP: ['Eephus', '--kn'], FA: ['Fastball', '--ff'], PO: ['Pitchout', '--kn'],
  };
  const css = getComputedStyle(document.documentElement);
  const color = (t) => (PT[t] ? css.getPropertyValue(PT[t][1]).trim() : '#8593ad') || '#8593ad';
  const ptName = (t) => (PT[t] ? PT[t][0] : t || 'Pitch');
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const ord = (n) => n + (['th', 'st', 'nd', 'rd'][(n % 100 > 10 && n % 100 < 14) ? 0 : n % 10] || 'th');
  const pct = (p) => `${Math.round(p * 100)}%`;
  const spct = (d, digits = 0) => `${d >= 0 ? '+' : '−'}${Math.abs(d * 100).toFixed(digits)}%`;
  const last = (name) => { const p = String(name || '').split(' '); return p.length > 1 ? p.slice(1).join(' ') : name; };
  const half = (top, inn) => `${top ? 'Top' : 'Bot'} ${ord(inn)}`;
  const arrow = (top) => (top ? '▲' : '▼');
  const round = (g) => {
    const r = g.round || '';
    if (/World Series/.test(r)) return 'World Series';
    if (/Championship|CS/.test(r)) return 'LCS';
    if (/Division|DS/.test(r)) return 'DS';
    if (/Wild Card/.test(r)) return 'Wild Card';
    return r;
  };
  const roundLabel = (g) => (g.desc || '').replace(/'([AB])'/, '$1').replace(/, Makeup of [\d/]+/, '');
  const day = (iso, opts = { month: 'short', day: 'numeric' }) => {
    const d = new Date(iso + 'T12:00:00');
    return isNaN(d) ? iso : d.toLocaleDateString('en-US', opts);
  };
  return { PT, color, ptName, esc, ord, pct, spct, last, half, arrow, round, roundLabel, day };
})();
