/* ------------------------------
   Daily Missions with Auto-Reset
   ------------------------------ */

const TASKS = [
  "Unstable Space 2x",
  "Elite Hunt Chest 2x",
  "World Hunt Chest 2x",
  "Season Pass Activity Merits",
  "Bureau Commissions",
  "Life Skill Focus",
  "Leisure Activities",
  "Homestead Commissions",
  "World Boss Crusade",
  "Guild Check-In",
  "Guild Cargo",
  "Guild Hunt ( Every Fri, Sat, Sun )",
];

const KEY = "daily-missions-v1";   // store check states
const META_KEY = "daily-missions-meta"; // store last reset time
const RESET_HOUR = 6; // 6:00 AM local time

const today = new Date();
document.getElementById('dateSub').textContent =
  today.toLocaleDateString(undefined, { weekday:"long", year:"numeric", month:"short", day:"numeric" });

/* --- Load stored data --- */
let saved = JSON.parse(localStorage.getItem(KEY) || "{}");
let meta = JSON.parse(localStorage.getItem(META_KEY) || "{}");

/* --- Get today's 6 AM reset time in local timezone --- */
function getTodayReset() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), RESET_HOUR, 0, 0, 0);
}

/* --- Determine if we should reset --- */
function shouldReset() {
  const now = new Date();
  const todayReset = getTodayReset();
  const lastReset = meta.lastReset ? new Date(meta.lastReset) : null;

  // Reset if: no record, OR it's past 6 AM today and the last reset was before 6 AM today
  return !lastReset || (now >= todayReset && lastReset < todayReset);
}

/* --- Perform the reset --- */
function performReset() {
  Object.keys(saved).forEach(k => saved[k] = false);
  localStorage.setItem(KEY, JSON.stringify(saved));
  meta.lastReset = new Date().toISOString();
  localStorage.setItem(META_KEY, JSON.stringify(meta));
}

/* --- Auto-reset if needed --- */
if (shouldReset()) {
  performReset();
}

/* --- Schedule live reset when 6 AM hits while page is open --- */
function scheduleNextReset() {
  const now = new Date();
  let nextReset = getTodayReset();
  if (now >= nextReset) {
    // 6 AM already passed today — schedule for tomorrow
    nextReset = new Date(nextReset.getTime() + 24 * 60 * 60 * 1000);
  }
  const msUntilReset = nextReset.getTime() - now.getTime();
  setTimeout(() => {
    performReset();
    // Uncheck all boxes and update UI
    document.querySelectorAll('input[type="checkbox"]').forEach(cb => { cb.checked = false; });
    document.querySelectorAll('.item').forEach(el => el.classList.remove('done'));
    updateProgress();
    scheduleNextReset(); // schedule the next day's reset
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
  list.appendChild(row);

  // Save when toggled
  box.addEventListener("change", () => {
    saved[id] = box.checked;
    localStorage.setItem(KEY, JSON.stringify(saved));
    row.classList.toggle("done", box.checked);
    updateProgress();
  });
});

/* --- Manual reset button --- */
document.getElementById("resetBtn").addEventListener("click", () => {
  document.querySelectorAll('input[type="checkbox"]').forEach(cb => cb.checked = false);
  Object.keys(saved).forEach(k => saved[k] = false);
  localStorage.setItem(KEY, JSON.stringify(saved));
  document.querySelectorAll('.item').forEach(el => el.classList.remove('done'));
  meta.lastReset = new Date().toISOString();
  localStorage.setItem(META_KEY, JSON.stringify(meta));
  updateProgress();
});

/* --- Progress indicator --- */
function updateProgress(){
  const boxes = [...document.querySelectorAll('input[type="checkbox"]')];
  const done = boxes.filter(b => b.checked).length;
  const total = boxes.length;
  const pct = Math.round((done / total) * 100);

  const circumference = 2 * Math.PI * 34; // radius=34
  const offset = circumference * (1 - pct/100);
  document.getElementById("ring").style.strokeDashoffset = offset.toFixed(2);
  document.getElementById("progressLabel").textContent = `${pct}%`;
  document.getElementById("summary").textContent = `${done} / ${total} completed`;
}

updateProgress();