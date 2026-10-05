#!/usr/bin/env node
'use strict';

// Scoped-access ratchet (spec §5.4).
//
// Contract. For every HTTP entry of the maintained profiles, with scoped
// access on:
//   1. a scope decision is made on the entry's own path before any data is
//      read or written, and every decision on the path is honoured: when any
//      one of them says no, the request stops (nothing further is read,
//      written or executed, nothing written earlier on the path came before
//      that decision, and the caller gets an error answer carrying none of the
//      probe's data);
//   2. a write entry makes, before its first write, a write-role decision
//      (canMutate or an admin decision; an admin decision on admin-only
//      routes) and, when its URL addresses a device, zone or plot, a decision
//      on that very object (or an admin decision);
//   3. a write entry reaches its write when every decision says yes, unless it
//      is listed in UNREACHED_WRITES with the reason;
//   4. outcome: run by a researcher who owns zone 1 and everything in it, with
//      the real scope helper deciding, a write entry changes no row of an
//      object outside that scope (zone 2 and its device, valve, plot, schedule,
//      plot group and journal entry, the shared weather station's zone-2
//      assignment, the admin's account and rows) and sends no command naming
//      one by its uuid or EUI. The runs name foreign objects by URL parameter,
//      by every body or query field the fixture leaves unset, and by the body
//      fields of the fixture's foreignBodies (run after its foreignBodySetupSql,
//      when it has one); bulk writes and set replacements are judged by the
//      same comparison.
// A scope decision is a call to a deciding function of osi-scope-helper
// (assertFresh*Access, assertRole, assertFreshRole, assertEnabledAccount,
// assertAuthenticatedRole, authorizeAdminRead, isAdmin, canMutate,
// resolveScope), loaded through osiLib.require('scope') and made by the
// entry's guard or by a seam module the guard hands the helper to. A mention
// of the helper elsewhere in the chain does not count.
//
// How it is checked. scripts/lib/scope-guard-probe.js sends requests down each
// entry against a seeded probe database and controls each decision. Per entry:
// every decision denied; the same with a "truthy" request (every unset query,
// body or header field reads as set, `in` included); every decision allowed
// (rules 2 and 3), plain and truthy; each decision denied on its own with every
// other one allowed; and, for write entries, the outcome runs of rule 4 (the
// fixture request; each URL parameter pointed at a foreign object; every unset
// body or query field naming a foreign object, one run per kind of id; and the
// fixture's foreign bodies), comparing the whole database before and after.
//
// Every entry the probe cannot run to a verdict fails, naming the entry, and so
// does a node type the verifier does not know. An entry is exempt only through
// one of the lists below, each entry with its reason; an exempt entry that the
// probe finds compliant fails as stale. An entry in KNOWN_GAPS is exempt
// wholesale; KNOWN_OUTCOME_GAPS tolerates one named change only.
//
// Limits. This is a ratchet; the behavioural suites (scripts/test-scoped-access-
// *.js and the per-route tests) remain the correctness gate. It does not see:
//   - a body id the fixture sets and no foreignBodies entry replaces with a
//     foreign id (foreignBodies exist for the device claim, both plot routes,
//     both plot-group routes and the weather station zone set);
//   - rows of accounts other than the seeded admin (another researcher's
//     views, workspaces, grants): only the admin's rows are foreign;
//   - rows the caller owns inside a foreign zone: the seed has none;
//   - foreign rows of kinds the seed lacks, when a write updates or deletes
//     them: valve schedules, plans and actuation expectations; device
//     calibrations (watermark, chameleon); zone configuration, calibration,
//     seasons and recommendations; other users' grants and custom terms;
//     history workspaces and preferences; analysis views; devices of types
//     other than the three seeded (LSN50, STREGA valve, S2120 weather station).
//     An inserted row that carries a foreign id is still seen;
//   - foreign links the markers do not read: numeric foreign keys other than
//     zone and user ids (a schedule id, an integer entry id), a zone id stored
//     as text, free-text columns, and a command that names a zone by number;
//   - a skip keyed on stored state the seed lacks (another device type, a
//     status, an owner); skips keyed on the three seeded types are caught;
//   - a skip keyed on an exact request value (`body.mode === 'admin'`); a skip
//     keyed on a header is caught only when the header is read as a plain
//     property;
//   - host files written through a seam module's own require('fs'): neither
//     stubbed nor seen;
//   - rule 4 on exempt entries: the 10 INLINE_ACCOUNT_CHECKS history routes
//     (workspace and preference writes included), KNOWN_GAPS, Phase C and
//     public entries are not outcome-checked;
//   - routes in UNREACHED_WRITES: their write is never reached, so rules 1 and
//     4 see only what happens before it, and a listed route that becomes
//     reachable does not fail as stale.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const {
  FOREIGN_DEVEUI,
  FOREIGN_ENTRY_UUID,
  FOREIGN_GROUP_UUID,
  FOREIGN_PLOT_UUID,
  FOREIGN_VALVE_DEVEUI,
  FOREIGN_ZONE_ID,
  FOREIGN_ZONE_UUID,
  PROBE_ADMIN_UUID,
  PROBE_CALLER_UUID,
  PROBE_DISABLED_UUID,
  PROBE_DEVEUI,
  PROBE_GATEWAY_EUI,
  PROBE_PLOT_UUID,
  PROBE_ZONE_UUID,
  WEATHER_DEVEUI,
  foreignEffect,
  foreignMarkers,
  probeEntry,
} = require('./lib/scope-guard-probe');

const ROOT = path.resolve(__dirname, '..');
const PROFILES = [
  'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json',
  'conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json',
];
const DEFAULT_MODULES_ROOT = path.join(
  ROOT,
  'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red'
);

// Endpoints with no scoped data or Phase-A/public semantics (exact http-in ids).
const PUBLIC_ALLOWLIST = new Set([
  'auth-register-http',
  'auth-login-http',
  // Reports the caller's own role and scope; it reads the scope instead of
  // deciding on it, and answers 200 to every authenticated caller by design.
  'api-me-http',
  'history-system-features-http',
]);

// Phase B lands before write enforcement by design. These exact pre-existing
// mutation/effect routes are tracked debt, not general exemptions. Phase C
// removes each id as its scope guard lands; any newly-added route still fails,
// and an id whose guard has landed fails as stale until it is removed here.
// (sys-reboot-in and sys-fan-in left this list once each made its own admin
// decision before the effect.)
const PHASE_C_PENDING = new Set([
  'al-link-in',
  'al-unlink-in',
  'sync-force-http',
  'history-rollups-run-http',
  // Wave 3 scoped-access port: these routes don't exist anywhere in AgroLink's
  // scope arc (valve-control and SDI-12 landed on main after AgroLink's fork;
  // AgroLink itself never scoped them). Tracked debt, same discipline as the
  // rest of this list -- not a blanket exemption for the two features.
  // sdi12-config-http and sdi12-identify-http are guard reconciliation done:
  // both now route through scoped-device-config-guard (routeTable extended
  // with POST /sdi12/identify -> sdi12-identify-action-fn and PUT /sdi12/config
  // -> sdi12-config-auth-fn), matching AgroLink's own guard scope exactly.
  // sdi12-recipe-apply-http/sdi12-recipe-rollback-http stay pending: AgroLink's
  // own guard-extension commit (853c1b3584) never added routeTable entries for
  // the recipe apply/rollback routes either -- this is upstream's own scope,
  // not a gap introduced by this port.
  'sdi12-recipe-apply-http',
  'sdi12-recipe-rollback-http',
  'valve-list-get-http',
  'valve-schedules-get-http',
  'valve-schedules-post-http',
  'valve-schedule-put-http',
  'valve-schedule-delete-http',
  'valve-plan-resend-post-http',
  'valve-scheduler-status-post-http',
  'valve-settings-put-http',
  'sys-settings-get-in',
  'sys-settings-put-in',
]);

