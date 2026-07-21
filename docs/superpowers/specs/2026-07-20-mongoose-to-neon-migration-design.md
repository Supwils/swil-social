# MongoDB → Neon (Postgres) Migration — Design

- **Date:** 2026-07-20
- **Status:** Approved design, pending implementation plan
- **Scope:** `server/` data layer only. Client, agent runtime, routes, controllers, DTOs, realtime, and auth flow are unchanged.

## 1. Context

`swil-social` currently persists everything in MongoDB via Mongoose (18
collections, ~16 MB logical data / ~10.8k documents at time of writing). The
core domain is a **social graph** (users, posts, comments, likes, follows,
conversations, messages) plus an **agent-observation lab** (personality &
behavior snapshots carrying 1024-dim bge-m3 embeddings, events, benchmark
runs, population metrics).

We are moving to **Postgres on Neon** because:

1. The social graph is inherently relational (JOINs for feeds/followers,
   FK integrity, GROUP BY for leaderboards — the current code hand-rolls these
   as Mongo aggregation pipelines in `feed`, `users`, and `agents` services).
2. `/lab` is fundamentally an analytics product; SQL is the right tool and
   grows more valuable as that data accumulates.
3. Neon gives Vercel-native provisioning, **branching** (instant dev/prod
   isolation), scale-to-zero cost at our stage, and pgvector for embeddings.
4. Migrating embeddings to `pgvector` shrinks the largest tables ~3× (Mongo
   stores a 1024-element double array ≈ 14 KB/doc; `vector(1024)` ≈ 4 KB).

Portability is a stated value: we use a **standard Postgres driver** so the
same code runs against Neon, a Railway/VPS Postgres, or local Docker/pglite
without lock-in.

## 2. Goals / Non-goals

**Goals**
- Replace the Mongoose data layer with Drizzle ORM over Postgres.
- Faithfully migrate **all** existing data (social content **and** the full
  `/lab` snapshot / drift / benchmark history) with zero loss.
- Keep the public API contract (`lib/dto.ts`) and client byte-for-byte
  compatible — including `id` string format.
- Keep the test suite green and coverage thresholds intact.
- Make the cutover reversible.

**Non-goals (this project)**
- No move to serverless / Next.js. Backend stays a persistent Express server
  (target: Railway).
- No change to Socket.IO realtime, S3 image storage, or the auth model
  (session + API key). S3→R2 and WorkOS are separate, later projects.
- No native pgvector ANN search yet (cosine stays in JS; see §5.3).
- No dual-write / zero-downtime machinery (no live users to protect).

## 3. Chosen approach: big-bang, one-shot ETL

We are **pre-launch** — the only data is agent-generated content on the
developer's machine, with no concurrent real-user writes. So:

- Build the Postgres schema + rewrite the data layer on a branch.
- Run a one-shot ETL to copy Mongo → Postgres.
- Validate row counts per table, then switch `DATABASE_URL`.
- **Do not delete the Mongo data.** If anything is wrong, discard the branch
  and we are back on Mongo unchanged.

Rejected alternatives: *clean-slate reseed* (loses the `/lab` history we chose
to keep) and *dual-write/incremental* (over-engineering with no live users).

## 4. Stack & layout

- **ORM:** Drizzle (SQL-first, strong TS inference, native `vector` type).
- **Driver:** `pg` (node-postgres) via `drizzle-orm/node-postgres`, using
  Neon's **pooled** connection string. Standard/portable; full transaction
  support for a persistent server. (If we ever go serverless, swap to
  `@neondatabase/serverless` — schema and queries are unchanged.)
- **Extension:** `pgvector` (enabled on the Neon database).
- **New structure:**
  - `server/src/db/schema/*.ts` — one file per table group; 18 tables.
  - `server/src/db/client.ts` — Drizzle instance + `pg` Pool.
  - `server/src/db/migrations/` — drizzle-kit generated SQL.
- **Removed at cutover:** `mongoose`, `connect-mongo`, `config/db.ts`'s
  mongoose wiring. `mongodb` (the raw driver) is **retained as a
  devDependency** until the ETL is done — the ETL script (§6) reads from
  Mongo — then dropped. **Added:** `drizzle-orm`, `drizzle-kit`, `pg`,
  `connect-pg-simple`, `bson` (id generation only), `pgvector` types.
- Service boundaries (`*.write.ts / *.read.ts / *.hydrate.ts`) are preserved;
  only their query bodies change from Mongoose to Drizzle.

## 5. Key decisions

### 5.1 Primary keys: keep ObjectId hex as `text`
Each collection's `_id` (24-char hex) is stored verbatim in an
`id text primary key` column. Consequences:
- **ETL needs no id remapping** — every foreign-key reference stays valid 1:1.
- **Client compatibility** — the API keeps returning the same 24-char `id`
  strings; the frontend needs no change.
- New rows generate ObjectId-format ids via `bson` (`new
  ObjectId().toHexString()`), so old and new ids are homogeneous.

Performance cost of `text` vs `bigint`/`uuid` PKs is negligible at our scale
and is outweighed by the ETL/compat simplification.

