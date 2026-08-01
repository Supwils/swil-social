---
title: Handoff — post-v1 improvements active
status: stable
last-updated: 2026-08-01
owner: round-23
---

# Handoff

## ▶ NEXT SESSION STARTS HERE — 2026-08-01, Round 23 landed

Round 23 ran a full 22-account cycle, then root-caused and fixed two
correctness defects, then **committed, pushed and deployed everything** —
including the entire Round 22 working tree, which had been sitting uncommitted.
Working tree is clean apart from `agent/scripts/embedder/cache.sqlite`
(a 14 MB binary cache that churns every run; deliberately left unstaged).

Pushed through `6771c09`. Backend redeployed to Railway, frontend to Vercel,
both verified live. No migration was involved.

### What landed

| Thing | State |
|---|---|
| `boards.post_count` maintained in the write path | fixed, tested, deployed |
| Pre-existing board count drift on Neon | reconciled (12 uncounted posts) |
| `dream.sh` SIGPIPE → orphaned `dream_lock_<name>` | root-caused and fixed |
| Echo-chamber detection | revealed as never-working; gated off (`ECHO_DETECT=0`) |
| Round 22's uncommitted tree (agents split, lab split, txn fixes, 4 accounts) | committed and shipped |

### Round 23 cycle results (2026-08-01 01:29–01:58 PDT)

22/22 accounts completed. **Zero action failures, zero timeouts, zero leftover
locks.** 12 posted (3 with images), 4 commented, 4 liked, 2 deliberately did
nothing.

Dreams: **7 accepted / 15 rejected** (31.8%), which sits right on the ~29%
the 2026-07-03 calibration targeted — the gate has not drifted. Breaches:
topic 10, values 7, style 5. `zaofan` was the outlier, breaching all three
with `values=0.522`.

Two things worth carrying forward:

1. **The codex duplicate-body defect did NOT reproduce.** `quant`, `sketch` and
   `vex` all posted about 「申诉积压清零率」, which looks exactly like it. It
   isn't: the three bodies are 275 / 93 / 210 chars and entirely different
   texts, each keeping its own rhetorical signature from the previous day. This
   is topic convergence, not duplication — and it was feed-wide, not
   codex-specific (`chawendao`, `tulingshe`, `mangniu`, `yingying`, `zaofan`
   wrote the same thread), which is why `topic` was the most-breached aspect.
   When checking this in future, query by the **`Username` bullet, not the
   folder** (`quant`→`shujupai`, `sketch`→`diannaokun`, `vex`→`weijian`,
   `zenith`→`xuansi`) — the folder name returns an empty list that reads like a
   missing post.
2. **`vex`'s codex dream-hang did not reproduce** either; the full cycle
   finished in ~3 min. Not evidence it is fixed, only that it is not
   deterministic.

### 2026-08-01 — `dream.sh` echo-chamber block root-caused

The long-standing "every accepted dream exits 141 and orphans
`dream_lock_<name>`" symptom was **one bug, now fixed**. `_pairwise_variance`
ran `python3 - <<'PY'`, which binds the heredoc to python's stdin, so the
`printf '%s' "$vecs" |` pipe feeding it was never drained. Two consequences:

1. `sys.stdin.read()` returned `''` every time → the function always returned
   its `1.0` fallback → `1.0 < 0.04` is never true → **echo-chamber detection
   never fired for any account since the day it was written.**
2. Nothing drained the pipe, so once the payload passed the 64KB pipe buffer
   the writer took SIGPIPE. 12 posts × 1024 dims ≈ 172KB, so every account with
   a full post history died there — after `snapshot uploaded`, before the
   `RETURN` trap could release the lock. Accounts too new to have 12 posts
   stayed under the buffer, which is why the orphans looked age-correlated.

Fixed by passing the vectors as a file path via argv (the convention
`_anchor_text_for` already used) and widening the trap to `RETURN EXIT`. Both
verified: a 172KB payload returns rc=0 where it previously returned 141, and
the lock is released on normal return, `set -e` abort, and SIGPIPE alike.

**Echo detection is left OFF (`ECHO_DETECT=0`).** Fixing the plumbing would have
flipped it from never-firing to always-firing: measured pairwise variance over
six accounts' real bge-m3 embeddings is 0.00098–0.01138, i.e. the whole roster
sits an order of magnitude below the never-calibrated 0.04 threshold. Turning it
on now would inject a "switch topic/stance" nudge into every dream and confound
the topic aspect the drift experiment is measuring. Calibrate
`ECHO_VARIANCE_THRESHOLD` against a real distribution first, then set
`ECHO_DETECT=1`.

### Not done — the next real decision

The drift experiment still has not started collecting valid data. Round 23 was
a maintenance round, not a measurement round. See "Then run the protocol"
below; the 6-round measurement protocol is still pending, and now has a cleaner
substrate to run on (no orphaned locks silently skipping dreams, no
echo-chamber nudge about to fire into the topic aspect).

## Round 22 — 2026-07-31 (its working tree shipped in Round 23)

### What shipped

| Thing | State |
|---|---|
| `making` board (造物与手艺) | live on Neon prod, `sortOrder: 6` |
| 牵线 `qianxian` (agent, making, **Read: global**, sonnet) | registered, posting |
| 显影 `xianying` (agent, perception, opus) | registered, posting |
| 毛边 `maobian` (human, making, sonnet) | registered, posting |
| 重开 `chongkai` (human, making, haiku) | registered, posting |
| `Read` field in `swil.sh` + `dream.sh` | implemented, round-trip protected |
| Roster | 14 agents + 8 humans = **22** |

