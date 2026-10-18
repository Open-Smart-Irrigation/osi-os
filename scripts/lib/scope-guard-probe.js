'use strict';

// Scope-guard probe for scripts/verify-scoped-access.js.
//
// Drives one `http in` entry of a flows.json through the function nodes it is
// wired to, in scoped mode (OSI_SCOPED_ACCESS=1), with each decision function of
// the scope helper forced to say "no" or "yes" as the caller asks (all denied,
// all allowed, or one denied). It records, in order, which node made which
// scope decision and every read or write of data on the way. The verifier
// turns that record into its verdict; this module only observes.
//
// Why a probe and not a text search: the old ratchet passed a route when the
// text `require('scope')` appeared anywhere downstream, so a guard could lose
// its scope call while a later node that only resolves the token secret kept
// the route green (#389). Forcing a denial and watching what the chain still
// does sees the decision itself: whether it is made, by which node, whether
// data is touched before it, and whether the chain stops when it says no.
//
// What the probe uses:
// - an in-memory SQLite database built from database/seed-blank.sql plus a
//   small fixture (one zone and one device owned by an admin, an enabled
//   researcher with no grants who sends the request, a disabled account, the
//   gateway identity row); every SQL statement is recorded with the node that
//   ran it;
// - the profile's own seam modules (osi-journal, osi-network-api, ...) loaded
//   for real, so a decision a module makes through the helper it is handed is
//   recorded too;
// - recording stand-ins for what the flows reach through `global` (fs, cp) and
//   through their `libs` (network clients, ChirpStack), so those calls never
//   touch the host and each counts as an effect. A seam module loaded for real
//   keeps its own require('fs'); none of them reaches the host on a probed
//   path today, since AUTH_TOKEN_SECRET is set. Every database a handler opens
//   (whatever its file name) is served from the one probe database;
// - Node-RED semantics for function nodes (return value or node.send, one
//   array slot per output), link out/link in, http response and debug nodes.
//   Any other node type on the path is something the probe cannot simulate,
//   and the verifier fails closed on it.

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..', '..');
const SEED_SQL_PATH = path.join(ROOT, 'database/seed-blank.sql');
const PROBE_SECRET = 'scope-guard-probe-secret';
const PROBE_GATEWAY_EUI = '00000000000000A1';
const PROBE_DEVEUI = '00000000000000D1';
// Identities are canonical UUIDs because the journal module refuses others.
const PROBE_ADMIN_UUID = '00000000-0000-4000-8000-00000000a001';
const PROBE_CALLER_UUID = '00000000-0000-4000-8000-00000000a002';
const PROBE_DISABLED_UUID = '00000000-0000-4000-8000-00000000a003';
const PROBE_ZONE_UUID = '00000000-0000-4000-8000-00000000b001';
const PROBE_PLOT_UUID = '00000000-0000-4000-8000-00000000b101';
// Objects outside the caller's scope: a second zone owned by the admin, with
// a device, a valve, a plot, a schedule, a plot group and a journal entry.
const FOREIGN_ZONE_ID = 2;
const FOREIGN_ZONE_UUID = '00000000-0000-4000-8000-00000000b002';
const FOREIGN_DEVEUI = '00000000000000E1';
const FOREIGN_VALVE_DEVEUI = '00000000000000E2';
const FOREIGN_PLOT_UUID = '00000000-0000-4000-8000-00000000b102';
const FOREIGN_GROUP_UUID = '00000000-0000-4000-8000-00000000b201';
const FOREIGN_ENTRY_UUID = '00000000-0000-4000-8000-00000000b301';
const FOREIGN_SCHEDULE_ID = 2;
// A weather station: shared by design (the helper allows every caller on
// weather-class devices), assigned to both zones.
const WEATHER_DEVEUI = '00000000000000C1';
const NODE_TIMEOUT_MS = 3000;
const MAX_STEPS = 60;

// Functions of osi-scope-helper that decide whether the request may go on.
// The probe replaces each with a denial. The functions in HELPER_NON_DECISIONS
// decide nothing and run for real. A helper export in neither list makes every
// probe fail until it is classified here.
const DENIED_DECISIONS = {
  assertFreshZoneAccess: 'reject404',
  assertFreshPlotAccess: 'reject404',
  assertFreshDeviceAccess: 'reject404',
  assertRole: 'reject403',
  assertEnabledAccount: 'reject403',
  assertAuthenticatedRole: 'reject403',
  authorizeAdminRead: 'reject403',
  assertFreshRole: 'reject403',
  isAdmin: 'resolveFalse',
  canMutate: 'returnFalse',
  resolveScope: 'resolveDisabledScope',
};

const HELPER_NON_DECISIONS = new Set([
  'isScopedMode',
  'resolveAuthSecret',
  'verifyBearer',
  'invalidateScope',
  'buildDisableUserGuardedSql',
  'buildDeroleUserGuardedSql',
  'buildDeriveUserGuardedSql',
  'resolveZoneUuidById',
  '_resetForTests',
]);

// Tables a guard may read before it decides, because the decision needs them
// and they hold nothing a denied caller could take away: the account, the zone
// or device being addressed, the grants the decision consults, and the
// gateway's own identity row. A read of any other table before the decision,
// and any write at all, is data access (idempotent CREATE ... IF NOT EXISTS
// schema upkeep excepted). A read of these tables cannot leak either: a denied
// request must still end in an error answer.
const SCOPE_RESOLUTION_TABLES = new Set([
  'users',
  'irrigation_zones',
  'devices',
  'journal_plots',
  'user_zone_assignments',
  'user_plot_assignments',
  'installation_identity',
]);

const AUTH_SECRET_PATHS = new Set([
  '/data/db/osi_auth_token_secret',
  '/var/lib/node-red/.node-red/osi_auth_token_secret',
]);

let seedSqlCache = null;
function seedSql() {
  if (seedSqlCache === null) seedSqlCache = fs.readFileSync(SEED_SQL_PATH, 'utf8');
  return seedSqlCache;
}

