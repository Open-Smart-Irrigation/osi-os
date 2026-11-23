import assert from 'node:assert/strict';
import {test} from 'node:test';
import {AxiosError, isAxiosError, isCancel} from 'axios';
import {accountLinkAPI, api, authAPI, devicesAPI, fetchScopeProfile, irrigationZonesAPI, lsn50API, stregaAPI} from '../../src/services/api';
import {beginAuthSession, endAuthSession, getAuthSession, StaleSessionRequestError} from '../../src/services/authSession';
import {createDemoAdapter} from '../adapter';
import {Simulator} from '../model';

function install(sim: Simulator) { api.defaults.adapter = createDemoAdapter(sim); }

const authStorage = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {configurable: true, value: {
  getItem: (key: string) => authStorage.get(key) ?? null,
  setItem: (key: string, value: string) => { authStorage.set(key, String(value)); },
  removeItem: (key: string) => { authStorage.delete(key); },
  clear: () => authStorage.clear(),
  key: (index: number) => [...authStorage.keys()][index] ?? null,
  get length() { return authStorage.size; },
}});

test('AU01 reports the seeded public researcher and its unrestricted fictional farm scope', async () => {
  const sim = new Simulator({mode: 'public'});
  install(sim);
  const profile = await fetchScopeProfile();
  assert.equal(profile.username, 'Demo farmer');
  assert.equal(profile.role, 'researcher');
  assert.equal(profile.features.scoped_access, false);
  assert.equal(profile.zone_uuids, null);
  assert.equal(profile.plot_uuids, null);
});

test('AU02 accepts the visible demo credentials and rejects invalid credentials without changing the current identity', async () => {
  const sim = new Simulator({mode: 'public'});
  install(sim);
  const first = await authAPI.login({username: 'Demo farmer', password: 'demo'});
  assert.ok(first.token.startsWith('demo-session-'));
  assert.equal((await fetchScopeProfile()).username, 'Demo farmer');
  await assert.rejects(authAPI.login({username: 'Demo farmer', password: 'wrong'}), (error: unknown) => {
    assert.ok(error instanceof AxiosError);
    assert.equal(error.response?.status, 401);
    assert.deepEqual(error.response?.data, {error: 'invalid_credentials', message: 'Username or password is incorrect'});
    return true;
  });
  assert.equal((await fetchScopeProfile()).username, 'Demo farmer');
});

test('AU02 login credential failures do not expire a different active AuthSession epoch', async () => {
  install(new Simulator({mode: 'public'}));
  const existing = beginAuthSession('opaque-current-session', 'Existing researcher');
  await assert.rejects(authAPI.login({username: 'Demo farmer', password: 'bad'}));
  assert.equal(getAuthSession().sessionEpoch, existing.sessionEpoch);
  assert.equal(getAuthSession().token, 'opaque-current-session');
  endAuthSession();
});

test('AU04 stale and aborted real API writes cannot mutate farm state through the installed adapter', async () => {
  const sim = new Simulator({mode: 'public'});
  install(sim);
  beginAuthSession('old-session', 'Demo farmer');
  const oldSession = getAuthSession();
  beginAuthSession('new-session', 'Demo farmer');
  const originalName = sim.zones[0]!.name;
  await assert.rejects(api.put('/api/irrigation-zones/1/name', {name: 'Stale update'}, {authSession: oldSession}), error => {
    assert.ok(error instanceof StaleSessionRequestError);
    return true;
  });

  const abort = new AbortController();
  abort.abort();
  await assert.rejects(api.put('/api/irrigation-zones/1/name', {name: 'Aborted update'}, {signal: abort.signal}), error => {
    assert.ok(isCancel(error));
    return true;
  });
  assert.equal((await irrigationZonesAPI.getAll()).find(zone => zone.id === 1)?.name, originalName);
  endAuthSession();
});

