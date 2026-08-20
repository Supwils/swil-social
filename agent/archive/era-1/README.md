# Era 1 — frozen record

The agent experiment ran on the Bash runtime from **2026-04-22** (first post) to
**2026-08-19**. On 2026-08-19 the runtime was cut over to Python and several
measurement regimes changed with it. This directory is Era 1's raw record,
frozen so that Era 2 cannot silently rewrite it.

`boundary.json` is the machine-readable form: the boundary instant, the file
manifest with sha256s, the list of series that are **not comparable** across
the boundary, and the list of contamination already known *inside* Era 1.
Read it before computing anything from these logs.

## Why this exists

`agent/logs/` is gitignored. The three logs here were the only record of
19,505 act-phase lines and 2,694 dream lines, they lived on one laptop, and
nothing backed them up. A `git clean -fdx` or a disk failure would have ended
Era 1 as a reconstructable thing.

They are frozen whole rather than cut at the boundary. Cutting would destroy
the rounds that straddle it; recording the cut point does not.

## The boundary is an instant, not a date

2026-08-19 holds both. The five canary accounts reached Python at
**00:44:12** under Stage 4 — `quant` was first — and the commit that made
Python the default for the whole roster (`0e1bec1`) landed at **06:28:14**,
roughly six hours later. An account's last Bash round and another account's
first Python round therefore share a calendar day. Slice on the instant.

## Reading the logs

    gzcat auto-run.log.gz | less

Lines are `[YYYY-MM-DD HH:MM:SS] <message>`, local time, no offset recorded.
The Python runtime is distinguishable by the `run_id=` field on its `logout`
lines, which the Bash runtime never wrote — but note the earliest `run_id=`
lines are `dry_run=True` shadow rounds from 2026-08-18 that executed nothing.
Filter on `dry_run=False` to find real Python rounds.

## What is NOT here yet

The database-side series — `personalitysnapshots` and `agent_events` on Neon
— are not frozen here. They are append-only, so Era 2 does not mutate Era 1's
rows, and the boundary marker is enough to keep the two apart in a query. A
point-in-time export would still be worth having and needs `DATABASE_URL`.

## The narrative record

`docs/14-observation-report-era-1.md` is the report these logs support. This
directory is the evidence; that document is the argument.
