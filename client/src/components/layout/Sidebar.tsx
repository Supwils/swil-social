import { useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import clsx from 'clsx';
import {
  HouseSimple,
  Globe,
  User as UserIcon,
  UsersThree,
  Gear,
  SignOut,
  Bell,
  ChatsCircle,
  NotePencil,
  BookmarkSimple,
  Newspaper,
  ArrowSquareOut,
} from '@phosphor-icons/react';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import { useSession } from '@/stores/session.store';
import { useRealtime } from '@/stores/realtime.store';
import * as authApi from '@/api/auth.api';
import { Avatar } from '@/components/primitives/Avatar';
import { Button } from '@/components/primitives/Button';
import { Dialog } from '@/components/primitives/Dialog';
import { PostComposer } from '@/features/posts/PostComposer';
import s from './Sidebar.module.css';

export function Sidebar() {
  const { t } = useTranslation();
  const user = useSession((st) => st.user);
  const clear = useSession((st) => st.clear);
  const unreadN = useRealtime((st) => st.unreadNotifications);
  const unreadC = useRealtime((st) => st.unreadConversations);
  const nav = useNavigate();
  const [composerOpen, setComposerOpen] = useState(false);

  const handleLogout = async () => {
    try {
      await authApi.logout();
    } finally {
      clear();
      toast.success(t('nav.signOut'));
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
          <span>{t('nav.following')}</span>
        </NavLink>
        <NavLink to="/global" className={linkClass}>
          <Globe weight="regular" className={s.icon} aria-hidden />
          <span>{t('nav.global')}</span>
        </NavLink>
        <NavLink to="/notifications" className={linkClass}>
          <Bell weight="regular" className={s.icon} aria-hidden />
          <span>{t('nav.notifications')}</span>
          {unreadN > 0 && <span className={s.dot} aria-label={`${unreadN} unread`} />}
        </NavLink>
        <NavLink to="/messages" className={linkClass}>
          <ChatsCircle weight="regular" className={s.icon} aria-hidden />
          <span>{t('nav.messages')}</span>
          {unreadC > 0 && <span className={s.dot} aria-label={`${unreadC} unread`} />}
        </NavLink>
        {user && (
          <NavLink to={`/u/${user.username}`} className={linkClass}>
            <UserIcon weight="regular" className={s.icon} aria-hidden />
            <span>{t('nav.profile')}</span>
          </NavLink>
        )}
        <NavLink to="/bookmarks" className={linkClass}>
          <BookmarkSimple weight="regular" className={s.icon} aria-hidden />
          <span>{t('nav.bookmarks')}</span>
        </NavLink>
        <NavLink to="/explore" className={linkClass}>
          <UsersThree weight="regular" className={s.icon} aria-hidden />
          <span>{t('nav.people')}</span>
        </NavLink>
        <NavLink to="/settings" className={linkClass}>
          <Gear weight="regular" className={s.icon} aria-hidden />
          <span>{t('nav.settings')}</span>
        </NavLink>

        <div className={s.navDivider} />

        <a
          href="https://swil-news.vercel.app"
          target="_blank"
          rel="noopener noreferrer"
          className={s.link}
        >
          <Newspaper weight="regular" className={s.icon} aria-hidden />
          <span>{t('nav.news')}</span>
          <ArrowSquareOut size={12} className={s.externalIcon} aria-hidden />
        </a>
      </nav>

      {user && (
        <>
          <button className={s.postBtn} onClick={() => setComposerOpen(true)}>
            <NotePencil weight="regular" size={20} aria-hidden />
            <span>{t('nav.newPost')}</span>
          </button>
          <Dialog open={composerOpen} onOpenChange={setComposerOpen}>
            <PostComposer bare onSuccess={() => setComposerOpen(false)} />
          </Dialog>
        </>
      )}

      <div className={s.footer}>
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
          {t('nav.signOut')}
        </Button>
      </div>
    </aside>
  );
}
