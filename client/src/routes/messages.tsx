import { type FormEvent, useState } from 'react';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import clsx from 'clsx';
import * as messagesApi from '@/api/messages.api';
import { qk } from '@/api/queryKeys';
import { useSession } from '@/stores/session.store';
import { Avatar, Button, EmptyState } from '@/components/primitives';
import { formatRelative } from '@/lib/formatDate';
import type { ApiError, ConversationDTO } from '@/api/types';
import s from './messages.module.css';

export default function MessagesRoute() {
  const me = useSession((st) => st.user);
  const nav = useNavigate();
  const qc = useQueryClient();
  const [recipient, setRecipient] = useState('');

  const q = useInfiniteQuery({
    queryKey: qk.conversations.list,
    queryFn: ({ pageParam }) =>
      messagesApi.listConversations({ cursor: pageParam, limit: 30 }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });

  const start = useMutation({
    mutationFn: () => messagesApi.findOrCreate(recipient.trim()),
    onSuccess: (convo) => {
      setRecipient('');
      qc.invalidateQueries({ queryKey: qk.conversations.list });
      nav(`/messages/${convo.id}`);
    },
    onError: (err) => toast.error((err as unknown as ApiError).message),
  });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!recipient.trim()) return;
    start.mutate();
  };

  const items = q.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <div className={s.page}>
      <header className={s.pageHeader}>
        <h1 className={s.title}>Messages</h1>
      </header>

      <form className={s.newForm} onSubmit={onSubmit}>
        <input
          type="text"
          className={s.newInput}
          placeholder="username to message…"
          value={recipient}
          onChange={(e) => setRecipient(e.target.value)}
          aria-label="Recipient username"
          pattern="[a-zA-Z0-9_]{3,24}"
        />
        <Button
          variant="primary"
          size="sm"
          type="submit"
          disabled={start.isPending || !recipient.trim()}
        >
          Start
        </Button>
      </form>

      {q.isSuccess && items.length === 0 && (
        <EmptyState
          title="No conversations yet."
          description="Start one above — enter a username and a new room opens."
        />
      )}

      {items.map((c) => (
        <ConversationRow key={c.id} convo={c} selfId={me?.id ?? ''} />
      ))}

      {q.hasNextPage && (
        <Button variant="ghost" onClick={() => q.fetchNextPage()}>
          Load more
        </Button>
      )}
    </div>
  );
}

function ConversationRow({ convo, selfId }: { convo: ConversationDTO; selfId: string }) {
  const other = convo.participants.find((p) => p.id !== selfId) ?? convo.participants[0];
  if (!other) return null;
  return (
    <Link to={`/messages/${convo.id}`} className={clsx(s.row, convo.unread && s.rowUnread)}>
      <Avatar src={other.avatarUrl} name={other.displayName || other.username} size="md" alt="" />
      <div className={s.rowBody}>
        <div className={s.rowHeader}>
          <span className={s.rowName}>{other.displayName || other.username}</span>
          <time className={s.rowDate} dateTime={convo.updatedAt}>
            {formatRelative(convo.updatedAt)}
          </time>
        </div>
        <div className={s.rowPreview}>
          {convo.lastMessage
            ? convo.lastMessage.sender.id === selfId
              ? `You: ${convo.lastMessage.text}`
              : convo.lastMessage.text
            : 'No messages yet — say something.'}
        </div>
      </div>
    </Link>
  );
}
