import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';

/**
 * Vitest globalSetup — runs once before the whole suite. Applies Drizzle
 * migrations to the test database so every test starts against a real,
 * up-to-date Postgres schema. Individual DB-touching suites call `resetDb()`
 * (src/test/db-reset.ts) in beforeEach for isolation.
 */
export default async function setup(): Promise<void> {
  process.env.NODE_ENV ??= 'test';
  const url =
    process.env.DATABASE_URL ?? 'postgresql://supwils@127.0.0.1:5432/swil_test_pg';
  const pool = new Pool({ connectionString: url });
  const db = drizzle(pool);
  await migrate(db, { migrationsFolder: `${__dirname}/../db/migrations` });
  await pool.end();
}
