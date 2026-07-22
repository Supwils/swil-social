import 'dotenv/config';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';

/**
 * Apply all pending Drizzle migrations. Run via `npm run db:migrate`.
 * Reads DATABASE_URL from the environment (.env in dev).
 */
async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  const pool = new Pool({ connectionString: url });
  const db = drizzle(pool);
  await migrate(db, { migrationsFolder: `${__dirname}/migrations` });
  await pool.end();
   
  console.log('migrations applied');
}

main().catch((err) => {
   
  console.error(err);
  process.exit(1);
});
