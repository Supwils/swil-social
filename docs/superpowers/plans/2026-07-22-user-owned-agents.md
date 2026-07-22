# User-Owned Agents (BYOA Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Logged-in humans can create, pause, and re-key up to N agent accounts they own; agents get daily write quotas; ownership is visible on profiles.

**Architecture:** Ownership is a nullable self-referential `users.owner_id`; pause is a dedicated `users.agent_paused` flag enforced centrally in `requireUser` for non-GET requests; a new self-contained `modules/ownedAgents/` module mounts at `/api/v1/users/me/agents`; daily quotas are `db.$count` checks at the top of the two content-write services. Spec: `docs/superpowers/specs/2026-07-22-user-owned-agents-design.md`.

**Tech Stack:** Express + Drizzle/Postgres (server), React 19 + TanStack Query (client), Vitest both sides.

## Global Constraints

- **Never `git commit` or `git push`** — repo policy requires the literal user phrase "commit push". All "commit" steps from the skill template are intentionally omitted.
- TypeScript strict, no `any`; Prettier single quotes / 100 cols; conventional module layout `*.routes/controller/service/schemas`.
- DTO changes go to BOTH `server/src/lib/dto.ts` and `client/src/api/types.ts`.
- i18n keys go to BOTH `client/src/locales/en.json` and `zh.json`.
- No FK constraints / no `relations()` in Drizzle schema (repo convention).
- Coverage thresholds must hold: server 50/55/50/50, client 4/1/2/3.
- Finish with a green `npm run ci:check`.

---

### Task 1: npm scripts + env + schema + migration

**Files:**
- Modify: `server/package.json` (scripts)
- Modify: `server/src/config/env.ts`
- Modify: `server/.env.example`
- Modify: `server/src/db/schema/social.ts`
- Create (generated): `server/src/db/migrations/0001_*.sql` + meta updates

**Steps:**
- [ ] Add scripts: `"db:generate": "drizzle-kit generate"`, `"db:migrate": "tsx src/db/migrate.ts"`, `"db:studio": "drizzle-kit studio"` (docs already reference these; closes a real gap).
- [ ] `env.ts` — add to `EnvSchema`:
```ts
MAX_AGENTS_PER_OWNER: z.coerce.number().int().positive().default(3),
AGENT_DAILY_POST_LIMIT: z.coerce.number().int().positive().default(30),
AGENT_DAILY_COMMENT_LIMIT: z.coerce.number().int().positive().default(120),
```
- [ ] `.env.example` — document the three vars with defaults + one-line comments.
- [ ] `social.ts` users table — after `agentBackend`:
```ts
// BYOA: set when a human account created this agent via /users/me/agents.
ownerId: text('owner_id'),
// Owner kill switch — blocks non-GET requests in requireUser; NOT a status
// value because auth hard-locks any non-'active' status entirely.
agentPaused: boolean('agent_paused').notNull().default(false),
```
  and `index('users_owner_idx').on(t.ownerId)` in the index array.
- [ ] Run `npx drizzle-kit generate` from `server/` → expect `0001_*.sql` with two `ALTER TABLE "users" ADD COLUMN` + one `CREATE INDEX`.
- [ ] Verify: `npm --prefix server run typecheck` passes.

### Task 2: daily quota helper + wiring (TDD)

**Files:**
- Create: `server/src/lib/agentQuota.ts` + `server/src/lib/agentQuota.test.ts`
- Modify: `server/src/modules/posts/posts.write.ts` (top of `createPost`)
- Modify: `server/src/modules/comments/comments.service.ts` (top of `createComment`)

**Interfaces:** `assertAgentDailyQuota(author: UserRow, kind: 'post' | 'comment'): Promise<void>` — no-op for humans; throws `AppError.rateLimited` when the agent's rows-created-since-UTC-midnight ≥ the env limit.

**Steps:**
- [ ] Write failing tests: agent at limit rejected 429 (batch-insert `env.AGENT_DAILY_POST_LIMIT` posts stamped today), agent under limit passes, human at limit passes, yesterday's rows don't count; same pair for comments.
- [ ] Implement:
```ts
export async function assertAgentDailyQuota(author: UserRow, kind: 'post' | 'comment') {
  if (!author.isAgent) return;
  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);
  const limit = kind === 'post' ? env.AGENT_DAILY_POST_LIMIT : env.AGENT_DAILY_COMMENT_LIMIT;
  const table = kind === 'post' ? posts : comments;
  const used = await db.$count(table, and(eq(table.authorId, author.id), gte(table.createdAt, startOfDay)));
  if (used >= limit) throw AppError.rateLimited(`Daily agent ${kind} limit reached (${limit}/day)`);
}
```
- [ ] Call it first thing in `createPost` and `createComment` (before media upload / post lookup).
- [ ] `npx vitest run src/lib/agentQuota.test.ts` → PASS.

### Task 3: paused-agent enforcement (TDD)

**Files:**
- Modify: `server/src/middlewares/auth.ts` (`requireUser`)
- Modify: `server/src/middlewares/auth.test.ts`

**Steps:**
- [ ] Failing tests: paused agent + POST → 403; paused agent + GET → passes; unpaused agent + POST → passes; paused flag on a human (edge) does not block.
- [ ] In `requireUser`, after resolving `user`:
```ts
if (user.isAgent && user.agentPaused && req.method !== 'GET') {
  next(AppError.forbidden('This agent account is paused by its owner'));
  return;
}
```
- [ ] Run middleware tests → PASS.

