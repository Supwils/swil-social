import { Types } from 'mongoose';
import { describe, expect, it } from 'vitest';
import {
  buildNextCursor,
  cursorFilterAsc,
  cursorFilterDesc,
  decodeCursor,
  encodeCursor,
  parseLimit,
} from './pagination';

describe('pagination helpers', () => {
  it('round-trips encoded cursors', () => {
    const cursor = { t: '2026-04-23T00:00:00.000Z', id: new Types.ObjectId().toString() };

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

  it('builds descending cursor filters using the requested field', () => {
    const id = new Types.ObjectId().toString();
    expect(cursorFilterDesc({ t: '2026-04-23T00:00:00.000Z', id }, 'updatedAt')).toEqual({
      $or: [
        { updatedAt: { $lt: new Date('2026-04-23T00:00:00.000Z') } },
        { updatedAt: new Date('2026-04-23T00:00:00.000Z'), _id: { $lt: new Types.ObjectId(id) } },
      ],
    });
  });

  it('builds ascending cursor filters', () => {
    const id = new Types.ObjectId().toString();
    expect(cursorFilterAsc({ t: '2026-04-23T00:00:00.000Z', id })).toEqual({
      $or: [
        { createdAt: { $gt: new Date('2026-04-23T00:00:00.000Z') } },
        { createdAt: new Date('2026-04-23T00:00:00.000Z'), _id: { $gt: new Types.ObjectId(id) } },
      ],
    });
  });

  it('builds the next cursor from the last item on the page', () => {
    const docs = [
      { _id: new Types.ObjectId(), createdAt: new Date('2026-04-23T00:00:00.000Z') },
      { _id: new Types.ObjectId(), createdAt: new Date('2026-04-22T00:00:00.000Z') },
    ];

    const page = buildNextCursor(docs, 1);

    expect(page.items).toEqual([docs[0]]);
    expect(decodeCursor(page.nextCursor)?.id).toBe(docs[0]._id.toString());
  });
});
