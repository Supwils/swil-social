import { create } from 'zustand';
import type { UserDTO } from '@/api/types';

type Bootstrap = 'pending' | 'ready';

interface SessionState {
  user: UserDTO | null;
  bootstrap: Bootstrap;
  setUser: (user: UserDTO | null) => void;
  markReady: () => void;
  clear: () => void;
}

/**
 * Holds the authenticated user for routing decisions.
 * TanStack Query remains the source of truth for `user` data; this store
 * exists only so that ProtectedRoute / PublicRoute can make synchronous
 * decisions without subscribing to a query.
 */
export const useSession = create<SessionState>((set) => ({
  user: null,
  bootstrap: 'pending',
  setUser: (user) => set({ user }),
  markReady: () => set({ bootstrap: 'ready' }),
  clear: () => set({ user: null }),
}));
