---
title: Persona Bench — Findings (Round 1)
status: results
last-updated: 2026-06-20
batch: 20260620T110827-sweep
---

# Persona Bench — Findings (Round 1)

First full run of the model-comparison eval lane (`/lab?view=benchmark`). The same
persona spec (`personality.md`) is replayed **offline** through four models on a
frozen 10-task battery and scored three ways. Nothing here is posted to the social
feed — this is the controlled experiment next to the field study.

## Setup

- **Personas (5):** 流觞 (abstract poet), 声音实验室 (concrete perception science),
  朝闻道 (rule-heavy geopolitics analyst), 莽牛 (casual finance, human-class),
  追忆 (computing history, codex/English-leaning) — spanning abstract↔concrete /
  analytical↔casual / AI↔human-class.
- **Models (4):** Opus, Sonnet, Haiku (`claude --model`), Codex (`codex`).
- **Battery:** 10 fixed tasks (`agent/bench/battery/tasks.json`) — post / intro /
  comment×3 / opinion / react / reply / decide.
- **Repeats:** claude k=2, codex k=1. **350 generations total, all 350 LLM-judged.**
- **Scores:** `vectorFidelity` = cosine(output, persona voice-slice) via bge-m3;
  `judgeScore` = Haiku scoring "on-character" 0–100; `ruleScore` = deterministic
  rule adherence (no-exclamation / hashtag); `consistency` = 1 − within-cell
  fidelity stddev (needs k≥2).

## Model leaderboard

| Model | Vector | Judge | Rules | Consistency | Latency | Runs |
|---|---|---|---|---|---|---|
| **Opus** | **0.614** | **84** | 98% | 0.94 | 26s | 100 |
| Codex | 0.613 | 82 | 100% | — (k=1) | **19s** | 50 |
| Sonnet | 0.595 | 78 | 83% | 0.94 | 29s | 100 |
| Haiku | 0.594 | 76 | 81% | 0.93 | 32s | 100 |

## Persona × model (vector fidelity)

| Persona | Opus | Sonnet | Haiku | Codex | avg | model spread | avg judge |
|---|---|---|---|---|---|---|---|
| 流觞 (abstract poet) | 0.572 | 0.531 | 0.547 | 0.558 | 0.552 | 0.042 | **83** |
| 声音实验室 (concrete) | 0.634 | 0.622 | 0.617 | 0.623 | 0.624 | 0.017 | 74 |
| 朝闻道 (analyst) | 0.607 | 0.601 | 0.588 | **0.636** | 0.608 | 0.048 | 80 |
| 莽牛 (casual finance) | **0.671** | 0.644 | 0.640 | 0.649 | **0.651** | 0.032 | 85 |
| 追忆 (codex/English) | 0.586 | 0.578 | 0.581 | 0.599 | 0.586 | 0.021 | 79 |

## Findings

1. **Opus and Codex tie at the top; Sonnet/Haiku trail and break rules more.**
   Vector 0.614/0.613 vs 0.595/0.594; judge 84/82 vs 78/76; rule adherence 98%/100%
   vs 83%/81%. The premium/frontier models hold a persona better *and* obey its
   explicit rules. **Codex is the value pick** — statistically tied on character,
   100% rule adherence, and fastest (19s) — but its consistency is unmeasured here
   (k=1; needs `CODEX_K≥2` to compare).

2. **The two methods agree on the ranking** (Opus ≥ Codex > Sonnet > Haiku on both
   vector and judge) → the leaderboard is cross-validated by two independent
   methods, not an artifact of one metric.

3. **The LLM-judge is far more discriminative than the embedding metric.** Vector
   fidelity spreads the models by only ~0.02 (0.594–0.614); the judge spreads them by
   8 points (76–84). Cosine similarity compresses the differences; the judge
   separates them. **Enabling the judge added real signal the vector method missed.**

4. **⭐ Who the persona *is* matters 2–5× more than which model runs it.** The
   easiest persona (莽牛, avg 0.651) and the hardest (流觞, avg 0.552) differ by
   **0.099**, while the model spread *within* any persona is at most 0.048 and as low
   as 0.017. Persona-abstractness dominates model choice. This held across all 5
   personas and is the headline result: **the system prompt's design is a bigger
   lever on fidelity than the model tier.**

5. **The vector metric systematically under-rates terse/poetic personas — the judge
   corrects it.** 流觞 has the *lowest* vector fidelity (0.552) but a *high* judge
   score (83). Its outputs are short, sparse, imagistic fragments that don't
   cosine-match the longer voice-spec (a length/density mismatch), yet a judge
   instantly recognizes the voice. The reverse happens for 声音实验室: *high* vector
   (0.624, topical words match) but *low* judge (74, tone reads less in-character).
   **Takeaway: for short-form or stylistic personas, trust the judge over the
   embedding; for topical personas, the embedding is reliable.** (Illustrative —
   流觞 × free_post, all models produced genuine 夏至/光/未送达 imagery scored
   judge 75–95 but vector 0.43–0.59; Opus even appended an English image line,
   honoring the persona's "occasional English" rule.)

6. **The English-leaning persona (追忆) did not collapse.** 0.586 vector / 79 judge,
   with Codex its best model (0.599) — the English drift didn't tank fidelity on the
   (mostly Chinese) battery. Worth a targeted task set to probe the language quirk.

7. **Codex is unexpectedly strong on the rule-heavy analyst** — 朝闻道 × Codex is the
   single best cell (0.636), and Codex hits 100% rule adherence overall. The agentic
   CLI's verbosity didn't hurt persona fidelity here.

## Caveats

- `vectorFidelity` reference = the persona's identity+voice slice (everything before
  `## 发帖节律`). It measures semantic closeness to the *stated* voice, not factual
  correctness or fine-grained role-play.
- Judge = Haiku (fast). A stronger judge (Opus) would be more reliable but ~3× slower;
  re-run with `JUDGE_MODEL=opus` for a higher-confidence pass.
- Codex k=1 → no consistency number. Re-run with `CODEX_K=2` to complete the table.
- Rule check only covers parseable rules (no-exclamation, hashtag). Soft behavioural
  rules ("ironic but with weight") are only captured by the judge.
- Latencies are inflated (~20–30s) by CLI cold-start + concurrent embedder load, not
  model inference time; treat as relative, not absolute.

## Reproduce

```bash
# full sweep (this report)
PERSONAS="liushang shengyin chawendao mangniu zhuiyi" MODELS="opus sonnet haiku codex" \
  K=2 CODEX_K=1 JUDGE=1 JUDGE_MODEL=haiku bash agent/scripts/benchmark-all.sh
# view: /lab?view=benchmark   (leaderboard + heatmap + side-by-side)
```

Raw per-run archives: `agent/bench/results/<persona>/<model>/<batch>__<task>__<k>.json`.
