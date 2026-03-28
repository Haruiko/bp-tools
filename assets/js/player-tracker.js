/* ─────────────────────────────────────────────
   Player Tracker — client-side logic
   Fetches from http://localhost:7777/players
   (served by BP-Player-Tracker.exe)
   ───────────────────────────────────────────── */

const FIREBASE_BASE  = 'https://bp-player-tracker-db-default-rtdb.asia-southeast1.firebasedatabase.app';
const FIREBASE_URL          = FIREBASE_BASE + '/players.json';
const GUILDS_FB_URL         = FIREBASE_BASE + '/guilds.json';
const DELETED_GUILDS_FB_URL = FIREBASE_BASE + '/deleted_guilds.json';
const RETRY_MS       = 10_000;      // SSE reconnect delay after connection loss

const PROFILE_KEY = 'pt_profile_v1'; // localStorage key for visitor profile (must persist between visits)

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
let allGuilds       = [];   // guild registry — loaded from Firebase, never cached locally
let isOnline        = false;
let eventSource     = null;   // Firebase SSE connection
let reconnectTimer      = null;
let modalSelectedGuild  = null; // guild selected inside the profile modal
let modalSelectedPlayer = null; // player record selected from DB search
let _dailyStats     = null;   // session-only daily stat accumulator (resets on page load)

// ── Daily stat tracking (session-only, resets on page load) ──────────────
function getTodayStr() {
  return new Date().toISOString().slice(0, 10);
}
function loadDailyStats()  { return _dailyStats; }
function saveDailyStats(s) { _dailyStats = s; }

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

// ── Profile helpers ─────────────────────────────────────────
function loadProfile() {
  try { return JSON.parse(localStorage.getItem(PROFILE_KEY) || 'null'); }
  catch { return null; }
}
function saveProfile(p) {
  try { localStorage.setItem(PROFILE_KEY, JSON.stringify(p)); } catch {}
}
function isAdmin(profile) {
  return profile?.inGameName?.toLowerCase() === 'aira';
}

// ── Guild registry (in-memory, sourced from Firebase) ─────────────────
function loadGuilds() { return allGuilds; }

async function fetchDeletedGuildIdsFromFirebase() {
  try {
    const res = await fetch(DELETED_GUILDS_FB_URL);
    if (!res.ok) return new Set();
    const obj = await res.json();
    if (!obj || typeof obj !== 'object') return new Set();
    return new Set(Object.keys(obj).filter(k => obj[k]));
  } catch { return new Set(); }
}

// Firebase uses objects keyed by ID; convert at the boundary
function guildsToFbObj(guilds) {
  const obj = {};
  guilds.forEach(g => { obj[g.id] = g; });
  return obj;
}
function fbObjToGuilds(obj) {
  if (!obj || typeof obj !== 'object') return [];
  return Object.values(obj).map(g => ({ ...g, members: Array.isArray(g.members) ? g.members : [] }));
}

async function fetchGuildsFromFirebase() {
  try {
    const [guildsRes, fbDeletedIds] = await Promise.all([
      fetch(GUILDS_FB_URL),
      fetchDeletedGuildIdsFromFirebase(),
    ]);
    if (!guildsRes.ok) return;
    const obj = await guildsRes.json();
    // Filter out any guilds that have been tombstoned in /deleted_guilds
    allGuilds = fbObjToGuilds(obj).filter(g => !fbDeletedIds.has(g.id));
  } catch { /* network unavailable — allGuilds stays as-is */ }
}

async function pushGuildsToFirebase(guilds) {
  try {
    // PATCH merges into existing data — won't overwrite other users' guilds
    const res = await fetch(GUILDS_FB_URL, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(guildsToFbObj(guilds)),
    });
    if (!res.ok) {
      const msg = await res.text().catch(() => '');
      console.warn('[PlayerTracker] Guild sync failed (', res.status, '):', msg);
    }
  } catch (err) {
    console.warn('[PlayerTracker] Guild sync error:', err);
  }
}

async function deleteGuild(guildId) {
  // 1. Remove from in-memory store
  allGuilds = allGuilds.filter(g => g.id !== guildId);
  // 2. Persist deletion in Firebase so all other browsers inherit the tombstone
  await Promise.allSettled([
    // Record in /deleted_guilds so any client can know this was intentionally removed
    fetch(DELETED_GUILDS_FB_URL, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [guildId]: true }),
    }),
    // Null out the guild node in /guilds (Firebase treats null value in PATCH as deletion)
    fetch(GUILDS_FB_URL, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [guildId]: null }),
    }),
  ]);
  renderGuildPanel();
  render(allPlayers);
}

