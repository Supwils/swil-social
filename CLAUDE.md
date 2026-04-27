# CLAUDE.md

Guidance for Claude / Claude Code when working in this repository.

## Project at a glance

Swil Social — full-stack social platform with AI agents. TypeScript monorepo:

- **`server/`** — Express + Mongoose + Socket.IO + Vitest
- **`client/`** — React 18 + Vite + TanStack Query + Zustand + Vitest + Testing Library
- **`agent/`** — autonomous agent runtime (bash + Claude/Codex CLI)
- **`docs/`** — architecture / API / decisions

`docs/12-handoff.md` reflects the current state. Read it first for any
non-trivial task. `docs/09-contributing.md` covers the conventions you
must follow.

## ⚠ Mandatory before every commit and push

```bash
npm run ci:check
```

Runs all 8 steps that GitHub Actions runs:

1. Typecheck server + 2. client
3. Lint server + 4. client
5. Test server + 6. client (with coverage thresholds)
7. Build server + 8. client

Even with the local git hooks installed (`npm run install-hooks`), the
hooks run a *subset* per phase — pre-commit skips the build, pre-push
runs everything but only against the new commits. **Always run
`ci:check` manually** for any change touching:

- Build config (`vite.config.ts`, `tsconfig.json`, `manualChunks`)
- Dependencies (added or removed in any `package.json`)
- ESLint config or rules
- The CI workflow itself

Reason: removing a dep that was referenced only in a build-config string
(e.g. `manualChunks: ['cmdk']`) typechecks fine, but only `vite build`
catches the dangling reference. Don't ship that breakage.

## Conventions baked into hooks

- **commit-msg** — Conventional Commits enforced via commitlint.
  Bad: `update stuff`. Good: `feat(client): add post echo composer`.
  Allowed types: `feat fix docs style refactor perf test build ci chore revert`.
- **pre-commit** — typecheck + eslint + vitest. ~7s.
- **pre-push** — adds builds. ~30s. Mirrors CI exactly.
- **gitleaks** — runs in pre-commit / pre-push if installed locally
  (`brew install gitleaks`); always runs in CI as a hard gate.

Bypass any single hook with `--no-verify` — but never push without a
clean `ci:check` first.

## Code style enforced by tooling

- TypeScript strict mode. No `any` (lint error).
- Prettier: single quotes, trailing commas, 100-char width.
- ESLint:
  - `@typescript-eslint/no-unused-vars` with `_`-prefix escape
  - React hooks: `rules-of-hooks` error, `exhaustive-deps` warn
  - Empty catch is allowed (used for fire-and-forget telemetry)

Run `npm run lint:fix` and `npm run format` before opening a PR.

## File-layout rules

- Routes → `client/src/routes/`. One file per top-level path; sub-tabs
  go in a sibling folder (see `routes/explore/`).
- Server services use the `*.write.ts / *.read.ts / *.hydrate.ts`
  pattern when one file gets > 300 lines (see `modules/posts/`).
- Tests live next to the file they test (`foo.ts` + `foo.test.ts`).
- Shared types: `server/src/lib/dto.ts` and `client/src/api/types.ts`
  are kept manually in sync (no codegen yet — see roadmap).

## What not to do

- Don't add `console.log` in committed code. Use `logger` (server) or
  guard with `import.meta.env.DEV` (client).
- Don't add a new dependency without noting why in the commit body.
  Run `npm run knip` to make sure you're not adding a duplicate.
- Don't commit `.env`, `*.key`, or anything in `agent/agents/*/api_key.txt`
  (.gitignore blocks most; gitleaks catches the rest).
- Don't lower coverage thresholds to "make CI pass". Write the test or
  document the reason in the commit.
- Don't bypass `commit-msg` to dodge Conventional Commits. The format
  feeds the changelog and makes git log searchable.

## Useful commands

```bash
# Setup
npm run install:all          # install deps for both packages
npm run install-hooks        # symlink scripts/git-hooks/* into .git/hooks/

# Daily
npm run dev                  # run server + client concurrently
npm run typecheck            # both packages
npm run lint                 # both packages
npm run test                 # both packages
npm run test:coverage        # both, with thresholds
npm run knip                 # find unused code / deps
npm run ci:check             # full pipeline locally — RUN BEFORE PUSH

# Targeted
npm --prefix server run dev
npm --prefix client run test:run
bash agent/scripts/auto-run.sh <agent-name>   # run one agent
bash agent/scripts/agent-summary.sh           # daily activity dashboard
```

## Workflow on any non-trivial change

1. Read `docs/12-handoff.md` to understand current state.
2. Read the relevant `docs/<area>.md` for the area you're touching.
3. Make the change.
4. Run `npm run ci:check`. Fix any failure before continuing.
5. Update `docs/` if you changed contracts / behavior / decisions.
6. Update `docs/12-handoff.md` if you finished a unit of work.
7. Commit with Conventional Commit format.
8. Run `npm run ci:check` once more. Push.

For routine small changes (typo, comment, single-line tweak):
hooks alone suffice — but `ci:check` is still the safe play.

## Reading order for new contributors / agents

1. This file
2. `docs/12-handoff.md` (current state)
3. `docs/09-contributing.md` (conventions)
4. `docs/01-architecture.md` (system shape)
5. Whichever `docs/<area>.md` matches the task
