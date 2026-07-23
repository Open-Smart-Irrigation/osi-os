import { FormEvent, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { AdminUser, IrrigationZone } from '../../types/farming';
import {
  getApiErrorMessage,
  grantPlot,
  grantZone,
  irrigationZonesAPI,
  listUsers,
  revokeGrant,
} from '../../services/api';
import type { GrantAssignment } from '../../services/api';

type VisibleGrant = GrantAssignment & { kind: 'zone' | 'plot' };
const INPUT = 'rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-[var(--text)]';
const BUTTON = 'btn-liquid rounded-lg px-4 py-2 font-semibold text-[var(--text)]';

export function GrantsPage() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [zones, setZones] = useState<IrrigationZone[]>([]);
  const [selectedUser, setSelectedUser] = useState('');
  const [zoneUuid, setZoneUuid] = useState('');
  const [plotUuid, setPlotUuid] = useState('');
  const [grants, setGrants] = useState<VisibleGrant[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    Promise.all([listUsers(), irrigationZonesAPI.getAll()])
      .then(([nextUsers, nextZones]) => {
        setUsers(nextUsers);
        setZones(nextZones);
        setSelectedUser(nextUsers[0]?.user_uuid ?? '');
        setZoneUuid(nextZones.find((zone) => zone.zone_uuid)?.zone_uuid ?? '');
      })
      .catch((cause) => setError(getApiErrorMessage(cause, 'Unable to load grant resources.')));
  }, []);

  async function addZone(event: FormEvent) {
    event.preventDefault();
    try {
      const grant = await grantZone(selectedUser, zoneUuid);
      setGrants((current) => [...current, { ...grant, kind: 'zone' }]);
      setError('');
    } catch (cause) {
      setError(getApiErrorMessage(cause, 'The zone grant could not be created.'));
    }
  }

  async function addPlot(event: FormEvent) {
    event.preventDefault();
    try {
      const grant = await grantPlot(selectedUser, plotUuid);
      setGrants((current) => [...current, { ...grant, kind: 'plot' }]);
      setPlotUuid('');
      setError('');
    } catch (cause) {
      setError(getApiErrorMessage(cause, 'The plot grant could not be created.'));
    }
  }

  async function remove(grant: VisibleGrant) {
    if (!window.confirm('Revoke this grant? The user will lose access after their scope refreshes.')) return;
    try {
      await revokeGrant(grant.kind, grant.assignment_uuid);
      setGrants((current) => current.filter((item) => item.assignment_uuid !== grant.assignment_uuid));
      setError('');
    } catch (cause) {
      setError(getApiErrorMessage(cause, 'The grant could not be revoked.'));
    }
  }

  const visibleGrants = grants.filter((grant) => grant.user_uuid === selectedUser);

  return (
    <main className="min-h-screen bg-[var(--background)] p-4 text-[var(--text)] sm:p-8">
      <div className="mx-auto max-w-6xl space-y-6">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div><p className="text-sm text-[var(--text-secondary)]">Administration</p><h1 className="text-3xl font-bold">Access grants</h1></div>
          <nav className="flex gap-3" aria-label="Administration"><Link className={BUTTON} to="/admin/users">Users</Link><Link className={BUTTON} to="/dashboard">Dashboard</Link></nav>
        </header>
        {error && <p role="alert" className="rounded-lg border border-red-400 bg-red-50 p-3 text-red-800">{error}</p>}
        <div className="grid gap-6 md:grid-cols-[minmax(14rem,1fr)_2fr]">
          <section className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-sm">
            <h2 className="mb-3 text-xl font-semibold">User</h2>
            <select aria-label="User" className={`${INPUT} w-full`} value={selectedUser} onChange={(event) => setSelectedUser(event.target.value)}>
              {users.map((user) => <option key={user.user_uuid} value={user.user_uuid}>{user.username}</option>)}
            </select>
          </section>
          <section className="space-y-5 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-sm">
            <div>
              <h2 className="text-xl font-semibold">Grant access</h2>
              <p className="text-sm text-[var(--text-secondary)]">New grants appear below. Existing grants cannot be listed by the current edge API.</p>
            </div>
            <form className="flex flex-wrap gap-3" onSubmit={addZone}>
              <select aria-label="Zone" className={`${INPUT} min-w-56 flex-1`} required value={zoneUuid} onChange={(event) => setZoneUuid(event.target.value)}>
                {zones.filter((zone) => zone.zone_uuid).map((zone) => <option key={zone.zone_uuid!} value={zone.zone_uuid!}>{zone.name}</option>)}
              </select>
              <button className={BUTTON} disabled={!selectedUser || !zoneUuid} type="submit">Grant zone</button>
            </form>
            <form className="flex flex-wrap gap-3" onSubmit={addPlot}>
              <input aria-label="Plot UUID" className={`${INPUT} min-w-56 flex-1`} placeholder="Plot UUID" required value={plotUuid} onChange={(event) => setPlotUuid(event.target.value)} />
              <button className={BUTTON} disabled={!selectedUser || !plotUuid} type="submit">Grant plot</button>
            </form>
            <div>
              <h3 className="mb-2 font-semibold">Grants created this session</h3>
              {visibleGrants.length === 0 ? <p className="text-sm text-[var(--text-secondary)]">No newly created grants.</p> : (
                <ul className="space-y-2">{visibleGrants.map((grant) => (
                  <li className="flex items-center justify-between gap-3 rounded-lg border border-[var(--border)] p-3" key={grant.assignment_uuid}>
                    <span><strong>{grant.kind}</strong> · {grant.zone_uuid ?? grant.plot_uuid}</span>
                    <button className={BUTTON} type="button" onClick={() => void remove(grant)}>Revoke</button>
                  </li>
                ))}</ul>
              )}
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}
