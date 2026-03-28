/* ─────────────────────────────────────────────
   Player Tracker — client-side logic
   Fetches from http://localhost:7777/players
   (served by BP-Player-Tracker.exe)
   ───────────────────────────────────────────── */

const FIREBASE_URL = 'https://bp-player-tracker-db-default-rtdb.asia-southeast1.firebasedatabase.app/players.json';
const RETRY_MS     = 10_000;      // SSE reconnect delay after connection loss

const GUILD_KEY   = 'pt_guild_members'; // localStorage key
const CACHE_KEY   = 'pt_players_cache'; // localStorage key for cached player data
const DAILY_KEY   = 'pt_daily_v1';      // localStorage key for daily stat tracking

// ── DOM refs ───────────────────────────────────────────────
const dot            = document.getElementById('pt-status-dot');
const statusText     = document.getElementById('pt-status-text');
const statusCount    = document.getElementById('pt-status-count');
const statusTime     = document.getElementById('pt-status-time');
const statTotal      = document.getElementById('pt-stat-total');
const statScanned    = document.getElementById('pt-stat-scanned');
const statNew        = document.getElementById('pt-stat-new');
const statUpdated    = document.getElementById('pt-stat-updated');
const notice         = document.getElementById('pt-notice');
const tbody          = document.getElementById('pt-tbody');
const searchInput    = document.getElementById('pt-search');
const sortSelect     = document.getElementById('pt-sort');
const viewSelect     = document.getElementById('pt-view');
const refreshBtn     = document.getElementById('pt-refresh-btn');
const actionHeader   = document.getElementById('pt-col-action-header');

// ── State ──────────────────────────────────────────────────
let allPlayers      = [];
let isOnline        = false;
let eventSource     = null;   // Firebase SSE connection
let reconnectTimer  = null;

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

// ── Daily stat tracking ────────────────────────────────────
// Persists across page refreshes; resets at midnight.
function getTodayStr() {
  return new Date().toISOString().slice(0, 10); // "YYYY-MM-DD" in UTC
}

