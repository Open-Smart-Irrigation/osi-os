import React, { useState } from 'react';
import type { LoginResponse } from '../types/farming';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import osiLogo from '../assets/osi_logo.png';
import { useTranslation } from 'react-i18next';
import { LanguageSwitcher } from '../components/LanguageSwitcher';

export const Login: React.FC = () => {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  // Set when the gateway asks this account for a new password before use.
  const [changeStep, setChangeStep] = useState(false);
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [changeStoreFailed, setChangeStoreFailed] = useState(false);
  const navigate = useNavigate();
  const { login } = useAuth();
  const { t } = useTranslation('auth');

  const finish = () => {
    // Replace: Back must not return to the sign-in form of a finished login.
    navigate('/dashboard', { replace: true });
  };

  const changeError = (response: LoginResponse): string => {
    if (response.passwordChange === 'failed') return t('passwordChange.storeFailed');
    if (response.passwordChangeError === 'password_too_short') return t('passwordChange.tooShort');
    if (response.passwordChangeError === 'password_unchanged') return t('passwordChange.unchanged');
    return response.passwordChangeMessage || t('passwordChange.storeFailed');
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const outcome = await login({ username, password });
      if (outcome.status === 'password-change-required') {
        setChangeStep(true);
        return;
      }
      finish();
    } catch (err: any) {
      setError(err.response?.data?.message || t('login.failed'));
    } finally {
      setLoading(false);
    }
  };

  const handleChange = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (newPassword.length < 6) {
      setError(t('passwordChange.tooShort'));
      return;
    }
    if (newPassword !== confirmPassword) {
      setError(t('passwordChange.mismatch'));
      return;
    }
    setLoading(true);
    try {
      const outcome = await login({ username, password, newPassword });
      if (outcome.status === 'signed-in') {
        finish();
        return;
      }
      setChangeStoreFailed(outcome.response.passwordChange === 'failed');
      setError(changeError(outcome.response));
    } catch (err: any) {
      setError(err.response?.data?.message || t('login.failed'));
    } finally {
      setLoading(false);
    }
  };

  // Only offered when the gateway could not store the new password: access
  // stays available offline, and the next sign-in asks again.
  const continueWithoutChange = async () => {
    setError('');
    setLoading(true);
    try {
      await login({ username, password }, { acceptPendingPasswordChange: true });
      finish();
    } catch (err: any) {
      setError(err.response?.data?.message || t('login.failed'));
    } finally {
      setLoading(false);
    }
  };

  const inputClass = 'w-full px-4 py-3 touch-target bg-[var(--card)] border-2 border-[var(--border)] rounded-lg text-[var(--text)] text-lg placeholder:text-[var(--text-tertiary)] focus:outline-none focus:border-[var(--focus)] focus:ring-2 focus:ring-[var(--focus)]';
  const buttonClass = 'w-full bg-[var(--primary)] hover:bg-[var(--primary-hover)] disabled:bg-[var(--border)] text-[var(--on-primary)] font-bold text-xl py-4 touch-target rounded-lg transition-colors shadow-lg disabled:cursor-not-allowed disabled:text-[var(--text-disabled)]';

  return (
    <div className="relative min-h-screen flex items-center justify-center bg-[var(--bg)] px-4">
      <div className="max-w-md w-full bg-[var(--card)] rounded-2xl shadow-2xl border border-[var(--border)] p-6">
        <div className="text-center mb-5">
          <img src={osiLogo} alt="OSI OS Logo" className="mx-auto mb-4 h-14 w-14" />
          <h1 className="text-3xl font-bold text-[var(--text)] mb-2 high-contrast-text">
            OSI OS v0.8.3
          </h1>
          <p className="text-[var(--text-secondary)] text-base">{t('login.subtitle')}</p>
        </div>

        {error && (
          <div className="mb-6 bg-[var(--error-bg)] border-2 border-[var(--error-bg)] text-[var(--error-text)] px-4 py-3 rounded-lg">
            {error}
          </div>
        )}

        {changeStep ? (
          <form onSubmit={handleChange} className="space-y-4" aria-labelledby="password-change-title">
            <h2 id="password-change-title" className="text-xl font-bold text-[var(--text)]">
              {t('passwordChange.title')}
            </h2>
            <p className="text-[var(--text-secondary)] text-base">{t('passwordChange.intro')}</p>
            <div>
              <label htmlFor="new-password" className="block text-[var(--text)] text-lg font-semibold mb-2">
                {t('passwordChange.newPassword')}
              </label>
              <input
                id="new-password"
                type="password"
                autoComplete="new-password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                required
                className={inputClass}
              />
            </div>
            <div>
              <label htmlFor="confirm-new-password" className="block text-[var(--text)] text-lg font-semibold mb-2">
                {t('passwordChange.confirmPassword')}
              </label>
              <input
                id="confirm-new-password"
                type="password"
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                required
                className={inputClass}
              />
            </div>
            <button type="submit" disabled={loading} className={buttonClass}>
              {loading ? t('passwordChange.saving') : t('passwordChange.submit')}
            </button>
            {changeStoreFailed && (
              <button
                type="button"
                onClick={continueWithoutChange}
                disabled={loading}
                className="w-full text-[var(--primary)] hover:text-[var(--primary-hover)] text-lg font-semibold underline py-2 touch-target"
              >
                {t('passwordChange.continueForNow')}
              </button>
            )}
          </form>
        ) : (
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="username" className="block text-[var(--text)] text-lg font-semibold mb-2">
              {t('login.username')}
            </label>
            <input
              id="username"
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
              className="w-full px-4 py-3 touch-target bg-[var(--card)] border-2 border-[var(--border)] rounded-lg text-[var(--text)] text-lg placeholder:text-[var(--text-tertiary)] focus:outline-none focus:border-[var(--focus)] focus:ring-2 focus:ring-[var(--focus)]"
              placeholder={t('login.usernamePlaceholder')}
            />
          </div>

          <div>
            <label htmlFor="password" className="block text-[var(--text)] text-lg font-semibold mb-2">
              {t('login.password')}
            </label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              className="w-full px-4 py-3 touch-target bg-[var(--card)] border-2 border-[var(--border)] rounded-lg text-[var(--text)] text-lg placeholder:text-[var(--text-tertiary)] focus:outline-none focus:border-[var(--focus)] focus:ring-2 focus:ring-[var(--focus)]"
              placeholder={t('login.passwordPlaceholder')}
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-[var(--primary)] hover:bg-[var(--primary-hover)] disabled:bg-[var(--border)] text-[var(--on-primary)] font-bold text-xl py-4 touch-target rounded-lg transition-colors shadow-lg disabled:cursor-not-allowed disabled:text-[var(--text-disabled)]"
          >
            {loading ? t('login.signingIn') : t('login.signIn')}
          </button>
        </form>
        )}

        <div className="mt-6 space-y-4 text-center">
          <Link
            to="/register"
            className="text-[var(--primary)] hover:text-[var(--primary-hover)] text-lg font-semibold underline"
          >
            {t('login.noAccount')}
          </Link>
          <div className="flex justify-center">
            <LanguageSwitcher />
          </div>
        </div>
      </div>
    </div>
  );
};
