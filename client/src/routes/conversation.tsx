import { type FormEvent, type KeyboardEvent, useEffect, useMemo, useState } from 'react';
import { useInfiniteQuery, useMutation } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import clsx from 'clsx';
import { ArrowLeft } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import * as messagesApi from '@/api/messages.api';
import { qk } from '@/api/queryKeys';
import { useSession } from '@/stores/session.store';
import { Avatar, Button, Spinner } from '@/components/primitives';
import { emit } from '@/api/realtime';
import { formatRelative } from '@/lib/formatDate';
import type { ApiError, MessageDTO } from '@/api/types';
import s from './messages.module.css';

export default function ConversationRoute() {
  const { t } = useTranslation();
  const { id = '' } = useParams<{ id: string }>();
  const me = useSession((st) => st.user);
  const nav = useNavigate();
  const [text, setText] = useState('');

  useEffect(() => {
    if (!id) return;
    emit('conversation:join', { conversationId: id });
    return () => {
      emit('conversation:leave', { conversationId: id });
    };
  }, [id]);

  useEffect(() => {
    if (!id) return;
    messagesApi.markRead(id).catch(() => undefined);
  }, [id]);

  const q = useInfiniteQuery({
    queryKey: qk.conversations.messages(id),
    queryFn: ({ pageParam }) =>
      messagesApi.listMessages(id, { cursor: pageParam, limit: 50 }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled: Boolean(id),
  });

  const send = useMutation({
    mutationFn: () => messagesApi.send(id, text.trim()),
    onSuccess: () => {
      setText('');
    },
    onError: (err) => toast.error((err as unknown as ApiError).message),
  });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    send.mutate();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      onSubmit(e as unknown as FormEvent);
    }
  };

  const messages = useMemo(
    () => q.data?.pages.flatMap((p) => p.items) ?? [],
    [q.data],
  );

  const other =
    messages.find((m) => m.sender.id !== me?.id)?.sender ??
    messages[0]?.sender ??
    null;

  if (!id) {
    nav('/messages');
    return null;
  }

  return (
    <div className={s.thread}>
      <header className={s.threadHeader}>
        <Link to="/messages" className={s.backLink}>
          <ArrowLeft size={14} weight="regular" aria-hidden /> {t('messages.back')}
        </Link>
        {other && (
          <Link to={`/u/${other.username}`} className={s.threadPeer}>
            <Avatar src={other.avatarUrl} name={other.displayName || other.username} size="sm" alt="" />
            <strong>{other.displayName || other.username}</strong>
            <span className={s.rowDate}>@{other.username}</span>
          </Link>
        )}
      </header>

      <div className={s.threadBody}>
        {q.isLoading && <Spinner />}
        {messages.map((m) => (
          <MessageBubble key={m.id} m={m} mine={m.sender.id === me?.id} />
        ))}
        {q.hasNextPage && (
          <div className={s.loadOlder}>
            <Button variant="ghost" size="sm" onClick={() => q.fetchNextPage()}>
              {t('messages.loadOlder')}
            </Button>
          </div>
        )}
      </div>

      <form onSubmit={onSubmit} className={s.composeRow}>
        <textarea
          className={s.composeInput}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={t('messages.messagePlaceholder')}
          maxLength={4000}
          rows={1}
          aria-label="Your message"
        />
        <Button
          variant="primary"
          type="submit"
          disabled={send.isPending || !text.trim()}
        >
          {t('messages.send')}
        </Button>
      </form>
    </div>
  );
}

function MessageBubble({ m, mine }: { m: MessageDTO; mine: boolean }) {
  return (
    <div>
      <div className={clsx(s.message, mine && s.messageMine)}>{m.text}</div>
      <div className={s.messageMeta}>
        <time dateTime={m.createdAt}>{formatRelative(m.createdAt)}</time>
      </div>
    </div>
  );
}
