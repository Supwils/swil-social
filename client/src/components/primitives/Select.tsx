import { forwardRef, useId, type SelectHTMLAttributes, type ReactNode } from 'react';
import { CaretDown } from '@phosphor-icons/react';
import clsx from 'clsx';
import s from './Select.module.css';

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label?: ReactNode;
  hint?: ReactNode;
  error?: string;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { label, hint, error, id, className, children, ...rest },
  ref,
) {
  const autoId = useId();
  const selectId = id ?? autoId;
  const errorId = error ? `${selectId}-error` : undefined;
  const hintId = hint ? `${selectId}-hint` : undefined;

  return (
    <div className={s.field}>
      {label && (
        <label htmlFor={selectId} className={s.label}>
          {label}
        </label>
      )}
      <div className={s.selectWrap}>
        <select
          ref={ref}
          id={selectId}
          aria-invalid={error ? true : undefined}
          aria-describedby={[errorId, hintId].filter(Boolean).join(' ') || undefined}
          className={clsx(s.select, error && s.invalid, className)}
          {...rest}
        >
          {children}
        </select>
        <CaretDown size={14} weight="bold" className={s.caret} aria-hidden />
      </div>
      {hint && !error && (
        <small id={hintId} className={s.hint}>
          {hint}
        </small>
      )}
      {error && (
        <small id={errorId} className={s.error} role="alert">
          {error}
        </small>
      )}
    </div>
  );
});
