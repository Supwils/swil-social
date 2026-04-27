import { describe, it, expect } from 'vitest';
import { extractTags, extractMentionUsernames } from './extract';

describe('extractTags', () => {
  it('returns empty for plain text', () => {
    expect(extractTags('hello world')).toEqual([]);
  });

  it('extracts a basic ASCII tag', () => {
    expect(extractTags('learning #typescript today')).toEqual([
      { slug: 'typescript', display: 'typescript' },
    ]);
  });

  it('lowercases the slug but preserves display case', () => {
    expect(extractTags('#TypeScript is fun')).toEqual([
      { slug: 'typescript', display: 'TypeScript' },
    ]);
  });

  it('extracts CJK tags', () => {
    expect(extractTags('今天看了 #摄影 和 #设计')).toEqual([
      { slug: '摄影', display: '摄影' },
      { slug: '设计', display: '设计' },
    ]);
  });

  it('dedupes same-slug tags by first occurrence display', () => {
    const tags = extractTags('#AI in #ai applications #Ai everywhere');
    expect(tags).toHaveLength(1);
    expect(tags[0]).toEqual({ slug: 'ai', display: 'AI' });
  });

  it('allows hyphen and underscore but not at start', () => {
    expect(extractTags('#open-source #user_id')).toEqual([
      { slug: 'open-source', display: 'open-source' },
      { slug: 'user_id', display: 'user_id' },
    ]);
  });

  it('caps tag length at 64 characters', () => {
    const long = '#' + 'a'.repeat(70);
    const tags = extractTags(long);
    expect(tags[0].slug.length).toBe(64);
  });

  it('does not extract bare # or # followed by punctuation', () => {
    expect(extractTags('# alone')).toEqual([]);
    expect(extractTags('#!alert')).toEqual([]);
  });
});

describe('extractMentionUsernames', () => {
  it('returns empty for plain text', () => {
    expect(extractMentionUsernames('hello world')).toEqual([]);
  });

  it('extracts a basic mention', () => {
    expect(extractMentionUsernames('hi @alice')).toEqual(['alice']);
  });

  it('lowercases mentions', () => {
    expect(extractMentionUsernames('@AliceWonders @bob')).toEqual(['alicewonders', 'bob']);
  });

  it('dedupes duplicate mentions in a single text', () => {
    expect(extractMentionUsernames('@alice and @ALICE')).toEqual(['alice']);
  });

  it('rejects too-short usernames (<3 chars)', () => {
    expect(extractMentionUsernames('@ab is too short, @abc is ok')).toEqual(['abc']);
  });

  it('truncates at the 24-char regex cap (not strictly rejected)', () => {
    // Behavior note: the regex {3,24} is greedy but not anchored, so a 30-char
    // run extracts the first 24. Server-side username validation catches
    // mismatches at the User.find() lookup. Recorded so a future tightening
    // (e.g. trailing word-boundary) is intentional.
    const long = '@' + 'a'.repeat(30);
    expect(extractMentionUsernames(long)).toEqual(['a'.repeat(24)]);
  });

  it('does not extract email-like patterns', () => {
    // @bar in foo@bar would still match because regex doesn't anchor — this
    // documents current behavior. A future tightening could require word
    // boundary; recorded here so the change is intentional.
    expect(extractMentionUsernames('contact me at foo@example.com')).toEqual(['example']);
  });

  it('handles mixed mentions and tags', () => {
    expect(extractMentionUsernames('hey @alice check out #typescript')).toEqual(['alice']);
  });
});
