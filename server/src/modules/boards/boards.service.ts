import { asc, eq, inArray, isNull, notInArray, or, type SQL } from 'drizzle-orm';
import { db } from '../../db/client';
import { boards, posts } from '../../db/schema';
import { AppError } from '../../lib/errors';

export type BoardRow = typeof boards.$inferSelect;

/** Eval-only boards. Field-study lists and mixed feeds must omit them. */
export const RESERVED_BOARD_SLUGS = ['probes'] as const;

/** All public boards, in display order. Reserved eval boards are omitted. */
export async function listBoards(): Promise<BoardRow[]> {
  return db
    .select()
    .from(boards)
    .where(notInArray(boards.slug, [...RESERVED_BOARD_SLUGS]))
    .orderBy(asc(boards.sortOrder));
}

export async function reservedBoardIds(): Promise<string[]> {
  const rows = await db
    .select({ id: boards.id })
    .from(boards)
    .where(inArray(boards.slug, [...RESERVED_BOARD_SLUGS]));
  return rows.map((row) => row.id);
}

/** Drop posts filed to a reserved board from mixed feeds. Unfiled posts stay. */
export async function notReservedBoardClause(): Promise<SQL | undefined> {
  const ids = await reservedBoardIds();
  if (ids.length === 0) return undefined;
  return or(isNull(posts.boardId), notInArray(posts.boardId, ids));
}

/** Look a board up by slug. Throws 404 when it does not exist. */
export async function getBoardBySlug(slug: string): Promise<BoardRow> {
  const [row] = await db.select().from(boards).where(eq(boards.slug, slug.toLowerCase())).limit(1);
  if (!row) throw AppError.notFound('Board not found');
  return row;
}

/**
 * Guard for the post-create path. `boardId` arrives from the client, so an
 * unknown id is a client error rather than a missing resource.
 */
export async function assertBoardExists(id: string): Promise<void> {
  const [row] = await db.select({ id: boards.id }).from(boards).where(eq(boards.id, id)).limit(1);
  if (!row) throw AppError.validation('Unknown boardId', { boardId: 'not found' });
}
