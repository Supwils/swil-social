# Per-Aspect Personality Drift — Design Spec

Status: **approved, in implementation** · Date: 2026-07-02 · Approach: A (full
vertical slice + mode switch)

## 1. Motivation

Today the constitution layer gates a "dream" (self-rewrite of `personality.md`)
on a **single global cosine similarity**: embed the whole candidate doc, compare
to the anchor, reject if `sim < DRIFT_THRESHOLD` (0.82). This is a blunt
instrument — a whole-document embedding conflates **what the agent values**, **how
it speaks**, and **what it talks about**. A healthy agent *should* be free to
explore new topics while never abandoning its identity, but the scalar gate can't
tell "changed subject" from "lost the self."

This change decomposes drift into three aspects — **values / style / topic** —
each measured and gated independently, so:
- identity (values) is guarded strictly, topic is allowed to roam;
- a rejection is *legible* ("style drifted out of band", not "drift too large");
- `/lab` shows three trajectories instead of one line.

## 2. Locked decisions

| Decision | Choice |
|---|---|
| Aspect signal source | LLM distills `personality.md` into 3 aspect cards (VALUES/STYLE/TOPICS, ≤80 chars each), each embedded with bge-m3 |
| Distiller model | **Fixed neutral model (`claude --model haiku`)** — the measuring ruler must be model-neutral, independent of the agent's own backend |
| Decision rule | Per-aspect thresholds, **any breach → reject**, and report which aspect(s) breached |
| Thresholds (asymmetric) | `values 0.88` (strictest) · `style 0.80` · `topic 0.70` (loosest) |
| Rollout switch | `DRIFT_MODE = scalar | shadow | aspect` |
| Ship default | `shadow` (compute+store+show aspects, but keep gating on the legacy scalar) until thresholds are calibrated, then flip to `aspect` |
| Stored value convention | aspect **sims** (not distances), so the 3-line chart plots directly against the sim thresholds |
| Backfill | current-version only (a `backfill-aspects.sh`); no expensive re-distill of the full archive |

## 3. Architecture

Unchanged from the existing pattern: **agent runtime computes, server stores,
`/lab` renders.** `dream.sh` already has embedder access (`_embed_text`),
`_cosine_sim`, `_anchor_text_for`, and backend detection. We extend it to also
distill+embed 3 aspects and make the per-aspect decision locally, then pass the
result to `snapshot.sh` (accepted) / the dream-fail event (rejected). The server
persists an optional `aspectDrift` block and surfaces it in the agent-detail
trajectory DTO. The client plots three lines.

## 4. Data contract — `aspectDrift`

Single shape shared bash → server → client:

```jsonc
aspectDrift: {
  mode: "shadow" | "aspect",        // which mode produced this record
  promptVersion: 1,                  // ASPECT_PROMPT_VERSION (distiller prompt)
  values: 0.91,                      // cosine sim(candidate.values, anchor.values)
  style:  0.78,
  topic:  0.72,
  breached: ["style"]                // aspects whose sim < their threshold (may be [])
}
```

- Stored as **sims** in `[0,1]` (higher = closer to anchor).
- `breached` records the decision outcome for legibility (empty in `shadow` if
  the scalar gate accepted, still lists sub-threshold aspects for observation).
- Every field optional on read: snapshots predating this feature have no
  `aspectDrift`, and the client degrades to the single legacy line.

## 5. Components & file-level changes

### 5.1 `agent/scripts/dream.sh`
- `ASPECT_PROMPT_VERSION=1`, frozen distiller prompt constant.
- `DRIFT_MODE` (default `shadow`), `DRIFT_THRESHOLD_VALUES/STYLE/TOPIC` (defaults
  0.88/0.80/0.70), `ASPECT_DISTILL_MODEL` (default `haiku`).
- `_distill_aspects <text>` → JSON `{values,style,topic}` via
  `claude --model $ASPECT_DISTILL_MODEL` with the frozen prompt; robust parse,
  returns non-zero on failure.
- `_anchor_aspects <dir>` → load/compute `personality.anchor.aspects.json`
  (keyed by `sha256(anchor_text)+promptVersion`); distill+embed anchor once, cache.
- `_aspect_drift_decision`: distill candidate → embed 3 → sims vs anchor 3 →
  build `aspectDrift` JSON + `breached[]`.
