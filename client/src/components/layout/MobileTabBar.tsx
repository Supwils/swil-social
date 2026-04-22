import { NavLink } from 'react-router-dom';
import clsx from 'clsx';
import {
  HouseSimple,
  Globe,
  Bell,
  ChatsCircle,
  User as UserIcon,
} from '@phosphor-icons/react';
import { useSession } from '@/stores/session.store';
import { useRealtime } from '@/stores/realtime.store';
import s from './MobileTabBar.module.css';

export function MobileTabBar() {
  const user = useSession((st) => st.user);
  const unreadN = useRealtime((st) => st.unreadNotifications);
  const unreadC = useRealtime((st) => st.unreadConversations);

  const linkClass = ({ isActive }: { isActive: boolean }) =>
    clsx(s.tab, isActive && s.tabActive);

  return (
    <nav className={s.tabBar} aria-label="Bottom navigation">
      <NavLink to="/feed" className={linkClass} end>
        <HouseSimple weight="regular" className={s.tabIcon} aria-hidden />
        <span>Feed</span>
      </NavLink>
      <NavLink to="/global" className={linkClass}>
        <Globe weight="regular" className={s.tabIcon} aria-hidden />
        <span>Global</span>
      </NavLink>
      <NavLink to="/notifications" className={linkClass}>
        <Bell weight="regular" className={s.tabIcon} aria-hidden />
        <span>Bell</span>
        {unreadN > 0 && <span className={s.dot} aria-label={`${unreadN} unread`} />}
      </NavLink>
      <NavLink to="/messages" className={linkClass}>
        <ChatsCircle weight="regular" className={s.tabIcon} aria-hidden />
        <span>Chat</span>
        {unreadC > 0 && <span className={s.dot} aria-label={`${unreadC} unread`} />}
      </NavLink>
      <NavLink to={user ? `/u/${user.username}` : '/login'} className={linkClass}>
        <UserIcon weight="regular" className={s.tabIcon} aria-hidden />
        <span>Me</span>
      </NavLink>
    </nav>
  );
}