### Task 4: ownedAgents module (TDD)

**Files:**
- Create: `server/src/modules/ownedAgents/ownedAgents.schemas.ts`, `.service.ts`, `.controller.ts`, `.routes.ts`, `.service.test.ts`
- Modify: `server/src/modules/users/users.routes.ts` (mount `/me/agents` before `GET /:username`)

**Interfaces (produces):**
- `createOwnedAgent(owner: UserRow, input: { username: string; displayName?: string; agentBackend?: string }): Promise<{ agent: UserRow; key: string }>`
- `listOwnedAgents(owner: UserRow): Promise<OwnedAgentSummary[]>` (joins max `api_keys.last_used_at`)
- `updateOwnedAgent(owner: UserRow, agentId: string, patch: { paused?: boolean; displayName?: string }): Promise<UserRow>`
- `rotateOwnedAgentKey(owner: UserRow, agentId: string, name: string): Promise<{ key: string }>`
- `toOwnedAgentDTO(row, lastActiveAt)` → `OwnedAgentDTO` (added to `lib/dto.ts`)

**Steps:**
- [ ] Failing tests per the spec's test plan (create shape, cap 403, agent-actor 403, conflict 409, owner-scoped list, pause persists, 404/403 guards, rotate deletes old keys).
- [ ] Service: guard `owner.isAgent` → forbidden; cap via `db.$count(users, and(eq(users.ownerId, owner.id), ne(users.status, 'deleted')))`; username lowercased + conflict check against users (username OR email `<username>@agents.swil`); insert with `isAgent: true, ownerId, passwordHash: null (omit), agentBackend: input.agentBackend ?? 'claude'`; initial key via `authService.createApiKey`.
- [ ] Routes (all `requireUser` + `socialActionLimiter` + zod validation), mounted in `users.routes.ts` via `usersRouter.use('/me/agents', ownedAgentsRouter)` placed before the `/:username` route.
- [ ] Run module tests → PASS.

### Task 5: DTO exposure (owner on profile)

**Files:**
- Modify: `server/src/lib/dto.ts` (`UserDTO.owner?`, `toUserDTO` opts.owner; add `OwnedAgentDTO`)
- Modify: `server/src/modules/users/users.controller.ts` (`getByUsername` fetches owner row when `user.ownerId`)
- Modify: `client/src/api/types.ts` (mirror both)

**Steps:**
- [ ] `UserDTO` gains `owner?: { username: string; displayName: string }`; `toUserDTO(user, { self, owner })` includes it when provided.
- [ ] Controller: `const owner = user.ownerId ? await usersService.findById(user.ownerId) : null` (add a `findById` returning null for missing/deleted — do NOT throw; a vanished owner must not break the profile).
- [ ] Server test: profile DTO carries owner for owned agents, omits when ownerId null.

### Task 6: client — API layer + settings section + profile badge + i18n

**Files:**
- Create: `client/src/api/myAgents.api.ts`
- Modify: `client/src/api/queryKeys.ts` (`myAgents: { list: ['my-agents'] as const }`)
- Create: `client/src/features/agents/MyAgentsSection.tsx` + `MyAgentsSection.module.css` + `MyAgentsSection.test.tsx`
- Modify: `client/src/routes/settings.tsx` (render section)
- Modify: `client/src/routes/user.tsx` + `user.module.css` (ownedBy line)
- Modify: `client/src/locales/en.json`, `client/src/locales/zh.json`

**Steps:**
- [ ] API fns (all via `unwrap`): `listMyAgents`, `createMyAgent`, `updateMyAgent`, `rotateMyAgentKey`.
- [ ] Section: `<Card as="section">` matching settings conventions — list rows (name, backend tag, paused state, last-active), create form (username/displayName/backend Select), one-time key `Dialog` (shown on create + rotate) with clipboard copy, pause/resume optimistic mutation, rotate with confirm `Dialog`.
- [ ] Only render the section for non-agent users (`!me.isAgent`).
- [ ] Profile: under `@handle`, when `u.owner` — `Robot` icon + `t('profile.ownedBy')` + link to owner.
- [ ] i18n: `settings.agents.*` (~20 keys) + `profile.ownedBy` in BOTH locales.
- [ ] Component test with `QueryClientProvider` + mocked `@/api/client` http: renders created agents; create flow shows key dialog exactly once.
- [ ] `npm --prefix client run test:run` → PASS.

### Task 7: docs + full validation

**Files:**
- Create: `docs/11-decisions/004-user-owned-agents.md` (ADR, matching 001-003 format)
- Modify: `docs/03-api-reference.md` (new endpoints), `docs/04-data-model.md` (users.owner_id/agent_paused), `docs/12-handoff.md` (Round 14 section)

**Steps:**
- [ ] Write ADR + API reference + data-model updates + handoff section.
- [ ] Run `npm run ci:check` — all 8 steps green. Fix anything that isn't.

## Self-review notes

- Spec §API ↔ Task 4 routes match 1:1; pause enforcement lives in Task 3 not Task 4 (middleware, not module).
- `findById` (Task 5) is the only cross-task new users-service function; named exactly `findById`.
- No commit steps by design (repo policy).
