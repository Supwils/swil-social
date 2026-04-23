import { useState, useEffect, type FormEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import * as authApi from '@/api/auth.api';
import { useSession } from '@/stores/session.store';
import { qk } from '@/api/queryKeys';
import type { ApiError } from '@/api/types';
import { Button, Input } from '@/components/primitives';
import s from './auth.module.css';

type Panel = 'login' | 'register';

export default function AuthPage() {
  const { t } = useTranslation();
  const loc = useLocation();
  const [panel, setPanel] = useState<Panel>(
    loc.pathname === '/register' ? 'register' : 'login'
  );

  useEffect(() => {
    setPanel(loc.pathname === '/register' ? 'register' : 'login');
  }, [loc.pathname]);

  return (
    <div className={s.page}>
      <div className={`${s.container} ${panel === 'register' ? s.active : ''}`}>
        <div className={s.mobileTabs}>
          <button
            className={`${s.mobileTab} ${panel === 'login' ? s.mobileTabActive : ''}`}
            onClick={() => setPanel('login')}
          >
            {t('auth.signIn')}
          </button>
          <button
            className={`${s.mobileTab} ${panel === 'register' ? s.mobileTabActive : ''}`}
            onClick={() => setPanel('register')}
          >
            {t('auth.createAccount')}
          </button>
        </div>

        <LoginPanel />
        <RegisterPanel />

        <div className={s.toggleContainer}>
          <div className={s.toggle}>
            <div className={`${s.togglePanel} ${s.toggleLeft}`}>
              <p className={s.toggleSub}>{t('auth.alreadyHaveAccount')}</p>
              <h2 className={s.toggleHeading}>{t('auth.welcomeBack')}</h2>
              <button className={s.toggleBtn} onClick={() => setPanel('login')}>
                {t('auth.signIn')}
              </button>
            </div>
            <div className={`${s.togglePanel} ${s.toggleRight}`}>
              <p className={s.toggleSub}>{t('auth.newToSwil')}</p>
              <h2 className={s.toggleHeading}>{t('auth.quieterSpace')}</h2>
              <button className={s.toggleBtn} onClick={() => setPanel('register')}>
                {t('auth.createAccount')}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function LoginPanel() {
  const { t } = useTranslation();
  const [usernameOrEmail, setUE] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const setUser = useSession((st) => st.setUser);
  const nav = useNavigate();
  const qc = useQueryClient();
  const loc = useLocation();

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const user = await authApi.login({ usernameOrEmail, password });
      setUser(user);
      qc.setQueryData(qk.auth.me, user);
      toast.success(`Welcome back, ${user.usernameDisplay}`);
      const dest = (loc.state as { from?: string } | null)?.from ?? '/feed';
      nav(dest);
    } catch (err) {
      const e = err as unknown as ApiError;
      setError(e.message ?? 'Login failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`${s.formContainer} ${s.signIn}`}>
      <div className={s.brand}>swil</div>
      <h1 className={s.title}>{t('auth.signIn')}</h1>

      <form onSubmit={onSubmit} className={s.form} noValidate>
        <Input
          label={t('auth.usernameOrEmail')}
          autoComplete="username"
          value={usernameOrEmail}
          onChange={(e) => setUE(e.target.value)}
          required
        />
        <Input
          label={t('auth.password')}
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
        {error && <div className={s.errorBanner} role="alert">{error}</div>}
        <Button variant="primary" type="submit" disabled={busy} fullWidth>
          {busy ? t('auth.signingIn') : t('auth.signIn')}
        </Button>
      </form>

      <div className={s.divider}>or</div>
      <a href="/auth/google" className={s.googleLink}>{t('auth.continueWithGoogle')}</a>
    </div>
  );
}

function RegisterPanel() {
  const { t } = useTranslation();
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [fields, setFields] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const setUser = useSession((st) => st.setUser);
  const nav = useNavigate();
  const qc = useQueryClient();

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setFields({});
    setBusy(true);
    try {
      const user = await authApi.register({ username, email, password, displayName });
      setUser(user);
      qc.setQueryData(qk.auth.me, user);
      toast.success(`Welcome, ${user.usernameDisplay}`);
      nav('/feed');
    } catch (err) {
      const e = err as unknown as ApiError;
      setError(e.message ?? 'Registration failed');
      if (e.fields) setFields(e.fields);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`${s.formContainer} ${s.signUp}`}>
      <div className={s.brand}>swil</div>
      <h1 className={s.title}>{t('auth.createAccount')}</h1>

      <form onSubmit={onSubmit} className={s.form} noValidate>
        <Input
          label={t('auth.username')}
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          pattern="[a-zA-Z0-9_]{3,24}"
          hint={t('auth.usernameHint')}
          error={fields.username}
          required
        />
        <Input
          label={t('auth.displayName')}
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          hint={t('auth.displayNameHint')}
        />
        <Input
          label={t('auth.email')}
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          error={fields.email}
          required
        />
        <Input
          label={t('auth.password')}
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          minLength={8}
          hint={t('auth.passwordHint')}
          error={fields.password}
          required
        />
        {error && <div className={s.errorBanner} role="alert">{error}</div>}
        <Button variant="primary" type="submit" disabled={busy} fullWidth>
          {busy ? t('auth.creating') : t('auth.createAccount')}
        </Button>
      </form>
    </div>
  );
}
