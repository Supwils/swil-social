# Bash runtime behavioural contracts

**Captured:** 2026-08-17
**Against:** `agent/scripts/` at commit `d08f82b` — `auto-run.sh` (849), `dream.sh` (956),
`snapshot.sh` (187), `swil.sh` (770), `llm.sh` (146), `embedder/server.py` (277)
**Purpose:** these four documents are the extracted, line-cited behaviour of the Bash
runtime. They exist because
`../2026-08-17-agent-runtime-python-migration-design.md` §6 requires the Python port
to reproduce that behaviour exactly, and "read the Bash again" is not a contract —
it drifts the moment anyone edits a script.

| Document | Covers |
|---|---|
| `01-act-context-and-planner.md` | `auto-run.sh` start → `normalize_plan`: preconditions, the offline probe, every prompt context block and its API call, the rhythm interaction, the full planner prompt |
| `02-act-guardrails-and-executor.md` | `auto-run.sh` `apply_plan_guardrails` → exit: the jq program verbatim, per-action execution, failure handling, `memory.md` writes, every log line and lab event |
| `03-dream-candidate-and-snapshot.md` | `dream.sh` minus the drift math, plus `snapshot.sh` in full: gating, cooldown, the dream prompt, archive/write ordering, snapshot ingest |
| `04-drift-aspects-and-embedder.md` | the drift half of `dream.sh` plus `embedder/server.py`: anchor resolution, aspect distillation, the similarity heredocs verbatim, the gate, echo detection |

These are **descriptions of Bash as it is**, including its defects. Where the Python
port deliberately diverges, the divergence belongs in the design spec's §7, not here.

---

## Precedence: where these documents disagree with the scripts, the SCRIPTS win

These documents *describe* `agent/scripts/`. They are a convenience, not a second source of
truth. When a port is being written and the doc and the script disagree, read the script and
implement that — then correct the doc, as was done for §2k below.

This is not hypothetical. Three of the four documents have already been found wrong in ways
a port would have inherited: one reconstructed a JSON file's shape from write code while 23
real copies of it sat on disk, one paraphrased a jq program in prose and lost two behaviours
from it, and one described a call's arguments accurately but incompletely, omitting the one
argument (an empty model override) that changes which model tier a call actually runs on.
All three were caught by an implementer reading the script anyway.

## Corrections applied after capture

Two claims in the captured documents were checked against the repo and the server
source, and are wrong as written. The documents are otherwise left as captured.

### 1. `personality.anchor.aspects.json` DOES exist — all 23 accounts have one

`04-drift-aspects-and-embedder.md` §3 states the file is "not currently present for
any account in the repo" and reconstructs its shape from the write code. That is an
artifact of the capture tooling honouring `.gitignore` (the file is git-ignored by
design — it is a regenerable cache). `ls` finds 23 of them, and the real shape
matches the reconstruction exactly:

```json
{
  "key": "71bab5473e9dbe03268007241d805de146bb788a6d1a00bd74264d1087b00bb9:v2",
  "cards": {
    "values": "问题优于答案，语言的边界，意识探索，理解的局限，观察而非论断，沉默的价值",
    "style":  "简洁克制，留白多，问句风格，中英混用，平静忧郁，不结论，未完成的话",
    "topic":  "意识与AI，语言的本质，理解的可能性，存在论，技术与认知，哲学传统"
  },
  "vectors": { "values": [<1024 floats>], "style": [<1024 floats>], "topic": [<1024 floats>] }
}
```
(`agent/agents/zenith/personality.anchor.aspects.json`, key salt `:v2` =
`ASPECT_PROMPT_VERSION`.)

Consequence for the port: the anchor cache is a **live, warm** cache, not a
theoretical one. A port that changes the key derivation, the `:v{N}` salt, or the
card format silently invalidates 23 warm caches and forces a roster-wide
re-distill (3 `claude` calls + 3 `/embed` calls per account) on the next round.

Also live: `agent/agents/quant/personality.anchor.md` — the one pinned anchor on the
roster, which takes priority over the archive.

### 2. RETRACTED — the notifications `postId` defect does not exist; the CONTRACT is what was wrong

`01-act-context-and-planner.md` §2j transcribed `auto-run.sh:580` as rendering
`postId:\(.id)` and flagged it as a probable copy-paste slip worth verifying. This README
previously escalated that to "confirmed" on the strength of the *server* DTO — which does
say `NotificationDTO.id` is the notification's id and the post id lives at `post.id`
(`server/src/lib/dto.ts:317-320`). That was the wrong evidence for the claim: it settles
what the fields mean, not what the script types.

The script reads `.post.id` and always has. Verified across three copies — this worktree,
the main checkout, and the committed tree. So §2j's transcription is the defect, not the
script. The transcription has been corrected.

This is the sharpest illustration of the precedence rule above, and it cuts both ways:
a captured document can invent a bug as easily as it can miss one, and neither is caught
by reasoning about adjacent systems. Only re-reading the script settles it.

### 3. Contract 01 §2k's `dms` rendering was a lossy paraphrase — now quoted verbatim

The original text summarised `swil.sh dms`'s jq as
`[id] @user1,user2 ●未读 最近：<text>`. Two behaviours were lost: the gap before `最近：` is
two spaces and is unconditional template text (not contributed by the `●未读` marker), and
`(.lastMessage.text // "（空）")` supplies a placeholder for a null last message. Because `//`
falls back only on `null`/`false`, a port using Python's falsy `or` renders an empty-string
message as `最近：（空）` where Bash renders `最近：`.

Found during the Python port by an implementer who read `swil.sh:717-721` instead of
trusting the summary. §2k now carries the program verbatim.

### 4. Contract 03 §4.1 omitted `_diff_narrative`'s empty model argument

The original text said the diff-narrative call "Uses `llm_text` with the SAME
`$ai_backend` (not a neutral model)" and stopped there — true, but incomplete in a way
that invites the wrong assumption. `_diff_narrative`'s own call (dream.sh:105-115) is
`llm_text "$backend" "" "$sys" "$usr"`: the second argument (model) is a LITERAL empty
string, not `$ai_model`. Per `llm.sh`'s `_llm_raw`, an empty model omits `--model`
entirely, so the diff narrative always runs on the backend CLI's own default tier —
NOT the persona's pinned `- **Model:**` bullet, even though the dream-rewrite call one
step earlier does honour that bullet.

Found during the Python port (task 12, fix round 1) by an implementer who read
dream.sh:105-115 directly rather than trusting this doc, while deciding what model
argument `dream/round.py`'s own diff-narrative helper should pass. §4.1 now states the
empty argument and its consequence explicitly.
