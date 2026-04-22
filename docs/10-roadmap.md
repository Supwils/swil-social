---
title: Roadmap
status: stable
last-updated: 2026-04-22
owner: round-8
---

# Roadmap

Phases are linear but not rigid — each phase should leave the app in a working state. When work starts on a phase, mark it **In Progress**; when it's done and `12-handoff.md` reflects it, mark **Shipped**.

## Legend

- ✅ **Shipped** — in main and working.
- 🟡 **In Progress** — a round is actively working on it.
- ⚪ **Planned** — not started.

## Status

| Phase | Focus | Status |
|---|---|---|
| P0 | Stop the bleeding | ✅ Shipped (Round 1) |
| P1 | `/docs` foundation | ✅ Shipped (Round 1) |
| P2 | Backend rewrite — skeleton, TS, Zod, security | ✅ Shipped (Round 2) |
| P3 | Backend rewrite — modules (posts/comments/likes/follows/tags/feed) + seed | ✅ Shipped (Round 3) |
| P4 | Frontend foundation — Vite, TS, API layer, stores, routing | ✅ Shipped (Round 4) |
| P5 | Design system + page rewrites — login/feed/profile | ✅ Shipped (Round 5) |
| P6 | Realtime — notifications + DM | ✅ Shipped (Round 6) |
| P7 | Polish — markdown, cmdk, drafts, edit/delete, write limits | ✅ Shipped (Round 7) |
| P8 | Ops — Docker, CI, Sentry, deployment docs | ✅ Shipped (Round 8) · **v1 complete** |

---

## P0 — Stop the bleeding ✅

Emergency fixes before any real work.

**Acceptance**
- `server/.env` untracked from git; `.env.example` in place.
- Root `.gitignore` comprehensive.
- Legacy bugs fixed: `/articless` typo, missing `await` in `mainFeed.jsx`.
- README rewritten to reflect actual stack.
- Owner notified to rotate leaked secrets.

## P1 — `/docs` foundation ✅

Docs that let any contributor or agent pick up the project.

**Acceptance**
- `/docs` directory with 00–12 files and a navigation index.
- Vision, architecture, design system, data model, API reference, auth flow, security, setup, roadmap, handoff — all authoritative.
- Initial ADRs for the three big decisions (Vite, Zustand, NoSQL).

---

## P2 — Backend skeleton ✅

Rebuild `server/` as a TypeScript Express app with the layered structure from `01-architecture.md`. No new features yet — port existing endpoints to the new structure, then add validation, security middleware, and persistent sessions.

**Deliverables**
- `server/tsconfig.json`, switch entry to `src/server.ts`.
- `src/config/env.ts` — Zod-validated env loader, fails fast with useful errors.
- `src/app.ts` — compose middleware: helmet, cors (allowlist via env), pino-http, mongo-sanitize, rate-limit global, cookie-parser, express-session with connect-mongo, passport.
- `src/middlewares/` — auth (requireUser/optionalUser), validate (generic Zod), errorHandler (envelope format), requestLogger.
- `src/lib/errors.ts` — `AppError(code, status, message, fields?)`.
- `src/lib/logger.ts` — pino with redactions.
- `src/modules/auth/` — register, login, logout, me, password change. bcrypt cost 12. Session regenerate on login. Rate-limited per spec.
- `src/modules/users/` — profile GET and PATCH /users/me with Zod.
- Mongoose connection once, in `config/db.ts`, with `syncIndexes()` on boot.
- Google OAuth creds moved to env.
- `/health` endpoint returns build info + mongo ping.
- `npm run typecheck` clean.

**Acceptance**
- Legacy frontend still works against the new backend for register/login/profile read.
- Bcrypt cost 12 verified by reading a hash.
- Rate limit verified with a script hitting /auth/login 10 times → 429 after 5.
- No secrets in source.
- Pino logs include `requestId`.

## P3 — Backend modules + seed ✅

Complete the backend surface so the frontend rebuild has a stable target.

**Deliverables**
- `posts` module — CRUD, visibility, tag + mention extraction.
- `comments` module — flat storage with `parentId`, soft-delete.
- `likes` module — polymorphic (post/comment), idempotent endpoints.
- `follows` module — edges, lists, counters.
- `tags` module — trending, by-slug.
- `feed` endpoints — following, global, by-tag.
- Denormalized counters via `$inc`, updated in services.
- Cursor pagination on all list endpoints.
- `scripts/seed.ts` — 15 users, 50 posts, comments, likes, follows, DMs. Unsplash-sourced images. Idempotent with `--reset`.
- OpenAPI schema generated from Zod (stretch).

