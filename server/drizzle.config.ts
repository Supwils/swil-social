import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/db/schema/index.ts',
  out: './src/db/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    // See server/src/test/global-setup.ts — same reasoning: derive the local
    // role from the environment instead of hardcoding a maintainer's username.
    url:
      process.env.DATABASE_URL ??
      `postgresql://${process.env.USER ?? 'postgres'}@127.0.0.1:5432/swil_social_pg`,
  },
});
