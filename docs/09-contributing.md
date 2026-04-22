---
title: Contributing
status: stable
last-updated: 2026-04-21
owner: round-1
---

# Contributing

Short and opinionated. This is a single-maintainer project for now; the rules here exist to keep the codebase and `/docs` coherent across agent-assisted sessions as much as human ones.

## For agents picking up the repo

1. **Read `docs/12-handoff.md` first.** It reflects the current round's state and what's next.
2. Then skim `docs/10-roadmap.md` to see where the current work fits.
3. Then read the relevant architecture / design / API doc for the area you're touching.
4. When you finish a round, update `12-handoff.md`, bump statuses in `10-roadmap.md`, and bump `last-updated` on any doc you edited.

## Conventions

### Commits

Conventional-commit style, but loose:

```
<type>(<area>): <summary>

[optional body]
```

Types used: `feat`, `fix`, `refactor`, `docs`, `chore`, `test`, `style`, `perf`.

Examples:
- `docs(roadmap): close P1 and plan P2`
- `feat(posts): add tag extraction`
- `fix(auth): regenerate session on login to prevent fixation`

Keep commits focused. A round typically closes with 3–6 commits, not 1 mega-commit.

### Branches

- `main` is always deployable (for a suitable definition of "deployable" given the phase).
- Feature branches: `phase-N/short-slug`, e.g. `phase-2/auth-rewrite`.
- PRs squash-merge into `main` with a clean commit message.

### Pull requests

Every PR includes:

- **What** — one sentence.
- **Why** — link to the relevant phase in `10-roadmap.md`.
- **How** — bullet list of notable decisions.
- **Checklist**:
  - [ ] `npm run typecheck`
  - [ ] `npm run test`
  - [ ] `/docs` updated if behavior/contracts changed
  - [ ] `handoff.md` updated

### Code style

- TypeScript strict mode. No `any` unless commented with why.
- ESLint + Prettier run in pre-commit (husky + lint-staged, added in P4).
- No hex colors in components — use tokens.
- No scattered `axios.*()` calls — route through `src/api/`.
- No `console.log` in committed code — use the logger (server) or a debug statement guarded by env (client).

### Tests

- Backend: Vitest + supertest. One describe per module, one case per service method + HTTP happy path + one auth/validation failure.
- Frontend: Vitest + React Testing Library. Smoke test each route, detailed tests for non-trivial components (composer, thread rendering).
- Target: tests pass in CI, not 100% coverage. Coverage tracked but not gated.

### Documentation

- Docs live in `/docs` — not in component headers, not in commit bodies.
- When a contract changes (API shape, schema), update the relevant `docs/` file in the same PR.
- ADRs for non-obvious decisions. If you're choosing between two reasonable options and the second-best isn't obviously wrong, write an ADR.

## What not to do

- Don't introduce a new dependency without noting why in the PR description. Small apps bloat fast.
- Don't add feature flags or A/B scaffolding. If a feature isn't ready, it isn't merged.
- Don't add error handling for impossible cases. Validate at the boundary (request body, env, user input); trust internal calls.
- Don't write backwards-compat shims during the refactor — there are no external consumers yet.
- Don't commit `.env`, dump files, or secrets. `.gitignore` blocks most; double-check.
