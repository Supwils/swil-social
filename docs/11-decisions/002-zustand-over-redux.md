---
title: ADR 002 — Zustand + TanStack Query over Redux Toolkit
status: stable
last-updated: 2026-04-21
owner: round-1
---

# ADR 002 — Zustand + TanStack Query over Redux Toolkit

**Status:** Accepted
**Date:** 2026-04-21

## Context

We need to manage two categories of state in the client:

1. **Server state** — fetched from the API, cacheable, needs dedup, staleness, background refresh, optimistic updates. Examples: posts, comments, notifications, the current user.
2. **Client state** — purely browser-side. Examples: theme, whether the command palette is open, draft text for a post in progress.

These two categories have **different requirements**. Conflating them in one store, which is what happens when people reach for Redux-for-everything, creates the kind of "where does this belong?" friction that slows teams down.

## Options considered

1. **Redux Toolkit + RTK Query.** Single unified story. But heavy: reducers, slices, providers, store setup. Overkill for a solo/small-team social app.
2. **React Context + useReducer.** Free. But re-renders poorly as state tree grows; no caching for server state; you end up rebuilding TanStack Query badly.
3. **Zustand** for client state + **TanStack Query** for server state. Two small, focused libraries, each doing one thing well.
4. **Jotai** or **Valtio** for client state. Atomic/proxy-based — elegant but team unfamiliarity + atomic thinking doesn't map as cleanly to this app's simple global flags.

## Decision

**Use Zustand for client state. Use TanStack Query for server state.**

## Consequences

**Positive**
- Zustand: `<50 LOC` per store. No providers. Type-safe, simple subscribe/select. Great DX.
- TanStack Query: cache, dedup, retries, stale-while-revalidate, optimistic updates, infinite queries, devtools — all free. Invalidation by query key is trivially composable.
- Clear ownership rule: **if it came from the server, it lives in a query; otherwise it lives in a Zustand store.** No judgment calls.

**Negative / trade-offs**
- Two libraries to learn instead of one. But each is smaller than Redux alone.
- No time-travel devtools (Zustand has a middleware but not as polished as Redux DevTools). We've never needed this on projects this size.
- Shared state between a Zustand store and a Query (e.g., optimistic username change) needs small helpers — documented in-repo when it comes up.

## Follow-ups

- In P4, set up:
  - `stores/session.store.ts` — logged-in user id + username cached from `/auth/me` (TQ owns the canonical user object; store holds the minimal id for routing decisions).
  - `stores/ui.store.ts` — theme, cmdk open, sidebar collapsed.
  - `stores/draft.store.ts` — persist-to-localStorage middleware.
- Establish a query key convention in `src/api/queryKeys.ts` to prevent drift.
