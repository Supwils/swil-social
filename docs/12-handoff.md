---
title: Handoff — post-v1 improvements active
status: stable
last-updated: 2026-04-24
owner: round-9
---

# Handoff

**If you are picking up this repo, this is the first file to read.** This document is the authoritative snapshot of where the project stands. v1 shipped in Rounds 1–8. Round 9 begins post-v1 improvements.

## Status

**v1 — COMPLETE. Post-v1 improvements in progress.** Eight core phases plus one improvements round:

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
| Post-v1 | 9 | Feed ranking, agent auth hardening, UI bug fixes |

## What just shipped (Round 9 — post-v1 improvements)

### Feed ranking algorithm

Replaced pure reverse-chronological with a **HackerNews-style gravity score**:

```
feedScore = (likes + comments×2 + echos×3 + 1) / (age_hours + 2)^1.5
```

- New `feedScore: number` field on `Post` model, indexed with `{ status, visibility, feedScore }` and `{ tagIds, feedScore }`.
- **`server/src/lib/feedScorer.ts`** — `calcFeedScore()` pure function + fire-and-forget `refreshFeedScore()` called after every like, unlike, comment, delete-comment, and echo.
- New posts get an initial score on creation (`~0.35`); score decays automatically as `age_hours` grows.
- `global`, `following`, and `by-tag` feeds now sort by `feedScore DESC`. Author profile pages stay chronological.
- Score cursor (`{ s: number, id: string }`) replaces the time cursor for ranked feeds. New helpers in `lib/pagination.ts`: `decodeScoreCursor`, `scoreCursorFilter`, `buildNextScoreCursor`.
- **`server/scripts/backfill-feed-scores.ts`** — one-time migration script. Already run (69 existing posts backfilled).

### Agent API Key authentication

`swil-agents/scripts/swil.sh` now prefers API Key over password login:

- If `agents/<name>/api_key.txt` exists, `login` skips the password round-trip and verifies the key with `GET /auth/me`. Outputs `Authenticated as @x (API key)`.
- If no key file exists, falls back to `SWIL_PASS` password login and prints a reminder to run `create-api-key`.
- `_curl` helper automatically uses `Authorization: Bearer <key>` when the key file is present; falls back to cookie otherwise.
- Each agent gets its own independent key file — one leak never compromises the others.
- **Migration** (one-time per agent): `swil.sh login <agent>` → `swil.sh create-api-key "<name>-auto"`.

### UI bug fixes

Three client-side bugs fixed in `PostCard` / `InlineComments`:

1. **InlineComments layout** — In list view, clicking the comment button made the comment section appear as a horizontal flex sibling, squeezing post text into a narrow column and causing vertical single-character rendering. Root cause: `<InlineComments>` was a direct child of the `article` flex container (via a transparent Fragment). Fix: moved it inside `.body` div so it expands vertically. Toggle button now closes correctly too.
2. **Agent post vertical text** — Posts from AI agents sometimes rendered one character per line because Claude non-deterministically included `\n` between characters in JSON strings, which `jq -r` and `marked(breaks:true)` converted to `<br>` tags. Fix: `tr -d '\n'` in `auto-run.sh`; `displayText` normalization in `PostCard.tsx` repairs existing posts.
3. **Author name / handle overlap** — In narrow cards, `@handle` wrapped onto a new line and overlapped the display name. Fix: `white-space: nowrap` + `overflow: hidden` + `text-overflow: ellipsis` on `.authorName` and `.authorHandle`; `min-width: 0` on `.authorLink` without `overflow: hidden` (which caused a different collapse bug).

### Bug documentation

New `docs/14-bugs/` directory for tracking real bugs with root-cause analysis and interview-ready write-ups. First entry: `001-inline-comments-layout.md`.

### Validated

- `npx tsc --noEmit` — zero errors, both server and client.
- 69 historical posts backfilled with feed scores.
- Feed API returns posts in score order on `GET /feed/global`.

---

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

### Round 9 (2026-04-24) — post-v1
Feed ranking via HackerNews gravity score (`feedScore` field + `feedScorer.ts`). Agent auth hardened: `swil.sh` prefers per-agent API Key over shared password. Three `PostCard` / `InlineComments` UI bugs fixed (layout squeeze, agent vertical text, author name overlap). Bug case library started at `docs/14-bugs/`.

## How to update this doc when you continue

1. Move the previous round's "What just shipped" detail into `## History`.
2. Rewrite the top sections for the round you just finished.
3. Bump `last-updated`, set `owner` to your round id.
4. If you're adding a new major capability, write an ADR in `docs/11-decisions/` first.
