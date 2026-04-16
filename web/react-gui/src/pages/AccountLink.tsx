import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { accountLinkAPI } from '../services/api';
import type { AccountLinkStatus, AccountLinkResult, ForceSyncResult } from '../services/api';

export const AccountLink: React.FC = () => {
  const { t } = useTranslation('accountLink');

  const [status, setStatus] = useState<AccountLinkStatus | null>(null);
  const [loadingStatus, setLoadingStatus] = useState(true);

  const [action, setAction] = useState<'login' | 'register'>('login');
  const [serverUrl, setServerUrl] = useState(
    import.meta.env.VITE_OSI_SERVER_URL || 'https://server.opensmartirrigation.org'
  );
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const [showWarning, setShowWarning] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<AccountLinkResult | null>(null);
  const [error, setError] = useState('');

  const [unlinking, setUnlinking] = useState(false);
  const [showUnlinkConfirm, setShowUnlinkConfirm] = useState(false);
  const [forcingSync, setForcingSync] = useState(false);
  const [forceSyncResult, setForceSyncResult] = useState<ForceSyncResult | null>(null);
  const [showReauth, setShowReauth] = useState(false);
  const [reauthPassword, setReauthPassword] = useState('');
  const [reauthSubmitting, setReauthSubmitting] = useState(false);

  useEffect(() => {
    accountLinkAPI.getStatus()
      .then(setStatus)
      .catch(() => setStatus({ linked: false, serverUsername: null, linkedAt: null }))
      .finally(() => setLoadingStatus(false));
  }, []);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setShowWarning(true);
  };

  const handleProceed = async () => {
    setShowWarning(false);
    setSubmitting(true);
    setError('');
    try {
      const res = await accountLinkAPI.link({
        serverUrl,
        action,
        username,
        email: action === 'register' ? email : undefined,
        password,
      });
      setResult(res);
      setStatus({
        linked: true,
        serverUsername: res.serverUsername,
        linkedAt: new Date().toISOString(),
        serverUrl,
      });
    } catch (err: any) {
      const status = err.response?.status;
      if (status === 401) {
        setError(t('errors.authFailed'));
      } else if (!err.response) {
        setError(t('errors.networkError'));
      } else {
        setError(err.response?.data?.message || t('errors.generic'));
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleUnlink = async () => {
    setShowUnlinkConfirm(false);
    setUnlinking(true);
    try {
      await accountLinkAPI.unlink();
      setStatus({ linked: false, serverUsername: null, linkedAt: null });
      setResult(null);
      setForceSyncResult(null);
    } catch {
      setError(t('errors.generic'));
    } finally {
      setUnlinking(false);
    }
  };

  const handleForceSync = async () => {
    setForcingSync(true);
    setError('');
    try {
      const res = await accountLinkAPI.forceSync();
      setForceSyncResult(res);
    } catch (err: any) {
      setError(err.response?.data?.error || err.response?.data?.message || t('errors.forceSyncFailed'));
    } finally {
      setForcingSync(false);
    }
  };

  const handleReauthenticate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!status?.serverUsername || !status?.serverUrl) {
      setError(t('errors.forceSyncFailed'));
      return;
    }
    setReauthSubmitting(true);
    setError('');
    try {
      const res = await accountLinkAPI.link({
        serverUrl: status.serverUrl,
        action: 'login',
        username: status.serverUsername,
        password: reauthPassword,
      });
      setResult(res);
      setForceSyncResult(null);
      setReauthPassword('');
      setShowReauth(false);
      setStatus({
        linked: true,
        serverUsername: res.serverUsername,
        linkedAt: new Date().toISOString(),
        serverUrl: status.serverUrl,
      });
    } catch (err: any) {
      const code = err.response?.status;
      if (code === 401) {
        setError(t('errors.authFailed'));
      } else if (!err.response) {
        setError(t('errors.networkError'));
      } else {
        setError(err.response?.data?.message || t('errors.generic'));
      }
    } finally {
      setReauthSubmitting(false);
    }
  };

  const needsReauth = Boolean(
    status?.linked &&
    status.serverUsername &&
    status.serverUrl &&
    forceSyncResult &&
    !forceSyncResult.success &&
    (
      forceSyncResult.refresh.statusCode === 401 ||
      forceSyncResult.refresh.statusCode === 403 ||
      forceSyncResult.lastError?.source === 'sync-token-refresh'
    )
  );

  if (loadingStatus) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[var(--bg)]">
        <div className="inline-block animate-spin h-12 w-12 border-4 border-[var(--text)] border-t-transparent rounded-full" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[var(--bg)] px-4 py-8">
      <div className="max-w-lg mx-auto">
        <div className="mb-6">
          <Link
            to="/dashboard"
            className="text-[var(--primary)] hover:text-[var(--primary-hover)] font-semibold text-lg"
          >
            ← {t('backToDashboard')}
          </Link>
        </div>

        <div className="bg-[var(--card)] rounded-2xl shadow-2xl border border-[var(--border)] p-8">
          <h1 className="text-3xl font-bold text-[var(--text)] mb-6">{t('title')}</h1>

          {error && (
            <div className="mb-4 bg-[var(--error-bg)] border-2 border-[var(--error-bg)] text-[var(--error-text)] px-4 py-3 rounded-lg">
              {error}
            </div>
          )}

          {status?.linked ? (
            <div>
              {result ? (
                <div className="mb-6 bg-green-50 border border-green-200 rounded-lg p-4">
                  <h2 className="text-xl font-bold text-green-800 mb-2">{t('success.title')}</h2>
                  <p className="text-green-700 mb-2">{t('success.message', { username: result.serverUsername })}</p>
                  <p className="text-green-600 text-sm">
                    {t('success.claimedDevices', { count: result.claimedDevices.length })}
                  </p>
                  {result.skippedDevices.length > 0 && (
                    <p className="text-yellow-600 text-sm">
                      {t('success.skippedDevices', { count: result.skippedDevices.length })}
                    </p>
                  )}
                </div>
              ) : null}

              <div className="bg-[var(--secondary-bg)] rounded-lg p-4 mb-6">
                <p className="text-[var(--text)] font-semibold">{t('status.linked')}</p>
                {status.serverUsername && (
                  <p className="text-[var(--text-secondary)] mt-1">
                    {t('status.linkedAs', { username: status.serverUsername })}
                  </p>
                )}
                {status.linkedAt && (
                  <p className="text-[var(--text-secondary)] text-sm mt-1">
                    {t('status.linkedSince', { date: new Date(status.linkedAt).toLocaleDateString() })}
                  </p>
                )}
                {status.serverUrl && (
                  <p className="text-[var(--text-secondary)] text-sm mt-1 break-all">
                    {status.serverUrl}
                  </p>
                )}
              </div>

              <div className="bg-[var(--secondary-bg)] rounded-lg p-4 mb-6">
                <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                  <div>
                    <p className="text-[var(--text)] font-semibold">{t('sync.title')}</p>
                    <p className="text-[var(--text-secondary)] text-sm mt-1">{t('sync.description')}</p>
                  </div>
                  <button
                    onClick={handleForceSync}
                    disabled={forcingSync}
                    className="bg-[var(--primary)] hover:bg-[var(--primary-hover)] text-white font-bold px-5 py-3 rounded-lg transition-colors disabled:opacity-50"
                  >
                    {forcingSync ? t('sync.running') : t('sync.button')}
                  </button>
                </div>

                {forceSyncResult && (
                  <div className={`mt-4 rounded-lg border p-4 ${
                    forceSyncResult.success
                      ? 'border-green-200 bg-green-50'
                      : 'border-yellow-300 bg-yellow-50'
                  }`}>
                    <p className={`font-bold ${
                      forceSyncResult.success ? 'text-green-800' : 'text-yellow-800'
                    }`}>
                      {forceSyncResult.success ? t('sync.successTitle') : t('sync.partialTitle')}
                    </p>
                    <p className="text-[var(--text-secondary)] text-sm mt-1">
                      {new Date(forceSyncResult.forcedAt).toLocaleString()}
                    </p>
                    <div className="mt-3 space-y-2 text-sm text-[var(--text)]">
                      <p>
                        {forceSyncResult.refresh.succeeded
                          ? t('sync.refreshed')
                          : t('sync.usedCurrentToken')}
                      </p>
                      <p>
                        {t('sync.bootstrap', {
                          applied: forceSyncResult.bootstrap.applied,
                          skipped: forceSyncResult.bootstrap.skipped,
                        })}
                      </p>
                      <p>
                        {t('sync.outbox', {
                          delivered: forceSyncResult.outbox.deliveredCount,
                          before: forceSyncResult.outbox.beforeCount,
                          after: forceSyncResult.outbox.afterCount,
                        })}
                      </p>
                      <p>
                        {t('sync.pending', {
                          fetched: forceSyncResult.pendingCommands.fetchedCount,
                          queued: forceSyncResult.pendingCommands.queuedCount,
                        })}
                      </p>
                      {forceSyncResult.pendingCommands.appliesAfterResponse && (
                        <p>{t('sync.pendingAfterResponse')}</p>
                      )}
                      {forceSyncResult.lastError && (
                        <p className="text-yellow-800">
                          {t('sync.lastError', {
                            source: forceSyncResult.lastError.source,
                            message: forceSyncResult.lastError.message,
                          })}
                        </p>
                      )}
                    </div>
                  </div>
                )}
              </div>

              {needsReauth && (
                <div className="bg-yellow-50 border border-yellow-300 rounded-lg p-4 mb-6">
                  <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                    <div>
                      <p className="font-bold text-yellow-800">{t('reauth.title')}</p>
                      <p className="text-yellow-700 text-sm mt-1">{t('reauth.description')}</p>
                    </div>
                    {!showReauth && (
                      <button
                        onClick={() => setShowReauth(true)}
                        className="bg-yellow-600 hover:bg-yellow-700 text-white font-bold px-4 py-2 rounded-lg transition-colors"
                      >
                        {t('reauth.button')}
                      </button>
                    )}
                  </div>

                  {showReauth && (
                    <form onSubmit={handleReauthenticate} className="mt-4 space-y-3">
                      <div>
                        <label className="block text-[var(--text)] font-semibold mb-2">
                          {t('reauth.username')}
                        </label>
                        <input
                          type="text"
                          value={status.serverUsername || ''}
                          disabled
                          className="w-full px-4 py-3 bg-white border-2 border-[var(--border)] rounded-lg text-[var(--text-secondary)]"
                        />
                      </div>
                      <div>
                        <label className="block text-[var(--text)] font-semibold mb-2">
                          {t('reauth.password')}
                        </label>
                        <input
                          type="password"
                          value={reauthPassword}
                          onChange={e => setReauthPassword(e.target.value)}
                          required
                          className="w-full px-4 py-3 bg-white border-2 border-[var(--border)] rounded-lg text-[var(--text)] focus:outline-none focus:border-[var(--focus)]"
                        />
                      </div>
                      <div className="flex gap-3">
                        <button
                          type="submit"
                          disabled={reauthSubmitting}
                          className="bg-[var(--primary)] hover:bg-[var(--primary-hover)] text-white font-bold px-4 py-3 rounded-lg transition-colors disabled:opacity-50"
                        >
                          {reauthSubmitting ? t('reauth.running') : t('reauth.submit')}
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setShowReauth(false);
                            setReauthPassword('');
                          }}
                          className="bg-[var(--secondary-bg)] hover:bg-[var(--border)] text-[var(--text)] font-bold px-4 py-3 rounded-lg transition-colors"
                        >
                          {t('form.cancel')}
                        </button>
                      </div>
                    </form>
                  )}
                </div>
              )}

              {showUnlinkConfirm ? (
                <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
                  <p className="text-yellow-800 font-semibold mb-3">{t('unlink.confirm')}</p>
                  <div className="flex gap-3">
                    <button
                      onClick={handleUnlink}
                      disabled={unlinking}
                      className="bg-red-600 hover:bg-red-700 text-white font-bold px-4 py-2 rounded-lg transition-colors disabled:opacity-50"
                    >
                      {t('unlink.button')}
                    </button>
                    <button
                      onClick={() => setShowUnlinkConfirm(false)}
                      className="bg-[var(--secondary-bg)] hover:bg-[var(--border)] text-[var(--text)] font-bold px-4 py-2 rounded-lg transition-colors"
                    >
                      {t('form.cancel')}
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  onClick={() => setShowUnlinkConfirm(true)}
                  className="bg-[var(--secondary-bg)] hover:bg-[var(--border)] text-[var(--text)] font-bold text-lg px-6 py-3 rounded-lg transition-colors"
                >
                  {t('unlink.button')}
                </button>
              )}
            </div>
          ) : (
            <div>
              <div className="bg-[var(--secondary-bg)] rounded-lg p-4 mb-6">
                <p className="text-[var(--text-secondary)]">{t('status.notLinked')}</p>
              </div>

              {showWarning ? (
                <div className="bg-yellow-50 border-2 border-yellow-300 rounded-lg p-6 mb-6">
                  <h2 className="text-xl font-bold text-yellow-800 mb-3">{t('warning.title')}</h2>
                  <p className="text-yellow-700 mb-4">{t('warning.message')}</p>
                  <div className="flex gap-3">
                    <button
                      onClick={handleProceed}
                      disabled={submitting}
                      className="bg-[var(--primary)] hover:bg-[var(--primary-hover)] text-white font-bold px-6 py-3 rounded-lg transition-colors disabled:opacity-50"
                    >
                      {submitting ? t('form.submitting') : t('warning.proceed')}
                    </button>
                    <button
                      onClick={() => setShowWarning(false)}
                      className="bg-[var(--secondary-bg)] hover:bg-[var(--border)] text-[var(--text)] font-bold px-6 py-3 rounded-lg transition-colors"
                    >
                      {t('form.cancel')}
                    </button>
                  </div>
                </div>
              ) : (
                <form onSubmit={handleSubmit} className="space-y-5">
                  <div>
                    <label className="block text-[var(--text)] font-semibold mb-2">
                      {t('form.serverUrl')}
                    </label>
                    <input
                      type="url"
                      value={serverUrl}
                      onChange={e => setServerUrl(e.target.value)}
                      required
                      className="w-full px-4 py-3 bg-white border-2 border-[var(--border)] rounded-lg text-[var(--text)] focus:outline-none focus:border-[var(--focus)]"
                    />
                  </div>

                  <div>
                    <label className="block text-[var(--text)] font-semibold mb-2">
                      {t('form.actionLabel')}
                    </label>
                    <div className="flex gap-4">
                      <label className="flex items-center gap-2 text-[var(--text)]">
                        <input
                          type="radio"
                          value="login"
                          checked={action === 'login'}
                          onChange={() => setAction('login')}
                        />
                        {t('form.actionLogin')}
                      </label>
                      <label className="flex items-center gap-2 text-[var(--text)]">
                        <input
                          type="radio"
                          value="register"
                          checked={action === 'register'}
                          onChange={() => setAction('register')}
                        />
                        {t('form.actionRegister')}
                      </label>
                    </div>
                  </div>

                  <div>
                    <label className="block text-[var(--text)] font-semibold mb-2">
                      {t('form.username')}
                    </label>
                    <input
                      type="text"
                      value={username}
                      onChange={e => setUsername(e.target.value)}
                      required
                      className="w-full px-4 py-3 bg-white border-2 border-[var(--border)] rounded-lg text-[var(--text)] focus:outline-none focus:border-[var(--focus)]"
                    />
                  </div>

                  {action === 'register' && (
                    <div>
                      <label className="block text-[var(--text)] font-semibold mb-2">
                        {t('form.email')}
                      </label>
                      <input
                        type="email"
                        value={email}
                        onChange={e => setEmail(e.target.value)}
                        required
                        className="w-full px-4 py-3 bg-white border-2 border-[var(--border)] rounded-lg text-[var(--text)] focus:outline-none focus:border-[var(--focus)]"
                      />
                    </div>
                  )}

                  <div>
                    <label className="block text-[var(--text)] font-semibold mb-2">
                      {t('form.password')}
                    </label>
                    <input
                      type="password"
                      value={password}
                      onChange={e => setPassword(e.target.value)}
                      required
                      className="w-full px-4 py-3 bg-white border-2 border-[var(--border)] rounded-lg text-[var(--text)] focus:outline-none focus:border-[var(--focus)]"
                    />
                  </div>

                  <button
                    type="submit"
                    className="w-full bg-[var(--primary)] hover:bg-[var(--primary-hover)] text-white font-bold text-xl py-4 rounded-lg transition-colors shadow-lg"
                  >
                    {t('form.submit')}
                  </button>
                </form>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