// The caller (user 2, researcher) owns zone 1 and everything in it; the admin
// (user 1) owns zone 2 and everything in it. User 3 is disabled.
function seedProbeDatabase(db) {
  db.exec(seedSql());
  const t = "'2026-01-01T00:00:00Z'";
  db.exec(`
    INSERT INTO users (id, username, password_hash, created_at, user_uuid, role, sync_version)
    VALUES
      (1, 'probe-admin', 'x', '2026-01-01', '${PROBE_ADMIN_UUID}', 'admin', 1),
      (2, 'probe-user', 'x', '2026-01-01', '${PROBE_CALLER_UUID}', 'researcher', 1),
      (3, 'probe-disabled', 'x', '2026-01-01', '${PROBE_DISABLED_UUID}', 'researcher', 1);
    UPDATE users SET disabled_at = '2026-01-02T00:00:00Z' WHERE id = 3;
    INSERT INTO installation_identity (
      singleton_id, installation_uuid, current_gateway_device_eui, created_at, updated_at
    ) VALUES (
      1, '00000000-0000-4000-8000-0000000000c1', '${PROBE_GATEWAY_EUI}', '2026-01-01', '2026-01-01'
    );
    INSERT INTO irrigation_zones (id, name, user_id, zone_uuid, timezone, scheduling_mode, gateway_device_eui)
    VALUES
      (1, 'Probe zone', 2, '${PROBE_ZONE_UUID}', 'UTC', 'local', '${PROBE_GATEWAY_EUI}'),
      (${FOREIGN_ZONE_ID}, 'Foreign zone', 1, '${FOREIGN_ZONE_UUID}', 'UTC', 'local', '${PROBE_GATEWAY_EUI}');
    INSERT INTO journal_plots (plot_uuid, plot_code, name, zone_uuid, gateway_device_eui, owner_user_uuid)
    VALUES
      ('${PROBE_PLOT_UUID}', 'PROBE1', 'Probe plot', '${PROBE_ZONE_UUID}', '${PROBE_GATEWAY_EUI}', '${PROBE_CALLER_UUID}'),
      ('${FOREIGN_PLOT_UUID}', 'FOREIGN1', 'Foreign plot', '${FOREIGN_ZONE_UUID}', '${PROBE_GATEWAY_EUI}', '${PROBE_ADMIN_UUID}');
    INSERT INTO journal_plot_settings (plot_uuid, layout_code, updated_at, updated_by_principal_uuid)
    VALUES
      ('${PROBE_PLOT_UUID}', 'open_field', ${t}, '${PROBE_CALLER_UUID}'),
      ('${FOREIGN_PLOT_UUID}', 'open_field', ${t}, '${PROBE_ADMIN_UUID}');
    INSERT INTO devices (deveui, name, type_id, user_id, irrigation_zone_id, created_at, updated_at)
    VALUES
      ('${PROBE_DEVEUI}', 'Probe device', 'DRAGINO_LSN50', 2, 1, '2026-01-01', '2026-01-01'),
      ('${FOREIGN_DEVEUI}', 'Foreign device', 'DRAGINO_LSN50', 1, ${FOREIGN_ZONE_ID}, '2026-01-01', '2026-01-01'),
      ('${FOREIGN_VALVE_DEVEUI}', 'Foreign valve', 'STREGA_VALVE', 1, ${FOREIGN_ZONE_ID}, '2026-01-01', '2026-01-01'),
      ('${WEATHER_DEVEUI}', 'Shared weather station', 'SENSECAP_S2120', NULL, NULL, '2026-01-01', '2026-01-01');
    INSERT INTO weather_station_zones (deveui, zone_id) VALUES ('${WEATHER_DEVEUI}', 1), ('${WEATHER_DEVEUI}', ${FOREIGN_ZONE_ID});
    INSERT INTO irrigation_schedules (id, irrigation_zone_id, trigger_metric, threshold_kpa, enabled)
    VALUES (1, 1, 'SWT_1', 30, 1), (${FOREIGN_SCHEDULE_ID}, ${FOREIGN_ZONE_ID}, 'SWT_1', 30, 1);
    INSERT INTO journal_plot_groups (group_uuid, label, gateway_device_eui, created_by_principal_uuid, owner_user_uuid)
    VALUES ('${FOREIGN_GROUP_UUID}', 'Foreign group', '${PROBE_GATEWAY_EUI}', '${PROBE_ADMIN_UUID}', '${PROBE_ADMIN_UUID}');
    INSERT INTO journal_plot_group_members (group_uuid, plot_uuid) VALUES ('${FOREIGN_GROUP_UUID}', '${FOREIGN_PLOT_UUID}');
    INSERT INTO journal_entries (entry_uuid, owner_user_uuid, user_id, author_principal_uuid,
      plot_uuid, zone_id, zone_uuid, activity_code, template_code, template_version, layout_code,
      layout_version, catalog_version, occurred_start, occurred_timezone, occurred_utc_offset_minutes,
      recorded_at, origin, status, sync_version, gateway_device_eui, created_at, updated_at)
    VALUES ('${FOREIGN_ENTRY_UUID}', '${PROBE_ADMIN_UUID}', 1, '${PROBE_ADMIN_UUID}', NULL, ${FOREIGN_ZONE_ID},
      '${FOREIGN_ZONE_UUID}', (SELECT code FROM journal_vocab ORDER BY code LIMIT 1), 'probe', 1, 'probe', 1, 1,
      ${t}, 'UTC', 0, ${t}, 'edge-ui', 'final', 1, '${PROBE_GATEWAY_EUI}', ${t}, ${t});
  `);
}

// Values that mark a row as belonging to an object outside the caller's scope.
// A row is foreign when an identifier column (or an identifier key inside a
// *_json column) holds a foreign id, when a zone-id column holds the foreign
// zone, when an owner column holds the admin, or when it is the foreign
// schedule, zone or admin account itself. Free-text columns are not read: a
// caller may write any text into its own rows.
const FOREIGN_IDS = [
  FOREIGN_ZONE_UUID, FOREIGN_DEVEUI, FOREIGN_VALVE_DEVEUI, FOREIGN_PLOT_UUID,
  FOREIGN_GROUP_UUID, FOREIGN_ENTRY_UUID, PROBE_ADMIN_UUID,
];
const ID_NAME = /(?:uuid|eui|deveui|_id|_key)$|^(?:id|key)$|(?:Uuid|Eui|Id|Key)$/;
const ZONE_ID_COLUMN = /(?:^|_)zone_id$|zoneId$/;
const OWNER_ID_COLUMN = /^(?:user_id|owner_user_id|userId|ownerUserId)$/;

function markValue(name, value, marks) {
  if (typeof value === 'string') {
    if (!ID_NAME.test(name)) return;
    for (const id of FOREIGN_IDS) {
      if (value.toUpperCase() === id.toUpperCase() || (/key$/i.test(name) && value.includes(id))) {
        marks.push(`${name} = ${id}`);
      }
    }
  } else if (typeof value === 'number' || typeof value === 'bigint') {
    const number = Number(value);
    if (ZONE_ID_COLUMN.test(name) && number === FOREIGN_ZONE_ID) marks.push(`${name} = ${number}`);
    if (OWNER_ID_COLUMN.test(name) && number === 1) marks.push(`${name} = 1 (the admin)`);
  }
}

function markJson(value, marks, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 6) return;
  for (const [key, inner] of Object.entries(value)) {
    if (inner && typeof inner === 'object') markJson(inner, marks, depth + 1);
    else markValue(key, inner, marks);
  }
}

// An effect (a downlink, an MQTT message, a command) aimed at a foreign object:
// its arguments name a foreign device, zone, plot or account.
function foreignEffect(detail) {
  const text = String(detail || '').toUpperCase();
  return FOREIGN_IDS.find((id) => text.includes(id.toUpperCase())) || null;
}

