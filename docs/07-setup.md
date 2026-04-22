---
title: Local Setup
status: stable
last-updated: 2026-04-21
owner: round-5
---

# Local Setup

Goal: clone → running locally in under 10 minutes. If you hit friction, the friction is a bug — please file an issue or update this doc.

> ⚠️ This guide covers **two** setups:
> - **Legacy** (current code, CRA + plain Express) — works today, documented for continuity.
> - **New** (post-refactor, Vite + TS + Zustand) — will replace the legacy instructions in Round 4.

## Prerequisites

| Tool | Version | Install |
|---|---|---|
| Node.js | ≥ 20.10 LTS | `brew install node@20` / [nodejs.org](https://nodejs.org) |
| npm | ≥ 10 | ships with Node |
| MongoDB | ≥ 6.0 | see below |
| Redis | ≥ 7 (**optional**) | `brew install redis` |
| Git | any | `brew install git` |

### MongoDB — local install

```sh
# macOS
brew tap mongodb/brew
brew install mongodb-community
brew services start mongodb-community

# Linux (Ubuntu/Debian)
# Follow the official guide: https://www.mongodb.com/docs/manual/administration/install-on-linux/

# Verify
mongosh --eval 'db.runCommand({ ping: 1 })'
```

Data lives at `/opt/homebrew/var/mongodb` (Apple Silicon) or `/usr/local/var/mongodb` (Intel). The database `swil_social` is created on first write.

### Redis (optional)

The server gracefully degrades without Redis. If you want the caching path exercised:

```sh
brew install redis
brew services start redis
```

## Clone & env

```sh
git clone <repo-url> swil-social
cd swil-social
cp server/.env.example server/.env
```

Open `server/.env` and fill in:

| Var | Example / required |
|---|---|
| `MONGODB_URI` | local: `mongodb://127.0.0.1:27017/swil_social` |
| `SESSION_SECRET` | generate: `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` |
| `GOOGLE_CLIENT_ID` / `_SECRET` | optional — leave blank to disable Google login |
| `CLOUDINARY_*` | optional in dev — uploads will fail until filled |

## Local → cloud Mongo — flip one var

Switching from local Mongo to Atlas (or vice-versa) requires changing **only** `MONGODB_URI`. No code changes, no config forks.

```sh
# Local:
MONGODB_URI=mongodb://127.0.0.1:27017/swil_social

# Atlas:
MONGODB_URI=mongodb+srv://<user>:<pass>@<cluster>/swil_social?retryWrites=true&w=majority

# Docker:
MONGODB_URI=mongodb://mongo:27017/swil_social
```

Indexes are created on server boot via `mongoose.model.syncIndexes()`, so a fresh Atlas cluster is ready after first start.

---

## Run — current (post-Round 4)

Both backend and frontend are TypeScript. The legacy CRA client still exists in `client-legacy/` as a reference and will be deleted in Round 5.

### One-command dev (recommended)

```sh
# From repo root — installs everything and runs both services concurrently.
npm install            # once
npm --prefix server install
npm --prefix client install

npm run dev            # starts server on :8888 AND client on :5173
```

Open `http://localhost:5173`. The Vite dev server proxies `/api/*` and `/auth/google*` to `:8888`.

### Or separately

```sh
# Terminal 1 — backend
cd server && npm run dev   # :8888

# Terminal 2 — frontend
cd client && npm run dev   # :5173
```

What works:
- Registration, login, logout via the legacy flat URLs (adapters translate to new services).
- Viewing/editing profile headline + email.
- Avatar upload (if Cloudinary env vars set).
- `/api/v1/auth/*` and `/api/v1/users/*` on the new API surface.

What works (post-Round 4):
- **Full end-to-end user flows via the new client** on `http://localhost:5173`: register, login, logout, view feed (following + global + by-tag), user profile, post detail with comments, like/unlike, follow/unfollow, edit profile, change password, upload avatar, change theme.
- `/api/v1/*` for all of Posts, Comments, Likes, Follows, Tags, Feed, Users, Auth.
- Legacy flat URLs still served by the server (`client-legacy/` can still run against `:8888` if you want to verify parity).
- Not yet: Notifications, DMs (Round 6). Visual design (Round 5 — current UI is intentionally barebones).

Root scripts (from repo root):
| Command | Purpose |
|---|---|
| `npm run dev` | Start server + client concurrently |
| `npm run install:all` | Install all three sets of deps |
| `npm run typecheck` | Typecheck both packages |
| `npm run build` | Build both packages |
| `npm run seed` | Populate dev DB (delegates to server) |
| `npm run seed:reset` | Drop collections, then seed |

Server scripts (inside `server/`):
| Command | Purpose |
|---|---|
| `npm run dev` | tsx watch — hot reload |
| `npm run build` | TypeScript → `dist/` |
| `npm start` | Run compiled build |
| `npm run typecheck` | Strict TS check |
| `npm run seed` / `seed:reset` | Same as root |

Client scripts (inside `client/`):
| Command | Purpose |
|---|---|
| `npm run dev` | Vite dev server on :5173 |
| `npm run build` | Typecheck then production build to `dist/` |
| `npm run preview` | Serve the prod build locally |
| `npm run typecheck` | Strict TS check |

After seeding, log in with any of: `ada`, `alan`, `grace`, `linus`, `margaret`, `denn`, `kathleen`, `hedy`, `djikstra`, `donald`, `leslie`, `joan`, `seymour`, `barbara`, `claude` — password **`password123`** for all of them.

---

## Run — new stack (from Round 4 onward)

> This section is a **stub**. It will be filled in when Vite migration lands. Expected shape:

```sh
# Install once
npm install

# Dev (runs client + server concurrently)
npm run dev

# Seed dummy data
npm run seed

# Typecheck
npm run typecheck

# Tests
npm test
```

Ports will be 5173 (Vite) and 8888 (API), with the client Vite config proxying `/api` to the server.

---

## Seed data

Once Round 5 lands `scripts/seed.ts`:

```sh
npm run seed           # populate
npm run seed -- --reset  # drop + populate
```

Creates: 15 users (each password `password123`), 50 posts with Unsplash images, ~120 comments, follow graph, a handful of DM conversations. All usernames will be listed on stdout after seeding.

---

## Troubleshooting

### `MongoNetworkError: connect ECONNREFUSED 127.0.0.1:27017`
MongoDB isn't running. `brew services start mongodb-community` (or equivalent).

### `EADDRINUSE :::8888`
Another process holds the port.
```sh
lsof -i :8888   # find the PID
kill <PID>
```

### Login works but refreshing the page logs me out (legacy)
Legacy sessions live in memory. Any server restart drops them. This is fixed in Round 2 when sessions move to Mongo.

### CORS error in browser console
The backend expects requests from `http://localhost:3000` (legacy) or `http://localhost:5173` (new). If you changed ports, update `CORS_ORIGINS` in `server/.env`.

### Images don't upload
Cloudinary env vars not set, or invalid. The server should log a clear message; if it doesn't, file a bug (Round 3 owns improving this).

### `npm install` hangs
Check Node version (`node -v` — must be ≥ 20.10). Delete `node_modules` and `package-lock.json` and retry.
