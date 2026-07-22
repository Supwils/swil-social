import { Client, Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';

/**
 * Prepare the dedicated E2E database: create it if missing, apply Drizzle
 * migrations, and truncate every table so each `playwright test` run starts
 * from a clean slate. Never points at the dev DB — the URL is its own env
 * var with an explicit e2e default.
 */
const url = process.env.E2E_DATABASE_URL ?? 'postgresql://supwils@127.0.0.1:5432/swil_e2e_pg';

// Keep in sync with server/src/test/db-reset.ts TABLES.
const TABLES = [
  'likes',
  'bookmarks',
  'follows',
  'comments',
  'posts',
  'messages',
  'conversations',
  'notifications',
  'api_keys',
  'personality_snapshots',
  'behavior_snapshots',
  'agent_events',
  'benchmark_runs',
  'population_metrics',
  'events',
  'tags',
  'users',
  'session',
];

async function main(): Promise<void> {
  const dbName = new URL(url).pathname.slice(1);
  const adminUrl = new URL(url);
  adminUrl.pathname = '/postgres';

  const admin = new Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${dbName}"`);
    console.log(`[e2e-db] created database ${dbName}`);
  } catch (err) {
    // 42P04 = duplicate_database — fine, reuse it.
    if ((err as { code?: string }).code !== '42P04') throw err;
  } finally {
    await admin.end();
  }

  const pool = new Pool({ connectionString: url });
  const db = drizzle(pool);
  await migrate(db, { migrationsFolder: `${__dirname}/../src/db/migrations` });
  await pool.query(
    `TRUNCATE ${TABLES.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`,
  );
  await pool.end();
  console.log(`[e2e-db] ${dbName} migrated + truncated`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
