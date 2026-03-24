/* ----------------------------------------
   Boss Tracker
   Live boss respawn data from bptimer.com
   ---------------------------------------- */
(function () {
  'use strict';

  const PB_BASE = 'https://db.bptimer.com';
  const MAX_CHANNELS = 15;
  const POLL_INTERVAL = 30_000; // 30 seconds

  /* ── Stale-data thresholds (mirrors bptimer source) ── */
  const STALE_FULL_HP  = 5 * 60 * 1000; // 5 min  — 100 % HP
  const STALE_HIGH_HP  = 3 * 60 * 1000; // 3 min  — 80-99 % HP
  const STALE_DEFAULT  = 2 * 60 * 1000; // 2 min  — < 80 % HP

  /* ── Boss definitions ── */
  const BOSSES = [
    {
      id: 'hb0daopkzoodbv4',
      name: 'Basilisk',
      respawnMin: 0,   // respawns at every HH:00 UTC
      image: 'https://bptimer.com/images/bosses/basilisk.webp',
    },
    {
      id: '55k7g96sfq3ey49',
      name: 'Goblin Chief',
      respawnMin: 30,  // respawns at every HH:30 UTC
      image: 'https://bptimer.com/images/bosses/goblin_chief.webp',
    },
  ];

  /* ── State ── */
  let region = 'SEA';
  let channelData = {}; // { [bossId]: rawRecord[] }

  /* ── Helpers ── */
  function getNextRespawn(respawnMin) {
    const now = new Date();
    const next = new Date(now);
    if (now.getUTCMinutes() < respawnMin) {
      next.setUTCMinutes(respawnMin, 0, 0);
    } else {
      next.setUTCHours(now.getUTCHours() + 1, respawnMin, 0, 0);
    }
    return next;
  }

  function formatCountdown(ms) {
    if (ms <= 0) return 'Respawning…';
    const totalSec = Math.floor(ms / 1000);
    const h   = Math.floor(totalSec / 3600);
    const m   = Math.floor((totalSec % 3600) / 60);
    const sec = totalSec % 60;
    if (h > 0) return `${h}h ${m}m ${sec}s`;
    return `${m}m ${sec}s`;
  }

  function getChannelStatus(hp, lastUpdate) {
    if (hp === 0) return 'dead'; // dead channels are never stale for regular bosses
    if (!lastUpdate) return 'unknown';
    const age = Date.now() - new Date(lastUpdate).getTime();
    let timeout;
    if (hp === 100)     timeout = STALE_FULL_HP;
    else if (hp >= 80)  timeout = STALE_HIGH_HP;
    else                timeout = STALE_DEFAULT;
    return age > timeout ? 'unknown' : 'alive';
  }

  /* ── Data fetching ── */
  async function fetchChannelData() {
    const orCond = BOSSES.map(b => `mob='${b.id}'`).join('||');
    const filter = `(${orCond})&&region='${region}'`;
    const url =
      `${PB_BASE}/api/collections/mob_channel_status/records` +
      `?filter=${encodeURIComponent(filter)}&perPage=500&skipTotal=true`;

    try {
      const res = await fetch(url);
      if (!res.ok) return;
      const data = await res.json();

      const grouped = {};
      for (const b of BOSSES) grouped[b.id] = [];
      for (const record of data.items) {
        if (record.mob in grouped) grouped[record.mob].push(record);
      }
      channelData = grouped;
      renderAllChannels();
    } catch (_) {
      // Network error – keep showing previous data
    }
  }

  /* ── Rendering ── */
  function renderAllChannels() {
    for (const boss of BOSSES) {
      const container = document.getElementById(`btch-${boss.id}`);
      if (!container) continue;
      container.innerHTML = '';

      const processed = (channelData[boss.id] || []).map(r => ({
        ch:      r.channel_number,
        hp:      r.last_hp,
        updated: r.last_update,
        status:  getChannelStatus(r.last_hp, r.last_update),
      })).filter(c => c.status !== 'unknown');

      /* Sort: alive first (by HP asc), then dead (most recent first) */
      processed.sort((a, b) => {
        if (a.status === 'alive' && b.status !== 'alive') return -1;
        if (b.status === 'alive' && a.status !== 'alive') return 1;
        if (a.status === 'dead' && b.status === 'dead') {
          return new Date(b.updated).getTime() - new Date(a.updated).getTime();
        }
        return a.ch - b.ch;
      });

      for (let i = 0; i < MAX_CHANNELS; i++) {
        const span = document.createElement('span');
        const item = processed[i];

        if (item) {
          span.className = `bt-pill bt-pill--${item.status}`;
          span.title = item.status === 'dead'
            ? `Ch ${item.ch} — Boss killed`
            : `Ch ${item.ch} — ${item.hp}% HP`;

          // HP fill bar
          const fill = document.createElement('span');
          fill.className = 'bt-pill-fill ' + (
            item.status === 'dead'   ? 'bt-pill-fill--dead' :
            item.hp <= 30            ? 'bt-pill-fill--low'  :
                                       'bt-pill-fill--healthy'
          );
          // dead fill handled by CSS (100% width); alive = actual HP width
          if (item.status !== 'dead') fill.style.width = `${item.hp}%`;

          const label = document.createElement('span');
          label.className = 'bt-pill-label';
          label.textContent = item.ch;

          span.appendChild(fill);
          span.appendChild(label);
        } else {
          span.className = 'bt-pill bt-pill--empty';
          const label = document.createElement('span');
          label.className = 'bt-pill-label';
          label.textContent = '0';
          span.appendChild(label);
        }
        container.appendChild(span);
      }
    }
  }

  /* ── Timer ticks (every second) ── */
  function tickTimers() {
    const now = Date.now();
    for (const boss of BOSSES) {
      const msLeft  = getNextRespawn(boss.respawnMin).getTime() - now;
      const timerEl = document.getElementById(`bttimer-${boss.id}`);
      const progEl  = document.getElementById(`btprog-${boss.id}`);
      if (timerEl) timerEl.textContent = formatCountdown(msLeft);
      if (progEl) {
        const pct = Math.max(0, Math.min(100, (msLeft / (60 * 60_000)) * 100));
        progEl.style.width = `${pct}%`;
      }
    }
  }

  /* ── Build DOM ── */
  function buildUI() {
    const section = document.getElementById('boss-tracker');
    if (!section) return;

    /* Header */
    const header = document.createElement('div');
    header.className = 'bt-header';
    header.innerHTML = `<h2 class="bt-title">🐉 Boss Tracker — SEA</h2>`;
    section.appendChild(header);

    /* Cards */
    const cardsRow = document.createElement('div');
    cardsRow.className = 'bt-cards';
    section.appendChild(cardsRow);

    for (const boss of BOSSES) {
      const card = document.createElement('div');
      card.className = 'bt-card';
      card.innerHTML = `
        <div class="bt-card-top">
          <span class="bt-boss-name">${boss.name}</span>
          <img class="bt-boss-img" src="${boss.image}" alt="${boss.name}"
               loading="lazy" onerror="this.style.display='none'">
        </div>
        <div class="bt-respawn-row">
          <span class="bt-respawn-label">Time Until Respawn</span>
          <span class="bt-respawn-val" id="bttimer-${boss.id}">—</span>
        </div>
        <div class="bt-prog-wrap">
          <div class="bt-prog-bar" id="btprog-${boss.id}" style="width:0%"></div>
        </div>
        <div class="bt-channels" id="btch-${boss.id}"></div>
        <div class="bt-footer">
          <a class="bt-details-btn"
             href="https://bptimer.com/"
             target="_blank"
             rel="noopener noreferrer">View Details ↗</a>
        </div>
      `;
      cardsRow.appendChild(card);
    }

    /* Credits note */
    const credits = document.createElement('p');
    credits.className = 'bt-credits';
    credits.innerHTML = 'Live data powered by <a href="https://bptimer.com/" target="_blank" rel="noopener noreferrer">bptimer.com</a>';
    section.appendChild(credits);
  }

  /* ── Init ── */
  buildUI();
  renderAllChannels(); // show empty slots immediately
  tickTimers();
  fetchChannelData();

  setInterval(tickTimers, 1000);
  setInterval(fetchChannelData, POLL_INTERVAL);
})();
