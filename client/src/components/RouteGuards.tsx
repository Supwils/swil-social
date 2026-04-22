import { Navigate, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useSession } from '@/stores/session.store';
import { Spinner } from '@/components/primitives';
import s from './RouteGuards.module.css';

function BootstrapGate({ children }: { children: ReactNode }) {
  const bootstrap = useSession((st) => st.bootstrap);
  if (bootstrap === 'pending') {
    return (
      <div className={s.bootstrap} role="status" aria-live="polite">
        <Spinner label="Loading" />
      </div>
    );
  }
  return <>{children}</>;
}

export function ProtectedRoute({ children }: { children: ReactNode }) {
  return (
    <BootstrapGate>
      <RequireAuth>{children}</RequireAuth>
    </BootstrapGate>
  );
}

function RequireAuth({ children }: { children: ReactNode }) {
  const user = useSession((st) => st.user);
  const location = useLocation();
  if (!user) {
    return <Navigate to="/login" state={{ from: location.pathname }} replace />;
  }
  return <>{children}</>;
}

export function PublicRoute({
  children,
  redirectIfAuthed = '/feed',
}: {
  children: ReactNode;
  redirectIfAuthed?: string;
}) {
  return (
    <BootstrapGate>
      <RedirectIfAuthed to={redirectIfAuthed}>{children}</RedirectIfAuthed>
    </BootstrapGate>
  );
}

function RedirectIfAuthed({ children, to }: { children: ReactNode; to: string }) {
  const user = useSession((st) => st.user);
  if (user) return <Navigate to={to} replace />;
  return <>{children}</>;
}
