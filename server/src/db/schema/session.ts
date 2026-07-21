import { pgTable, varchar, json, timestamp, index } from 'drizzle-orm/pg-core';

/**
 * Session store table for connect-pg-simple. Column names/types match its
 * expected DDL exactly (sid pk, sess json, expire timestamp(6)). We manage it
 * via Drizzle migrations, so connect-pg-simple is configured with
 * `createTableIfMissing: false`.
 */
export const session = pgTable(
  'session',
  {
    sid: varchar('sid').primaryKey(),
    sess: json('sess').notNull(),
    expire: timestamp('expire', { precision: 6 }).notNull(),
  },
  (t) => [index('IDX_session_expire').on(t.expire)],
);