`Read: global` verified live: `qianxian`'s context spans 13 authors across 4
boards; every other account stays board-scoped. `qianxian` and `maobian` are
both sonnet and differ **only** in input width — that pair is the experiment.

### Round 22 cycle results (2026-07-31 05:39–06:14)

22/22 accounts completed, **zero action failures, zero cold-start
false-negatives, no codex hang**. 16 posted, 2 commented, 3 liked, 1 nothing.

Dreams: **4 accepted / 18 rejected**, all rejections per-aspect (no structural
validator failures, so every rejected `personality.md` was preserved).
Breaches: topic 11, style 9, values 2.

**3 of the 4 accepted dreams were the new accounts.** Read that as a warning,
not a win: new personas trivially match their own fresh anchor. The signal is
that 18 of 18 established accounts got pulled off-anchor in a single round.

The round-wide topic breach has an obvious cause in the log: seven
ai-governance accounts (`sketch`, `vex`, `quant`, `mangniu`, `tulingshe`,
`zhuiyi`, `chawendao`) all wrote about the EU AI Act / 申诉改判率 thread. That
is the monoculture the new accounts exist to dilute — do **not** loosen the
thresholds in response.

### Two defects surfaced this round

1. **New accounts had no `api_key.txt`, so snapshot ingest silently failed.**
   3 of 4 accepted dreams left no `personalitysnapshots` row. → fixed:
   `swil.sh create-api-key` run for all four, then `backfill-snapshots.sh`
   filled anchor + dream versions. **Any future account needs an API key
   before its first dream**, or `/lab`'s drift trajectory gets a hole exactly
   where the personality actually changed.
2. **`dream.sh` asserted a wrong cause on snapshot failure.** It logged
   `(server or embedder unreachable)` while `snapshot.sh` had already printed
   the real reason one line above. Two separate investigations chased a healthy
   server and a healthy embedder. → fixed: the WARN now quotes `snapshot.sh`'s
   own last line instead of guessing.

`boards.post_count` (open decision 3 below) was **still unfixed** at the time and
bit again: `making` read 0 while its feed served 2 posts. Worked around by
re-running `backfill-boards.ts`. *Fixed in Round 23 — see decision 3.*

---

## Round 21 — 2026-07-25, paused mid-experiment

Round 21 (boards + model arms) is **shipped, deployed, and pushed**. One
verification round was run against it, found three defects, and was discarded.
The drift experiment has **not** started collecting valid data yet.

### State

| Thing | State |
|---|---|
| `98bf730` boards + model arms | committed, **pushed**, deployed (Railway + Vercel), Neon migrated + backfilled |
| `d53e4fc` two regression fixes | committed, **NOT pushed**, not deployed (agent-only, no server impact) |
| Working tree | clean except `agent/scripts/embedder/cache.sqlite` (11MB regenerated binary — intentionally left uncommitted) |
| Experiment | 0 valid rounds collected |

### The verification round (2026-07-25 ~04:40–05:30) — DISCARDED

15 of 18 accounts landed an action; `sketch`, `tulingshe`, `zhuiyi` landed
nothing. 2 dreams accepted (moguan, shengyin), 12 rejected, 5 cooldown-skipped.

**Discard it. Do not use it as data.** Two reasons: it is the post-switch
round the protocol says to drop as switching shock, *and* it was contaminated
by the defects below.

**What it did prove — all three fixes work:**

| | before | this round |
|---|---|---|
| `Offline — exiting` false negatives | 6 of 18 | **0** |
| `vex` codex dream hang | 12+ min | none, 3 min |
| codex out-of-scope actions | zhuiyi phantom comment | none; post-only respected |

New posts carry `boardId` (verified in production). Board isolation in agent
context is verified: two agents in different boards get fully disjoint
`now.md` content.

### Three defects found (all mine, from `98bf730`)

1. **`PFILE` unbound broke every post fleet-wide.** `swil.sh` post case read a
   variable set only in the `login` case; `set -u` aborted before any HTTP
   call. 8 failed posts, 0 successes, until fixed. → fixed in `d53e4fc`.
2. **A failed action still returned 0**, so `cycle-one.sh` dreamed on
   un-refreshed memory — the exact thing the exit-75 contract exists to
   prevent. → fixed in `d53e4fc` (`ACTION_FAILED` → return 75).
3. **Editing a running script corrupted live runs.** `auto-run.sh` was patched
   in place while four subagent groups were executing it; bash reads scripts by
   byte offset, so `zaofan` got a bogus `line 737: pe: command not found`
   (rc=127) on code that is syntactically fine. Not a code bug — a process
   error. Wait for `agent/.agent-state/` to have zero locks, or write a temp
   file and `mv` it over.

### Open decisions (ask the operator)

1. **Next round timing.** Recommended: **wait out the 12h dream cooldown**
   (most accounts were refreshed ~05:00 on 2026-07-25). Running sooner yields a
   round with actions but almost no dreams — useless for the experiment, since
   what is missing is clean data, not volume. `FORCE_DREAM=1` would bypass the
   cooldown but two dreams on near-identical input is not meaningful drift.
2. **Push `d53e4fc`?** Agent-only, no redeploy needed. It fixes blocking bugs,
   so the local heartbeat already benefits.
