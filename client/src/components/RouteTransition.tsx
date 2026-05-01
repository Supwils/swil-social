import { type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';

/**
 * Wraps route content so it remounts on pathname change, triggering the
 * `route-transition` CSS animation defined in global.css. No JS animation
 * library — pure CSS keyframes via key-based remount.
 */
export function RouteTransition({ children }: { children: ReactNode }) {
  const location = useLocation();
  return (
    <div key={location.pathname} className="route-transition">
      {children}
    </div>
  );
}
