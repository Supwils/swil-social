import * as RadixDialog from '@radix-ui/react-dialog';
import type { ReactNode } from 'react';
import clsx from 'clsx';
import s from './Dialog.module.css';

export interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title?: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  contentClassName?: string;
}

/**
 * Accessible modal dialog. Focus is trapped inside and restored to the
 * previously focused element on close. Esc and overlay click dismiss.
 */
export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  contentClassName,
}: DialogProps) {
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className={s.overlay} />
        <RadixDialog.Content className={clsx(s.content, contentClassName)}>
          {title && <RadixDialog.Title className={s.title}>{title}</RadixDialog.Title>}
          {description && (
            <RadixDialog.Description className={s.description}>
              {description}
            </RadixDialog.Description>
          )}
          {children}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

export function DialogActions({ children }: { children: ReactNode }) {
  return <div className={s.actions}>{children}</div>;
}
