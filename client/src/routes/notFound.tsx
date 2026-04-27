import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button, EmptyState } from '@/components/primitives';

export default function NotFoundRoute() {
  const { t } = useTranslation();
  const nav = useNavigate();
  return (
    <div className="center-page">
      <EmptyState
        title={t('notFound.title')}
        description={t('notFound.desc')}
        action={<Button onClick={() => nav('/')}>{t('notFound.goToFeed')}</Button>}
      />
    </div>
  );
}
