import { FormEvent, useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { AdminUser } from '../../types/farming';
import {
  createUser,
  getApiErrorMessage,
  isLinkedPasswordResetError,
  listUsers,
  resetPassword,
  setUserDisabled,
  setUserRole,
} from '../../services/api';

const INPUT = 'min-w-0 w-full rounded-lg border border-[var(--field-border)] bg-[var(--surface)] px-3 py-2 text-[var(--text)]';
const BUTTON = 'min-w-0 whitespace-normal break-words btn-liquid rounded-lg px-4 py-2 font-semibold text-[var(--text)]';

const ERROR_MESSAGES = {
  loadError: 'Unable to load users.',
  saveError: 'The account change could not be saved.',
  passwordMismatch: 'The passwords do not match.',
  linkedResetRefused: 'This account uses linked sign-in, so its password cannot be reset on this gateway. Ask the linked-identity administrator for the approved recovery process.',
  resetError: 'The password could not be reset.',
  resetRefreshFailed: 'The password reset was sent, but the user list could not be reloaded. The reset may already have been applied; reload the page before trying again.',
};
type UserError = { key: keyof typeof ERROR_MESSAGES; cause?: unknown };

export function UsersPage() {
  const { t, i18n } = useTranslation('settings');
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<UserError | null>(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<AdminUser['role']>('researcher');
  const [resetFor, setResetFor] = useState<AdminUser | null>(null);
  const [resetValue, setResetValue] = useState('');
  const [resetConfirmation, setResetConfirmation] = useState('');

  // Returns whether the list loaded, so a caller can tell a failed reload
  // from a successful one.
  const refresh = useCallback(async (): Promise<boolean> => {
    setLoading(true);
    try {
      setUsers(await listUsers());
      setError(null);
      return true;
    } catch (cause) {
      setError({ key: 'loadError', cause });
      return false;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function run(action: () => Promise<unknown>) {
    try {
      setError(null);
      await action();
      await refresh();
    } catch (cause) {
      setError({ key: 'saveError', cause });
    }
  }

  async function submitCreate(event: FormEvent) {
    event.preventDefault();
    await run(() => createUser({ username, password, role }));
    setUsername('');
    setPassword('');
  }

  // The form keeps its account and both password fields until the reset and
  // the reload have both succeeded (#521).
  async function submitReset(event: FormEvent) {
    event.preventDefault();
    if (!resetFor) return;
    if (resetValue !== resetConfirmation) {
      setError({ key: 'passwordMismatch' });
      return;
    }
    setError(null);
    try {
      await resetPassword(resetFor.user_uuid, resetValue);
    } catch (cause) {
      setError(isLinkedPasswordResetError(cause)
        ? { key: 'linkedResetRefused' }
        : { key: 'resetError', cause });
      return;
    }
    if (!(await refresh())) {
      setError({ key: 'resetRefreshFailed' });
      return;
    }
    setResetFor(null);
    setResetValue('');
    setResetConfirmation('');
  }

  function resetAction(user: AdminUser) {
    if (user.auth_mode === 'local') {
      return <button className={BUTTON} type="button" onClick={() => setResetFor(user)}>{t('users.resetPassword', 'Reset password')}</button>;
    }
    if (user.auth_mode === 'server') {
      return (
        <p className="text-sm text-[var(--text-secondary)]">
          <span className="font-semibold">{t('users.linkedSignIn', 'Linked sign-in')}</span>
          {' '}
          {t('users.linkedResetGuidance', 'Password changes for this account use the approved linked-identity recovery process. Ask the linked-identity administrator for the correct steps.')}
        </p>
      );
    }
    return (
      <p className="text-sm text-[var(--text-secondary)]">
        {t('users.signInUnknown', 'Sign-in type unavailable. Ask the gateway administrator.')}
      </p>
    );
  }

  return (
    <main className="min-h-screen bg-[var(--bg)] p-4 text-[var(--text)] sm:p-8">
      <div className="mx-auto min-w-0 max-w-6xl space-y-6">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm text-[var(--text-secondary)]">{t('users.administration', 'Administration')}</p>
            <h1 className="text-3xl font-bold">{t('users.title', 'Users')}</h1>
          </div>
          <nav className="flex min-w-0 flex-wrap gap-3" aria-label={t('users.administration', 'Administration')}>
            <Link className={BUTTON} to="/admin/grants">{t('users.accessGrants', 'Access grants')}</Link>
            <Link className={BUTTON} to="/dashboard">{t('users.dashboard', 'Dashboard')}</Link>
          </nav>
        </header>

        {error && <p role="alert" className="break-words rounded-lg border border-red-400 bg-red-50 p-3 text-red-800">{getApiErrorMessage(error.cause, t(`users.${error.key}`, ERROR_MESSAGES[error.key]))}</p>}

        <section className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-sm">
          <h2 className="mb-4 text-xl font-semibold">{t('users.createUser', 'Create user')}</h2>
          <form className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" onSubmit={submitCreate}>
            <label className="grid min-w-0 gap-1 text-sm">{t('users.username', 'Username')}
              <input className={INPUT} required value={username} onChange={(event) => setUsername(event.target.value)} />
            </label>
            <label className="grid min-w-0 gap-1 text-sm">{t('users.temporaryPassword', 'Temporary password')}
              <input className={INPUT} required minLength={6} type="password" value={password} onChange={(event) => setPassword(event.target.value)} />
            </label>
            <label className="grid min-w-0 gap-1 text-sm">{t('users.role', 'Role')}
              <select className={INPUT} value={role} onChange={(event) => setRole(event.target.value as AdminUser['role'])}>
                <option value="researcher">{t('users.roles.researcher', 'Researcher')}</option>
                <option value="viewer">{t('users.roles.viewer', 'Viewer')}</option>
                <option value="admin">{t('users.roles.admin', 'Administrator')}</option>
              </select>
            </label>
            <button className={`${BUTTON} self-end`} type="submit">{t('users.createUser', 'Create user')}</button>
          </form>
        </section>

        <section className="min-w-0 rounded-2xl border border-[var(--border)] bg-[var(--surface)] shadow-sm">
          <p id="users-scroll-hint" className="p-4 text-sm text-[var(--text-secondary)] xl:hidden">
            {t('users.scrollHint', 'Scroll horizontally to see all user details and actions.')}
          </p>
          <div className="relative overflow-hidden rounded-2xl">
            {/* Keep the scroll region keyboard reachable, including on phones. */}
            <div role="region" aria-label={t('users.title', 'Users')} aria-describedby="users-scroll-hint" tabIndex={0} className="overflow-x-auto focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--field-border)]">
              {loading ? <p className="p-5">{t('users.loading', 'Loading users…')}</p> : (
                <table className="w-full min-w-[64rem] table-fixed text-left">
                  <thead className="border-b border-[var(--border)] text-sm text-[var(--text-secondary)]">
                    <tr><th scope="col" className="p-4">{t('users.username', 'Username')}</th><th scope="col" className="p-4">{t('users.role', 'Role')}</th><th scope="col" className="p-4">{t('users.status', 'Status')}</th><th scope="col" className="p-4">{t('users.created', 'Created')}</th><th scope="col" className="p-4">{t('users.actions', 'Actions')}</th></tr>
                  </thead>
                  <tbody>
                    {users.map((user) => (
                      <tr key={user.user_uuid} className="border-b border-[var(--border)] last:border-0">
                        <td className="break-words p-4 font-semibold [overflow-wrap:anywhere]">{user.username}</td>
                        <td className="p-4">
                          <select aria-label={t('users.roleFor', `Role for ${user.username}`, { username: user.username })} className={INPUT} value={user.role} onChange={(event) => void run(() => setUserRole(user.user_uuid, event.target.value as AdminUser['role']))}>
                            <option value="admin">{t('users.roles.admin', 'Administrator')}</option><option value="researcher">{t('users.roles.researcher', 'Researcher')}</option><option value="viewer">{t('users.roles.viewer', 'Viewer')}</option>
                          </select>
                        </td>
                        <td className="p-4">{user.disabled_at ? t('users.disabled', 'Disabled') : t('users.enabled', 'Enabled')}</td>
                        <td className="p-4">{new Date(user.created_at).toLocaleDateString(i18n?.resolvedLanguage)}</td>
                        <td className="p-4">
                          <div className="flex flex-wrap items-center gap-2">
                            <button className={BUTTON} type="button" onClick={() => void run(() => setUserDisabled(user.user_uuid, !user.disabled_at))}>{user.disabled_at ? t('users.enable', 'Enable') : t('users.disable', 'Disable')}</button>
                            {resetAction(user)}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
            <div aria-hidden="true" className="pointer-events-none absolute inset-y-0 right-0 w-4 bg-gradient-to-l from-[var(--surface)] to-transparent xl:hidden" />
          </div>
        </section>

        {resetFor && (
          <section className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-sm">
            <h2 className="mb-3 break-words text-xl font-semibold [overflow-wrap:anywhere]">{t('users.resetFor', `Reset password for ${resetFor.username}`, { username: resetFor.username })}</h2>
            <form className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" onSubmit={submitReset}>
              <label className="grid min-w-0 gap-1 text-sm">{t('users.newTemporaryPassword', 'New temporary password')}
                <input className={INPUT} minLength={6} required type="password" value={resetValue} onChange={(event) => setResetValue(event.target.value)} />
              </label>
              <label className="grid min-w-0 gap-1 text-sm">{t('users.confirmTemporaryPassword', 'Confirm temporary password')}
                <input className={INPUT} minLength={6} required type="password" value={resetConfirmation} onChange={(event) => setResetConfirmation(event.target.value)} />
              </label>
              <div className="flex min-w-0 flex-wrap items-end gap-2 sm:col-span-2 lg:col-span-1"><button className={BUTTON} type="submit">{t('users.savePassword', 'Save password')}</button><button className={BUTTON} type="button" onClick={() => setResetFor(null)}>{t('users.cancel', 'Cancel')}</button></div>
            </form>
          </section>
        )}
      </div>
    </main>
  );
}
