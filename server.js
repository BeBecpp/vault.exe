'use strict';

require('dotenv').config();

const crypto = require('crypto');
const path = require('path');
const http = require('http');
const express = require('express');
const helmet = require('helmet');
const { WebSocketServer } = require('ws');
const { nanoid } = require('nanoid');

const PORT = Number(process.env.PORT) || 3000;
const HOST = '0.0.0.0';
const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_DEV = NODE_ENV !== 'production';
const FLAG_SECRET = process.env.FLAG_SECRET || 'vault_exe_local_dev_secret_do_not_use_in_prod';

const CLIENT_MAGIC = 0x56;
const SERVER_MAGIC = 0x58;

const CLIENT_TYPE = { START: 1, MOVE: 2, RESUME: 9, HIDDEN: 11 };
const SERVER_TYPE = { HELLO: 1, STATE: 3, GUARD: 6, ERROR: 8, FLAG: 12, NOTICE: 13 };

const ZONE_NAMES = [
  'Lobby',
  'Hallway',
  'Gallery',
  'Security Room',
  'Vault Door',
  'Vault',
];

const REQUIRED_PATH = [0, 1, 2, 3, 4];
const MAX_ZONE = 4;
const INVALID_FRAME_LIMIT = 20;
const INVALID_FRAME_WINDOW_MS = 10_000;

/** @type {Map<string, Session>} */
const sessions = new Map();
/** @type {Map<string, string>} resumeToken -> sessionId */
const resumeIndex = new Map();
/** @type {Array<{handle: string, solvedAt: string}>} */
const leaderboard = [];
/** @type {Map<string, string>} stable flag cache per session */
const flagCache = new Map();

/**
 * @typedef {Object} Session
 * @property {string} id
 * @property {string} nickname
 * @property {string} resumeToken
 * @property {number} sessionSaltByte
 * @property {number} visualZone
 * @property {number} permissionZone
 * @property {number[]} pathHistory
 * @property {boolean} solved
 * @property {number} createdAt
 * @property {number} updatedAt
 */

/**
 * @typedef {Object} ConnectionState
 * @property {string|null} sessionId
 * @property {string} nickname
 * @property {number} visualZone
 * @property {number} permissionZone
 * @property {number} expectedSeq
 * @property {number} serverSeq
 * @property {number[]} invalidFrameTimestamps
 * @property {number} connectedAt
 */

function computeChecksum(type, seq, payloadLength, sessionSaltByte) {
  const seqHi = (seq >> 8) & 0xff;
  const seqLo = seq & 0xff;
  return (type + seqHi + seqLo + payloadLength + sessionSaltByte) & 0xff;
}

function encodeFrame(magic, type, seq, payloadObject, sessionSaltByte) {
  const payloadStr = JSON.stringify(payloadObject);
  const payloadBytes = Buffer.from(payloadStr, 'utf8');
  const frame = Buffer.allocUnsafe(5 + payloadBytes.length);
  frame[0] = magic;
  frame[1] = type;
  frame[2] = (seq >> 8) & 0xff;
  frame[3] = seq & 0xff;
  frame[4] = computeChecksum(type, seq, payloadBytes.length, sessionSaltByte);
  payloadBytes.copy(frame, 5);
  return frame;
}

function decodeFrame(buffer, expectedMagic, sessionSaltByte) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 5) {
    return { ok: false, code: 'ERR_BAD_FRAME' };
  }
  const magic = buffer[0];
  if (magic !== expectedMagic) {
    return { ok: false, code: 'ERR_BAD_MAGIC' };
  }
  const type = buffer[1];
  const seq = (buffer[2] << 8) | buffer[3];
  const checksum = buffer[4];
  const payloadBytes = buffer.subarray(5);
  const expectedChecksum = computeChecksum(type, seq, payloadBytes.length, sessionSaltByte);
  if (checksum !== expectedChecksum) {
    return { ok: false, code: 'ERR_BAD_CHECKSUM', type, seq };
  }
  let payload;
  try {
    payload = JSON.parse(payloadBytes.toString('utf8'));
  } catch {
    return { ok: false, code: 'ERR_BAD_JSON', type, seq };
  }
  return { ok: true, type, seq, payload };
}

