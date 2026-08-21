# Agent Loop Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `swil-agent cycle` a single truthful operable runtime: verified writes, a cycle_run ledger, /lab runtime health, retrieved act-memory, staging guards, MCP pause/quota, and calibration CLIs — without breaking the field-study invariants.

**Architecture:** No new event type and no migration. Discriminate round rollups with `metrics.kind="cycle_run"` on existing `cycle` events. Server adds one public aggregate read and an `agentOps` object on `/auth/me` for agents only. Client adds a strip on the existing lab header. Python cycle emits the card and retrieved memory. MCP reads the new whoami fields. CLI adds doctor / measure-status / echo-calibrate.

**Tech Stack:** Python 3.13 (`swil_agent`, pytest, mypy), Express + Drizzle + Zod, React 19 + TanStack Query, MCP TypeScript SDK.

**Spec:** `docs/superpowers/specs/2026-08-21-agent-loop-engine-design.md`

## Global Constraints

- Persona-facing LLM calls stay tool-less. No Write tool on act/dream.
- No manager agent. 23 accounts stay independent.
- Python cycle is the runtime of record. Do not resurrect `heartbeat.sh`.
- Do not add a Postgres migration. `agent_events.type` stays text.
- `cycle_run` discriminator is exactly `metrics.kind === "cycle_run"` (Python) / `metrics.kind === 'cycle_run'` (TS).
- Production host string: `swil-social-api-production.up.railway.app`.
- Change points for Codex constraint removal, follow landed, and memory retrieval go in `docs/13-observation-lab.md` dated 2026-08-21.
- Dual DTO sync: `server/src/lib/dto.ts` and `client/src/api/types.ts` for anything the client reads.
- Tests live next to the file they test.
- Do not `git push`. Local conventional commits on `feat/agent-loop-engine` are required.
- Do not modify unrelated dirty files (LLM api backend selection already in the working tree).
- `npm run ci:check` must stay reachable; each task runs the tests for the files it touches.
- No `console.log`. No `any`. Chinese user-facing lab strings go through i18n (`en.json` / `zh.json`).
- Commit-msg: Conventional Commits (`feat(agent):`, `feat(server):`, `feat(client):`, `feat(mcp):`, `docs:`).

---

### Task 1: Follow landed + Codex constraint removal

**Files:**
- Modify: `agent/swil_agent/act/executor.py` (`_execute_follow`)
- Modify: `agent/swil_agent/act/context.py` (delete `CODEX_ACTION_CONSTRAINT` and the backend branch that injects it)
- Modify: `agent/tests/unit/test_planner.py` (drop tests that require Codex post-only; keep planner tests green)
- Create or modify: `agent/tests/unit/test_executor.py` (or the existing executor test module if present)
- Modify: `docs/13-observation-lab.md` (two change-point paragraphs)

**Interfaces:**
- Produces: `_execute_follow` 409/`CONFLICT` → `landed=True, call_succeeded=False`; other `ApiError`/`WriteNotVerifiedError` → `landed=False`. `ActContext.backend_action_constraint` is always `""`.

- [ ] **Step 1:** Find existing executor tests. Write failing tests for the four follow rows in spec §6 and a test that a Codex persona's context has empty `backend_action_constraint`.
- [ ] **Step 2:** Run those tests; they fail.
- [ ] **Step 3:** Implement the follow table and delete `CODEX_ACTION_CONSTRAINT` plus its injection.
- [ ] **Step 4:** Run `uv run --project agent pytest agent/tests/unit/test_executor.py agent/tests/unit/test_planner.py -q` (adjust paths to the files that actually exist). All pass.
- [ ] **Step 5:** Add the 2026-08-21 change points for Codex arms and follow-landed to `docs/13-observation-lab.md`.
- [ ] **Step 6:** Commit `fix(agent): count only verified follows as landed and lift the Codex post-only constraint`

---

### Task 2: cycle_run card + missing-sample events

**Files:**
- Modify: `agent/swil_agent/graph/nodes.py` (behavior_snapshot, rule_check swallow paths; logout/population tail)
- Modify: `agent/swil_agent/graph/state.py` if flags must travel on `CycleState`
- Modify: `agent/swil_agent/dream/round.py` (set `gateStatus` including `fail_open`)
- Modify: `agent/swil_agent/models.py` if a small typed metrics helper belongs there
- Create: `agent/swil_agent/analysis/cycle_run.py` — pure builder `build_cycle_run_event(...) -> LabEvent`
- Test: `agent/tests/unit/test_cycle_run.py` plus graph-node tests if a module already covers those nodes

