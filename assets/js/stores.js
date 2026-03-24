/* ------------------------------
   Daily & Weekly Stores Tracker
   ------------------------------ */

const DAILY_TASKS  = ["Mystery Store"];
const WEEKLY_TASKS = ["Season Pass", "Orb", "Friendship", "Honor Coin", "Reputation", "Guild", "Gear Exchange"];

const DAILY_KEY      = "stores-daily-v1";
const DAILY_META_KEY = "stores-daily-meta";
const WEEKLY_KEY      = "stores-weekly-v1";
const WEEKLY_META_KEY = "stores-weekly-meta";
const RESET_HOUR = 6; // 6:00 AM local time

document.getElementById('dateSub').textContent =
  new Date().toLocaleDateString(undefined, { weekday: "long", year: "numeric", month: "short", day: "numeric" });

/* --- Storage --- */
let dailySaved  = JSON.parse(localStorage.getItem(DAILY_KEY)  || "{}");
let dailyMeta   = JSON.parse(localStorage.getItem(DAILY_META_KEY)  || "{}");
let weeklySaved = JSON.parse(localStorage.getItem(WEEKLY_KEY) || "{}");
let weeklyMeta  = JSON.parse(localStorage.getItem(WEEKLY_META_KEY) || "{}");

/* ── Daily reset helpers ── */
function getDailyReset() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), RESET_HOUR, 0, 0, 0);
}

function shouldResetDaily() {
  const now = new Date();
  const resetTime = getDailyReset();
  const last = dailyMeta.lastReset ? new Date(dailyMeta.lastReset) : null;
  return !last || (now >= resetTime && last < resetTime);
}

function performDailyReset() {
  Object.keys(dailySaved).forEach(k => (dailySaved[k] = false));
  localStorage.setItem(DAILY_KEY, JSON.stringify(dailySaved));
  dailyMeta.lastReset = new Date().toISOString();
  localStorage.setItem(DAILY_META_KEY, JSON.stringify(dailyMeta));
}

/* ── Weekly reset helpers ── */
function getWeeklyReset() {
  const now = new Date();
  const day = now.getDay();
  const daysToMonday = day === 0 ? -6 : 1 - day;
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + daysToMonday, RESET_HOUR, 0, 0, 0);
}

function shouldResetWeekly() {
  const now = new Date();
  const resetTime = getWeeklyReset();
  const last = weeklyMeta.lastReset ? new Date(weeklyMeta.lastReset) : null;
  return !last || (now >= resetTime && last < resetTime);
}

function performWeeklyReset() {
  Object.keys(weeklySaved).forEach(k => (weeklySaved[k] = false));
  localStorage.setItem(WEEKLY_KEY, JSON.stringify(weeklySaved));
  weeklyMeta.lastReset = new Date().toISOString();
  localStorage.setItem(WEEKLY_META_KEY, JSON.stringify(weeklyMeta));
}

/* ── Auto-reset on load ── */
if (shouldResetDaily())  performDailyReset();
if (shouldResetWeekly()) performWeeklyReset();

/* ── Schedule live resets ── */
function scheduleDaily() {
  const now = new Date();
  let next = getDailyReset();
  if (now >= next) next = new Date(next.getTime() + 24 * 60 * 60 * 1000);
  setTimeout(() => {
    performDailyReset();
    refreshSection('daily');
    updateProgress();
    scheduleDaily();
  }, next.getTime() - now.getTime());
}

function scheduleWeekly() {
  const now = new Date();
  let next = getWeeklyReset();
  if (now >= next) next = new Date(next.getTime() + 7 * 24 * 60 * 60 * 1000);
  setTimeout(() => {
    performWeeklyReset();
    refreshSection('weekly');
    updateProgress();
    scheduleWeekly();
  }, next.getTime() - now.getTime());
}

scheduleDaily();
scheduleWeekly();

/* ── Build a checklist item ── */
function createItem(text, id, checked, storage, storageKey) {
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

  box.addEventListener("change", () => {
    storage[id] = box.checked;
    localStorage.setItem(storageKey, JSON.stringify(storage));
    row.classList.toggle("done", box.checked);
    updateProgress();
  });

  return row;
}

/* ── Render sections ── */
function buildSection(tasks, listEl, prefix, storage, storageKey) {
  listEl.innerHTML = "";
  tasks.forEach((text, idx) => {
    const id = `${prefix}-${idx}`;
    const checked = !!storage[id];
    listEl.appendChild(createItem(text, id, checked, storage, storageKey));
  });
}

function refreshSection(type) {
  if (type === 'daily') {
    dailySaved = JSON.parse(localStorage.getItem(DAILY_KEY) || "{}");
    buildSection(DAILY_TASKS, document.getElementById("dailyList"), "daily", dailySaved, DAILY_KEY);
  } else {
    weeklySaved = JSON.parse(localStorage.getItem(WEEKLY_KEY) || "{}");
    buildSection(WEEKLY_TASKS, document.getElementById("weeklyList"), "weekly", weeklySaved, WEEKLY_KEY);
  }
}

buildSection(DAILY_TASKS,  document.getElementById("dailyList"),  "daily",  dailySaved,  DAILY_KEY);
buildSection(WEEKLY_TASKS, document.getElementById("weeklyList"), "weekly", weeklySaved, WEEKLY_KEY);

/* ── Manual reset ── */
document.getElementById("resetBtn").addEventListener("click", () => {
  performDailyReset();
  performWeeklyReset();
  refreshSection('daily');
  refreshSection('weekly');
  updateProgress();
});

/* ── Progress indicator ── */
function updateProgress() {
  const boxes = [...document.querySelectorAll('input[type="checkbox"]')];
  const done  = boxes.filter(b => b.checked).length;
  const total = boxes.length;
  const pct   = total ? Math.round((done / total) * 100) : 0;

  const circumference = 2 * Math.PI * 34;
  const offset = circumference * (1 - pct / 100);
  document.getElementById("ring").style.strokeDashoffset = offset.toFixed(2);
  document.getElementById("progressLabel").textContent = `${pct}%`;
  document.getElementById("summary").textContent = `${done} / ${total} completed`;
}

updateProgress();
