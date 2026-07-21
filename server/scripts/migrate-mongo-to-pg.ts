/**
 * One-shot ETL: MongoDB → Postgres (Drizzle).
 *
 * Reads every collection from the source Mongo and inserts faithfully into the
 * Postgres tables: `_id` hex preserved as `id`, all ObjectId refs → hex strings,
 * dates/embeddings/jsonb preserved. Validates per-table counts and embedding
 * fidelity, then prints a reconciliation report.
 *
 * Usage:
 *   DATABASE_URL=postgres://…  MONGO_SOURCE_URI=mongodb://127.0.0.1:27017/swil_social \
 *     npx tsx scripts/migrate-mongo-to-pg.ts
 *
 * Idempotent: inserts use ON CONFLICT DO NOTHING; safe to re-run against a
 * truncated target. Does NOT migrate the `sessions` collection (ephemeral).
 */
import 'dotenv/config';
import { MongoClient, ObjectId } from 'mongodb';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { getTableColumns, sql } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import * as schema from '../src/db/schema';
import { cosineSim } from '../src/lib/vector';

const MONGO_URI = process.env.MONGO_SOURCE_URI ?? 'mongodb://127.0.0.1:27017/swil_social';
const PG_URI = process.env.DATABASE_URL;
if (!PG_URI) throw new Error('DATABASE_URL is required');

// Mongo collection name → Drizzle table. Order = dependency order.
const MAP: Array<[string, PgTable]> = [
  ['users', schema.users],
  ['tags', schema.tags],
  ['posts', schema.posts],
  ['comments', schema.comments],
  ['likes', schema.likes],
  ['follows', schema.follows],
  ['bookmarks', schema.bookmarks],
  ['conversations', schema.conversations],
  ['messages', schema.messages],
  ['notifications', schema.notifications],
  ['apikeys', schema.apiKeys],
  ['personalitysnapshots', schema.personalitySnapshots],
  ['behaviorsnapshots', schema.behaviorSnapshots],
  ['agentevents', schema.agentEvents],
  ['benchmarkruns', schema.benchmarkRuns],
  ['populationmetrics', schema.populationMetrics],
  ['events', schema.events],
];

/** Recursively convert BSON ObjectId → hex string; keep Date/plain structures. */
function toPlain(v: unknown): unknown {
  if (v == null) return v;
  if (v instanceof ObjectId) return v.toHexString();
  if (v instanceof Date) return v;
  if (Array.isArray(v)) return v.map(toPlain);
  if (typeof v === 'object') {
    const o: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) o[k] = toPlain(val);
    return o;
  }
  return v;
}

/** Map a Mongo doc to a row keyed by the table's Drizzle column JS-names. */
function mapDoc(doc: Record<string, unknown>, table: PgTable): Record<string, unknown> {
  const cols = getTableColumns(table);
  const row: Record<string, unknown> = {};
  for (const key of Object.keys(cols)) {
    if (key === 'id') {
      row.id = String((doc as { _id: unknown })._id);
      continue;
    }
    if (key in doc) row[key] = toPlain(doc[key]);
  }
  return row;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function main(): Promise<void> {
  const mongo = new MongoClient(MONGO_URI);
  await mongo.connect();
  const mdb = mongo.db();
  const pool = new Pool({ connectionString: PG_URI });
  const db = drizzle(pool, { schema });

  const report: Array<{ table: string; mongo: number; pg: number; ok: boolean }> = [];

  for (const [coll, table] of MAP) {
    const docs = await mdb.collection(coll).find({}).toArray();
    const rows = docs.map((d) => mapDoc(d as Record<string, unknown>, table));
    for (const c of chunk(rows, 500)) {
      if (c.length === 0) continue;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await db.insert(table).values(c as any).onConflictDoNothing();
    }
    const mongoCount = docs.length;
    const [{ c: pgCount }] = await db.select({ c: sql<number>`count(*)::int` }).from(table);
    const ok = mongoCount === pgCount;
    report.push({ table: coll, mongo: mongoCount, pg: pgCount, ok });
    // eslint-disable-next-line no-console
    console.log(`${ok ? '✓' : '✗'} ${coll.padEnd(22)} mongo=${mongoCount} pg=${pgCount}`);
  }

  // Embedding fidelity: sample personality snapshots, compare Mongo vs PG vectors.
  const sample = await mdb
    .collection('personalitysnapshots')
    .find({})
    .limit(5)
    .toArray();
  let worst = 1;
  for (const s of sample) {
    const id = String(s._id);
    const [pg] = await db
      .select({ e: schema.personalitySnapshots.embedding })
      .from(schema.personalitySnapshots)
      .where(sql`${schema.personalitySnapshots.id} = ${id}`);
    if (pg?.e && Array.isArray(s.embedding)) {
      const sim = cosineSim(s.embedding as number[], pg.e as number[]);
      worst = Math.min(worst, sim);
    }
  }
  // eslint-disable-next-line no-console
  console.log(`\nembedding fidelity (min cosine over ${sample.length} samples): ${worst.toFixed(8)}`);

  const failures = report.filter((r) => !r.ok);
  await mongo.close();
  await pool.end();

  if (failures.length > 0) {
    // eslint-disable-next-line no-console
    console.error(`\n❌ count mismatch in: ${failures.map((f) => f.table).join(', ')}`);
    process.exit(1);
  }
  if (worst < 0.999999) {
    // eslint-disable-next-line no-console
    console.error(`\n❌ embedding fidelity too low: ${worst}`);
    process.exit(1);
  }
  // eslint-disable-next-line no-console
  console.log('\n✅ ETL complete — all counts match, embeddings faithful.');
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
