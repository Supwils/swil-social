---
title: Architecture
status: stable
last-updated: 2026-04-21
owner: round-1
---

# Architecture

## System diagram

```
          ┌────────────────────────────────┐
          │  Browser (React 18 + TS)       │
          │  Vite build · CSS Modules      │
          │  Zustand (client state)        │
          │  TanStack Query (server cache) │
          │  Socket.io-client              │
          └────────────┬───────────────────┘
                       │ HTTPS (cookie session)
                       │ WebSocket (same origin)
                       ▼
          ┌────────────────────────────────┐
          │  Express API (Node + TS)       │
          │  Routes → Controllers → Services → Repos
          │  Zod validation · Helmet       │
          │  Rate limit · Pino logger      │
          │  Socket.io server              │
          └──┬──────────────┬──────────────┘
             │              │
             ▼              ▼
     ┌──────────────┐  ┌──────────────┐
     │  MongoDB     │  │  Cloudinary  │
     │ (local/cloud)│  │  (images)    │
     │ + connect-mongo (sessions)     │
     └──────────────┘  └──────────────┘
             │
             ▼
     ┌──────────────┐
     │  Redis       │  (optional; graceful fallback)
     │  cache + pubsub for Socket.io scale
     └──────────────┘
```

## Layered structure

### Frontend (`client/`)

```
client/
├── index.html
├── vite.config.ts
├── tsconfig.json
├── src/
│   ├── main.tsx                 # entry
│   ├── App.tsx                  # router shell
│   ├── routes/                  # one file per route, lazy-loaded
│   │   ├── login.tsx
│   │   ├── register.tsx
│   │   ├── feed.tsx
│   │   ├── post.$id.tsx
│   │   ├── user.$username.tsx
│   │   ├── settings.tsx
│   │   ├── messages.tsx
│   │   └── notifications.tsx
│   ├── features/                # feature-first organization
│   │   ├── auth/
│   │   ├── posts/
│   │   ├── comments/
│   │   ├── follows/
│   │   ├── likes/
│   │   ├── tags/
│   │   ├── notifications/
│   │   └── messages/
│   ├── components/              # generic, cross-feature UI
│   │   ├── primitives/          # Button, Input, Avatar, Card, Dialog
│   │   ├── layout/              # AppShell, Sidebar, TopBar
│   │   └── feedback/            # Toast, Skeleton, ErrorState, EmptyState
│   ├── api/                     # axios instance + typed endpoint fns
│   │   ├── client.ts
│   │   ├── auth.api.ts
│   │   ├── posts.api.ts
│   │   └── ...
│   ├── stores/                  # Zustand stores (client-only state)
│   │   ├── session.store.ts
│   │   ├── ui.store.ts          # theme, cmdk open, etc.
│   │   └── draft.store.ts
│   ├── hooks/                   # reusable hooks
│   ├── lib/                     # pure helpers (date, markdown, etc.)
│   ├── styles/
│   │   ├── tokens.css           # design tokens as CSS vars
│   │   ├── reset.css
│   │   └── global.css
│   └── types/                   # shared TS types (mirrors API contracts)
```

Feature-first over type-first. Each feature folder contains its components, hooks, and local queries; cross-feature stuff goes to `components/` or `lib/`.

### Backend (`server/`)

```
server/
├── tsconfig.json
├── src/
│   ├── server.ts                # listen + graceful shutdown
│   ├── app.ts                   # compose express + middleware + routes
│   ├── config/
│   │   ├── env.ts               # Zod-validated env loader
│   │   ├── db.ts                # Mongo connection (single)
│   │   ├── redis.ts             # optional
│   │   ├── cloudinary.ts
│   │   └── session.ts
│   ├── middlewares/
│   │   ├── auth.ts              # requireUser / optionalUser
│   │   ├── validate.ts          # Zod → 400 with field errors
│   │   ├── rateLimit.ts
│   │   ├── errorHandler.ts
│   │   └── requestLogger.ts
│   ├── modules/                 # feature modules (self-contained)
│   │   ├── auth/
│   │   │   ├── auth.routes.ts
│   │   │   ├── auth.controller.ts
│   │   │   ├── auth.service.ts
│   │   │   └── auth.schemas.ts
│   │   ├── users/
│   │   ├── posts/
│   │   ├── comments/
│   │   ├── likes/
│   │   ├── follows/
│   │   ├── tags/
│   │   ├── notifications/
│   │   └── messages/
│   ├── models/                  # Mongoose schemas (thin)
│   ├── realtime/
│   │   ├── io.ts                # Socket.io server init
│   │   └── handlers/
│   ├── lib/                     # errors, logger, pagination, helpers
│   └── types/                   # shared types
├── scripts/
│   ├── seed.ts                  # dummy data with unsplash images
│   └── reset-db.ts
```

