/**
 * Cursor-based pagination helpers.
 *
 * A cursor is an opaque base64url-encoded JSON `{ t: <ISO timestamp>, id: <string> }`
 * pointing at the last item of the previous page. Queries filter for items strictly
 * older (or newer, depending on sortDir) than the cursor; ties broken by _id.
 */
import { Types } from 'mongoose';

export interface Cursor {
  t: string;
  id: string;
}

export interface Paginated<T> {
  items: T[];
  nextCursor: string | null;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

export function parseLimit(raw: unknown, fallback = DEFAULT_LIMIT): number {
  const n = typeof raw === 'string' ? parseInt(raw, 10) : typeof raw === 'number' ? raw : NaN;
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(MAX_LIMIT, Math.floor(n));
}

export function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');
}

export function decodeCursor(raw: unknown): Cursor | null {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const json = Buffer.from(raw, 'base64url').toString('utf8');
    const parsed = JSON.parse(json) as Partial<Cursor>;
    if (typeof parsed.t !== 'string' || typeof parsed.id !== 'string') return null;
    if (!Types.ObjectId.isValid(parsed.id)) return null;
    return { t: parsed.t, id: parsed.id };
  } catch {
    return null;
  }
}

/**
 * Build a mongo filter fragment for descending pagination by createdAt.
 * The cursor points at the last item of the previous page; we want items
 * strictly older, with _id breaking ties at identical timestamps.
 */
export function cursorFilterDesc(
  cursor: Cursor | null,
  field = 'createdAt',
): Record<string, unknown> {
  if (!cursor) return {};
  const t = new Date(cursor.t);
  const id = new Types.ObjectId(cursor.id);
  return {
    $or: [
      { [field]: { $lt: t } },
      { [field]: t, _id: { $lt: id } },
    ],
  };
}

/**
 * Ascending variant (e.g., comments shown oldest-first).
 */
export function cursorFilterAsc(
  cursor: Cursor | null,
  field = 'createdAt',
): Record<string, unknown> {
  if (!cursor) return {};
  const t = new Date(cursor.t);
  const id = new Types.ObjectId(cursor.id);
  return {
    $or: [
      { [field]: { $gt: t } },
      { [field]: t, _id: { $gt: id } },
    ],
  };
}

export function buildNextCursor<T extends { createdAt: Date; _id: Types.ObjectId }>(
  items: T[],
  limit: number,
): { items: T[]; nextCursor: string | null } {
  if (items.length <= limit) {
    return { items, nextCursor: null };
  }
  const page = items.slice(0, limit);
  const last = page[page.length - 1];
  const id = last._id.toString();
  return {
    items: page,
    nextCursor: encodeCursor({ t: last.createdAt.toISOString(), id }),
  };
}

// ── Score-based cursor (for ranked feeds) ────────────────────────────────────

export interface ScoreCursor {
  s: number;
  id: string;
}

export function decodeScoreCursor(raw: unknown): ScoreCursor | null {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const json = Buffer.from(raw, 'base64url').toString('utf8');
    const parsed = JSON.parse(json) as Partial<ScoreCursor>;
    if (typeof parsed.s !== 'number' || typeof parsed.id !== 'string') return null;
    if (!Types.ObjectId.isValid(parsed.id)) return null;
    return { s: parsed.s, id: parsed.id };
  } catch {
    return null;
  }
}

export function scoreCursorFilter(cursor: ScoreCursor | null): Record<string, unknown> {
  if (!cursor) return {};
  const id = new Types.ObjectId(cursor.id);
  return {
    $or: [
      { feedScore: { $lt: cursor.s } },
      { feedScore: cursor.s, _id: { $lt: id } },
    ],
  };
}

export function buildNextScoreCursor<T extends { feedScore: number; _id: Types.ObjectId }>(
  items: T[],
  limit: number,
): { items: T[]; nextCursor: string | null } {
  if (items.length <= limit) {
    return { items, nextCursor: null };
  }
  const page = items.slice(0, limit);
  const last = page[page.length - 1];
  return {
    items: page,
    nextCursor: Buffer.from(JSON.stringify({ s: last.feedScore, id: last._id.toString() }), 'utf8').toString('base64url'),
  };
}
