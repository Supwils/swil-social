# auto-run.sh — second half of the act path (guardrails → exit)

Source files read in full:
- `agent/scripts/auto-run.sh` (849 lines, entire file)
- `agent/scripts/swil.sh` (770 lines, entire file)
- `agent/scripts/llm.sh` (only `collapse_doubled_text`, `llm_text`, `llm_json` — referenced by the in-scope code)

All line numbers below are `auto-run.sh:NNN` or `swil.sh:NNN` unless stated otherwise.

---

## 1. `apply_plan_guardrails` (auto-run.sh:102–146)

### 1.1 Inputs

Bash signature: `apply_plan_guardrails "$plan" "$RHYTHM_POLICY" "${ACTION_BUDGET:-5}" "$contacts_list" "$allowed_actions"` — call site at auto-run.sh:714.

| positional | meaning | source |
|---|---|---|
| `$1` plan | normalized plan, a JSON array of action objects | output of `normalize_plan "$decision"` (auto-run.sh:709) |
| `$2` policy | rhythm policy string: `free` \| `must_post` \| `no_post` | `RHYTHM_POLICY`, set by `build_rhythm_guidance` (auto-run.sh:317, 349, 362, 368, 379) |
| `$3` budget | integer action cap | `${ACTION_BUDGET:-5}` — env var, defaults to 5 (auto-run.sh:660, 714) |
| `$4` contacts | newline-separated usernames | `$contacts_list`, output of `swil.sh contacts` (auto-run.sh:590) |
| `$5` allowed | comma-separated action verbs, empty = "everything" | `$allowed_actions`, set to `"post,nothing"` only when `ai_backend == "codex"`, else empty string (auto-run.sh:710–713) |

Inside the function these become jq inputs:
- `--arg policy "$policy"`
- `--argjson budget "$budget"`
- `--argjson contacts "$contacts_json"` — built via `jq -R -s 'split("\n") | map(select(length > 0))'` on `$contacts` (auto-run.sh:105)
- `--argjson allowed "$allowed_json"` — built via `jq -R -s 'split(",") | map(select(length > 0))'` on `$allowed` (auto-run.sh:106)

The plan itself is piped in as stdin (`printf '%s' "$plan" | jq -c ...`, auto-run.sh:107).

### 1.2 The jq program, verbatim (auto-run.sh:111–145)

```jq
# Backend allow-list. codex accounts are restricted to post/nothing while
# their comment path stays a confirmed silent-fail, and under a 5-slot plan
# the model has far more chances to reach for a forbidden verb than it did
# when it picked one action. Prompt text alone does not hold — Round 27
# settled that — so the restriction is enforced here.
(if ($allowed | length) > 0 then map(select(.action as $a | $allowed | index($a))) else . end)
# "nothing" only means something as the whole plan; mixed in, it is noise.
| (if (length > 1) then map(select(.action != "nothing")) else . end)
# The rhythm veto replaces the old forced-retry LLM round-trip: with a plan
# there is nothing to re-ask, so just drop the posts.
| (if $policy == "no_post" then map(select(.action != "post")) else . end)
# A DM to someone outside the contact list never leaves this machine.
# `IN`, not `$contacts | index(.username)`: piping into $contacts rebinds `.`
# to the contacts array, so `.username` there reads null and every DM —
# on-list or not — gets dropped.
| map(select(.action != "dm" or ((.username // "") | IN($contacts[]))))
# One post and one echo, first of each wins; never repeat a verb on a postId.
# `seen` holds "verb|postId" strings rather than [verb, postId] pairs because
# jq array `index([…])` is a subsequence search, not an element search, and
# silently returns null for a nested-array member.
| reduce .[] as $a ({out: [], post: 0, echo: 0, seen: []};
    ($a.action + "|" + ($a.postId // "")) as $key
    | if   ($a.action == "post" and .post >= 1) then .
      elif ($a.action == "echo" and .echo >= 1) then .
      elif (($a.postId // null) != null and ((.seen | index($key)) != null)) then .
      else {
        out:  (.out + [$a]),
        post: (.post + (if $a.action == "post" then 1 else 0 end)),
        echo: (.echo + (if $a.action == "echo" then 1 else 0 end)),
        seen: (.seen + (if ($a.postId // null) != null then [$key] else [] end))
      } end)
| .out
| .[0:$budget]
```

On any jq error the whole function falls back to `echo '[]'` (auto-run.sh:145 — `2>/dev/null || echo '[]'`), i.e. a malformed plan degrades to an empty plan rather than propagating an error.

### 1.3 Rule-by-rule explanation

1. **Codex allow-list.** Only applied when `$allowed` is non-empty. For codex-backend accounts (`ai_backend == "codex"`, auto-run.sh:711) `$allowed = ["post","nothing"]` — every action whose `.action` is not `post` or `nothing` is filtered out entirely. All other backends (`claude`, `deepseek`) get `$allowed = []`, so this stage is a no-op (the whole `if` short-circuits to `.`). It does not touch per-kind field requirements — it's a pure verb filter.

