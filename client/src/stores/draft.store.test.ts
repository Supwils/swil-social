import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useDrafts } from './draft.store';

/**
 * Drafts hold text the user typed but has not posted, so a bug here loses
 * work silently. The store is persisted, which makes cross-key leakage and
 * stale-clear the failure modes worth pinning.
 */
function reset(): void {
  useDrafts.setState({ drafts: {} });
}

describe('draft.store', () => {
  beforeEach(reset);
  afterEach(() => {
    vi.useRealTimers();
    reset();
  });

  it('returns undefined for a key that was never written', () => {
    expect(useDrafts.getState().getDraft('post.new')).toBeUndefined();
  });

  it('round-trips text for a key', () => {
    useDrafts.getState().setDraft('post.new', 'half a thought');
    expect(useDrafts.getState().getDraft('post.new')?.text).toBe('half a thought');
  });

  it('keeps drafts for different keys independent', () => {
    useDrafts.getState().setDraft('post.new', 'top level');
    useDrafts.getState().setDraft('reply.abc123', 'a reply');

    expect(useDrafts.getState().getDraft('post.new')?.text).toBe('top level');
    expect(useDrafts.getState().getDraft('reply.abc123')?.text).toBe('a reply');
  });

  it('overwrites rather than appends on repeated writes to one key', () => {
    useDrafts.getState().setDraft('post.new', 'first');
    useDrafts.getState().setDraft('post.new', 'second');

    expect(useDrafts.getState().getDraft('post.new')?.text).toBe('second');
    expect(Object.keys(useDrafts.getState().drafts)).toHaveLength(1);
  });

  it('stamps updatedAt on every write', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-15T12:00:00.000Z'));
    useDrafts.getState().setDraft('post.new', 'a');
    const first = useDrafts.getState().getDraft('post.new')!.updatedAt;

    vi.setSystemTime(new Date('2026-06-15T12:00:05.000Z'));
    useDrafts.getState().setDraft('post.new', 'b');
    const second = useDrafts.getState().getDraft('post.new')!.updatedAt;

    expect(second).toBeGreaterThan(first);
  });

  it('clearDraft removes only the target key', () => {
    useDrafts.getState().setDraft('post.new', 'keep me');
    useDrafts.getState().setDraft('reply.abc123', 'delete me');

    useDrafts.getState().clearDraft('reply.abc123');

    expect(useDrafts.getState().getDraft('reply.abc123')).toBeUndefined();
    expect(useDrafts.getState().getDraft('post.new')?.text).toBe('keep me');
  });

  it('clearDraft on an absent key is a no-op, not a throw', () => {
    useDrafts.getState().setDraft('post.new', 'keep me');
    expect(() => useDrafts.getState().clearDraft('never.existed')).not.toThrow();
    expect(useDrafts.getState().getDraft('post.new')?.text).toBe('keep me');
  });

  it('stores empty string as a real draft rather than dropping it', () => {
    // The composer clears text to '' before the user navigates away; that must
    // be distinguishable from "no draft" so the caller can decide.
    useDrafts.getState().setDraft('post.new', '');
    expect(useDrafts.getState().getDraft('post.new')).toBeDefined();
    expect(useDrafts.getState().getDraft('post.new')?.text).toBe('');
  });
});