// Known gaps: real gaps found by this verifier, each tracked by its issue. An
// entry leaves the list when its fix lands (the stale check enforces it).
const KNOWN_GAPS = new Map([
]);

// Known gaps the outcome rule sees: the entry is checked like any other, and
// only the listed change to rows outside the caller's scope is tolerated until
// the issue's fix lands (then the entry is stale and fails until removed).
const KNOWN_OUTCOME_GAPS = new Map([
]);

// Entries whose decision is real but made without the helper, so the probe
// cannot see it. Each must refuse a disabled account: the verifier probes them
// with a disabled account's token and fails if the request reads or writes
// anything or gets a non-error answer. Moving the check onto the helper retires
// the entry (the stale check enforces it).
const INLINE_ACCOUNT_CHECKS = new Map([
  ...[
    'history-zone-cards-http',
    'history-zone-card-data-http',
    'history-zone-card-advanced-http',
    'history-zone-card-preferences-http',
    'history-zone-card-opened-http',
    'history-zone-export-csv-http',
    'history-workspaces-get-http',
    'history-workspaces-post-http',
    'history-workspaces-put-http',
    'history-workspaces-delete-http',
  ].map((id) => [
    id,
    'history-api-router-fn reads users.disabled_at itself (scopeCheckForRoute) and ' +
      'refuses a disabled account before any history read; zone history is ' +
      'account-wide by design (W1) and workspaces are filtered by owner',
  ]),
]);

// Entries that answer every caller with an error and read nothing, so there is
// nothing to decide on. The probe holds them to that: any read or write, or a
// success answer, fails. Implementing the route retires the entry.
const NO_DATA_ENTRIES = new Map([
  [
    'journal-export-adapt-get-http',
    'GET /api/journal/export.adapt.json answers 501 not_implemented after resolving ' +
      'the caller; it reads no journal data',
  ],
]);

// Entries that decide per row and leave denied rows out: when every row is
// denied the right answer is a success with an empty list, not an error. For
// these entries alone the probe accepts a success answer after a denial; it
// still fails on any read or write before the decision or after it.
const FILTERING_ENTRIES = new Map([
  [
    'network-api-http-0',
    'GET /api/network/observations calls assertFreshDeviceAccess for each device and ' +
      'returns observations only for the devices it allows; all denied gives an empty list',
  ],
]);

const ALLOWLIST = new Set([...PUBLIC_ALLOWLIST, ...PHASE_C_PENDING, ...KNOWN_GAPS.keys()]);

const probeDeviceType = (type) => "UPDATE devices SET type_id = '" + type + "' WHERE deveui = '" + PROBE_DEVEUI + "';";
const PROBE_GRANT_UUID = '00000000-0000-4000-8000-00000000c001';
const PROBE_ZONE2_UUID = '00000000-0000-4000-8000-00000000c003';
// A plot group of the caller's, holding the caller's plot.
const PROBE_GROUP_UUID = '00000000-0000-4000-8000-00000000c002';
const PROBE_GROUP_SQL =
  'INSERT INTO journal_plot_groups (group_uuid, label, gateway_device_eui, created_by_principal_uuid, ' +
  "owner_user_uuid) VALUES ('" + PROBE_GROUP_UUID + "', 'Probe group', '" + PROBE_GATEWAY_EUI + "', '" +
  PROBE_CALLER_UUID + "', '" + PROBE_CALLER_UUID + "');" +
  "INSERT INTO journal_plot_group_members (group_uuid, plot_uuid) VALUES ('" + PROBE_GROUP_UUID + "', '" +
  PROBE_PLOT_UUID + "');";

// The probe device (the caller's) as a valve, for the valve routes.
const PROBE_VALVE_SQL = "UPDATE devices SET type_id = 'STREGA_VALVE' WHERE deveui = '" + PROBE_DEVEUI + "';";
const PROBE_MOTORIZED_VALVE_SQL = PROBE_VALVE_SQL +
  "UPDATE devices SET strega_model = 'MOTORIZED' WHERE deveui = '" + PROBE_DEVEUI + "';";
// A running actuation on the probe valve, for the cancel routes.
const PROBE_ACTUATION_SQL =
  'INSERT INTO valve_actuation_expectations (expectation_id, device_eui, commanded_at, ' +
  'commanded_duration_seconds, expected_close_at, volume_source, reconciliation_state, created_at) ' +
  "VALUES ('probe-expectation', '" + PROBE_DEVEUI + "', '2026-01-01T00:00:00Z', 600, " +
  "'2099-01-01T00:00:00Z', 'none', 'PENDING_OBSERVATION', '2026-01-01T00:00:00Z');";

