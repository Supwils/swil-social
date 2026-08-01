/**
 * Shared helpers: day bucketing, agent lookup, lab-population loading.
 *
 * Split out of the former 2018-line agents.service.ts, which had grown to cover
 * nine unrelated concerns — over six times the 300-line ceiling this repo sets
 * for a service file. agents.service.ts is now a re-export barrel, so every
 * existing import path still resolves unchanged.
 */
import { and, eq, inArray, or } from 'drizzle-orm';
import { db } from '../../db/client';
import { agentEvents, personalitySnapshots, users } from '../../db/schema';
import { AppError } from '../../lib/errors';
import type { UserRow } from '../../lib/dto';

/* ---------- helpers ---------- */

export function dayBuckets(range: '7d' | '30d' | '90d'): { since: Date; days: number } {
  const days = range === '7d' ? 7 : range === '30d' ? 30 : 90;
  const since = new Date();
  since.setUTCHours(0, 0, 0, 0);
  since.setUTCDate(since.getUTCDate() - (days - 1));
  return { since, days };
}

export function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Count rows per UTC day (matches Mongo's `$dateToString %Y-%m-%d` on a UTC date). */
export function countByDay(dates: Array<{ createdAt: Date }>): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of dates) {
    const k = isoDay(r.createdAt);
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return m;
}

/** Split a set of actor rows by AI vs human (null isAgent counts as human). */
export function splitByAgent(rows: Array<{ isAgent: boolean | null }>): { ai: number; human: number } {
  let ai = 0;
  let human = 0;
  for (const r of rows) {
    if (r.isAgent === true) ai += 1;
    else human += 1;
  }
  return { ai, human };
}

/**
 * `/lab` tracks both AI agents (isAgent=true) AND human-simulation accounts
 * that participate in the dream/personality loop — they share the same runtime
 * and have personality.md + memory.md. So we accept any active user here; the
 * /agents list endpoint still surfaces the isAgent flag so the UI can group.
 */
export async function findAgentByUsername(username: string): Promise<UserRow> {
  const [u] = await db
    .select()
    .from(users)
    .where(and(eq(users.username, username.toLowerCase()), eq(users.status, 'active')))
    .limit(1);
  if (!u) throw AppError.notFound('Account not found');
  return u;
}

/* ---------- lab population loader (shared by graph / pulse / alerts) ---------- */

/** A lab participant: an AI agent, or a human account inside the dream loop. */
export interface LabUser {
  id: string;
  username: string;
  displayName: string;
  isAgent: boolean;
}

export async function loadLabUsers(): Promise<LabUser[]> {
  const [snapUserRows, eventUserRows] = await Promise.all([
    db.selectDistinct({ userId: personalitySnapshots.userId }).from(personalitySnapshots),
    db.selectDistinct({ userId: agentEvents.userId }).from(agentEvents),
  ]);
  const labUserIds = Array.from(
    new Set([...snapUserRows.map((r) => r.userId), ...eventUserRows.map((r) => r.userId)]),
  );
  const orCond = labUserIds.length
    ? or(eq(users.isAgent, true), inArray(users.id, labUserIds))
    : eq(users.isAgent, true);
  return db
    .select({
      id: users.id,
      username: users.username,
      displayName: users.displayName,
      isAgent: users.isAgent,
    })
    .from(users)
    .where(and(eq(users.status, 'active'), orCond));
}