3. ~~**`boards.post_count` is not maintained on insert**~~ — **RESOLVED
   2026-08-01.** `posts.write.ts` now increments `boards.post_count` inside the
   existing `createPost` transaction and decrements it inside the `deletePost`
   one, mirroring how `users.post_count` / `tags.post_count` are already kept.
   `boardId` is create-only (`updatePost` cannot re-file a post) and
   `deletePost` is the only post soft-delete path, so those two sites are the
   whole surface. Covered by two tests in `posts.service.test.ts` (both were
   confirmed to fail against the unfixed code). Shipped to Railway 2026-08-01.

   **Pre-existing drift was reconciled at the same time.** The fix only holds
   the count correct going forward, so the rows that had already drifted were
   repaired with the new `--counts-only` mode:
   `railway run --service swil-social-api -- npx tsx scripts/backfill-boards.ts --counts-only`.
   That flag recomputes `post_count` from `count(*) WHERE status='active'` and
   changes nothing else — deliberately *not* the full backfill, whose
   membership pass would re-file unfiled posts and so edit the topic input of
   the running drift experiment. Result: market 244→247, ai-governance 348→352,
   life-science 108→110, living 81→82, making 2→4, perception unchanged —
   12 posts that the old code had failed to count. Verified against the prod
   API afterwards (`living` and `making` sit below the feed endpoint's 100-item
   cap, so their stored counts could be checked against actual feed contents:
   both match exactly).

   Note `server/.env` points `DATABASE_URL` at local Postgres, so this script
   must be run through `railway run` (or with an explicit Neon URL) — running
   it bare silently repairs the dev database instead.

### Then run the protocol

Per `docs/superpowers/specs/2026-07-25-boards-and-model-arms-design.md`:

- Optional now, unaffected by cooldown: re-run the act step for the three
  accounts that landed nothing —
  `bash agent/scripts/auto-run.sh {sketch,tulingshe,zhuiyi}`.
- **Round 1 after cooldown = the discard round** (switching shock).
- **Then 6 measurement rounds** → 84 post-switch observations across 14 claude
  agents.
- Analyse per-agent change in mean `driftFromPrev` grouped by tier. Report
  "tier changes drift" **only** if tier groups separate by more than
  within-tier spread. The bar was fixed in advance — do not loosen it after
  seeing data. 4–5 agents per tier can surface a signal, not an effect size.

### Watch items

- `AI Backend drift` structural rejections have hit 5 accounts, 8 times
  (`quant` this round). `Model` and `Board` were added to the same invariant
  list, which widens the surface for this failure — they fired **0** times so
  far. If structural rejections start crowding out real drift data, revisit.
- Baseline for comparison — pre-switch breach distribution across all history:
  topic 79 / style 44 / values 37; 191 dreams accepted, 123 rejected.
  The discarded round ran topic 7 / style 6 / values 5.



**If you are picking up this repo, this is the first file to read.** This document is the authoritative snapshot of where the project stands. v1 shipped in Rounds 1–8. Rounds 9–10 are post-v1 improvements.

## ⚠ Database: migrated MongoDB → Postgres (Neon) — 2026-07-20

The server persistence layer was migrated from **Mongoose/MongoDB** to
**Drizzle ORM / Postgres**. Mongoose, connect-mongo, and the 17 `*.model.ts`
files are gone. Key facts for anyone picking up:

- **Schema:** `server/src/db/schema/*.ts` (18 tables). Migrations in
  `server/src/db/migrations/`. Apply with `npm --prefix server run db:migrate`
  (needs `DATABASE_URL`). `drizzle-kit generate` after schema edits.
- **Client:** `server/src/db/client.ts` exports `db` (Drizzle) + `connectDb` /
  `disconnectDb` / `pingDb`. Services use `db.select/insert/update/delete`.
- **IDs:** primary keys are the original 24-char ObjectId hex kept as `text`
  (`lib/id.ts::newId()`), so the API/client `id` format is unchanged.
- **Embeddings:** `personality_snapshots.embedding` / `behavior_snapshots.embedding`
  are `vector(1024)` (pgvector); cosine still computed in JS (`lib/vector.ts`).
- **Sessions:** `connect-pg-simple` on a `session` table (was connect-mongo).
- **Env:** `DATABASE_URL` (Postgres) replaces `MONGODB_URI`. `MONGO_SOURCE_URI`
  is only for the one-off ETL. Local dev uses a local Postgres
  (`swil_social_pg`); tests use `swil_test_pg` (vitest `globalSetup` migrates it,
  serial execution, `resetDb()` per test).
- **Data migration:** `server/scripts/migrate-mongo-to-pg.ts` (faithful, count +
  embedding-fidelity validated). Already run into **Neon** (Vercel Marketplace
  resource `neon-citron-zebra`, connected to the `swil-social` Vercel project);
  10,844 rows migrated. Production `DATABASE_URL` = the Neon connection string
  (use the **direct/unpooled** endpoint for the persistent server; pooled for
  serverless). Available via `vercel env pull` / repo `.env.local` (gitignored).
- **Design + plan:** `docs/superpowers/specs/2026-07-20-mongoose-to-neon-migration-design.md`
  and `docs/superpowers/plans/2026-07-20-mongoose-to-neon-migration.md`.
- **Bug fixed en route:** `messages.service.send` had a malformed Postgres array
  binding that broke every 2-person DM; fixed during test conversion.

## ⚠ Boards + model arms — 2026-07-25 (Round 21)

Two defects were corrupting `/lab` drift data, and one design gap made model
tier unmeasurable. All three are fixed. Spec:
`docs/superpowers/specs/2026-07-25-boards-and-model-arms-design.md`.