test('AU03 registers a normalized local researcher that can re-enter the same farm', async () => {
  const sim = new Simulator({mode: 'public'});
  install(sim);
  const zones = await irrigationZonesAPI.getAll();
  const registered = await authAPI.register({username: '  Field Researcher  ', password: 'strong-pass'});
  assert.deepEqual(registered, {success: true});
  const login = await authAPI.login({username: 'field researcher', password: 'strong-pass'});
  assert.ok(login.token.startsWith('demo-session-'));
  assert.equal((await fetchScopeProfile()).username, 'Field Researcher');
  assert.deepEqual((await irrigationZonesAPI.getAll()).map(zone => zone.id), zones.map(zone => zone.id));
  await assert.rejects(authAPI.register({username: 'FIELD RESEARCHER', password: 'another-pass'}), (error: unknown) => {
    assert.ok(isAxiosError(error));
    assert.equal(error.response?.status, 409);
    assert.equal(error.response?.data?.error, 'username_exists');
    return true;
  });
});

test('AU04 logout removes the local scope and re-entry restores access without replacing farm state', async () => {
  const sim = new Simulator({mode: 'public'});
  install(sim);
  const zonesBefore = (await irrigationZonesAPI.getAll()).map(zone => ({id: zone.id, name: zone.name}));
  sim.setSessionUser(null);
  await assert.rejects(fetchScopeProfile(), (error: unknown) => {
    assert.ok(isAxiosError(error));
    assert.equal(error.response?.status, 401);
    return true;
  });
  sim.setSessionUser('Demo farmer');
  assert.equal((await fetchScopeProfile()).username, 'Demo farmer');
  assert.deepEqual((await irrigationZonesAPI.getAll()).map(zone => ({id: zone.id, name: zone.name})), zonesBefore);
});

test('AU05-AU07 link status follows fictional login, unlink, and relink actions without retaining the password', async () => {
  const sim = new Simulator({mode: 'public'});
  install(sim);
  const nativeFetch = globalThis.fetch;
  let networkRequests = 0;
  globalThis.fetch = async () => { networkRequests += 1; throw new Error('native transport must not run'); };
  try {
    assert.deepEqual(await accountLinkAPI.getStatus(), {linked: false, serverUsername: null, linkedAt: null, serverUrl: null});
    const linked = await accountLinkAPI.link({serverUrl: 'https://osicloud.ch', action: 'login', username: 'researcher@example.test', password: 'fictional-password'});
    assert.equal(linked.success, true);
    assert.equal(linked.serverUsername, 'researcher@example.test');
    assert.ok(linked.claimedDevices.length > 0);
    assert.deepEqual(linked.skippedDevices, []);
    const status = await accountLinkAPI.getStatus();
    assert.deepEqual(status, {linked: true, serverUsername: 'researcher@example.test', linkedAt: new Date(sim.now).toISOString(), serverUrl: 'https://osicloud.ch'});
    assert.equal([...sim.state.sessions.accounts.values()].some(account => account.password === 'fictional-password'), false);
    await accountLinkAPI.unlink();
    assert.deepEqual(await accountLinkAPI.getStatus(), {linked: false, serverUsername: null, linkedAt: null, serverUrl: null});
    await accountLinkAPI.link({serverUrl: 'https://example.test', action: 'register', username: 'new-account', email: 'new@example.test', password: 'second-fictional-password'});
    assert.equal((await accountLinkAPI.getStatus()).serverUsername, 'new-account');
    assert.equal([...sim.state.sessions.accounts.values()].some(account => account.password === 'second-fictional-password'), false);
    assert.equal(networkRequests, 0);
  } finally {
    globalThis.fetch = nativeFetch;
  }
});

