---
title: Handoff — v1 complete
status: stable
last-updated: 2026-04-22
owner: round-8
---

# Handoff

**If you are picking up this repo, this is the first file to read.** This document is the authoritative snapshot of where the refactor stands. Round 8 closes out the v1 refactor. What comes next is optional scope, not required scope.

## Status

**v1 — COMPLETE.** Eight phases shipped in eight rounds:

| Phase | Round | Focus |
|---|---|---|
| P0 | 1 | Stop the bleeding |
| P1 | 1 | `/docs` foundation |
| P2 | 2 | Backend rewrite — TS, Zod, security hardening, connect-mongo sessions |
| P3 | 3 | Backend modules — posts/comments/likes/follows/tags/feed + seed |
| P4 | 4 | Frontend foundation — Vite + TS + Zustand + TanStack Query |
| P5 | 5 | Design system — tokens, primitives, app shell, all routes styled |
| P6 | 6 | Realtime — Socket.io, notifications, DMs |
| P7 | 7 | Polish — Markdown, ⌘K, draft autosave, edit/delete, write rate limits |
| P8 | 8 | Ops — Docker, CI, deployment playbook, Sentry scaffolding |

Full roadmap with per-phase details: [`docs/10-roadmap.md`](./10-roadmap.md).

## What just shipped (Round 8 — P8)

### Production same-origin serving

- **`server/src/middlewares/staticClient.ts`** — in `NODE_ENV=production` (or when `SERVE_CLIENT=true`), the Express server serves the built client from `client/dist` with an SPA fallback. One origin, no cross-origin cookie dance.
- Static asset caching: hashed `.js`/`.css`/fonts/images get `max-age=31536000 immutable`; `index.html` and everything else is `no-cache`.

### Production hardening

- **Strict CSP via `helmet`** (`app.ts`):
  - `defaultSrc 'self'`
  - `scriptSrc 'self'` in prod (`'unsafe-eval'` only in dev for Vite HMR)
  - `imgSrc` allowlists Cloudinary, Picsum, Dicebear
  - `styleSrc` / `fontSrc` allowlist Google Fonts until self-hosted
  - `connectSrc` allows `ws:/wss:` for Socket.io
  - `objectSrc 'none'`, `frameAncestors 'none'`
- **HSTS** auto-enabled in prod (1 year, includeSubDomains)
- **Trust proxy** + **Secure cookies** gated on `NODE_ENV=production`

### Sentry scaffolding (env-gated)

- **`server/src/lib/monitoring.ts`** — `initMonitoring()` no-ops unless `SENTRY_DSN` is set. Dynamic-imports `@sentry/node` lazily; logs a warning if the DSN is set but the package isn't installed. `captureException` helper wired into `unhandledRejection` + `uncaughtException`.
- **`client/src/lib/monitoring.ts`** — stub with clear turn-key instructions. Intentionally kept out of the build dependency graph so default client has zero monitoring code.
- `SENTRY_DSN` + `SENTRY_TRACES_SAMPLE_RATE` added to server env schema + `.env.example`.

### Docker + compose

- **`Dockerfile`** — 4-stage build: `deps` (install both packages) · `build-server` (tsc) · `build-client` (vite build) · `runtime` (slim Node 20, prod deps only, non-root `app` user, `HEALTHCHECK` hitting `/health`). Layer-caches `package*.json` before source.
- **`docker-compose.yml`** — `app` + `mongo:7` (with healthcheck) + `redis:7-alpine` with named volumes. `app` depends on mongo `service_healthy`. Ports 8888 / 27017 / 6379 exposed for local use.
- **`.dockerignore`** — excludes `node_modules`, `dist`, `.env` (but keeps `.env.example`), `docs`, `client-legacy` (already gone but defensive).

### CI

- **`.github/workflows/ci.yml`** — two jobs:
  - `typecheck` — installs all three `package-lock.json`s (npm cache keyed on all three), typechecks server + client, builds server + client. Node 20. ~3 min.
  - `docker` — builds the production image using Buildx with GHA cache. Runs after typecheck. ~5 min on cold cache, ~1 min warm.
- Concurrency group cancels in-progress runs on new pushes to the same branch.

### Dependabot

- **`.github/dependabot.yml`** — weekly npm updates for root + server + client, monthly for GitHub Actions + Docker. Grouped updates for React / TanStack / Radix / types to keep PR noise down. Conventional-commit prefixes.

### Deployment playbook

- **`docs/08-deployment.md`** — 600+ lines covering:
  - External service setup (Atlas, Cloudinary, Google OAuth)
  - Railway managed deploy (recommended)
  - Self-hosted Docker with Caddy TLS sample
  - First-run + smoke checks (curl scripts)
  - **Backup runbook** (Atlas snapshots + self-hosted `mongodump` cron)
  - **Secret rotation runbook** (SESSION_SECRET, Mongo, OAuth, Cloudinary)
  - **Rollback** (Railway UI / image tag)
  - Production hardening checklist
  - Optional font self-hosting procedure
  - Common issues + fixes

### README

- Rewritten for post-v1 repo — removed "under active refactor" banner, added docker quickstart, link to deployment guide, feature list.

### Validated

- **`npm run typecheck`** both packages clean.
- **`npm run build`** both packages succeed.
- Client bundle:
  - Main chunk gzip **116 KB** (unchanged from R7)
  - CSS gzip 3.3 KB
  - Lazy chunks for each route + PostCard markdown pipeline (56 KB gzip)
- Acceptance grep clean: 0 hex outside tokens, 0 `style={{` in tsx.

### Deferrals from P8 plan

