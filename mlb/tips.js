/* RINKSENSE MLB stat tooltips: any stat label that matches a glossary term gets a dotted underline
   and a plain-English tooltip with a link to its glossary entry. Works on content drawn later too. */
(() => {
  'use strict';
  const TERMS = window.RSM_TERMS || [];
  if (!TERMS.length) return;
  const byKey = new Map(TERMS.map((t) => [t.k, t]));
  const alias = new Map();
  for (const t of TERMS) for (const a of t.alias || []) alias.set(a.toLowerCase(), t.k);
  const SEL = '.gl, .ctitle, .kl, th button, #boxTable th, .pltable td:first-child, .popkv span, .dg, .slabel';
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function labelOf(el) {
    const n = el.firstChild;
    const txt = n && n.nodeType === 3 ? n.textContent : el.children.length ? '' : el.textContent;
    return txt.replace(/\s*[↑↓]\s*$/, '').trim().toLowerCase();
  }
  function tag(root) {
    const els = root.matches && root.matches(SEL) ? [root] : [];
    if (root.querySelectorAll) els.push(...root.querySelectorAll(SEL));
    for (const el of els) {
      if (el.dataset.term) continue;
      const lab = labelOf(el);
      let key = alias.get(lab);
      if (!key && lab.startsWith('tunnel vs')) key = 'tunnel';
      if (!key) continue;
      el.dataset.term = key;
      el.classList.add('tterm');
      if (!el.hasAttribute('tabindex') && el.tagName !== 'BUTTON') el.tabIndex = 0;
    }
  }

  // ---- the tooltip itself ----
  const tip = document.createElement('div');
  tip.className = 'rstip';
  tip.setAttribute('role', 'tooltip');
  document.body.appendChild(tip);
  let hideT = 0, cur = null;
  function show(el) {
    const t = byKey.get(el.dataset.term);
    if (!t) return;
    clearTimeout(hideT);
    cur = el;
    tip.innerHTML = `<b>${esc(t.name)}</b>${esc(t.short)}<a href="glossary.html#${t.k}">Full definition →</a>`;
    tip.classList.add('show');
    const r = el.getBoundingClientRect(), w = tip.offsetWidth, h = tip.offsetHeight;
    let x = r.left + window.scrollX + r.width / 2 - w / 2;
    x = Math.max(8 + window.scrollX, Math.min(x, window.scrollX + document.documentElement.clientWidth - w - 8));
    let y = r.bottom + window.scrollY + 8;
    if (r.bottom + h + 16 > window.innerHeight && r.top > h + 16) y = r.top + window.scrollY - h - 8;
    tip.style.left = `${x}px`; tip.style.top = `${y}px`;
  }
  function hide(delay = 180) { clearTimeout(hideT); hideT = setTimeout(() => { tip.classList.remove('show'); cur = null; }, delay); }
  document.addEventListener('mouseover', (e) => {
    const el = e.target.closest('.tterm');
    if (el) show(el); else if (!e.target.closest('.rstip')) hide();
  });
  tip.addEventListener('mouseover', () => clearTimeout(hideT));
  document.addEventListener('focusin', (e) => { const el = e.target.closest('.tterm'); if (el) show(el); });
  document.addEventListener('focusout', (e) => { if (e.target.closest('.tterm')) hide(); });
  // touch: tap a label to open, tap anywhere else to close
  document.addEventListener('touchstart', (e) => {
    const el = e.target.closest('.tterm');
    if (el) { if (cur === el) hide(0); else show(el); } else if (!e.target.closest('.rstip')) hide(0);
  }, { passive: true });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hide(0); });
  window.addEventListener('scroll', () => { if (cur) hide(0); }, { passive: true });

  tag(document.body);
  new MutationObserver((muts) => {
    for (const m of muts) for (const n of m.addedNodes) if (n.nodeType === 1 && !(n instanceof SVGElement)) tag(n);
  }).observe(document.body, { childList: true, subtree: true });
  window.RSM_TIPS = { tag, count: () => document.querySelectorAll('.tterm').length };
})();
