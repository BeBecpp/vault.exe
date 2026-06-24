# Vault.exe — Owner Notes

> **⚠️ DO NOT publish this file publicly.** It contains the intended solve path and verification steps. Express only serves `public/` — this file in `docs/` is not exposed by default, but keep it out of client bundles and public repos if you want the challenge to stay hard.

---

## Challenge overview

**Vault.exe** is a WebSocket binary-protocol CTF where players:

1. Explore a polished pixel blackmarket vault UI
2. Discover that REST/API scanning is bait
3. Reverse the custom binary frame format (via `/manual`, DevTools, and `public/app.js`)
4. Execute a **two-tab state desynchronization** exploit using `RESUME`
5. Send a **hidden binary action** (type `11`) while the guard sleeps

The flag is generated dynamically server-side and only sent after all conditions pass.

---

## Intended solve path

### Phase 1 — Recon

- Play normally: enter nickname, move Lobby → Hallway → Gallery → Security Room → Vault Door
- Notice guard cycles (awake/asleep every ~7 seconds, asleep ~2 seconds)
- Read `/manual` — damaged frame layout, hints at unknown 4th byte
- Inspect WebSocket binary frames in DevTools
- Read `public/app.js` — find `ACTION` constants, checksum function, `calibration` from HELLO

### Phase 2 — Protocol

Frame layout (client → server):

```
byte 0: magic 0x56
byte 1: type (u8)
bytes 2-3: seq (u16 BE)
byte 4: checksum
bytes 5+: UTF-8 JSON payload
```

Server → client uses magic `0x58`.

**Checksum:**

```
checksum = (type + seq_hi + seq_lo + payload_length + sessionSaltByte) & 0xff
```

`sessionSaltByte` is sent as `calibration` in the HELLO frame.

### Phase 3 — State desync (two tabs)

1. **Tab A:** Start session, walk to **Security Room** (zone 3)
2. **Tab B:** Open same origin, same `localStorage` resume token (`vault_exe_resume`), connect
3. **Tab A:** Move to **Vault Door** (zone 4)
4. **Tab B:** Send `RESUME` frame (type 9) with resume token + nickname
5. **Bug:** Tab B `visualZone` = 4 (Vault Door), `permissionZone` stays 3 (Security Room)

Single-tab `RESUME` does **not** work because permission and visual were updated together on the same connection.

### Phase 4 — Hidden action

While guard is **asleep**, Tab B sends type **11** frame:

```json
{ "target": "case_7", "intent": "inspect" }
```

With valid seq + checksum + calibration.

### Success conditions (all required)

| Check | Value |
|-------|-------|
| type | `11` |
| visualZone | `4` (Vault Door) |
| permissionZone | `3` (Security Room) |
| guard | asleep |
| payload.target | `case_7` |
| payload.intent | `inspect` |
| pathHistory | contains `0→1→2→3→4` in order |
| checksum/seq | valid |

---

## Verify locally

```bash
cp .env.example .env
npm install
npm run dev
# another terminal:
npm run smoke
```

Manual solve test (author only — browser console on Tab B after desync):

```javascript
// Assumes: ws is open WebSocket, calibration stored, clientSeq correct
// Player must compute frame manually — example outline only:

const type = 11;
const payload = JSON.stringify({ target: 'case_7', intent: 'inspect' });
const bytes = new TextEncoder().encode(payload);
const seq = /* current expected seq from last server frame */;
const cal = Number(localStorage.getItem('vault_exe_calibration'));
const chk = (type + ((seq>>8)&0xff) + (seq&0xff) + bytes.length + cal) & 0xff;
const frame = new Uint8Array(5 + bytes.length);
frame[0] = 0x56; frame[1] = type;
frame[2] = (seq>>8)&0xff; frame[3] = seq&0xff; frame[4] = chk;
frame.set(bytes, 5);
ws.send(frame);
```

For RESUME on Tab B:

```javascript
const type = 9;
const payload = JSON.stringify({
  resume: localStorage.getItem('vault_exe_resume'),
  nickname: 'your_handle'
});
// ... same framing as above with correct seq
```

---

## Deploy to Railway

1. Set `FLAG_SECRET` to a long random value in Railway variables
2. Set `NODE_ENV=production`
3. Push repo; Railway builds from `Dockerfile`
4. Health check: `/health`

---

## Common issues

| Issue | Cause |
|-------|-------|
| `ERR_BAD_CHECKSUM` | Wrong calibration byte or payload length |
| `ERR_BAD_SEQUENCE` | Seq drift — check last HELLO/STATE/ERROR hint in dev |
| `ERR_GUARD_AWAKE` | Hidden action sent while guard awake |
| `ERR_CASE_LOCKED` | Desync not achieved (visual/permission mismatch) |
| `ERR_TOO_NOISY` | >20 bad frames in 10s |
| Flag different per deploy | Expected — HMAC uses `FLAG_SECRET` + session material |

---

## Reset leaderboard

Restart the server process. Leaderboard is in-memory only.

---

## Flag generation

```
HMAC-SHA256(FLAG_SECRET, sessionId:resumeToken:nickname) → first 12 hex chars
NF404{vault_exe_<hex>}
```

Same session gets stable flag during one server runtime (cached per session id).

---

## Security notes

- No flag in client bundles, bait routes, or README
- `docs/OWNER_NOTES.md` not served by Express
- No `eval`, no external attacks, no secret logging