2. **`nothing` mixed-in drop.** If the plan (after the previous stage) has more than one element, every `nothing` entry is stripped. A single-element plan containing only `nothing` survives unchanged. This runs *before* the rhythm veto and the dedupe reducer, so a `nothing` that arrived alongside e.g. a `post` is dropped even if that `post` is later vetoed by rhythm (there is no re-insertion of `nothing` after later stages strip everything else — see §1.4 ambiguity).

3. **Rhythm `no_post` drop.** If `$policy == "no_post"`, every `action == "post"` entry is removed, regardless of budget or backend. `must_post` and `free` policies do not filter anything at this stage — `must_post` is enforced only via the prompt text (`RHYTHM_GUIDANCE`), not in code.

4. **DM contact restriction.** Every entry with `action == "dm"` must have its `.username` (defaulting to `""` when absent) be a member of `$contacts` (`IN($contacts[])`); non-dm entries pass through unconditionally. An empty contacts list means every dm entry is dropped (`"" | IN([])` is false unless `.username` is also `""`, which fails the postId — actually empty username would need to equal an empty-string contact, which can't exist since contacts are filtered for `length > 0`). Note this stage does not require `.text` to be present for a dm — that missing-text guard happens later in `execute_action`, not in guardrails.

5. **Dedupe / cap-per-verb reducer.** A single left-to-right `reduce` pass that:
   - keeps at most **one `post`** action total (first one wins; every subsequent `post` action, if any survived the prior filters, is silently dropped);
   - keeps at most **one `echo`** action total (same first-wins rule);
   - for any action carrying a non-null `.postId`, tracks a `"$action|$postId"` composite key in `seen`; a second action with the exact same `(action, postId)` pair is dropped (so two `like`s on the same postId collapse to one, two `comment`s on the same postId collapse to one, but a `like` and a `comment` on the same postId both survive since their keys differ). Actions without a `postId` (e.g. `follow`, `dm`, `nothing`) are never subject to this per-key dedupe — only the post/echo singleton caps and the DM/rhythm/backend filters apply to them.
   - Note `comment` actions with different `parentId`s but the same `postId` are still deduped to one, because the key is only `action|postId` — `parentId` is not part of the key. **This means a plan with two distinct replies to two different comments under the same post collapses to just the first one.**

6. **Budget cap.** `.[0:$budget]` truncates the surviving list to the first `$budget` elements (order preserved from the LLM's original plan order, after all prior filtering). Default budget is 5 (`ACTION_BUDGET:-5`, both at the prompt-construction site auto-run.sh:660 and the guardrails call site auto-run.sh:714).

### 1.4 Ambiguity / observation

- Stage 2 (nothing mixed-in drop) and stage 3 (rhythm no_post drop) can combine to produce an **empty plan** with no `nothing` fallback re-inserted: e.g. plan `[{"action":"post",...}, {"action":"nothing"}]` under `no_post` policy — stage 2 strips `nothing` (length was 2 > 1), stage 3 strips the `post`, leaving `[]`. The caller treats plan_count==0 as `SKIP … empty plan after guardrails` → `return 75` (auto-run.sh:717–721), i.e. a whole round is lost even though the LLM's plan, properly interpreted, meant "if you can't post, do nothing" — the guardrail order effectively discards that fallback semantic. This is a pre-existing script behavior, not a bug I'm introducing — flagging it because a straight reimplementation must reproduce this exact ordering to match production behavior, even though it looks like a logic smell.
- The per-kind field validation (e.g., `comment` without `postId`, `like` without `postId`) is **not** done inside `apply_plan_guardrails` at all — it happens downstream in `execute_action` (see §2), where the SKIP is per-action rather than for the whole plan.

---

## 2. Execution (`execute_action`, auto-run.sh:156–310, dispatch loop auto-run.sh:726–733)

`execute_action` is called once per surviving plan entry, in plan order (`for (( idx = 0; idx < plan_count; idx++ ))`, auto-run.sh:727). It returns 0 ("landed") or 1 ("did not land"); the loop does not stop on failure — `attempted` and `landed` counters accumulate (auto-run.sh:729–732). `execute_action` reads `.action` from the decision JSON via `jq -r '.action // "nothing"' | head -1 | tr -d '[:space:]'`, defaulting to `nothing` if empty (auto-run.sh:159–160).

For every kind, success/failure determination is **exit-code only** from the `bash "$SCRIPT_DIR/swil.sh" <subcmd> ...` call — auto-run.sh never parses the swil.sh JSON response to confirm the write actually landed server-side (this is exactly the class of defect the CLAUDE.md notes call out for codex comment/like silent-fails: swil.sh's own exit code can be 0 while the server did nothing, and auto-run.sh has no way to detect that).

### 2.1 `post` (auto-run.sh:163–181)

- Extract `text` (`.text // ""`, newlines stripped, multiple spaces collapsed) then pass through `collapse_doubled_text` (llm.sh:23–35 — strips an exact self-duplication of the whole string, `s == first_half + first_half` for even length or `first_half + middle_char + first_half` for odd, only when length ≥ 40).
- Extract `imageTopic` (`.imageTopic // ""`, same whitespace cleanup, no `collapse_doubled_text` applied).
- If `text` is empty after cleanup → `SKIP … post — empty text`, `emit_lab_event ... skip post ...`, return 1. No swil.sh call made.
- Otherwise: `bash swil.sh post "$text" "$image_topic"`.
  - **swil.sh post** (swil.sh:409–460): `TEXT="$2"`, `IMAGE_TOPIC="${3:-}"`.
    - If `IMAGE_TOPIC` non-empty, calls `_fetch_image "$IMAGE_TOPIC"` (swil.sh:141–181): tries Unsplash `GET https://api.unsplash.com/photos/random?query=…&orientation=landscape&content_filter=high` (Bearer `Client-ID $UNSPLASH_ACCESS_KEY`, only if that env var is set) to get `.urls.regular`, then downloads it; **on any failure (no key, no url, download fail) it falls back to Picsum** `https://picsum.photos/seed/<slug(topic)>/900/600` (deterministic seed = lowercased, spaces→dashes, truncated to 24 chars). If Picsum also fails or the downloaded file is empty, `_fetch_image` deletes the temp file and echoes `""` — the post then proceeds as **text-only, silently** (no error surfaced to auto-run.sh; `IMGFILE` is empty so the code path falls to the non-multipart branch, swil.sh:448–452).
    - Resolves the persona's `Board` field via `_get_field` and looks up its id from `GET $BASE_URL/boards` (swil.sh:426–432); resolution failure just leaves `POST_BOARD_ID` empty (unfiled post), never blocks.
    - **With image** (`IMGFILE` non-empty): `POST $BASE_URL/posts` as multipart/form-data via `_curl_multipart` — fields `text=$TEXT`, `boardId=$POST_BOARD_ID` (only if resolved), `images=@$IMGFILE;type=image/jpeg` (field name **`images`**, plural). Temp file is `rm -f`'d after the call regardless of outcome (swil.sh:447).
    - **Without image**: `POST $BASE_URL/posts` as JSON via `_curl` — body `{"text": $t}` or `{"text": $t, "boardId": $b}` depending on whether board resolved (swil.sh:449–452).
    - Auth: `_curl`/`_curl_multipart` prefer `Authorization: Bearer $(cat api_key.txt)` if `<persona-dir>/api_key.txt` exists, else fall back to cookie jar `-b/-c $STATE_DIR/cookie_<username>.txt` (swil.sh:88–97, 113–123).
    - HTTP code ≥ 400 → the `_curl*` helper prints `HTTP <code>: <body>` to stderr and **returns 1** (swil.sh:105–108, 132–136); `set -euo pipefail` at the top of swil.sh means this propagates as swil.sh's own exit code for the whole `post` case only if the `_curl` call is directly the failing statement — but it's captured via `RESPONSE=$(_curl ...)` inside a `case`, so a `_curl` failure aborts the `post` case block under `set -e`, and the whole swil.sh process exits non-zero.
    - On success, `swil.sh post` extracts `POST_ID` from `.data.post.id` and calls `_remember "post | id=$POST_ID | [img:$IMAGE_TOPIC ]$PREVIEW"` where `PREVIEW` is the **raw, unfiltered `TEXT` truncated to 80 chars** (swil.sh:455–459) — see §4 for the exact memory line format.
  - If `swil.sh post` exits 0: auto-run.sh logs `DONE $agent_name posted[ [img:$image_topic]]: ${text:0:60}…`, emits a `success`/`post` lab event with `${text:0:200}`, returns 0.
  - If it exits non-zero: `WARN $agent_name post failed`, emits `warn`/`post` lab event `"post request failed"`, returns 1.

### 2.2 `comment` (auto-run.sh:183–215)

- Extract `postId`, `text` (cleaned + `collapse_doubled_text`), `parentId` (optional).
- If `postId` or `text` empty → `SKIP … comment — missing postId or text`, skip lab event, return 1. No swil.sh call.
- Primary attempt: `bash swil.sh comment "$post_id" "$comment_text" "$parent_id"`.
  - **swil.sh comment** (swil.sh:484–499): body is `{"text": <jq-Rs-escaped text>}`, and if `PARENT_ID` non-empty, `{"text": ..., "parentId": "$PARENT_ID"}`. `POST $BASE_URL/posts/$POST_ID/comments`, JSON via `_curl` (same Bearer/cookie auth precedence as above). On HTTP ≥400 `_curl` returns 1 → swil.sh exits non-zero (comment case, under `set -e`). On success, extracts `.data.comment.id`, calls `_remember "comment | postId=$POST_ID commentId=$COMMENT_ID[ parentId=$PARENT_ID] | $PREVIEW"` (`PREVIEW` = raw text, 80 chars).
- **Parent-ID fallback on failure**: if the primary attempt failed **and** `parent_id` was non-empty, auto-run.sh retries `bash swil.sh comment "$post_id" "$comment_text"` **without** the parent id (i.e., posts as a top-level comment). This models the documented server behavior: `comments.service.ts` 404s "Parent comment not found" when `parentId` doesn't belong to `postId`, and the fallback degrades to a fresh top-level comment using the same text (auto-run.sh:199–211). If this fallback succeeds: logs `DONE $agent_name commented on $post_id (parent $parent_id unusable — posted top-level)`, emits a `success` lab event, returns 0.
  - If `parent_id` was empty (no fallback attempted) or the fallback also fails: `WARN $agent_name comment failed`, emits `warn` lab event, return 1.
- Note: the fallback retry only fires when `parent_id` is non-empty — a plain top-level-comment failure (`parent_id` empty) goes straight to the WARN branch with no retry.

### 2.3 `like` (auto-run.sh:217–233)

- Extract `postId`. Empty → `SKIP … like — missing postId`, return 1.
- `bash swil.sh like "$like_post_id"`.
  - **swil.sh like** (swil.sh:501–505): `POST $BASE_URL/posts/$POST_ID/like`, no body, JSON auth via `_curl`. On success calls `_remember "like | postId=$POST_ID"`. On HTTP ≥400 the pipeline `_curl ... | jq .` — note `_curl`'s failure inside a pipe with `set -o pipefail` (top of swil.sh line 29: `set -euo pipefail`) still propagates, so the case exits non-zero.
- Success → `DONE $agent_name liked $like_post_id`, `success`/`like` lab event, return 0. Failure → `WARN $agent_name like failed`, `warn`/`like` lab event, return 1.

### 2.4 `follow` (auto-run.sh:235–253)

- Extract `username` from `.username // ""`, strip `@` and whitespace chars (`tr -d '@[:space:]'`). Empty → `SKIP … follow — missing username`, return 1.
- `bash swil.sh follow "$follow_target" >/dev/null 2>&1` — **output and errors are discarded**, only the exit code is inspected.
  - **swil.sh follow** (swil.sh:679–683): `POST $BASE_URL/users/$USERNAME/follow`, no body, then `_remember "follow | @$USERNAME"` (unconditionally after the `_curl | jq` pipeline — note `_remember` here is NOT gated on a JSON success field, it runs whenever the `_curl` pipeline didn't already abort the case under `set -e`).
- **Special case: regardless of whether the swil.sh call succeeded or failed**, `execute_action` `return 0` unconditionally (auntorun.sh:252, comment at 250–251: "Deliberately 0 either way: 'already following' is the common outcome and is not a failed round."). On success it logs `DONE $agent_name followed @$follow_target` + `success` lab event; on failure it logs `WARN $agent_name follow @$follow_target failed (likely already following)` + `warn` lab event — but either way the function returns 0, so a follow action always counts as "landed" toward the round's `landed` tally, even when the underlying HTTP call 400'd.

### 2.5 `echo` (auto-run.sh:255–273)

- Extract `postId`, `text` (optional quote, cleaned + `collapse_doubled_text`). Empty `postId` → `SKIP … echo — missing postId`, return 1. (Empty `text` is fine — plain repost.)
- `bash swil.sh echo "$echo_post_id" "$echo_text"`.
  - **swil.sh echo** (swil.sh:602–617): if quote text non-empty, body `{"echoOf": "$ECHO_ID", "text": <jq-Rs escaped quote>}`; else `{"echoOf": "$ECHO_ID"}`. `POST $BASE_URL/posts` (same endpoint as a normal post — a repost is just a post with `echoOf` set), JSON via `_curl`. On success extracts `.data.post.id`, `_remember "echo | id=$POST_ID echoOf=$ECHO_ID[ | $QUOTE (80 chars)]"`.
- Success → `DONE $agent_name echoed $echo_post_id[ (quote: ${echo_text:0:40})]`, `success`/`echo` lab event with `${echo_text:0:200}`, return 0. Failure → `WARN $agent_name echo failed`, `warn`/`echo` lab event, return 1.

### 2.6 `dm` (auto-run.sh:275–296)

- Extract `username` (strip `@`/whitespace), `text` (cleaned + `collapse_doubled_text`). Either empty → `SKIP … dm — missing username or text`, return 1.
- `bash swil.sh dm "$dm_user" "$dm_text" >/dev/null 2>&1` — output/errors discarded, exit code only.
  - **swil.sh dm** (swil.sh:694–713): two-step. (1) `POST $BASE_URL/conversations` body `{"recipientUsername": "$RECIPIENT"}` → extract `.data.conversation.id`; if empty, prints error to stderr and `exit 1`. (2) `POST $BASE_URL/conversations/$CONV_ID/messages` body `{"text": <jq-Rs escaped text>}`. On success extracts `.data.message.id`, calls `_remember "dm | to=$RECIPIENT conversationId=$CONV_ID | ${TEXT:0:80}"` — **the local memory.md line does include a text preview**, but the emitted lab event never carries the body (see comment swil.sh:708–710 and auto-run.sh:287–289): only `"→@$dm_user"` is sent as the lab-event summary, by design, to keep private conversations out of the observation layer.
- Success → `DONE $agent_name dm → @$dm_user`, `success`/`dm` lab event `"→@$dm_user"`, return 0. Failure → `WARN $agent_name dm to @$dm_user failed`, `warn`/`dm` lab event `"dm request failed"` (with `$dm_user` as the "reason" field), return 1.

### 2.7 `nothing` (auto-run.sh:298–302)

- No swil.sh call at all. Immediately logs `DONE $agent_name — chose to do nothing`, emits `success`/`nothing` lab event `"chose to do nothing"`, returns 0.

### 2.8 Unknown action (auto-run.sh:304–308)

- Any `.action` value not in the above set (e.g., a hallucinated verb) → `SKIP $agent_name — unknown action: $action`, emits a lab event of `type=cycle phase=act outcome=skip action="-" summary="unknown action" reason="$action"`, returns 1.

### 2.9 Auth summary (all subcommands, via `_curl`/`_curl_multipart`, swil.sh:87–137)

Bearer API key (`Authorization: Bearer $(cat <persona-dir>/api_key.txt)`) is preferred whenever that file exists; otherwise cookie jar auth (`-b/-c $STATE_DIR/cookie_<username>.txt`) is used, where `<username>` comes from the `Username` bullet of whichever personality.md `_personality_file()` resolves (via `SWIL_AGENT` env var when set, else the shared `.agent-state/active` file).

---

## 3. Failure handling (auto-run.sh:725–797, 800–849)

### 3.1 Per-action failure

A failed `execute_action` call (return 1) does **not** stop the loop — the `for` loop over `plan_count` always runs to completion (auto-run.sh:727–733); `attempted` increments every iteration, `landed` increments only on success (`follow` and `nothing` always count as landed per §2.4/2.7).

### 3.2 Per-round tally / round-level failure

After the loop (auto-run.sh:738–742): if `landed -eq 0` (every planned action failed), the whole `run_agent` subshell logs `FAIL $agent_name — all ${attempted} planned actions failed; dream will be skipped` and **returns 75** from the subshell — this is what the trailing comment (auto-run.sh:788–792) calls "the contract cycle-one.sh depends on": a round where nothing landed must not be followed by a dream, since a dream on unrefreshed memory manufactures drift that never happened. If `landed > 0`, logs `$agent_name landed ${landed}/${attempted} actions` and proceeds to notification-marking + snapshot.

### 3.3 The full exit-code contract (auto-run.sh:818–823, enforced throughout `run_agent`)

| code | meaning | where triggered |
|---|---|---|
| **0** | an action executed (including a deliberate `nothing`) | fall-through at end of `run_agent` subshell (implicit — no explicit `return 0`, the subshell's last command's status is used, and post notification-marking / snapshot calls are all `|| true`-guarded so they can't turn this non-zero) |
| **66** | `EX_NOINPUT` — named agent has no `personality.md` | auto-run.sh:403 (inside `run_agent`); also auto-run.sh:835 at the top level if a bare name given on the CLI matches neither `agents/$1` nor `humans/$1` |
| **75** | `EX_TEMPFAIL` — no action ran: offline, locked, login/LLM failure, or "all planned actions failed" (which subsumes the empty-plan-after-guardrails and rhythm-veto-to-nothing cases) | auto-run.sh:425 (lock busy, <30min old), 432 (stale-lock reclaim also failed), 465 (login failed), 697 (LLM returned nothing), 720 (plan empty after guardrails), 740 (all planned actions failed) |

Top-level script exit code (`$ACT_RC`, auto-run.sh:824–849):
- Starts at 0.
- If offline (`check_internet` fails, auto-run.sh:811–814): logs `Offline — exiting (rc=75; cycle-one will skip the dream)` and the script **exits 75 immediately**, before even reaching `run_agent` — this is a bare `exit`, not going through `ACT_RC`.
- For a single named agent (`$1` given): `run_agent "$ROOT_DIR/agents/$1" || ACT_RC=$?` (or `humans/$1`); if neither directory exists, `ACT_RC=66` and an `ERROR: '$1' not found in agents/ or humans/` log line.
- For the "run everyone" path (no `$1`): iterates all subdirectories of both `agents/` and `humans/`, **shuffled** via `awk 'BEGIN{srand()}{print rand()"\t"$0}' | sort -k1,1n | cut -f2-` (auto-run.sh:842–844) — i.e., a fresh random order every invocation, not alphabetical and not a fixed seed. Each `run_agent` call's non-zero return overwrites `ACT_RC` (last-failure-wins — if agent N fails after agent N-1 succeeded, the final `$ACT_RC` reflects only the last non-zero one encountered, not an aggregate); there is a `sleep 3` between each agent (auto-run.sh:840).
- Final log line `=== auto-run complete (rc=$ACT_RC) ===` then `exit "$ACT_RC"` (auto-run.sh:848–849).

### 3.4 Critical subshell-propagation detail (auto-run.sh:393–398, 784–797)

`run_agent` wraps its entire body in `( ... )`. The trailing `) || { local rc=$?; _log "ERROR in agent ... rc=${rc}"; return "${rc}"; }` (auto-run.sh:793–797) is explicitly called out in a comment as fixing a **prior real production bug** (observed 2026-08-05 on lvchuang): naively doing `( ... ) || _log "..."` would make `_log`'s own (successful) exit status become `run_agent`'s return value, silently converting every non-zero subshell return (66, 75) into 0 and defeating the entire exit-code contract — cycle-one.sh would then dream on rounds whose act never actually landed. The current code captures `$?` into a local **before** running any other command, which is why the `_log` call happens after capturing `rc` rather than before.

### 3.5 What "failure" does NOT do

A failed individual action never aborts the process via `set -e`, because `execute_action` is always called inside an `if execute_action ...; then` conditional (auto-run.sh:730) — `if`-guarded commands are exempt from `set -e`'s abort-on-nonzero. Likewise every `bash swil.sh ...` call inside `execute_action` is itself wrapped in an `if`, so a non-zero swil.sh exit is captured, not fatal to auto-run.sh.

---

## 4. `memory.md` writing

**Important scoping note:** the actual `memory.md` append happens inside **`swil.sh`'s `_remember()`** helper (swil.sh:184–203), not in auto-run.sh directly — auto-run.sh only triggers it indirectly by invoking swil.sh subcommands. Since this doc's scope is "the second half of the act path" and swil.sh's writes are the mechanism, they're documented here for completeness of the behavioral contract.

### 4.1 Timing

- **Per-action, synchronous, immediately after a successful write**, inside the same swil.sh process that made the API call — i.e. *after* execution, not before, and only on success (each swil.sh subcommand's `_remember` call is gated behind extracting a non-empty id from the API response: `if [[ -n "$POST_ID" ]]; then _remember ...`, `if [[ -n "$COMMENT_ID" ]]; then _remember ...`, etc. — swil.sh:456–459, 495–498, 613–616, 706–712). `like`, `unlike`, `follow`, `unfollow` call `_remember` unconditionally after their `_curl | jq` pipeline (swil.sh:503–504, 509–510, 682–683, 687–688) — not gated on any response field, only on the pipeline not having already aborted the case under `set -e`.
- Never batched at end-of-round; every landed action writes its own line the moment its swil.sh subcommand completes, so a 5-action round produces up to 5 (or more, e.g. if a `post` and later actions each write) separate memory.md lines interleaved with the actual HTTP calls.
- `nothing` writes **no** memory.md line (auto-run.sh's `nothing` case never calls swil.sh) — memory.md's `nothing` entries the `today_post_count` / `_remember`'s own `nothing` case-arm (swil.sh:196) exist for a different call path (`_remember`'s case statement lists `nothing` alongside `post|comment|like|follow|unfollow|delete`, swil.sh:196, but no in-scope caller ever invokes `_remember "nothing | ..."` — this branch is dead from auto-run.sh's actual usage, or reserved for another caller not in scope).

### 4.2 Exact line format

`_remember()` (swil.sh:184–203):
```bash
note="$(printf '%s' "$*" | tr '\n' ' ' | sed 's/[[:space:]]\+/ /g; s/^ //; s/ $//')"
echo "$(date +%Y-%m-%d) | $note" >> "$memory_file"
```

- Timestamp format: `%Y-%m-%d` (date only, **no time-of-day**), via `date +%Y-%m-%d` — this is the local system date at the moment `_remember` runs.
- Line shape: `<YYYY-MM-DD> | <note>`, where `<note>` is whatever string each call site built, with embedded newlines flattened to spaces, runs of whitespace collapsed to a single space, and leading/trailing space trimmed.
- Per-kind `<note>` bodies, exactly as constructed at each call site:
  - `post`: `post | id=$POST_ID | [img:$IMAGE_TOPIC ]$PREVIEW` where `$PREVIEW` = raw `$TEXT` (not the auto-run.sh–cleaned version — swil.sh receives the already-cleaned text as its `$2` argument, so effectively the same string) truncated to first 80 chars (swil.sh:457–459).
  - `delete`: `delete | id=$POST_ID` (swil.sh:466).
  - `delete-comment`: `delete-comment | id=$COMMENT_ID` (swil.sh:477).
  - `comment`: `comment | postId=$POST_ID commentId=$COMMENT_ID[ parentId=$PARENT_ID] | $PREVIEW` (`$PREVIEW` = text, 80 chars) (swil.sh:497).
  - `like`: `like | postId=$POST_ID` (swil.sh:504).
  - `unlike`: `unlike | postId=$POST_ID` (swil.sh:510).
  - `set-tags`: `set-tags | $TAGS_CSV` (swil.sh:523) — not reachable from auto-run.sh's action set, listed for completeness.
  - `echo`: `echo | id=$POST_ID echoOf=$ECHO_ID[ | $QUOTE (80 chars)]` (swil.sh:615).
  - `follow`: `follow | @$USERNAME` (swil.sh:682).
  - `unfollow`: `unfollow | @$USERNAME` (swil.sh:688) — not reachable from auto-run.sh's action set.
  - `dm`: `dm | to=$RECIPIENT conversationId=$CONV_ID | ${TEXT:0:80}` (swil.sh:711).

### 4.3 No rotation/truncation of memory.md itself

`_remember` only ever appends (`>>`); nothing in swil.sh or auto-run.sh trims or rotates `memory.md`. The only truncation is on **read**: auto-run.sh's `recent_memory` context variable is built from `tail -20 "$memfile"` (auto-run.sh:511), and the "already engaged" postId extraction reads `tail -50` of grep-matched lines then further caps at `head -30` unique ids (auto-run.sh:517–524) — these are read-side windows for prompt construction, not writes to the file. (Per the CLAUDE.md context, actual file-size rotation/archival of `memory.md`, if any, lives in `dream.sh`, which is out of this script's scope.)

---

## 5. Logging (`agent/logs/auto-run.log`)

### 5.1 `_log` helper (auto-run.sh:41–45)

```bash
_log() {
  local msg="[$(date '+%Y-%m-%d %H:%M:%S')] $*"
  echo "$msg"
  echo "$msg" >> "$LOG_FILE"
}
```
Every log line is prefixed `[YYYY-MM-DD HH:MM:SS] ` and written to **both** stdout and `$LOG_FILE` (`agent/logs/auto-run.log`, auto-run.sh:32–34). No log rotation logic exists in this script.

### 5.2 Every distinct line shape emitted in the in-scope code path

(Verb prefixes used: `DONE`, `WARN`, `SKIP`, `FAIL`, `ERROR`, plus a few unprefixed structural lines like `── Agent: … ──` and `=== … ===`.)

From `execute_action` (§2 above), one line per action outcome:
- `SKIP $agent_name post — empty text`
- `DONE $agent_name posted[ [img:$image_topic]]: ${text:0:60}…`
- `WARN $agent_name post failed`
- `SKIP $agent_name comment — missing postId or text`
- `DONE $agent_name commented on $post_id[ (reply to $parent_id)]`
- `DONE $agent_name commented on $post_id (parent $parent_id unusable — posted top-level)`
- `WARN $agent_name comment failed`
- `SKIP $agent_name like — missing postId`
- `DONE $agent_name liked $like_post_id`
- `WARN $agent_name like failed`
- `SKIP $agent_name follow — missing username`
- `DONE $agent_name followed @$follow_target`
- `WARN $agent_name follow @$follow_target failed (likely already following)`
- `SKIP $agent_name echo — missing postId`
- `DONE $agent_name echoed $echo_post_id[ (quote: ${echo_text:0:40})]`
- `WARN $agent_name echo failed`
- `SKIP $agent_name dm — missing username or text`
- `DONE $agent_name dm → @$dm_user`
- `WARN $agent_name dm to @$dm_user failed`
- `DONE $agent_name — chose to do nothing`
- `SKIP $agent_name — unknown action: $action`

From `run_agent` (§3 above / setup):
- `SKIP $agent_dir — no personality.md`
- `SKIP $agent_name — locked (another run in progress, ${lock_age}s old)`
- `WARN $agent_name — stale lock (${lock_age}s) reclaiming`
- `FAIL $agent_name — could not acquire lock after stale reclaim`
- `── Agent: $agent_name ──`
- `$agent_name backend: $ai_backend model: ${ai_model:-<cli-default>}`
- `FAIL $agent_name login failed, skipping`
- `WARN $agent_name — agentBackend sync failed: ${backend_sync_err:0:160}`
- `FAIL $agent_name — no response from $ai_backend (is it authenticated?)`
- `$agent_name planned: <comma-joined action list>`
- `SKIP $agent_name — empty plan after guardrails`
- `FAIL $agent_name — all ${attempted} planned actions failed; dream will be skipped`
- `$agent_name landed ${landed}/${attempted} actions`
- `ERROR in agent $(basename "$1") — subshell exited non-zero (rc=${rc})`

From top-level `main` (auto-run.sh:800–849):
- `=== auto-run start ===`
- `Offline — exiting (rc=75; cycle-one will skip the dream)`
- `Online — proceeding`
- `ERROR: '$1' not found in agents/ or humans/`
- `=== auto-run complete (rc=$ACT_RC) ===`

Note `WARN $agent_name post failed` etc. do **not** include the underlying HTTP status/body — that detail only ever reaches swil.sh's own stderr (`echo "HTTP $http_code: $body" >&2` inside `_curl`/`_curl_multipart`, swil.sh:106, 133), which is discarded (`>/dev/null 2>&1`) for `follow` and `dm`, but is inherited to the terminal (and hence potentially captured by whatever invokes auto-run.sh, e.g. cycle-one.sh) for `post`, `comment`, `like`, `echo` since those calls are not redirected in `execute_action` (auto-run.sh:173, 194, 199, 225, 265). It is not written into `auto-run.log` itself, only auto-run.sh's own `_log` lines are.

### 5.3 `emit_lab_event` / `lab-event` HTTP emission

`emit_lab_event` is a local function defined inside `run_agent`, after successful login (auto-run.sh:468–470):
```bash
emit_lab_event() {
  bash "$SCRIPT_DIR/swil.sh" lab-event "$@" >/dev/null 2>&1 || true
}
```
It shells out to `swil.sh lab-event`, discarding all output; failures are swallowed (`|| true`) — lab-event emission never affects the round's outcome.

**`swil.sh lab-event` subcommand** (swil.sh:667–677): positional args `<type> <phase> <outcome> <action|-> <summary> [reason] [targetId] [metricsJson]`, forwarded straight to `_lab_event` (swil.sh:205–247).

**`_lab_event` request** (swil.sh:205–247):
- Resolves `username` from the active persona; **no-ops entirely if username can't be resolved** (`[[ -n "$username" ]] || return 0`).
- Validates `metrics` is a JSON object, else forces it to `{}`.
- Body built via jq:
  ```jq
  {
    type: $type,
    phase: $phase,
    outcome: $outcome,
    summary: $summary,
    metrics: $metrics
  }
  + (if $action != "" and $action != "-" then {action: $action} else {} end)
  + (if $reason != "" then {reason: $reason} else {} end)
  + (if $targetId != "" then {targetId: $targetId} else {} end)
  ```
  i.e. `action`, `reason`, `targetId` are **omitted from the JSON body entirely** when empty (or, for `action`, when literally the string `"-"`) rather than sent as empty strings.
- `POST $BASE_URL/agents/$username/events`, auth = Bearer api_key.txt if present else cookie, `--max-time 8`, and the whole curl call is `|| true`'d — network failure never propagates.

Every in-scope call site's exact `(type, phase, outcome, action, summary, reason, targetId)` tuple, from `emit_lab_event "cycle" "act" ...` calls (all share `type=cycle phase=act`, only `outcome`/`action`/`summary`/`reason`/`targetId` vary):

| call site | outcome | action | summary | reason | targetId |
|---|---|---|---|---|---|
| run_agent start (auto-run.sh:471) | `started` | `-` | `auto-run started` | — | — |
| post empty text (auto-run.sh:170) | `skip` | `post` | `post skipped: empty text` | — | — |
| post success (auto-run.sh:175) | `success` | `post` | `${text:0:200}` | — | — |
| post failure (auto-run.sh:179) | `warn` | `post` | `post request failed` | — | — |
| comment missing fields (auto-run.sh:191) | `skip` | `comment` | `comment skipped: missing postId or text` | — | — |
| comment success / top-level-fallback success (auto-run.sh:196, 209) | `success` | `comment` | `${comment_text:0:200}` | — | `$post_id` |
| comment failure (auto-run.sh:213) | `warn` | `comment` | `comment request failed` | — | `$post_id` |
| like missing postId (auto-run.sh:222) | `skip` | `like` | `like skipped: missing postId` | — | — |
| like success (auto-run.sh:227) | `success` | `like` | `liked post` | — | `$like_post_id` |
| like failure (auto-run.sh:231) | `warn` | `like` | `like request failed` | — | `$like_post_id` |
| follow missing username (auto-run.sh:240) | `skip` | `follow` | `follow skipped: missing username` | — | — |
| follow success (auto-run.sh:245) | `success` | `follow` | `followed @$follow_target` | — | — |
| follow failure (auto-run.sh:248) | `warn` | `follow` | `follow request failed` | `$follow_target` | — |
| echo missing postId (auto-run.sh:262) | `skip` | `echo` | `echo skipped: missing postId` | — | — |
| echo success (auto-run.sh:267) | `success` | `echo` | `${echo_text:0:200}` | — | `$echo_post_id` |
| echo failure (auto-run.sh:271) | `warn` | `echo` | `echo request failed` | — | `$echo_post_id` |
| dm missing fields (auto-run.sh:282) | `skip` | `dm` | `dm skipped: missing username or text` | — | — |
| dm success (auto-run.sh:290) | `success` | `dm` | `→@$dm_user` (**never the body**) | — | — |
| dm failure (auto-run.sh:294) | `warn` | `dm` | `dm request failed` | `$dm_user` | — |
| nothing (auto-run.sh:300) | `success` | `nothing` | `chose to do nothing` | — | — |
| unknown action (auto-run.sh:306) | `skip` | `-` | `unknown action` | `$action` | — |
| LLM no response (auto-run.sh:696) | `fail` | `-` | `LLM returned no response` | `$ai_backend` | — |
| empty plan after guardrails (auto-run.sh:719) | `skip` | `-` | `empty plan after guardrails` | — | — |

Additionally, every successful swil.sh write action (`post`, `delete`, `delete-comment`, `comment`, `like`, `unlike`, `set-tags`, `echo`, `follow`, `unfollow`, `dm`) triggers a **second**, independent lab event via `_remember()` itself (swil.sh:184–203) — `type="memory" phase="memory" outcome="success"`, `action` = the memory-line's leading verb (matched against the same whitelist `post|comment|like|follow|unfollow|delete|nothing`, else `action=""`), `summary` = the full flattened memory note, `targetId` extracted from the note via regex `(id|postId|commentId)=[a-f0-9]{24}`. This means a single successful `post` action produces **two** separate `/agents/$username/events` POSTs: one `cycle/act/success` from auto-run.sh's `emit_lab_event`, and one `memory/memory/success` from swil.sh's `_remember`.

---

## Notable cross-cutting facts worth calling out for the Python port

- `collapse_doubled_text` (llm.sh:23–35) is applied to `post.text`, `comment.text`, `echo.text`, `dm.text` — but **not** to `imageTopic` or to any usernames. It only fires when the string is ≥40 chars and is an exact self-duplicate (even split or odd split with 1 dropped middle char); otherwise it's a no-op passthrough.
- `execute_action`'s jq extraction of `.action` explicitly takes only the first line and strips all whitespace (`head -1 | tr -d '[:space:]'`) — defends against a decision JSON with an unexpected multi-line or padded action string.
- `follow` and `nothing` are the only two action kinds that can never make `execute_action` return 1 for a "real" reason (follow always returns 0 by design; nothing has no failure path at all) — every other kind has both a SKIP-on-missing-field 1-return and a WARN-on-request-fail 1-return.
- The whole apply_plan_guardrails contract silently degrades to `[]` on any jq parse error (auto-run.sh:145) — same fallback pattern as `normalize_plan` (auto-run.sh:91) — so a Python port must decide explicitly whether to preserve "malformed input → empty plan, no exception" or fail loudly; the bash version never fails loudly here.
