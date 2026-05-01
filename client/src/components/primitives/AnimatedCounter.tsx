import { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import s from './AnimatedCounter.module.css';

interface Props {
  value: number;
  className?: string;
}

/**
 * Renders a number that vertically rolls when the value changes.
 * - Increment → new number rolls up from below
 * - Decrement → new number rolls down from above
 * - Initial render: no animation (avoids on-mount flicker for whole feed)
 */
export function AnimatedCounter({ value, className }: Props) {
  const [current, setCurrent] = useState(value);
  const [previous, setPrevious] = useState<number | null>(null);
  const direction = useRef<'up' | 'down'>('up');
  const isInitial = useRef(true);

  useEffect(() => {
    if (isInitial.current) {
      isInitial.current = false;
      setCurrent(value);
      return;
    }
    if (value === current) return;

    direction.current = value > current ? 'up' : 'down';
    setPrevious(current);
    setCurrent(value);

    const t = setTimeout(() => setPrevious(null), 220);
    return () => clearTimeout(t);
  }, [value, current]);

  const isDown = direction.current === 'down';

  return (
    <span className={clsx(s.counter, className)} aria-label={String(value)}>
      <span className={clsx(s.value, previous !== null && s.enter, isDown && s.down)}>
        {current}
      </span>
      {previous !== null && (
        <span className={clsx(s.value, s.exit, isDown && s.down)} aria-hidden="true">
          {previous}
        </span>
      )}
    </span>
  );
}
