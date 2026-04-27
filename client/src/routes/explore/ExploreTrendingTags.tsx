import type { TrendingTagItem } from '@/api/types';
import s from '../explore.module.css';

export function ExploreTrendingTags({ tags }: { tags: TrendingTagItem[] }) {
  if (tags.length === 0) return null;

  const maxCount = Math.max(...tags.map((t) => t.postCount), 1);

  const goToTag = (slug: string) => {
    window.location.href = `/tag/${slug}`;
  };

  return (
    <div className={s.trending}>
      <div className={s.sectionHeader}>
        <h2 className={s.sectionTitle}>热门话题</h2>
      </div>
      <div className={s.tagCloud}>
        {tags.map((tag) => {
          const ratio = tag.postCount / maxCount;
          // 0.78rem–1.24rem for text size, 0.55–1.0 for opacity — tag-cloud weighting
          const fontSize = 0.78 + ratio * 0.46;
          const opacity = 0.55 + ratio * 0.45;
          return (
            <button
              key={tag.slug}
              type="button"
              className={s.tagCloudItem}
              style={{ fontSize: `${fontSize}rem`, opacity }}
              onClick={() => goToTag(tag.slug)}
            >
              #{tag.display}
            </button>
          );
        })}
      </div>
    </div>
  );
}
