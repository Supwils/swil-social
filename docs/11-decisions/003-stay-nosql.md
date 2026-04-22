---
title: ADR 003 — Stay on MongoDB with local/cloud parity
status: stable
last-updated: 2026-04-21
owner: round-1
---

# ADR 003 — Stay on MongoDB with local/cloud parity

**Status:** Accepted
**Date:** 2026-04-21

## Context

The legacy code uses MongoDB via Mongoose. We evaluated whether the refactor is a good time to switch to PostgreSQL, which has well-known advantages for relational data (follow graphs, joins for feeds, integrity constraints). The owner's preference is to stay NoSQL if feasible.

## Options considered

1. **Keep MongoDB.** Familiar ecosystem. Mongoose is mature. Schema flexibility matches iterative product development (adding `likes`, `tags`, `reactions` over time without migrations). Native document model fits user profiles and posts well.
2. **Switch to PostgreSQL + Prisma.** Strong relational story (follows, feed joins are natural). Schema migrations forced (good discipline). But: every schema change is a migration, which slows early feature work; denormalization we'd want for perf (counters) reintroduces integrity risk; local dev requires Postgres setup which is slightly heavier than Mongo.
3. **SQLite for local + Postgres for prod.** Great local ergonomics but a hidden cost: ORM quirks differ enough between engines that you end up testing on two dialects.

## Decision

**Stay on MongoDB.** Both local (via `mongod`) and cloud (via Atlas) are first-class; switching between them is one env var. See `07-setup.md` and `04-data-model.md`.

Target scale (~10k users per instance) is comfortably within MongoDB's sweet spot. Feed generation at this scale is solvable with an index on `{ authorId: 1, createdAt: -1 }` plus a `$in` on followed users — no joins required, no performance cliff.

## Consequences

**Positive**
- Zero friction between local and cloud deploys.
- Fast schema evolution; new optional fields cost nothing.
- Mongoose's ecosystem (validators, middleware, virtuals, populate) is well-understood.
- Session store (`connect-mongo`) uses the same connection — one backing store.

**Negative / trade-offs**
- No referential integrity. If we delete a user, we must soft-delete their posts/comments in the service layer; Mongo won't enforce cascades. This is documented in `04-data-model.md` "Soft delete policy."
- Denormalized counters (`likeCount`, `followerCount`) require discipline: always `$inc` in services; reconcile job for drift.
- Ad-hoc analytical queries are harder. Acceptable — we don't ship an analytics tab.

## Local/cloud parity contract

This is the rule: **the only thing that differs between a local `mongod` and a cloud Atlas cluster is the `MONGODB_URI` env var.** If we find ourselves reaching for features that only exist on Atlas (like full-text search or `$search`), we document it as an ADR and decide explicitly whether to adopt the dependency. Until then, both environments must pass the same test suite.

## Follow-ups

- P2 lands the single `config/db.ts` that honors this contract.
- Seed script must work identically against both; CI runs it against a local mongo container.
- If we ever adopt Atlas-only features (`$search`, triggers), add an ADR and a local-dev fallback (e.g., a simple text index for local).