// Request inputs an entry needs to get past its own validation and reach its
// decision. Without them the guard answers 400 before deciding, which proves
// nothing; the probe then reports the entry as having no scope call.
const REQUEST_FIXTURES = {
  'sensor-history-http': { query: { field: 'swt_1', hours: '24' } },
  // Radio capture on, with the observation store served from the probe
  // database, so the read the per-device filter guards is on the probed path.
  'network-api-http-0': {
    env: { OSI_RADIO_CAPTURE_ENABLED: '1' },
    radioStore: true,
    setupSql: 'CREATE TABLE radio_uplinks (id INTEGER PRIMARY KEY, deveui TEXT, ' +
      'installation_uuid TEXT, recorded_at TEXT);',
  },
  'journal-plot-put-http': {
    params: { uuid: PROBE_PLOT_UUID },
    body: {
      plot_code: 'PROBE1', name: 'Probe plot renamed', zone_uuid: PROBE_ZONE_UUID,
      layout_code: 'open_field', base_sync_version: 0,
    },
    foreignBodies: [{
      plot_code: 'PROBE1', name: 'Probe plot renamed', zone_uuid: FOREIGN_ZONE_UUID,
      layout_code: 'open_field', base_sync_version: 0,
    }],
  },
  // The fixture request and the field runs keep the seeded zone-2 assignment,
  // which no run may remove (#404); the foreign body runs without it, so that
  // adding the station to the foreign zone is a visible change.
  's2120-zones-put-http': {
    params: { deveui: WEATHER_DEVEUI },
    body: { zone_ids: [1] },
    foreignBodies: [{ zone_ids: [1, FOREIGN_ZONE_ID] }],
    foreignBodySetupSql: 'DELETE FROM weather_station_zones WHERE zone_id = ' + FOREIGN_ZONE_ID + ';',
  },
  // Write routes: inputs that take each distinct guard through to its write
  // when every decision says yes, so a decision that is ignored, or placed
  // after the write, shows up as a write.
  'zone-rename-http': { body: { name: 'Probe renamed' } },
  'device-rename-http': { body: { name: 'Probe renamed' } },
  'dendro-tz-http': { body: { timezone: 'Europe/Zurich' } },
  'e970d93ded4679af': {
    body: { trigger_metric: 'SWT_1', threshold_kpa: 30, duration_minutes: 10, enabled: true },
  },
  '6ba1d1d0ac7fd7db': {
    body: { action: 'OPEN_FOR_DURATION', duration_minutes: 10 },
    setupSql: PROBE_VALVE_SQL,
  },
  'cancel-valve-http-in': { setupSql: PROBE_VALVE_SQL + PROBE_ACTUATION_SQL },
  'cancel-valve-local-http-in': { setupSql: PROBE_VALVE_SQL + PROBE_ACTUATION_SQL },
  'post-zone-http': { body: { name: 'Probe new zone' } },
  'sys-fan-in': { body: { speed: 128 } },
  'post-devices-http': {
    body: {
      deveui: '00000000000000F1', name: 'Probe new device', type_id: 'DRAGINO_LSN50', zone_id: 1,
      appkey: '00112233445566778899AABBCCDDEEFF',
    },
    foreignBodies: [{
      deveui: '00000000000000F2', name: 'Probe new device', type_id: 'DRAGINO_LSN50', zone_id: FOREIGN_ZONE_ID,
      appkey: '00112233445566778899AABBCCDDEEFF',
    }],
  },
  'dendro-location-http': { body: { latitude: 46.5, longitude: 7.5 } },
  'zone-config-http': { body: { cropType: 'probe-crop' } },
  'put-lsn50-mode-http': { body: { mode: 'MOD1' } },
  'put-lsn50-interval-http': { body: { minutes: 10 } },
  'put-kiwi-interval-http': { body: { minutes: 10 }, setupSql: probeDeviceType('KIWI_SENSOR') },
  'post-kiwi-enable-http': { body: { minutes: 10 }, setupSql: probeDeviceType('KIWI_SENSOR') },
  'put-strega-interval-http': { body: { minutes: 10 }, setupSql: PROBE_VALVE_SQL },
  'put-lsn50-interrupt-http': { body: { mode: 1 } },
  'put-lsn50-5v-http': { body: { milliseconds: 100 } },
  'put-strega-model-http': { body: { model: 'STANDARD' }, setupSql: PROBE_VALVE_SQL },
  'put-strega-timed-http': { body: { action: 'OPEN', unit: 'minutes', amount: 5 }, setupSql: PROBE_VALVE_SQL },
  'put-strega-magnet-http': { body: { enabled: true }, setupSql: PROBE_VALVE_SQL },
  'put-strega-partial-http': { body: { action: 'OPEN', percentage: 50 }, setupSql: PROBE_MOTORIZED_VALVE_SQL },
  'put-strega-flush-http': { body: { returnPosition: 'OPEN', percentage: 50 }, setupSql: PROBE_MOTORIZED_VALVE_SQL },
  'watermark-cal-delete-http': {
    query: { expected_sync_version: '1' },
    setupSql: 'INSERT INTO watermark_calibrations (deveui, pullup_1_ohm, pulldown_1_ohm, series_fwd_1_ohm, ' +
      'series_rev_1_ohm, pullup_2_ohm, pulldown_2_ohm, series_fwd_2_ohm, series_rev_2_ohm) ' +
      "VALUES ('" + PROBE_DEVEUI + "', 41670, 41260, 130, 112, 42530, 42070, 46, 27);",
  },
  'sdi12-config-http': { body: { probe_profile: 'GENERIC_VWC' }, setupSql: probeDeviceType('DRAGINO_SDI12') },
  'network-api-http-2': {
    body: {
      revisionUuid: '00000000-0000-4000-8000-00000000d001',
      values: { latitude: 46.5, longitude: 7.5, effectiveFrom: '2026-01-01T00:00:00Z' },
    },
  },
  'network-api-http-5': {
    body: {
      revisionUuid: '00000000-0000-4000-8000-00000000d002',
      values: { txPowerDbm: 14, effectiveFrom: '2026-01-01T00:00:00Z' },
    },
  },
  // A dry run: it reads the outbox after the admin decision (execute needs a
  // cloud replay receipt the probe cannot mint, see UNREACHED_WRITES).
  'sync-outbox-recover-http': {
    body: {
      eventUuids: ['00000000-0000-4000-8000-00000000d003'],
      receipts: [{ request: { eventUuid: '00000000-0000-4000-8000-00000000d003' } }],
    },
  },
  '7aa47f3149614bb1': {
    setupSql: "INSERT INTO chameleon_readings (deveui, recorded_at, array_id) VALUES ('" + PROBE_DEVEUI +
      "', '2026-01-01T00:00:00Z', 'probe-array');",
  },
  'journal-plot-group-put-http': {
    params: { uuid: PROBE_GROUP_UUID },
    body: { label: 'Probe group', resolved: false, base_sync_version: 0, members: [PROBE_PLOT_UUID] },
    foreignBodies: [{ label: 'Probe group', resolved: false, base_sync_version: 0, members: [FOREIGN_PLOT_UUID] }],
    setupSql: PROBE_GROUP_SQL,
  },
  'journal-plot-groups-post-http': {
    body: {
      group_uuid: '00000000-0000-4000-8000-00000000d004', label: 'Probe new group', resolved: false,
      base_sync_version: 0, members: [PROBE_PLOT_UUID],
    },
    foreignBodies: [{
      group_uuid: '00000000-0000-4000-8000-00000000d004', label: 'Probe new group', resolved: false,
      base_sync_version: 0, members: [FOREIGN_PLOT_UUID],
    }],
  },
  'journal-plots-post-http': {
    // A second zone of the caller's, without a plot yet; and the foreign zone's
    // plot retired, so a plot created there would be a new foreign row (the
    // route answers with an existing zone plot instead of creating one).
    setupSql: "INSERT INTO irrigation_zones (id, name, user_id, zone_uuid, timezone, scheduling_mode) VALUES " +
      "(3, 'Probe zone two', 2, '" + PROBE_ZONE2_UUID + "', 'UTC', 'local');" +
      "UPDATE journal_plots SET deleted_at = '2026-01-02T00:00:00Z', active = 0 WHERE plot_uuid = '" +
      FOREIGN_PLOT_UUID + "';",
    body: {
      plot_uuid: '00000000-0000-4000-8000-00000000d005', plot_code: 'PROBE2', name: 'Probe new plot',
      zone_uuid: PROBE_ZONE2_UUID, layout_code: 'open_field', base_sync_version: 0,
    },
    foreignBodies: [{
      plot_uuid: '00000000-0000-4000-8000-00000000d006', plot_code: 'PROBE3', name: 'Probe new plot',
      zone_uuid: FOREIGN_ZONE_UUID, layout_code: 'open_field', base_sync_version: 0,
    }],
  },
  'analysis-views-post-http': { body: { view: { name: 'Probe view' } } },
  'sdi12-identify-http': { setupSql: probeDeviceType('DRAGINO_SDI12') },
  'network-api-http-7': { actor: 'admin', body: { latitude: 46.5, longitude: 7.5 } },
  'put-chameleon-enabled-http': { body: { enabled: true } },
  'put-dendro-config-http': { body: { dendro_stroke_mm: 25 } },
  'b0b3d5c0ff56cd29': { body: { chameleonSwt1DepthCm: 20 } },
  'watermark-cal-put-http': {
    body: {
      pullup_1_ohm: 41670, pulldown_1_ohm: 41260, series_fwd_1_ohm: 130, series_rev_1_ohm: 112,
      pullup_2_ohm: 42530, pulldown_2_ohm: 42070, series_fwd_2_ohm: 46, series_rev_2_ohm: 27,
      expected_sync_version: 0,
    },
  },
  'zone-calibration-http': { body: { measured_flow_rate_lpm: 10, measurement_method: 'manual' } },
  'admin-users-create-http': { body: { username: 'probe-new-user', password: 'probe-pass-1', role: 'viewer' } },
  'admin-users-password-http': { params: { uuid: PROBE_DISABLED_UUID }, body: { password: 'probe-pass-2' } },
  'admin-users-role-http': { params: { uuid: PROBE_DISABLED_UUID }, body: { role: 'viewer' } },
  'admin-users-disabled-http': { params: { uuid: PROBE_DISABLED_UUID }, body: { disabled: false } },
  'admin-zone-grant-http': { body: { zone_uuid: PROBE_ZONE_UUID, user_uuid: PROBE_DISABLED_UUID } },
  'admin-plot-grant-http': { body: { plot_uuid: PROBE_PLOT_UUID, user_uuid: PROBE_DISABLED_UUID } },
  'admin-zone-grant-delete-http': {
    params: { assignmentUuid: PROBE_GRANT_UUID },
    setupSql: "INSERT INTO user_zone_assignments (assignment_uuid, user_uuid, zone_uuid, created_at) VALUES ('" +
      PROBE_GRANT_UUID + "', '" + PROBE_DISABLED_UUID + "', '" + PROBE_ZONE_UUID + "', '2026-01-01T00:00:00Z');",
  },
  'admin-plot-grant-delete-http': {
    params: { assignmentUuid: PROBE_GRANT_UUID },
    setupSql: "INSERT INTO user_plot_assignments (assignment_uuid, user_uuid, plot_uuid, created_at) VALUES ('" +
      PROBE_GRANT_UUID + "', '" + PROBE_DISABLED_UUID + "', '" + PROBE_PLOT_UUID + "', '2026-01-01T00:00:00Z');",
  },
  // The discard verb of the entry PUT, on the foreign zone-only entry made a
  // version-zero draft: it reaches its write when every decision says yes (an update needs
  // a catalogue-valid body the probe does not build).
  'journal-entry-put-http': {
    params: { uuid: FOREIGN_ENTRY_UUID },
    body: { entry_uuid: FOREIGN_ENTRY_UUID, discard: true },
    setupSql: "UPDATE journal_entries SET status = 'draft', sync_version = 0 WHERE entry_uuid = '" +
      FOREIGN_ENTRY_UUID + "';",
  },
  'journal-entry-void-post-http': {
    params: { uuid: FOREIGN_ENTRY_UUID },
    body: { entry_uuid: FOREIGN_ENTRY_UUID, base_sync_version: 1, reason: 'probe' },
  },
  'improvement-requests-post-http': {
    body: {
      type: 'bug',
      severity: 'idea',
      area: 'other',
      title: 'Probe title',
      description: 'Probe description long enough',
      consent_public: true,
      consent_diagnostics: true,
    },
  },
};

