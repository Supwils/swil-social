# Mongoose → Neon (Postgres) Migration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Mongoose/MongoDB data layer in `server/` with Drizzle ORM over Postgres (Neon in prod), preserving all data and the public API contract.

**Architecture:** Big-bang cutover on a branch. Build Drizzle schema mirroring the 17 Mongoose models (+ session table), rewrite each service's queries, migrate data with a one-shot ETL, swap the test harness to Postgres, then (deferred, with user consent) create Neon and cut over. ObjectId hex is preserved as `text` PKs so foreign keys and client `id` strings are unchanged. Embeddings become `vector(1024)` (pgvector); cosine stays in JS.

**Tech Stack:** Drizzle ORM, `pg` (node-postgres), drizzle-kit, pgvector, connect-pg-simple, pglite (tests), bson (id gen), Vitest.

## Global Constraints

- TypeScript strict; no `any` (lint error). Prettier: single quotes, trailing commas, 100-char width.
- Tests live next to source (`foo.ts` + `foo.test.ts`). Coverage thresholds must not drop.
- Shared DTOs in `server/src/lib/dto.ts` must stay byte-compatible with `client/src/api/types.ts` — the migration must NOT change any DTO shape or `id` string format.
- Never `git commit`/`push` unless the user says "commit push". This plan's commit steps are **staged locally only** — run `git add` + prepare the message, but do the actual commit only on user instruction. (Deviation from default TDD "commit each step" to honor project policy.)
- `npm run ci:check` must pass before declaring the migration done.
- Local dev Postgres: `postgresql://supwils@127.0.0.1:5432/swil_social_pg` (created in Phase 0). Prod: Neon (Phase 6).
- Preserve every Mongoose index as a Postgres index/constraint.

## File Structure

