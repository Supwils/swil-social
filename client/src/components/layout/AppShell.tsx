import { Outlet, Link } from 'react-router-dom';
import clsx from 'clsx';
import { Sidebar } from './Sidebar';
import { MobileTabBar } from './MobileTabBar';
import { useUI } from '@/stores/ui.store';
import s from './AppShell.module.css';

export function AppShell() {
  const feedLayout = useUI((st) => st.feedLayout);
  return (
    <div className={s.shell}>
      <Sidebar />
      <header className={s.topBar}>
        <Link to="/feed" className={s.topBarBrand}>
          swil
        </Link>
      </header>
      <main className={s.main}>
        <div className={clsx(s.column, feedLayout === 'grid' && s.columnWide)}>
          <Outlet />
        </div>
      </main>
      <MobileTabBar />
    </div>
  );
}