// Link-in targets that a denied request may reach because they do not act on
// the request's data: they record that an error happened or nudge the sync
// outbox to flush. The probe stops at them.
const TERMINAL_LINK_INS = new Map([
  ['record-error-link-in', 'counts the error for the health report; reads no request data'],
  ['sync-outbox-flush-link-in', 'asks the outbox to flush what is already queued; adds nothing'],
]);

// CORS preflights: answer the browser's OPTIONS request with headers only. Each
// is probed and must touch no data; it needs no scope decision. An OPTIONS
// route not listed here is probed like any other entry.
const CORS_PREFLIGHT_ENTRIES = new Set([
  'auth-options-http',
  'device-options-http',
  'sys-cors-in',
  'al-options-in',
  'dendro-cors-http',
  'dendro-zone-cors-http',
  'dendro-zone-ref-cors-http',
  'dendro-location-cors-http',
  'zone-config-cors-http',
  'zone-env-cors-http',
]);

// Every node type in the flows, sorted into entries and the rest. A request
// from a user can only arrive through an `http in` node, which is probed; the
// other entry types carry no user. A type not listed here fails, so a new kind
// of input node cannot arrive unprobed.
const NODE_TYPES = new Map([
  ['http in', 'entry with a user: probed by this verifier'],
  ['mqtt in', 'entry without a user: ChirpStack uplinks and the local broker'],
  ['device event', 'entry without a user: ChirpStack device events'],
  ['field_tester_service', 'entry without a user: field tester uplinks'],
  ['inject', 'entry without a user: timers'],
  ['catch', 'entry without a user: error handler of its tab'],
  ['link in', 'internal: reached only from link out nodes'],
  ['link out', 'internal'],
  ['function', 'internal'],
  ['http response', 'internal'],
  ['sqlite', 'internal'],
  ['mqtt out', 'internal'],
  ['debug', 'internal'],
  ['split', 'internal'],
  ['switch', 'internal'],
  ['tab', 'configuration'],
  ['group', 'configuration'],
  ['global-config', 'configuration'],
  ['mqtt-broker', 'configuration'],
  ['sqlitedb', 'configuration'],
]);

// Write rules. A write entry (PUT, POST, DELETE or PATCH, or any entry that
// writes once every decision says yes) must, before its first write, make
//   - a write-role decision: canMutate or an admin decision, and
//   - when its URL addresses a device, zone or plot, a decision on that very
//     object (assertFresh{Device,Zone,Plot}Access on the probe's object) or an
//     admin decision.
// URL parameters the verifier cannot map to a device, zone or plot need an
// entry in WRITE_TARGETS. Every exception below carries its reason.
const WRITE_TARGETS = new Map([
  ...[
    'admin-users-create-http', 'admin-users-password-http', 'admin-users-role-http',
    'admin-users-disabled-http', 'admin-zone-grant-http', 'admin-zone-grant-delete-http',
    'admin-plot-grant-http', 'admin-plot-grant-delete-http',
  ].map((id) => [id, { object: 'admin', reason: 'account and grant administration is admin-only' }]),
  [
    'sync-outbox-recover-http',
    { object: 'admin', reason: 'outbox recovery acts on the whole gateway; admin-only' },
  ],
  ...[
    'history-gateway-cards-http', 'history-gateway-card-data-http', 'history-gateway-card-advanced-http',
    'history-gateway-card-preferences-http', 'history-gateway-card-opened-http',
  ].map((id) => [id, { object: 'admin', reason: 'gateway-wide history is admin-only (P2)' }]),
  [
    'assign-device-http',
    {
      object: 'zone',
      target: PROBE_ZONE_UUID,
      reason: 'assignment takes only unassigned devices (W4/P7: the UPDATE requires ' +
        'irrigation_zone_id IS NULL), so the zone is the object in scope',
    },
  ],
  ...['journal-entry-put-http', 'journal-entry-void-post-http'].map((id) => [id, {
    object: 'zone',
    target: FOREIGN_ZONE_UUID,
    // #403, by the owner's decision: an entry with neither zone nor plot is
    // farm-wide, and any write-capable role may change it without a zone grant
    // (the role decision is the rule). An entry with a zone and no plot needs
    // the grant on its zone, which the fixture's foreign zone-only entry tests.
    reason: 'the fixture entry is a zone-only entry (no plot) in the foreign zone; farm-wide ' +
      'entries (no zone, no plot) need only the write role (#403)',
  }]),
  [
    'journal-custom-vocab-put-http',
    { object: 'own', reason: 'custom terms are read and written through owner filters' },
  ],
  [
    'journal-plot-group-put-http',
    {
      object: 'own',
      reason: 'the group row is filtered by owner, and each member plot gets assertFreshPlotAccess',
    },
  ],
]);

