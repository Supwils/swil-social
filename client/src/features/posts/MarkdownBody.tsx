import clsx from 'clsx';
import { MarkdownBody as InnerBody } from '@/lib/markdown';
import s from './MarkdownBody.module.css';

interface Props {
  source: string;
  compact?: boolean;
  className?: string;
}

export function MarkdownBody({ source, compact, className }: Props) {
  return (
    <div className={clsx(s.body, compact && s.compact, className)}>
      <InnerBody source={source} />
    </div>
  );
}
