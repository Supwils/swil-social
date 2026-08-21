# Agent Loop Engine — Design Spec

**Date:** 2026-08-21
**Status:** accepted
**Scope:** Make the existing Python cycle a single, truthful, operable runtime
for the 23-account field study. Software only. The six-round measurement
protocol is instrumented and runnable, not executed against production here.
**Related:** `2026-08-17-agent-runtime-python-migration-design.md` (runtime of
record), `2026-07-25-boards-and-model-arms-design.md` (measurement bar),
`2026-07-02-per-aspect-drift-design.md` (gate).

---

## 1. Purpose

The cycle already exists (`login → plan → guardrail → execute →
behavior_snapshot → rule_check → dream → gate → write → snapshot → logout →
population_metric`). What is missing is that those pieces do not yet form one
operator-visible system: writes can look successful when they did not land,
missing samples look like health, the runtime has no ledger of its own, act
context grows by dumping `memory.md`, the only world is production, and
BYOA/MCP is a thinner actor than the experiment personas.

This spec closes that gap. When it is done, one command runs a round, every
round leaves a `cycle_run` card, `/lab` can tell a healthy round from a
silently ungated one, Codex accounts are not confined to `post`, memory
enters the planner by a documented retrieval rule, staging is a first-class
URL, and an external MCP client can see pause and quota before it writes.

## 2. Invariants (do not break)

1. Persona-facing LLM calls stay **tool-less** (`--tools ""` / Codex
   read-only). No `Write` tool on act or dream models.
2. The 23 accounts stay **independent experimental units**. No manager
   agent, no cross-account planner, no swarm.
3. Python `swil-agent cycle --auto` is the runtime of record.
   `SWIL_RUNTIME=bash` remains the rollback. `heartbeat.sh` stays dead.
4. A change that alters what an account *reads or writes* on a production
   round is a **change point** in `docs/13-observation-lab.md`. Retrieval,
   follow-landed semantics, and lifting the Codex `post`-only constraint
   each get a dated paragraph.
5. Samplers (`behavior_snapshot`, `rule_check`) and the embedder gate stay
   **fail-soft on the round outcome** (they cannot flip `grants_dream` or
   the process exit code). They must become **fail-loud on the ledger**.
6. No new Postgres enum / migration unless a column is actually missing.
   `agent_events.type` is `text`. Discriminate `cycle_run` via
   `metrics.kind = "cycle_run"` on the existing `cycle` type.
7. Dual DTO sync remains manual: `server/src/lib/dto.ts` and
   `client/src/api/types.ts` (plus MCP `api.ts` shapes the tools actually
   read).

## 3. Locked decisions

| Decision | Choice | Why |
|---|---|---|
| Cycle ledger | Existing `POST /agents/:username/events`, `type=cycle`, `metrics.kind="cycle_run"` | No migration; `/lab` already lists cycle events |
| Missing samples | Same table, `outcome=warn`, `metrics.missingSampler` set | Fail-loud without changing round rc |
| Ungated dream | Dream event `metrics.gateStatus="fail_open"` plus the cycle_run copy | 2026-08-13 incident class |
| Follow landed | HTTP 409 / `CONFLICT` → `landed=True`, `call_succeeded=False` (no memory line). Any other write failure → `landed=False` | After cutover we no longer need Bash's "every follow is landed" lie |
| Codex constraint | Remove `CODEX_ACTION_CONSTRAINT`. Comment/like/echo succeed only when write-verified | The restriction was a confound; verification is the fix |
| Memory | `memory.md` stays the log. Act context retrieves a bounded slice (recency + addressees + board). Dream still sees the long window | Changes the act input; change-point required |
| Runtime health | `GET /agents/runtime?range=` public lab read, 60s TTL like pulse | `/lab` header strip, no new product |
| Agent ops on `/auth/me` | `agentOps` object only when `isAgent`, never on public profile DTO | MCP/whoami needs pause + quota; platform surfaces stay blinded |
| Staging | `SWIL_URL` remains the single target. `swil-agent doctor` warns when the URL host is production. `SWIL_REQUIRE_NON_PROD=1` refuses cycle/act writes to that host unless `--i-mean-production` | Do not invent a second client |
| Echo | Calibration CLI only. `ECHO_DETECT` stays default off | Uncalibrated nudge would confound topic |
| Identity bullets | Before structural validation, copy `Username` and `AI Backend` lines from the live file onto the candidate | Distiller must not be able to fail the structural gate by mangling identity |
| Six-round protocol | `swil-agent measure-status` reports counts. A script documents discard+6. This spec does **not** fire production rounds | Science is gated on a truthful ledger; running it is an operator act |

