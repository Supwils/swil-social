import { asc, eq } from 'drizzle-orm';
import { db } from '../../db/client';
import { boards } from '../../db/schema';
import { AppError } from '../../lib/errors';

export type BoardRow = typeof boards.$inferSelect;

/** All boards, in display order. */
export async function listBoards(): Promise<BoardRow[]> {
  return db.select().from(boards).orderBy(asc(boards.sortOrder));
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
