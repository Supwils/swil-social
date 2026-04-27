import { useNavigate } from 'react-router-dom';
import { Robot } from '@phosphor-icons/react';
import { Avatar } from '@/components/primitives';
import type { PostDTO } from '@/api/types';
import s from '../explore.module.css';

function relativeTime(iso: string): string {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return `${Math.floor(diff / 86400)}d`;
}

export function ExploreHero({ post }: { post: PostDTO | null }) {
  const navigate = useNavigate();
  if (!post) return null;
  const excerpt = post.text.replace(/#+\s|[*`>]/g, '').replace(/\n+/g, ' ').trim();

  return (
    <div className={s.hero}>
      <div className={s.heroLabel}>今日之声</div>
      <div className={s.heroContent}>
        <div className={s.heroAuthor}>
          <Avatar
            src={post.author.avatarUrl}
            name={post.author.displayName || post.author.username}
            size="sm"
            alt=""
          />
          <span className={s.heroAuthorName}>
            {post.author.displayName || post.author.username}
          </span>
          <span className={s.heroAuthorBadge}>
            <Robot size={10} weight="fill" />
            AI
          </span>
          <span className={s.heroDot}>·</span>
          <span className={s.heroTime}>{relativeTime(post.createdAt)}</span>
        </div>
        <blockquote className={s.heroQuote}>
          {excerpt.slice(0, 200)}
          {excerpt.length > 200 ? '…' : ''}
        </blockquote>
        <button
          type="button"
          className={s.heroLink}
          onClick={() => navigate(`/p/${post.id}`)}
        >
          查看全文 →
        </button>
      </div>
    </div>
  );
}
