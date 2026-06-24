'use strict';

(function () {
  const CLIENT_MAGIC = 0x56;
  const SERVER_MAGIC = 0x58;

  const ACTION = { start: 1, step: 2, again: 9, unknown: 11 };

  const SERVER = { HELLO: 1, STATE: 3, GUARD: 6, ERROR: 8, FLAG: 12, NOTICE: 13 };

  const ZONE_NAMES = [
    'Lobby',
    'Hallway',
    'Gallery',
    'Security Room',
    'Vault Door',
    'Vault',
  ];

  const STORAGE_RESUME = 'vault_exe_resume';
  const STORAGE_CALIB = 'vault_exe_calibration';

  const BOOT_LINES = [
    'VAULT.EXE BOOTING...',
    'loading blackmarket interface...',
    'syncing door memory...',
    'protocol manual damaged...',
    'ready.',
  ];

  // ─── DOM refs ────────────────────────────────────────────

  const $ = (sel) => document.querySelector(sel);

  const bootScreen = $('#boot-screen');
  const bootLog = $('#boot-log');
  const bootSkip = $('#boot-skip');
  const loginModal = $('#login-modal');
  const nicknameInput = $('#nickname');
  const enterBtn = $('#enter-btn');
  const app = $('#app');
  const victoryScreen = $('#victory-screen');
  const flagDisplay = $('#flag-display');
  const victoryClose = $('#victory-close');

  const chipWs = $('#chip-ws');
  const chipGuard = $('#chip-guard');
  const chipZone = $('#chip-zone');
  const chipSession = $('#chip-session');

  const monZone = $('#mon-zone');
  const monLane = $('#mon-lane');
  const monGuard = $('#mon-guard');
  const monDoor = $('#mon-door');
  const monPath = $('#mon-path');
  const monNotice = $('#mon-notice');
  const objectiveText = $('#objective-text');

  const btnBack = $('#btn-back');
  const btnForward = $('#btn-forward');
  const protocolLog = $('#protocol-log');
  const logCount = $('#log-count');
  const leaderboardList = $('#leaderboard-list');

  const canvas = $('#game-canvas');
  const ctx = canvas.getContext('2d');

  // ─── State ───────────────────────────────────────────────

  let ws = null;
  let clientSeq = 1;
  let calibration = 0;
  let resumeToken = localStorage.getItem(STORAGE_RESUME) || null;
  let currentZone = 0;
  let guardState = 'awake';
  let guardTick = 0;
  let pathLen = 1;
  let logEvents = 0;
  let reconnectTimer = null;
  let animFrame = 0;
  let case7Flicker = false;
  let doorPulse = 0;
  let protocolReady = false;

  const roomLayout = [
    { x: 60, y: 180, w: 80, h: 60, label: 'Lobby' },
    { x: 170, y: 180, w: 80, h: 60, label: 'Hall' },
    { x: 280, y: 180, w: 80, h: 60, label: 'Gallery' },
    { x: 390, y: 180, w: 80, h: 60, label: 'Security' },
    { x: 500, y: 180, w: 80, h: 60, label: 'Door' },
    { x: 560, y: 80, w: 70, h: 70, label: 'Vault' },
  ];

  // ─── Protocol helpers ────────────────────────────────────

  function computeChecksum(type, seq, payloadLength, saltByte) {
    const seqHi = (seq >> 8) & 0xff;
    const seqLo = seq & 0xff;
    return (type + seqHi + seqLo + payloadLength + saltByte) & 0xff;
  }

  function encodeFrame(type, payloadObj, saltByte) {
    const salt = saltByte !== undefined ? saltByte : calibration;
    const payloadStr = JSON.stringify(payloadObj);
    const payloadBytes = new TextEncoder().encode(payloadStr);
    const frame = new Uint8Array(5 + payloadBytes.length);
    const seq = clientSeq;
    frame[0] = CLIENT_MAGIC;
    frame[1] = type;
    frame[2] = (seq >> 8) & 0xff;
    frame[3] = seq & 0xff;
    frame[4] = computeChecksum(type, seq, payloadBytes.length, salt);
    frame.set(payloadBytes, 5);
    clientSeq += 1;
    return frame;
  }

  function decodeFrame(buffer) {
    const view = new Uint8Array(buffer);
    if (view.length < 5) return null;
    if (view[0] !== SERVER_MAGIC) return { error: 'ERR_BAD_MAGIC' };
    const type = view[1];
    const seq = (view[2] << 8) | view[3];
    const checksum = view[4];
    const payloadBytes = view.subarray(5);
    const salt = type === SERVER.HELLO ? 0 : calibration;
    const expected = computeChecksum(type, seq, payloadBytes.length, salt);
    if (checksum !== expected) return { error: 'ERR_BAD_CHECKSUM', type, seq };
    try {
      const payload = JSON.parse(new TextDecoder().decode(payloadBytes));
      return { type, seq, payload };
    } catch {
      return { error: 'ERR_BAD_JSON' };
    }
  }

  function sendFrame(type, payload, saltByte) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      log('Cannot send — socket offline', 'err');
      return;
    }
    ws.send(encodeFrame(type, payload, saltByte));
  }

  function setMovementEnabled(enabled) {
    if (!enabled) {
      btnBack.disabled = true;
      btnForward.disabled = true;
      return;
    }
    setZoneUI(currentZone);
  }

  // ─── Logging ─────────────────────────────────────────────

  function ts() {
    return new Date().toLocaleTimeString('en-GB', { hour12: false });
  }

  function log(msg, level = 'info') {
    logEvents += 1;
    logCount.textContent = `${logEvents} events`;
    const line = document.createElement('p');
    line.className = `log-line ${level}`;
    line.innerHTML = `<span class="log-ts">${ts()}</span>${escapeHtml(msg)}`;
    protocolLog.appendChild(line);
    protocolLog.scrollTop = protocolLog.scrollHeight;
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  // ─── UI updates ──────────────────────────────────────────

  function setWsStatus(connected) {
    chipWs.textContent = connected ? 'WS: connected' : 'WS: disconnected';
    chipWs.className = connected ? 'chip chip-on' : 'chip chip-off';
  }

  function setGuardUI(guard) {
    guardState = guard;
    chipGuard.textContent = `Guard: ${guard}`;
    chipGuard.className = guard === 'asleep' ? 'chip chip-guard-asleep' : 'chip chip-guard-awake';
    monGuard.textContent = guard.toUpperCase();
  }

  function setZoneUI(zone, zoneName) {
    currentZone = zone;
    const name = zoneName || ZONE_NAMES[zone] || 'Unknown';
    chipZone.textContent = `Zone: ${name}`;
    monZone.textContent = name;
    monDoor.textContent = zone >= 4 ? 'VIBRATING' : zone >= 3 ? 'ARMED' : 'SEALED';
    btnBack.disabled = zone <= 0;
    btnForward.disabled = zone >= 4;
    if (zone >= 4) {
      objectiveText.textContent = 'You stand before the vault door. Something else is required.';
    } else if (zone >= 3) {
      objectiveText.textContent = 'Security cleared. Advance to the vault door.';
    } else {
      objectiveText.textContent = 'Reach the vault door. Watch the guard.';
    }
  }

  function setNotice(msg) {
    monNotice.textContent = msg;
  }

  // ─── Boot sequence ───────────────────────────────────────

  function runBoot(onDone) {
    let i = 0;
    let skipped = false;

    function finish() {
      if (skipped) return;
      skipped = true;
      bootScreen.classList.add('hidden');
      onDone();
    }

    bootSkip.addEventListener('click', finish);

    function nextLine() {
      if (skipped) return;
      if (i >= BOOT_LINES.length) {
        setTimeout(finish, 300);
        return;
      }
      bootLog.textContent += (i > 0 ? '\n' : '') + BOOT_LINES[i];
      i += 1;
      setTimeout(nextLine, i === 1 ? 200 : 350);
    }
    nextLine();
  }

  // ─── Canvas rendering ────────────────────────────────────

  function drawPixelRect(x, y, w, h, color) {
    ctx.fillStyle = color;
    ctx.fillRect(Math.floor(x), Math.floor(y), w, h);
  }

  function drawMap() {
    const W = canvas.width;
    const H = canvas.height;
    animFrame += 1;

    ctx.fillStyle = '#080c10';
    ctx.fillRect(0, 0, W, H);

    // floor grid
    ctx.strokeStyle = '#1a2a20';
    ctx.lineWidth = 1;
    for (let gx = 0; gx < W; gx += 20) {
      ctx.beginPath();
      ctx.moveTo(gx, 0);
      ctx.lineTo(gx, H);
      ctx.stroke();
    }
    for (let gy = 0; gy < H; gy += 20) {
      ctx.beginPath();
      ctx.moveTo(0, gy);
      ctx.lineTo(W, gy);
      ctx.stroke();
    }

    // neon wires
    ctx.strokeStyle = '#3de8ff33';
    ctx.beginPath();
    ctx.moveTo(0, 40);
    ctx.lineTo(W, 40);
    ctx.stroke();

    // connections
    ctx.strokeStyle = '#39ff8a55';
    ctx.lineWidth = 2;
    for (let i = 0; i < roomLayout.length - 2; i++) {
      const a = roomLayout[i];
      const b = roomLayout[i + 1];
      ctx.beginPath();
      ctx.moveTo(a.x + a.w / 2, a.y + a.h / 2);
      ctx.lineTo(b.x + b.w / 2, b.y + b.h / 2);
      ctx.stroke();
    }
    // vault branch
    const door = roomLayout[4];
    const vault = roomLayout[5];
    ctx.strokeStyle = '#ff446655';
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(door.x + door.w / 2, door.y);
    ctx.lineTo(vault.x + vault.w / 2, vault.y + vault.h);
    ctx.stroke();
    ctx.setLineDash([]);

    // rooms
    roomLayout.forEach((room, idx) => {
      const isCurrent = idx === currentZone;
      const isLocked = idx === 5;
      const baseColor = isCurrent ? '#1a3a28' : '#121a16';
      drawPixelRect(room.x, room.y, room.w, room.h, baseColor);
      ctx.strokeStyle = isCurrent ? '#39ff8a' : isLocked ? '#ff4466' : '#2a4a38';
      ctx.lineWidth = isCurrent ? 2 : 1;
      ctx.strokeRect(room.x, room.y, room.w, room.h);

      ctx.fillStyle = isCurrent ? '#39ff8a' : '#6a8a72';
      ctx.font = '10px monospace';
      ctx.textAlign = 'center';
      ctx.fillText(room.label, room.x + room.w / 2, room.y + room.h / 2 + 3);

      if (idx === 3) {
        // camera blink
        const camOn = animFrame % 60 < 30;
        drawPixelRect(room.x + room.w - 14, room.y + 6, 8, 6, camOn ? '#ff4466' : '#441111');
      }
      if (idx === 4) {
        doorPulse = (doorPulse + 0.05) % (Math.PI * 2);
        const glow = 0.4 + Math.sin(doorPulse) * 0.3;
        ctx.strokeStyle = `rgba(255, 179, 71, ${glow})`;
        ctx.lineWidth = 2;
        ctx.strokeRect(room.x + 8, room.y + 10, room.w - 16, room.h - 20);
        // locked glyph
        ctx.fillStyle = '#ffb347';
        ctx.fillText('🔒', room.x + room.w / 2, room.y + 18);
      }
      if (idx === 5) {
        ctx.fillStyle = '#ff4466';
        ctx.fillText('⛔', room.x + room.w / 2, room.y + room.h / 2);
      }
    });

    // Case 7 flicker near vault door
    case7Flicker = guardState === 'asleep' && currentZone >= 3;
    if (case7Flicker && animFrame % 20 < 10) {
      const cx = roomLayout[4].x + roomLayout[4].w + 8;
      const cy = roomLayout[4].y - 20;
      drawPixelRect(cx, cy, 24, 18, '#2a1a00');
      ctx.strokeStyle = '#ffb347';
      ctx.strokeRect(cx, cy, 24, 18);
      ctx.fillStyle = '#ffb347';
      ctx.font = '8px monospace';
      ctx.fillText('C7', cx + 12, cy + 12);
    }

    // guard light
    const guardColor = guardState === 'asleep' ? '#39ff8a' : '#ff4466';
    drawPixelRect(20, 20, 12, 12, guardColor);
    ctx.fillStyle = '#6a8a72';
    ctx.font = '9px monospace';
    ctx.textAlign = 'left';
    ctx.fillText('GUARD', 36, 30);

    // blackmarket crate
    drawPixelRect(20, H - 50, 36, 30, '#1a1410');
    ctx.strokeStyle = '#ffb34755';
    ctx.strokeRect(20, H - 50, 36, 30);
    ctx.fillStyle = '#ffb347';
    ctx.font = '8px monospace';
    ctx.fillText('BM', 38, H - 32);

    // player marker
    const pr = roomLayout[currentZone] || roomLayout[0];
    const px = pr.x + pr.w / 2;
    const py = pr.y + pr.h / 2;
    const bob = Math.sin(animFrame * 0.1) * 2;
    drawPixelRect(px - 6, py - 10 + bob, 12, 14, '#3de8ff');
    ctx.fillStyle = '#fff';
    ctx.fillRect(px - 2, py - 6 + bob, 4, 4);
  }

  function startRenderLoop() {
    function loop() {
      drawMap();
      requestAnimationFrame(loop);
    }
    loop();
  }

  // ─── WebSocket ───────────────────────────────────────────

  function wsUrl() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}/ws`;
  }

  function connect(nickname) {
    if (ws) {
      ws.onclose = null;
      ws.close();
    }

    clientSeq = 1;
    calibration = 0;
    protocolReady = false;
    setMovementEnabled(false);
    ws = new WebSocket(wsUrl());
    ws.binaryType = 'arraybuffer';

    ws.addEventListener('open', () => {
      setWsStatus(true);
      log('WebSocket connected', 'ok');
      const payload = { nickname };
      if (resumeToken) payload.resume = resumeToken;
      sendFrame(ACTION.start, payload, 0);
    });

    ws.addEventListener('message', (ev) => {
      const decoded = decodeFrame(ev.data);
      if (!decoded || decoded.error) {
        log(decoded?.error || 'Bad frame', 'err');
        return;
      }
      handleServerFrame(decoded);
    });

    ws.addEventListener('close', () => {
      setWsStatus(false);
      log('WebSocket disconnected', 'warn');
      scheduleReconnect(nickname);
    });

    ws.addEventListener('error', () => {
      log('WebSocket error', 'err');
    });
  }

  function scheduleReconnect(nickname) {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      log('Attempting reconnect...', 'info');
      connect(nickname);
    }, 3000);
  }

  function handleServerFrame({ type, payload }) {
    switch (type) {
      case SERVER.HELLO:
        if (payload.resume) {
          resumeToken = payload.resume;
          localStorage.setItem(STORAGE_RESUME, resumeToken);
        }
        if (payload.calibration !== undefined) {
          calibration = payload.calibration;
          localStorage.setItem(STORAGE_CALIB, String(calibration));
        }
        protocolReady = true;
        if (payload.zone !== undefined) {
          setZoneUI(payload.zone, payload.zoneName);
        } else {
          setMovementEnabled(true);
        }
        log(`HELLO — session linked (zone: ${payload.zoneName || '?'})`, 'ok');
        chipSession.textContent = 'Session: lane active';
        chipSession.className = 'chip chip-sync';
        if (payload.lore) {
          payload.lore.forEach((l) => log(`lore: ${l}`, 'info'));
        }
        break;

      case SERVER.STATE:
        setZoneUI(payload.zone, payload.zoneName);
        pathLen = payload.pathLen || pathLen;
        monPath.textContent = `${pathLen} nodes`;
        log(`moved to ${payload.zoneName}`, 'info');
        break;

      case SERVER.GUARD:
        setGuardUI(payload.guard);
        guardTick = payload.tick;
        if (payload.guard === 'asleep') {
          log('guard asleep — corridor dim', 'warn');
        }
        break;

      case SERVER.ERROR:
        log(`ERROR: ${payload.code}${payload.hint ? ' — ' + payload.hint : ''}`, 'err');
        break;

      case SERVER.NOTICE:
        setNotice(payload.message);
        log(`NOTICE: ${payload.message}`, 'info');
        chipSession.textContent = 'Session: unstable lane';
        chipSession.className = 'chip chip-unstable';
        break;

      case SERVER.FLAG:
        log(payload.message || 'Flag received', 'ok');
        showVictory(payload.flag);
        refreshLeaderboard();
        break;

      default:
        log(`Unknown server frame type ${type}`, 'warn');
    }
  }

  function showVictory(flag) {
    flagDisplay.textContent = flag || '???';
    victoryScreen.classList.remove('hidden');
  }

  // ─── Movement ────────────────────────────────────────────

  function move(dir) {
    if (!protocolReady) return;
    sendFrame(ACTION.step, { dir });
  }

  btnBack.addEventListener('click', () => move('back'));
  btnForward.addEventListener('click', () => move('forward'));

  document.addEventListener('keydown', (e) => {
    if (loginModal.classList.contains('hidden') === false) return;
    if (victoryScreen.classList.contains('hidden') === false) return;
    if (e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'A') {
      e.preventDefault();
      if (!btnBack.disabled) move('back');
    }
    if (e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D') {
      e.preventDefault();
      if (!btnForward.disabled) move('forward');
    }
  });

  // ─── Leaderboard ─────────────────────────────────────────

  async function refreshLeaderboard() {
    try {
      const res = await fetch('/api/leaderboard');
      const data = await res.json();
      const entries = data.entries || [];
      if (!entries.length) {
        leaderboardList.innerHTML = '<li class="lb-empty">No breaches yet.</li>';
        return;
      }
      leaderboardList.innerHTML = entries
        .slice(0, 10)
        .map(
          (e) =>
            `<li><span class="lb-handle">${escapeHtml(e.handle)}</span><span class="lb-time">${escapeHtml(e.solvedAt.slice(11, 19))}</span></li>`
        )
        .join('');
    } catch {
      /* silent */
    }
  }

  // ─── Init ────────────────────────────────────────────────

  enterBtn.addEventListener('click', startGame);
  nicknameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') startGame();
  });

  victoryClose.addEventListener('click', () => {
    victoryScreen.classList.add('hidden');
  });

  function startGame() {
    const nick = nicknameInput.value.trim();
    if (!nick) {
      nicknameInput.focus();
      nicknameInput.style.borderColor = '#ff4466';
      return;
    }
    loginModal.classList.add('hidden');
    app.classList.remove('hidden');
    startRenderLoop();
    connect(nick);
    refreshLeaderboard();
    setInterval(refreshLeaderboard, 30000);
  }

  runBoot(() => {
    loginModal.classList.remove('hidden');
    nicknameInput.focus();
  });
})();