- **Font self-hosting.** Deferred — documented as an optional optimization in `docs/08-deployment.md`. The Google Fonts link still works; self-hosting is a small perf + privacy win to run post-launch.
- **Bundle visualizer run.** Didn't formally run `vite-bundle-visualizer`. PostCard chunk is the largest (marked + DOMPurify). Acceptable for v1.
- **Lighthouse CI gate.** Not wired. Noted as a future addition if this gets real traffic.
- **Sentry installed by default.** Scaffolding only — you run `npm i @sentry/node @sentry/react` when you're ready to enable.

## ⚠️ Owner action items before public release

**These are mandatory before making the repo public or deploying publicly:**

1. **Rotate MongoDB Atlas password** for user `huahaoshang2000` (leaked in git history).
2. **Regenerate the Google OAuth Client Secret** that was hardcoded in the old `index-passport.js`.
3. If the repo will be public, **scrub git history** with `git filter-repo` to remove `server/.env` from past commits (see `docs/06-security.md` "Scrubbing history").

Optional but recommended:

4. **Pick a license and add LICENSE file.** README mentions MIT pending.
5. **Install + configure Sentry** (or your preferred monitoring) for the production deploy.
6. **Run `npm audit`** periodically; Dependabot will surface critical issues automatically.

## How to continue

The `/docs/10-roadmap.md` "Stretch / post-v1 ideas" section lists the catalog of things that could come next. Any one of them is a well-scoped mini-project:

- **Inline @mention autocomplete** in the composer/comment textarea (endpoint `/api/v1/users?search=` already exists).
- **Notifications grouping UI** — `"Ada, Alan, and 3 others liked your post"`.
- **Comment edit/delete UI** surface (API already supports it).
- **Typing indicator** in DMs.
- **Self-hosted fonts** per `docs/08-deployment.md`.
- **ActivityPub federation** (big; would need its own design doc).
- **Scheduled posts.**
- **Reactions beyond like** (`👍 ❤️ 😂 😢 🔥`).
- **Saved/bookmarked posts.**
- **Public read mode** (no login for `visibility=public`).
- **Multi-image carousel.**
- **Email digests** via a worker.

Pick one, write a short ADR explaining the decision, tackle it in a new round. Update this handoff at the end.

## Repo at end of Round 8

```
Full-Stack-Web-Social/
├── .github/
│   ├── workflows/ci.yml              NEW
│   └── dependabot.yml                NEW
├── client/                            — Vite + React 18 + TS; design system; Markdown; ⌘K
├── server/                            — Express + TS; /api/v1/* + /socket.io; CSP
├── docs/
│   ├── README.md
│   ├── 00-vision.md
│   ├── 01-architecture.md
│   ├── 02-design-system.md
│   ├── 03-api-reference.md
│   ├── 04-data-model.md
│   ├── 05-auth-flow.md
│   ├── 06-security.md
│   ├── 07-setup.md
│   ├── 08-deployment.md              EXPANDED
│   ├── 09-contributing.md
│   ├── 10-roadmap.md                 P8 closed
│   ├── 11-decisions/*.md             ADR 001-003
│   └── 12-handoff.md                 THIS FILE — v1 complete
├── .dockerignore                      NEW
├── .gitignore
├── Dockerfile                         NEW
├── docker-compose.yml                 NEW
├── README.md                          UPDATED
└── package.json                       (root workspace orchestration)
```

## Suggested Round 8 commits

```
feat(server): serve built client from same origin in production
feat(server): strict CSP + HSTS + per-user write rate limits
feat(server): optional Sentry scaffolding (@sentry/node, env-gated)
feat(client): client monitoring stub (turn-key Sentry instructions)
build: multi-stage Dockerfile + docker-compose + .dockerignore
build: GitHub Actions CI + Dependabot config
docs: comprehensive deployment playbook (Railway + Docker + runbooks)
docs: close P8; mark v1 complete; rewrite README
```

---

## History

### Round 1 (2026-04-21) — P0 + P1
`.env` secured; root `.gitignore`; `server/.env.example`. Legacy bugs fixed. Root README rewritten. `/docs` tree authored.

### Round 2 (2026-04-21) — P2
Full `server/` rewrite as TypeScript layered architecture. Auth + users + security hardening + OAuth env. 12 legacy JS files removed.

### Round 3 (2026-04-21) — P3
Posts / comments / likes / follows / tags / feed modules + seed. Legacy adapters fleshed out.

### Round 4 (2026-04-21) — P4
Vite + TS client scaffold. API layer, stores, route guards. 9 unstyled placeholder routes.

### Round 5 (2026-04-21) — P5
Design tokens, fonts, primitives, AppShell. 8 routes rewritten. Legacy deleted.

### Round 6 (2026-04-21) — P6
Socket.io + notifications + DM. RealtimeBridge. Sidebar unread dots.

### Round 7 (2026-04-22) — P7
Markdown pipeline (marked + DOMPurify + linkify). `⌘K` palette. Draft autosave. Post edit/delete UI. Per-user write rate limits. Zod on socket events. User-search endpoint.

### Round 8 (2026-04-22) — P8
Prod same-origin serving. Strict CSP + HSTS. Sentry scaffolding. Dockerfile (multi-stage) + compose. GitHub Actions CI. Dependabot. Deployment playbook with backup + rotation runbooks. README rewrite. **v1 complete.**

## How to update this doc when you continue

1. Move the previous round's "What just shipped" detail into `## History`.
2. Rewrite the top sections for the round you just finished.
3. Bump `last-updated`, set `owner` to your round id.
4. If you're adding a new major capability, write an ADR in `docs/11-decisions/` first.