Route → controller → service → model. Each layer has a single responsibility:

- **Route** — HTTP plumbing: path, verb, middleware chain, delegate to controller.
- **Controller** — parse/validate input, call service, shape HTTP response.
- **Service** — business logic. Pure-ish. No req/res.
- **Model** — Mongoose schema + query helpers.

## Tech choices & rationale

### Vite over CRA
CRA is deprecated upstream. Vite gives ~10x faster cold start, near-instant HMR, first-class TS, and a simpler config surface. See [`11-decisions/001-vite-over-cra.md`](./11-decisions/001-vite-over-cra.md).

### Zustand + TanStack Query over Redux
Most of what Redux is used for in apps this size is actually server-state (fetched data). TanStack Query handles that natively with caching, dedup, optimistic updates, and background refetch. Zustand handles the remaining bit (session, theme, UI flags) with zero boilerplate. See [`11-decisions/002-zustand-over-redux.md`](./11-decisions/002-zustand-over-redux.md).

### MongoDB (not PostgreSQL)
The data is social-graph shaped: small structured documents, frequent schema evolution as we add features like tags and reactions. Mongoose is mature, developer velocity is higher, and the target scale (~10k users per instance) is well within MongoDB's comfort zone. Local `mongod` and cloud Atlas differ only in one env var. See [`11-decisions/003-stay-nosql.md`](./11-decisions/003-stay-nosql.md).

### Session cookies over JWT
JWTs are great for stateless microservices; they're overkill and harder to invalidate for a monolith like this. HttpOnly, SameSite=Lax, Secure cookies backed by `connect-mongo` give us revocation for free and a simpler threat model.

### CSS Modules over Tailwind or styled-components
Tailwind fights the "quiet, restrained" aesthetic — utility soup makes every element look opinionated. styled-components has runtime cost and harder SSR stories. CSS Modules are scoped by default, compile to static CSS, and we already have designers on the team who know CSS. Design tokens live in a root `tokens.css`.

### Socket.io over raw WebSocket
Auto-reconnect, rooms, fallbacks, and typed events with a minimal learning curve. Scale past one node is easy (Redis adapter).

### TypeScript everywhere
Non-negotiable at refactor time — after the rewrite, adding TS is expensive. Shared types between frontend and backend live in `packages/shared` if we adopt a monorepo, or by duplicating request/response types generated from Zod schemas. Round 2 decides.

## Environments

One codebase, three environments, switched entirely by env vars.

| | Local dev | Cloud dev | Prod |
|---|---|---|---|
| `NODE_ENV` | development | development | production |
| `MONGODB_URI` | `mongodb://127.0.0.1:27017/swil_social` | Atlas cluster | Atlas cluster |
| `REDIS_URL` | `redis://127.0.0.1:6379` (optional) | Upstash/managed | managed |
| `CORS_ORIGINS` | `http://localhost:5173` | dev frontend URL | prod frontend URL |
| `COOKIE_SECURE` | false | true | true |

No conditional logic reads `NODE_ENV` to change behavior beyond log verbosity and error detail. Everything else is a config value.

## Data flow examples

### Posting a new post

```
User clicks "Post"
 → client/features/posts/CreatePost.tsx
 → useMutation(postsApi.create) in TanStack Query
 → POST /api/v1/posts  { text, tags?, image? (multipart) }
 → middlewares: auth → validate(createPostSchema) → rateLimit
 → posts.controller.create
 → posts.service.create(userId, input)   // inserts Post, inserts Tags, resolves @mentions, emits notifications via realtime
 → returns Post DTO
 → Query invalidates feed + user posts caches
 → Optimistic UI: new post prepended before response
```

### Receiving a notification

```
Someone likes your post
 → likes.service.like() inserts Like + inserts Notification doc
 → io.to(`user:${ownerId}`).emit('notification', payload)
 → client useSocketSubscription adds to notificationsStore
 → Unread badge (subtle) appears; toast if user enabled
```

## Out-of-scope (for now)

- GraphQL. REST is sufficient and matches the team's instincts.
- Server-side rendering. The app is auth-gated; SEO isn't a goal.
- Monorepo (Turborepo/Nx). Revisit if the shared-types duplication becomes painful.
- Event sourcing, CQRS, microservices. All overkill.
