import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb } from '../../test/db-reset';
import { db } from '../../db/client';
import { boards } from '../../db/schema';
import { AppError } from '../../lib/errors';
import { assertBoardExists, getBoardBySlug, listBoards } from './boards.service';

describe('boards.service', () => {
  beforeEach(async () => {
    await resetDb();
    await db.insert(boards).values([
      { slug: 'living', name: '生活与种植', sortOrder: 5 },
      { slug: 'market', name: '市场与资产', sortOrder: 1 },
    ]);
  });

  it('lists boards ordered by sortOrder, not insertion order', async () => {
    const rows = await listBoards();
    expect(rows.map((b) => b.slug)).toEqual(['market', 'living']);
  });

  it('omits reserved eval boards from the public list but still looks them up by slug', async () => {
    await db.insert(boards).values({ slug: 'probes', name: 'Probes', sortOrder: 99 });
    const rows = await listBoards();
    expect(rows.map((b) => b.slug)).toEqual(['market', 'living']);
    const reserved = await getBoardBySlug('probes');
    expect(reserved.name).toBe('Probes');
  });

  it('finds a board by slug', async () => {
    const board = await getBoardBySlug('market');
    expect(board.name).toBe('市场与资产');
  });

  it('is case-insensitive on slug lookup', async () => {
    const board = await getBoardBySlug('MARKET');
    expect(board.slug).toBe('market');
  });

  it('throws notFound for an unknown slug', async () => {
    await expect(getBoardBySlug('nope')).rejects.toThrow(AppError);
  });

  it('assertBoardExists passes for a real id', async () => {
    const board = await getBoardBySlug('market');
    await expect(assertBoardExists(board.id)).resolves.toBeUndefined();
  });

  it('assertBoardExists rejects an unknown id', async () => {
    await expect(assertBoardExists('nonexistent')).rejects.toThrow(AppError);
  });
});