test('AU08-AU09 force sync returns complete local results, drains its outbox once, and advances its timestamp', async () => {
  const sim = new Simulator({mode: 'public'});
  install(sim);
  const before = await accountLinkAPI.getSyncState();
  assert.equal(before.pendingOutboxCount, 0);
  assert.equal(before.lastOutboxDeliverySuccessAt, null);
  const result = await accountLinkAPI.forceSync();
  assert.deepEqual(result, {
    success: true, forcedAt: new Date(sim.now).toISOString(),
    refresh: {attempted: true, succeeded: true, statusCode: 200, syncTokenExpiresAt: null, error: null},
    bootstrap: {attempted: true, succeeded: true, applied: 0, skipped: 0, statusCode: 200, error: null},
    outbox: {attempted: true, succeeded: true, selected: before.pendingOutboxCount, applied: before.pendingOutboxCount,
      duplicate: 0, retryable: 0, rejected: 0, protocolErrors: 0, pendingAfter: 0, rejectedByCode: {},
      beforeCount: before.pendingOutboxCount, deliveredCount: before.pendingOutboxCount, afterCount: 0,
      appliedLegacy: 0, skipped: 0, statusCode: 200, error: null},
    pendingCommands: {attempted: true, succeeded: true, fetchedCount: 0, queuedCount: 0,
      appliesAfterResponse: false, applyPhase: 'NO_PENDING_COMMANDS', statusCode: 200, error: null},
    lastError: null,
  });
  const after = await accountLinkAPI.getSyncState();
  assert.equal(after.pendingOutboxCount, 0);
  assert.equal(after.lastOutboxDeliverySuccessAt, result.forcedAt);
  sim.advanceTo(sim.now + 1_000);
  const repeated = await accountLinkAPI.forceSync();
  assert.equal(repeated.outbox.beforeCount, 0);
  assert.equal(repeated.outbox.deliveredCount, 0);
  assert.equal((await accountLinkAPI.getSyncState()).lastOutboxDeliverySuccessAt, repeated.forcedAt);
  assert.ok(Date.parse(repeated.forcedAt) > Date.parse(result.forcedAt));
});

test('AU08-AU09 canonical farm changes create one pending sync item; no-op and rejected writes create none', async () => {
  const sim = new Simulator({mode: 'public'});
  install(sim);
  await accountLinkAPI.link({serverUrl: 'https://cloud.example.test', action: 'login', username: 'fictional', password: 'discard-me'});
  await accountLinkAPI.forceSync();
  const originalName = (await irrigationZonesAPI.getAll()).find(zone => zone.id === 1)!.name;

  const changed = await irrigationZonesAPI.rename(1, 'Changed after drain');
  assert.equal(changed.changed, true);
  assert.equal((await irrigationZonesAPI.getAll()).find(zone => zone.id === 1)?.name, 'Changed after drain');
  assert.equal((await accountLinkAPI.getSyncState()).pendingOutboxCount, 1);

  const noOp = await irrigationZonesAPI.rename(1, 'Changed after drain');
  assert.equal(noOp.changed, false);
  await assert.rejects(irrigationZonesAPI.rename(1, '   '));
  assert.equal((await accountLinkAPI.getSyncState()).pendingOutboxCount, 1);

  const drained = await accountLinkAPI.forceSync();
  assert.equal(drained.outbox.selected, 1);
  assert.equal(drained.outbox.deliveredCount, 1);
  assert.equal((await accountLinkAPI.getSyncState()).pendingOutboxCount, 0);
  const repeated = await accountLinkAPI.forceSync();
  assert.equal(repeated.outbox.deliveredCount, 0);
  assert.equal((await irrigationZonesAPI.getAll()).find(zone => zone.id === 1)?.name, 'Changed after drain');
  assert.notEqual(originalName, 'Changed after drain');
});