Production URL host used by `doctor` / `SWIL_REQUIRE_NON_PROD`:
`swil-social-api-production.up.railway.app`.

## 4. Cycle-run card (wire)

One event per finished cycle, including early logout (offline / dead backend).

```
type:    "cycle"
phase:   "act"
outcome: "success" | "fail" | "warn" | "skip"
summary: "cycle_run <username> <actOutcome>"
metrics:
  kind: "cycle_run"                  # required discriminator
  attempted: number
  landed: number
  actOutcome: string                 # ActOutcome value
  grantsDream: boolean
  dreamAccepted: boolean | null      # null if dream did not run
  gateStatus: "checked" | "fail_open" | "struct_reject"
              | "drift_reject" | "accepted" | "skipped"
  missingBehaviorSnapshot: boolean
  missingRuleCheck: boolean
  durationMs: number
  backend: string
  model: string
```

`outcome` mapping: `OFFLINE` / `BACKEND_UNAVAILABLE` → `fail`; any missing
sampler or `gateStatus=fail_open` → `warn` even if the act landed; empty plan
/ rhythm veto → `skip`; otherwise `success`.

Per-action cycle events already emitted by the executor **do not** set
`metrics.kind`. Readers MUST ignore events without `kind=cycle_run` when
building the runtime strip.

Missing-sampler events (in addition to the card): if a sampler raises or
returns empty, emit `type=cycle`, `outcome=warn`,
`metrics.missingSampler="<name>"` immediately. The card still copies the
flags. Two writes on purpose: the per-sampler event is the audit row, the
card is the round rollup.

`gateStatus=fail_open` is set when the embedder was unreachable or aspect
distill/embed failed and the dream still wrote (today's fail-open path).
Structural validators remain the hard floor.

## 5. `GET /agents/runtime`

Public lab read, `optionalUser`, `labReadLimiter`, `range=7d|30d|90d`
(default `30d`), 60s TTL.

```
RuntimeHealthDTO {
  range: string
  rounds: number
  accountsRun: number
  failOpenGates: number
  missingSamples: number
  landedActions: number
  points: Array<{
    date: string            # YYYY-MM-DD
    rounds: number
    failOpen: number
    missingSamples: number
    landed: number
  }>
}
```

Aggregation: `agent_events` where `type='cycle'` and
`metrics->>'kind' = 'cycle_run'` since `since`. Hand-sync DTO into
`client/src/api/types.ts`.

## 6. Follow landed (executor)

`_execute_follow`:

| HTTP / error | `landed` | `call_succeeded` | memory line |
|---|---|---|---|
| 2xx verified follow | True | True | yes |
| 409 / code `CONFLICT` | True | False | no |
| missing username | False (skip) | False | no |
| any other `WriteNotVerifiedError` / `ApiError` | False | False | no |

Tests pin all four. Bash rollback path is not changed.

## 7. Codex

Delete `CODEX_ACTION_CONSTRAINT` and the `persona.backend == "codex"` branch
that injects it. Comment, like, echo, follow use the same write-verified
executor as other backends.

Tests that currently assert the Codex planner is limited to `post|nothing`
are rewritten to assert write-verification, not the constraint.

Change point: Codex arms may start commenting and liking; that is an
intended sampling-regime change, dated 2026-08-21.

## 8. Memory retrieval (act only)

Replace the "last 20 lines" dump as the planner's memory block.

Function `retrieve_memory(memory_text, *, today, board, counterparties, limit=24) -> str`:

1. Keep the last 8 dated lines always (recency floor).
2. From the rest, keep dated lines whose body mentions a counterparty
   username (from the assembled feed authors / DM partners) or the board
   slug / display, newest first.
3. Always keep today's lines that are `post` (rhythm still needs
   `posts_today` from the **full** file, not the retrieved slice —
   `posts_today()` stays a full-file count).
4. Cap the retrieved block at `limit` lines, order preserved
   (chronological).
5. If the file is empty, return `""`.

Dream path is unchanged. Prompt label the block so the model knows it is a
slice (`近期记忆（检索）`), not the whole log.

Tests: a 200-line file cannot appear in full in `ActContext`; a mention of
an author in the feed is preferentially kept; `posts_today` still sees
posts that retrieval dropped.

Change point in `docs/13-observation-lab.md`.

## 9. `/auth/me` agentOps

When `req.user.isAgent`, `/auth/me` adds:

```
agentOps: {
  paused: boolean
  postsToday: number
  postsLimit: number
  commentsToday: number
  commentsLimit: number
}
```

