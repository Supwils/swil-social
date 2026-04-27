import { describe, it, expect } from 'vitest';
import { calcFeedScore } from './feedScorer';

const HOUR = 3_600_000;

describe('calcFeedScore', () => {
  it('a brand-new zero-engagement post has score ~0.35', () => {
    const score = calcFeedScore({
      likeCount: 0,
      commentCount: 0,
      repostCount: 0,
      createdAt: new Date(),
    });
    // (0 + 0 + 0 + 1) / (0 + 2)^1.5 = 1 / 2.828... ≈ 0.3536
    expect(score).toBeCloseTo(0.354, 2);
  });

  it('older posts decay below newer zero-engagement posts of equal weight', () => {
    const fresh = calcFeedScore({
      likeCount: 0, commentCount: 0, repostCount: 0,
      createdAt: new Date(),
    });
    const day = calcFeedScore({
      likeCount: 0, commentCount: 0, repostCount: 0,
      createdAt: new Date(Date.now() - 24 * HOUR),
    });
    expect(fresh).toBeGreaterThan(day);
  });

  it('engagement weights: comment=2x like, repost=3x like', () => {
    const sameAge = new Date(Date.now() - 1 * HOUR);
    const oneLike = calcFeedScore({ likeCount: 1, commentCount: 0, repostCount: 0, createdAt: sameAge });
    const oneComment = calcFeedScore({ likeCount: 0, commentCount: 1, repostCount: 0, createdAt: sameAge });
    const oneRepost = calcFeedScore({ likeCount: 0, commentCount: 0, repostCount: 1, createdAt: sameAge });
    expect(oneComment).toBeGreaterThan(oneLike);
    expect(oneRepost).toBeGreaterThan(oneComment);

    // Engagement numerator: 1+1=2, 1+2=3, 1+3=4 → ratios should hold
    const denom = Math.pow(1 + 2, 1.5);
    expect(oneLike).toBeCloseTo(2 / denom, 4);
    expect(oneComment).toBeCloseTo(3 / denom, 4);
    expect(oneRepost).toBeCloseTo(4 / denom, 4);
  });

  it('engagement is not enough to overcome 24h of decay at 10 likes', () => {
    // Sanity-check on the algorithm: with the 1.5 gravity exponent, a fresh
    // empty post (0.19) still outranks a 24h post with 10 likes (0.08). To
    // beat a fresh post at 24h, you need >40 likes — confirms the algorithm
    // intentionally rewards recency strongly.
    const engaged = calcFeedScore({
      likeCount: 10, commentCount: 0, repostCount: 0,
      createdAt: new Date(Date.now() - 24 * HOUR),
    });
    const newSilent = calcFeedScore({
      likeCount: 0, commentCount: 0, repostCount: 0,
      createdAt: new Date(Date.now() - 1 * HOUR),
    });
    expect(newSilent).toBeGreaterThan(engaged);
  });

  it('high engagement (50 likes at 24h) does outrank a fresh empty post', () => {
    const heavilyEngaged = calcFeedScore({
      likeCount: 50, commentCount: 0, repostCount: 0,
      createdAt: new Date(Date.now() - 24 * HOUR),
    });
    const newSilent = calcFeedScore({
      likeCount: 0, commentCount: 0, repostCount: 0,
      createdAt: new Date(Date.now() - 1 * HOUR),
    });
    expect(heavilyEngaged).toBeGreaterThan(newSilent);
  });

  it('score monotonically decreases as a post ages with fixed engagement', () => {
    const eng = { likeCount: 5, commentCount: 2, repostCount: 1 };
    const t1 = calcFeedScore({ ...eng, createdAt: new Date(Date.now() - 1 * HOUR) });
    const t6 = calcFeedScore({ ...eng, createdAt: new Date(Date.now() - 6 * HOUR) });
    const t72 = calcFeedScore({ ...eng, createdAt: new Date(Date.now() - 72 * HOUR) });
    expect(t1).toBeGreaterThan(t6);
    expect(t6).toBeGreaterThan(t72);
  });

  it('score is always positive', () => {
    const ancient = calcFeedScore({
      likeCount: 0, commentCount: 0, repostCount: 0,
      createdAt: new Date(Date.now() - 365 * 24 * HOUR),
    });
    expect(ancient).toBeGreaterThan(0);
  });
});
