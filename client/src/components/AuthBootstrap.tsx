import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useSession } from '@/stores/session.store';
import { qk } from '@/api/queryKeys';
import { onUnauthorized } from '@/api/client';
import * as authApi from '@/api/auth.api';
import { useUI } from '@/stores/ui.store';
import { applyTheme, watchSystemTheme } from '@/lib/applyTheme';

/**
 * One-time app bootstrap:
 *  - Calls /auth/me, hydrates session store
 *  - Wires 401 interceptor to clear the session
 *  - Applies theme and watches system changes
 */
export function AuthBootstrap() {
  const setUser = useSession((s) => s.setUser);
  const markReady = useSession((s) => s.markReady);
  const clear = useSession((s) => s.clear);
  const qc = useQueryClient();
  const theme = useUI((s) => s.theme);

  useEffect(() => {
    applyTheme(theme);
    if (theme !== 'system') return;
    return watchSystemTheme(() => applyTheme(theme));
  }, [theme]);

  useEffect(() => {
    onUnauthorized(() => {
      clear();
      qc.clear();
    });
  }, [clear, qc]);

  useEffect(() => {
    let active = true;
    authApi
      .me()
      .then((user) => {
        if (!active) return;
        setUser(user);
        if (user) qc.setQueryData(qk.auth.me, user);
      })
      .catch(() => {
        if (!active) return;
        setUser(null);
      })
      .finally(() => {
        if (active) markReady();
      });
    return () => {
      active = false;
    };
  }, [setUser, markReady, qc]);

  return null;
}
