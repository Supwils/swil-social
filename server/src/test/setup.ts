/**
 * Vitest setup — provides safe defaults for env vars that env.ts validates
 * at import time, so unit tests can run without a .env file (e.g. in CI).
 *
 * Real values from a local .env still win — these are fallbacks only.
 *
 * IMPORTANT: this file is wired via `setupFiles` in vitest.config.ts. It runs
 * BEFORE each test file imports its modules, so env.ts sees these defaults
 * when its top-level `safeParse(process.env)` runs.
 *
 * If you ever add an integration test that hits a real MongoDB, gate it on
 * `process.env.MONGO_INTEGRATION === '1'` and skip otherwise — these
 * fallbacks point at a placeholder URI that wouldn't connect anyway.
 */

// Use ?? so any value already set in the environment (e.g. from a developer's
// .env or a real CI secret) takes precedence.
process.env.NODE_ENV ??= 'test';
// Derived from the OS user (the default role for a `brew install postgresql`
// setup) rather than hardcoded — this used to name one maintainer, so every
// other machine ran migrations against one URL and queries against another.
process.env.DATABASE_URL ??= `postgresql://${process.env.USER ?? 'postgres'}@127.0.0.1:5432/swil_test_pg`;
process.env.MONGODB_URI ??= 'mongodb://127.0.0.1:27017/swil-test-placeholder';
process.env.SESSION_SECRET ??=
  'unit-test-session-secret-must-be-at-least-32-chars-long-and-deterministic';