// Write entries that need no write-role decision, each with its reason.
const NO_WRITE_ROLE_NEEDED = new Map([
  ['analysis-series-http', 'a read sent as POST (the query is the body); it writes nothing'],
  [
    'analysis-views-post-http',
    'saves the caller\'s own analysis view, filtered by owner; no farm data changes',
  ],
  [
    'improvement-requests-post-http',
    'files a support request owned by the caller; any enabled role may report a problem, ' +
      'so the enabled-account decision is the whole rule (#400)',
  ],
]);

// Write entries that address an object yet need no decision on it, each with
// its reason.
const NO_OBJECT_DECISION_NEEDED = new Map([
]);

// Records a node may write after a scope decision said no, because they record
// the refusal itself: node id -> the tables it may touch, and why.
const DENIAL_RECORDS = new Map([
  [
    'write-strega-expectation',
    {
      tables: ['applied_commands'],
      // Reads of the ledger, and only a write that carries this reason.
      writeMarker: 'scope_denied',
      reason: 'a refused valve command is written to the command ledger as rejected ' +
        "(reason 'scope_denied'), so the cloud receives a rejection acknowledgement",
    },
  ],
]);

function isDenialRecord(access) {
  const record = DENIAL_RECORDS.get(access.node);
  return Boolean(record && access.tables.length &&
    access.tables.every((table) => record.tables.includes(table)) &&
    (!access.write || String(access.detail || '').includes(record.writeMarker)));
}

// Values the probe database holds and no refused request may carry back.
const FIXTURE_CANARIES = [
  'Probe device', 'Probe zone', 'Probe plot', 'probe-admin', 'probe-disabled',
  'Foreign device', 'Foreign valve', 'Foreign zone', 'Foreign plot', 'Foreign group', PROBE_ADMIN_UUID,
];

// Write-only scoping (W1): the read-filter API is retired. A route that
// reintroduces one of these calls is reintroducing read scoping, which the
// behavioral matrix would catch only if someone wrote the matching test.
const RETIRED_READ_FILTERS = [
  'assertZoneAccess',
  'assertPlotAccess',
  'assertDeviceAccess',
  'listScopeZoneUuids',
  'filterZoneUuids',
];

function findReadFilterRegressions(flows, profileLabel) {
  const failures = [];
  for (const node of flows) {
    const text = String(node.func || '');
    for (const name of RETIRED_READ_FILTERS) {
      if (text.includes(name + '(')) {
        failures.push(
          `${profileLabel}: node ${node.id} (${node.name || 'unnamed'}) calls retired read filter ${name}()`
        );
      }
    }
  }
  return failures;
}

function entryLabel(profileLabel, entry) {
  return `${profileLabel}: ${String(entry.method || '').toUpperCase()} ${entry.url} (${entry.id})`;
}

function carriesFixtureData(payload) {
  if (payload === undefined || payload === null) return false;
  let text;
  try {
    text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  } catch (error) {
    text = String(payload);
  }
  return FIXTURE_CANARIES.some((canary) => String(text).includes(canary));
}

// Turns one probe trace into the failures of the scope-decision contract.
// options.filtering: the entry is in FILTERING_ENTRIES.
function judgeTrace(label, trace, options = {}) {
  const failures = [];
  for (const reason of trace.unanalysable) failures.push(`${label} cannot be analysed: ${reason}`);
  if (!trace.decisions.length) {
    const first = trace.accesses[0];
    const detail = first ? `; it reaches ${first.node}: ${first.what}` : '';
    failures.push(`${label} has no scope call: no node on its path made a scope decision${detail}`);
    return failures;
  }
  const denial = trace.decisions.find((decision) => decision.action === 'deny');
  // A write before a denied decision is covered when the same decision on the
  // same object already said yes before the write (a guard re-checking later).
  const coveredBefore = (access) => trace.decisions.some((decision) =>
    decision.action === 'allow' && decision.seq < access.seq && decision.name === denial.name &&
    String(decision.target || '') === String(denial.target || ''));
  for (const access of trace.accesses) {
    if (access.phase === 'before') {
      failures.push(`${label} reads or writes data before its scope decision: ${access.node}: ${access.what}`);
    } else if (access.phase === 'after') {
      if (isDenialRecord(access)) continue;
      // A filtering entry decides per row and goes on to the next one after a
      // refusal: resolving the next row, and reading allowed rows, is its
      // design. With every decision refused it must read no data.
      if (options.filtering && !access.write &&
          (access.what.startsWith('resolution-read') || trace.decisions.some((d) => d.action === 'allow'))) continue;
      failures.push(`${label} goes on after its scope decision said no: ${access.node}: ${access.what}`);
    } else if (denial && access.seq < denial.seq && !coveredBefore(access)) {
      failures.push(
        `${label} writes before its scope decision ${denial.index} (${denial.name}) said no: ` +
        `${access.node}: ${access.what}`
      );
    }
  }
  for (const response of trace.responses) {
    const refused = response.denied || !response.decided;
    if (!refused) continue;
    if (carriesFixtureData(response.payload)) {
      failures.push(`${label} answers ${response.status} with fixture data although the request was refused (${response.node})`);
    }
    if (options.filtering && response.decided) {
      if (response.status >= 500) {
        failures.push(`${label} cannot be analysed: the filtering entry answers ${response.status}, so its filtered read was not reached (${response.node})`);
      }
      continue;
    }
    if (response.status >= 400) continue;
    failures.push(response.decided
      ? `${label} goes on after its scope decision said no: answers ${response.status} (${response.node})`
      : `${label} answers ${response.status} on a path without a scope decision (${response.node})`);
  }
  if (!failures.length && !trace.responses.length && !trace.streamed) {
    failures.push(`${label} cannot be analysed: the denied request reaches no http response`);
  }
  return failures;
}

// The 'truthy' variant sets every request field the probe does not set. It
// exists to catch a decision skipped for some request content, so it judges
// only what such a skip leaves behind; a variant request that stops at
// validation proves nothing and passes.
function judgeVariant(label, trace, options = {}) {
  const failures = [];
  const prefix = `${label} skips or ignores its scope decision when the request sets a field`;
  for (const access of trace.accesses) {
    if (access.phase === 'after' && options.filtering && !access.write &&
        access.what.startsWith('resolution-read')) continue;
    if (access.phase === 'before' || access.phase === 'after') {
      failures.push(`${prefix}: ${access.node}: ${access.what}`);
    }
  }
  for (const response of trace.responses) {
    if (response.status >= 400) continue;
    if (response.decided && (!response.denied || options.filtering)) continue;
    failures.push(`${prefix}: answers ${response.status} (${response.node})`);
  }
  return failures;
}

const WRITE_METHODS = new Set(['PUT', 'POST', 'DELETE', 'PATCH']);

