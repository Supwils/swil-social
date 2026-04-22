import { NavLink, useNavigate } from 'react-router-dom';
import clsx from 'clsx';
import {
  HouseSimple,
  Globe,
  User as UserIcon,
  Gear,
  SignOut,
  Bell,
  ChatsCircle,
} from '@phosphor-icons/react';
import { toast } from 'sonner';
import { useSession } from '@/stores/session.store';
import { useUI } from '@/stores/ui.store';
import { useRealtime } from '@/stores/realtime.store';
import * as authApi from '@/api/auth.api';
import { Avatar } from '@/components/primitives/Avatar';
import { Button } from '@/components/primitives/Button';
import s from './Sidebar.module.css';

export function Sidebar() {
  const user = useSession((st) => st.user);
  const clear = useSession((st) => st.clear);
  const theme = useUI((st) => st.theme);
  const setTheme = useUI((st) => st.setTheme);
  const unreadN = useRealtime((st) => st.unreadNotifications);
  const unreadC = useRealtime((st) => st.unreadConversations);
  const nav = useNavigate();

  const handleLogout = async () => {
    try {
      await authApi.logout();
    } finally {
      clear();
      toast.success('Signed out');
      nav('/login');
    }
  };

  const linkClass = ({ isActive }: { isActive: boolean }) =>
    clsx(s.link, isActive && s.linkActive);

  return (
    <aside className={s.sidebar} aria-label="Primary navigation">
      <div className={s.brand}>
        <span className={s.brandDot} aria-hidden />
        <span>swil</span>
      </div>

      <nav className={s.nav}>
        <NavLink to="/feed" className={linkClass} end>
          <HouseSimple weight="regular" className={s.icon} aria-hidden />
          <span>Following</span>
        </NavLink>
        <NavLink to="/global" className={linkClass}>
          <Globe weight="regular" className={s.icon} aria-hidden />
          <span>Global</span>
        </NavLink>
        <NavLink to="/notifications" className={linkClass}>
          <Bell weight="regular" className={s.icon} aria-hidden />
          <span>Notifications</span>
          {unreadN > 0 && <span className={s.dot} aria-label={`${unreadN} unread`} />}
        </NavLink>
        <NavLink to="/messages" className={linkClass}>
          <ChatsCircle weight="regular" className={s.icon} aria-hidden />
          <span>Messages</span>
          {unreadC > 0 && <span className={s.dot} aria-label={`${unreadC} unread`} />}
        </NavLink>
        {user && (
          <NavLink to={`/u/${user.username}`} className={linkClass}>
            <UserIcon weight="regular" className={s.icon} aria-hidden />
            <span>Profile</span>
          </NavLink>
        )}
        <NavLink to="/settings" className={linkClass}>
          <Gear weight="regular" className={s.icon} aria-hidden />
          <span>Settings</span>
        </NavLink>
      </nav>

      <div className={s.footer}>
        <div className={s.themeRow}>
          <label htmlFor="theme-select">Theme</label>
          <select
            id="theme-select"
            value={theme}
            onChange={(e) => setTheme(e.target.value as typeof theme)}
            className={s.themeSelect}
          >
            <option value="system">System</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </div>

        {user && (
          <NavLink to={`/u/${user.username}`} className={s.userCard}>
            <Avatar src={user.avatarUrl} name={user.displayName || user.username} size="md" />
            <div className={s.userMeta}>
              <span className={s.userName}>{user.displayName || user.username}</span>
              <span className={s.userHandle}>@{user.username}</span>
            </div>
          </NavLink>
        )}

        <Button
          variant="ghost"
          size="sm"
          onClick={handleLogout}
          leadingIcon={<SignOut size={16} aria-hidden />}
          fullWidth
        >
          Sign out
        </Button>
      </div>
    </aside>
  );
}