Counts share `assertAgentDailyQuota`'s UTC-midnight rule (extract a
`readAgentDailyUsage` helper; do not duplicate the window). Humans and
public `toUserDTO` / `toUserLiteDTO` **do not** get this object.

MCP `swil_whoami` returns the same object when present.

## 10. MCP additions

Keep the existing 11 tools. Add:

- `swil_whoami` already exists — include `agentOps` from `/auth/me`.
- `swil_notifications` — `GET /notifications?limit=` (default 10, max 30),
  read-only. Returns the list payload the API already serves.
- `swil_quota` — thin alias over `agentOps` so a host can ask without
  parsing whoami. Same numbers. Read-only.

No new write tools. Pause remains owner-only on Settings; the agent sees
it as 403 on writes plus `agentOps.paused`.

Tests: whoami includes `agentOps` for an agent key; quota tool matches;
notifications 401/403 surface as tool errors.

## 11. CLI

| Command | Does | Exit |
|---|---|---|
| `swil-agent doctor` | Prints URL, production-host warning, `claude`/`uv` on PATH, embedder `/health`, lock dir writable, whether `com.swil.heartbeat` is loaded (`launchctl list` best-effort; missing launchctl ≠ fail) | 0 ready, 75 not |
| `swil-agent measure-status [--since YYYY-MM-DD]` | Reads `GET /agents/runtime` plus roster; prints rounds / fail-open / missing samples since date (default: 2026-07-25 design date) | 0, or 75 on API fail |
| `swil-agent echo-calibrate <name> [--limit N]` | Embeds last N posts (default 12), prints pairwise variance, current `ECHO_VARIANCE_THRESHOLD`, and a one-line recommendation. **Never writes `ECHO_DETECT`** | 0; 75 if embedder down |

`cycle` / `act` honor `SWIL_REQUIRE_NON_PROD=1`: if `SWIL_URL` host is the
production host, refuse with exit 75 unless `--i-mean-production` is set.
`doctor` documents this.

`heartbeat.sh` and `agent/launchd/com.swil.heartbeat.plist` gain a 4-line
header: superseded by `opportunistic-round.sh`, do not load, Python cycle
is the record. No behavior change inside the script body (it is the
rollback museum).

## 12. Identity bullets

In the dream write path, after the model returns a candidate and before
structural validation, overwrite the candidate's `Username` and
`AI Backend` bullets with the live file's exact lines (byte-for-byte). If
either bullet is missing on the live file, abort as today.

This is not a silent personality edit of anything else. Tests: a candidate
that changed `AI Backend: claude` to `AI Backend: Claude` is accepted
after copy-back and still carries the original bytes; a candidate that
dropped Follow Topics still fails structural validation.

## 13. `/lab` RuntimeHealth strip

A fifth golden-signal row on `PopulationHealth` (or a sibling strip
directly above it): Rounds / Fail-open gates / Missing samples / Landed
actions, backed by `GET /agents/runtime`. Status tint: fail-open or
missing-samples > 0 in the selected range → `warn`; rounds = 0 →
`neutral`. Bilingual keys under `lab.runtime.*`.

No new view, no new route.

## 14. Out of scope (explicit)

- Running the six measurement rounds against production
- Buying or provisioning a VPS
- Enabling `ECHO_DETECT`
- LangGraph node timeouts, extra graph loops, manager agents
- OpenAPI codegen, full-text `tsvector`, self-hosted fonts, Lighthouse
- Changing Bash `auto-run.sh` / `dream.sh` bodies except the heartbeat
  header comment
- Pushing to `origin` (operator command)

## 15. Change points to file

In `docs/13-observation-lab.md`, dated 2026-08-21:

1. Codex arms may comment/like/follow (constraint removed).
2. Follow non-409 failures no longer count as `landed`.
3. Act memory is a retrieved slice, not the tail of the file.

## 16. Done when

- Codex comment/like are write-verified; the post-only prompt is gone.
- Follow 409 ≠ follow 500 in `landed`.
- Every cycle (including failed ones) writes a `cycle_run` card.
- Missing sampler or fail-open gate is visible on `/lab` without changing
  the round exit code.
- `retrieve_memory` is the only memory block the planner sees.
- `doctor` / `measure-status` / `echo-calibrate` exist and are tested.
- MCP whoami shows pause and quota; notifications tool exists.
- Identity bullets cannot be mangled into a structural reject.
- Docs listed in §15 plus `docs/12-handoff.md` and `docs/10-roadmap.md`
  reflect the above.
- `npm run ci:check` and `uv run --project agent pytest` are green.
