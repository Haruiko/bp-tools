/* ------------------------------
   Weekly Missions Tracker
   Resets every Monday at 6:00 AM local time
   ------------------------------ */

const TASKS = [
  "Life Skill Quests",
  "World Boss Crusade (1,200 Activity Points)",
  "Friendship Point Support",
  "Guild Dance",
  "Guild Activity Rewards",
  "Chaotic Realm Reforge Stones",
  "Bane Lord",
  "Pioneer Rewards",
  "Dragon Shackles Raid",
  "Stimen Vaults (Bi-Weekly)"
];

const KEY = "weekly-missions-v1";
const META_KEY = "weekly-missions-meta";
const RESET_HOUR = 6; // 6:00 AM local time

const today = new Date();
document.getElementById('dateSub').textContent =
  today.toLocaleDateString(undefined, { weekday: "long", year: "numeric", month: "short", day: "numeric" });

/* --- Load stored data --- */
let saved = JSON.parse(localStorage.getItem(KEY) || "{}");
let meta  = JSON.parse(localStorage.getItem(META_KEY) || "{}");

/* --- Get this week's Monday at 6 AM local time --- */
function getWeeklyReset() {
  const now = new Date();
  const day = now.getDay(); // 0=Sun, 1=Mon ... 6=Sat
  const daysToMonday = (day === 0) ? -6 : 1 - day; // how many days back to Monday
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() + daysToMonday, RESET_HOUR, 0, 0, 0);
  return monday;
}

/* --- Determine if we should reset --- */
function shouldReset() {
  const now = new Date();
  const weeklyReset = getWeeklyReset();
  const lastReset = meta.lastReset ? new Date(meta.lastReset) : null;

  // Reset if: no record, OR it's past this Monday's 6 AM and last reset was before it
  return !lastReset || (now >= weeklyReset && lastReset < weeklyReset);
}

/* --- Perform the reset --- */
function performReset() {
  Object.keys(saved).forEach(k => (saved[k] = false));
  localStorage.setItem(KEY, JSON.stringify(saved));
  meta.lastReset = new Date().toISOString();
  localStorage.setItem(META_KEY, JSON.stringify(meta));
}

/* --- Auto-reset on load if needed --- */
if (shouldReset()) {
  performReset();
}

/* --- Schedule live reset for the next Monday 6 AM --- */
function scheduleNextReset() {
  const now = new Date();
  let nextReset = getWeeklyReset();
  if (now >= nextReset) {
    // This week's reset already passed — schedule for next Monday
    nextReset = new Date(nextReset.getTime() + 7 * 24 * 60 * 60 * 1000);
  }
  const msUntilReset = nextReset.getTime() - now.getTime();
  setTimeout(() => {
    performReset();
    document.querySelectorAll('input[type="checkbox"]').forEach(cb => { cb.checked = false; });
    document.querySelectorAll('.item').forEach(el => el.classList.remove('done'));
    updateProgress();
    scheduleNextReset();
  }, msUntilReset);
}
scheduleNextReset();

/* --- Build checklist UI --- */
const list = document.getElementById("missionList");

TASKS.forEach((text, idx) => {
  const id = `task-${idx}`;
  const checked = !!saved[id];

  const row = document.createElement("label");
  row.className = `item${checked ? " done" : ""}`;
  row.setAttribute("for", id);

  const box = document.createElement("input");
  box.type = "checkbox";
  box.id = id;
  box.checked = checked;
  box.setAttribute("aria-label", text);

  const span = document.createElement("span");
  span.className = "label";
  span.textContent = text;

  row.appendChild(box);
  row.appendChild(span);

  // Add 'Learn more' link for Life Skill Quests
  if (idx === 0) {
    const link = document.createElement("a");
    link.href = "weekly-lifestyle.html";
    link.className = "learn-more";
    link.textContent = "Learn more";
    link.addEventListener("click", e => e.stopPropagation());
    row.appendChild(link);
  }

  list.appendChild(row);

  box.addEventListener("change", () => {
    saved[id] = box.checked;
    localStorage.setItem(KEY, JSON.stringify(saved));
    row.classList.toggle("done", box.checked);
    updateProgress();
  });
});

/* --- Manual reset button --- */
document.getElementById("resetBtn").addEventListener("click", () => {
  document.querySelectorAll('input[type="checkbox"]').forEach(cb => (cb.checked = false));
  Object.keys(saved).forEach(k => (saved[k] = false));
  localStorage.setItem(KEY, JSON.stringify(saved));
  document.querySelectorAll('.item').forEach(el => el.classList.remove('done'));
  meta.lastReset = new Date().toISOString();
  localStorage.setItem(META_KEY, JSON.stringify(meta));
  updateProgress();
});

/* --- Progress indicator --- */
function updateProgress() {
  const boxes = [...document.querySelectorAll('input[type="checkbox"]')];
  const done  = boxes.filter(b => b.checked).length;
  const total = boxes.length;
  const pct   = total ? Math.round((done / total) * 100) : 0;

  const circumference = 2 * Math.PI * 34; // radius=34
  const offset = circumference * (1 - pct / 100);
  document.getElementById("ring").style.strokeDashoffset = offset.toFixed(2);
  document.getElementById("progressLabel").textContent = `${pct}%`;
  document.getElementById("summary").textContent = `${done} / ${total} completed`;
}

updateProgress();