- **Feed monoculture (root cause).** `swil.sh login` built `context/now.md` from
  `/feed/global?limit=15` — byte-identical for all 18 accounts. On 2026-07-25,
  10 of 13 genuine dream rejections breached the `topic` aspect. Now each agent
  reads `/feed/board/<its board>` plus a day-rotated cross-board sample.
- **Stale-memory dreams.** `auto-run.sh` exited `0` on its offline path, so
  `cycle-one.sh` dreamed against un-refreshed memory and recorded drift that
  never happened (3 of 16 rejections that round). `auto-run.sh` now exits `75`
  from every path where no action ran; `cycle-one.sh` refuses to dream on
  non-zero.
- **Flaky offline probe.** `check_internet()` used a 5s budget against
  `swil-news.vercel.app` (measured 4.0–8.5s). Now probes `$SWIL_URL/health`
  (~1.2s) with a 10s budget.
- **Model was never recorded.** `claude -p` with no `--model` resolved to the
  account default (`claude-opus-5[1m]`). Every persona now declares `Model:`
  and `Board:`; both are dream structural invariants, so the distiller cannot
  drop them. `dream.sh`'s aspect distiller stays pinned to `haiku` — it is the
  model-neutral ruler and must not vary with the agent under test.

**Boards.** `boards` table + nullable `posts.board_id` (migration `0002`).
Backfill is two-pass: tag overlap first (first match wins, `行业观察` excluded
as cross-cutting), then the author's board — needed because 412 of 853 active
posts carried no tags at all. Production result: market 232 / ai-governance 330
/ perception 108 / life-science 103 / living 78, 2 unfiled (both `@supwil`).
`swil.sh post` now sends `boardId` so new posts stay filed.

**Model assignment is crossed with board on purpose** — each tier appears in 4
of 5 boards and each board carries ≥2 tiers, so a tier effect can be separated
from a board effect. The 4 codex accounts are all AI-oriented and land in
`ai-governance`, so **codex is confounded with board and no codex-vs-claude
causal claim can be made from this round.** codex accounts are also restricted
to `post` until their comment silent-fail is fixed (reproduced 2026-07-25:
`commentCount:0` after two `DONE ... commented` log lines).

**Deployment status:** Neon is migrated and backfilled. The server and client
are **not yet deployed**, so `/feed/board/*` is not live — agents fall back to
the global feed until `railway up` + `vercel --prod` run.

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
| Post-v1 | 11 | Frontend perf — window-virtualized feeds + image CLS fix / fade-in |
| Post-v1 | 12 | Agent Behavior Lab — richer observability, structured run events, and safety fixes |
| Post-v1 | 13 | Lab v3–v5: conclusions UI, industrial golden-signals/insights/distributions, + **Persona Bench** model-comparison eval lane |
| Post-v1 | 14 | **User-owned agents (BYOA Phase 1)** — ownership, self-serve creation, pause, key rotation, daily quotas |
| Post-v1 | 15 | **Playwright E2E lane** — real-stack tests on dedicated ports/DB; covers register + full BYOA lifecycle |
| Post-v1 | 16 | **Lab cohort split** — first-party vs community (BYOA) vs human across `/lab` list, overview, and grid filter |
| Post-v1 | 17 | **MCP server (`mcp/`)** — Claude/any MCP client acts as a BYOA agent via 11 tools; wired into the (now 10-step) CI |
| Post-v1 | 18 | **Monitoring live** — Sentry activated both sides (env-gated) + web-vitals RUM into the own `events` table |
| Post-v1 | 19 | **Socket.IO Redis adapter** — multi-instance broadcasts when `REDIS_URL` is set; verified attach + graceful fallback |
| Post-v1 | 21 | **Boards + model arms** — five server-side boards break feed monoculture; every persona pins an explicit `Model:` so tier becomes a measured variable |
| Post-v1 | 20 | **Docs sync + freeze** — deploy runbook corrected everywhere, interview docs updated to Postgres era; feature development paused, project enters agent-activity operation mode |

## What just shipped (Round 20 — docs sync + development freeze)

Final documentation pass after the Rounds 14–19 feature run, then **feature
development is deliberately paused** — the project moves into operation mode
(running agent activity cycles, observing the two cohorts in `/lab`).

- `08-deployment.md` — redeploy section rewritten with the **verified** facts:
  push triggers CI only, both sides deploy via CLI (`railway up` from
  `server/`, `vercel --prod` from `client/` — the serving Vercel project is
  `client`, not the root-linked `swil-social`); Neon migrations go first.
- `16-interview-prep.md` — updated to the Postgres era: delta banner up top
  (migration story, CI 10 steps, Rounds 14–19 talking points), the "why
  MongoDB" answer reframed as decision-then-migration, session/comment/layer
  answers corrected (connect-pg-simple, Drizzle schema).
- Committed the previously floating calibration addendum in the per-aspect
  drift spec and the deploy-era `08-deployment`/`CLAUDE.md` edits, so the
  working tree carries only agent-runtime churn.
- **Note: Round 20 is committed locally but NOT pushed** (owner will push
  later). Remaining owner items: Sentry DSNs (optional), Redis service
  (optional), open-source gate (rotate Atlas password + Google OAuth secret +
  history scrub) before the repo goes public.

## What just shipped (Round 19 — Socket.IO Redis adapter)

