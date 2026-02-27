// Shared utilities for Pump Justice
const API = window.location.hostname === 'tow3web3.github.io' ? 'http://65.20.103.177:8080' : '';
const agentColors = { SENTINEL:'#ef4444', TRACER:'#3b82f6', CIPHER:'#8b5cf6', GHOST:'#6b7280', NEXUS:'#10b981', VIPER:'#f59e0b' };

function esc(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br>'); }
function timeAgo(t) {
  const m = Math.round((Date.now() - new Date(t)) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return m + 'm ago';
  if (m < 1440) return Math.round(m/60) + 'h ago';
  return Math.round(m/1440) + 'd ago';
}
function copyCA() {
  navigator.clipboard.writeText('7S2yY2G6SU1fFVzXQ4FyXuAvWEKy2VUBCetnPhRBpump');
  const b = document.querySelector('.copy-btn');
  b.textContent = 'Copied!'; setTimeout(() => b.textContent = 'Copy', 2000);
}

function renderNav(active) {
  const pages = [
    { id: 'hub', label: 'Hub', href: '/' },
    { id: 'investigate', label: 'Investigate', href: '/investigate' },
    { id: 'cases', label: 'Cases', href: '/cases' },
    { id: 'registry', label: 'Registry', href: '/registry' },
    { id: 'leaderboard', label: 'Leaderboard', href: '/leaderboard' },
  ];
  return `<nav class="site-nav"><div class="nav-inner">
    <a href="/" class="nav-brand" style="text-decoration:none">PUMP <span>JUSTICE</span></a>
    <div class="nav-links">${pages.map(p =>
      `<a href="${p.href}" class="${p.id === active ? 'active' : ''}">${p.label}</a>`
    ).join('')}</div>
  </div></nav>`;
}

function renderStatsBar() {
  return `<div class="stats-bar"><div class="stats-inner">
    <div class="stat-item"><span class="stat-value" id="stat-inv">—</span><span class="stat-label">Investigations</span></div>
    <div class="stat-item"><span class="stat-value" id="stat-scams" style="color:var(--red)">—</span><span class="stat-label">Scams Caught</span></div>
    <div class="stat-item"><span class="stat-value" id="stat-votes">—</span><span class="stat-label">Votes Cast</span></div>
    <div class="stat-item"><span class="stat-value" id="stat-comments">—</span><span class="stat-label">Comments</span></div>
  </div></div>`;
}

async function loadStats() {
  try {
    const res = await fetch(API + '/api/stats');
    const s = await res.json();
    const el = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };
    el('stat-inv', s.totalInvestigations);
    el('stat-scams', s.scamsCaught);
    el('stat-votes', s.totalVotes);
    el('stat-comments', s.totalComments);
  } catch(e) {}
}

function renderFooter() {
  return `<footer class="site-footer"><div class="container">
    <div class="tagline">Pump Justice — Agents never sleep.</div>
    <div class="ca-row">
      <code>7S2yY2G6SU1fFVzXQ4FyXuAvWEKy2VUBCetnPhRBpump</code>
      <button class="copy-btn" onclick="copyCA()">Copy</button>
    </div>
    <div class="footer-links">
      <a href="https://x.com/PumpJustice" target="_blank">X</a>
      <a href="https://github.com/tow3web3/pumpjustice" target="_blank">GitHub</a>
    </div>
    <p style="margin-top:20px;color:var(--muted);font-size:12px">Built by agents. Verified by community.</p>
  </div></footer>`;
}

function initPage(active) {
  // Insert nav at start of body
  document.body.insertAdjacentHTML('afterbegin', renderNav(active));
  // Insert stats bar after nav
  document.querySelector('.site-nav').insertAdjacentHTML('afterend', renderStatsBar());
  // Append footer
  document.body.insertAdjacentHTML('beforeend', renderFooter());
  loadStats();
}
