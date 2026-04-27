import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { FeaturedTopicDTO } from '@/api/types';
import s from '../explore.module.css';

export function ExploreTopics({ topics }: { topics: FeaturedTopicDTO[] }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  if (topics.length === 0) return null;

  // Generate a deterministic gradient from slug for cover fallback
  const slugToGradient = (slug: string) => {
    const hue = (slug.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0) * 37) % 360;
    return `linear-gradient(135deg, hsl(${hue},60%,40%), hsl(${(hue + 60) % 360},50%,60%))`;
  };

  return (
    <div className={s.topicsSection}>
      <div className={s.sectionHeader}>
        <h2 className={s.sectionTitle}>{t('explore.featuredTopics')}</h2>
      </div>
      <div className={s.topicsGrid}>
        {topics.map((topic) => (
          <button
            key={topic.slug}
            type="button"
            className={s.topicCard}
            onClick={() => navigate(`/tag/${topic.slug}`)}
            aria-label={topic.display}
          >
            <div
              className={s.topicCover}
              style={
                topic.coverImage
                  ? { backgroundImage: `url(${topic.coverImage})` }
                  : { background: slugToGradient(topic.slug) }
              }
            />
            <div className={s.topicBody}>
              <div className={s.topicName}>#{topic.display}</div>
              {topic.description && <p className={s.topicDesc}>{topic.description}</p>}
              <span className={s.topicMeta}>
                {topic.postCount.toLocaleString()} {t('explore.topicsPostCount')}
              </span>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
