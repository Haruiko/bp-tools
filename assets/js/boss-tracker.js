/* ----------------------------------------
   Boss Tracker
   Live boss respawn data from bptimer.com
   ---------------------------------------- */
(function () {
  'use strict';

  const PB_BASE = 'https://db.bptimer.com';
  const MAX_CHANNELS = 15;
  const POLL_INTERVAL = 30_000; // 30 seconds
  const WEBHOOK_KEY      = 'bt_discord_webhook';
  const ALERT_KEY_PREFIX  = 'bt_auto_alert_'; // + bossId

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
    {
      id: '3bw8w75ct4w1tjb',
      name: 'Cabbage Kingpin',
      respawnMin: 0,   // respawns at every HH:00 UTC
      image: 'https://bptimer.com/images/bosses/cabbage_kingpin.webp',
    },
    {
      id: 'x9ls682xem020cr',
      name: 'Blackstone Captain',
      respawnMin: 30,  // respawns at every HH:30 UTC
      image: 'https://bptimer.com/images/bosses/blackstone_captain.webp',
    },
    {
      id: 'c60g15hv8tpojd2',
      name: 'Crimson Foxen',
      respawnMin: 0,   // respawns at every HH:00 UTC
      image: 'https://bptimer.com/images/bosses/crimson_foxen.webp',
    },
    {
      id: 'p1dmp4dkgy9ts2',
      name: 'Flamehorn',
      respawnMin: 30,  // respawns at every HH:30 UTC
      image: 'https://bptimer.com/images/bosses/flamehorn.webp',
    },
  ];

  /* ── State ── */
  let region = 'SEA';
  let channelData = {}; // { [bossId]: rawRecord[] }
  let prevHpMap   = {}; // { ["bossId-channel"]: lastKnownHp } — for auto-alert threshold tracking
  let pendingAlertMsgIds = {}; // { ["bossId-channel"]: discordMessageId } — 30% HP messages pending paired deletion

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

  /* ── Discord webhook ── */
  function getWebhookUrl() {
    return localStorage.getItem(WEBHOOK_KEY) || '';
  }

  function isAutoAlertEnabled(bossId) {
    // Default ON if not explicitly set to 'off'
    return localStorage.getItem(ALERT_KEY_PREFIX + bossId) !== 'off';
  }

  function setAutoAlert(bossId, enabled) {
    localStorage.setItem(ALERT_KEY_PREFIX + bossId, enabled ? 'on' : 'off');
  }

  function configureWebhook() {
    const current = getWebhookUrl();
    const url = prompt('Paste your Discord Webhook URL below (leave blank to clear):', current);
    if (url === null) return; // user cancelled
    const trimmed = url.trim();
    if (trimmed) {
      localStorage.setItem(WEBHOOK_KEY, trimmed);
      alert('✅ Discord webhook saved!');
    } else {
      localStorage.removeItem(WEBHOOK_KEY);
      alert('Discord webhook cleared.');
    }
  }

  const DELETE_AFTER_MS = 10_000; // delete the Discord message after 10 seconds

  async function sendDiscordMessage(bossName, channel, hp, { promptIfMissing = true, autoDelete = true } = {}) {
    let webhookUrl = getWebhookUrl().replace(/\/+$/, ''); // strip any trailing slashes
    if (!webhookUrl) {
      if (!promptIfMissing) return; // auto-alerts skip silently when no webhook set
      const url = prompt('No Discord webhook set.\nPaste your Webhook URL to continue:');
      if (!url || !url.trim()) return;
      webhookUrl = url.trim();
      localStorage.setItem(WEBHOOK_KEY, webhookUrl);
    }
    const healthText = hp === 0 ? 'Killed' : `${hp}%`;
    const content = `Line: ${channel}\nBoss: ${bossName}\nHealth: ${healthText}`;
    try {
      // ?wait=true makes Discord return the created message object (with its ID)
      const res = await fetch(`${webhookUrl}?wait=true`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      });
      if (!res.ok) {
        alert(`❌ Discord returned an error (${res.status}).\nClick "🔔 Discord" to update your webhook URL.`);
        return;
      }
      const msg = await res.json();
      console.log(`[BossTracker] Sent msg id=${msg.id} | ${bossName} ch${channel} hp=${hp} autoDelete=${autoDelete}`);
      if (autoDelete) {
        // Schedule deletion after DELETE_AFTER_MS milliseconds
        setTimeout(async () => {
          console.log(`[BossTracker] Deleting msg id=${msg.id}`);
          try {
            const dr = await fetch(`${webhookUrl}/messages/${msg.id}`, { method: 'DELETE' });
            console.log(`[BossTracker] Delete result: ${dr.status}`);
          } catch (err) {
            console.error('[BossTracker] Delete fetch error:', err);
          }
        }, DELETE_AFTER_MS);
      }
      return msg.id;
    } catch (err) {
      console.error('[BossTracker] Send error:', err);
      alert('❌ Network error — could not reach Discord.');
    }
  }

  /* ── Auto-alert: check HP threshold transitions after each poll ── */
  async function checkAlerts(grouped) {
    if (!getWebhookUrl()) return; // no webhook configured — skip silently

    for (const boss of BOSSES) {
      if (!isAutoAlertEnabled(boss.id)) continue; // this boss's alerts are toggled off
      const records = grouped[boss.id] || [];
      const currentKeys = new Set();

      for (const r of records) {
        const status = getChannelStatus(r.last_hp, r.last_update);
        if (status === 'unknown') continue;

        const key = `${boss.id}-${r.channel_number}`;
        currentKeys.add(key);
        const prev = prevHpMap[key];

        // First time seeing this channel — just initialise, don't alert
        if (prev === undefined) {
          prevHpMap[key] = r.last_hp;
          continue;
        }

        const crossedLow = prev > 30 && r.last_hp > 0 && r.last_hp <= 30;
        const justKilled = prev > 0  && r.last_hp === 0;

        if (crossedLow) {
          // Store the message ID so it can be deleted together with the killed message
          const msgId = await sendDiscordMessage(boss.name, r.channel_number, r.last_hp, { promptIfMissing: false, autoDelete: false });
          if (msgId) pendingAlertMsgIds[key] = msgId;
        }

        if (justKilled) {
          const wh = getWebhookUrl().replace(/\/+$/, '');
          const lowMsgId = pendingAlertMsgIds[key];
          delete pendingAlertMsgIds[key];
          const killedMsgId = await sendDiscordMessage(boss.name, r.channel_number, r.last_hp, { promptIfMissing: false, autoDelete: false });
          console.log(`[BossTracker] justKilled — killedMsgId=${killedMsgId} lowMsgId=${lowMsgId} wh=${wh}`);
          // After 10 s delete the killed message and the paired low-HP message simultaneously
          setTimeout(async () => {
            console.log(`[BossTracker] Delete timer fired for ${boss.name} ch${r.channel_number}`);
            const deletions = [];
            if (killedMsgId) deletions.push(
              fetch(`${wh}/messages/${killedMsgId}`, { method: 'DELETE' })
                .then(dr => console.log(`[BossTracker] Killed msg delete: ${dr.status}`))
                .catch(err => console.error('[BossTracker] Killed msg delete error:', err))
            );
            if (lowMsgId) deletions.push(
              fetch(`${wh}/messages/${lowMsgId}`, { method: 'DELETE' })
                .then(dr => console.log(`[BossTracker] Low-HP msg delete: ${dr.status}`))
                .catch(err => console.error('[BossTracker] Low-HP msg delete error:', err))
            );
            await Promise.all(deletions);
          }, DELETE_AFTER_MS);
        }

        prevHpMap[key] = r.last_hp;
      }

      // Remove channels that disappeared (boss respawned) so they can alert again next cycle
      for (const key of Object.keys(prevHpMap)) {
        if (key.startsWith(`${boss.id}-`) && !currentKeys.has(key)) {
          delete prevHpMap[key];
          delete pendingAlertMsgIds[key];
        }
      }
    }
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
      checkAlerts(grouped);
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

      /* Sort: low HP first → 100% HP → dead (0%) last */
      processed.sort((a, b) => {
        const rank = hp => hp === 0 ? 101 : hp; // treat dead as 101 so it sinks to end
        return rank(a.hp) - rank(b.hp);
      });

      for (let i = 0; i < MAX_CHANNELS; i++) {
        const span = document.createElement('span');
        const item = processed[i];

        if (item) {
          span.className = `bt-pill bt-pill--${item.status}`;
          span.title = item.status === 'dead'
            ? `Ch ${item.ch} — Boss killed (click to report)`
            : `Ch ${item.ch} — ${item.hp}% HP (click to report)`;
          span.classList.add('bt-pill--clickable');
          span.addEventListener('click', () => sendDiscordMessage(boss.name, item.ch, item.hp));

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
    const titleEl = document.createElement('h2');
    titleEl.className = 'bt-title';
    titleEl.textContent = '🐉 Boss Tracker — SEA';
    const webhookBtn = document.createElement('button');
    webhookBtn.className = 'bt-webhook-btn';
    const refreshWebhookBtn = () => {
      const connected = !!getWebhookUrl();
      webhookBtn.textContent = connected ? '✅ Connected' : '🔔 Connect to Discord';
      webhookBtn.title = connected ? 'Discord connected — click to update or remove' : 'Connect a Discord webhook';
      webhookBtn.classList.toggle('bt-webhook-btn--connected', connected);
    };
    refreshWebhookBtn();
    webhookBtn.addEventListener('click', () => { configureWebhook(); refreshWebhookBtn(); });

    header.appendChild(titleEl);
    header.appendChild(webhookBtn);
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
          <button class="bt-alert-btn" id="btalert-${boss.id}" type="button"></button>
        </div>
      `;
      cardsRow.appendChild(card);

      /* Wire per-boss alert toggle */
      const alertBtn = card.querySelector(`#btalert-${boss.id}`);
      const refreshAlertBtn = () => {
        const on = isAutoAlertEnabled(boss.id);
        alertBtn.textContent = on ? '🟢 Alerts ON' : '🔴 Alerts OFF';
        alertBtn.title = on ? 'Auto-alerts ON — click to disable' : 'Auto-alerts OFF — click to enable';
        alertBtn.classList.toggle('bt-alert-btn--off', !on);
      };
      refreshAlertBtn();
      alertBtn.addEventListener('click', () => {
        setAutoAlert(boss.id, !isAutoAlertEnabled(boss.id));
        refreshAlertBtn();
      });
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
