---
title: Handoff — post-v1 improvements active
status: stable
last-updated: 2026-04-28
owner: round-10
---

# Handoff

**If you are picking up this repo, this is the first file to read.** This document is the authoritative snapshot of where the project stands. v1 shipped in Rounds 1–8. Rounds 9–10 are post-v1 improvements.

## Status

**v1 — COMPLETE. Post-v1 improvements in progress.**

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
| Post-v1 | 10 | UX features (comment edit/delete, @mention, notification grouping, typing indicator) + global debug scan |

## What just shipped (Round 10 — UX features + debug scan)

### Comment edit / delete UI

`InlineComments` now exposes a 3-dot menu for comment authors:

- **Edit**: inline textarea replaces comment text; Save mutates via `PATCH /comments/:id`; Cancel discards. `(edited)` badge shows `common.edited` i18n key.
- **Delete**: toast with undo-style confirmation (Sonner `toast()` with action button). On confirm, `DELETE /comments/:id`.
- Both mutations update the `commentCount` optimistically across all feed/user caches via `bumpCount(delta)`.

### @mention autocomplete in comments

Reused the existing `useAutocomplete` + `AutocompleteDropdown` from `PostComposer`. The comment compose textarea now:
- Tracks cursor position on every keystroke.
- Triggers user search when the cursor is inside an `@word` token.
- Shows a dropdown; selection replaces the token with `@username `.

### Notifications grouping UI

`notifications.tsx` now groups fine-grained notification entries client-side before rendering:

- `like` and `echo` events targeting the same post/comment are merged into a single row with stacked avatars (up to 3 visible).
- Actor label: "Alice" (1), "Alice and Bob" (2), "Alice and 3 others" (3+) — using new i18n keys `notifications.and` + `notifications.actorsWithOthers`.
- Other types (comment, follow, reply, mention, message) remain ungrouped.

### Typing indicator in DMs

Full end-to-end implementation:

- **Server** (`realtime/io.ts`): `typing` and `typing:end` socket events broadcast to conversation room (excluding sender). No extra membership check needed — room join already validates it.
- **Client API** (`realtime.ts`): `emitTyping(conversationId)` + `emitTypingEnd(conversationId)` helpers added to `RealtimeEvent` union type.
- **UI** (`conversation.tsx`): 2s debounce — emit `typing` on first keystroke, emit `typing:end` after 2s of silence. Cleanup on unmount. Animated 3-dot bounce indicator (`messages.module.css`).

### Global debug scan & cleanup

Ran a full codebase bug scan (see findings inline). One real issue fixed:

- **`server/src/modules/messages/messages.service.ts`**: removed a dead no-op `conversationRoom;` expression with a misleading comment that claimed it "ensured room exists" (it did nothing; the import was also removed).

Most other scan findings were false positives on close inspection (TanStack Query prefix invalidation correctly handles all feed variants; `markReady()` is correctly in `.finally()`; non-null assertion in showcase is guarded by outer `length > 0` check; Socket.IO listeners persist through reconnects by design).

### Dependency maintenance

- Upgraded React 18 → 19 (`react`, `react-dom`, `@types/react`, `@types/react-dom`).
- Applied all safe Dependabot patches (pino 9→10, pino-http 10→11, vitest 2→4, dotenv 16→17, various `@types/*`).
- Added explicit `"mongodb": "^6.20.0"` to `server/package.json` to fix a MODULE_NOT_FOUND crash caused by npm hoisting changes after mongoose upgrade.

### Validated

- `npm run ci:check` — all 8 steps pass (typecheck, lint, test ×2, build ×2). Server: 141 tests. Client: 34 tests.
- No new lint errors introduced.

---

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
- **`docker-compose.yml`** — `app` + `mongo:7` (with healthcheck) + `redis:7-alpine` with named volumes. `app` depends on mongo `service_healthy`. Ports 7945 / 27017 / 6379 exposed for local use.
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

## Repo at end of Round 10

```
swil-social/
├── .github/
│   ├── workflows/ci.yml
│   └── dependabot.yml
├── agent/                             — agent runtime, scripts, per-agent context files
├── client/                            — Vite + React 19 + TS; design system; Markdown; ⌘K
├── server/                            — Express + TS; /api/v1/* + /socket.io; CSP
│   └── src/
│       ├── models/                    — user, post, comment, like, follow, tag,
│       │                                notification, conversation, message,
│       │                                apiKey, bookmark, event
│       ├── modules/                   — auth, users, posts, comments, likes, follows,
│       │                                tags, notifications, messages, feed, bookmarks
│       ├── realtime/io.ts             — Socket.IO: rooms, typing indicator, membership check
│       └── lib/feedScorer.ts          — HackerNews gravity score + batched bulkWrite
├── docs/
│   ├── README.md
│   ├── 00-vision.md
│   ├── 01-architecture.md            UPDATED (React 19, actual routes/models)
│   ├── 02-design-system.md
│   ├── 03-api-reference.md
│   ├── 04-data-model.md              UPDATED (apikeys, bookmarks, events, notification.echo)
│   ├── 05-auth-flow.md               UPDATED (API Key auth section)
│   ├── 06-security.md
│   ├── 07-setup.md
│   ├── 08-deployment.md
│   ├── 09-contributing.md
│   ├── 10-roadmap.md
│   ├── 11-decisions/*.md             ADR 001-003
│   ├── 12-handoff.md                 THIS FILE
│   ├── 13-feature-spec.md
│   ├── 14-bugs/001-inline-comments-layout.md
│   ├── 15-performance-optimizations.md
│   └── 16-interview-prep.md          NEW — comprehensive interview Q&A
├── .dockerignore
├── .gitignore
├── Dockerfile
├── docker-compose.yml
├── README.md
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

### Round 10 (2026-04-28) — post-v1 UX + debug scan
Four UX features: comment edit/delete UI (3-dot menu, inline edit, toast confirm), @mention autocomplete in InlineComments (reused existing hook/component), notification grouping UI (client-side aggregation with stacked avatars + i18n), typing indicator in DMs (Socket.IO room broadcast, 2s debounce, 3-dot animation). React upgraded to v19. Dead code cleanup in `messages.service.ts`. All-green `ci:check` (141 server + 34 client tests). Global debug scan — no critical bugs found, one dead-code line removed.

## How to update this doc when you continue

1. Move the previous round's "What just shipped" detail into `## History`.
2. Rewrite the top sections for the round you just finished.
3. Bump `last-updated`, set `owner` to your round id.
4. If you're adding a new major capability, write an ADR in `docs/11-decisions/` first.
