import { useState } from 'react';
import { NavLink } from 'react-router-dom';
import clsx from 'clsx';
import {
  HouseSimple,
  Globe,
  Bell,
  User as UserIcon,
  NotePencil,
} from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import { useSession } from '@/stores/session.store';
import { useRealtime } from '@/stores/realtime.store';
import { Dialog } from '@/components/primitives/Dialog';
import { PostComposer } from '@/features/posts/PostComposer';
import s from './MobileTabBar.module.css';

export function MobileTabBar() {
  const { t } = useTranslation();
  const user = useSession((st) => st.user);
  const unreadN = useRealtime((st) => st.unreadNotifications);
  const [composerOpen, setComposerOpen] = useState(false);

  const linkClass = ({ isActive }: { isActive: boolean }) =>
    clsx(s.tab, isActive && s.tabActive);

  return (
    <>
      <nav className={s.tabBar} aria-label="Bottom navigation">
        <NavLink to="/feed" className={linkClass} end>
          <HouseSimple weight="regular" className={s.tabIcon} aria-hidden />
          <span>{t('nav.following')}</span>
        </NavLink>
        <NavLink to="/global" className={linkClass}>
          <Globe weight="regular" className={s.tabIcon} aria-hidden />
          <span>{t('nav.global')}</span>
        </NavLink>
        {user && (
          <button className={s.composeBtn} onClick={() => setComposerOpen(true)} aria-label={t('nav.newPost')}>
            <span className={s.composeBtnInner}>
              <NotePencil weight="regular" size={20} aria-hidden />
            </span>
          </button>
        )}
        <NavLink to="/notifications" className={linkClass}>
          <Bell weight="regular" className={s.tabIcon} aria-hidden />
          <span>{t('nav.notifications')}</span>
          {unreadN > 0 && <span className={s.dot} aria-label={`${unreadN} unread`} />}
        </NavLink>
        <NavLink to={user ? `/u/${user.username}` : '/login'} className={linkClass}>
          <UserIcon weight="regular" className={s.tabIcon} aria-hidden />
          <span>{t('nav.profile')}</span>
        </NavLink>
      </nav>
      {user && (
        <Dialog open={composerOpen} onOpenChange={setComposerOpen}>
          <PostComposer bare onSuccess={() => setComposerOpen(false)} />
        </Dialog>
      )}
    </>
  );
}
