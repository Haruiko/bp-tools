/* ----------------------------------------
   Event Timers
   ---------------------------------------- */

const TIMERS = [
  { id: 'daily',      name: 'Daily Reset',  icon: '☀',  label: 'until reset', getNext: getNextDailyReset  },
  { id: 'weekly',     name: 'Weekly Reset', icon: '⏳', label: 'until reset', getNext: getNextWeeklyReset },
  { id: 'guild-hunt', name: 'Guild Hunt',   icon: '⚔',  label: 'until start', getNext: getNextGuildHunt   },
  { id: 'guild-dance',name: 'Guild Dance',  icon: '🎵', label: 'until start', getNext: getNextGuildDance  },
  { id: 'stimen',     name: 'Stimen Vault', icon: '💎', label: 'left',        getNext: getNextStimenVault },
];

/* ── Daily reset: 6:00 AM every day ── */
function getNextDailyReset() {
  const now = new Date();
  let t = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 6, 0, 0, 0);
  if (now >= t) t = new Date(t.getTime() + 24 * 60 * 60 * 1000);
  return t;
}

/* ── Weekly reset: Monday 6:00 AM ── */
function getNextWeeklyReset() {
  const now = new Date();
  const day = now.getDay(); // 0=Sun … 6=Sat
  const daysToMonday = day === 0 ? -6 : 1 - day; // rewind to this Monday
  let monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() + daysToMonday, 6, 0, 0, 0);
  if (now >= monday) monday = new Date(monday.getTime() + 7 * 24 * 60 * 60 * 1000);
  return monday;
}

/* ── Guild Hunt: 11:00 AM every Friday, Saturday, Sunday ── */
function getNextGuildHunt() {
  const now = new Date();
  const huntDays = new Set([5, 6, 0]); // Fri, Sat, Sun
  for (let i = 0; i <= 7; i++) {
    const t = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i, 11, 0, 0, 0);
    if (huntDays.has(t.getDay()) && t > now) return t;
  }
}

/* ── Guild Dance: 8:00 PM Friday only ── */
function getNextGuildDance() {
  const now = new Date();
  for (let i = 0; i <= 7; i++) {
    const t = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i, 20, 0, 0, 0);
    if (t.getDay() === 5 && t > now) return t;
  }
}

/* ── Stimen Vault: bi-weekly, anchored to Monday March 30 2026 6:00 AM ── */
function getNextStimenVault() {
  const anchor = new Date(2026, 2, 30, 6, 0, 0, 0); // March = month 2 (0-indexed)
  const now = new Date();
  if (now < anchor) return anchor;
  const cycleMs = 14 * 24 * 60 * 60 * 1000;
  const cyclesPassed = Math.floor((now.getTime() - anchor.getTime()) / cycleMs);
  return new Date(anchor.getTime() + (cyclesPassed + 1) * cycleMs);
}

/* ── Format ms into "Xd Xh Xm Xs" ── */
function formatCountdown(ms) {
  if (ms <= 0) return 'now';
  const totalSeconds = Math.floor(ms / 1000);
  const days    = Math.floor(totalSeconds / 86400);
  const hours   = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts = [];
  if (days > 0)  parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  parts.push(`${minutes}m`);
  if (days === 0) parts.push(`${seconds}s`);
  return parts.join(' ');
}

/* ── Build cards ── */
const container = document.getElementById('timers');

TIMERS.forEach(t => {
  const card = document.createElement('div');
  card.className = 'timer-card';
  card.innerHTML = `
    <span class="timer-icon">${t.icon}</span>
    <div class="timer-body">
      <div class="timer-name">${t.name}</div>
      <div class="timer-value" id="tv-${t.id}">…</div>
    </div>`;
  container.appendChild(card);
});

/* ── Tick ── */
function tick() {
  const now = new Date();
  TIMERS.forEach(t => {
    const next = t.getNext();
    const el = document.getElementById(`tv-${t.id}`);
    if (el && next) el.textContent = `${formatCountdown(next - now)} ${t.label}`;
  });
}

tick();
setInterval(tick, 1000); // refresh every second