function randomSaltByte() {
  return crypto.randomInt(1, 256);
}

function createSession(nickname) {
  const id = nanoid(16);
  const resumeToken = nanoid(24);
  /** @type {Session} */
  const session = {
    id,
    nickname,
    resumeToken,
    sessionSaltByte: randomSaltByte(),
    visualZone: 0,
    permissionZone: 0,
    pathHistory: [0],
    solved: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  sessions.set(id, session);
  resumeIndex.set(resumeToken, id);
  return session;
}

function getSessionByResume(resumeToken) {
  const sessionId = resumeIndex.get(resumeToken);
  if (!sessionId) return null;
  return sessions.get(sessionId) || null;
}

function pathContainsRequired(pathHistory) {
  let idx = 0;
  for (const zone of pathHistory) {
    if (zone === REQUIRED_PATH[idx]) {
      idx += 1;
      if (idx === REQUIRED_PATH.length) return true;
    }
  }
  return false;
}

function generateFlag(session) {
  if (flagCache.has(session.id)) {
    return flagCache.get(session.id);
  }
  const material = `${session.id}:${session.resumeToken}:${session.nickname}`;
  const digest = crypto
    .createHmac('sha256', FLAG_SECRET)
    .update(material)
    .digest('hex')
    .slice(0, 12);
  const flag = `NF404{vault_exe_${digest}}`;
  flagCache.set(session.id, flag);
  return flag;
}

function guardStateAt(nowMs = Date.now()) {
  const tick = Math.floor(nowMs / 1000);
  const phase = tick % 7;
  const asleep = phase >= 5;
  return { guard: asleep ? 'asleep' : 'awake', tick };
}

function isGuardAsleep(nowMs = Date.now()) {
  return guardStateAt(nowMs).guard === 'asleep';
}

function recordZoneVisit(session, zone) {
  const last = session.pathHistory[session.pathHistory.length - 1];
  if (last !== zone) {
    session.pathHistory.push(zone);
  }
}

function sendError(ws, conn, session, code, detail = {}) {
  if (!session) return;
  conn.serverSeq += 1;
  const payload = { code, ...detail };
  if (code === 'ERR_BAD_SEQUENCE' && IS_DEV && detail.expected !== undefined) {
    payload.hint = `expected seq ${detail.expected}`;
  } else if (code === 'ERR_BAD_SEQUENCE') {
    payload.hint = 'frame order drift detected';
  }
  ws.send(
    encodeFrame(SERVER_MAGIC, SERVER_TYPE.ERROR, conn.serverSeq, payload, session.sessionSaltByte)
  );
}

function sendNotice(ws, conn, session, message) {
  conn.serverSeq += 1;
  ws.send(
    encodeFrame(
      SERVER_MAGIC,
      SERVER_TYPE.NOTICE,
      conn.serverSeq,
      { message },
      session.sessionSaltByte
    )
  );
}

function sendState(ws, conn, session) {
  conn.serverSeq += 1;
  ws.send(
    encodeFrame(
      SERVER_MAGIC,
      SERVER_TYPE.STATE,
      conn.serverSeq,
      {
        zone: conn.visualZone,
        zoneName: ZONE_NAMES[conn.visualZone] || 'Unknown',
        permission: conn.permissionZone,
        pathLen: session.pathHistory.length,
      },
      session.sessionSaltByte
    )
  );
}

function sendHello(ws, conn, session) {
  conn.serverSeq += 1;
  ws.send(
    encodeFrame(
      SERVER_MAGIC,
      SERVER_TYPE.HELLO,
      conn.serverSeq,
      {
        session: session.id,
        resume: session.resumeToken,
        zone: session.visualZone,
        zoneName: ZONE_NAMES[session.visualZone],
        seq: conn.expectedSeq,
        calibration: session.sessionSaltByte,
        lore: [
          'The vault remembers what the door forgot.',
          'Two mirrors, one keyhole.',
          'Case 7 only listens in the dark.',
        ],
      },
      session.sessionSaltByte
    )
  );
}

function sendFlag(ws, conn, session, flag) {
  conn.serverSeq += 1;
  ws.send(
    encodeFrame(
      SERVER_MAGIC,
      SERVER_TYPE.FLAG,
      conn.serverSeq,
      {
        ok: true,
        message: 'case_7 opened',
        flag,
      },
      session.sessionSaltByte
    )
  );
}

function validateSeq(conn, seq, ws, session) {
  if (seq !== conn.expectedSeq) {
    if (session) {
      sendError(ws, conn, session, 'ERR_BAD_SEQUENCE', { expected: conn.expectedSeq, got: seq });
    } else {
      ws.close(4005, 'ERR_BAD_SEQUENCE');
    }
    return false;
  }
  conn.expectedSeq += 1;
  return true;
}

function trackInvalidFrame(conn, ws, session) {
  const now = Date.now();
  conn.invalidFrameTimestamps = conn.invalidFrameTimestamps.filter(
    (t) => now - t < INVALID_FRAME_WINDOW_MS
  );
  conn.invalidFrameTimestamps.push(now);
  if (conn.invalidFrameTimestamps.length > INVALID_FRAME_LIMIT) {
    sendError(ws, conn, session, 'ERR_TOO_NOISY');
    ws.close(4008, 'ERR_TOO_NOISY');
    return true;
  }
  return false;
}

function handleStart(ws, conn, _session, payload) {
  const nickname = String(payload.nickname || '').trim().slice(0, 32);
  if (!nickname) {
    ws.close(4004, 'ERR_BAD_JSON');
    return;
  }

  const resume = payload.resume ? String(payload.resume) : null;
  let activeSession = resume ? getSessionByResume(resume) : null;

  if (!activeSession) {
    activeSession = createSession(nickname);
  } else {
    activeSession.nickname = nickname;
    activeSession.updatedAt = Date.now();
  }

  conn.sessionId = activeSession.id;
  conn.nickname = nickname;
  conn.visualZone = activeSession.visualZone;
  conn.permissionZone = activeSession.permissionZone;

  sendHello(ws, conn, activeSession);
  sendState(ws, conn, activeSession);
}

function handleResume(ws, conn, session, payload) {
  const resume = payload.resume ? String(payload.resume) : null;
  if (!resume) {
    sendError(ws, conn, session, 'ERR_BAD_STATE', { reason: 'resume token missing' });
    return;
  }

  const resumed = getSessionByResume(resume);
  if (!resumed) {
    sendError(ws, conn, session, 'ERR_BAD_STATE', { reason: 'session not found' });
    return;
  }

  const nickname = String(payload.nickname || resumed.nickname).trim().slice(0, 32);
  resumed.nickname = nickname;
  resumed.updatedAt = Date.now();

  conn.sessionId = resumed.id;
  conn.nickname = nickname;
  conn.visualZone = resumed.visualZone;
  // Intentional bug: permissionZone is NOT refreshed from session

  sendNotice(ws, conn, resumed, 'session lane resynced (visual only)');
  sendState(ws, conn, resumed);
}

function handleMove(ws, conn, session, payload) {
  const direction = payload.dir;
  if (direction !== 'forward' && direction !== 'back') {
    sendError(ws, conn, session, 'ERR_BAD_STATE', { reason: 'invalid direction' });
    return;
  }

  let nextZone = conn.visualZone;
  if (direction === 'forward') {
    if (conn.visualZone >= MAX_ZONE) {
      sendError(ws, conn, session, 'ERR_BAD_STATE', { reason: 'path blocked' });
      return;
    }
    nextZone = conn.visualZone + 1;
  } else {
    if (conn.visualZone <= 0) {
      sendError(ws, conn, session, 'ERR_BAD_STATE', { reason: 'path blocked' });
      return;
    }
    nextZone = conn.visualZone - 1;
  }

  conn.visualZone = nextZone;
  conn.permissionZone = nextZone;
  session.visualZone = nextZone;
  session.permissionZone = nextZone;
  session.updatedAt = Date.now();
  recordZoneVisit(session, nextZone);

  sendState(ws, conn, session);
}

function handleHiddenAction(ws, conn, session, payload) {
  const target = payload.target;
  const intent = payload.intent;

  if (target !== 'case_7' || intent !== 'inspect') {
    sendError(ws, conn, session, 'ERR_UNKNOWN_ACTION');
    return;
  }

  if (!isGuardAsleep()) {
    sendError(ws, conn, session, 'ERR_GUARD_AWAKE');
    return;
  }

  if (conn.visualZone !== 4 || conn.permissionZone !== 3) {
    sendError(ws, conn, session, 'ERR_CASE_LOCKED');
    return;
  }

  if (!pathContainsRequired(session.pathHistory)) {
    sendError(ws, conn, session, 'ERR_CASE_LOCKED', { reason: 'path incomplete' });
    return;
  }

  if (session.solved) {
    const flag = generateFlag(session);
    sendFlag(ws, conn, session, flag);
    return;
  }

  session.solved = true;
  session.updatedAt = Date.now();
  const flag = generateFlag(session);
  leaderboard.push({
    handle: session.nickname,
    solvedAt: new Date().toISOString(),
  });
  leaderboard.sort((a, b) => a.solvedAt.localeCompare(b.solvedAt));
  sendFlag(ws, conn, session, flag);
}

function decodeClientFrame(raw, session) {
  const trySalts = new Set();
  if (session) trySalts.add(session.sessionSaltByte);
  trySalts.add(0);

  if (raw.length >= 5) {
    try {
      const payloadBytes = raw.subarray(5);
      const payload = JSON.parse(payloadBytes.toString('utf8'));
      if (payload.resume) {
        const resumed = getSessionByResume(String(payload.resume));
        if (resumed) trySalts.add(resumed.sessionSaltByte);
      }
    } catch {
      /* ignore peek errors */
    }
  }

  for (const salt of trySalts) {
    const decoded = decodeFrame(raw, CLIENT_MAGIC, salt);
    if (!decoded.ok) continue;

    let resolvedSession = session;
    if (
      decoded.type === CLIENT_TYPE.START &&
      decoded.payload &&
      decoded.payload.resume &&
      !resolvedSession
    ) {
      resolvedSession = getSessionByResume(String(decoded.payload.resume)) || null;
    }

    return { decoded, session: resolvedSession };
  }

  const fallback = decodeFrame(raw, CLIENT_MAGIC, session ? session.sessionSaltByte : 0);
  return { decoded: fallback, session: session || null };
}

function handleClientFrame(ws, conn, raw) {
  let session = conn.sessionId ? sessions.get(conn.sessionId) : null;
  const { decoded, session: resolvedSession } = decodeClientFrame(raw, session);
  session = resolvedSession;

  if (!decoded.ok) {
    if (session && trackInvalidFrame(conn, ws, session)) return;
    if (session) {
      sendError(ws, conn, session, decoded.code);
    } else {
      ws.close(4002, decoded.code);
    }
    return;
  }

  if (!session && decoded.type !== CLIENT_TYPE.START) {
    ws.close(4003, 'ERR_BAD_STATE');
    return;
  }

  if (!validateSeq(conn, decoded.seq, ws, session)) {
    if (session) trackInvalidFrame(conn, ws, session);
    return;
  }

  switch (decoded.type) {
    case CLIENT_TYPE.START:
      handleStart(ws, conn, session, decoded.payload);
      break;
    case CLIENT_TYPE.RESUME:
      handleResume(ws, conn, session, decoded.payload);
      break;
    case CLIENT_TYPE.MOVE:
      handleMove(ws, conn, session, decoded.payload);
      break;
    case CLIENT_TYPE.HIDDEN:
      handleHiddenAction(ws, conn, session, decoded.payload);
      break;
    default:
      sendError(ws, conn, session, 'ERR_UNKNOWN_ACTION');
      trackInvalidFrame(conn, ws, session);
  }
}

// ─── Express ───────────────────────────────────────────────────────────────

const app = express();

app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'", 'ws:', 'wss:'],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
  })
);

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'vault-exe', uptime: process.uptime() });
});