### 5.2 Relationships → real foreign keys
Referenced collections (`likes`, `follows`, `comments`, `bookmarks`,
`messages`, `apikeys`, snapshots, events…) become tables with real FK columns
+ indexes mirroring the current Mongoose indexes. Many-to-many edges (likes,
follows) become join tables with composite uniqueness matching today's unique
indexes.

### 5.3 Embeddings: `vector(1024)`, cosine stays in JS (for now)
- `personalitysnapshots.embedding` and `behaviorsnapshots.embedding` →
  `vector(1024)` (pgvector). ~3× storage reduction.
- `lib/vector.ts` (`cosineSim`, `cosineDist`, `meanPairwiseCosine`,
  variance) is **kept**: we read the vector column back into `number[]` and
  compute in JS exactly as today. bge-m3 vectors are L2-normalized, so this
  stays correct.
- Deferred: native `<=>` ANN + HNSW index. The column type already supports
  it, so adopting it later is additive — no re-migration.

### 5.4 Sessions: `connect-mongo` → `connect-pg-simple`
A single `session` table in the same Postgres, backing express-session
unchanged. Auth logic (session cookie + API-key dual channel in
`middlewares/auth.ts`) is untouched. `config/session.ts` swaps its store.

### 5.5 Aggregations → SQL
The three services using Mongo aggregation pipelines are rewritten to SQL:
- `feed.service` — follower fan-out / timeline assembly → JOIN + ORDER/LIMIT.
- `users.service` — profile counters / relationships → JOIN + COUNT.
- `agents.service` — drift leaderboard / population rollups → GROUP BY + CTEs
  (embeddings fetched and reduced in JS where cosine is involved).

## 6. ETL design
One-shot script (`server/scripts/migrate-mongo-to-pg.ts`):
1. Connect to both the source Mongo and target Postgres.
2. Copy tables in dependency order: `users` → `tags` → `posts` →
   `comments`/`likes`/`follows`/`bookmarks` → `conversations`/`messages` →
   `notifications` → `apikeys` → `personalitysnapshots`/`behaviorsnapshots`/
   `agentevents`/`benchmarkruns`/`populationmetrics`/`events` → `sessions`.
3. Map each document to a row: preserve `id` (hex), all FK refs, timestamps,
   and embeddings (array → `vector`).
4. Batch inserts; wrap each table in a transaction.
5. **Validation:** assert per-table `count(*)` equals the Mongo count; abort
   and roll back on mismatch. Print a reconciliation table.
Idempotent: safe to re-run against a truncated target.

## 7. Testing
- Unit tests run against **pglite** (in-process Postgres, WASM) with the
  vector extension loaded — fast, no external service, works in CI.
- Integration tests that need a full engine run against a real Postgres
  (local Docker or a Neon `dev` branch), gated like today's
  `MONGO_INTEGRATION` flag (renamed `PG_INTEGRATION`).
- `src/test/setup.ts` swaps the `MONGODB_URI` placeholder for `DATABASE_URL`;
  affected mocks/fixtures updated. Coverage thresholds unchanged.
- If pglite's pgvector support proves insufficient for a given test, that
  test falls back to the real-Postgres integration lane.

## 8. Cutover & rollback
- All work on a dedicated git branch.
- Sequence: build schema → rewrite data layer → ETL to local Postgres →
  tests green → create Neon → ETL to Neon `main` → switch `DATABASE_URL`.
- **Rollback:** discard the branch → back on Mongo, data untouched.
- Neon `main` branch = production DB, shared by local dev and the deployed
  backend (satisfies "local + remote same DB"). A `dev` branch is used for
  risky local work.

## 9. What does NOT change
Socket.IO realtime layer; S3 (`config/s3.ts`); routes, controllers, request
validation; DTOs (`lib/dto.ts`) and `client/`; the agent runtime (talks to
the HTTP API, never the DB); the session + API-key auth model.

## 10. Phasing (each phase independently verifiable)
1. Deps + `db/` scaffold + Drizzle schema (18 tables) + generated migration.
2. Rewrite data layer per model/service (TDD), keep tests green.
3. ETL script + local Postgres trial run + count validation.
4. Switch test harness to Postgres; full suite green + coverage.
5. Create Neon (via `vercel install neon`, with explicit user consent) →
   production ETL → switch `DATABASE_URL`.
6. (Follow-on, separate work) Railway backend deploy + Vercel frontend.

## 11. Risks & mitigations
- **Aggregation parity** (feed/users/agents): highest-risk rewrites → cover
  with targeted tests comparing against known-good outputs before cutover.
- **pglite/pgvector gaps in tests:** fall back to real-Postgres integration
  lane for affected tests.
- **Embedding fidelity:** ETL round-trips a sample and asserts
  `cosineSim(before, after) == 1` within float tolerance.
- **Hidden Mongo-isms** (e.g. `mongoose.connection.db` raw use in
  `auth.service.ts:85`): audited and rewritten during Phase 2.

## 12. Open questions (non-blocking)
- Final DB host for production compute (Neon serverless vs Postgres co-located
  on Railway) depends on agent run cadence; decided at deploy time. Does not
  affect this migration — same schema/queries either way.
