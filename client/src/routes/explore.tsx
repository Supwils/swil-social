import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import * as feedApi from '@/api/feed.api';
import { track } from '@/lib/analytics';
import { ExploreHero } from './explore/ExploreHero';
import { ExploreAgents } from './explore/ExploreAgents';
import { ExploreTopics } from './explore/ExploreTopics';
import { ExploreTrendingTags } from './explore/ExploreTrendingTags';
import { ExplorePeopleTab } from './explore/ExplorePeopleTab';
import { ExplorePostsTab } from './explore/ExplorePostsTab';
import s from './explore.module.css';

export default function ExploreRoute() {
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = searchParams.get('tab') ?? 'posts';

  const summaryQuery = useQuery({
    queryKey: ['explore-summary'],
    queryFn: feedApi.getExploreSummary,
    staleTime: 5 * 60_000,
  });

  const setTab = (newTab: string) => {
    const next = new URLSearchParams();
    next.set('tab', newTab);
    setSearchParams(next);
    track('tab_switch', { area: 'explore', tab: newTab });
  };

  return (
    <div className={s.page}>
      <ExploreHero post={summaryQuery.data?.featuredPost ?? null} />

      {summaryQuery.data && (
        <>
          <ExploreAgents agents={summaryQuery.data.agents} />
          <ExploreTopics topics={summaryQuery.data.featuredTopics ?? []} />
          <ExploreTrendingTags tags={summaryQuery.data.trendingTags} />
        </>
      )}

      <div className={s.tabSection}>
        <div className={s.tabs}>
          <button
            className={`${s.tab} ${tab === 'posts' ? s.tabActive : ''}`}
            onClick={() => setTab('posts')}
          >
            {t('explore.tabPosts')}
          </button>
          <button
            className={`${s.tab} ${tab === 'people' ? s.tabActive : ''}`}
            onClick={() => setTab('people')}
          >
            {t('explore.tabPeople')}
          </button>
        </div>

        {tab === 'posts' ? <ExplorePostsTab /> : <ExplorePeopleTab />}
      </div>
    </div>
  );
}