// The object an entry's URL addresses, as the probe fills it in.
function addressedObject(entry) {
  if (WRITE_TARGETS.has(entry.id)) return WRITE_TARGETS.get(entry.id);
  const url = String(entry.url || '');
  const params = (REQUEST_FIXTURES[entry.id] || {}).params || {};
  if (/\/:deveui\b/.test(url)) return { object: 'device', target: params.deveui || PROBE_DEVEUI };
  if (/^\/api\/(?:irrigation-zones|history\/zones)\/:(?:id|zone_id|zoneId)\b/.test(url)) {
    return { object: 'zone', target: PROBE_ZONE_UUID };
  }
  if (/^\/api\/journal\/plots\/:uuid\b/.test(url)) return { object: 'plot', target: PROBE_PLOT_UUID };
  if (/\/:[A-Za-z_]/.test(url)) return { object: 'unmapped' };
  return null;
}

function sameTarget(decision, wanted) {
  return String(decision.target || '').toUpperCase() === String(wanted.target || '').toUpperCase();
}

// Required decisions, judged on the run in which every decision says yes.
// options.variant: the truthy variant, judged only when it reaches a write
// (a variant request that stops at validation proves nothing).
function judgeRequired(label, entry, trace, options = {}) {
  const failures = [];
  const writes = trace.accesses.filter((access) => access.write && access.phase !== 'after');
  const method = String(entry.method || '').toUpperCase();
  if (!WRITE_METHODS.has(method) && !writes.length) return failures;
  if (options.variant) {
    if (!writes.length) return failures;
    label = `${label} skips or ignores its scope decision when the request sets a field:`;
  }
  const firstWrite = writes.length ? writes[0].seq : Infinity;
  const before = trace.decisions.filter((decision) => decision.seq < firstWrite);
  const reached = '';
  if (!writes.length && !UNREACHED_WRITES.has(entry.id) && !options.variant) {
    const answer = trace.responses.map((r) => `${r.status} ${JSON.stringify(r.payload)}`.slice(0, 120)).join('; ');
    failures.push(
      `${label} never reaches its write with every decision allowed` +
      (trace.unanalysable.length ? ` (${trace.unanalysable[0]})` : answer ? ` (answers ${answer})` : '') +
      '; give it a request fixture or list it in UNREACHED_WRITES'
    );
  }
  const isAdmin = (decision) => decision.level === 'admin';
  if (!NO_WRITE_ROLE_NEEDED.has(entry.id) &&
      !before.some((decision) => decision.level === 'mutate' || isAdmin(decision))) {
    failures.push(`${label} makes no write-role decision before it writes (canMutate or an admin decision)${reached}`);
  }
  const wanted = addressedObject(entry);
  if (!wanted || NO_OBJECT_DECISION_NEEDED.has(entry.id)) return failures;
  if (wanted.object === 'own') return failures;
  if (wanted.object === 'unmapped') {
    failures.push(`${label} addresses an object the verifier cannot map; add it to WRITE_TARGETS`);
  } else if (wanted.object === 'admin') {
    if (!before.some(isAdmin)) failures.push(`${label} makes no admin decision before it writes${reached}`);
  } else if (!before.some((decision) => isAdmin(decision) ||
      (decision.level === 'object' && decision.object === wanted.object && sameTarget(decision, wanted)))) {
    failures.push(`${label} makes no scope decision on the ${wanted.object} it addresses before it writes${reached}`);
  }
  return failures;
}

// Outcome rule. Each write entry is run as the caller, a researcher who owns
// zone 1 and everything in it, with the real scope helper deciding against the
// probe database, and the database is compared before and after. No row of an
// object outside that scope (zone 2 and its device, valve, plot, schedule,
// plot group and journal entry, the shared weather station's zone-2
// assignment, the admin's account and rows) may be added, changed or removed.
// The runs: the fixture request; each URL parameter pointed at a foreign
// object; every unset body or query field naming a foreign object (one run per
// kind of id); and the fixture's own foreign bodies.
//
// Tables a run may change outside the caller's scope, with the reason.
const OUTSIDE_SCOPE_TABLES = new Map([
]);

// Write entries whose write the probe cannot reach with every decision
// allowed, with the reason. Every other write entry must reach its write, so
// that a decision ignored before it shows.
const UNREACHED_WRITES = new Map([
  ['analysis-series-http', 'a read sent as POST: there is no write to reach'],
  ['sys-fan-in', 'the write is a PWM value through sysfs, which the probe serves as absent; the admin decision comes first'],
  [
    '7aa47f3149614bb1',
    'queues a calibration refresh for the cloud and needs a linked cloud account, which the probe has not; ' +
      'the device decisions come first',
  ],
  [
    'sync-outbox-recover-http',
    'execute needs a cloud replay receipt the probe cannot mint; the dry run is probed and reads the outbox ' +
      'after the admin decision, so an ignored admin decision still shows',
  ],
  ...['journal-entries-post-http', 'journal-custom-vocab-post-http', 'journal-custom-vocab-put-http'].map((id) => [
    id,
    'needs a catalogue-valid journal body (template, layout and values, or a custom field definition) the ' +
      'probe does not build; its write role and plot or zone decisions run first in osi-journal',
  ]),
]);

const FOREIGN_FILLS = [FOREIGN_DEVEUI, FOREIGN_ZONE_ID, FOREIGN_ZONE_UUID, FOREIGN_PLOT_UUID];

// The foreign values a URL parameter can be pointed at.
function foreignParams(entry) {
  const url = String(entry.url || '');
  const variants = [];
  if (/:deveui\b/.test(url)) {
    variants.push({ deveui: FOREIGN_DEVEUI }, { deveui: FOREIGN_VALVE_DEVEUI });
  }
  const zoneParam = (url.match(/^\/api\/(?:irrigation-zones|history\/zones)\/:(id|zone_id|zoneId)\b/) || [])[1];
  if (zoneParam) variants.push({ [zoneParam]: String(FOREIGN_ZONE_ID) });
  if (/^\/api\/journal\/plots\/:uuid\b/.test(url)) variants.push({ uuid: FOREIGN_PLOT_UUID });
  if (/^\/api\/journal\/plot-groups\/:uuid\b/.test(url)) variants.push({ uuid: FOREIGN_GROUP_UUID });
  if (/^\/api\/journal\/entries\/:uuid\b/.test(url)) variants.push({ uuid: FOREIGN_ENTRY_UUID });
  if (/^\/api\/users\/:uuid\b/.test(url)) variants.push({ uuid: PROBE_ADMIN_UUID });
  return variants;
}

function judgeOutcome(label, trace, how, knownGap) {
  const failures = [];
  for (const change of trace.changes || []) {
    if (OUTSIDE_SCOPE_TABLES.has(change.table)) continue;
    if (knownGap && knownGap.table === change.table && knownGap.op === change.op) continue;
    const marks = foreignMarkers(change.table, change.row);
    if (marks.length) {
      failures.push(`${label} changes a row outside the caller's scope (${how}): ${change.table} row ${change.op}, ${marks[0]}`);
    }
  }
  for (const access of trace.accesses) {
    if (access.write && !access.what.startsWith('write ')) {
      const id = foreignEffect(access.detail);
      if (id) failures.push(`${label} acts on an object outside the caller's scope (${how}): ${access.node}: ${access.what} names ${id}`);
    }
  }
  return failures;
}

