import { useNavigate } from 'react-router-dom';
import { Button, EmptyState } from '@/components/primitives';

export default function NotFoundRoute() {
  const nav = useNavigate();
  return (
    <div className="center-page">
      <EmptyState
        title="Nothing here."
        description="The page you were looking for doesn't exist."
        action={<Button onClick={() => nav('/feed')}>Go to feed</Button>}
      />
    </div>
  );
}