function saveGuilds(guilds) {
  allGuilds = guilds; // update in-memory store
  pushGuildsToFirebase(guilds); // sync to Firebase in the background
}
function getGuildById(id) {
  return allGuilds.find(g => g.id === id) ?? null;
}
// Find the guild (if any) that already lists this player as a member
function findGuildByMember(playerName) {
  const lower = playerName.toLowerCase();
  return allGuilds.find(g => (g.members || []).some(m => m.toLowerCase() === lower)) ?? null;
}
function createGuild(name, id) {
  const guilds = loadGuilds();
  const guild = { id, name, members: [] };
  guilds.push(guild);
  saveGuilds(guilds);
  return guild;
}

// Attach the visitor's own name to a guild's members list and update their profile.
function joinGuild(guildId) {
  const profile = loadProfile();
  const myName  = profile?.inGameName;
  const guilds  = loadGuilds();

  // Remove self from any previous guild
  const prevId = profile?.guildId;
  if (prevId && prevId !== guildId) {
    const prevIdx = guilds.findIndex(g => g.id === prevId);
    if (prevIdx !== -1 && myName) {
      guilds[prevIdx].members = guilds[prevIdx].members
        .filter(n => n.toLowerCase() !== myName.toLowerCase());
    }
  }

  // Add self to new guild
  const idx = guilds.findIndex(g => g.id === guildId);
  if (idx !== -1 && myName) {
    if (!guilds[idx].members.some(n => n.toLowerCase() === myName.toLowerCase())) {
      guilds[idx].members.push(myName);
    }
  }

  saveGuilds(guilds);
  saveProfile({ ...profile, guildId });
}

// ── Guild member helpers (operate on current user’s guild) ───
function loadGuildMembers() {
  const profile = loadProfile();
  if (!profile?.guildId) return [];
  return getGuildById(profile.guildId)?.members ?? [];
}
function saveGuildMembers(list) {
  const profile = loadProfile();
  if (!profile?.guildId) return;
  const guilds = loadGuilds();
  const idx = guilds.findIndex(g => g.id === profile.guildId);
  if (idx === -1) return;
  guilds[idx].members = list;
  saveGuilds(guilds);
}
function addGuildMember(name) {
  const trimmed = name.trim();
  if (!trimmed) return;
  const list = loadGuildMembers();
  if (list.some(n => n.toLowerCase() === trimmed.toLowerCase())) return;
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
  if (viewSelect.value === 'guild') renderGuildPanel();
}