function foreignMarkers(table, row) {
  const marks = [];
  for (const [column, value] of Object.entries(row)) {
    if (/_json$/.test(column) && typeof value === 'string') {
      try { markJson(JSON.parse(value), marks); } catch (_) { /* not JSON */ }
    } else {
      markValue(column, value, marks);
    }
  }
  if (table === 'irrigation_schedules' && Number(row.id) === FOREIGN_SCHEDULE_ID) marks.push('the foreign schedule');
  if (table === 'irrigation_zones' && Number(row.id) === FOREIGN_ZONE_ID) marks.push('the foreign zone');
  if (table === 'users' && Number(row.id) === 1) marks.push('the admin account');
  return marks;
}

// Rows of every table, keyed by their JSON form (with a count), so the
// difference before/after a run lists inserted and deleted row versions; an
// update shows as one of each.
function snapshotDatabase(db) {
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
  ).all().map((row) => row.name);
  const snapshot = new Map();
  for (const table of tables) {
    const rows = new Map();
    for (const row of db.prepare(`SELECT * FROM "${table}"`).all()) {
      const key = JSON.stringify(row, (_k, v) => (typeof v === 'bigint' ? String(v) : v));
      rows.set(key, (rows.get(key) || 0) + 1);
    }
    snapshot.set(table, rows);
  }
  return snapshot;
}

function diffSnapshots(before, after) {
  const changes = [];
  const tables = new Set([...before.keys(), ...after.keys()]);
  for (const table of tables) {
    const old = before.get(table) || new Map();
    const next = after.get(table) || new Map();
    for (const [key, count] of old) {
      for (let i = 0; i < count - (next.get(key) || 0); i += 1) changes.push({ table, op: 'removed', row: JSON.parse(key) });
    }
    for (const [key, count] of next) {
      for (let i = 0; i < count - (old.get(key) || 0); i += 1) changes.push({ table, op: 'added', row: JSON.parse(key) });
    }
  }
  return changes;
}

// Building the database from seed-blank.sql takes ~30 ms; a probe run needs a
// fresh one each time. The seeded fixture is built once per process into a
// template file in a private temporary directory, and each probe opens its own
// copy, removed again when the probe ends.
let templateDir = null;
let templatePath = null;
let copyCount = 0;
function probeTemplate() {
  if (templatePath) return templatePath;
  templateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-scope-probe-'));
  templatePath = path.join(templateDir, 'template.db');
  const db = new DatabaseSync(':memory:');
  try {
    seedProbeDatabase(db);
    db.exec(`VACUUM INTO '${templatePath.replace(/'/g, "''")}'`);
  } finally {
    db.close();
  }
  process.once('exit', () => {
    try { fs.rmSync(templateDir, { recursive: true, force: true }); } catch (_) { /* best effort */ }
  });
  return templatePath;
}

function createProbeDatabase() {
  const template = probeTemplate();
  const copy = path.join(templateDir, `probe-${++copyCount}.db`);
  fs.copyFileSync(template, copy);
  const db = new DatabaseSync(copy);
  db.exec('PRAGMA journal_mode = MEMORY; PRAGMA synchronous = OFF;');
  return {
    db,
    dispose() {
      try { db.close(); } catch (_) { /* already closed */ }
      try { fs.rmSync(copy, { force: true }); } catch (_) { /* best effort */ }
    },
  };
}

function makeAuthorization(userId, username) {
  const payload = Buffer.from(JSON.stringify({
    userId,
    username,
    exp: Date.now() + 10 * 60 * 1000,
  })).toString('base64url');
  const signature = crypto.createHmac('sha256', PROBE_SECRET).update(payload).digest('base64url');
  return `Bearer ${payload}.${signature}`;
}

// ---------------------------------------------------------------------------
// SQL classification

