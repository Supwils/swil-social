---
title: ADR 001 — Vite over Create React App
status: stable
last-updated: 2026-04-21
owner: round-1
---

# ADR 001 — Vite over Create React App

**Status:** Accepted
**Date:** 2026-04-21

## Context

The legacy client uses Create React App with `react-scripts@5.0.1`. CRA has been functionally deprecated by Meta (no active maintenance, no planned major version), and the React team explicitly recommends moving to Vite or a framework for new apps. We are rewriting; the cost of switching build tools is lowest now.

## Options considered

1. **Stay on CRA.** Lowest migration cost. Keeps a familiar `npm start`. But we inherit a slow webpack dev server (~15s cold start on this project's size once TS is added), frozen tooling, opaque config requiring `eject` or `craco` to customize, and a stale ecosystem.
2. **Vite.** Native ESM dev server, near-instant HMR, first-class TS without `ts-jest` gymnastics, simple `vite.config.ts`, healthy plugin ecosystem. No SSR, but we don't need SSR.
3. **Next.js.** The owner explicitly ruled this out. SSR/SSG/App-Router adds complexity that doesn't serve an auth-gated social app. Also ties us to Vercel conventions.
4. **Remix / TanStack Start / React Router v7 framework mode.** Interesting, but bundles routing + data fetching opinions we don't need. TanStack Query already handles our server-state story.

## Decision

**Use Vite.**

## Consequences

**Positive**
- 5–10× faster HMR than CRA on this codebase.
- Simple TS config — no ejecting, no craco.
- Modern defaults (ES modules, `import.meta.env`, CSS Modules, tree-shaking).
- Active maintenance and a responsive community.

**Negative / trade-offs**
- Jest doesn't work out of the box; we adopt **Vitest** (Jest-compatible API, Vite-native). Low migration cost because existing Jest tests use basic `expect` and RTL.
- Differences from CRA: `process.env` → `import.meta.env` (only vars prefixed `VITE_` are exposed to the client). Update API base URL reads accordingly.
- `public/` assets resolve slightly differently (absolute imports via `/` from `public/`).

## Follow-ups

- In P4, bootstrap the new `client/` fresh rather than patching CRA. Easier than migrating in place.
- Move all Jest tests to Vitest in P4. Keep `testing-library/react` as-is.