// ── Bootstrap ──────────────────────────────────────────────
searchInput.addEventListener('input', () => render(allPlayers));
sortSelect.addEventListener('change', () => render(allPlayers));
viewSelect.addEventListener('change', () => {
  const panel = document.getElementById('pt-guild-panel');
  if (panel) {
    panel.hidden = viewSelect.value !== 'guild';
    if (viewSelect.value === 'guild') renderGuildPanel();
  }
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

document.getElementById('pt-clear-cache-btn')?.addEventListener('click', async () => {
  const btn = document.getElementById('pt-clear-cache-btn');
  btn.disabled = true;
  btn.textContent = 'Clearing…';
  allPlayers = [];
  try {
    // Ask the local exe to wipe Firebase and repush fresh data
    const res = await fetch('http://localhost:7777/reset', { signal: AbortSignal.timeout(10000) });
    const data = await res.json();
    if (data.ok) {
      btn.textContent = `Done (✓ ${data.count} players)`;
    } else {
      btn.textContent = 'Cache cleared';
    }
  } catch {
    // Exe not running — at least browser cache is cleared
    btn.textContent = 'Local cache cleared';
  }
  setTimeout(() => { btn.textContent = 'Clear Cache'; btn.disabled = false; }, 3000);
  connectRealtime();
});

// Fetch shared guild data from Firebase before booting the UI
async function init() {
  await fetchGuildsFromFirebase();
  renderProfileBar();
  initProfileModal();
  if (!loadProfile()) showProfileModal();
  connectRealtime();
}
init();

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
    setStatus('offline', 'Connection lost — reconnecting…');
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
  if (!data || data.error) {
    if (data?.error) {
      setStatus('offline', `Server error: ${data.error}`);
      showNotice(true);
    }
    return;
  }

  // ── Detect format ──────────────────────────────────────────────────────────
  // New format: flat object keyed by player name → { "PlayerName": { name, level, lastSeen, ... } }
  // Old format: { updatedAt, count, players: [...] }
  // Mixed:      old PUT data + new PATCH entries coexist (transition period)

  // Collect name-keyed player entries (new format)
  const newEntries = Object.values(data).filter(
    v => v && typeof v === 'object' && typeof v.name === 'string' && typeof v.level === 'number' && v.level > 0
  );

  let players, updatedAt;

  if (newEntries.length > 0) {
    // New (or mixed) format — use keyed entries as primary source, supplement with
    // any old-format players not yet migrated (so top players never vanish during transition)
    const newNames = new Set(newEntries.map(p => p.name.toLowerCase()));
    const oldArray = Array.isArray(data.players) ? data.players : [];
    const oldOnly  = oldArray.filter(p => !newNames.has((p.name ?? '').toLowerCase()));
    players   = [...newEntries, ...oldOnly];
    updatedAt = newEntries.reduce((latest, p) => {
      if (!p.lastSeen) return latest;
      return !latest || p.lastSeen > latest ? p.lastSeen : latest;
    }, null) ?? data.updatedAt ?? null;
  } else if (Array.isArray(data.players)) {
    // Pure old format
    players   = data.players;
    updatedAt = data.updatedAt;
  } else {
    players   = [];
    updatedAt = null;
  }

  allPlayers = players;
  isOnline   = true;

  updateStats(data);
  setStatus('online', 'Live — last updated ' + timeAgo(updatedAt), null, updatedAt);
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

  const profile      = loadProfile();
  const hasGuild     = !!(profile?.guildId);
  const guildMembers = loadGuildMembers().map(n => n.toLowerCase());

  // Build a name → guild name lookup from all known guilds
  const allGuilds = loadGuilds();
  const playerGuildMap = {}; // lowercase name → guild name
  allGuilds.forEach(g => {
    (g.members || []).forEach(m => {
      playerGuildMap[m.toLowerCase()] = g.name;
    });
  });

  tbody.innerHTML = list.map((p, i) => {
    const rank      = i + 1;
    const rankClass = rank === 1 ? 'gold' : rank === 2 ? 'silver' : rank === 3 ? 'bronze' : '';
    const specIcon = p.professionSpec
      ? `<img class="pt-spec-icon" src="../assets/Image/${p.professionSpec.toLowerCase()}.png" alt="" aria-hidden="true">`
      : '';
    const specHtml  = p.professionSpec
      ? `<span class="pt-spec">${specIcon}${escHtml(p.professionSpec)}</span>`
      : `<span class="pt-spec pt-spec-none">—</span>`;
    const illusionHtml = p.illusionStrength > 0
      ? `<span class="pt-illusion">✶ ${p.illusionStrength.toLocaleString()}</span>`
      : '';
    const alreadyInGuild = guildMembers.includes(p.name.toLowerCase());
    const playerGuildName = playerGuildMap[p.name.toLowerCase()] ?? null;
    const actionCell = isGuild
      ? `<td class="pt-col-action">
          <button class="pt-remove-guild-btn"
                  data-name="${escHtml(p.name)}"
                  title="Remove from guild">−</button>
        </td>`
      : `<td class="pt-col-action">
          ${playerGuildName
            ? `<span class="pt-guild-badge" title="Guild: ${escHtml(playerGuildName)}">${escHtml(playerGuildName)}</span>`
            : `<button class="pt-add-guild-btn${!hasGuild ? ' pt-add-guild-btn--no-guild' : ''}"
                  data-name="${escHtml(p.name)}"
                  title="${!hasGuild ? 'Join a guild first' : 'Add to my guild'}"
                  ${!hasGuild ? 'disabled' : ''}>
              +
            </button>`
          }
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
          <span class="pt-level">${p.level}${p.seasonLevel > 0 ? `<span class="pt-season-level">(+${p.seasonLevel})</span>` : ''}</span>
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

// ── Guild panel ────────────────────────────────────────────
function renderGuildPanel() {
  const panel = document.getElementById('pt-guild-panel');
  if (!panel) return;

  const profile        = loadProfile();
  const currentGuildId = profile?.guildId ?? null;
  const guilds         = loadGuilds();
  const currentGuild   = currentGuildId ? guilds.find(g => g.id === currentGuildId) : null;
  const admin          = isAdmin(profile);

  panel.innerHTML = `
    <div class="pt-guild-panel-inner" style="grid-template-columns:1fr">
      <div class="pt-guild-col">
        ${currentGuild ? `
          <h3 class="pt-guild-col-title">Your Guild</h3>
          <div class="pt-guild-list-item pt-guild-list-item--active" style="margin-bottom:16px">
            <div class="pt-guild-list-info">
              <span class="pt-guild-list-name">${escHtml(currentGuild.name)}</span>
              <span class="pt-guild-list-meta">ID: ${escHtml(currentGuild.id)} · ${(currentGuild.members || []).length} member${(currentGuild.members || []).length !== 1 ? 's' : ''}</span>
            </div>
            <button class="pt-guild-leave-btn" data-gid="${escHtml(currentGuild.id)}">Leave</button>
          </div>
        ` : ''}

        <h3 class="pt-guild-col-title">
          ${currentGuild ? 'Find Another Guild' : 'Guilds'}
          <span class="pt-guild-col-count">${guilds.length}</span>
        </h3>
        <input type="search" class="pt-guild-search" id="pt-guild-list-search"
               placeholder="${currentGuild ? 'Search to find other guilds…' : 'Search guilds…'}" />
        <div class="pt-guild-list" id="pt-guild-list">
          ${guilds.length === 0
            ? `<p class="pt-guild-empty">No guilds yet — set up your profile to create one.</p>`
            : guilds
                .filter(g => g.id !== currentGuildId) // hide current guild here
                .map(g => `
                  <div class="pt-guild-list-item" style="display:none" data-guild-item>
                    <div class="pt-guild-list-info">
                      <span class="pt-guild-list-name">${escHtml(g.name)}</span>
                      <span class="pt-guild-list-meta">ID: ${escHtml(g.id)} · ${(g.members || []).length} member${(g.members || []).length !== 1 ? 's' : ''}</span>
                    </div>
                    ${currentGuild
                      ? `<span class="pt-guild-join-locked" title="Leave your current guild first">Leave first</span>`
                      : `<button class="pt-guild-join-btn" data-gid="${escHtml(g.id)}">Join</button>`
                    }
                    ${admin ? `<button class="pt-guild-delete-btn" data-gid="${escHtml(g.id)}" title="Delete guild">Delete</button>` : ''}
                  </div>`).join('')}
        </div>
      </div>
    </div>
  `;

  // Search reveals other guilds (hidden by default)
  document.getElementById('pt-guild-list-search').addEventListener('input', (e) => {
    const q = e.target.value.trim().toLowerCase();
    document.querySelectorAll('#pt-guild-list [data-guild-item]').forEach(el => {
      const name = el.querySelector('.pt-guild-list-name').textContent.toLowerCase();
      el.style.display = q && name.includes(q) ? '' : 'none';
    });
  });

  // Leave button
  panel.querySelector('.pt-guild-leave-btn')?.addEventListener('click', (e) => {
    const gid     = e.currentTarget.dataset.gid;
    const p       = loadProfile();
    const myName  = p?.inGameName;
    const guilds  = loadGuilds();
    const idx     = guilds.findIndex(g => g.id === gid);
    if (idx !== -1 && myName) {
      guilds[idx].members = guilds[idx].members.filter(n => n.toLowerCase() !== myName.toLowerCase());
      saveGuilds(guilds);
    }
    saveProfile({ ...p, guildId: null });
    renderGuildPanel();
    renderProfileBar();
    render(allPlayers);
  });

  // Join buttons (only shown when user has no current guild)
  panel.querySelectorAll('.pt-guild-join-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!loadProfile()?.inGameName) {
        showProfileModal();
        return;
      }
      joinGuild(btn.dataset.gid);
      renderGuildPanel();
      renderProfileBar();
      render(allPlayers);
    });
  });

  // Delete buttons (admin only)
  panel.querySelectorAll('.pt-guild-delete-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const guildName = btn.closest('[data-guild-item]')?.querySelector('.pt-guild-list-name')?.textContent ?? 'this guild';
      if (!confirm(`Delete "${guildName}"? This cannot be undone.`)) return;
      deleteGuild(btn.dataset.gid);
    });
  });
}

// ── Profile bar ────────────────────────────────────────────
function renderProfileBar() {
  const bar = document.getElementById('pt-profile-bar');
  if (!bar) return;
  const profile = loadProfile();
  if (!profile) {
    bar.innerHTML = `<button class="pt-profile-setup-btn" id="pt-profile-btn">👤 Set up your profile</button>`;
  } else {
    const guild = profile.guildId ? getGuildById(profile.guildId) : null;
    bar.innerHTML = `
      <span class="pt-profile-info">
        <span class="pt-profile-avatar">👤</span>
        <span class="pt-profile-name">${escHtml(profile.inGameName)}</span>
        ${guild ? `<span class="pt-profile-guild-badge">⚔️ ${escHtml(guild.name)}</span>` : ''}
      </span>
      <button class="pt-profile-edit-btn" id="pt-profile-btn">Edit</button>`;
  }
  document.getElementById('pt-profile-btn')?.addEventListener('click', () => showProfileModal());
}

// ── Profile modal ──────────────────────────────────────────
function showProfileModal() {
  const modal       = document.getElementById('pt-profile-modal');
  if (!modal) return;
  const profile     = loadProfile();
  const nameInput   = document.getElementById('pt-profile-name');
  const guildInput  = document.getElementById('pt-profile-guild-input');
  const guildIdRow  = document.getElementById('pt-profile-guild-id-row');
  const guildSec    = document.getElementById('pt-profile-guild-section');
  const nameHint    = document.getElementById('pt-modal-name-hint');

  modalSelectedGuild  = null;
  modalSelectedPlayer = null;

  // Always unlock the name field when opening
  nameInput.readOnly = false;
  nameInput.classList.remove('pt-modal-input--locked');
  nameInput.value  = profile?.inGameName ?? '';
  nameHint.hidden  = true;

  if (guildInput) guildInput.value = '';
  if (guildIdRow) guildIdRow.hidden = true;

  // If the saved name exists in DB, check guild membership
  if (profile?.inGameName) {
    const match = allPlayers.find(p => p.name.toLowerCase() === profile.inGameName.toLowerCase());
    if (match) {
      modalSelectedPlayer = match;
      nameInput.readOnly  = true;
      nameInput.classList.add('pt-modal-input--locked');
      // Check if this player is already in a guild
      const existingGuild = findGuildByMember(match.name);
      if (existingGuild) {
        modalSelectedGuild = existingGuild;
        if (guildInput) guildInput.value = existingGuild.name;
        if (guildSec) guildSec.hidden = true;
      } else if (profile?.guildId) {
        // Profile has a guildId but player not in members list — still show pre-filled
        const g = getGuildById(profile.guildId);
        if (g) { if (guildInput) guildInput.value = g.name; modalSelectedGuild = g; }
        if (guildSec) guildSec.hidden = false;
      } else {
        if (guildSec) guildSec.hidden = false;
      }
    } else {
      if (guildSec) guildSec.hidden = true;
    }
  } else {
    if (guildSec) guildSec.hidden = true;
  }

  modal.removeAttribute('hidden');
  nameInput.focus();
}

function hideProfileModal() {
  const modal = document.getElementById('pt-profile-modal');
  if (modal) modal.setAttribute('hidden', '');
}

function initProfileModal() {
  const modal       = document.getElementById('pt-profile-modal');
  const nameInput   = document.getElementById('pt-profile-name');
  const nameDropdown= document.getElementById('pt-name-dropdown');
  const guildInput  = document.getElementById('pt-profile-guild-input');
  const guildIdRow  = document.getElementById('pt-profile-guild-id-row');
  const guildDropdown = document.getElementById('pt-guild-dropdown');
  const guildSec    = document.getElementById('pt-profile-guild-section');
  const nameHint    = document.getElementById('pt-modal-name-hint');
  const saveBtn     = document.getElementById('pt-profile-save');
  if (!modal) return;

  // ── Name search against allPlayers ──
  nameInput.addEventListener('input', () => {
    const q = nameInput.value.trim().toLowerCase();
    nameInput.classList.remove('pt-modal-input--error');

    if (!q) {
      nameDropdown.hidden      = true;
      nameHint.hidden          = true;
      if (guildSec) guildSec.hidden = true;
      modalSelectedPlayer      = null;
      return;
    }

    const matches = allPlayers.filter(p => p.name.toLowerCase().includes(q));

    if (matches.length === 0) {
      nameDropdown.hidden = true;
      nameHint.hidden     = false;
      if (guildSec) guildSec.hidden = true;
      modalSelectedPlayer = null;
      return;
    }

    nameHint.hidden     = true;
    nameDropdown.hidden = false;
    nameDropdown.innerHTML = matches.slice(0, 12).map(p =>
      `<div class="pt-dropdown-item" data-name="${escHtml(p.name)}">
        <span>${escHtml(p.name)}</span>
        <span class="pt-dropdown-meta">Lv ${p.level}${p.seasonLevel > 0 ? `(+${p.seasonLevel})` : ''} · ${p.abilityScore.toLocaleString()} AS</span>
      </div>`
    ).join('');

    nameDropdown.querySelectorAll('.pt-dropdown-item').forEach(el => {
      el.addEventListener('click', () => {
        const selected = allPlayers.find(p => p.name === el.dataset.name);
        if (!selected) return;
        modalSelectedPlayer      = selected;
        nameInput.value          = selected.name;
        nameInput.readOnly       = true;
        nameInput.classList.add('pt-modal-input--locked');
        nameDropdown.hidden      = true;
        nameHint.hidden          = true;
        // If this player is already in a guild, auto-select it and hide the guild section
        const existingGuild = findGuildByMember(selected.name);
        if (existingGuild) {
          modalSelectedGuild = existingGuild;
          if (guildInput) guildInput.value = existingGuild.name;
          if (guildSec) guildSec.hidden = true;
        } else {
          modalSelectedGuild = null;
          if (guildInput) guildInput.value = '';
          if (guildSec) guildSec.hidden = false;
        }
      });
    });
  });

  // ── Guild name autocomplete ──
  if (guildInput) {
    guildInput.addEventListener('input', () => {
      const q      = guildInput.value.trim().toLowerCase();
      const guilds = loadGuilds();
      const matches    = q ? guilds.filter(g => g.name.toLowerCase().includes(q)) : guilds;
      const exactMatch = guilds.find(g => g.name.toLowerCase() === q);

      modalSelectedGuild = exactMatch ?? null;
      if (guildIdRow) guildIdRow.hidden = !!exactMatch || !q;

      if (matches.length === 0) { if (guildDropdown) guildDropdown.hidden = true; return; }

      if (guildDropdown) {
        guildDropdown.hidden = false;
        guildDropdown.innerHTML = matches.map(g =>
          `<div class="pt-dropdown-item" data-id="${escHtml(g.id)}">
            ${escHtml(g.name)}
            <span class="pt-dropdown-meta">${g.members.length} member${g.members.length !== 1 ? 's' : ''}</span>
          </div>`
        ).join('');
        guildDropdown.querySelectorAll('.pt-dropdown-item').forEach(el => {
          el.addEventListener('click', () => {
            const g = loadGuilds().find(x => x.id === el.dataset.id);
            if (!g) return;
            modalSelectedGuild     = g;
            guildInput.value       = g.name;
            guildDropdown.hidden   = true;
            if (guildIdRow) guildIdRow.hidden = true;
          });
        });
      }
    });
  }

  // Close dropdowns when clicking outside
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.pt-autocomplete-wrapper')) {
      if (nameDropdown)  nameDropdown.hidden  = true;
      if (guildDropdown) guildDropdown.hidden = true;
    }
  });

  // Close modal on backdrop click
  modal.addEventListener('click', (e) => {
    if (e.target === modal) hideProfileModal();
  });

  // ── Save ──
  saveBtn.addEventListener('click', () => {
    const guildIdInput = document.getElementById('pt-profile-guild-id');
    const name = nameInput.value.trim();
    if (!name || !modalSelectedPlayer) {
      nameInput.focus();
      nameInput.classList.add('pt-modal-input--error');
      nameHint.hidden = false;
      return;
    }
    nameInput.classList.remove('pt-modal-input--error');

    const guildText = guildInput ? guildInput.value.trim() : '';
    let guildId = modalSelectedGuild?.id ?? null;

    // Only create/join a guild if the player has DB data and typed a guild name
    if (guildText && !modalSelectedGuild && modalSelectedPlayer) {
      const rawId   = guildIdInput ? guildIdInput.value.trim() : '';
      const idToUse = rawId || `guild-${Date.now().toString(36)}`;
      const guilds  = loadGuilds();
      const finalId = guilds.some(g => g.id === idToUse)
        ? `${idToUse}-${Math.random().toString(36).slice(2, 5)}`
        : idToUse;
      guildId = createGuild(guildText, finalId).id;
    }

    saveProfile({ inGameName: name, guildId });
    if (guildId) {
      // Only call joinGuild if the player isn't already a member of that guild
      const targetGuild = loadGuilds().find(g => g.id === guildId);
      const alreadyMember = targetGuild?.members?.some(
        m => m.toLowerCase() === name.toLowerCase()
      ) ?? false;
      if (!alreadyMember) joinGuild(guildId);
    }
    hideProfileModal();
    renderProfileBar();
    if (viewSelect.value === 'guild') renderGuildPanel();
    render(allPlayers);
  });
}
