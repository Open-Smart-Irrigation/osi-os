'use strict';
// ST1 — settings persistence and validation.
//
// Two surfaces:
//   GET/PUT /api/system/settings  -> app_settings (gateway_timezone today)
//   PUT /api/irrigation-zones/:id/{timezone,config}  -> per-zone settings
//   GET /api/system/features      -> the shipped feature-flag set
//
// The case restores every value it changes, so a run leaves the gateway's
// settings exactly as it found them.

exports.title = 'Settings: read, write, validate, persist, restore';

const state = { zones: [], restore: null };

exports.run = async (ctx) => {
  const { rest, ssh, ev } = ctx;
  const tag = 'st1-' + Date.now().toString(36);

  // --- system settings ------------------------------------------------------
  const before = await rest.get('/api/system/settings');
  ctx.expectStatus('GET /api/system/settings returns the current settings', before, 200);
  state.restore = before.body && typeof before.body === 'object' ? before.body : null;
  ctx.expect('the settings response is an object', !!state.restore, before.body);

  const unauth = await rest.get('/api/system/settings', { token: null });
  ctx.expectStatus('GET /api/system/settings without a token returns 401', unauth, 401);
  const unauthPut = await rest.put('/api/system/settings', { gatewayTimezone: 'UTC' }, { token: null });
  ctx.expectStatus('PUT /api/system/settings without a token returns 401', unauthPut, 401);

  // The settings API speaks camelCase (gatewayTimezone), while the SQLite key is
  // snake_case (gateway_timezone). Both spellings matter and neither is derivable
  // from the other.
  const originalTz = state.restore && state.restore.gatewayTimezone;
  const newTz = originalTz === 'Europe/Zurich' ? 'Europe/Paris' : 'Europe/Zurich';

  const put = await rest.put('/api/system/settings', { gatewayTimezone: newTz });
  ctx.expectStatus('PUT /api/system/settings accepts a valid IANA timezone', put, 200);

  const after = await rest.get('/api/system/settings');
  ctx.expect('the new timezone is returned by a subsequent read',
    after.body && after.body.gatewayTimezone === newTz, after.body);

  const dbRow = await ssh.sqlOne("SELECT value FROM app_settings WHERE key = 'gateway_timezone'");
  ctx.expect('SQLite: the setting is persisted in app_settings, not held in memory',
    !!dbRow && dbRow.value === newTz, dbRow);

  // --- validation -----------------------------------------------------------
  const badTz = await rest.put('/api/system/settings', { gatewayTimezone: 'Mars/Olympus_Mons' });
  ctx.expect('an invalid timezone is rejected, not stored',
    badTz.status >= 400 && badTz.status < 500, { status: badTz.status, body: badTz.body });
  const stillNew = await ssh.sqlOne("SELECT value FROM app_settings WHERE key = 'gateway_timezone'");
  ctx.expect('SQLite: a rejected write leaves the previous value intact',
    !!stillNew && stillNew.value === newTz, stillNew);

  const emptyTz = await rest.put('/api/system/settings', { gatewayTimezone: '' });
  ctx.expect('an empty timezone is rejected', emptyTz.status >= 400 && emptyTz.status < 500,
    { status: emptyTz.status, body: emptyTz.body });

  const junk = await rest.put('/api/system/settings', { not_a_setting: 'x' });
  ctx.expect('an unknown settings key does not 500', junk.status !== 500, { status: junk.status, body: junk.body });
  const unknownKey = await ssh.sqlScalar("SELECT COUNT(*) AS n FROM app_settings WHERE key = 'not_a_setting'");
  ctx.expect('SQLite: an unknown settings key is not silently persisted', Number(unknownKey) === 0, { rows: unknownKey });

  // --- persistence across a read-back of a new zone ------------------------
  // A zone created with no explicit timezone must inherit the gateway default,
  // which is the only thing that makes the gateway_timezone setting meaningful.
  const zoneDefault = await rest.post('/api/irrigation-zones', { name: 'TZ Default ' + tag });
  ctx.expectStatus('a zone can be created without an explicit timezone', zoneDefault, 201);
  if (zoneDefault.body && zoneDefault.body.id) state.zones.push(zoneDefault.body.id);
  const zoneTz = await ssh.sqlScalar(
    "SELECT timezone FROM irrigation_zones WHERE zone_uuid = '" + (zoneDefault.body && zoneDefault.body.zone_uuid) + "'"
  );
  ctx.expect('SQLite: a zone with no explicit timezone inherits the gateway default',
    zoneTz === newTz, { zoneTimezone: zoneTz, gatewayDefault: newTz });

  // --- per-zone timezone ----------------------------------------------------
  const zoneTzPut = await rest.put('/api/irrigation-zones/' + zoneDefault.body.id + '/timezone', { timezone: 'Africa/Kampala' });
  ctx.expect('a zone timezone can be overridden', zoneTzPut.status < 300, { status: zoneTzPut.status, body: zoneTzPut.body });
  const zoneTzAfter = await ssh.sqlScalar(
    "SELECT timezone FROM irrigation_zones WHERE id = " + zoneDefault.body.id
  );
  ctx.expect('SQLite: the per-zone timezone override is persisted',
    zoneTzAfter === 'Africa/Kampala', { timezone: zoneTzAfter });

  // PUT /api/system/settings validates the IANA name with Intl.DateTimeFormat
  // (osi-system-settings/api.js:130). The per-zone route does not, so the two
  // timezone surfaces disagree about what a valid timezone is.
  const zoneTzBad = await rest.put('/api/irrigation-zones/' + zoneDefault.body.id + '/timezone', { timezone: 'Not/AZone' });
  ctx.expect('an invalid zone timezone is rejected the way the gateway-level route rejects one',
    zoneTzBad.status >= 400 && zoneTzBad.status < 500, { status: zoneTzBad.status, body: zoneTzBad.body });
  const zoneTzUnchanged = await ssh.sqlScalar("SELECT timezone FROM irrigation_zones WHERE id = " + zoneDefault.body.id);
  ctx.expect('SQLite: a rejected zone timezone leaves the previous value intact',
    zoneTzUnchanged === 'Africa/Kampala', { timezone: zoneTzUnchanged });
  if (zoneTzUnchanged !== 'Africa/Kampala') {
    ev.note('DEFECT: PUT /api/irrigation-zones/:id/timezone stores any string as the zone timezone ' +
      '("Not/AZone" persisted). PUT /api/system/settings validates the same kind of value with ' +
      'Intl.DateTimeFormat and answers 422. Everything downstream that does wall-clock maths for that zone ' +
      '(the valve plan compiler, the daily rollups, schedule next_run) then works from an unresolvable zone.');
    // Put a real timezone back so the rest of the run and any follow-up is sane.
    await rest.put('/api/irrigation-zones/' + zoneDefault.body.id + '/timezone', { timezone: 'Africa/Kampala' });
  }

  ctx.expect('the gateway default is not changed by a per-zone override',
    (await ssh.sqlOne("SELECT value FROM app_settings WHERE key = 'gateway_timezone'")).value === newTz, { gatewayDefault: newTz });

  // --- feature flags --------------------------------------------------------
  const features = await rest.get('/api/system/features', { token: null });
  ctx.expectStatus('GET /api/system/features is readable without a token (it drives the login screen)', features, 200);
  const flags = features.body && features.body.features;
  ctx.expect('the feature-flag set is returned as an object', !!flags && typeof flags === 'object', flags);
  const expectedFlags = [
    'historyUxEnabled', 'historyComparisonEnabled', 'historyWorkspacesEnabled',
    'historyAdvancedOverlaysEnabled', 'historyCloudAiEnabled', 'fieldJournalUxEnabled', 'scoped_access',
  ];
  const missing = expectedFlags.filter((f) => !(f in (flags || {})));
  ctx.expect('every flag the GUI reads is present in the response', missing.length === 0, { missing, actual: Object.keys(flags || {}) });
  ctx.expect('scoped_access reflects the live OSI_SCOPED_ACCESS env, not a literal',
    !!flags && flags.scoped_access === (ctx.env.OSI_SCOPED_ACCESS === '1'),
    { flag: flags && flags.scoped_access, env: ctx.env.OSI_SCOPED_ACCESS });

  // --- system stats ---------------------------------------------------------
  const stats = await rest.get('/api/system/stats');
  ctx.expectStatus('GET /api/system/stats returns live gateway stats', stats, 200);
  // flows.json node system-stats-admin-read-guard ("Admin Read Guard: System
  // Stats") opens with
  //   if (String(env.get('OSI_SCOPED_ACCESS') || '') !== '1') return [msg, null];
  // so with scoped access off -- the default, and what every current gateway
  // runs -- the guard is a pass-through and the route needs no token at all.
  const statsUnauth = await rest.get('/api/system/stats', { token: null });
  ctx.expectStatus('GET /api/system/stats is auth-gated', statsUnauth, 401);
  if (statsUnauth.status === 200) {
    ev.note('DEFECT: GET /api/system/stats needs no token when OSI_SCOPED_ACCESS is off (the default). ' +
      'It returns CPU temperature, memory, load average, CPU count, fan mode/speed and restartPending to ' +
      'anyone who can reach port 1880. The "Admin Read Guard" node only engages in scoped mode.');
  }

  // --- restore --------------------------------------------------------------
  if (originalTz) {
    const restore = await rest.put('/api/system/settings', { gatewayTimezone: originalTz });
    ctx.expect('the original gateway timezone can be restored', restore.status === 200, { status: restore.status });
    const restored = await ssh.sqlOne("SELECT value FROM app_settings WHERE key = 'gateway_timezone'");
    ctx.expect('SQLite: the gateway timezone is back to what the run found',
      !!restored && restored.value === originalTz, { restored: restored && restored.value, expected: originalTz });
  } else {
    ev.note('The gateway had no gateway_timezone setting before this run; nothing to restore.');
  }
};

exports.cleanup = async (ctx) => {
  const original = state.restore && state.restore.gatewayTimezone;
  if (original) {
    try {
      const res = await ctx.rest.put('/api/system/settings', { gatewayTimezone: original });
      ctx.ev.cleanupStep('restore gateway_timezone to ' + original, res.status === 200, { status: res.status });
    } catch (e) { ctx.ev.cleanupStep('restore gateway_timezone', false, e.message); }
  }
  for (const id of state.zones.slice()) await ctx.deleteZone(id);
  state.zones.length = 0;
  state.restore = null;
};
