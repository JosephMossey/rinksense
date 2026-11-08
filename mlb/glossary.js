/* RINKSENSE MLB glossary page: renders RSM_TERMS with scales and October examples from data/glossary.js. */
(() => {
  'use strict';
  const TERMS = window.RSM_TERMS || [], D = window.RS_MLB_GLOSS || { scales: {}, ex: {} };
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const d3 = (v) => (+v).toFixed(3).replace(/^0/, '').replace(/^-0/, '-');
  const FMT = { d3, pct: (v) => `${Math.round(v * 100)}%`, n1: (v) => (+v).toFixed(1), n0: (v) => Math.round(v).toLocaleString('en-US') };
  const fill = (s) => s
    .replace('{tto2}', D.tto ? `+${d3(D.tto['2'])}` : 'a bit')
    .replace('{tto3}', D.tto ? `+${d3(D.tto['3'])}` : 'more')
    .replace('{brier}', D.brier ? D.brier.post_brier.toFixed(3) : '')
    .replace('{brierMlb}', D.brier ? D.brier.post_brier_mlb.toFixed(3) : '');

  function scaleHTML(t) {
    if (t.bands) {
      return `<div class="glscale"><div class="glbar">${t.bands.map((_, i) => `<i class="b${i}"></i>`).join('')}</div>` +
        `<div class="gllabels">${t.bands.map(([v, l]) => `<span><b>${esc(v)}</b>${esc(l)}</span>`).join('')}</div></div>`;
    }
    const s = D.scales[t.scale];
    if (!s) return '';
    const f = FMT[t.fmt] || String, u = t.unit || '';
    const labels = t.labels || ['poor', 'average', 'good', 'elite'];
    const note = t.labels ? `Spread of all ${s.n.toLocaleString('en-US')} swings and misses in 2026` :
      `2026 regular season · ${s.hb === false ? 'lower is better · ' : ''}10th, 50th, 75th and 90th percentile`;
    return `<div class="glscale"><div class="glbar">${labels.map((_, i) => `<i class="b${i}"></i>`).join('')}</div>` +
      `<div class="gllabels">${s.cuts.map((c, i) => `<span><b>${f(c)}${u}</b>${labels[i]}</span>`).join('')}</div><div class="glnote">${note}</div></div>`;
  }
  const exHTML = (key) => {
    const e = key && D.ex[key];
    return e ? `<a class="glex" href="${esc(e.href)}"><span>October</span>${esc(e.t)}<i>→</i></a>` : '';
  };
  const card = (t) => `<article class="card glcard" id="${t.k}">
      <div class="glhead"><h2>${esc(t.name)}</h2><span class="gl">${esc(t.cat)}</span></div>
      <p class="glshort">${esc(fill(t.short))}</p>
      <p class="glplain">${esc(fill(t.plain))}</p>
      ${scaleHTML(t)}${exHTML(t.ex)}${exHTML(t.ex2)}
      ${t.more ? `<a class="glmore" href="methods.html${t.more}">How it's built</a>` : ''}
    </article>`;

  let cat = '', q = '';
  function draw() {
    const list = TERMS.filter((t) => (!cat || t.cat === cat) &&
      (!q || `${t.name} ${t.short} ${t.plain} ${(t.alias || []).join(' ')}`.toLowerCase().includes(q)));
    $('glGrid').innerHTML = list.map(card).join('') || '<p class="empty">No stat matches that search.</p>';
    $('glCount').textContent = `${list.length} stats`;
  }
  document.querySelectorAll('#glCat button').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('#glCat button').forEach((x) => x.classList.toggle('on', x === b));
    cat = b.dataset.v; draw();
  }));
  $('glSearch').addEventListener('input', (e) => { q = e.target.value.trim().toLowerCase(); draw(); });
  draw();
  const hl = () => {
    const el = location.hash && document.getElementById(location.hash.slice(1));
    document.querySelectorAll('.glcard.hl').forEach((x) => x.classList.remove('hl'));
    if (el) { el.classList.add('hl'); el.scrollIntoView({ block: 'start' }); }
  };
  window.addEventListener('hashchange', hl);
  hl();
  window.RS_MLB_GLOSSARY = { terms: TERMS.length };
})();
