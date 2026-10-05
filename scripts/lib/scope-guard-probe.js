'use strict';

// Scope-guard probe for scripts/verify-scoped-access.js.
//
// Drives one `http in` entry of a flows.json through the function nodes it is
// wired to, in scoped mode (OSI_SCOPED_ACCESS=1), with every decision function
// of the scope helper forced to say "no". It records, in order, which node made
// a scope decision and every read or write of data on the way. The verifier
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
// - recording stand-ins for the filesystem, child_process, network clients and
//   ChirpStack, so a probe never touches the host and every such call counts as
//   an effect;
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

function createProbeDatabase() {
  const db = new DatabaseSync(':memory:');
  db.exec(seedSql());
  db.exec(`
    INSERT INTO users (id, username, password_hash, created_at, user_uuid, role, sync_version)
    VALUES
      (1, 'probe-admin', 'x', '2026-01-01', 'u-probe-admin', 'admin', 1),
      (2, 'probe-user', 'x', '2026-01-01', 'u-probe-user', 'researcher', 1),
      (3, 'probe-disabled', 'x', '2026-01-01', 'u-probe-disabled', 'researcher', 1);
    UPDATE users SET disabled_at = '2026-01-02T00:00:00Z' WHERE id = 3;
    INSERT INTO installation_identity (
      singleton_id, installation_uuid, current_gateway_device_eui, created_at, updated_at
    ) VALUES (
      1, '00000000-0000-4000-8000-0000000000c1', '${PROBE_GATEWAY_EUI}', '2026-01-01', '2026-01-01'
    );
    INSERT INTO irrigation_zones (id, name, user_id, zone_uuid, timezone, scheduling_mode)
    VALUES (1, 'Probe zone', 1, 'z-probe', 'UTC', 'local');
    INSERT INTO devices (deveui, name, type_id, user_id, irrigation_zone_id, created_at, updated_at)
    VALUES ('${PROBE_DEVEUI}', 'Probe device', 'DRAGINO_LSN50', 1, 1, '2026-01-01', '2026-01-01');
  `);
  return db;
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

const ENSURE_RE = /^\s*CREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX|VIEW|TRIGGER)\s+IF\s+NOT\s+EXISTS\b/i;

