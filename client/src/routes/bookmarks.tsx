import { useTranslation } from 'react-i18next';
import { BookmarksFeed } from '@/features/bookmarks/BookmarksFeed';
import s from './bookmarks.module.css';

export default function BookmarksRoute() {
  const { t } = useTranslation();

  return (
    <div className={s.page}>
      <header className={s.pageHeader}>
        <h1 className={s.title}>{t('nav.bookmarks')}</h1>
      </header>
      <BookmarksFeed />
    </div>
  );
}