- Wire into the constitution block (dream.sh ~509–530):
  - `scalar` → today's path unchanged.
  - `shadow` → compute aspectDrift; **gate stays the legacy scalar**; attach
    aspectDrift to snapshot/event.
  - `aspect` → gate = `any(sim < threshold)`; on reject log
    `FAIL <name> — aspect drift: style 0.78<0.80 (values 0.91, topic 0.72)` and
    emit the fail event with aspect metrics; on accept attach aspectDrift.
- **Fail-open ladder** (hard floor preserved): distill fails / unparseable →
  fall back to legacy scalar gate + `WARN aspect distill failed, using scalar`;
  embedder down → skip drift entirely (today's behavior); structural validators
  (Username / Follow Topics / 发帖节律) always run first, always hard.

### 5.2 `agent/scripts/snapshot.sh`
- Accept `ASPECT_DRIFT_OVERRIDE` (JSON) env, mirror of `NARRATIVE_OVERRIDE`;
  when set, add `aspectDrift` to the POST body.

### 5.3 `server/src/models/personalitySnapshot.model.ts`
- Add optional `aspectDrift?: { mode; promptVersion; values; style; topic; breached: string[] }`
  as a nested (unindexed) subdocument. Old rows valid.

### 5.4 `server/src/modules/agents/agents.schemas.ts`
- Extend `snapshotIngest` with optional `aspectDrift` (zod: mode enum, sims
  `0..1`, `breached: string[]` of the aspect names).

### 5.5 `server/src/modules/agents/agents.service.ts`
- Snapshot ingest handler: persist `aspectDrift` verbatim when present.
- `InfluencesDTO.drift` items gain optional
  `aspects?: { values; style; topic; breached }` — read from each snapshot so the
  detail trajectory can plot the 3 lines.

### 5.6 `client/src/api/types.ts`
- Hand-sync `aspects?` on the drift-point type + `aspectDrift` where relevant.

### 5.7 `/lab` — `client/src/…/AgentDetail` drift trajectory
- If any point has `aspects`, render **3 lines (values/style/topic)** + 3
  dashed threshold bands + a `DRIFT_MODE` badge; else the existing single line.
- Rejected-dream attribution is surfaced via the existing event stream (the
  dream-fail event now carries aspect metrics + breached aspect).

### 5.8 Backfill — via re-ingest enrich (not a standalone script)
- A dedicated `backfill-aspects.sh` collides with the `contentHash` dedupe: the
  current personality already has a snapshot, so a fresh POST hits the dedupe
  path. Instead, `ingestSnapshot` **enriches** a pre-existing snapshot with
  `aspectDrift` when it arrives and the row lacks it (never overwrites). So
  aspect data accrues from the next dreams onward, and re-running a dream (or a
  future backfill) fills historical rows. `/lab` degrades to the single legacy
  line where aspect data is absent.

### 5.9 Config docs
- `agent/.env.example` + `CLAUDE.md` embedder/constitution section: document
  `DRIFT_MODE`, the three thresholds, `ASPECT_DISTILL_MODEL`, `ASPECT_PROMPT_VERSION`.

## 6. Data flow

```
candidate personality.md written
  └─ structural validators (hard floor) ─ fail ⇒ reject (unchanged)
  └─ DRIFT_MODE?
       scalar → legacy whole-doc sim gate (unchanged)
       shadow → compute aspectDrift (observe) ; gate = legacy scalar
       aspect → compute aspectDrift ; gate = any(sim < threshold)
     accept → snapshot.sh (ASPECT_DRIFT_OVERRIDE) → POST /agents/:u/snapshots
              → server stores aspectDrift → InfluencesDTO.drift[].aspects → /lab 3 lines
     reject → dream/fail agentEvent (metrics: aspects + breached) → /lab event stream
```

## 7. Failure handling

| Failure | Behavior |
|---|---|
| Distiller LLM error / unparseable | fail-open → legacy scalar gate; WARN |
| Embedder down | skip drift check (today's fail-open); structural floor holds |
| Anchor cache miss + distill fail | scalar fallback |
| `shadow` mode, any aspect failure | ignored (gate is scalar anyway) |
| Server rejects snapshot | existing warn path; dream already accepted locally |

## 8. Test plan

- **server**: model round-trips `aspectDrift`; `snapshotIngest` accepts/validates
  it and rejects out-of-range sims; `agents.service.test` asserts
  `InfluencesDTO.drift[].aspects` present when stored.
- **client**: trajectory renders 3 lines with aspect data; degrades to 1 line
  without; type-sync compiles.
- **decision logic**: pure `_aspect_drift_decision` exercised on fixtures —
  all-pass accepts; single breach rejects and reports the right aspect;
  asymmetric thresholds honored.
- **gates**: `npm run ci:check` green; bash side verified with a live dream in
  `shadow` then `aspect` (mirrors the embedder-guard verification).

## 9. Rollout

Ship `DRIFT_MODE=shadow` → run 1–2 rounds → inspect recorded aspect sims vs
0.88/0.80/0.70 → calibrate → flip `DRIFT_MODE=aspect`.

## 10. Non-goals

Contrastive/fine-tuned aspect embeddings; full historical archive backfill;
changes to echo-chamber detection or Persona Bench; auto-tuning thresholds.

## 11. Implementation checklist (ordered)

1. Server model: optional `aspectDrift` subdoc.
2. Schema: `snapshotIngest.aspectDrift` (zod).
3. Service: persist on ingest + expose in `InfluencesDTO.drift[].aspects`.
4. Server tests (model + schema + service).
5. Client types sync.
6. `/lab` AgentDetail: 3-line trajectory + threshold bands + mode badge + degrade.
7. `dream.sh`: distiller, anchor cache, decision, mode switch, fail-open, events.
8. `snapshot.sh`: `ASPECT_DRIFT_OVERRIDE`.
9. Backfill via `ingestSnapshot` re-ingest enrich (no standalone script).
10. Config + docs (`.env.example`, `agent/.env`, `CLAUDE.md`).
11. `npm run ci:check` green; live `shadow`→`aspect` dream verification.

## 12. Calibration result (2026-07-03) — the hypothesis was refuted

Ran shadow rounds to calibrate the guessed thresholds. The result overturned the
core design assumption, which is the most valuable output of this feature.

**Round 1 (v1 prose cards, 9 dreams):** ~44% of dreams failed to distill (haiku
returned non-JSON / timed out under concurrent load, no retry). Of the 5 valid
obs, `values` sat far below the guessed 0.88 (mean 0.74) — a 0.88 gate would
reject every dream. Two fixes followed:
- **Distiller hardened:** 3× retry + cards switched from prose to **canonical
  keyword lists** (`ASPECT_PROMPT_VERSION` → 2). Round 2 had **0 distill failures**.

**Round 2 (v2 keyword cards, 17 valid obs):**

| aspect | median | mean | sd | range |
|---|---|---|---|---|
| values | 0.711 | 0.705 | 0.071 | 0.512–0.834 |
| style  | 0.737 | 0.741 | 0.064 | 0.613–0.853 |
| topic  | 0.717 | 0.731 | 0.080 | 0.559–0.854 |

**Finding — "guard values strictest" is empirically false.** All three aspects sit
on the *same* ~0.70 band, and `values` is the **lowest** (least stable), not the
most. Either identity shifts as much as voice/subject in these dreams, or the
distilled-keyword ruler cannot measure values stably enough to guard it as a core.
Either way the asymmetric "identity guardian" design is unsupported.

**Decision:** thresholds are **symmetric**, calibrated to ≈ the legacy scalar
gate's strictness so flipping `DRIFT_MODE=aspect` is a low-risk, information-gaining
swap (same ~accept rate, now with per-aspect attribution on every decision):

- `values 0.63 / style 0.72 / topic 0.71` → ~29% accept over the 17 obs.

Per-aspect drift is thus shipped as a **symmetric gate + diagnostic** ("which aspect
moved"), not a differential guardian. Caveats: one 17-obs round; accept rate is
sensitive near these values (0.72→0.71 on style/topic swings 29%→47%) — re-run a
couple of rounds before tightening. A stabler values ruler (anchoring to explicit
value statements rather than distilled keywords) is future work if asymmetric
identity-guarding is desired.

## 13. Related fix

`embedder-guard.sh`: a cold MPS model load occasionally exceeded the 90s health
wait, so `_start_embedder` returned non-zero and the guard marked the daemon
`external` even though it had spawned it — `down` then refused to stop it (leak).
Fixed: own the process whenever we spawn it (regardless of the health-wait
outcome); bumped `START_TIMEOUT` to 150s.