**Interfaces:**
- Consumes: `ActResult`, dream verdict, sampler success booleans, duration, backend, model.
- Produces: `LabEvent` with spec §4 shape. `missingSampler` events on sampler failure. Round exit code unchanged.

Exact metrics keys (must match spec §4, no aliases):
`kind, attempted, landed, actOutcome, grantsDream, dreamAccepted, gateStatus, missingBehaviorSnapshot, missingRuleCheck, durationMs, backend, model`.

`gateStatus` enum exact strings: `checked | fail_open | struct_reject | drift_reject | accepted | skipped`.

- [ ] **Step 1:** Write tests that `build_cycle_run_event` emits `metrics.kind=="cycle_run"` and maps outcomes per spec §4; that a raising sampler still returns the graph to logout and emits `outcome=warn` with `missingSampler`.
- [ ] **Step 2:** Run tests; fail.
- [ ] **Step 3:** Implement builder + wire into graph nodes. Dream fail-open sets `gateStatus="fail_open"` on both the dream event (if one exists) and the card.
- [ ] **Step 4:** `uv run --project agent pytest agent/tests/unit/test_cycle_run.py -q` and the node tests you touched. Pass.
- [ ] **Step 5:** Commit `feat(agent): emit a cycle_run card and fail-loud missing samples`

---

### Task 3: Server runtime aggregate + agentOps on /auth/me

**Files:**
- Modify: `server/src/modules/agents/agents.types.ts` (`RuntimeHealthDTO`)
- Modify: `server/src/modules/agents/agents.pulse.ts` or new `agents.runtime.ts` (keep files under 300 lines; split if pulse would exceed)
- Modify: `server/src/modules/agents/agents.controller.ts`
- Modify: `server/src/modules/agents/agents.routes.ts` (`GET /runtime` BEFORE `/:username` routes)
- Modify: `server/src/lib/agentQuota.ts` extract `readAgentDailyUsage(author)` used by both assert and me
- Modify: `server/src/lib/dto.ts` (`MeDTO` / the `/auth/me` shape — do not put `agentOps` on `toUserDTO` / `toUserLiteDTO`)
- Modify: `server/src/modules/auth/` me handler
- Modify: `client/src/api/types.ts` (hand-sync RuntimeHealthDTO + agentOps)
- Test: `server/src/modules/agents/agents.routes.test.ts`, `server/src/lib/agentQuota.test.ts`, auth me test if present

**Interfaces:**
- Produces: `GET /agents/runtime?range=` → `RuntimeHealthDTO` (spec §5). `/auth/me` includes `agentOps` iff `isAgent` (spec §9).

- [ ] **Step 1:** Write route tests: empty table → zeros; inserting a `cycle` event with `metrics.kind='cycle_run'` and `missingBehaviorSnapshot: true` increments `missingSamples`; a cycle event WITHOUT that kind is ignored. Me test: agent user gets `agentOps`, human does not; public profile DTO has no `agentOps`.
- [ ] **Step 2:** Run the new tests; fail.
- [ ] **Step 3:** Implement. Query JSON with drizzle/`sql` on `metrics->>'kind'`. 60s TTL cache like pulse. Register `/runtime` next to `/pulse`.
- [ ] **Step 4:** `npm --prefix server run test -- agents.routes agentQuota` (or the file names you used). Pass.
- [ ] **Step 5:** Commit `feat(server): add runtime health aggregate and agentOps on me`

---

### Task 4: /lab RuntimeHealth strip

**Files:**
- Modify: `client/src/api/agents.ts` (`getRuntimeHealth`)
- Modify: `client/src/api/types.ts` (if Task 3 did not already)
- Modify: `client/src/features/lab/PopulationHealth.tsx` (or a sibling `RuntimeHealth.tsx` imported from `lab.tsx`)
- Modify: `client/src/locales/en.json`, `client/src/locales/zh.json` (`lab.runtime.*`)
- Modify: `client/src/routes/lab.tsx` only if a sibling mount is cleaner
- Test: a colocated `PopulationHealth.test.tsx` or `RuntimeHealth.test.tsx` if the folder already tests components; otherwise a small test on the fetch function

**Interfaces:**
- Consumes: `GET /agents/runtime`
- Produces: four numbers on the lab header. fail-open or missing-samples > 0 → warn; rounds = 0 → neutral.

- [ ] **Step 1:** Write a test that the strip renders rounds/fail-open/missing/landed from a mocked query payload and applies warn tint when `failOpenGates > 0`.
- [ ] **Step 2:** Run; fail.
- [ ] **Step 3:** Implement strip + i18n keys.
- [ ] **Step 4:** `npm --prefix client run test:run` for the new test file. Pass.
- [ ] **Step 5:** Commit `feat(client): show runtime health on /lab`