**New files:**
- `server/drizzle.config.ts` — drizzle-kit config (schema dir, out dir, dialect, dbCredentials).
- `server/src/db/client.ts` — `pg` Pool + Drizzle instance (`db`), `connectDb`/`disconnectDb`/`pingDb`.
- `server/src/db/schema/index.ts` — re-exports all table modules.
- `server/src/db/schema/{users,social,messaging,notifications,tags,agents,lab,auth,session}.ts` — grouped table definitions.
- `server/src/db/vector.ts` — Drizzle custom `vector` column helper (thin wrapper if drizzle's native type needs config).
- `server/src/db/migrations/*` — drizzle-kit generated SQL.
- `server/src/lib/id.ts` — `newId()` → ObjectId-format hex via `bson`.
- `server/scripts/migrate-mongo-to-pg.ts` — one-shot ETL.
- `server/src/test/pg.ts` — pglite/Postgres test harness (spin up, migrate, truncate-between-tests).

**Modified files:**
- `server/src/config/env.ts` — `MONGODB_URI` → `DATABASE_URL` (+ keep `MONGO_URL_SOURCE` optional for ETL).
- `server/src/config/db.ts` — delete mongoose wiring, re-export from `db/client.ts`.
- `server/src/config/session.ts` — `connect-mongo` → `connect-pg-simple`.
- `server/src/server.ts` — model-registration imports removed; `syncAllIndexes` → drizzle migrate.
- All `server/src/models/*.model.ts` — **deleted** after their table + queries land.
- `server/src/modules/**/{*.service,*.write,*.read,*.hydrate}.ts` — queries rewritten to Drizzle.
- `server/src/test/setup.ts` — env placeholder swap.
- `server/package.json` — deps swap; add `db:generate`/`db:migrate`/`db:studio`/`etl` scripts.

---

## Phase 0 — Environment & dependencies

### Task 0.1: Install pgvector + create dev database

**Files:** none (environment).

- [ ] **Step 1:** Install pgvector for the local brew Postgres 16.
  Run: `brew install pgvector`
  Expected: formula installs; `.so`/`.control` land under the `postgresql@16` lib/share dirs.
- [ ] **Step 2:** Create the dev database.
  Run: `psql -h 127.0.0.1 -p 5432 -d postgres -c "CREATE DATABASE swil_social_pg;"`
  Expected: `CREATE DATABASE`.
- [ ] **Step 3:** Verify the extension is now available and installable.
  Run: `psql -h 127.0.0.1 -p 5432 -d swil_social_pg -c "CREATE EXTENSION IF NOT EXISTS vector; SELECT extversion FROM pg_extension WHERE extname='vector';"`
  Expected: a version string (e.g. `0.7.x`).

### Task 0.2: Swap dependencies

**Files:** Modify `server/package.json`.

- [ ] **Step 1:** Add deps.
  Run: `npm --prefix server install drizzle-orm pg connect-pg-simple bson pgvector` and `npm --prefix server install -D drizzle-kit @electric-sql/pglite @types/pg`
  Expected: installs clean (`.npmrc` legacy-peer-deps honored).
- [ ] **Step 2:** Keep `mongodb` (raw driver) for the ETL; remove `mongoose` + `connect-mongo` only AFTER Phase 4. Add npm scripts:
  ```json
  "db:generate": "drizzle-kit generate",
  "db:migrate": "tsx src/db/migrate.ts",
  "db:studio": "drizzle-kit studio",
  "etl": "tsx scripts/migrate-mongo-to-pg.ts"
  ```
- [ ] **Step 3:** Verify typecheck still passes (nothing wired yet).
  Run: `npm --prefix server run typecheck`
  Expected: PASS.
- [ ] **Step 4:** Stage (do not commit): `git add server/package.json server/package-lock.json`.

---

## Phase 1 — Drizzle scaffold

### Task 1.1: Env + drizzle config + client

**Files:** Create `server/drizzle.config.ts`, `server/src/db/client.ts`, `server/src/db/vector.ts`; Modify `server/src/config/env.ts`.

**Interfaces produced:**
- `db` — Drizzle instance (`NodePgDatabase<typeof schema>`).
- `connectDb(): Promise<void>`, `disconnectDb(): Promise<void>`, `pingDb(): Promise<boolean>`.
- `env.DATABASE_URL: string`.

- [ ] **Step 1:** In `env.ts`, replace `MONGODB_URI` with `DATABASE_URL: z.string().min(1)` and add optional `MONGO_SOURCE_URI: z.string().optional()` (used only by ETL).
- [ ] **Step 2:** Write `server/src/db/client.ts`:
  ```ts
  import { Pool } from 'pg';
  import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
  import * as schema from './schema';
  import { env } from '../config/env';
  import { logger } from '../lib/logger';

  const pool = new Pool({ connectionString: env.DATABASE_URL, max: 10 });
  export const db: NodePgDatabase<typeof schema> = drizzle(pool, { schema });

  export async function connectDb(): Promise<void> {
    await pool.query('select 1');
    logger.info('postgres connected');
  }
  export async function disconnectDb(): Promise<void> { await pool.end(); }
  export async function pingDb(): Promise<boolean> {
    try { await pool.query('select 1'); return true; } catch { return false; }
  }
  ```
- [ ] **Step 3:** Write `drizzle.config.ts`:
  ```ts
  import { defineConfig } from 'drizzle-kit';
  export default defineConfig({
    schema: './src/db/schema/index.ts',
    out: './src/db/migrations',
    dialect: 'postgresql',
    dbCredentials: { url: process.env.DATABASE_URL! },
  });
  ```
- [ ] **Step 4:** `server/src/db/vector.ts` — export a helper if needed; drizzle-orm ships `vector` in `drizzle-orm/pg-core`. Confirm import works:
  ```ts
  export { vector } from 'drizzle-orm/pg-core';
  ```
- [ ] **Step 5:** Verify: `npm --prefix server run typecheck` (schema/index.ts is still empty stub — create `server/src/db/schema/index.ts` exporting `{}` for now). Expected PASS.
- [ ] **Step 6:** Stage.

---

## Phase 2 — Schema (17 tables + session)

Each task defines a schema module, mirroring the exact fields, types, defaults, and **indexes** from the corresponding `*.model.ts`. Rule of thumb per column: Mongo `String`→`text`, `Number`→`integer`/`doublePrecision` (match usage), `Boolean`→`boolean`, `Date`→`timestamp with time zone`, `ObjectId`→`text` (FK), `[Number]` embedding→`vector(1024)`, arrays→`text[]`/`jsonb`, subdocuments→`jsonb`. Every `_id` → `id text primary key`. `timestamps: true` → `created_at`/`updated_at timestamptz default now()`.

**Read the source model before writing each table** (`server/src/models/<name>.model.ts`) and reproduce its indexes.

### Task 2.1: `schema/users.ts` — users, apikeys
- [ ] Define `users` (mirror `user.model.ts:137` — username unique, displayName, headline, bio, followTopics `text[]`, isAgent, aiBackend, passwordHash, timestamps + indexes) and `apiKeys` (mirror `apiKey.model.ts` — userId FK, name, keyHash unique, lastUsedAt).
- [ ] Verify `drizzle-kit generate` produces SQL; apply to dev DB with `db:migrate`; `psql \d users` shows expected columns/indexes.
- [ ] Stage.

### Task 2.2: `schema/social.ts` — posts, comments, likes, follows, bookmarks
- [ ] Mirror `post.model.ts` (author FK, body, images `jsonb`, tags `text[]`, counters, echo/repost refs), `comment.model.ts`, `like.model.ts` (unique (user,post)), `follow.model.ts` (unique (follower,following)), `bookmark.model.ts`. Reproduce all compound/unique indexes.
- [ ] Verify generate + migrate + `\d`.
- [ ] Stage.

### Task 2.3: `schema/messaging.ts` — conversations, messages
- [ ] Mirror `conversation.model.ts`, `message.model.ts` (conversation FK, sender FK, body, readBy). Indexes.
- [ ] Verify; stage.

### Task 2.4: `schema/notifications.ts` + `schema/tags.ts` — notifications, tags
- [ ] Mirror `notification.model.ts` (recipient FK, type, actor, entity refs, read), `tag.model.ts` (name unique, counts).
- [ ] Verify; stage.

### Task 2.5: `schema/lab.ts` — personalitysnapshots, behaviorsnapshots, agentevents, benchmarkruns, populationmetrics, events
- [ ] Mirror the six lab models. `embedding vector(1024)` on personality/behavior snapshots. Preserve `driftFromAnchor`/`driftFromPrev`/aspect sims, `contentHash` (dedupe unique), snapshotType, timestamps, event payloads (`jsonb`). Reproduce indexes (esp. contentHash unique used for dedupe).
- [ ] Verify; stage.

### Task 2.6: `schema/session.ts` + `schema/index.ts`
- [ ] Define the `session` table matching `connect-pg-simple`'s expected DDL (`sid varchar pk`, `sess json`, `expire timestamptz` + index on expire).
- [ ] `schema/index.ts` re-exports every table.
- [ ] Enable pgvector in the first migration: prepend `CREATE EXTENSION IF NOT EXISTS vector;` to the generated migration (or add a `0000_enable_vector.sql`).
- [ ] Verify: fresh `db:migrate` on a dropped/recreated `swil_social_pg` applies all tables cleanly. `psql \dt` lists 18 tables.
- [ ] Stage.

---

## Phase 3 — Data-layer rewrite (per module, TDD)

For each module: (a) write/adjust a focused test that pins current behavior against a pglite DB seeded with fixtures, (b) rewrite the queries to Drizzle, (c) green, (d) stage. Keep DTO outputs identical (compare against `lib/dto.ts` mappers). Order chosen so dependencies land first.

### Task 3.1: `lib/id.ts` + auth.service
- [ ] `lib/id.ts`: `import { ObjectId } from 'bson'; export const newId = () => new ObjectId().toHexString();`
- [ ] Rewrite `modules/auth/auth.service.ts` (register/login/password + `createApiKey`/`listApiKeys`/`revokeApiKey`; replace the raw `mongoose.connection.db` use at line 85). Test: register→login→apikey create/verify/revoke round-trip on pglite.
- [ ] Rewrite `middlewares/auth.ts` (`loadApiKeyUser`, session load) to Drizzle.
- [ ] Verify: `vitest run modules/auth middlewares` green. Stage.

### Task 3.2: users.service + follows.service
- [ ] Rewrite profile reads/counters (users) and follow/unfollow + follower/following lists (follows) — the follows counters become `COUNT` JOINs. Tests pin counts and relationship flags.
- [ ] Verify; stage.

### Task 3.3: posts (service/write/read/hydrate) + tags
- [ ] Rewrite create/edit/delete (write), timeline/single reads (read), hydration/counter joins (hydrate), tag upsert/counts. Preserve the `emitToUser('post:new')` realtime call in `posts.write.ts:131` untouched.
- [ ] Tests: create post → appears in read with correct hydrated counts + tags.
- [ ] Verify; stage.

### Task 3.4: comments + likes + bookmarks
- [ ] Rewrite CRUD + unique-constraint handling (like/bookmark idempotency via `ON CONFLICT DO NOTHING`). Tests pin idempotent like/unlike, comment counts.
- [ ] Verify; stage.

### Task 3.5: notifications + messages
- [ ] Rewrite notification create/list/mark-read and DM send/read. Preserve realtime emits (`emitToUser`/`emitToConversation`) untouched. Tests pin unread counts + conversation membership checks.
- [ ] Verify; stage.

### Task 3.6: feed.service (aggregation — high risk)
- [ ] Rewrite the timeline aggregation as SQL (follower fan-out JOIN + ORDER BY createdAt + pagination). Write a parity test: seed a known graph, assert the exact ordered post ids + hydrated fields match the pre-migration expectation.
- [ ] Verify; stage.

### Task 3.7: agents.service (1,650 lines — highest risk, split into sub-tasks)
- [ ] 3.7a Snapshot ingest (`ingestPersonalitySnapshot`/`behavior`) + `recomputeDriftAgainstAnchor`: store `vector(1024)`, read back to `number[]`, reuse `lib/vector.ts` cosine. Test: ingest two snapshots → drift sim matches JS cosine within 1e-6.
- [ ] 3.7b Drift leaderboard + population rollups → GROUP BY/CTE; embeddings pulled and reduced in JS where cosine is needed. Parity test vs seeded fixture.
- [ ] 3.7c Cross-species / cadence / engagement split endpoints. Parity tests per endpoint.
- [ ] 3.7d benchmarkRun ingest + leaderboard/matrix/compare. Parity tests.
- [ ] Verify each sub-task green before the next. Stage after each.

### Task 3.8: Wire server bootstrap
- [ ] `server.ts`: drop `import './models/*'` registrations + `syncAllIndexes`; call drizzle `migrate` on boot (or rely on CI-run migrations). `config/db.ts` re-exports from `db/client.ts`. `config/session.ts` uses `connect-pg-simple` with the `pg` Pool.
- [ ] Delete all `server/src/models/*.model.ts`.
- [ ] Verify: `npm --prefix server run typecheck` PASS (no dangling model imports). Stage.

---

## Phase 4 — ETL

### Task 4.1: Write `scripts/migrate-mongo-to-pg.ts`
**Interfaces consumed:** `db` (Drizzle), all schema tables. Source Mongo via `MONGO_SOURCE_URI` (default `mongodb://127.0.0.1:27017/swil_social`).
- [ ] Implement: connect both; for each collection in dependency order (users→tags→posts→comments/likes/follows/bookmarks→conversations/messages→notifications→apikeys→lab tables→sessions), read all docs, map `_id`→`id`, refs verbatim, `Date`→JS Date, embedding array→`vector`, subdocs→jsonb; `insert().onConflictDoNothing()`; wrap per-table in a transaction.
- [ ] After each table, assert `SELECT count(*)` == Mongo `countDocuments`; collect a reconciliation report; throw on mismatch.
- [ ] Embedding fidelity check: sample 5 snapshots, assert `cosineSim(mongoVec, pgVec) > 0.999999`.

### Task 4.2: Trial run against local Postgres
- [ ] Recreate `swil_social_pg` clean, run `db:migrate`, then `MONGO_SOURCE_URI=mongodb://127.0.0.1:27017/swil_social npm --prefix server run etl`.
- [ ] Expected: reconciliation report shows every table's Mongo count == PG count (users 19, posts 895, comments 1147, likes 1182, follows 107, personalitysnapshots 198, behaviorsnapshots 206, agentevents 3701, benchmarkruns 437, notifications 2447, tags 440, …). Embedding check passes.
- [ ] Stage the script.

---

## Phase 5 — Test harness + full green

### Task 5.1: pglite test harness
- [ ] `server/src/test/pg.ts`: boot pglite with the `vector` extension, run the drizzle migrations against it, expose `resetDb()` (truncate all tables) for `beforeEach`. Wire into `vitest.config.ts` globalSetup or per-suite.
- [ ] `test/setup.ts`: `process.env.DATABASE_URL ??= <pglite url or marker>`; drop the `MONGODB_URI` line.
- [ ] Rename the integration gate `MONGO_INTEGRATION` → `PG_INTEGRATION`.

### Task 5.2: Full suite + coverage
- [ ] Run: `npm --prefix server run test:coverage`. Fix any red tests / coverage gaps introduced by the rewrite.
- [ ] Run the whole pipeline: `npm run ci:check`. Expected: all 8 steps green.
- [ ] Remove `mongoose` + `connect-mongo` from `server/package.json`; keep `mongodb` only if the ETL is retained in-repo (it is). `npm --prefix server run knip` clean.
- [ ] Stage everything.

---

## Phase 6 — Neon cutover (DEFERRED — needs user consent, do NOT run autonomously)

### Task 6.1: Provision Neon
- [ ] With explicit user go-ahead: `vercel install neon` (user completes the browser OAuth/consent). Capture the pooled `DATABASE_URL`.
- [ ] `CREATE EXTENSION vector` on Neon `main`; run `db:migrate` against it.

### Task 6.2: Production ETL + switch
- [ ] Run the ETL with target = Neon `main`. Validate counts + embedding fidelity.
- [ ] Set `DATABASE_URL` (local `.env` + later Railway) to Neon. Smoke-test `npm --prefix server run dev` + a login + a feed read + a realtime event.
- [ ] Report; hand off to the (separate) Railway/Vercel deploy plan.

---

## Self-Review

**Spec coverage:** every spec section maps to a task — big-bang cutover (Phase 4/6), Drizzle+pg+pgvector (Phase 1/2), ObjectId-text PK (Phase 2 rule + `lib/id.ts` 3.1), vector(1024)+JS cosine (2.5, 3.7a), connect-pg-simple (3.8), faithful ETL + count/embedding validation (Phase 4), pglite tests (Phase 5), unchanged realtime/S3/auth/DTO/client (called out in 3.3/3.5/global constraints), rollback (branch-based, Phase 4/6), Neon branching (Phase 6). No gaps.

**Placeholder scan:** foundational code (client, config, ETL shape, id) is given in full; per-model tasks reference the exact source model to mirror rather than reproducing 939 lines — acceptable since the executor reads the source file named in each task. No "TBD/handle edge cases" left.

**Type consistency:** `db`, `newId()`, `connectDb/disconnectDb/pingDb`, `env.DATABASE_URL` used consistently across Phase 1→5. Realtime emit call sites (`emitToUser`/`emitToConversation`) referenced by their real paths and left intact.

**Risk order:** hardest rewrites (feed 3.6, agents 3.7) are late, after the pattern is proven on simple modules, and each carries a parity test.