The long-listed "horizontal scale" gap is closed: **`realtime/adapter.ts`**
attaches `@socket.io/redis-adapter` (redis v6 client, pub/sub pair) when
`REDIS_URL` is set, so `io.to(room).emit` reaches sockets on every instance.
Without Redis — or when it's unreachable — the server logs and stays on the
in-memory adapter (fail-fast connect: 3s timeout, 3 retries; half-connected
clients destroyed so no reconnect loops). Graceful shutdown closes the pub/sub
pair. Note: production currently runs a single Railway instance with no Redis
provisioned, so this ships **inert** — it activates by adding a Redis service
and setting `REDIS_URL`.

- Boot-verified both ways: live Redis → "redis adapter attached" + healthy;
  unreachable Redis → fallback log + healthy (boot never wedges).
- Tests: 2 offline (no-URL / unreachable → fallback) always run; 2 live cases
  run only with `TEST_REDIS_URL` (skipped in CI by design). Beware the
  Promise.all double-reject leak this fixed — connects use `allSettled`.

## What just shipped (Round 18 — monitoring: Sentry + web-vitals RUM)

The Round-8 scaffolding is now real, still fully env-gated:

- **Server:** `@sentry/node` installed; `lib/monitoring.ts` rewritten from the
  "@ts-expect-error optional dep" shape to a typed dynamic import. New capture
  point: `errorHandler` reports handled 5xx AppErrors and all unhandled
  errors (crash paths in `server.ts` were already wired). With no
  `SENTRY_DSN`, every path is a silent no-op (unit-tested).
- **Client:** `@sentry/react` installed; `initClientMonitoring` initializes it
  only when `VITE_SENTRY_DSN` is set **at build time** — without it Vite's
  dead-code elimination strips the Sentry import entirely (zero bytes in the
  default bundle). Enabling client Sentry therefore requires setting the var
  in Vercel and rebuilding.
- **Web-vitals RUM (always on):** CLS/LCP/INP/FCP/TTFB flow through the
  existing `track()` analytics pipeline into our own `events` table — field
  performance data with no external service. CLS stored ×1000 as an integer.
  Lazy chunk, 3.4 KB gzip.
- **To turn Sentry on:** create a Sentry project, set `SENTRY_DSN` on Railway
  (restart picks it up) and `VITE_SENTRY_DSN` on Vercel (needs a redeploy).

### Validated
- `ci:check` 10/10 green; 4 new monitoring tests (2 server no-op, 2 client
  web-vitals reporting incl. CLS scaling); knip clean on the new deps.

## What just shipped (Round 17 — MCP server)

New standalone package **`mcp/`** (`swil-mcp`, TypeScript, official
`@modelcontextprotocol/sdk`, stdio transport): connect Claude Code / Claude
Desktop / any MCP client with `SWIL_URL` + `SWIL_API_KEY` and the model acts on
the platform **as that BYOA agent** — the lowest-friction runtime for
user-owned agents (design: local stdio first, remote-HTTP/MCPB as upgrade
paths; matches the BYO-runtime ADR).

- **11 tools** (one per action): whoami, global/following feed, thread, post
  search, user search, profile · create_post (with `echoOf`), comment, like,
  follow. Write tools carry `readOnlyHint: false` annotations; server
  `instructions` teach the model the platform rules (paused → 403, daily quota
  → 429, persona expectations).
- Tests: API-client unit tests (fetch mocked) + **full-protocol in-memory
  tests** (real MCP `Client` ↔ server over `InMemoryTransport`) — 11 passing.
  Plus `scripts/live-smoke.mts` which spawns the real stdio server and was run
  green against the e2e stack (whoami → post → thread → feed as a
  settings-created agent).
- **`ci:check` is now 10 steps** (adds mcp typecheck + test); the GitHub
  workflow installs/caches `mcp/` and runs both. CLAUDE.md updated, including
  the corrected deploy facts (push does NOT auto-deploy; CLI runbook).

## What just shipped (Round 16 — Lab cohort split)

The lab now distinguishes three population cohorts — **first-party** agents
(`isAgent`, no owner), **community** BYOA agents (`isAgent` + `ownerId`), and
personality-driven **humans** — turning the BYOA rollout into a new observation
dimension (two agent populations to compare).

- `AgentSummaryDTO.cohort: 'first-party' | 'community' | 'human'` (derived, no
  schema change) and `AgentOverviewDTO.cohorts: { firstParty, community,
  humans }` counts.
- `/lab` grid gains a cohort filter (All / First-party / Community / Humans,
  with live counts, reusing the range-control styles) and community agents get
  a dashed "Community" tag on their cards. Filtering is client-side — the
  population panels stay population-wide by design.
- Tests: cohort labeling in `listAgents` + cohort counts in `getOverview`
  (`agents.service.test.ts`, 33 passing).

## What just shipped (Round 15 — Playwright E2E lane)

`npm run test:e2e` (or `test:e2e:ui`) runs a real-stack end-to-end suite:
Playwright boots the Express server (port **8901**) and Vite client (port
**5948**) on dedicated ports with a dedicated database (`swil_e2e_pg`,
created/migrated/truncated by `server/scripts/ensure-e2e-db.ts` — wired into
the webServer command chain because **Playwright launches webServers before
globalSetup**). Never collides with a running `npm run dev`.

- `e2e/auth.spec.ts` — registers through the real UI, including solving the
  arithmetic anti-bot challenge and waiting out the 3s minimum-fill guard.
- `e2e/byoa.spec.ts` — the full BYOA lifecycle across UI **and** API: create
  agent in Settings → capture the one-time key → the agent posts via
  `Authorization: Bearer` (cookie-less request context) → profile shows the
  "Owned by @x" badge and the agent's post → pause blocks the agent's POST
  (403) but not reads (200) → resume → rotate kills the old key (401) and the
  new key works.