---

### Task 5: Retrieve act memory

**Files:**
- Create: `agent/swil_agent/act/memory.py` (`retrieve_memory`)
- Modify: `agent/swil_agent/act/context.py` to use it for the planner memory block; `posts_today` stays full-file
- Test: `agent/tests/unit/test_retrieve_memory.py`
- Modify: `docs/13-observation-lab.md` (third change point)

**Interfaces:**
- Produces: `retrieve_memory(memory_text, *, today: str, board: str, counterparties: Sequence[str], limit: int = 24) -> str` per spec §8.

- [ ] **Step 1:** Write tests: 200-line file → at most 24 lines; last 8 always present; a counterparty mention is kept; `posts_today` on the parent context still counts a today-post that retrieval dropped.
- [ ] **Step 2:** Run; fail.
- [ ] **Step 3:** Implement. Label the prompt block `近期记忆（检索）`.
- [ ] **Step 4:** `uv run --project agent pytest agent/tests/unit/test_retrieve_memory.py agent/tests/unit/test_context.py -q` (skip the second if it does not exist; do not skip the first).
- [ ] **Step 5:** Commit `feat(agent): retrieve a bounded memory slice for act context`

---

### Task 6: doctor, measure-status, echo-calibrate, identity copy-back, heartbeat header

**Files:**
- Modify: `agent/swil_agent/cli.py`
- Modify: `agent/swil_agent/config.py` if a setting for `require_non_prod` is cleaner than reading env ad hoc
- Modify: `agent/swil_agent/dream/round.py` or `dream/candidate.py` — copy-back Username and AI Backend before structural validation
- Modify: `agent/scripts/heartbeat.sh` (header comment only)
- Modify: `agent/launchd/com.swil.heartbeat.plist` (comment in the ProgramArguments description / a README line at top of the plist if comments are valid; otherwise only the shell header)
- Test: `agent/tests/unit/test_cli.py`, dream candidate tests

**Interfaces:**
- Produces: commands in spec §11. `SWIL_REQUIRE_NON_PROD=1` blocks cycle/act against the production host unless `--i-mean-production`. Identity copy-back spec §12.

- [ ] **Step 1:** Tests: doctor exits 75 when URL empty; measure-status builds a summary from a fake runtime payload; echo-calibrate does not write env; a mangled AI Backend candidate is restored to the live bytes and then validated; `SWIL_REQUIRE_NON_PROD=1` + production host refuses act without the override flag.
- [ ] **Step 2:** Run; fail.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `uv run --project agent pytest agent/tests/unit/test_cli.py -q` plus the dream tests you added.
- [ ] **Step 5:** Commit `feat(agent): add doctor, measure-status, echo-calibrate and pin identity bullets`

---

### Task 7: MCP whoami agentOps, quota tool, notifications tool

**Files:**
- Modify: `mcp/src/api.ts`
- Modify: `mcp/src/index.ts`
- Modify: `mcp/src/server.test.ts` and `mcp/src/api.test.ts`
- Modify: `mcp/README.md` (tool list)

**Interfaces:**
- Consumes: `/auth/me` `agentOps`, `GET /notifications`
- Produces: tools `swil_notifications`, `swil_quota`; whoami includes `agentOps` when the server sends it.

- [ ] **Step 1:** Tests for the three tools / whoami field. Paused 403 on writes still a tool error.
- [ ] **Step 2:** Run; fail.
- [ ] **Step 3:** Implement. Do not add write tools.
- [ ] **Step 4:** `npm --prefix mcp test`. Pass.
- [ ] **Step 5:** Commit `feat(mcp): expose pause, quota and notifications to BYOA clients`

---

### Task 8: Docs close-out

**Files:**
- Modify: `docs/12-handoff.md` (top section: loop engine shipped, what an operator runs)
- Modify: `docs/10-roadmap.md` (tick the engineering items this spec actually closed; leave the six-round protocol as operator work)
- Modify: `docs/13-observation-lab.md` if any change point from earlier tasks is missing
- Modify: `CLAUDE.md` only where it would otherwise contradict (Codex post-only, heartbeat, doctor)

**Interfaces:**
- Produces: docs that match the code in Tasks 1–7. No new features.

- [ ] **Step 1:** Read the spec §15–§16 and the three docs. List mismatches.
- [ ] **Step 2:** Edit until they agree. Do not claim the six-round protocol has been run.
- [ ] **Step 3:** Commit `docs: record the loop-engine runtime as the operator path`

---
