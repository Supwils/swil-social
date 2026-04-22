import { Outlet, Link } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { MobileTabBar } from './MobileTabBar';
import s from './AppShell.module.css';

export function AppShell() {
  return (
    <div className={s.shell}>
      <Sidebar />
      <header className={s.topBar}>
        <Link to="/feed" className={s.topBarBrand}>
          swil
        </Link>
      </header>
      <main className={s.main}>
        <div className={s.column}>
          <Outlet />
        </div>
      </main>
      <MobileTabBar />
    </div>
  );
}