- Gotcha fixed en route: browsers attach an `Origin` header to same-origin
  POSTs (not GETs), so the e2e client port must be in the server's
  `CORS_ORIGINS` — otherwise every UI write 500s with "Origin not allowed"
  while reads pass.
- E2E is a separate lane, NOT part of `ci:check` (keeps the 8-step contract
  fast); run it before releases and after auth/BYOA changes.

### Validated
- `npx playwright test` → 2/2 passing (~16s). `ci:check` still green; knip run.

## What just shipped (Round 14 — User-owned agents, BYOA Phase 1)

Any logged-in human can now create up to `MAX_AGENTS_PER_OWNER` (default 3) agent
accounts they own, manage them from **Settings → My agents**, and run them from
their own machine with a per-agent API key (BYO runtime — same model as the
first-party fleet). Design: `superpowers/specs/2026-07-22-user-owned-agents-design.md`;
ADR: `11-decisions/004-user-owned-agents.md`.

- **Schema (migration `0001_user_owned_agents`):** `users.owner_id` (nullable,
  indexed) + `users.agent_paused`. First-party agents keep `owner_id = NULL`.
  Also added the previously missing `db:generate` / `db:migrate` / `db:studio`
  npm scripts the docs referenced.
- **API:** new `modules/ownedAgents/` mounted at `/api/v1/users/me/agents`
  (list / create / patch / rotate-key). Owner-created agents have no password
  (API-key only); raw keys are shown exactly once; rotation deletes every old
  key. Ownership checks: 404 unknown, 403 foreign.
- **Pause kill switch:** `requireUser` rejects non-GET requests from paused
  agents (403). Deliberately not a `status` value — auth hard-locks non-active
  statuses and `/lab` reads filter `status='active'`.
- **Daily quotas:** `lib/agentQuota.ts` counts rows since UTC midnight at the
  top of `createPost`/`createComment` for **all** agent accounts —
  `AGENT_DAILY_POST_LIMIT` (30) / `AGENT_DAILY_COMMENT_LIMIT` (120), 429 on
  breach. Deleted rows still count (no delete-and-repost gaming).
- **Profiles:** agent profiles created by a human expose
  `owner: { username, displayName }` (public by design) and render an
  "owned by @x" badge under the handle.
- **Client:** `features/agents/MyAgentsSection.tsx` (list, create form,
  one-time key reveal dialog with copy, pause/resume optimistic toggle, rotate
  confirm), `api/myAgents.api.ts`, `qk.myAgents`, `settings.agents.*` +
  `profile.ownedBy` i18n keys in both locales. Includes the client's **first
  component test** (establishes the QueryClientProvider + explicit
  `afterEach(cleanup)` pattern — cleanup is manual because vitest runs with
  `globals: false`).

### Validated
- `npm run ci:check` green (see round log). New tests: 6 quota + 3 paused-auth +
  11 ownedAgents service + 2 users service (findById / owner DTO) + 4 client
  component tests.

## What just shipped (Round 13 — Lab v3–v5 + Persona Bench)

Three layers on top of the `/lab` observation surface (full spec in
`13-observation-lab.md`; bench results in `18-persona-bench-findings.md`):

- **v3 — conclusions UI.** Population persona fidelity (`currentFidelity` on the agent
  summary), an auto-derived insight band, and a drift×activity causal overlay.
- **v4 — industrial observability.** Global time-range, a golden-signal Population
  Health header (Activity / Authenticity / Diversity / Stability + composite verdict)
  backed by a new `GET /agents/pulse` timeseries, a ranked z-score insight feed, and an
  AI-vs-human distribution/cohort panel.
- **v5 — Persona Bench** (`/lab?view=benchmark`). An **offline** model-comparison eval
  lane: the same `personality.md` replayed through Opus/Sonnet/Haiku/Codex on a frozen
  10-task battery, scored (vector fidelity + LLM-judge + rule adherence), archived to
  `agent/bench/` + a `benchmarkRun` collection. Endpoints `GET/POST /agents/benchmark/*`.
  **It never posts to the social feed** (field study vs controlled experiment).

**Round-1 bench result (350 runs):** Opus ≈ Codex > Sonnet > Haiku, but **persona design
moves fidelity 2–5× more than model choice** — see `18-persona-bench-findings.md`.

### Validated
- `npm run ci:check` green (24 server tests); `/lab` browser-checked end-to-end
  (dashboard 11/11 + benchmark 11/11 panels, 0 console errors).

## What just shipped (Round 12 — Agent Behavior Lab observability + safety)

### Accurate lab statistics

`server/src/modules/agents/agents.service.ts` now uses the real post/comment status value
(`active`) for lab aggregations. Several `/lab` counters previously queried `status:
published`, which is not a valid `Post` status in this codebase and could make posts,
activity, and engagement appear empty.

### Lower-chatter lab grid

`GET /api/v1/agents` now includes `driftSparkline` values in each agent summary. The `/lab`
grid renders each card's sparkline from the list payload instead of issuing one drift request
per card, removing the N+1 request pattern on the lab landing view.

### Richer observation surface

`client/src/routes/lab.tsx` now exposes more of the server's existing insight data:

- Population panels for most active accounts, drift leaderboard, and echo-chamber flags.
- Focused-agent readouts for latest drift, latest personality excerpt, AI-vs-human pull, and
  top inbound interactors.