function loadDailyStats() {
  try {
    const raw = localStorage.getItem(DAILY_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    return s.date === getTodayStr() ? s : null; // discard if new day
  } catch { return null; }
}

function saveDailyStats(s) {
  try { localStorage.setItem(DAILY_KEY, JSON.stringify(s)); } catch {}
}

// Called after every Firebase push. Diffs the new player list against the
// daily baseline and accumulates scanned / new / updated counters.
function accumulateDailyStats() {
  let s = loadDailyStats();

  if (!s) {
    // First snapshot of the day — everything currently in DB is the baseline.
    s = {
      date:          getTodayStr(),
      baselineNames: allPlayers.map(p => p.name),
      scannedNames:  allPlayers.map(p => p.name),
      newNames:      [],
      updatedNames:  [],
      lastScores:    Object.fromEntries(allPlayers.map(p => [p.name, p.abilityScore])),
    };
    saveDailyStats(s);
    return { scanned: s.scannedNames.length, newP: 0, updated: 0 };
  }

  const baselineSet = new Set(s.baselineNames);
  const scannedSet  = new Set(s.scannedNames);
  const newSet      = new Set(s.newNames);
  const updatedSet  = new Set(s.updatedNames);

  for (const p of allPlayers) {
    scannedSet.add(p.name);

    if (!baselineSet.has(p.name)) {
      // Player wasn't in DB at start of day → genuinely new
      newSet.add(p.name);
    } else if (
      s.lastScores[p.name] !== undefined &&
      s.lastScores[p.name] !== p.abilityScore
    ) {
      // Existing player with a changed ability score → updated
      updatedSet.add(p.name);
    }

    s.lastScores[p.name] = p.abilityScore;
  }

  s.scannedNames = [...scannedSet];
  s.newNames     = [...newSet];
  s.updatedNames = [...updatedSet];
  saveDailyStats(s);

  return {
    scanned: s.scannedNames.length,
    newP:    s.newNames.length,
    updated: s.updatedNames.length,
  };
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



// ── Bootstrap ──────────────────────────────────────────────
searchInput.addEventListener('input', () => render(allPlayers));
sortSelect.addEventListener('change', () => render(allPlayers));
viewSelect.addEventListener('change', () => {
  render(allPlayers);
});

// Table row button delegation: + to add, - to remove
tbody.addEventListener('click', e => {
  const addBtn = e.target.closest('.pt-add-guild-btn');
  if (addBtn) {
    addGuildMember(addBtn.dataset.name);
    addBtn.textContent = '✓';
    addBtn.disabled = true;
    addBtn.classList.add('pt-add-guild-btn--added');
    return;
  }
  const removeBtn = e.target.closest('.pt-remove-guild-btn');
  if (removeBtn) removeGuildMember(removeBtn.dataset.name);
});

refreshBtn.addEventListener('click', () => {
  refreshBtn.classList.add('spinning');
  setTimeout(() => refreshBtn.classList.remove('spinning'), 600);
  connectRealtime();
});

connectRealtime();

// ── Real-time connection (Firebase SSE) ──────────────────────────
// Firebase Realtime Database pushes 'put' events over SSE whenever
// data changes, so the page updates the instant the exe writes.
function connectRealtime() {
  clearTimeout(reconnectTimer);
  if (eventSource) { eventSource.close(); eventSource = null; }

  setStatus('loading', 'Connecting…');

  eventSource = new EventSource(FIREBASE_URL);

  // Initial snapshot + every subsequent change pushed by Firebase
  eventSource.addEventListener('put', (e) => {
    try {
      const payload = JSON.parse(e.data);
      if (payload && payload.data) handleData(payload.data);
    } catch { /* malformed event */ }
  });

  // Partial update — do a one-shot REST fetch for simplicity
  eventSource.addEventListener('patch', () => fetchOnce());

  eventSource.onerror = () => {
    eventSource.close();
    eventSource = null;
    isOnline = false;

    const cached = loadPlayersCache();
    if (cached && allPlayers.length === 0) {
      allPlayers = cached.players;
      render(allPlayers);
      const savedAt = cached.savedAt ? new Date(cached.savedAt).toLocaleString() : '?';
      setStatus('offline', `Connection lost — showing cached data from ${savedAt}`);
    } else {
      setStatus('offline', 'Connection lost — reconnecting…');
    }
    showNotice(true);

    reconnectTimer = setTimeout(connectRealtime, RETRY_MS);
  };
}

// One-shot REST fetch used for patch events
async function fetchOnce() {
  try {
    const res = await fetch(FIREBASE_URL, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return;
    const data = await res.json();
    if (data && !data.error) handleData(data);
  } catch { /* SSE will handle reconnect */ }
}

// Shared handler for both SSE put payloads and REST responses
function handleData(data) {
  if (data.error) {
    setStatus('offline', `Server error: ${data.error}`);
    showNotice(true);
    return;
  }

  allPlayers = data.players ?? [];
  isOnline   = true;
  savePlayersCache(allPlayers);

  updateStats(data);
  setStatus('online', 'Live — last updated ' + timeAgo(data.updatedAt), null, data.updatedAt);
  showNotice(false);
  render(allPlayers);
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

  // Guild filter
  if (guildSet) {
    list = list.filter(p => guildSet.has(p.name.toLowerCase()));
  }

  // Sort before capping
  if (sort === 'level') {
    list.sort((a, b) => b.level - a.level || b.abilityScore - a.abilityScore);
  } else if (sort === 'name') {
    list.sort((a, b) => a.name.localeCompare(b.name));
  } else {
    list.sort((a, b) => b.abilityScore - a.abilityScore);
  }

  // Cap to top 100 in All Players view with no search query;
  // when searching, show all matches regardless of rank
  if (!isGuild && !query) {
    list = list.slice(0, 100);
  }

  // Name search (across full sorted list when query present)
  if (query) {
    list = list.filter(p => p.name.toLowerCase().includes(query));
  }

  if (list.length === 0) {
    let msg;
    if (isGuild && loadGuildMembers().length === 0) {
      msg = 'No guild members added yet — switch to All Players and click + on a row to add members.';
    } else if (isGuild) {
      msg = 'None of your guild members have been seen in this session yet.';
    } else if (query) {
      msg = `No players match "<em>${escHtml(query)}</em>"`;
    } else {
      msg = 'No players found in this session yet';
    }
    tbody.innerHTML = `<tr class="pt-empty-row"><td colspan="6">${msg}</td></tr>`;
    return;
  }

  const guildMembers = loadGuildMembers().map(n => n.toLowerCase());

  tbody.innerHTML = list.map((p, i) => {
    const rank      = i + 1;
    const rankClass = rank === 1 ? 'gold' : rank === 2 ? 'silver' : rank === 3 ? 'bronze' : '';
    const specHtml  = p.professionSpec
      ? `<span class="pt-spec">${escHtml(p.professionSpec)}</span>`
      : `<span class="pt-spec pt-spec-none">—</span>`;
    const illusionHtml = p.illusionStrength > 0
      ? `<span class="pt-illusion">✶ ${p.illusionStrength.toLocaleString()}</span>`
      : '';
    const alreadyInGuild = guildMembers.includes(p.name.toLowerCase());
    const actionCell = isGuild
      ? `<td class="pt-col-action">
          <button class="pt-remove-guild-btn"
                  data-name="${escHtml(p.name)}"
                  title="Remove from guild">−</button>
        </td>`
      : `<td class="pt-col-action">
          <button class="pt-add-guild-btn${alreadyInGuild ? ' pt-add-guild-btn--added' : ''}"
                  data-name="${escHtml(p.name)}"
                  title="Add to guild"
                  ${alreadyInGuild ? 'disabled' : ''}>
            ${alreadyInGuild ? '✓' : '+'}
          </button>
        </td>`;

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
          <span class="pt-as-row">
            <span class="pt-as">${p.abilityScore.toLocaleString()}</span>${illusionHtml}
          </span>
        </td>
        <td class="pt-col-spec">${specHtml}</td>${actionCell}
      </tr>`;
  }).join('');
}

// ── Helpers ────────────────────────────────────────────────
function updateStats(data) {
  const total = data.totalPlayers ?? data.total_players ?? allPlayers.length;
  const { scanned, newP, updated } = accumulateDailyStats();

  if (statTotal)   statTotal.textContent   = Number(total).toLocaleString();
  if (statScanned) statScanned.textContent = scanned.toLocaleString();
  if (statNew)     statNew.textContent     = newP.toLocaleString();
  if (statUpdated) statUpdated.textContent = updated.toLocaleString();
}

function setStatus(state, text, count, updatedAt) {
  dot.className = `pt-status-dot ${state}`;
  statusText.textContent = text;

  statusCount.textContent = '';

  statusTime.textContent = updatedAt
    ? `Updated ${new Date(updatedAt).toLocaleTimeString()}`
    : '';
}

function showNotice(show) {
  notice.hidden = !show;
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
