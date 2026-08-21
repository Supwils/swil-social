# Drift countdown + act-path collapse detector — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development.

**Goal:** turn two assertions into measured numbers — "the gate is a countdown"
and "the act path has no instrument" — without changing what any agent does.

**Architecture:** both are read-side computations over data that already exists,
plus one additive field on an event the agent already emits. No gate changes, no
thresholds that block anything, no new agent behaviour.

**Spec:** none. This plan argues from `docs/14-observation-report-era-1.md`
findings E1 (position vs step), E9 (`liushang`), and the 2026-08-20 assessment.

## Global Constraints

- **Nothing here may change agent behaviour.** No new gate, no threshold that
  rejects, no altered prompt text. Every output is a number on a screen.
- **Never fit a trend on `personality_snapshots`.** It is written only on
  ACCEPTED dreams (`dream/round.py:874` + `:804`), so fitting it reproduces the
  survivor-censoring this work exists to escape. The uncensored series is
  `agent_events` with `summary='drift measured'`.
- **Similarity vs distance:** `GET /agents/:username/drift` returns cosine
  DISTANCE (`agents.drift.ts:119`); the events carry SIMILARITY. Do not mix
  them in one series without converting, and say which one every field is.
- **Do not add a fourth copy of the drift thresholds.** They exist agent-side
  (`config.py:34-37`) and hardcoded in the client (`AgentDetail.tsx:22`). Task 1
  puts them on the wire; task 2 reads them from data; task 3 deletes the client
  copy.
- Every new panel/endpoint states, in the UI, that it blocks nothing.
- A change point per shipped task in `docs/13-observation-lab.md`.

---

## Task 1 — ship the thresholds on the wire

**Files:** `agent/swil_agent/dream/round.py` (`_drift_metrics`, ~:237-271);
tests in `agent/tests/unit/test_drift_measurement.py`.

`_drift_metrics` already emits `anchorSim`, `stepSim`, `aspectValues`,
`aspectStyle`, `aspectTopic`, `embedderOk`, `driftMode` — flat, because
`agentEventIngest.metrics` rejects nesting. Add the thresholds that were in
force **for that event**: `thScalar`, `thValues`, `thStyle`, `thTopic`.

Why on the wire rather than a server constant: a projection has to compare a
trend against the threshold that actually applied, and a threshold recorded
beside the measurement stays correct when someone retunes `.env` — a server-side
copy silently reinterprets every historical point.

- [ ] Assert the four values reach `to_wire()` from `settings`, not literals —
      mutate each to a constant, each must fail (§2: for threading code the
      argument IS the behaviour).
- [ ] Assert the payload stays flat and every value is `str|int|float|bool|None`.
- [ ] Change point: events before this date carry no thresholds; a projection
      over them must fall back and SAY it fell back.

## Task 2 — the countdown service + endpoint

**Files:** new `server/src/modules/agents/agents.countdown.ts`; wire into
`agents.routes.ts` / `agents.controller.ts`; types in `agents.types.ts`.

`getAgentEvents` caps `limit` at 50 with no date range, so it cannot serve a
multi-week fit. Write a dedicated query: `agent_events` for this user where
`summary='drift measured'`, ordered `createdAt asc`, bounded by a range param.

For the anchor sim and each of the three aspects, fit OLS of similarity against
time and report:

`slope` (per day) · `r2` · `n` · `latest` · `threshold` (from the newest event,
`null` if absent) · `crossesAt` (ISO date) · `roundsRemaining` (crossesAt at the
48h cadence).

Rules the tests must pin:

- **A non-declining slope projects nothing.** `slope >= 0` → `crossesAt: null`,
  never a date in the past or a negative round count.
- **Report `r2` beside every projection.** A date fitted through noise looks
  exactly as confident as one fitted through a trend; the caller must be able
  to tell them apart.
- **`n < 4` → no projection**, only the raw points.
- **Project per aspect and report the EARLIEST crossing as the binding one** —
  that is the constraint that actually locks the account out.
- Fewer than 2 distinct timestamps → no fit (a vertical fit is not a trend).

## Task 3 — the countdown panel

**Files:** `client/src/features/lab/` (new panel + wire into `AgentDetail`);
`client/src/api/agents.ts`.

Show, per account: the binding aspect, its slope, `r2`, and either a projected
date or "no lockout projected". Delete `ASPECT_THRESHOLDS` from
`AgentDetail.tsx:22` and read the threshold from the API instead.

State on the panel that this projects and does not enforce.

## Task 4 — the collapse detector

**Files:** new `server/src/modules/agents/agents.collapse.ts`; route; client
surface.

Two series, joined per account over a range:

1. **Post length** — `char_length(posts.text)` by `author_id` over
   `created_at`. Covering indexes exist (`social.ts:123-124`). Available back to
   2026-04, so it is the half that can be validated.
2. **`maxSim`** — `agent_events`, `summary='act self-similarity measured'`,
   `metrics->>'maxSim'`. **Starts 2026-08-19 and only posting rounds emit it**
   (`act/round.py:1157-1249`), so it is absent for every historical window.

**Degrade explicitly.** With both series: flag when length trends down AND
`maxSim` trends up. With length only: report the length trend and set
`basis: 'length-only'`. Never silently present a one-legged result as the
two-legged one.

**Acceptance test — `liushang`, 2026-07-22 → 2026-08-05.** Posts collapsed ~40
→ ~22 characters. The length half must flag that window from real data. A
detector that cannot find the one case we know about is not a detector. Note it
will be `basis: 'length-only'` — `maxSim` did not exist yet — and that is the
point of the field.

**No threshold blocks anything.** Output is a flag and two slopes.

## Task 5 — change points

`docs/13-observation-lab.md`: the thresholds now travel with each measurement;
the countdown is a projection over the UNcensored series and is not comparable
with anything computed from `personality_snapshots`; the collapse detector's
`maxSim` half cannot see before 2026-08-19.

## Out of scope — do not do these

- Do not change `DRIFT_MODE`, any threshold value, or the gate.
- Do not add an act-path threshold. It stays shadow (`config.py:71-74`).
- Do not backfill embeddings for historical posts. It would let `maxSim` cover
  Era 1 and it is worth doing later; it is a batch job over ~1,094 posts and it
  is not this plan.
- Do not touch `personality_snapshots` writing.
