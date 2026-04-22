import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Command } from 'cmdk';
import {
  HouseSimple,
  Globe,
  Bell,
  ChatsCircle,
  User as UserIcon,
  Gear,
  Hash,
  PencilSimple,
} from '@phosphor-icons/react';
import * as RadixDialog from '@radix-ui/react-dialog';
import { useUI } from '@/stores/ui.store';
import { useSession } from '@/stores/session.store';
import * as searchApi from '@/api/search.api';
import dialogStyles from '@/components/primitives/Dialog.module.css';
import s from './CommandPalette.module.css';

/**
 * Global ⌘K / Ctrl+K palette. Navigate routes, jump to any user by username,
 * jump to any tag.
 *
 * Uses Radix Dialog for focus trap + overlay + dismissal, wrapped around
 * the headless `cmdk` list for keyboard-driven filtering.
 */
export function CommandPalette() {
  const open = useUI((st) => st.cmdkOpen);
  const openCmdK = useUI((st) => st.openCmdK);
  const closeCmdK = useUI((st) => st.closeCmdK);
  const me = useSession((st) => st.user);
  const nav = useNavigate();
  const [query, setQuery] = useState('');

  // Global keybinding
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const modifier = e.metaKey || e.ctrlKey;
      if (modifier && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        if (open) closeCmdK();
        else openCmdK();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, openCmdK, closeCmdK]);

  useEffect(() => {
    if (!open) setQuery('');
  }, [open]);

  const go = (path: string) => {
    closeCmdK();
    nav(path);
  };

  const users = useQuery({
    queryKey: ['cmdk', 'users', query],
    queryFn: ({ signal }) => searchApi.searchUsers(query, 6, signal),
    enabled: open && query.trim().length > 0 && !query.startsWith('#'),
    staleTime: 15_000,
  });

  const isTagQuery = query.startsWith('#') && query.length > 1;
  const tagSlug = isTagQuery ? query.slice(1).toLowerCase() : null;

  return (
    <RadixDialog.Root open={open} onOpenChange={(o) => (o ? openCmdK() : closeCmdK())}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className={dialogStyles.overlay} />
        <RadixDialog.Content
          className={`${dialogStyles.content} ${s.dialogContent}`}
          aria-label="Command palette"
        >
          <RadixDialog.Title className="visually-hidden">
            Command palette
          </RadixDialog.Title>
          <Command className={s.root} shouldFilter label="Command Menu">
            <Command.Input
              value={query}
              onValueChange={setQuery}
              placeholder="Search, jump, post — start with @ for users or # for tags…"
              className={s.input}
              autoFocus
            />
            <Command.List className={s.list}>
              <Command.Empty className={s.empty}>
                {users.isFetching ? 'Searching…' : 'Nothing here.'}
              </Command.Empty>

              <Command.Group heading="Navigate" className={s.group}>
                <Item onSelect={() => go('/feed')} label="Following" keywords="feed home">
                  <HouseSimple size={16} className={s.itemIcon} aria-hidden />
                  Following
                </Item>
                <Item onSelect={() => go('/global')} label="Global" keywords="discover">
                  <Globe size={16} className={s.itemIcon} aria-hidden />
                  Global
                </Item>
                <Item onSelect={() => go('/notifications')} label="Notifications" keywords="bell">
                  <Bell size={16} className={s.itemIcon} aria-hidden />
                  Notifications
                </Item>
                <Item onSelect={() => go('/messages')} label="Messages" keywords="dm chat inbox">
                  <ChatsCircle size={16} className={s.itemIcon} aria-hidden />
                  Messages
                </Item>
                {me && (
                  <Item
                    onSelect={() => go(`/u/${me.username}`)}
                    label="My profile"
                    keywords={`profile me ${me.username}`}
                  >
                    <UserIcon size={16} className={s.itemIcon} aria-hidden />
                    My profile
                  </Item>
                )}
                <Item onSelect={() => go('/settings')} label="Settings" keywords="preferences">
                  <Gear size={16} className={s.itemIcon} aria-hidden />
                  Settings
                </Item>
              </Command.Group>

              <Command.Group heading="Actions" className={s.group}>
                <Item
                  onSelect={() => go('/feed#compose')}
                  label="New post"
                  keywords="compose write create"
                >
                  <PencilSimple size={16} className={s.itemIcon} aria-hidden />
                  New post
                </Item>
              </Command.Group>

              {tagSlug && (
                <Command.Group heading="Tag" className={s.group}>
                  <Item
                    onSelect={() => go(`/tag/${tagSlug}`)}
                    label={`Go to #${tagSlug}`}
                    keywords={`tag ${tagSlug}`}
                  >
                    <Hash size={16} className={s.itemIcon} aria-hidden />
                    #{tagSlug}
                  </Item>
                </Command.Group>
              )}

              {users.data && users.data.length > 0 && (
                <Command.Group heading="Users" className={s.group}>
                  {users.data.map((u) => (
                    <Item
                      key={u.id}
                      onSelect={() => go(`/u/${u.username}`)}
                      label={`${u.displayName || u.username} @${u.username}`}
                      keywords={`${u.username} ${u.displayName}`}
                    >
                      <UserIcon size={16} className={s.itemIcon} aria-hidden />
                      <span>{u.displayName || u.username}</span>
                      <span className={s.handle}>@{u.username}</span>
                    </Item>
                  ))}
                </Command.Group>
              )}
            </Command.List>
            <div className={s.hint}>
              <span>
                <span className={s.kbd}>↵</span> to select
              </span>
              <span>
                <span className={s.kbd}>Esc</span> to close
              </span>
            </div>
          </Command>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

function Item({
  onSelect,
  label,
  keywords,
  children,
}: {
  onSelect: () => void;
  label: string;
  keywords?: string;
  children: React.ReactNode;
}) {
  return (
    <Command.Item
      value={`${label} ${keywords ?? ''}`}
      onSelect={onSelect}
      className={s.item}
    >
      {children}
    </Command.Item>
  );
}