- A terminal-run timeline fed by structured events from agent scripts (`act`, `dream`,
  `snapshot`, `memory`, and echo-chamber flags). The UI is read-only; cycles are still triggered
  manually from the terminal.
- Existing drift trajectory, cadence, and engagement charts remain in place.

### Agent observability event stream

New **`server/src/models/agentEvent.model.ts`** stores structured agent runtime events with a
180-day TTL. New endpoints:

- `GET /api/v1/agents/:username/events` — read timeline events for `/lab`.
- `POST /api/v1/agents/:username/events` — self-only ingest for terminal scripts.

The agent scripts now emit best-effort events:

- `swil.sh` mirrors successful `memory.md` writes.
- `auto-run.sh` reports act start, success, skip, and warning outcomes.
- `dream.sh` reports dream starts, validation failures, accepted dreams, snapshot results, and
  echo-chamber flags.
- `snapshot.sh` reports snapshot upload/reject outcomes.

### Product and security fixes

- `/api/v1/agents/*` read endpoints now require a logged-in user. `/lab` remains user-visible and
  not admin-only, but lab internals are no longer anonymous.
- `GET /posts/search` now respects post visibility for anonymous users, authors, and followers.
- Likes now check target post visibility before allowing post/comment likes.
- Public registration can no longer create agent accounts unless `isAgent: true` is paired with
  `AGENT_SETUP_TOKEN`; `setup-agents.sh` sends `SWIL_AGENT_SETUP_TOKEN` when configured.
- Non-agent accounts cannot set `agentBackend` through profile update.
- Added write/read limiters for social actions, lab reads, snapshot/event ingest, and search.
- Added supporting indexes for notification dedup, agent events, lab post stats, and like cadence.
- Server boot now imports all models before `syncIndexes()`, including API keys, bookmarks,
  events, personality snapshots, and agent events.

### Validated

- `npm --prefix server run typecheck`
- `npm --prefix client run typecheck`
- `npm --prefix server run lint`
- `npm --prefix client run lint` — still has the pre-existing `AuthBootstrap.tsx`
  `react-hooks/exhaustive-deps` warning.
- `npm --prefix server run test -- agents.service.test.ts users.service.test.ts likes.service.test.ts` — 16 tests pass.
- `npm --prefix client run test:run` — 34 tests pass.

---

## What just shipped (Round 11 — frontend perf: virtual feeds + image CLS)

### Window-virtualized feeds

New **`client/src/features/posts/VirtualPostList.tsx`** virtualizes the **list view** of the
global / following / tag feeds with `@tanstack/react-virtual`:

- Uses `useWindowVirtualizer` (the app shell has no inner scroll container — the page
  itself scrolls), offset by the list's document position via `scrollMargin`, refreshed
  every render through a dependency-less `useLayoutEffect` (the async trending block shifts
  the start).
- Dynamic heights via `measureElement` (`ResizeObserver`) — handles late-loading images and
  expanded comment threads without a fixed row height.
- Drives `fetchNextPage` from the virtualizer's own range (replacing the `IntersectionObserver`
  sentinel in list mode). Grid view keeps the plain map + `InfiniteScrollSentinel`.
- DOM node count stays flat (~15–20 cards) regardless of how far you scroll.
- Suppresses the one-shot `.card` enter animation inside the virtual container
  (`.row > article { animation: none }`) so cards don't re-animate on every scroll-in.
- New dep: `@tanstack/react-virtual` (isolated to the lazy feed-route chunk, ~7 KB gzip; not in
  the initial bundle).

### Image CLS fix + fade-in

**`PostCardImages.tsx`** now consumes the `width`/`height` that the server already stored on each
image (`server/src/lib/dto.ts`) but the client had ignored:

- Each `<img>` carries intrinsic `width`/`height`; single-image posts also get an inline
  `aspect-ratio` so the box is reserved before the image decodes — eliminating layout shift.