test('AU08 delayed device configuration queues work only for changed ACKs, not no-op or superseded requests', async () => {
  const sim = new Simulator({mode: 'public'});
  install(sim);
  await accountLinkAPI.link({serverUrl: 'https://cloud.example.test', action: 'login', username: 'fictional', password: 'discard-me'});
  await accountLinkAPI.forceSync();
  const lsn = (await devicesAPI.getAll()).find(device => device.type_id === 'DRAGINO_LSN50')!;
  assert.equal(lsn.temp_enabled, 0);

  await lsn50API.setTempEnabled(lsn.deveui, true);
  assert.equal((await accountLinkAPI.getSyncState()).pendingOutboxCount, 0);
  sim.advanceTo(sim.now + 2_000);
  assert.equal((await devicesAPI.getAll()).find(device => device.deveui === lsn.deveui)?.temp_enabled, 1);
  assert.equal((await accountLinkAPI.getSyncState()).pendingOutboxCount, 1);
  const delivered = await accountLinkAPI.forceSync();
  assert.equal(delivered.outbox.deliveredCount, 1);
  assert.equal((await accountLinkAPI.forceSync()).outbox.deliveredCount, 0);

  await lsn50API.setUplinkInterval(lsn.deveui, 30);
  assert.equal((await accountLinkAPI.getSyncState()).pendingOutboxCount, 0, 'the request-side requested interval is not a second sync change');
  sim.advanceTo(sim.now + 2_000);
  assert.equal((await devicesAPI.getAll()).find(device => device.deveui === lsn.deveui)?.uplink_interval_minutes, 30);
  assert.equal((await accountLinkAPI.getSyncState()).pendingOutboxCount, 1);
  assert.equal((await accountLinkAPI.forceSync()).outbox.deliveredCount, 1);

  await lsn50API.setTempEnabled(lsn.deveui, true);
  sim.advanceTo(sim.now + 2_000);
  assert.equal((await accountLinkAPI.getSyncState()).pendingOutboxCount, 0);
  await lsn50API.setTempEnabled(lsn.deveui, false);
  await lsn50API.setTempEnabled(lsn.deveui, true);
  sim.advanceTo(sim.now + 2_000);
  assert.equal((await devicesAPI.getAll()).find(device => device.deveui === lsn.deveui)?.temp_enabled, 1);
  assert.equal((await accountLinkAPI.getSyncState()).pendingOutboxCount, 0);

  const valveEui = sim.devices.find(device => device.type_id === 'STREGA_VALVE')!.deveui;
  await stregaAPI.setMagnetEnabled(valveEui, true);
  assert.equal((await accountLinkAPI.getSyncState()).pendingOutboxCount, 0);
  sim.advanceTo(sim.now + 2_000);
  assert.equal((await devicesAPI.getAll()).find(device => device.deveui === valveEui)?.strega_magnet_enabled, true);
  assert.equal((await accountLinkAPI.getSyncState()).pendingOutboxCount, 1);
  assert.equal((await accountLinkAPI.forceSync()).outbox.deliveredCount, 1);
  await stregaAPI.setMagnetEnabled(valveEui, true);
  sim.advanceTo(sim.now + 2_000);
  assert.equal((await accountLinkAPI.getSyncState()).pendingOutboxCount, 0);

  const deletedConfigDevice = (await devicesAPI.getAll()).find(device => device.type_id === 'DRAGINO_LSN50')!;
  await lsn50API.setTempEnabled(deletedConfigDevice.deveui, false);
  await devicesAPI.remove(deletedConfigDevice.deveui);
  assert.equal((await accountLinkAPI.getSyncState()).pendingOutboxCount, 1, 'the device removal itself is one real change');
  sim.advanceTo(sim.now + 2_000);
  assert.equal((await accountLinkAPI.getSyncState()).pendingOutboxCount, 1, 'a deleted device ACK is ignored');
});

test('AU10 keeps all admin user and grant operations denied to the public researcher', async () => {
  const sim = new Simulator({mode: 'public'});
  install(sim);
  const profile = await fetchScopeProfile();
  assert.equal(profile.role, 'researcher');
  const operations: Array<Promise<unknown>> = [
    api.get('/api/users'), api.post('/api/users', {username: 'admin', password: 'secret', role: 'admin'}),
    api.post('/api/users/fake-user/password-reset', {}), api.put('/api/users/fake-user/role', {role: 'admin'}),
    api.put('/api/users/fake-user/disabled', {disabled: true}), api.post('/api/grants/zone', {}),
    api.post('/api/grants/plot', {}), api.delete('/api/grants/zone/fake-grant'),
  ];
  for (const operation of operations) await assert.rejects(operation, (error: unknown) => {
    assert.ok(isAxiosError(error));
    assert.equal(error.response?.status, 403);
    assert.deepEqual(error.response?.data, {error: 'forbidden', message: 'Administrator access is required'});
    return true;
  });
  await assert.rejects(api.get('/api/users/fake-user/unknown-operation'), (error: unknown) => {
    assert.ok(isAxiosError(error));
    assert.equal(error.response?.status, 501);
    assert.equal(error.response?.data?.error, 'unsupported');
    return true;
  });
});
