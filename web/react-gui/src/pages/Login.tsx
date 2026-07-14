import React, { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { useTranslation } from 'react-i18next';
import { LanguageSwitcher } from '../components/LanguageSwitcher';
import { AGROLINK_BRAND, resolveAgroscopeAssets } from '../branding/agrolink';

export const Login: React.FC = () => {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();
  const { login } = useAuth();
  const { t, i18n } = useTranslation('auth');
  const { balkenHorizontal } = resolveAgroscopeAssets(i18n.language);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      await login({ username, password });
      navigate('/dashboard');
    } catch (err: any) {
      setError(err.response?.data?.message || t('login.failed'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-scene relative min-h-screen flex items-center justify-center px-4">
      <div className="max-w-md w-full bg-[var(--card)] rounded-2xl shadow-2xl border border-[var(--border)]">
        {/* Balken crown on white (the asset's own ground), cropped to the
            readable wordmark. rounded-t + overflow-hidden live HERE, not on
            the card — the LanguageSwitcher dropdown at the bottom would be
            clipped by an overflow-hidden card. */}
        <div className="overflow-hidden rounded-t-2xl bg-white border-b border-[var(--border)]">
          <img
            src={balkenHorizontal}
            alt="Agroscope"
            className="block h-8 w-full object-cover object-left"
          />
        </div>
        <div className="p-6">
        <div className="text-center mb-5 font-brand">
          <h1 className="text-5xl font-bold text-[var(--text)]">
            {AGROLINK_BRAND.productName}
          </h1>
        </div>

        {error && (
          <div className="mb-6 bg-[var(--error-bg)] border-2 border-[var(--error-bg)] text-[var(--error-text)] px-4 py-3 rounded-lg">
            {error}
          </div>
        )}

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
              className="w-full px-4 py-3 touch-target bg-white border-2 border-[var(--border)] rounded-lg text-[var(--text)] text-lg placeholder:text-[var(--text-tertiary)] focus:outline-none focus:border-[var(--focus)] focus:ring-2 focus:ring-[var(--focus)]"
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
              className="w-full px-4 py-3 touch-target bg-white border-2 border-[var(--border)] rounded-lg text-[var(--text)] text-lg placeholder:text-[var(--text-tertiary)] focus:outline-none focus:border-[var(--focus)] focus:ring-2 focus:ring-[var(--focus)]"
              placeholder={t('login.passwordPlaceholder')}
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            className="btn-liquid-red w-full font-bold text-xl py-4 touch-target rounded-lg disabled:cursor-not-allowed"
          >
            {loading ? t('login.signingIn') : t('login.signIn')}
          </button>
        </form>

        {/* items-center is load-bearing: a stretched flex row would detach the
            LanguageSwitcher's absolutely-positioned dropdown from its trigger */}
        <div className="mt-6 flex items-center justify-center gap-5">
          <Link
            to="/register"
            className="text-sm font-medium text-[var(--text)] hover:underline"
          >
            {t('login.noAccount')}
          </Link>
          <LanguageSwitcher />
        </div>
        </div>
      </div>
    </div>
  );
};
