import { type FormEvent, useEffect, useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import * as usersApi from '@/api/users.api';
import * as authApi from '@/api/auth.api';
import { useSession } from '@/stores/session.store';
import type { ApiError } from '@/api/types';
import {
  Avatar,
  Button,
  Card,
  Input,
  Textarea,
} from '@/components/primitives';
import s from './settings.module.css';

export default function SettingsRoute() {
  const user = useSession((st) => st.user);
  const setUser = useSession((st) => st.setUser);

  const [displayName, setDisplayName] = useState('');
  const [bio, setBio] = useState('');
  const [headline, setHeadline] = useState('');

  useEffect(() => {
    if (user) {
      setDisplayName(user.displayName || '');
      setBio(user.bio || '');
      setHeadline(user.headline || '');
    }
  }, [user]);

  const saveProfile = useMutation({
    mutationFn: () => usersApi.updateMe({ displayName, bio, headline }),
    onSuccess: (updated) => {
      setUser(updated);
      toast.success('Saved');
    },
    onError: (err) => toast.error((err as unknown as ApiError).message),
  });

  const avatar = useMutation({
    mutationFn: (file: File) => usersApi.updateAvatar(file),
    onSuccess: (url) => {
      if (user) setUser({ ...user, avatarUrl: url });
      toast.success('Avatar updated');
    },
    onError: (err) => toast.error((err as unknown as ApiError).message),
  });

  const [currentPwd, setCurrentPwd] = useState('');
  const [newPwd, setNewPwd] = useState('');
  const changePwd = useMutation({
    mutationFn: () =>
      authApi.changePassword({ currentPassword: currentPwd, newPassword: newPwd }),
    onSuccess: () => {
      setCurrentPwd('');
      setNewPwd('');
      toast.success('Password changed');
    },
    onError: (err) => toast.error((err as unknown as ApiError).message),
  });

  const fileRef = useRef<HTMLInputElement | null>(null);

  if (!user) return null;

  return (
    <div className={s.page}>
      <h1 className={s.title}>Settings</h1>

      <Card as="section" className={s.section}>
        <header className={s.sectionHeader}>
          <h2 className={s.sectionTitle}>Profile</h2>
          <p className={s.sectionDesc}>What others see on your profile.</p>
        </header>
        <form
          className={s.form}
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            saveProfile.mutate();
          }}
        >
          <Input
            label="Display name"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
          />
          <Input
            label="Headline"
            value={headline}
            onChange={(e) => setHeadline(e.target.value)}
            maxLength={80}
            hint="A single line shown on your profile card."
          />
          <Textarea
            label="Bio"
            rows={4}
            value={bio}
            onChange={(e) => setBio(e.target.value)}
            maxLength={280}
            showCounter
          />
          <div className={s.formActions}>
            <Button variant="primary" type="submit" disabled={saveProfile.isPending}>
              {saveProfile.isPending ? 'Saving…' : 'Save changes'}
            </Button>
          </div>
        </form>
      </Card>

      <Card as="section" className={s.section}>
        <header className={s.sectionHeader}>
          <h2 className={s.sectionTitle}>Avatar</h2>
          <p className={s.sectionDesc}>A small picture, 5 MB max.</p>
        </header>
        <div className={s.avatarRow}>
          <Avatar
            src={user.avatarUrl}
            name={user.displayName || user.username}
            size="lg"
            alt=""
          />
          <Button
            variant="subtle"
            onClick={() => fileRef.current?.click()}
            disabled={avatar.isPending}
          >
            {avatar.isPending ? 'Uploading…' : 'Upload new'}
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            className={s.hiddenInput}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) avatar.mutate(f);
              e.target.value = '';
            }}
          />
        </div>
      </Card>

      <Card as="section" className={s.section}>
        <header className={s.sectionHeader}>
          <h2 className={s.sectionTitle}>Password</h2>
          <p className={s.sectionDesc}>
            Changing your password signs out all other sessions.
          </p>
        </header>
        <form
          className={s.form}
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            changePwd.mutate();
          }}
        >
          <Input
            label="Current password"
            type="password"
            autoComplete="current-password"
            value={currentPwd}
            onChange={(e) => setCurrentPwd(e.target.value)}
            required
          />
          <Input
            label="New password"
            type="password"
            autoComplete="new-password"
            value={newPwd}
            onChange={(e) => setNewPwd(e.target.value)}
            minLength={8}
            hint="At least 8 characters."
            required
          />
          <div className={s.formActions}>
            <Button variant="primary" type="submit" disabled={changePwd.isPending}>
              {changePwd.isPending ? 'Changing…' : 'Change password'}
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
