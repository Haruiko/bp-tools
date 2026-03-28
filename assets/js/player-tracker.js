/* ─────────────────────────────────────────────
   Player Tracker — client-side logic
   Fetches from http://localhost:7777/players
   (served by BP-Player-Tracker.exe)
   ───────────────────────────────────────────── */

const FIREBASE_URL = 'https://bp-player-tracker-db-default-rtdb.asia-southeast1.firebasedatabase.app/players.json';
const POLL_MS      = 15_000;      // refresh every 15 s
const RETRY_MS     = 30_000;      // retry after network error

const GUILD_KEY = 'pt_guild_members'; // localStorage key
const CACHE_KEY = 'pt_players_cache'; // localStorage key for cached player data

// ── DOM refs ───────────────────────────────────────────────
const dot            = document.getElementById('pt-status-dot');
const statusText     = document.getElementById('pt-status-text');
const statusCount    = document.getElementById('pt-status-count');
const statusTime     = document.getElementById('pt-status-time');
const notice         = document.getElementById('pt-notice');
const tbody          = document.getElementById('pt-tbody');
const searchInput    = document.getElementById('pt-search');
const sortSelect     = document.getElementById('pt-sort');
const viewSelect     = document.getElementById('pt-view');
const refreshBtn     = document.getElementById('pt-refresh-btn');
const guildPanel     = document.getElementById('pt-guild-panel');
const guildTags      = document.getElementById('pt-guild-tags');
const guildNameInput = document.getElementById('pt-guild-name-input');
const guildAddBtn    = document.getElementById('pt-guild-add-btn');
const guildEmptyHint = document.getElementById('pt-guild-empty-hint');

// ── State ──────────────────────────────────────────────────
let allPlayers   = [];
let pollTimer    = null;
let isOnline     = false;

// ── Cache helpers ──────────────────────────────────────────
function savePlayersCache(players) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ players, savedAt: new Date().toISOString() }));
  } catch { /* storage full or private mode */ }
}

function loadPlayersCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function timeAgo(isoStr) {
  if (!isoStr) return '?';
  const mins = Math.floor((Date.now() - new Date(isoStr).getTime()) / 60000);
  if (mins < 1)  return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ${mins % 60}m ago`;
}

// ── Guild helpers ──────────────────────────────────────────
function loadGuildMembers() {
  try { return JSON.parse(localStorage.getItem(GUILD_KEY) || '[]'); }
  catch { return []; }
}

function saveGuildMembers(list) {
  localStorage.setItem(GUILD_KEY, JSON.stringify(list));
}

function addGuildMember(name) {
  const trimmed = name.trim();
  if (!trimmed) return;
  const list = loadGuildMembers();
  if (list.some(n => n.toLowerCase() === trimmed.toLowerCase())) return; // already in list
  list.push(trimmed);
  saveGuildMembers(list);
  renderGuildTags();
  render(allPlayers);
}

function removeGuildMember(name) {
  const list = loadGuildMembers().filter(n => n.toLowerCase() !== name.toLowerCase());
  saveGuildMembers(list);
  renderGuildTags();
  render(allPlayers);
}

function renderGuildTags() {
  const list = loadGuildMembers();
  guildEmptyHint.hidden = list.length > 0;
  guildTags.innerHTML = list.map(name => `
    <span class="pt-guild-tag">
      <span class="pt-guild-tag-name">${escHtml(name)}</span>
      <button class="pt-guild-tag-remove" data-name="${escHtml(name)}" title="Remove">&#x2715;</button>
    </span>
  `).join('');
}

// ── Bootstrap ──────────────────────────────────────────────
searchInput.addEventListener('input', () => render(allPlayers));
sortSelect.addEventListener('change', () => render(allPlayers));
viewSelect.addEventListener('change', () => {
  const isGuild = viewSelect.value === 'guild';
  guildPanel.hidden = !isGuild;
  if (isGuild) renderGuildTags();
  render(allPlayers);
});

// Guild add via button or Enter key
guildAddBtn.addEventListener('click', () => {
  addGuildMember(guildNameInput.value);
  guildNameInput.value = '';
  guildNameInput.focus();
});
guildNameInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    addGuildMember(guildNameInput.value);
    guildNameInput.value = '';
  }
});

// Guild tag removal (event delegation)
guildTags.addEventListener('click', e => {
  const btn = e.target.closest('.pt-guild-tag-remove');
  if (btn) removeGuildMember(btn.dataset.name);
});

refreshBtn.addEventListener('click', () => {
  refreshBtn.classList.add('spinning');
  setTimeout(() => refreshBtn.classList.remove('spinning'), 600);
  fetchPlayers();
});

fetchPlayers();

// ── Fetch ──────────────────────────────────────────────────
async function fetchPlayers() {
  setStatus('loading', 'Connecting…');

  try {
    const res = await fetch(FIREBASE_URL, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json();

    if (data.error) {
      setStatus('offline', `Server error: ${data.error}`);
      showNotice(true);
      schedule(RETRY_MS);
      return;
    }

    allPlayers = data.players ?? [];
    isOnline   = true;
    savePlayersCache(allPlayers);

    setStatus('online',
      'Live — last updated ' + timeAgo(data.updatedAt),
      allPlayers.length,
      data.updatedAt
    );
    showNotice(false);
    render(allPlayers);
    schedule(POLL_MS);

  } catch {
    isOnline = false;

    // Try to show cached data while offline
    const cached = loadPlayersCache();
    if (cached && allPlayers.length === 0) {
      allPlayers = cached.players;
      const savedAt = cached.savedAt ? new Date(cached.savedAt).toLocaleString() : '?';
      setStatus('offline', `No internet — showing cached data from ${savedAt}`);
    } else {
      setStatus('offline', 'Cannot reach server — no cached data available');
    }
    showNotice(true);

    if (allPlayers.length === 0) {
      tbody.innerHTML = '<tr class="pt-empty-row"><td colspan="5">No data yet — start BP-Player-Tracker.exe</td></tr>';
    } else {
      render(allPlayers);
    }

    schedule(RETRY_MS);
  }
}

// ── Render table ───────────────────────────────────────────
function render(players) {
  const query    = searchInput.value.trim().toLowerCase();
  const sort     = sortSelect.value;
  const isGuild  = viewSelect.value === 'guild';
  const guildSet = isGuild
    ? new Set(loadGuildMembers().map(n => n.toLowerCase()))
    : null;

  let list = [...players];

  // Guild filter first
  if (guildSet) {
    list = list.filter(p => guildSet.has(p.name.toLowerCase()));
  }

  // Then name search
  if (query) {
    list = list.filter(p => p.name.toLowerCase().includes(query));
  }

  if (sort === 'level') {
    list.sort((a, b) => b.level - a.level || b.abilityScore - a.abilityScore);
  } else if (sort === 'name') {
    list.sort((a, b) => a.name.localeCompare(b.name));
  } else {
    // abilityScore — already presorted by server, but re-sort client-side after filter
    list.sort((a, b) => b.abilityScore - a.abilityScore);
  }

  if (list.length === 0) {
    let msg;
    if (isGuild && loadGuildMembers().length === 0) {
      msg = 'No guild members added yet — use the list above to add names.';
    } else if (isGuild) {
      msg = 'None of your guild members have been seen in this session yet.';
    } else if (query) {
      msg = `No players match "<em>${escHtml(query)}</em>"`;
    } else {
      msg = 'No players found in this session yet';
    }
    tbody.innerHTML = `<tr class="pt-empty-row"><td colspan="5">${msg}</td></tr>`;
    return;
  }

  tbody.innerHTML = list.map((p, i) => {
    const rank      = i + 1;
    const rankClass = rank === 1 ? 'gold' : rank === 2 ? 'silver' : rank === 3 ? 'bronze' : '';
    const specHtml  = p.professionSpec
      ? `<span class="pt-spec">${escHtml(p.professionSpec)}</span>`
      : `<span class="pt-spec pt-spec-none">—</span>`;
    const illusionHtml = p.illusionStrength > 0
      ? `<span class="pt-illusion">✶ ${p.illusionStrength.toLocaleString()}</span>`
      : '';

    return `
      <tr>
        <td class="pt-col-rank">
          <span class="pt-rank ${rankClass}">${rank}</span>
        </td>
        <td class="pt-col-name">
          <span class="pt-name">${escHtml(p.name)}</span>
        </td>
        <td class="pt-col-level">
          <span class="pt-level">${p.level}</span>
        </td>
        <td class="pt-col-as">
          <span class="pt-as">${p.abilityScore.toLocaleString()}</span>${illusionHtml}
        </td>
        <td class="pt-col-spec">${specHtml}</td>
      </tr>`;
  }).join('');
}

// ── Helpers ────────────────────────────────────────────────
function setStatus(state, text, count, updatedAt) {
  dot.className = `pt-status-dot ${state}`;
  statusText.textContent = text;

  statusCount.textContent = count != null
    ? `${count} player${count !== 1 ? 's' : ''}`
    : '';

  statusTime.textContent = updatedAt
    ? `Updated ${new Date(updatedAt).toLocaleTimeString()}`
    : '';
}

function showNotice(show) {
  notice.hidden = !show;
}

function schedule(ms) {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(fetchPlayers, ms);
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