const WRITE_RE = /\b(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|REPLACE\s+INTO|UPDATE\s+(?:OR\s+\w+\s+)?["`[]?\w+["`\]]?\s+SET|DELETE\s+FROM|CREATE\s+(?:TEMP\w*\s+)?(?:TABLE|INDEX|VIEW|TRIGGER)|DROP\s+(?:TABLE|INDEX|VIEW|TRIGGER)|ALTER\s+TABLE)\b/i;
const CONTROL_RE = /^\s*(?:BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE)\b[\s\w]*;?\s*$/i;
const TABLE_RE = /\b(?:FROM|JOIN|INTO|UPDATE)\s+["`[]?([A-Za-z_]\w*)/gi;

function stripSqlComments(sql) {
  return String(sql || '').replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ');
}

const ENSURE_RE = /^\s*(?:CREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX|VIEW|TRIGGER)\s+IF\s+NOT\s+EXISTS\b|ALTER\s+TABLE\s+\w+\s+ADD\s+COLUMN\b)/i;

function classifySql(sql) {
  const text = stripSqlComments(sql);
  if (CONTROL_RE.test(text)) return { access: false, kind: 'control', tables: [] };
  // Schema upkeep (CREATE ... IF NOT EXISTS, ALTER TABLE ... ADD COLUMN, which
  // the handlers run and tolerate failing) touches no rows; some handlers run
  // it before they decide. Every statement in the text must be one.
  const statements = text.split(';').filter((part) => part.trim());
  if (statements.length && statements.every((part) => ENSURE_RE.test(part))) {
    return { access: false, kind: 'schema-ensure', tables: [] };
  }
  const tables = [...new Set([...text.matchAll(TABLE_RE)].map((m) => m[1].toLowerCase()))];
  if (WRITE_RE.test(text)) return { access: true, kind: 'write', tables };
  if (/^\s*PRAGMA\b/i.test(text)) return { access: true, kind: 'pragma', tables };
  if (tables.length && tables.every((t) => SCOPE_RESOLUTION_TABLES.has(t))) {
    return { access: false, kind: 'resolution-read', tables };
  }
  return { access: true, kind: 'read', tables };
}

function shortSql(sql) {
  const flat = stripSqlComments(sql).replace(/\s+/g, ' ').trim();
  return flat.length > 110 ? flat.slice(0, 107) + '...' : flat;
}

// ---------------------------------------------------------------------------
// Recording stand-ins. Each node execution gets its own recorder; every
// stand-in handed to that execution writes into it.

function normalizeDbArgs(args) {
  const [sql, paramsOrCallback, callback] = args;
  if (typeof paramsOrCallback === 'function') return { sql, params: [], callback: paramsOrCallback };
  let params = paramsOrCallback === undefined ? [] : paramsOrCallback;
  if (!Array.isArray(params) && (params === null || typeof params !== 'object')) params = [params];
  return { sql, params, callback };
}

function bindParams(params) {
  if (Array.isArray(params)) {
    return params.map((v) => (typeof v === 'boolean' ? Number(v) : v === undefined ? null : v));
  }
  return [params];
}

function makeRecordingDatabaseModule(sqlite, recorder) {
  function recordSql(sql, params) {
    const verdict = classifySql(sql);
    let detail = '';
    try { detail = JSON.stringify(params === undefined ? [] : params).slice(0, 2000); } catch (_) { detail = ''; }
    recorder.events.push({
      kind: 'sql',
      sql: shortSql(sql),
      access: verdict.access,
      sqlKind: verdict.kind,
      tables: verdict.tables,
      detail,
    });
  }
  function execute(method, sql, params) {
    recordSql(sql, params);
    const statement = sqlite.prepare(String(sql));
    const bound = bindParams(params);
    if (method === 'run') {
      const info = statement.run(...bound);
      return { rows: undefined, context: { changes: Number(info.changes), lastID: Number(info.lastInsertRowid) } };
    }
    return { rows: statement.all(...bound), context: {} };
  }
  function queued(method, args, mapper) {
    const { sql, params, callback } = normalizeDbArgs(args);
    let outcome;
    try {
      const { rows, context } = execute(method, sql, params);
      outcome = { ok: true, value: mapper(rows), context };
    } catch (error) {
      outcome = { ok: false, error };
    }
    if (typeof callback === 'function') {
      process.nextTick(() => {
        if (outcome.ok) callback.call(outcome.context, null, outcome.value);
        else callback.call(null, outcome.error);
      });
      return outcome.ok ? Promise.resolve(outcome.value) : Promise.resolve(undefined);
    }
    return outcome.ok ? Promise.resolve(outcome.value) : Promise.reject(outcome.error);
  }
  function scopeApi() {
    return {
      all: (...args) => queued('all', args, (rows) => rows || []),
      get: (...args) => queued('all', args, (rows) => (rows && rows[0]) || undefined),
      run: (...args) => queued('run', args, () => undefined),
      exec(sql, callback) {
        let error = null;
        try {
          recordSql(sql);
          sqlite.exec(String(sql));
        } catch (e) {
          error = e;
        }
        if (typeof callback === 'function') process.nextTick(() => callback(error));
        return error ? Promise.reject(error) : Promise.resolve();
      },
    };
  }
  class Database {
    constructor(filename, mode, callback) {
      const done = typeof mode === 'function' ? mode : callback;
      Object.assign(this, scopeApi());
      if (typeof done === 'function') process.nextTick(() => done.call(this, null));
    }
    async transaction(executor) {
      return executor(scopeApi());
    }
    async readSnapshot(executor) {
      return executor(scopeApi());
    }
    close(callback) {
      if (typeof callback === 'function') process.nextTick(() => callback(null));
      return Promise.resolve();
    }
    serialize(callback) {
      if (typeof callback === 'function') callback();
      return this;
    }
    parallelize(callback) {
      if (typeof callback === 'function') callback();
      return this;
    }
    configure() {
      return this;
    }
  }
  return {
    Database,
    open: (filename) => new Database(filename),
    approvedPath: (value) => String(value),
    OPEN_READONLY: 1,
    OPEN_READWRITE: 2,
    OPEN_CREATE: 4,
    verbose() { return this; },
    getHealth: () => ({}),
    async quickCheck() {
      recordSql('PRAGMA quick_check');
      return [{ quick_check: 'ok' }];
    },
  };
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  error.statusCode = status;
  return error;
}

// What a decision is about: the level the verifier reasons with, and for an
// object-level decision the object it names.
function decisionDetail(name, args) {
  switch (name) {
    case 'assertFreshZoneAccess': return { level: 'object', object: 'zone', target: args[2] };
    case 'assertFreshPlotAccess': return { level: 'object', object: 'plot', target: args[2] };
    case 'assertFreshDeviceAccess': return { level: 'object', object: 'device', target: args[2] };
    case 'assertRole':
    case 'assertFreshRole':
    case 'assertAuthenticatedRole':
      return { level: args[2] === 'admin' ? 'admin' : 'role', role: args[2] };
    case 'authorizeAdminRead':
    case 'isAdmin':
      return { level: 'admin' };
    case 'canMutate':
      return { level: 'mutate' };
    default:
      return { level: 'account' };
  }
}

// The scope an allowed decision hands back: an enabled researcher whose scope
// holds the fixture zone and plot.
function allowedScope(role) {
  return {
    role: role || 'researcher',
    username: 'probe-user',
    disabled: false,
    wildcard: false,
    zoneUuids: new Set([PROBE_ZONE_UUID]),
    plotUuids: new Set([PROBE_PLOT_UUID]),
  };
}

function allowedResult(name, args) {
  switch (name) {
    case 'isAdmin':
    case 'canMutate':
      return name === 'canMutate' ? true : Promise.resolve(true);
    case 'authorizeAdminRead':
      return Promise.resolve(allowedScope('admin'));
    case 'assertRole':
    case 'assertFreshRole':
    case 'assertAuthenticatedRole':
      return Promise.resolve(allowedScope(typeof args[2] === 'string' ? args[2] : 'researcher'));
    default:
      return Promise.resolve(allowedScope('researcher'));
  }
}

function deniedResult(name) {
  switch (DENIED_DECISIONS[name]) {
    case 'reject404': return Promise.reject(httpError(404, 'not found'));
    case 'reject403': return Promise.reject(httpError(403, 'forbidden by probe'));
    case 'resolveFalse': return Promise.resolve(false);
    case 'returnFalse': return false;
    default:
      return Promise.resolve({
        role: 'viewer',
        username: 'probe-user',
        disabled: true,
        wildcard: false,
        zoneUuids: new Set(),
        plotUuids: new Set(),
      });
  }
}

// Wraps the real helper. `policy(name)` numbers each decision in the order the
// chain makes it and says what to do with it:
// - 'deny': the decision says no (404/403 rejection, false, or a disabled scope);
// - 'allow': the decision says yes (an enabled researcher with the fixture zone
//   and plot in scope; canMutate and isAdmin answer true);
// - 'real': the real function runs against the probe database (investigations).
function makeProbeScopeHelper(realHelper, recorder, policy) {
  const wrapped = {};
  for (const [name, value] of Object.entries(realHelper)) {
    if (typeof value !== 'function' || !DENIED_DECISIONS[name]) {
      wrapped[name] = value;
      continue;
    }
    wrapped[name] = function probedDecision(...args) {
      const { index, action } = policy(name);
      recorder.events.push({ kind: 'decision', name, index, action, ...decisionDetail(name, args) });
      // A guard may fire a decision without awaiting it. Node-RED logs the
      // unhandled rejection and carries on, and so must the probe, so each
      // returned promise gets a no-op handler; a caller that awaits it still
      // sees the rejection.
      let result;
      if (action === 'real') result = value.apply(realHelper, args);
      else if (action === 'allow') result = allowedResult(name, args);
      else result = deniedResult(name);
      if (result && typeof result.catch === 'function') result.catch(() => {});
      return result;
    };
  }
  // A probe runs in scoped mode whatever the process environment says.
  wrapped.isScopedMode = () => true;
  return wrapped;
}

function makeEffectStub(label, recorder, kind = 'effect') {
  const target = function effectStub() {};
  return new Proxy(target, {
    get(_t, prop) {
      if (prop === 'then' || prop === Symbol.toPrimitive || prop === Symbol.iterator) return undefined;
      if (prop === 'toString') return () => `[probe ${label}]`;
      return makeEffectStub(`${label}.${String(prop)}`, recorder, kind);
    },
    apply(_t, _this, args) {
      let argsText = '';
      try {
        argsText = JSON.stringify(args.filter((arg) => typeof arg !== 'function')) || '';
      } catch (_) {
        argsText = '[unserialisable arguments]';
      }
      recorder.events.push({
        kind,
        what: `${label}(${argsText.slice(1, 61)})`,
        detail: argsText.slice(0, 2000),
      });
      const last = args.length ? args[args.length - 1] : undefined;
      if (typeof last === 'function') {
        setImmediate(() => {
          try { last(new Error(`probe: ${label} is not available`)); } catch (_) { /* caller's own bug */ }
        });
      }
      return makeEffectStub(`${label}()`, recorder, kind);
    },
    construct() {
      recorder.events.push({ kind, what: `new ${label}` });
      return makeEffectStub(`new ${label}`, recorder, kind);
    },
  });
}

function enoent(target) {
  const error = new Error(`ENOENT: no such file or directory (probe), '${target}'`);
  error.code = 'ENOENT';
  return error;
}

const FS_WRITE_PREFIXES = ['write', 'append', 'unlink', 'rm', 'rename', 'mkdir', 'copy', 'truncate', 'chmod', 'chown', 'symlink', 'link', 'utimes', 'createWrite', 'cp'];

function makeRecordingFs(recorder) {
  function method(name) {
    return function probeFs(...args) {
      const target = typeof args[0] === 'string' ? args[0] : String(args[0]);
      if (name === 'existsSync') return false;
      const isWrite = FS_WRITE_PREFIXES.some((prefix) => name.startsWith(prefix));
      if (!(AUTH_SECRET_PATHS.has(target) && !isWrite)) {
        recorder.events.push({ kind: isWrite ? 'effect' : 'file-read', what: `fs.${name}(${target})` });
      }
      const error = enoent(target);
      const last = args[args.length - 1];
      if (typeof last === 'function') {
        setImmediate(() => last(error));
        return undefined;
      }
      if (name.endsWith('Sync')) throw error;
      return Promise.reject(error);
    };
  }
  const promises = new Proxy({}, { get: (_t, prop) => method(String(prop)) });
  return new Proxy({}, {
    get(_t, prop) {
      if (prop === 'promises') return promises;
      if (prop === 'constants') return fs.constants;
      if (typeof prop !== 'string') return undefined;
      return method(prop);
    },
  });
}

function makeStore(initial) {
  const store = new Map(Object.entries(initial || {}));
  return {
    get(key) {
      if (Array.isArray(key)) return key.map((k) => store.get(k));
      return store.get(key);
    },
    set(key, value) {
      store.set(key, value);
    },
    keys() {
      return [...store.keys()];
    },
  };
}

// ---------------------------------------------------------------------------
// Module loading

function loadRealModule(modulesRoot, relative) {
  // eslint-disable-next-line global-require
  return require(path.join(modulesRoot, relative));
}

const registryCache = new Map();
function readOsiLibRegistry(modulesRoot) {
  if (!registryCache.has(modulesRoot)) registryCache.set(modulesRoot, parseOsiLibRegistry(modulesRoot));
  return registryCache.get(modulesRoot);
}

function parseOsiLibRegistry(modulesRoot) {
  const source = fs.readFileSync(path.join(modulesRoot, 'osi-lib/index.js'), 'utf8');
  const block = source.match(/const NAME_TO_PATH = \{([\s\S]*?)\n\};/);
  if (!block) throw new Error('scope-guard probe: cannot read the osi-lib module registry');
  const registry = {};
  for (const m of block[1].matchAll(/['"]([^'"]+)['"]\s*:\s*['"]([^'"]+)['"]/g)) registry[m[1]] = m[2];
  return registry;
}

// ---------------------------------------------------------------------------
// Request synthesis

const PARAM_DEFAULTS = {
  deveui: PROBE_DEVEUI,
  id: '1',
  zone_id: '1',
  zoneId: '1',
  gatewayEui: PROBE_GATEWAY_EUI,
  cardId: 'probe-card',
  uuid: '00000000-0000-4000-8000-0000000000a1',
  assignmentUuid: '00000000-0000-4000-8000-0000000000a2',
};

const ACTORS = {
  // The admin, for admin-only routes whose own inline check needs that role
  // before the write can be reached (used with every decision allowed only).
  admin: { userId: 1, username: 'probe-admin' },
  // An enabled researcher with no grants: what a scoped user who reaches for
  // something outside their scope looks like.
  researcher: { userId: 2, username: 'probe-user' },
  // A disabled account whose token has not expired yet.
  disabled: { userId: 3, username: 'probe-disabled' },
};

// writes(chunk) receives every chunk the handler streams to the caller.
function makeStreamStub(writes) {
  return {
    statusCode: 200,
    headersSent: false,
    setHeader() {},
    getHeader() { return undefined; },
    writeHead(status) { this.statusCode = status; this.headersSent = true; },
    write(chunk) { this.headersSent = true; writes(String(chunk).slice(0, 60)); return true; },
    end(chunk) { if (chunk !== undefined) writes(String(chunk).slice(0, 60)); this.headersSent = true; },
    destroy() {},
    on() { return this; },
    once() { return this; },
    emit() { return false; },
  };
}

// The 'truthy' variant: every query or body field the request does not set
// reads as set ('1' in the query, true in the body), so a guard that skips its
// decision when some flag is present takes that branch under the probe.
const TRUTHY_PASSTHROUGH = new Set(['then', 'toJSON', 'constructor', 'length', 'inspect', 'valueOf', 'toString']);
function truthyRecord(base, value) {
  return new Proxy(base, {
    get(target, prop) {
      if (typeof prop !== 'string' || prop in target || TRUTHY_PASSTHROUGH.has(prop)) return target[prop];
      return value;
    },
    // `'field' in body` reads as present too. Object.keys, spread and JSON
    // still see only the fields actually set.
    has(target, prop) {
      if (typeof prop !== 'string' || TRUTHY_PASSTHROUGH.has(prop)) return prop in target;
      return true;
    },
  });
}

function buildRequestMsg(entry, fixture = {}, actorName = 'researcher', streamWrites = () => {}, variant) {
  const actor = ACTORS[actorName] || ACTORS.researcher;
  const params = {};
  const url = String(entry.url || '');
  const filled = url.replace(/:([A-Za-z_]\w*)/g, (_m, name) => {
    const value = (fixture.params && fixture.params[name]) || PARAM_DEFAULTS[name] || `probe-${name}`;
    params[name] = value;
    return encodeURIComponent(value);
  });
  let body = fixture.body ? JSON.parse(JSON.stringify(fixture.body)) : {};
  let query = fixture.query ? { ...fixture.query } : {};
  const queryString = Object.keys(query).length
    ? '?' + new URLSearchParams(query).toString()
    : '';
  let payload = Array.isArray(fixture.body) ? JSON.parse(JSON.stringify(fixture.body)) : { ...body };
  let headers = {
    authorization: makeAuthorization(actor.userId, actor.username),
    'content-type': 'application/json',
    host: 'probe.local',
  };
  if (variant === 'truthy') {
    query = truthyRecord(query, '1');
    if (!Array.isArray(body)) body = truthyRecord(body, true);
    if (!Array.isArray(payload)) payload = truthyRecord(payload, true);
    headers = truthyRecord(headers, '1');
  } else if (variant && Object.prototype.hasOwnProperty.call(variant, 'fill')) {
    // Every unset query or body field names one foreign object.
    query = truthyRecord(query, String(variant.fill));
    if (!Array.isArray(body)) body = truthyRecord(body, variant.fill);
    if (!Array.isArray(payload)) payload = truthyRecord(payload, variant.fill);
  }
  return {
    _msgid: 'scope-guard-probe',
    req: {
      method: String(entry.method || 'get').toUpperCase(),
      url: filled + queryString,
      originalUrl: filled + queryString,
      path: filled,
      baseUrl: '',
      route: { path: url },
      params,
      query,
      body,
      headers,
      get(name) { return this.headers[String(name).toLowerCase()]; },
      ip: '127.0.0.1',
    },
    res: { _res: makeStreamStub(streamWrites) },
    payload,
  };
}

// ---------------------------------------------------------------------------
// Function-node execution

const RESERVED = ['msg', 'node', 'context', 'flow', 'global', 'env', 'RED', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'];

function makeEnv(extra) {
  const values = {
    OSI_SCOPED_ACCESS: '1',
    AUTH_TOKEN_SECRET: PROBE_SECRET,
    DEVICE_EUI: PROBE_GATEWAY_EUI,
    DEVICE_EUI_SOURCE: 'probe',
    DEVICE_EUI_CONFIDENCE: 'authoritative',
    // ChirpStack is a recording stand-in; configured names let the handlers
    // reach the downlink they queue there.
    CHIRPSTACK_APP_SENSORS: 'probe-app',
    CHIRPSTACK_APP_ACTUATORS: 'probe-app',
    CHIRPSTACK_APP_FIELD_TESTER: 'probe-app',
    CHIRPSTACK_PROFILE_KIWI: 'probe-profile',
    CHIRPSTACK_PROFILE_STREGA: 'probe-profile',
    CHIRPSTACK_PROFILE_STREGA_GEN2: 'probe-profile',
    CHIRPSTACK_PROFILE_LSN50: 'probe-profile',
    CHIRPSTACK_PROFILE_CLOVER: 'probe-profile',
    CHIRPSTACK_PROFILE_S2120: 'probe-profile',
    CHIRPSTACK_PROFILE_LORAIN: 'probe-profile',
    CHIRPSTACK_PROFILE_UC512: 'probe-profile',
    CHIRPSTACK_PROFILE_SDI12: 'probe-profile',
    CHIRPSTACK_PROFILE_RAK10701: 'probe-profile',
    ...extra,
  };
  return { get: (key) => (Object.prototype.hasOwnProperty.call(values, key) ? values[key] : '') };
}

function libValue(lib, ctx, recorder) {
  switch (lib.module) {
    case 'crypto': return crypto;
    case 'osi-lib': return ctx.makeOsiLib(recorder);
    case 'osi-db-helper': return makeRecordingDatabaseModule(ctx.sqlite, recorder);
    case 'bcryptjs': return loadRealModule(ctx.modulesRoot, 'node_modules/bcryptjs');
    case 'osi-history-helper': return loadRealModule(ctx.modulesRoot, 'osi-history-helper');
    case 'osi-history-router': return loadRealModule(ctx.modulesRoot, 'osi-history-router');
    case 'url': return require('node:url');
    default: return makeEffectStub(lib.var, recorder);
  }
}

async function runFunctionNode(node, msg, ctx) {
  const recorder = { events: [], sent: [] };
  // Chunks streamed to the caller are attributed to the node that runs.
  ctx.activeRecorder = recorder;
  const names = [...RESERVED];
  const values = [
    msg,
    {
      id: node.id,
      name: node.name || '',
      send(out) { recorder.sent.push(out); },
      done() {},
      error(message) { recorder.events.push({ kind: 'log', level: 'error', what: String(message && message.message || message) }); },
      warn() {},
      log() {},
      status() {},
      trace() {},
      debug() {},
    },
    ctx.context(node.id),
    ctx.flow,
    {
      get(key) {
        if (key === 'fs') return makeRecordingFs(recorder);
        if (key === 'cp') return makeEffectStub('cp', recorder);
        if (key === 'os') return os;
        return ctx.global.get(key);
      },
      set: (key, value) => ctx.global.set(key, value),
      keys: () => ctx.global.keys(),
    },
    ctx.env,
    makeEffectStub('RED', recorder),
    (fn, ms, ...args) => setTimeout(fn, Math.min(Number(ms) || 0, 1), ...args),
    clearTimeout,
    () => 0,
    () => {},
  ];
  for (const lib of node.libs || []) {
    if (!lib || typeof lib.var !== 'string' || names.includes(lib.var)) continue;
    names.push(lib.var);
    values.push(libValue(lib, ctx, recorder));
  }
  let fn;
  try {
    // eslint-disable-next-line no-new-func
    fn = new Function(...names, String(node.func || ''));
  } catch (error) {
    return { recorder, outputs: [], threw: error, unparseable: true };
  }
  let result;
  let threw = null;
  let timedOut = false;
  try {
    result = fn(...values);
    if (result && typeof result.then === 'function') {
      let timer;
      const timeout = new Promise((resolve) => {
        timer = setTimeout(() => { timedOut = true; resolve(undefined); }, NODE_TIMEOUT_MS);
      });
      try {
        result = await Promise.race([result, timeout]);
      } finally {
        clearTimeout(timer);
      }
    }
  } catch (error) {
    threw = error;
  }
  // Let callbacks and short timers the node scheduled run, so late node.send
  // calls and effects are attributed to this node.
  await new Promise((resolve) => setTimeout(resolve, 4));
  const outputs = [];
  const collect = (value) => {
    if (value === undefined || value === null) return;
    const slots = Array.isArray(value) ? value : [value];
    slots.forEach((slot, port) => {
      if (slot === undefined || slot === null) return;
      for (const item of Array.isArray(slot) ? slot : [slot]) {
        if (item && typeof item === 'object') outputs.push({ port, msg: item });
      }
    });
  };
  if (!threw && !timedOut) collect(result);
  for (const sent of recorder.sent) collect(sent);
  return { recorder, outputs, threw, timedOut };
}

// ---------------------------------------------------------------------------
// Chain simulation

// Sorts a recorded event against the decisions made so far on its path.
// Returns null when the event is not an access worth judging, else
// { phase, write, what }:
// - phase 'before': no decision yet on the path. Any read outside the
//   resolution tables, any write and any effect counts.
// - phase 'between': decisions made and all allowed. Reads are fine (reads are
//   account-wide, W1); a write or an effect is recorded, and the verifier
//   counts it when a decision on the same run says no after it.
// - phase 'after': a decision on the path said no. Every statement counts,
//   resolution reads included, and every effect.
function classifyAccess(event, state) {
  let write;
  let resolution = false;
  if (event.kind === 'sql') {
    if (event.sqlKind === 'control' || event.sqlKind === 'schema-ensure') return null;
    resolution = event.sqlKind === 'resolution-read';
    write = event.sqlKind === 'write';
  } else if (event.kind === 'effect') {
    write = true;
  } else if (event.kind === 'file-read' || event.kind === 'stream') {
    write = false;
  } else {
    return null;
  }
  const what = describeEvent(event);
  const tables = event.tables || [];
  const detail = event.detail;
  if (state.denied) return { phase: 'after', write, what, tables, detail };
  if (resolution) return null;
  if (!state.decided) return { phase: 'before', write, what, tables, detail };
  return write ? { phase: 'between', write, what, tables, detail } : null;
}

function describeEvent(event) {
  if (event.kind === 'sql') return `${event.sqlKind} ${event.sql}`;
  return event.what;
}

// Returns a trace:
// {
//   steps: [{ node, type, events, threw, timedOut }],
//   decisions: [{ node, seq, index, name, action, level, object, target, role }],
//   accesses: [{ node, seq, phase, write, what, tables }],   see classifyAccess
//   responses: [{ node, seq, status, decided, denied, payload }],
//   unanalysable: [reason],
//   streamed: true when the handler streamed an answer to the caller,
// }
// seq orders every decision, access and answer of the run.
// options: modulesRoot (required), byId, terminalLinkIns, fixture
// ({ params, query, body, env, flow, setupSql, radioStore }), actor
// ('researcher' | 'disabled'), denyAt (1 = deny every decision, k = allow the
// first k-1, Infinity = allow all), denyOnly (deny decision k alone),
// decisions ('real': the real helper decides against the probe database),
// variant ('truthy': unknown query, body and header fields read as set;
// { fill: value }: unknown query and body fields read as that value),
// params / body (override the fixture's), snapshot (record trace.changes:
// every row version added or removed in the probe database).
async function probeEntry(flows, entry, options = {}) {
  const modulesRoot = options.modulesRoot;
  const byId = options.byId || new Map(flows.map((n) => [n.id, n]));
  const terminalLinkIns = options.terminalLinkIns || new Set();
  const baseFixture = options.fixture || {};
  const fixture = {
    ...baseFixture,
    params: { ...(baseFixture.params || {}), ...(options.params || {}) },
    ...(options.body !== undefined ? { body: options.body } : {}),
  };
  const probeDb = createProbeDatabase();
  const sqlite = probeDb.db;
  if (fixture.setupSql) sqlite.exec(fixture.setupSql);
  const before = options.snapshot ? snapshotDatabase(sqlite) : null;
  // Decisions are numbered in the order the chain makes them. denyOnly = k
  // denies decision k and allows every other one; without it, denyAt = k
  // allows decisions 1..k-1 and denies the rest (default 1: deny all;
  // Infinity: allow all). decisions: 'real' runs them for real.
  const denyAt = options.denyAt === undefined ? 1 : options.denyAt;
  let decisionCount = 0;
  const policy = () => {
    decisionCount += 1;
    if (options.decisions === 'real') return { index: decisionCount, action: 'real' };
    if (options.denyOnly !== undefined) {
      return { index: decisionCount, action: decisionCount === options.denyOnly ? 'deny' : 'allow' };
    }
    return { index: decisionCount, action: decisionCount < denyAt ? 'allow' : 'deny' };
  };
  const registry = readOsiLibRegistry(modulesRoot);
  const realScope = loadRealModule(modulesRoot, registry.scope || 'osi-scope-helper');
  // Real decisions read the scope helper's own flag and cache: scoped mode on,
  // cache empty, for this probe only.
  const savedScopedEnv = process.env.OSI_SCOPED_ACCESS;
  if (options.decisions === 'real') {
    process.env.OSI_SCOPED_ACCESS = '1';
    if (typeof realScope._resetForTests === 'function') realScope._resetForTests();
  }
  const unclassified = Object.keys(realScope).filter((name) =>
    typeof realScope[name] === 'function' && !DENIED_DECISIONS[name] && !HELPER_NON_DECISIONS.has(name));
  const contexts = new Map();
  const ctx = {
    modulesRoot,
    sqlite,
    env: makeEnv(fixture.env),
    flow: makeStore(fixture.flow),
    global: makeStore(),
    context(id) {
      if (!contexts.has(id)) contexts.set(id, makeStore());
      return contexts.get(id);
    },
    makeOsiLib(recorder) {
      return {
        require(name) {
          if (name === 'scope') {
            return { ok: true, value: makeProbeScopeHelper(realScope, recorder, policy) };
          }
          if (name === 'radio' && fixture.radioStore) {
            // The radio observation store is a second database on the gateway;
            // the probe serves it from the probe database, recorded like the rest.
            return {
              ok: true,
              value: { getSharedStore: async () => new (makeRecordingDatabaseModule(sqlite, recorder).Database)('/data/db/radio.db') },
            };
          }
          if (name === 'osi-db-helper') return { ok: true, value: makeRecordingDatabaseModule(sqlite, recorder) };
          const relative = registry[name];
          if (!relative) return { ok: false, error: 'unknown osi-lib module: ' + name };
          try {
            return { ok: true, value: loadRealModule(modulesRoot, relative) };
          } catch (error) {
            return { ok: false, error: `probe could not load ${name}: ${error.message}` };
          }
        },
      };
    },
  };

  const trace = { steps: [], decisions: [], accesses: [], responses: [], unanalysable: [] };
  if (unclassified.length) {
    trace.unanalysable.push(
      `the scope helper exports ${unclassified.join(', ')}, which the probe does not know as ` +
      'deciding or not; classify it in scripts/lib/scope-guard-probe.js'
    );
  }
  const actorName = options.actor || fixture.actor || 'researcher';
  const streamWrites = (chunk) => {
    trace.streamed = true;
    if (ctx.activeRecorder) ctx.activeRecorder.events.push({ kind: 'stream', what: `streams to the caller: ${chunk}` });
  };
  let seq = 0;
  const queue = [];
  for (const output of entry.wires || []) {
    for (const target of output) {
      queue.push({
        id: target,
        msg: buildRequestMsg(entry, fixture, actorName, streamWrites, options.variant),
        decided: false,
        denied: false,
      });
    }
  }
  if (!queue.length) trace.unanalysable.push('the entry is wired to nothing');
  const noteAccess = (nodeId, event, state) => {
    const access = classifyAccess(event, state);
    if (access) trace.accesses.push({ node: nodeId, seq: ++seq, ...access });
  };
  let steps = 0;
  try {
    while (queue.length) {
      const item = queue.shift();
      if (++steps > MAX_STEPS) {
        trace.unanalysable.push(`the chain runs more than ${MAX_STEPS} steps`);
        break;
      }
      const node = byId.get(item.id);
      if (!node) {
        trace.unanalysable.push(`wired to a missing node ${item.id}`);
        continue;
      }
      const forward = (port, msg, state) => {
        const targets = (node.wires || [])[port] || [];
        for (const target of targets) {
          queue.push({ id: target, msg: targets.length > 1 ? { ...msg } : msg, ...state });
        }
      };
      const passOn = { decided: item.decided, denied: item.denied };
      switch (node.type) {
        case 'function': {
          const run = await runFunctionNode(node, item.msg, ctx);
          const state = { decided: item.decided, denied: item.denied };
          trace.steps.push({ node: node.id, type: node.type, events: run.recorder.events, threw: run.threw, timedOut: run.timedOut });
          for (const event of run.recorder.events) {
            if (event.kind === 'decision') {
              state.decided = true;
              if (event.action === 'deny') state.denied = true;
              const { kind, ...detail } = event;
              void kind;
              trace.decisions.push({ node: node.id, seq: ++seq, ...detail });
            } else {
              noteAccess(node.id, event, state);
            }
          }
          if (run.unparseable) {
            trace.unanalysable.push(`function node ${node.id} does not parse: ${run.threw.message}`);
            break;
          }
          if (run.timedOut) {
            trace.unanalysable.push(`function node ${node.id} did not settle within ${NODE_TIMEOUT_MS} ms`);
          }
          if (run.threw) {
            if (run.threw instanceof ReferenceError) {
              trace.unanalysable.push(`function node ${node.id} uses something the probe does not provide: ${run.threw.message}`);
            } else if (!state.decided) {
              trace.unanalysable.push(`function node ${node.id} threw before any scope decision: ${run.threw.message}`);
            }
          }
          for (const { port, msg } of run.outputs) forward(port, msg, state);
          break;
        }
        case 'http response':
          trace.responses.push({
            node: node.id,
            seq: ++seq,
            status: Number(item.msg && item.msg.statusCode) || Number(node.statusCode) || 200,
            decided: item.decided,
            denied: item.denied,
            payload: item.msg ? item.msg.payload : undefined,
          });
          break;
        case 'debug':
        case 'comment':
          break;
        case 'switch': {
          // Node-RED switch on a msg property, with the rule types the flows use.
          if (node.propertyType && node.propertyType !== 'msg') {
            trace.unanalysable.push(`switch ${node.id} reads a ${node.propertyType} property`);
            break;
          }
          const value = String(node.property || '').split('.').reduce(
            (current, key) => (current === null || current === undefined ? undefined : current[key]), item.msg);
          let matched = false;
          let unknown = false;
          (node.rules || []).forEach((rule, port) => {
            if (matched && node.checkall !== 'true') return;
            let hit;
            switch (rule.t) {
              case 'null': hit = value === null || value === undefined; break;
              case 'nnull': hit = value !== null && value !== undefined; break;
              case 'true': hit = value === true; break;
              case 'false': hit = value === false; break;
              case 'eq': hit = String(value) === String(rule.v); break;
              case 'neq': hit = String(value) !== String(rule.v); break;
              case 'else': hit = !matched; break;
              default: unknown = true; hit = false;
            }
            if (hit) {
              matched = true;
              forward(port, item.msg, passOn);
            }
          });
          if (unknown) trace.unanalysable.push(`switch ${node.id} uses a rule type the probe does not simulate`);
          break;
        }
        case 'link out':
          if (node.mode && node.mode !== 'link') {
            trace.unanalysable.push(`link out ${node.id} in mode ${node.mode}`);
            break;
          }
          for (const target of node.links || []) queue.push({ id: target, msg: item.msg, ...passOn });
          break;
        case 'link in':
          if (terminalLinkIns.has(node.id)) break;
          forward(0, item.msg, passOn);
          break;
        case 'sqlite': {
          // node-red-node-sqlite: the statement comes from msg.topic unless the
          // node holds a fixed or prepared one; rows replace msg.payload.
          const sql = node.sqlquery === 'fixed' || node.sqlquery === 'prepared'
            ? node.sql
            : item.msg && item.msg.topic;
          const verdict = classifySql(sql);
          const event = { kind: 'sql', sql: shortSql(sql), access: verdict.access, sqlKind: verdict.kind, tables: verdict.tables };
          trace.steps.push({ node: node.id, type: node.type, events: [event] });
          noteAccess(node.id, event, passOn);
          if (passOn.denied) break;
          let rows;
          try {
            const params = node.sqlquery === 'prepared' ? (item.msg && item.msg.params) || {} : [];
            const statement = sqlite.prepare(String(sql));
            rows = Array.isArray(params) ? statement.all(...params) : statement.all(params);
          } catch (error) {
            trace.unanalysable.push(`sqlite node ${node.id} failed on the probe database: ${error.message}`);
            break;
          }
          item.msg.payload = rows;
          forward(0, item.msg, passOn);
          break;
        }
        case 'mqtt out':
        case 'http request':
        case 'exec':
        case 'file':
        case 'file in':
        case 'tcp out':
        case 'udp out':
        case 'websocket out':
          let detail = '';
          try {
            detail = JSON.stringify({ topic: item.msg && item.msg.topic, payload: item.msg && item.msg.payload }).slice(0, 2000);
          } catch (_) {
            detail = '';
          }
          noteAccess(node.id, { kind: 'effect', what: `${node.type} node`, detail }, passOn);
          break;
        default:
          trace.unanalysable.push(`reaches a ${node.type} node (${node.id}) the probe cannot simulate`);
      }
    }
  } finally {
    if (before) trace.changes = diffSnapshots(before, snapshotDatabase(sqlite));
    probeDb.dispose();
    if (options.decisions === 'real') {
      if (savedScopedEnv === undefined) delete process.env.OSI_SCOPED_ACCESS;
      else process.env.OSI_SCOPED_ACCESS = savedScopedEnv;
    }
  }
  return trace;
}

module.exports = {
  ACTORS,
  DENIED_DECISIONS,
  HELPER_NON_DECISIONS,
  PARAM_DEFAULTS,
  PROBE_DEVEUI,
  PROBE_GATEWAY_EUI,
  PROBE_PLOT_UUID,
  PROBE_ZONE_UUID,
  PROBE_ADMIN_UUID,
  PROBE_CALLER_UUID,
  PROBE_DISABLED_UUID,
  FOREIGN_DEVEUI,
  FOREIGN_ENTRY_UUID,
  FOREIGN_GROUP_UUID,
  FOREIGN_PLOT_UUID,
  FOREIGN_SCHEDULE_ID,
  FOREIGN_VALVE_DEVEUI,
  FOREIGN_ZONE_ID,
  FOREIGN_ZONE_UUID,
  WEATHER_DEVEUI,
  foreignEffect,
  foreignMarkers,
  SCOPE_RESOLUTION_TABLES,
  buildRequestMsg,
  classifySql,
  probeEntry,
};
