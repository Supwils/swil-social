# Swil Social

A self-hostable, quietly designed social web app — built as a personal-portfolio piece, a niche community platform, and a deployable template for anyone who wants to run their own small social space.

![Swil Social demo](./docs/demo/swil-social-1.gif)

---

## Design ethos

_纸本日志 × 侘寂_ — paper-journal meets wabi-sabi. Warm off-white canvas, ink-black type, a single muted accent (tea-brown), and generous whitespace. No bright gradients, no bouncy animations, no dopamine bait. A place to post a thought, not to farm engagement. See [`docs/02-design-system.md`](./docs/02-design-system.md).

## Triple positioning

1. **Personal portfolio** — a well-engineered, opinionated app that demonstrates full-stack craft end-to-end.
2. **Niche community platform** — usable for a small group (friends, hobby circle) who want their own space.
3. **Deployable template** — cleanly factored, documented, and easy to fork/rebrand.

## Tech stack

| Layer | Choice |
|---|---|
| Client | **Vite** + React 18 + TypeScript + Zustand + TanStack Query + CSS Modules |
| Server | **Express** + TypeScript + Zod + Mongoose + Socket.io |
| Database | MongoDB (local ↔ cloud via a single env var) |
| Auth | Session cookies backed by `connect-mongo`; optional Google OAuth |
| Images | Cloudinary (with strict allowlist sanitization client-side) |
| Realtime | Socket.io for notifications + DMs |
| Ops | Docker multi-stage · GitHub Actions CI · optional Sentry |

See [`docs/01-architecture.md`](./docs/01-architecture.md) for rationale, and [`docs/11-decisions/`](./docs/11-decisions/) for ADRs.

## Features

Auth (local + Google OAuth) · posts with images + Markdown · comments with threading · likes on posts and comments · follows · #tags + @mentions (inline linkified and notified) · realtime notifications · direct messages · command palette (⌘K) · draft autosave · light/dark theme · mobile responsive.

---

## Quick start (local dev)

```sh
# Prereqs: Node 20.10+, local MongoDB running

cp server/.env.example server/.env
# edit — set MONGODB_URI and generate SESSION_SECRET
#   node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"

npm install
npm --prefix server install
npm --prefix client install

npm run seed        # optional — 15 users, 50 posts (pw: password123)
npm run dev         # server :7945 + client :5947 concurrently
```

Open `http://localhost:5947`.

## Quick start (Docker)

```sh
cp server/.env.example server/.env     # set SESSION_SECRET + Cloudinary
docker compose up --build
```

One process on `:7945` serves both the API and the built client. Front with Caddy/Nginx for TLS. Full guide: [`docs/08-deployment.md`](./docs/08-deployment.md).

---

## Repo map

```
Full-Stack-Web-Social/
├── client/              # React 18 + TS + Vite + design system
├── server/              # Express + TS backend; /api/v1/* + /socket.io
├── docs/                # Architecture, design, roadmap, decisions, handoff
├── .github/             # CI workflow + Dependabot config
├── Dockerfile           # multi-stage prod image
└── docker-compose.yml   # app + mongo + redis for self-host
```

## Docs

- [`docs/12-handoff.md`](./docs/12-handoff.md) — current state + entry plan for the next round of work
- [`docs/07-setup.md`](./docs/07-setup.md) — local dev walkthrough
- [`docs/08-deployment.md`](./docs/08-deployment.md) — production deploy (Railway / Docker / self-host)
- [`docs/06-security.md`](./docs/06-security.md) — security checklist + rotation runbooks
- [`docs/10-roadmap.md`](./docs/10-roadmap.md) — phase status

## Contributing

- Start at [`docs/12-handoff.md`](./docs/12-handoff.md).
- Then [`docs/10-roadmap.md`](./docs/10-roadmap.md) and the nearest ADRs in [`docs/11-decisions/`](./docs/11-decisions/).
- Commit style + branch conventions in [`docs/09-contributing.md`](./docs/09-contributing.md).

## License

MIT (pending — will land on first public release; see owner action items in `docs/12-handoff.md`).
