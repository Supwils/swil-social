import { forwardRef, useId, type InputHTMLAttributes, type ReactNode } from 'react';
import clsx from 'clsx';
import s from './Input.module.css';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: ReactNode;
  hint?: ReactNode;
  error?: string;
  trailing?: ReactNode;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, hint, error, id, className, trailing, ...rest },
  ref,
) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const errorId = error ? `${inputId}-error` : undefined;
  const hintId = hint ? `${inputId}-hint` : undefined;

  return (
    <div className={s.field}>
      {label && (
        <label htmlFor={inputId} className={s.label}>
          {label}
        </label>
      )}
      <div className={s.inputWrap}>
        <input
          ref={ref}
          id={inputId}
          aria-invalid={error ? true : undefined}
          aria-describedby={[errorId, hintId].filter(Boolean).join(' ') || undefined}
          className={clsx(s.input, error && s.invalid, trailing && s.inputWithTrailing, className)}
          {...rest}
        />
        {trailing && <div className={s.trailing}>{trailing}</div>}
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
