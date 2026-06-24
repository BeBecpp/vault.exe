# Vault.exe — The State Desync Heist

A self-contained browser CTF challenge for authorized lab and team practice.

**Category:** Web / WebSocket / State Machine / Logic Bug  
**Difficulty:** Hard+  
**Flag format:** `NF404{...}`

> There is no `/api/flag`. This challenge is solved through live protocol and state analysis.

## About

You enter a pixel blackmarket vault interface and navigate a cyber-noir heist map. The vault speaks a custom **binary WebSocket protocol** — not REST. Scanning API routes is intentional misdirection.

This is a **fictional, legal CTF challenge**. It does not attack external systems.

## Quick start (local)

```bash
cp .env.example .env
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000)

## Scripts

| Command | Description |
|---------|-------------|
| `npm start` | Production server |
| `npm run dev` | Development with nodemon |
| `npm run smoke` | HTTP smoke tests (server must be running) |

## Environment

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | HTTP listen port |
| `NODE_ENV` | `development` | Set `production` on deploy |
| `FLAG_SECRET` | dev default | Secret for dynamic flag generation |

## Deploy to Railway

1. Push this repo to GitHub.
2. Create a new Railway project → **Deploy from GitHub**.
3. Railway uses the included `Dockerfile` and `railway.json`.
4. Set environment variables:
   - `NODE_ENV=production`
   - `FLAG_SECRET=<long random secret>`
5. Deploy. Health check hits `/health`.

## Routes

| Route | Purpose |
|-------|---------|
| `/` | Game |
| `/health` | Health check |
| `/manual` | Damaged protocol manual |
| `/api/leaderboard` | In-memory solver list |
| `/api/flag` | Bait — no flag |
| `/ws` | Binary WebSocket protocol |

## Leaderboard

Solved handles are stored in memory. **Restarting the server resets the leaderboard.**

## Legal

Authorized CTF/lab use only. Do not deploy against systems you do not own or have permission to test.
