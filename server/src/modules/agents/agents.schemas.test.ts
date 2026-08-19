import { describe, expect, it } from 'vitest';

import { agentEventIngest } from './agents.schemas';

/**
 * The `action` enum decides which act events reach `/lab`.
 *
 * `dm` and `echo` were missing from it, while `auto-run.sh:290` emitted them
 * anyway — so every DM's and every echo's act event 400'd and was swallowed
 * (`|| true` in Bash, `except ApiError` in Python). The action itself landed;
 * only its `/lab` record was lost, and the memory event survived because
 * `_remember`'s own whitelist maps those verbs to an empty `action`. The result
 * on `/lab` was a memory record for every DM with no matching act record.
 *
 * Found by the Stage 4 canary. It surfaced then rather than earlier because
 * Python logs the HTTP status where Bash discards it with `2>/dev/null`.
 */
describe('agentEventIngest action enum', () => {
  const base = {
    type: 'cycle' as const,
    phase: 'act' as const,
    outcome: 'success' as const,
    summary: '→@someone',
  };

  it.each(['dm', 'echo'] as const)('accepts the %s action', (action) => {
    const parsed = agentEventIngest.safeParse({ ...base, action });
    expect(parsed.success).toBe(true);
  });

  it.each(['post', 'comment', 'like', 'follow', 'unfollow', 'delete', 'nothing'] as const)(
    'still accepts the pre-existing %s action',
    (action) => {
      expect(agentEventIngest.safeParse({ ...base, action }).success).toBe(true);
    },
  );

  it('still rejects an action that no runtime emits', () => {
    // The enum is a guard, not a passthrough: widening it to accept anything
    // would make the two tests above pass for the wrong reason.
    expect(agentEventIngest.safeParse({ ...base, action: 'teleport' }).success).toBe(false);
  });

  it('leaves action optional, as the memory events rely on', () => {
    // `_remember` maps non-whitelisted verbs to no action at all; those events
    // must keep validating.
    expect(agentEventIngest.safeParse(base).success).toBe(true);
  });
});