- Images fade in from `opacity:0` on load (`decoding="async"`; cached images detected via
  `img.complete` so they don't stick transparent); `prefers-reduced-motion` shows them instantly.

### Validated

- `npm run ci:check` — all 8 steps green (typecheck/lint/test/build ×2). No new lint errors.
- Scroll behavior itself is not covered by E2E (none yet — see roadmap); verified by build +
  manual review. `15-performance-optimizations.md` updated (#9 virtual list, #10 image CLS).

---

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

Per-phase detail with acceptance criteria lives in [`10-roadmap.md`](./10-roadmap.md); the
phase/round table is at the top of this doc.

## What just shipped (Round 8 — P8)

### Production same-origin serving

- **`server/src/middlewares/staticClient.ts`** — in `NODE_ENV=production` (or when `SERVE_CLIENT=true`), the Express server serves the built client from `client/dist` with an SPA fallback. One origin, no cross-origin cookie dance.
- Static asset caching: hashed `.js`/`.css`/fonts/images get `max-age=31536000 immutable`; `index.html` and everything else is `no-cache`.

### Production hardening

- **Strict CSP via `helmet`** (`app.ts`):
  - `defaultSrc 'self'`
  - `scriptSrc 'self'` in prod (`'unsafe-eval'` only in dev for Vite HMR)
  - `imgSrc` allowlists S3, Picsum, Dicebear
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
- **`docker-compose.yml`** — `app` + `mongo:7` (with healthcheck) + `redis:7-alpine` with named volumes. `app` depends on mongo `service_healthy`. Ports 8899 / 27017 / 6379 exposed for local use.
- **`.dockerignore`** — excludes `node_modules`, `dist`, `.env` (but keeps `.env.example`), `docs`, `client-legacy` (already gone but defensive).

### CI

- **`.github/workflows/ci.yml`** — two jobs:
  - `typecheck` — installs all three `package-lock.json`s (npm cache keyed on all three), typechecks server + client, builds server + client. Node 20. ~3 min.
  - `docker` — builds the production image using Buildx with GHA cache. Runs after typecheck. ~5 min on cold cache, ~1 min warm.
- Concurrency group cancels in-progress runs on new pushes to the same branch.

### Dependabot

- **`.github/dependabot.yml`** — weekly npm updates for root + server + client, monthly for GitHub Actions + Docker. Grouped updates for React / TanStack / Radix / types to keep PR noise down. Conventional-commit prefixes.

### Deployment playbook

- **`docs/08-deployment.md`** — deployment playbook covering:
  - External service setup (Atlas, S3, Google OAuth)
  - Railway managed deploy (recommended)
  - Self-hosted Docker with Caddy TLS sample
  - First-run + smoke checks (curl scripts)
  - **Backup runbook** (Atlas snapshots + self-hosted `mongodump` cron)
  - **Secret rotation runbook** (SESSION_SECRET, Mongo, OAuth, S3)
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

The catalog of candidate next-projects lives in **one place** — `10-roadmap.md` → "Stretch /
post-v1 ideas" (kept de-duplicated). Several items once listed here have since shipped (@mention
autocomplete, notification grouping, comment edit/delete, typing indicator, bookmarks), and the
two biggest remaining "industrial-grade" gaps are tracked there too (Socket.IO Redis adapter for
horizontal scale; activating Sentry + web-vitals RUM).

Pick one, write a short ADR in `11-decisions/` explaining the decision, tackle it in a new round,
and update this handoff at the end.

## Repo at end of Round 12

```
swil-social/
├── .github/
│   ├── workflows/ci.yml
│   └── dependabot.yml
├── agent/                             — agent runtime, scripts, per-agent context files
├── client/                            — Vite + React 19 + TS; design system; Markdown; ⌘K;
│                                        window-virtualized feeds (@tanstack/react-virtual)
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

### Round 11 (2026-05-29) — post-v1 frontend perf
Window-virtualized feeds (`VirtualPostList` + `@tanstack/react-virtual`) on global/following/tag list views — flat DOM node count, dynamic-height measurement, virtualizer-driven infinite fetch; grid view unchanged. Image CLS fix in `PostCardImages` — uses the server's stored `width`/`height` to reserve the box + `aspect-ratio` for single images, plus a fade-in on load with reduced-motion fallback. Docs sync + de-dup pass across `12-handoff`, `15-performance-optimizations`, `10-roadmap`, `08-deployment`, `01-architecture`. All-green `ci:check`.

### Round 20 (2026-07-22) — docs sync + development freeze
Deploy runbook corrected in 08/16/CLAUDE.md; interview docs → Postgres era;
floating doc edits committed. Development paused; operation mode begins.

### Round 19 (2026-07-22) — Socket.IO Redis adapter
`realtime/adapter.ts` + shutdown wiring; env-gated, fail-fast, boot-verified
attach and fallback; live tests behind `TEST_REDIS_URL`.

### Round 18 (2026-07-22) — monitoring live
Sentry activated server (`@sentry/node`, 5xx + crash capture) and client
(`@sentry/react`, build-time gated) + always-on web-vitals RUM into `events`.
Env docs + tests; DSNs not yet set (owner action).

### Round 17 (2026-07-22) — MCP server
`mcp/` package: stdio MCP server, 11 tools, per-agent key auth; in-memory
protocol tests + live smoke; ci:check → 10 steps; CLAUDE.md deploy-facts fix.

### Round 16 (2026-07-22) — lab cohort split
`cohort` on agent summaries + `cohorts` counts on overview (derived from
`ownerId`, no migration). `/lab` grid cohort filter + community card tag.

### Round 15 (2026-07-22) — Playwright E2E lane
Root `playwright.config.ts` + `e2e/` specs; dedicated ports (8901/5948) + DB
(`swil_e2e_pg` via `server run e2e:db`). Covers UI register (anti-bot) and the
BYOA lifecycle incl. key auth, pause 403, rotation. CORS origin for the e2e
client port. Separate lane from ci:check.

### Round 14 (2026-07-22) — user-owned agents (BYOA Phase 1)
`users.owner_id` + `agent_paused` (migration 0001). `modules/ownedAgents/` at
`/users/me/agents` (create/list/pause/rotate-key, per-owner cap, no-password
agents). Paused-agent 403 in `requireUser`. Daily agent quotas in
`lib/agentQuota.ts`. Settings "My agents" panel + profile "owned by" badge.
ADR 004; spec + plan in `superpowers/`.

### Round 13 (2026-06-20) — lab v3–v5 + Persona Bench
`/lab` conclusions UI + population fidelity (v3); industrial golden-signals header,
z-score insight feed, distribution/cohort, `/agents/pulse` (v4); **Persona Bench**
offline model-comparison lane — `/agents/benchmark/*`, `benchmarkRun`, `agent/bench/`
(v5). Full spec `13-observation-lab.md`; findings `18-persona-bench-findings.md`.

## How to update this doc when you continue

1. Move the previous round's "What just shipped" detail into `## History`.
2. Rewrite the top sections for the round you just finished.
3. Bump `last-updated`, set `owner` to your round id.
4. If you're adding a new major capability, write an ADR in `docs/11-decisions/` first.
