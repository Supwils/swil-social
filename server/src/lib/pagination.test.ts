import { describe, expect, it } from 'vitest';
import { newId } from './id';
import { posts } from '../db/schema';
import {
  buildNextCursor,
  buildNextScoreCursor,
  cursorConditionAsc,
  cursorConditionDesc,
  decodeCursor,
  decodeScoreCursor,
  encodeCursor,
  parseLimit,
  scoreCursorCondition,
} from './pagination';

describe('pagination helpers', () => {
  it('round-trips encoded cursors', () => {
    const cursor = { t: '2026-04-23T00:00:00.000Z', id: newId() };

    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it('returns null for malformed cursors', () => {
    expect(decodeCursor('not-base64')).toBeNull();
    expect(decodeCursor('')).toBeNull();
  });

  it('clamps limits to the supported range', () => {
    expect(parseLimit('500')).toBe(100);
    expect(parseLimit('-1')).toBe(20);
    expect(parseLimit('7')).toBe(7);
  });

  it('builds a descending cursor condition only when a cursor is present', () => {
    expect(cursorConditionDesc(null, posts.createdAt, posts.id)).toBeUndefined();
    const condition = cursorConditionDesc(
      { t: '2026-04-23T00:00:00.000Z', id: newId() },
      posts.createdAt,
      posts.id,
    );
    expect(condition).toBeDefined();
  });

  it('builds an ascending cursor condition only when a cursor is present', () => {
    expect(cursorConditionAsc(null, posts.createdAt, posts.id)).toBeUndefined();
    const condition = cursorConditionAsc(
      { t: '2026-04-23T00:00:00.000Z', id: newId() },
      posts.createdAt,
      posts.id,
    );
    expect(condition).toBeDefined();
  });

  it('builds a score cursor condition only when a cursor is present', () => {
    expect(scoreCursorCondition(null, posts.feedScore, posts.id)).toBeUndefined();
    expect(scoreCursorCondition({ s: 1.5, id: newId() }, posts.feedScore, posts.id)).toBeDefined();
  });

  it('builds the next cursor from the last item on the page', () => {
    const docs = [
      { id: newId(), createdAt: new Date('2026-04-23T00:00:00.000Z') },
      { id: newId(), createdAt: new Date('2026-04-22T00:00:00.000Z') },
    ];

    const page = buildNextCursor(docs, 1);

    expect(page.items).toEqual([docs[0]]);
    expect(decodeCursor(page.nextCursor)?.id).toBe(docs[0].id);
  });

  it('builds the next score cursor from the last item on the page', () => {
    const docs = [
      { id: newId(), feedScore: 9 },
      { id: newId(), feedScore: 3 },
    ];

    const page = buildNextScoreCursor(docs, 1);

    expect(page.items).toEqual([docs[0]]);
    expect(decodeScoreCursor(page.nextCursor)?.s).toBe(9);
  });
});
