import s from './Spinner.module.css';

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return <span className={s.spinner} role="status" aria-label={label} />;
}
