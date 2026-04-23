import { type FormEvent, type KeyboardEvent, useEffect, useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { X } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import * as usersApi from '@/api/users.api';
import * as authApi from '@/api/auth.api';
import { useSession } from '@/stores/session.store';
import { useUI, type ThemePreference, type LanguagePreference } from '@/stores/ui.store';
import type { ApiError } from '@/api/types';
import {
  Avatar,
  Button,
  Card,
  Input,
  Textarea,
} from '@/components/primitives';
import s from './settings.module.css';

const SUGGESTED_TAGS_BY_CATEGORY: Record<string, string[]> = {
  '身份 · Identity': [
    'developer', 'designer', 'engineer', 'writer', 'artist',
    'photographer', 'musician', 'filmmaker', 'researcher', 'student',
    'teacher', 'creator', 'entrepreneur', 'scientist', 'journalist',
    'architect', 'translator', 'therapist', 'coach', 'illustrator',
  ],
  '性格 · Personality': [
    'introvert', 'thinker', 'dreamer', 'maker', 'minimalist',
    'optimist', 'night-owl', 'wanderer', 'observer', 'empath',
    'curious', 'quiet', 'reflective', 'gentle', 'playful',
    'explorer', 'perfectionist', 'spontaneous', 'independent',
  ],
  '兴趣 · Interests': [
    'gamer', 'chef', 'athlete', 'reader', 'traveler',
    'cyclist', 'climber', 'gardener', 'coder', 'builder',
    'painter', 'dancer', 'singer', 'poet', 'philosopher',
    'cinephile', 'bookworm', 'tea-lover', 'cat-person', 'runner',
  ],
};

const ALL_SUGGESTED_TAGS = Object.values(SUGGESTED_TAGS_BY_CATEGORY).flat();

export default function SettingsRoute() {
  const { t } = useTranslation();
  const user = useSession((st) => st.user);
  const setUser = useSession((st) => st.setUser);

  const [displayName, setDisplayName] = useState('');
  const [bio, setBio] = useState('');
  const [headline, setHeadline] = useState('');
  const [profileTags, setProfileTags] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState('');

  useEffect(() => {
    if (user) {
      setDisplayName(user.displayName || '');
      setBio(user.bio || '');
      setHeadline(user.headline || '');
      setProfileTags(user.profileTags ?? []);
    }
  }, [user]);

  const addTag = (raw: string) => {
    const tag = raw.trim().toLowerCase();
    if (!tag || profileTags.length >= 10 || profileTags.includes(tag)) return;
    setProfileTags((prev) => [...prev, tag]);
    setTagInput('');
  };

  const removeTag = (tag: string) => setProfileTags((prev) => prev.filter((t) => t !== tag));

  const handleTagKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      addTag(tagInput);
    }
  };

  const saveProfile = useMutation({
    mutationFn: () => usersApi.updateMe({ displayName, bio, headline, profileTags }),
    onSuccess: (updated) => {
      setUser(updated);
      toast.success(t('settings.profile.saved'));
    },
    onError: (err) => toast.error((err as unknown as ApiError).message),
  });

  const avatar = useMutation({
    mutationFn: (file: File) => usersApi.updateAvatar(file),
    onSuccess: (url) => {
      if (user) setUser({ ...user, avatarUrl: url });
      toast.success(t('settings.avatar.updated'));
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
      toast.success(t('settings.password.changed'));
    },
    onError: (err) => toast.error((err as unknown as ApiError).message),
  });

  const theme = useUI((st) => st.theme);
  const setTheme = useUI((st) => st.setTheme);
  const language = useUI((st) => st.language);
  const setLanguage = useUI((st) => st.setLanguage);

  const changeTheme = (val: ThemePreference) => {
    setTheme(val);
    usersApi.updateMe({ preferences: { theme: val } }).catch(() => {});
  };

  const changeLanguage = (val: LanguagePreference) => {
    setLanguage(val);
    usersApi.updateMe({ preferences: { language: val } }).catch(() => {});
  };

  const fileRef = useRef<HTMLInputElement | null>(null);

  if (!user) return null;

  return (
    <div className={s.page}>
      <h1 className={s.title}>{t('settings.title')}</h1>

      <Card as="section" className={s.section}>
        <header className={s.sectionHeader}>
          <h2 className={s.sectionTitle}>{t('settings.profile.title')}</h2>
          <p className={s.sectionDesc}>{t('settings.profile.desc')}</p>
        </header>
        <form
          className={s.form}
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            saveProfile.mutate();
          }}
        >
          <Input
            label={t('settings.profile.displayName')}
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
          />
          <Input
            label={t('settings.profile.headline')}
            value={headline}
            onChange={(e) => setHeadline(e.target.value)}
            maxLength={80}
            hint={t('settings.profile.headlineHint')}
          />
          <Textarea
            label={t('settings.profile.bio')}
            rows={4}
            value={bio}
            onChange={(e) => setBio(e.target.value)}
            maxLength={280}
            showCounter
          />

          <div className={s.tagsSection}>
            <label className={s.tagsLabel}>{t('settings.profile.tags')}</label>
            <p className={s.tagsHint}>{t('settings.profile.tagsHint')}</p>
            {profileTags.length > 0 && (
              <div className={s.tagsList}>
                {profileTags.map((tag) => (
                  <span key={tag} className={s.tagChip}>
                    {tag}
                    <button
                      type="button"
                      className={s.tagRemove}
                      onClick={() => removeTag(tag)}
                      aria-label={`Remove ${tag}`}
                    >
                      <X size={12} weight="bold" />
                    </button>
                  </span>
                ))}
              </div>
            )}
            <input
              className={s.tagInput}
              type="text"
              placeholder={profileTags.length >= 10 ? t('settings.profile.maxTags') : t('settings.profile.addTag')}
              value={tagInput}
              maxLength={30}
              disabled={profileTags.length >= 10}
              onChange={(e) => setTagInput(e.target.value)}
              onKeyDown={handleTagKeyDown}
              onBlur={() => addTag(tagInput)}
            />
            {ALL_SUGGESTED_TAGS.some((tag) => !profileTags.includes(tag)) && (
              <div className={s.tagCategories}>
                {Object.entries(SUGGESTED_TAGS_BY_CATEGORY).map(([category, tags]) => {
                  const available = tags.filter((tag) => !profileTags.includes(tag));
                  if (available.length === 0) return null;
                  return (
                    <div key={category} className={s.tagCategory}>
                      <span className={s.tagCategoryLabel}>{category}</span>
                      <div className={s.tagSuggestions}>
                        {available.slice(0, 7).map((tag) => (
                          <button
                            key={tag}
                            type="button"
                            className={s.tagSuggestion}
                            onClick={() => addTag(tag)}
                            disabled={profileTags.length >= 10}
                          >
                            {tag}
                          </button>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className={s.formActions}>
            <Button variant="primary" type="submit" disabled={saveProfile.isPending}>
              {saveProfile.isPending ? t('settings.profile.saving') : t('settings.profile.save')}
            </Button>
          </div>
        </form>
      </Card>

      <Card as="section" className={s.section}>
        <header className={s.sectionHeader}>
          <h2 className={s.sectionTitle}>{t('settings.avatar.title')}</h2>
          <p className={s.sectionDesc}>{t('settings.avatar.desc')}</p>
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
            {avatar.isPending ? t('settings.avatar.uploading') : t('settings.avatar.upload')}
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
          <h2 className={s.sectionTitle}>{t('settings.password.title')}</h2>
          <p className={s.sectionDesc}>{t('settings.password.desc')}</p>
        </header>
        <form
          className={s.form}
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            changePwd.mutate();
          }}
        >
          <Input
            label={t('settings.password.current')}
            type="password"
            autoComplete="current-password"
            value={currentPwd}
            onChange={(e) => setCurrentPwd(e.target.value)}
            required
          />
          <Input
            label={t('settings.password.new')}
            type="password"
            autoComplete="new-password"
            value={newPwd}
            onChange={(e) => setNewPwd(e.target.value)}
            minLength={8}
            hint={t('settings.password.newHint')}
            required
          />
          <div className={s.formActions}>
            <Button variant="primary" type="submit" disabled={changePwd.isPending}>
              {changePwd.isPending ? t('settings.password.changing') : t('settings.password.change')}
            </Button>
          </div>
        </form>
      </Card>

      <Card as="section" className={s.section}>
        <header className={s.sectionHeader}>
          <h2 className={s.sectionTitle}>{t('settings.appearance.title')}</h2>
          <p className={s.sectionDesc}>{t('settings.appearance.desc')}</p>
        </header>
        <p className={s.appearanceLabel}>{t('settings.appearance.theme')}</p>
        <div className={s.themeToggle}>
          {(['system', 'light', 'dark'] as ThemePreference[]).map((themeVal) => (
            <button
              key={themeVal}
              type="button"
              className={`${s.themeBtn} ${theme === themeVal ? s.themeBtnActive : ''}`}
              onClick={() => changeTheme(themeVal)}
            >
              {themeVal === 'system'
                ? t('settings.appearance.themeSystem')
                : themeVal === 'light'
                ? t('settings.appearance.themeLight')
                : t('settings.appearance.themeDark')}
            </button>
          ))}
        </div>
        <p className={s.appearanceLabel}>{t('settings.appearance.language')}</p>
        <div className={s.themeToggle}>
          {(['en', 'zh'] as LanguagePreference[]).map((lang) => (
            <button
              key={lang}
              type="button"
              className={`${s.themeBtn} ${language === lang ? s.themeBtnActive : ''}`}
              onClick={() => changeLanguage(lang)}
            >
              {lang === 'en' ? t('settings.appearance.languageEn') : t('settings.appearance.languageZh')}
            </button>
          ))}
        </div>
      </Card>
    </div>
  );
}