app.get('/api/me', (_req, res) => {
  res.json({
    name: 'Vault.exe',
    subtitle: 'The State Desync Heist',
    category: 'Web / WebSocket / State Machine',
    flagFormat: 'NF404{...}',
    hint: 'There is no flag endpoint. The vault speaks in frames.',
  });
});

app.get('/api/leaderboard', (_req, res) => {
  res.json({ entries: leaderboard.slice(0, 50) });
});

app.get('/api/flag', (_req, res) => {
  res.status(403).json({ error: 'There is no flag endpoint in this vault.' });
});

app.get('/api/vault', (_req, res) => {
  res.json({
    vault: 'sealed',
    cases: 12,
    case_7: 'signal_null',
    door: 'memory_locked',
    note: 'Visual access ≠ permission access',
  });
});

app.get('/api/debug', (_req, res) => {
  res.json({
    debug: true,
    sessions: sessions.size,
    wsPath: '/ws',
    frameMagicClient: '0x56',
    frameMagicServer: '0x58',
    warning: 'This panel shows nothing useful.',
  });
});

app.get('/admin', (_req, res) => {
  res.status(403).type('html').send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>Vault Admin — Locked</title>
<style>body{background:#0a0a0f;color:#ff4466;font-family:monospace;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.panel{border:2px solid #ff4466;padding:2rem;text-align:center;box-shadow:0 0 20px #ff446633}</style></head>
<body><div class="panel"><h1>⛔ ADMIN CONSOLE LOCKED</h1><p>Unauthorized. This vault has no admin surface.</p></div></body></html>`);
});

app.get('/internal/status', (_req, res) => {
  res.json({
    internal: true,
    guardCycle: '7s',
    zones: ZONE_NAMES.length,
    status: 'nominal',
  });
});

app.get('/robots.txt', (_req, res) => {
  res.type('text').send(`User-agent: *
Disallow: /admin
Disallow: /internal/
Disallow: /api/flag
Disallow: /api/debug
# The manual is damaged. Good luck.
Allow: /manual
`);
});

app.get('/manual', (_req, res) => {
  res.type('html').send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Vault Frame Manual v0.3</title>
<style>
  :root{--bg:#080c10;--panel:#0f1a14;--green:#39ff8a;--cyan:#3de8ff;--amber:#ffb347;--text:#c8e6d0;--muted:#5a7a62}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--text);font-family:"Courier New",Consolas,monospace;min-height:100vh}
  body::after{content:"";position:fixed;inset:0;background:repeating-linear-gradient(0deg,transparent,transparent 2px,rgba(0,0,0,.15) 2px,rgba(0,0,0,.15) 4px);pointer-events:none;z-index:99}
  .wrap{max-width:720px;margin:0 auto;padding:2rem}
  h1{color:var(--cyan);font-size:1.4rem;text-shadow:0 0 8px #3de8ff55}
  .sub{color:var(--muted);font-size:.85rem;margin-bottom:2rem}
  .panel{background:var(--panel);border:2px solid var(--green);padding:1.5rem;box-shadow:0 0 16px #39ff8a22,inset 0 0 30px #0008}
  pre{background:#0006;padding:1rem;border:1px dashed var(--muted);overflow-x:auto;line-height:1.8}
  .corrupt{color:#ff4466;text-decoration:line-through;opacity:.5}
  .unknown{color:var(--amber);animation:flicker 2s infinite}
  @keyframes flicker{0%,100%{opacity:1}50%{opacity:.4}}
  a{color:var(--cyan)}
</style>
</head>
<body>
<div class="wrap">
  <h1>Vault Frame Manual v0.3</h1>
  <p class="sub">RECOVERED FROM BLACKMARKET ARCHIVE — SEVERELY DAMAGED</p>
  <div class="panel">
    <p>All vault traffic uses fixed-width binary frames.</p>
    <pre>MAGIC | TYPE | SEQ   | <span class="corrupt">████</span> | PAYLOAD
0x56  | u8   | u16BE | <span class="unknown">?byte</span>  | UTF-8 JSON</pre>
    <p>Server replies use magic <code>0x58</code> instead of <code>0x56</code>.</p>
    <p>Known client types: <code>1</code> start, <code>2</code> move, <code>9</code> resume.</p>
    <p>Additional types may exist. The fourth field was used for <span class="corrupt">integrity</span> but the algorithm page is missing.</p>
    <p>Calibration value is sent once per session in the hello frame.</p>
    <p>Sequence numbers must match server expectation or frames are rejected.</p>
    <p style="color:var(--muted);font-size:.8rem;margin-top:2rem">— end of recoverable data —</p>
  </div>
  <p style="margin-top:1.5rem"><a href="/">← Return to Vault.exe</a></p>
</div>
</body>
</html>`);
});

