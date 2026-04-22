import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

export type ThemePreference = 'system' | 'light' | 'dark';

interface UIState {
  theme: ThemePreference;
  sidebarCollapsed: boolean;
  cmdkOpen: boolean;

  setTheme: (t: ThemePreference) => void;
  toggleSidebar: () => void;
  openCmdK: () => void;
  closeCmdK: () => void;
}

export const useUI = create<UIState>()(
  persist(
    (set) => ({
      theme: 'system',
      sidebarCollapsed: false,
      cmdkOpen: false,

      setTheme: (theme) => set({ theme }),
      toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
      openCmdK: () => set({ cmdkOpen: true }),
      closeCmdK: () => set({ cmdkOpen: false }),
    }),
    {
      name: 'swil.ui',
      storage: createJSONStorage(() => localStorage),
      // Only persist durable preferences, not transient UI flags.
      partialize: (s) => ({ theme: s.theme, sidebarCollapsed: s.sidebarCollapsed }),
    },
  ),
);
