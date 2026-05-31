---
title: Deployment
status: stable
last-updated: 2026-05-29
owner: round-11
---

# Deployment

How to run Swil Social in production. For local dev see [`07-setup.md`](./07-setup.md); for the
hardening checklist see [`06-security.md`](./06-security.md).

> **Docker is supported but not required, and is not in CI.** The repo ships a `Dockerfile` and
> `docker-compose.yml`, but the realistic deploy paths below run plain Node. The container path is
> kept for documentation and future k8s/ECS, not as the default.

## What the runtime needs

| Dependency | Notes |
|---|---|
| Node.js 20+ | Server (`tsc` build → `dist/`) and client (`vite build` → `client/dist`). |
| MongoDB | Local `mongod` or Atlas — differs only by `MONGODB_URI`. Sessions are stored here via `connect-mongo`. |
| Redis | **Optional today** (graceful fallback). Required once you run >1 server instance — see "Scaling" below. |
| Object storage (S3) | Post images + avatars upload to S3 (`server/src/config/s3.ts`). |

## Build

```bash
npm run install:all
npm run ci:check        # typecheck + lint + test + build, both packages (mirrors GitHub Actions)
```

`ci:check` produces `server/dist` and `client/dist`. In production the Express server serves the
built client from the **same origin** (`server/src/middlewares/staticClient.ts`) with an SPA
fallback and long-lived cache headers on hashed assets — so there is no cross-origin cookie dance.
Start with:

```bash
NODE_ENV=production node server/dist/server.js
```

## Environment

`server/.env.example` is the authoritative list — copy it to `server/.env` and fill in. Core keys:

| Key | Purpose |
|---|---|
| `NODE_ENV` | `production` enables HSTS, secure cookies, trust-proxy, strict CSP, and same-origin client serving. |
| `PORT` | Listen port (default 8899). |
| `MONGODB_URI` | Local `mongod` or Atlas connection string. |
| `SESSION_SECRET` | Signs session cookies — rotate on suspected compromise. |
| `CORS_ORIGINS` | Comma-separated allowlist. With same-origin serving in prod this can be empty/self. |
| `COOKIE_SECURE` / `COOKIE_DOMAIN` | `true` + your domain in prod. |
| `REDIS_URL` | Optional cache; required for multi-instance (see Scaling). |
| `LOG_LEVEL` / `CACHE_TTL` | Pino verbosity / cache TTL. |

Object-storage and any third-party API credentials are listed in `.env.example` too — don't
hardcode them. **Never commit `server/.env`** (gitignored; gitleaks gates it in CI).

## Deploy paths

### A. VPS (Hetzner / DigitalOcean / Vultr) — simplest, cheapest
```bash
git pull
npm run install:all && npm run ci:check
# run the built server under a supervisor:
pm2 start server/dist/server.js --name swil    # or a systemd unit
```
Put Caddy or Nginx in front for TLS (Caddy auto-provisions certs). The Dockerfile documents the
exact runtime if you'd rather write a systemd unit from it.

### B. Railway / Render / Fly.io — managed
Native Node.js detection; no Docker needed (a `Dockerfile` is also accepted if you prefer it).
Set the env vars in the platform's secret manager (they do **not** auto-inherit from
`.env.example`), point a managed Mongo (Atlas) and optional Redis at it, deploy.

### C. Docker / compose — opt-in
```bash
docker compose up        # app + mongo:7 + redis:7-alpine, healthchecked
```
Gotchas if you re-enable a Docker build job in CI: `.npmrc` (legacy-peer-deps) must be COPY'd into
the build context; `.dockerignore` does **not** inherit from `.gitignore` — double-check what's
bundled.

## Smoke check

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://<host>/health   # expect 200
```

`/health` returns build info + a Mongo ping. Then: register → post → comment → open a second tab
and confirm the realtime notification/DM arrives.

## Observability

- **Logging** — Pino structured logs (`LOG_LEVEL`), with redactions.
- **Errors** — Sentry is **scaffolded but env-gated and off by default** (`server/src/lib/monitoring.ts`,
  `client/src/lib/monitoring.ts`). Install `@sentry/node` (+ `@sentry/react`) and set the DSN to
  activate. Turning this on is a tracked pre-launch item (see `10-roadmap.md`).
- **Uptime** — point an external monitor (UptimeRobot etc.) at `/health`.

## Scaling note

Realtime currently assumes a **single server instance**: Socket.IO has no Redis adapter wired, so
a second instance would drop cross-node notifications/DMs/typing. Before scaling horizontally, add
`@socket.io/redis-adapter` (and move sessions/cache to Redis). This is the top item in the roadmap's
"Stretch / not yet started" list.

## Pre-launch owner checklist

See `12-handoff.md` → "Owner action items" for the mandatory items (rotate any leaked secrets,
add a LICENSE, enable monitoring). Run `npm audit` periodically; Dependabot surfaces criticals.
