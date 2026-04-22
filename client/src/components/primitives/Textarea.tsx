import { forwardRef, useId, type TextareaHTMLAttributes, type ReactNode } from 'react';
import clsx from 'clsx';
import s from './Textarea.module.css';

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: ReactNode;
  error?: string;
  serif?: boolean;
  showCounter?: boolean;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { label, error, serif, showCounter, id, className, maxLength, value, ...rest },
  ref,
) {
  const autoId = useId();
  const areaId = id ?? autoId;
  const errorId = error ? `${areaId}-error` : undefined;

  const len = typeof value === 'string' ? value.length : 0;
  const over = Boolean(maxLength && len > maxLength);

  return (
    <div className={s.field}>
      {label && (
        <label htmlFor={areaId} className={s.label}>
          {label}
        </label>
      )}
      <textarea
        ref={ref}
        id={areaId}
        value={value}
        maxLength={maxLength}
        aria-invalid={error ? true : undefined}
        aria-describedby={errorId}
        className={clsx(s.textarea, serif && s.serif, error && s.invalid, className)}
        {...rest}
      />
      {showCounter && maxLength && (
        <span className={clsx(s.counter, over && s.counterOver)}>
          {len} / {maxLength}
        </span>
      )}
      {error && (
        <small id={errorId} className={s.error} role="alert">
          {error}
        </small>
      )}
    </div>
  );
});
