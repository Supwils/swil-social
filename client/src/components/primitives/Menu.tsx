import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import type { ReactNode } from 'react';
import clsx from 'clsx';
import s from './Menu.module.css';

export interface MenuProps {
  trigger: ReactNode;
  children: ReactNode;
  align?: 'start' | 'center' | 'end';
  ariaLabel?: string;
}

export function Menu({ trigger, children, align = 'end', ariaLabel }: MenuProps) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild aria-label={ariaLabel}>
        <button type="button" className={s.trigger}>
          {trigger}
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className={s.content}
          sideOffset={6}
          align={align}
          collisionPadding={8}
        >
          {children}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

export interface MenuItemProps {
  onSelect?: () => void;
  danger?: boolean;
  children: ReactNode;
}

export function MenuItem({ onSelect, danger, children }: MenuItemProps) {
  return (
    <DropdownMenu.Item
      className={clsx(s.item, danger && s.itemDanger)}
      onSelect={(e) => {
        e.preventDefault();
        onSelect?.();
      }}
    >
      {children}
    </DropdownMenu.Item>
  );
}