**Acceptance**
- All endpoints in `03-api-reference.md` sections Posts, Comments, Follows, Likes, Tags, Feed return correct shape.
- Seeded DB produces a usable dev experience.
- Each service method has ≥ 1 unit test (vitest).

## P4 — Frontend foundation ✅

Swap CRA for Vite and put the plumbing in place for feature work.

**Deliverables**
- New `client/` with `vite`, `typescript`, `react`, `react-router-dom`, `zustand`, `@tanstack/react-query`, `axios`, `zod`.
- `vite.config.ts` with `/api` proxy to server.
- `client/src/api/client.ts` — axios instance + interceptors (401 → session store clear → redirect).
- Typed API modules (`auth.api.ts`, `posts.api.ts`, ...) mirroring `03-api-reference.md`.
- Zustand stores: `session`, `ui` (theme), `draft`.
- TanStack Query provider + devtools in dev.
- Error boundary at root; Sonner toast provider.
- Skeleton, EmptyState, ErrorState primitives.
- Lazy-loaded routes.
- `ProtectedRoute` / `PublicRoute` HOCs.

**Acceptance**
- `/auth/me` called on boot; authed user lands on feed, anon on login.
- 401 from any API call clears session and redirects.
- `npm run dev` starts both server and client concurrently.
- `npm run typecheck` clean.

## P5 — Design system + core pages ✅

Implement the visual language from `02-design-system.md` and rewrite the three core pages.

**Deliverables**
- `src/styles/tokens.css`, `reset.css`, `global.css`.
- Primitives: Button, Input, Textarea, Card, Avatar, Dialog, Popover, Toast, Skeleton, Tag, EmptyState.
- Fonts (Cormorant Garamond, Inter, JetBrains Mono) self-hosted.
- Phosphor icons integrated.
- Routes rewritten: Login/Register, Feed (with composer, post list, like button, comments preview), User profile, Settings.
- Post composer with image upload, tag chips, mention autocomplete stub.
- Responsive mobile (≤ 720px) done.

**Acceptance**
- Accessibility: every page passes axe with zero critical violations.
- Dark mode toggle works and persists.
- All CSS values come from tokens; grep for raw hex returns zero hits in components.

## P6 — Realtime: notifications + DM ⚪

**Deliverables**
- `server/src/realtime/io.ts` with session-cookie handshake and room helpers.
- `notifications` module — inbox endpoints + Socket.io events; 24h dedup rule.
- `messages`/`conversations` modules — find-or-create, paginated, read receipts.
- Frontend: notifications dropdown + page, DM route with conversation list and thread view.
- Typing indicator (optional, stretch).

**Acceptance**
- Liking a post creates a notification for the author; author's other open tab receives it via socket.
- DM round-trip < 200ms on localhost.
- Unread counts accurate across sessions.

## P7 — Polish ⚪

**Deliverables**
- Markdown rendering with DOMPurify (client).
- Draft autosave to `localStorage` via the `draft` store.
- Command palette (`⌘K`) — navigate, post, new message.
- Empty states and skeletons everywhere.
- i18n scaffold (English + Simplified Chinese strings).
- Full a11y pass.
- `npm run analyze` bundle report; trim deps.

**Acceptance**
- Lighthouse ≥ 90 on Performance, Accessibility, Best Practices.
- Bundle gzip < 250KB initial route.

## P8 — Ops ⚪

**Deliverables**
- `Dockerfile` + `docker-compose.yml` (app + mongo + redis).
- GitHub Actions: typecheck, test, build, lint on PR.
- Sentry (or equivalent) integration, both ends.
- `08-deployment.md` with a concrete playbook (Railway or Render recommended).
- Backup and monitoring notes.

**Acceptance**
- `docker compose up` yields a fully working app on a fresh machine.
- A tagged release can be deployed by following only `08-deployment.md`.

---

## Stretch / post-v1 ideas

Kept here so they're not lost, not committed to:

- ActivityPub federation.
- Scheduled posts.
- Post reactions beyond like (`👍 ❤️ 😂 😢 🔥`).
- Saved/bookmarked posts.
- Public read mode (no login required for `visibility=public`).
- Email digests.
- Native mobile wrappers (Capacitor?).
- Plugin/hook system for self-hosters.
- Multi-image carousel with captions per image.
- Quoted reposts.
