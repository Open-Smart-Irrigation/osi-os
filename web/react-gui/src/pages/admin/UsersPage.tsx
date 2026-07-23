import { FormEvent, useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { AdminUser } from '../../types/farming';
import {
  createUser,
  getApiErrorMessage,
  listUsers,
  resetPassword,
  setUserDisabled,
  setUserRole,
} from '../../services/api';

const INPUT = 'rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-[var(--text)]';
const BUTTON = 'btn-liquid rounded-lg px-4 py-2 font-semibold text-[var(--text)]';

export function UsersPage() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<AdminUser['role']>('researcher');
  const [resetFor, setResetFor] = useState<AdminUser | null>(null);
  const [resetValue, setResetValue] = useState('');
  const [resetConfirmation, setResetConfirmation] = useState('');

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setUsers(await listUsers());
      setError('');
    } catch (cause) {
      setError(getApiErrorMessage(cause, 'Unable to load users.'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function run(action: () => Promise<unknown>) {
    try {
      setError('');
      await action();
      await refresh();
    } catch (cause) {
      setError(getApiErrorMessage(cause, 'The account change could not be saved.'));
    }
  }

  async function submitCreate(event: FormEvent) {
    event.preventDefault();
    await run(() => createUser({ username, password, role }));
    setUsername('');
    setPassword('');
  }

  async function submitReset(event: FormEvent) {
    event.preventDefault();
    if (!resetFor) return;
    if (resetValue !== resetConfirmation) {
      setError('The passwords do not match.');
      return;
    }
    await run(() => resetPassword(resetFor.user_uuid, resetValue));
    setResetFor(null);
    setResetValue('');
    setResetConfirmation('');
  }

  return (
    <main className="min-h-screen bg-[var(--background)] p-4 text-[var(--text)] sm:p-8">
      <div className="mx-auto max-w-6xl space-y-6">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm text-[var(--text-secondary)]">Administration</p>
            <h1 className="text-3xl font-bold">Users</h1>
          </div>
          <nav className="flex gap-3" aria-label="Administration">
            <Link className={BUTTON} to="/admin/grants">Access grants</Link>
            <Link className={BUTTON} to="/dashboard">Dashboard</Link>
          </nav>
        </header>

        {error && <p role="alert" className="rounded-lg border border-red-400 bg-red-50 p-3 text-red-800">{error}</p>}

        <section className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-sm">
          <h2 className="mb-4 text-xl font-semibold">Create user</h2>
          <form className="grid gap-3 sm:grid-cols-4" onSubmit={submitCreate}>
            <label className="grid gap-1 text-sm">Username
              <input className={INPUT} required value={username} onChange={(event) => setUsername(event.target.value)} />
            </label>
            <label className="grid gap-1 text-sm">Temporary password
              <input className={INPUT} required minLength={6} type="password" value={password} onChange={(event) => setPassword(event.target.value)} />
            </label>
            <label className="grid gap-1 text-sm">Role
              <select className={INPUT} value={role} onChange={(event) => setRole(event.target.value as AdminUser['role'])}>
                <option value="researcher">Researcher</option>
                <option value="viewer">Viewer</option>
                <option value="admin">Administrator</option>
              </select>
            </label>
            <button className={`${BUTTON} self-end`} type="submit">Create user</button>
          </form>
        </section>

        <section className="overflow-x-auto rounded-2xl border border-[var(--border)] bg-[var(--surface)] shadow-sm">
          {loading ? <p className="p-5">Loading users…</p> : (
            <table className="w-full text-left">
              <thead className="border-b border-[var(--border)] text-sm text-[var(--text-secondary)]">
                <tr><th className="p-4">Username</th><th className="p-4">Role</th><th className="p-4">Status</th><th className="p-4">Created</th><th className="p-4">Actions</th></tr>
              </thead>
              <tbody>
                {users.map((user) => (
                  <tr key={user.user_uuid} className="border-b border-[var(--border)] last:border-0">
                    <td className="p-4 font-semibold">{user.username}</td>
                    <td className="p-4">
                      <select aria-label={`Role for ${user.username}`} className={INPUT} value={user.role} onChange={(event) => void run(() => setUserRole(user.user_uuid, event.target.value as AdminUser['role']))}>
                        <option value="admin">Administrator</option><option value="researcher">Researcher</option><option value="viewer">Viewer</option>
                      </select>
                    </td>
                    <td className="p-4">{user.disabled_at ? 'Disabled' : 'Enabled'}</td>
                    <td className="p-4">{new Date(user.created_at).toLocaleDateString()}</td>
                    <td className="p-4">
                      <div className="flex flex-wrap gap-2">
                        <button className={BUTTON} type="button" onClick={() => void run(() => setUserDisabled(user.user_uuid, !user.disabled_at))}>{user.disabled_at ? 'Enable' : 'Disable'}</button>
                        <button className={BUTTON} type="button" onClick={() => setResetFor(user)}>Reset password</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        {resetFor && (
          <section className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-sm">
            <h2 className="mb-3 text-xl font-semibold">Reset password for {resetFor.username}</h2>
            <form className="grid gap-3 sm:grid-cols-3" onSubmit={submitReset}>
              <input aria-label="New temporary password" className={INPUT} minLength={6} required type="password" value={resetValue} onChange={(event) => setResetValue(event.target.value)} />
              <input aria-label="Confirm temporary password" className={INPUT} minLength={6} required type="password" value={resetConfirmation} onChange={(event) => setResetConfirmation(event.target.value)} />
              <div className="flex gap-2"><button className={BUTTON} type="submit">Save password</button><button className={BUTTON} type="button" onClick={() => setResetFor(null)}>Cancel</button></div>
            </form>
          </section>
        )}
      </div>
    </main>
  );
}
