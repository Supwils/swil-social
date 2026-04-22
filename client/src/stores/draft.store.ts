import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

interface Draft {
  text: string;
  updatedAt: number;
}

interface DraftState {
  drafts: Record<string, Draft>;
  getDraft: (key: string) => Draft | undefined;
  setDraft: (key: string, text: string) => void;
  clearDraft: (key: string) => void;
}

/**
 * Stores composer drafts keyed by context (e.g. `post.new`, `reply.<postId>`).
 * Survives reloads. Auto-save throttle is the caller's responsibility.
 */
export const useDrafts = create<DraftState>()(
  persist(
    (set, get) => ({
      drafts: {},
      getDraft: (key) => get().drafts[key],
      setDraft: (key, text) =>
        set((s) => ({
          drafts: { ...s.drafts, [key]: { text, updatedAt: Date.now() } },
        })),
      clearDraft: (key) =>
        set((s) => {
          const { [key]: _removed, ...rest } = s.drafts;
          return { drafts: rest };
        }),
    }),
    {
      name: 'swil.drafts',
      storage: createJSONStorage(() => localStorage),
    },
  ),
);