async function checkOutcome(flows, entry, label, probeOptions) {
  const failures = [];
  const knownGap = KNOWN_OUTCOME_GAPS.get(entry.id);
  let knownGapSeen = false;
  const base = { ...probeOptions, decisions: 'real', snapshot: true };
  const runs = [{ how: 'the fixture request', options: {} }];
  for (const params of foreignParams(entry)) {
    runs.push({ how: `URL ${JSON.stringify(params)}`, options: { params } });
  }
  for (const fill of FOREIGN_FILLS) {
    runs.push({ how: `unset fields set to ${fill}`, options: { variant: { fill } } });
  }
  const fixture = probeOptions.fixture || {};
  for (const body of (fixture.foreignBodies || [])) {
    const options = { body };
    // foreignBodySetupSql runs before each foreign-body run only, after setupSql.
    if (fixture.foreignBodySetupSql) {
      options.fixture = { ...fixture, setupSql: (fixture.setupSql || '') + '\n' + fixture.foreignBodySetupSql };
    }
    runs.push({ how: `body ${JSON.stringify(body)}`, options });
  }
  for (const run of runs) {
    const trace = await probeEntry(flows, entry, { ...base, ...run.options });
    failures.push(...judgeOutcome(label, trace, run.how, knownGap));
    if (knownGap && (trace.changes || []).some((change) => change.table === knownGap.table &&
        change.op === knownGap.op && foreignMarkers(change.table, change.row).length)) {
      knownGapSeen = true;
    }
  }
  if (knownGap && !knownGapSeen) {
    failures.push(`${label} is listed as known gap ${knownGap.issue} but no longer shows it; remove it from KNOWN_OUTCOME_GAPS`);
  }
  return failures;
}

// The whole check for one entry: every decision denied; the truthy variant
// with every decision denied; every decision allowed (required decisions), in
// the plain and the truthy request; then each later decision denied on its
// own with every other one allowed (decision 1 too when there are several, so a
// later decision cannot hide an ignored first one).
async function checkEntry(flows, entry, label, probeOptions) {
  const filtering = FILTERING_ENTRIES.has(entry.id);
  const first = await probeEntry(flows, entry, probeOptions);
  const failures = judgeTrace(label, first, { filtering });
  if (failures.length) return { failures, first };
  const variant = await probeEntry(flows, entry, { ...probeOptions, variant: 'truthy' });
  failures.push(...judgeVariant(label, variant, { filtering }));
  const allowAll = await probeEntry(flows, entry, { ...probeOptions, denyAt: Infinity });
  failures.push(...judgeRequired(label, entry, allowAll));
  const isWrite = WRITE_METHODS.has(String(entry.method || '').toUpperCase()) ||
    allowAll.accesses.some((access) => access.write);
  if (isWrite) failures.push(...await checkOutcome(flows, entry, label, probeOptions));
  const variantAllowAll = await probeEntry(flows, entry, { ...probeOptions, denyAt: Infinity, variant: 'truthy' });
  failures.push(...judgeRequired(label, entry, variantAllowAll, { variant: true }));
  for (let k = allowAll.decisions.length > 1 ? 1 : 2; k <= allowAll.decisions.length; k += 1) {
    const trace = await probeEntry(flows, entry, { ...probeOptions, denyOnly: k });
    failures.push(...judgeTrace(label, trace, { filtering }));
  }
  return { failures: [...new Set(failures)], first };
}

// The request must be refused without any read or write and without a success
// answer. Used for inline account checks (probed with a disabled account) and
// for entries that answer without data (probed with the usual caller).
function judgeRefusal(label, trace, failurePrefix, options = {}) {
  const failures = [];
  for (const reason of trace.unanalysable) failures.push(`${label} cannot be analysed: ${reason}`);
  for (const access of trace.accesses) {
    failures.push(`${label} ${failurePrefix}: ${access.node}: ${access.what}`);
  }
  for (const response of trace.responses) {
    if (carriesFixtureData(response.payload)) {
      failures.push(`${label} ${failurePrefix}: answers ${response.status} with fixture data (${response.node})`);
    }
    if (response.status < 400 && !options.anyStatus) {
      failures.push(`${label} ${failurePrefix}: answers ${response.status} (${response.node})`);
    }
  }
  if (!trace.responses.length && !failures.length) {
    failures.push(`${label} cannot be analysed: the request reaches no http response`);
  }
  return failures;
}

function modulesRootFor(profileLabel) {
  if (PROFILES.includes(profileLabel)) {
    return path.join(ROOT, path.dirname(profileLabel), 'node-red');
  }
  return DEFAULT_MODULES_ROOT;
}

// options.only: probe just these entry ids (tests use it; the CLI probes all).
// options.modulesRoot: the profile's node-red directory for its seam modules.
async function findFailures(flows, profileLabel, allowlist = ALLOWLIST, options = {}) {
  const failures = [];
  const byId = new Map(flows.map((node) => [node.id, node]));
  const entries = flows.filter((node) => node.type === 'http in');
  const entryIds = new Set(entries.map((node) => node.id));
  const modulesRoot = options.modulesRoot || modulesRootFor(profileLabel);
  const terminalLinkIns = new Set(TERMINAL_LINK_INS.keys());

  const unknownTypes = new Map();
  for (const node of flows) {
    if (!NODE_TYPES.has(node.type) && !unknownTypes.has(node.type)) unknownTypes.set(node.type, node.id);
  }
  for (const [type, id] of unknownTypes) {
    failures.push(
      `${profileLabel}: node type ${type} (${id}) is neither an entry the ratchet probes nor a type it ` +
      'knows; classify it in NODE_TYPES'
    );
  }

  const inventories = [
    ['allowlist', [...allowlist]],
    ['inline account check list', [...INLINE_ACCOUNT_CHECKS.keys()]],
    ['no-data list', [...NO_DATA_ENTRIES.keys()]],
    ['filtering list', [...FILTERING_ENTRIES.keys()]],
    ['request fixture list', Object.keys(REQUEST_FIXTURES)],
    ['write target list', [...WRITE_TARGETS.keys()]],
    ['write-role exception list', [...NO_WRITE_ROLE_NEEDED.keys()]],
    ['object exception list', [...NO_OBJECT_DECISION_NEEDED.keys()]],
    ['unreached write list', [...UNREACHED_WRITES.keys()]],
    ['known outcome gap list', [...KNOWN_OUTCOME_GAPS.keys()]],
  ];
  for (const id of DENIAL_RECORDS.keys()) {
    if (!byId.has(id)) failures.push(`${profileLabel}: denial record entry ${id} matches no node`);
  }
  for (const [name, ids] of inventories) {
    for (const id of ids) {
      if (!entryIds.has(id)) failures.push(`${profileLabel}: ${name} entry ${id} matches no http in node`);
    }
  }
  for (const id of CORS_PREFLIGHT_ENTRIES) {
    const node = byId.get(id);
    if (!node || node.type !== 'http in' || node.method !== 'options') {
      failures.push(`${profileLabel}: CORS preflight entry ${id} matches no OPTIONS http in node`);
    }
  }
  for (const id of TERMINAL_LINK_INS.keys()) {
    const node = byId.get(id);
    if (!node || node.type !== 'link in') {
      failures.push(`${profileLabel}: terminal link-in entry ${id} matches no link in node`);
    }
  }

  for (const entry of entries) {
    if (options.only && !options.only.has(entry.id)) continue;
    const label = entryLabel(profileLabel, entry);
    const probeOptions = {
      byId,
      modulesRoot,
      terminalLinkIns,
      fixture: REQUEST_FIXTURES[entry.id],
    };

    if (CORS_PREFLIGHT_ENTRIES.has(entry.id) && entry.method === 'options') {
      const trace = await probeEntry(flows, entry, probeOptions);
      failures.push(...judgeRefusal(label, trace, 'is listed as a CORS preflight, yet it goes on', { anyStatus: true }));
      continue;
    }
    if (NO_DATA_ENTRIES.has(entry.id)) {
      const trace = await probeEntry(flows, entry, probeOptions);
      if (trace.decisions.length) {
        failures.push(`${label} is listed as answering without data but makes a scope decision; remove it from the list`);
        continue;
      }
      failures.push(...judgeRefusal(label, trace, 'is listed as answering without data, yet it goes on'));
      continue;
    }

    const { failures: verdict } = await checkEntry(flows, entry, label, probeOptions);

    if (allowlist.has(entry.id)) {
      if (!verdict.length) {
        failures.push(`${label} is allowlisted but makes its scope decision; remove it from the allowlist`);
      }
      continue;
    }
    if (INLINE_ACCOUNT_CHECKS.has(entry.id)) {
      if (!verdict.length) {
        failures.push(`${label} is listed as an inline account check but makes its scope decision on the helper; remove it from the list`);
        continue;
      }
      const disabledTrace = await probeEntry(flows, entry, { ...probeOptions, actor: 'disabled' });
      failures.push(...judgeRefusal(label, disabledTrace, 'does not refuse a disabled account'));
      continue;
    }
    failures.push(...verdict);
  }
  return failures;
}