app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html' }));

app.use((_req, res) => {
  res.status(404).type('html').send(`<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>404</title>
<style>body{background:#080c10;color:#39ff8a;font-family:monospace;display:flex;align-items:center;justify-content:center;height:100vh}</style>
</head><body><p>404 — Nothing behind this wall.</p></body></html>`);
});

// ─── HTTP + WebSocket ──────────────────────────────────────────────────────

const server = http.createServer(app);

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  /** @type {ConnectionState} */
  const conn = {
    sessionId: null,
    nickname: '',
    visualZone: 0,
    permissionZone: 0,
    expectedSeq: 1,
    serverSeq: 0,
    invalidFrameTimestamps: [],
    connectedAt: Date.now(),
  };

  const guardInterval = setInterval(() => {
    const session = conn.sessionId ? sessions.get(conn.sessionId) : null;
    if (!session || ws.readyState !== ws.OPEN) return;
    const { guard, tick } = guardStateAt();
    conn.serverSeq += 1;
    ws.send(
      encodeFrame(
        SERVER_MAGIC,
        SERVER_TYPE.GUARD,
        conn.serverSeq,
        { guard, tick },
        session.sessionSaltByte
      )
    );
  }, 1000);

  ws.on('message', (data, isBinary) => {
    if (!isBinary) {
      const session = conn.sessionId ? sessions.get(conn.sessionId) : null;
      if (session) {
        sendError(ws, conn, session, 'ERR_BAD_FRAME', { reason: 'binary frames only' });
        trackInvalidFrame(conn, ws, session);
      } else {
        ws.close(4001, 'ERR_BAD_FRAME');
      }
      return;
    }
    handleClientFrame(ws, conn, data);
  });

  ws.on('close', () => {
    clearInterval(guardInterval);
  });

  ws.on('error', () => {
    clearInterval(guardInterval);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Vault.exe listening on http://${HOST}:${PORT}`);
});

module.exports = {
  computeChecksum,
  encodeFrame,
  decodeFrame,
  guardStateAt,
  pathContainsRequired,
};
