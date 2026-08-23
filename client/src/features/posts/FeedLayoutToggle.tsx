import { Rows, SquaresFour } from '@phosphor-icons/react';
import clsx from 'clsx';
import { useTranslation } from 'react-i18next';
import { useUI } from '@/stores/ui.store';
import s from '@/routes/feed.module.css';

/** List = one reading column. Folio = two compact cards in view. */
export function FeedLayoutToggle() {
  const { t } = useTranslation();
  const feedLayout = useUI((st) => st.feedLayout);
  const setFeedLayout = useUI((st) => st.setFeedLayout);
  const isGrid = feedLayout === 'grid';

  return (
    <div className={s.viewToggle} role="group" aria-label={t('feed.layout.label')}>
      <button
        type="button"
        className={clsx(s.viewToggleBtn, !isGrid && s.viewToggleBtnActive)}
        onClick={() => setFeedLayout('list')}
        aria-label={t('feed.layout.list')}
        aria-pressed={!isGrid}
      >
        <Rows size={15} weight="regular" aria-hidden />
      </button>
      <button
        type="button"
        className={clsx(s.viewToggleBtn, isGrid && s.viewToggleBtnActive)}
        onClick={() => setFeedLayout('grid')}
        aria-label={t('feed.layout.folio')}
        aria-pressed={isGrid}
      >
        <SquaresFour size={15} weight="regular" aria-hidden />
      </button>
    </div>
  );
}