function classifySql(sql) {
  const text = stripSqlComments(sql);
  if (CONTROL_RE.test(text)) return { access: false, kind: 'control', tables: [] };
  // Idempotent schema upkeep (CREATE ... IF NOT EXISTS) touches no rows; some
  // handlers run it before they decide. Every statement in the text must be one.
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
  function recordSql(sql) {
    const verdict = classifySql(sql);
    recorder.events.push({
      kind: 'sql',
      sql: shortSql(sql),
      access: verdict.access,
      sqlKind: verdict.kind,
      tables: verdict.tables,
    });
  }
  function execute(method, sql, params) {
    recordSql(sql);
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

// mode 'deny' (the verifier): every deciding function says no.
// mode 'real': deciding functions run for real against the probe database, so a
// probe shows what a given caller can actually do (used for investigations).
function makeDenyingScopeHelper(realHelper, recorder, mode = 'deny') {
  const wrapped = {};
  for (const [name, value] of Object.entries(realHelper)) {
    if (typeof value !== 'function') {
      wrapped[name] = value;
      continue;
    }
    if (!DENIED_DECISIONS[name]) {
      wrapped[name] = value;
      continue;
    }
    wrapped[name] = function deniedDecision(...args) {
      recorder.events.push({ kind: 'decision', name });
      // A guard may fire a decision without awaiting it. Node-RED logs the
      // unhandled rejection and carries on, and so must the probe, so each
      // returned promise gets a no-op handler; a caller that awaits it still
      // sees the rejection.
      const quiet = (promise) => {
        promise.catch(() => {});
        return promise;
      };
      if (mode === 'real') {
        const result = value.apply(realHelper, args);
        return result && typeof result.catch === 'function' ? quiet(result) : result;
      }
      switch (DENIED_DECISIONS[name]) {
        case 'reject404': return quiet(Promise.reject(httpError(404, 'not found')));
        case 'reject403': return quiet(Promise.reject(httpError(403, 'forbidden by probe')));
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
      recorder.events.push({ kind, what: `${label}(${args.length && typeof args[0] !== 'function' ? JSON.stringify(args[0]).slice(0, 60) : ''})` });
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
  // An enabled researcher with no grants: what a scoped user who reaches for
  // something outside their scope looks like.
  researcher: { userId: 2, username: 'probe-user' },
  // A disabled account whose token has not expired yet.
  disabled: { userId: 3, username: 'probe-disabled' },
};

function makeStreamStub(writes) {
  return {
    statusCode: 200,
    headersSent: false,
    setHeader() {},
    getHeader() { return undefined; },
    writeHead(status) { this.statusCode = status; this.headersSent = true; },
    write(chunk) { this.headersSent = true; writes.push(String(chunk).slice(0, 60)); return true; },
    end(chunk) { if (chunk !== undefined) writes.push(String(chunk).slice(0, 60)); this.headersSent = true; },
    destroy() {},
    on() { return this; },
    once() { return this; },
    emit() { return false; },
  };
}

function buildRequestMsg(entry, fixture = {}, actorName = 'researcher', streamWrites = []) {
  const actor = ACTORS[actorName] || ACTORS.researcher;
  const params = {};
  const url = String(entry.url || '');
  const filled = url.replace(/:([A-Za-z_]\w*)/g, (_m, name) => {
    const value = (fixture.params && fixture.params[name]) || PARAM_DEFAULTS[name] || `probe-${name}`;
    params[name] = value;
    return encodeURIComponent(value);
  });
  const body = fixture.body ? JSON.parse(JSON.stringify(fixture.body)) : {};
  const query = fixture.query ? { ...fixture.query } : {};
  const queryString = Object.keys(query).length
    ? '?' + new URLSearchParams(query).toString()
    : '';
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
      headers: {
        authorization: makeAuthorization(actor.userId, actor.username),
        'content-type': 'application/json',
        host: 'probe.local',
      },
      get(name) { return this.headers[String(name).toLowerCase()]; },
      ip: '127.0.0.1',
    },
    res: { _res: makeStreamStub(streamWrites) },
    payload: Array.isArray(fixture.body) ? JSON.parse(JSON.stringify(fixture.body)) : { ...body },
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
    (fn, ms, ...args) => setTimeout(fn, Math.min(Number(ms) || 0, 5), ...args),
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
  await new Promise((resolve) => setTimeout(resolve, 20));
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

function isAccessEvent(event) {
  if (event.kind === 'sql') return event.access;
  return event.kind === 'effect' || event.kind === 'file-read';
}

function describeEvent(event) {
  if (event.kind === 'sql') return `${event.sqlKind} ${event.sql}`;
  return event.what;
}

// Returns a trace:
// {
//   steps: [{ node, type, decidedOnEntry, events, threw, timedOut }],
//   decisions: [{ node, name }],             in path order
//   accesses: [{ node, before, what }],      before: no decision yet on that path
//   responses: [{ node, status, decided, payload }],
//   unanalysable: [reason],
// }
// options: modulesRoot (required), byId, terminalLinkIns, fixture
// ({ params, query, body, env, flow }), actor ('researcher' | 'disabled'),
// decisions ('deny' | 'real'). The before/after reading of accesses assumes
// 'deny'.
async function probeEntry(flows, entry, options = {}) {
  const modulesRoot = options.modulesRoot;
  const byId = options.byId || new Map(flows.map((n) => [n.id, n]));
  const terminalLinkIns = options.terminalLinkIns || new Set();
  const fixture = options.fixture || {};
  const sqlite = createProbeDatabase();
  const registry = readOsiLibRegistry(modulesRoot);
  const realScope = loadRealModule(modulesRoot, registry.scope || 'osi-scope-helper');
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
            return { ok: true, value: makeDenyingScopeHelper(realScope, recorder, options.decisions || 'deny') };
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
  const actorName = options.actor || 'researcher';
  const streamWrites = [];
  const queue = [];
  for (const output of entry.wires || []) {
    for (const target of output) {
      queue.push({ id: target, msg: buildRequestMsg(entry, fixture, actorName, streamWrites), decided: false });
    }
  }
  if (!queue.length) trace.unanalysable.push('the entry is wired to nothing');
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
      const forward = (port, msg, decided) => {
        const targets = (node.wires || [])[port] || [];
        for (const target of targets) {
          queue.push({ id: target, msg: targets.length > 1 ? { ...msg } : msg, decided });
        }
      };
      switch (node.type) {
        case 'function': {
          const run = await runFunctionNode(node, item.msg, ctx);
          let decided = item.decided;
          const step = { node: node.id, type: node.type, decidedOnEntry: item.decided, events: run.recorder.events, threw: run.threw, timedOut: run.timedOut };
          trace.steps.push(step);
          for (const event of run.recorder.events) {
            if (event.kind === 'decision') {
              decided = true;
              trace.decisions.push({ node: node.id, name: event.name });
            } else if (isAccessEvent(event)) {
              trace.accesses.push({ node: node.id, before: !decided, what: describeEvent(event) });
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
            } else if (!decided) {
              trace.unanalysable.push(`function node ${node.id} threw before any scope decision: ${run.threw.message}`);
            }
          }
          for (const { port, msg } of run.outputs) forward(port, msg, decided);
          break;
        }
        case 'http response':
          trace.responses.push({
            node: node.id,
            status: Number(item.msg && item.msg.statusCode) || Number(node.statusCode) || 200,
            decided: item.decided,
            payload: item.msg ? item.msg.payload : undefined,
          });
          break;
        case 'debug':
        case 'comment':
          break;
        case 'link out':
          if (node.mode && node.mode !== 'link') {
            trace.unanalysable.push(`link out ${node.id} in mode ${node.mode}`);
            break;
          }
          for (const target of node.links || []) queue.push({ id: target, msg: item.msg, decided: item.decided });
          break;
        case 'link in':
          if (terminalLinkIns.has(node.id)) break;
          forward(0, item.msg, item.decided);
          break;
        case 'sqlite': {
          // node-red-node-sqlite: the statement comes from msg.topic unless the
          // node holds a fixed or prepared one; rows replace msg.payload.
          const sql = node.sqlquery === 'fixed' || node.sqlquery === 'prepared'
            ? node.sql
            : item.msg && item.msg.topic;
          const verdict = classifySql(sql);
          const event = { kind: 'sql', sql: shortSql(sql), access: verdict.access, sqlKind: verdict.kind, tables: verdict.tables };
          trace.steps.push({ node: node.id, type: node.type, decidedOnEntry: item.decided, events: [event] });
          if (event.access) {
            trace.accesses.push({ node: node.id, before: !item.decided, what: describeEvent(event) });
            break;
          }
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
          forward(0, item.msg, item.decided);
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
          trace.accesses.push({ node: node.id, before: !item.decided, what: `${node.type} node` });
          break;
        default:
          trace.unanalysable.push(`reaches a ${node.type} node (${node.id}) the probe cannot simulate`);
      }
    }
  } finally {
    sqlite.close();
  }
  if (streamWrites.length) {
    trace.responses.push({
      node: 'streamed response',
      status: 200,
      decided: trace.decisions.length > 0,
      payload: streamWrites.join(''),
    });
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
  SCOPE_RESOLUTION_TABLES,
  buildRequestMsg,
  classifySql,
  probeEntry,
};
