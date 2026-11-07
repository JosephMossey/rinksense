/* RINKSENSE player pages: helpers shared by players.html and player.html. */
window.RSP = (() => {
  'use strict';
  const D = window.RS_PLAYERS || { games: [], players: [] };
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
  const pName = (p) => (p === 4 ? 'OT' : `P${p}`);

  // One color per team across every game (the replay colors teams home/away instead).
  const teams = [...new Set(D.players.map((p) => p.team))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const HUES = [8, 34, 80, 215, 140, 185, 265, 305, 165, 345, 245, 105];
  const color = (team) => {
    const i = teams.indexOf(team);
    return i < 0 ? '#8593ad' : `hsl(${HUES[i % HUES.length]} 72% 66%)`;
  };
  const gameById = Object.fromEntries(D.games.map((g, i) => [g.id, Object.assign({ i }, g)]));
  const day = (iso, opts) => {
    const d = new Date(iso + 'T12:00:00');
    return isNaN(d) ? iso : d.toLocaleDateString('en-US', opts || { month: 'short', day: 'numeric' });
  };
  const url = (p) => `player.html?p=${encodeURIComponent(p.id)}`;
  const label = (p) => `#${p.j} ${p.team}`;
  const chip = (p) => `<i class="dot" style="background:${color(p.team)}"></i>`;

  return { D, esc, fmt, pName, teams, color, gameById, day, url, label, chip };
})();