// Result cache. A pull request runs the ratchet up to three times on the same
// tree (its workflow step, scripts/verify-sync-flow.js and the full-tree test).
// The verdict depends only on the files hashed below and the Node version, so
// the first run stores it under that digest and the others reuse it. The cache
// lives in RUNNER_TEMP on CI (private to the job) and otherwise in a per-user
// directory under the system temporary directory; that directory must be ours,
// not a symlink, and closed to others, and so must each cache file, or the
// cache is not used. Files are written under a random name and renamed into
// place. OSI_SCOPED_ACCESS_RATCHET_CACHE=0 turns the cache off.
function ownedPrivately(stat) {
  if (typeof process.getuid !== 'function') return true;
  return stat.uid === process.getuid() && (stat.mode & 0o077) === 0;
}

function cacheDirectory() {
  const base = process.env.RUNNER_TEMP
    ? path.join(process.env.RUNNER_TEMP, 'osi-scoped-access-ratchet')
    : path.join(os.tmpdir(), `osi-scoped-access-ratchet-${typeof process.getuid === 'function' ? process.getuid() : 'user'}`);
  try {
    fs.mkdirSync(base, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(base);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !ownedPrivately(stat)) return null;
    return base;
  } catch (error) {
    return null;
  }
}

function readCachedVerdict(file) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || !ownedPrivately(stat)) return null;
    const cached = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(cached.failures) ? cached.failures : null;
  } catch (error) {
    return null;
  }
}

function writeCachedVerdict(file, failures) {
  const temporary = `${file}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify({ failures }), { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, file);
  } catch (error) {
    try { fs.rmSync(temporary, { force: true }); } catch (_) { /* best effort */ }
  }
}

// The cache file for a verifyProfiles call, or null when the call must not use
// the cache (mutated flows, a subset of entries, or the cache turned off).
function cacheFileFor(profiles, options = {}) {
  if (options.load || options.only) return null;
  if (process.env.OSI_SCOPED_ACCESS_RATCHET_CACHE === '0') return null;
  const directory = cacheDirectory();
  return directory ? path.join(directory, `${inputDigest(profiles)}.json`) : null;
}

function listFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(full));
    else if (entry.isFile()) files.push(full);
  }
  return files;
}

function inputDigest(profiles) {
  const files = [
    __filename,
    require.resolve('./lib/scope-guard-probe'),
    path.join(ROOT, 'database/seed-blank.sql'),
  ];
  for (const relativePath of profiles) {
    files.push(path.join(ROOT, relativePath), ...listFiles(modulesRootFor(relativePath)));
  }
  const hash = crypto.createHash('sha256');
  hash.update(process.version);
  for (const file of files.sort()) {
    hash.update('\0' + path.relative(ROOT, file) + '\0');
    hash.update(fs.readFileSync(file));
  }
  return hash.digest('hex');
}

// options.load(profile): flows loader (tests mutate one profile with it).
// options.only: forwarded to findFailures.
// Neither given: the tracked tree, and the cached verdict may be used.
async function verifyProfiles(profiles = PROFILES, options = {}) {
  const cacheFile = cacheFileFor(profiles, options);
  if (cacheFile) {
    const cached = readCachedVerdict(cacheFile);
    if (cached) return cached;
  }
  const load = options.load || ((relativePath) =>
    JSON.parse(fs.readFileSync(path.join(ROOT, relativePath), 'utf8')));
  const failures = [];
  for (const relativePath of profiles) {
    const flows = load(relativePath);
    failures.push(...await findFailures(flows, relativePath, ALLOWLIST, { only: options.only }));
    failures.push(...findReadFilterRegressions(flows, relativePath));
  }
  if (cacheFile) writeCachedVerdict(cacheFile, failures);
  return failures;
}

if (require.main === module) {
  verifyProfiles().then((failures) => {
    if (failures.length) {
      console.error('FAIL: scoped-access ratchet:\n  ' + failures.join('\n  '));
      process.exit(1);
    }
    console.log(
      'verify-scoped-access: OK (every entry decides on scope before touching data, ' +
      `or is listed: ${PUBLIC_ALLOWLIST.size} public, ${PHASE_C_PENDING.size} Phase C, ` +
      `${KNOWN_GAPS.size} known gaps, ${INLINE_ACCOUNT_CHECKS.size} inline checks, ` +
      `${NO_DATA_ENTRIES.size} without data, ${FILTERING_ENTRIES.size} filtering; ` +
      'the behavioral matrix is the correctness gate)'
    );
  }, (error) => {
    console.error('verify-scoped-access: fatal error:', error);
    process.exit(1);
  });
}

module.exports = {
  ALLOWLIST,
  CORS_PREFLIGHT_ENTRIES,
  FILTERING_ENTRIES,
  INLINE_ACCOUNT_CHECKS,
  DENIAL_RECORDS,
  KNOWN_GAPS,
  KNOWN_OUTCOME_GAPS,
  isDenialRecord,
  NODE_TYPES,
  NO_DATA_ENTRIES,
  NO_OBJECT_DECISION_NEEDED,
  NO_WRITE_ROLE_NEEDED,
  OUTSIDE_SCOPE_TABLES,
  UNREACHED_WRITES,
  PHASE_C_PENDING,
  PROFILES,
  PUBLIC_ALLOWLIST,
  REQUEST_FIXTURES,
  RETIRED_READ_FILTERS,
  TERMINAL_LINK_INS,
  WRITE_TARGETS,
  cacheFileFor,
  checkEntry,
  findFailures,
  findReadFilterRegressions,
  judgeTrace,
  verifyProfiles,
};
