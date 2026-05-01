import { Outlet, Link, useLocation } from 'react-router-dom';
import clsx from 'clsx';
import { Sidebar } from './Sidebar';
import { MobileTabBar } from './MobileTabBar';
import { RouteTransition } from '@/components/RouteTransition';
import { useUI } from '@/stores/ui.store';
import s from './AppShell.module.css';

export function AppShell() {
  const feedLayout = useUI((st) => st.feedLayout);
  const { pathname } = useLocation();
  const isFeedRoute = /^\/(feed|global|tags\/)/.test(pathname);

  return (
    <div className={s.shell}>
      <Sidebar />
      <header className={s.topBar}>
        <Link to="/feed" className={s.topBarBrand}>
          swil
        </Link>
      </header>
      <main className={s.main}>
        <div className={clsx(s.column, isFeedRoute && feedLayout === 'grid' && s.columnWide)}>
          <RouteTransition>
            <Outlet />
          </RouteTransition>
        </div>
      </main>
      <MobileTabBar />
    </div>
  );
}
