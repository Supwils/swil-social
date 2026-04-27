import { describe, it, expect } from 'vitest';
import { detectTrigger, applySelection } from './useAutocomplete';

describe('detectTrigger', () => {
  it('returns null when text is empty', () => {
    expect(detectTrigger('', 0)).toBeNull();
  });

  it('returns null when cursor is at a bare @ with no query', () => {
    expect(detectTrigger('@', 1)).toBeNull();
    expect(detectTrigger('hello @', 7)).toBeNull();
  });

  it('detects @ trigger at start of input', () => {
    const trig = detectTrigger('@xu', 3);
    expect(trig).toEqual({ prefix: '@', query: 'xu', triggerIndex: 0 });
  });

  it('detects # trigger at start of input', () => {
    const trig = detectTrigger('#AI', 3);
    expect(trig).toEqual({ prefix: '#', query: 'AI', triggerIndex: 0 });
  });

  it('detects @ trigger after whitespace', () => {
    const trig = detectTrigger('hello @bob', 10);
    expect(trig).toEqual({ prefix: '@', query: 'bob', triggerIndex: 6 });
  });

  it('detects @ trigger after newline', () => {
    const trig = detectTrigger('line1\n@alice', 12);
    expect(trig).toEqual({ prefix: '@', query: 'alice', triggerIndex: 6 });
  });

  it('does NOT trigger when @ is mid-word (e.g. email-like)', () => {
    expect(detectTrigger('foo@bar', 7)).toBeNull();
  });

  it('uses cursor position to slice text — only what is before cursor counts', () => {
    // cursor between "ab" and "cd": "@ab|cd" — query is "ab"
    expect(detectTrigger('@abcd', 3)).toEqual({ prefix: '@', query: 'ab', triggerIndex: 0 });
  });

  it('handles unicode (CJK) usernames', () => {
    const trig = detectTrigger('@刘霜', 3);
    expect(trig).toEqual({ prefix: '@', query: '刘霜', triggerIndex: 0 });
  });

  it('allows hyphen and underscore in query', () => {
    const trig = detectTrigger('@my_user-name', 13);
    expect(trig).toEqual({ prefix: '@', query: 'my_user-name', triggerIndex: 0 });
  });

  it('stops at whitespace — multiple words after @ not captured', () => {
    expect(detectTrigger('@bob has', 8)).toBeNull();
  });

  it('picks the LAST trigger when multiple are present', () => {
    const trig = detectTrigger('@first then @second', 19);
    expect(trig).toEqual({ prefix: '@', query: 'second', triggerIndex: 12 });
  });
});

describe('applySelection', () => {
  it('replaces query with prefix + replacement + space', () => {
    const { newText, newCursor } = applySelection('@xu', 0, 2, '@', 'xuansi');
    expect(newText).toBe('@xuansi ');
    expect(newCursor).toBe(8);
  });

  it('preserves text after the trigger region', () => {
    const { newText, newCursor } = applySelection('hi @bo there', 3, 2, '@', 'bob');
    expect(newText).toBe('hi @bob  there');
    expect(newCursor).toBe(8); // 'hi @bob ' length
  });

  it('preserves text before the trigger region', () => {
    const { newText } = applySelection('say @hi', 4, 2, '@', 'hello');
    expect(newText).toBe('say @hello ');
  });

  it('works for # tag selections', () => {
    const { newText, newCursor } = applySelection('check #ai', 6, 2, '#', 'AI');
    expect(newText).toBe('check #AI ');
    expect(newCursor).toBe(10);
  });

  it('newCursor lands immediately after the inserted space', () => {
    const replacement = 'someone';
    const { newCursor } = applySelection('@a', 0, 1, '@', replacement);
    // '@' + 'someone' + ' ' = 9 chars → cursor at 9
    expect(newCursor).toBe(1 + replacement.length + 1);
  });
});
