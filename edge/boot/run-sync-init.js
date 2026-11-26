#!/usr/bin/env node
'use strict';
// Standalone runner for the frozen Node-RED boot node "Sync Init Schema +
// Triggers" (sync-init-fn). The image runs it once at boot, before the Go
// backend starts, so the node's schema DDL and data repairs keep running
// unchanged without Node-RED. edge/boot/INVENTORY.md lists what the node does
// and how each Node-RED dependency is supplied here.
//
// What is executed, and how:
//   - the body from sync-init-fn.generated.json, checked against sync-init.pin
//     (both written and checked by gen-sync-init.js);
//   - wrapped in Node-RED 3.1's own function-node text and run in a vm
//     context with the sandbox names Node-RED provides (10-function.js);
//   - `osiDb` is the real osi-db-helper, loaded the way RED.import loads a
//     function-node lib (dynamic import of the user directory's copy);
//   - the helper's sqlite3 is the copy node-red-node-sqlite resolves, the one
//     Node-RED itself would hand the helper (osi-db-helper/sqlite-driver.js).
// The one runtime shim sits in that sqlite3 module: it opens OSI_BOOT_DB
// whenever the helper asks for /data/db/farming.db, refuses every other
// path, never creates a file, and observes (without changing) each statement
// result so the errors the body swallows still reach the log.
//
// Environment:
//   OSI_BOOT_DB            required: absolute path of an existing farm database
//   DEVICE_EUI             read by the body through env.get, as under Node-RED
//   OSI_BOOT_NODE_RED_DIR  Node-RED user directory holding node_modules/osi-db-helper
//                          (default /srv/node-red)
//   OSI_BOOT_SQLITE_NODE_DIR  node-red-node-sqlite package directory (default: the
//                          user directory's, else /usr/lib/node/node-red/node_modules/...)
//   OSI_BOOT_REPORT        optional: write a JSON report (statements, branches) here
//
// Exit status: 0 the node completed with no error; 1 the node reported an
// error or did not complete, a statement failed with a storage-class SQLite
// error (busy, locked, I/O, full, read-only, corrupt), or the node warned
// with a message this runner does not know as benign; 2 the runner could not
// start (pin mismatch, missing database, missing helper or driver).
const T0 = process.hrtime.bigint();
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const util = require('node:util');
const crypto = require('node:crypto');
const Module = require('node:module');
const { pathToFileURL } = require('node:url');

const IMAGE_DB_PATH = '/data/db/farming.db';
const TAG = '[sync-init-runner]';
const EXIT_OK = 0, EXIT_NODE_FAILED = 1, EXIT_SETUP = 2;

// One stream for every level keeps the lines in order in the boot log.
function log(level, message) {
  process.stderr.write(`${TAG} ${level} ${message}\n`);
}

class SetupError extends Error {}

// ---------- 1. the pinned body ----------
function loadPinnedBody(dir = __dirname) {
  const { readPin, sha256, EXPECTED_LIBS } = require('./gen-sync-init.js');
  const pin = readPin(path.join(dir, 'sync-init.pin'));
  const generated = JSON.parse(fs.readFileSync(path.join(dir, 'sync-init-fn.generated.json'), 'utf8'));
  const actual = sha256(generated.func || '');
  if (actual !== pin) throw new SetupError(`pinned body mismatch: sync-init-fn.generated.json body sha256 ${actual}, sync-init.pin ${pin}`);
  if (generated.sha256 !== pin) throw new SetupError(`generated file records sha256 ${generated.sha256}, pin ${pin}`);
  if (JSON.stringify(generated.libs) !== JSON.stringify(EXPECTED_LIBS)) throw new SetupError('generated libs differ: ' + JSON.stringify(generated.libs));
  return generated;
}

// ---------- 2. configuration ----------
function config(env = process.env) {
  const db = env.OSI_BOOT_DB;
  if (!db || !path.isAbsolute(db)) throw new SetupError('OSI_BOOT_DB must name the farm database by absolute path');
  let st;
  try { st = fs.statSync(db); } catch (e) { throw new SetupError(`OSI_BOOT_DB ${db}: ${e.code || e.message}`); }
  if (!st.isFile() || st.size === 0) throw new SetupError(`OSI_BOOT_DB ${db} is not a non-empty regular file`);
  const userDir = env.OSI_BOOT_NODE_RED_DIR || '/srv/node-red';
  const sqliteNodeCandidates = env.OSI_BOOT_SQLITE_NODE_DIR
    ? [env.OSI_BOOT_SQLITE_NODE_DIR]
    : [path.join(userDir, 'node_modules/node-red-node-sqlite'), '/usr/lib/node/node-red/node_modules/node-red-node-sqlite'];
  return { db, userDir, sqliteNodeCandidates, report: env.OSI_BOOT_REPORT || null };
}

// ---------- 3. the driver: Node-RED's sqlite3, relocated and observed ----------
const SQLITE_HARD = /^SQLITE_(BUSY|LOCKED|IOERR|FULL|READONLY|CORRUPT|NOTADB|CANTOPEN|NOMEM|PROTOCOL)/;
function classify(error) {
  const code = String(error && error.code || '');
  const message = String(error && error.message || error);
  if (SQLITE_HARD.test(code) || /database is locked|disk I\/O error|database or disk is full|readonly database|malformed|not a database|unable to open/i.test(message)) return 'hard';
  if (/duplicate column name/i.test(message)) return 'duplicate_column';
  if (/no such table/i.test(message)) return 'no_such_table';
  if (/already exists/i.test(message)) return 'already_exists';
  return 'other';
}

function makeDriver(sqlite3, target, observed) {
  const handles = new Set();
  const NativeDatabase = sqlite3.Database;
  const wrap = (method, sql, args) => {
    const index = args.length - 1;
    const callback = args[index];
    if (typeof callback !== 'function') return args;
    const entry = { seq: observed.length + 1, method, sql: String(sql) };
    observed.push(entry);
    const copy = args.slice();
    copy[index] = function observedCallback(error, ...values) {
      if (error) { entry.error = String(error.message || error); entry.code = error.code || null; entry.class = classify(error); }
      else if (method === 'run' && this && typeof this.changes === 'number') entry.changes = this.changes;
      return callback.call(this, error, ...values);
    };
    return copy;
  };
  class RelocatedDatabase extends NativeDatabase {
    constructor(filename, mode, callback) {
      if (filename !== IMAGE_DB_PATH) throw new Error(`boot runner: database path refused: ${filename}`);
      if (typeof mode === 'function') { callback = mode; mode = undefined; }
      const base = mode === undefined ? (sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE | sqlite3.OPEN_FULLMUTEX) : mode;
      // Never create the farm database: an empty file would let the body
      // "succeed" against nothing. config() already refused a missing file.
      super(target, base & ~sqlite3.OPEN_CREATE, callback);
      handles.add(this);
    }
    run(sql, ...args) { return super.run(sql, ...wrap('run', sql, args)); }
    all(sql, ...args) { return super.all(sql, ...wrap('all', sql, args)); }
    get(sql, ...args) { return super.get(sql, ...wrap('get', sql, args)); }
    exec(sql, ...args) { return super.exec(sql, ...wrap('exec', sql, args)); }
  }
  const driver = new Proxy(sqlite3, { get: (t, p) => (p === 'Database' ? RelocatedDatabase : t[p]) });
  return { driver, handles };
}

function resolveSqlite(candidates) {
  for (const dir of candidates) {
    const entry = path.join(dir, 'sqlite.js');
    if (fs.existsSync(entry)) {
      const req = Module.createRequire(entry);
      return { sqliteNode: fs.realpathSync(dir), modulePath: req.resolve('sqlite3'), sqlite3: req('sqlite3') };
    }
  }
  throw new SetupError('node-red-node-sqlite not found in ' + candidates.join(', ') + ' (set OSI_BOOT_SQLITE_NODE_DIR)');
}

// Distinct node_sqlite3.node files mapped into this process, or null when
// /proc/self/maps cannot be read.
function mappedAddons() {
  let text;
  try { text = fs.readFileSync('/proc/self/maps', 'utf8'); } catch { return null; }
  const files = new Set();
  for (const line of text.split('\n')) {
    const m = /\s(\/\S*\/node_sqlite3\.node)(?: \(deleted\))?$/.exec(line);
    if (m) files.add(m[1]);
  }
  return [...files];
}

// ---------- 4. the helper, loaded as RED.import loads a function-node lib ----------
async function importHelper(userDir) {
  let pkg;
  try { pkg = JSON.parse(fs.readFileSync(path.join(userDir, 'package.json'), 'utf8')); }
  catch (e) { throw new SetupError(`Node-RED user directory ${userDir}: package.json unreadable (${e.code || e.message})`); }
  // Node-RED refuses a lib its user-directory package.json does not list ("Module not allowed").
  if (!pkg.dependencies || !pkg.dependencies['osi-db-helper']) throw new SetupError(`${userDir}/package.json does not list osi-db-helper`);
  const moduleDir = path.join(userDir, 'node_modules', 'osi-db-helper');
  let modulePath;
  try { modulePath = Module.createRequire(moduleDir).resolve('osi-db-helper'); }
  catch (e) { throw new SetupError(`osi-db-helper not resolvable from ${moduleDir}: ${e.message}`); }
  const lib = await import(pathToFileURL(modulePath));
  return { lib: lib.default || lib, modulePath };
}

// ---------- 5. Node-RED's function-node wrapper and sandbox (3.1.15, 10-function.js) ----------
function functionText(func) {
  return 'var results = null;' +
    'results = (async function(msg,__send__,__done__){ ' +
      'var __msgid__ = msg._msgid;' +
      'var node = {' +
        'id:__node__.id,' +
        'name:__node__.name,' +
        'path:__node__.path,' +
        'outputCount:__node__.outputCount,' +
        'log:__node__.log,' +
        'error:__node__.error,' +
        'warn:__node__.warn,' +
        'debug:__node__.debug,' +
        'trace:__node__.trace,' +
        'on:__node__.on,' +
        'status:__node__.status,' +
        'send:function(msgs,cloneMsg){ __node__.send(__send__,__msgid__,msgs,cloneMsg);},' +
        'done:__done__' +
      '};\n' +
      func + '\n' +
    '})(msg,__send__,__done__);';
}

const fmt = (args) => args.map((a) => (typeof a === 'string' ? a : a instanceof Error ? a.message : util.inspect(a))).join(' ');

// Names the pinned body does not use fail loudly instead of pretending to be
// Node-RED's context store; the pin guarantees the body never reaches them.
function unavailable(name) {
  return () => { throw new Error(`boot runner: ${name} is not available outside Node-RED`); };
}

function makeSandbox(generated, lib, events) {
  const tab = generated.source.tab || {};
  const nodeInfo = { id: generated.node, name: generated.name, path: `${tab.id}/${generated.node}` };
  const say = (level) => function (...args) { const text = fmt(args); events.push({ level, text }); log(level.toUpperCase(), `[function:${nodeInfo.name}] ${text}`); };
  const timers = new Set(), intervals = new Set();
  const sandbox = {
    console, util, Buffer, Date,
    RED: { util: new Proxy({}, { get: (_, p) => unavailable('RED.util.' + String(p))() }) },
    __node__: {
      id: nodeInfo.id, name: nodeInfo.name, path: nodeInfo.path, outputCount: generated.outputs,
      log: say('info'), error: say('error'), warn: say('warn'), debug: say('debug'), trace: say('trace'),
      // The node has no downstream wires: Node-RED delivers a send to nobody.
      send: (send, id, msgs) => { events.push({ level: 'send', text: util.inspect(msgs) }); },
      on: (event) => { if (event === 'input') throw new Error('Cannot add input listener in function node'); unavailable('node.on(' + event + ')')(); },
      status: (status) => { events.push({ level: 'status', status }); log('INFO', `[function:${nodeInfo.name}] status ${JSON.stringify(status)}`); },
    },
    context: { set: unavailable('context.set'), get: unavailable('context.get'), keys: unavailable('context.keys') },
    flow: { set: unavailable('flow.set'), get: unavailable('flow.get'), keys: unavailable('flow.keys') },
    global: { set: unavailable('global.set'), get: unavailable('global.get'), keys: unavailable('global.keys') },
    env: {
      // RED.util.getSetting: node names, then flow and global-config env
      // (both empty; gen-sync-init.js checks), then process.env
      // (settings.js sets no envVarExcludes).
      get(name) {
        if (name === 'NR_NODE_NAME') return nodeInfo.name;
        if (name === 'NR_NODE_ID') return nodeInfo.id;
        if (name === 'NR_NODE_PATH') return nodeInfo.path;
        if (name === 'NR_FLOW_NAME') return tab.label;
        if (name === 'NR_FLOW_ID') return tab.id;
        return process.env[name];
      },
    },
    setTimeout(func, ...rest) {
      const id = setTimeout(() => { timers.delete(id); try { func(); } catch (err) { sandbox.__node__.error(err); } }, ...rest);
      timers.add(id); return id;
    },
    clearTimeout(id) { clearTimeout(id); timers.delete(id); },
    setInterval(func, ...rest) {
      const id = setInterval(() => { try { func(); } catch (err) { sandbox.__node__.error(err); } }, ...rest);
      intervals.add(id); return id;
    },
    clearInterval(id) { clearInterval(id); intervals.delete(id); },
  };
  sandbox.setTimeout[util.promisify.custom] = (after, value) => new Promise((resolve) => { sandbox.setTimeout(() => resolve(value), after); });
  sandbox.promisify = util.promisify;
  for (const { var: name } of generated.libs) {
    if (Object.prototype.hasOwnProperty.call(sandbox, name) || name === 'node') throw new SetupError('lib variable collides with a sandbox name: ' + name);
    sandbox[name] = lib;
  }
  return { sandbox, nodeInfo, timers, intervals };
}

// ---------- 6. run ----------
const BENIGN_WARN = [/^Self-healed FK refs for: /];
const COMPLETION = 'sync-init: schema init complete';

async function run(env = process.env) {
  const report = { node: 'sync-init-fn', started_at: new Date().toISOString(), node_version: process.versions.node };
  let cfg;
  const events = [], observed = [];
  let handles = new Set();
  try {
    const generated = loadPinnedBody();
    report.sha256 = generated.sha256;
    cfg = config(env);
    report.db = cfg.db;
    const sq = resolveSqlite(cfg.sqliteNodeCandidates);
    const relocated = makeDriver(sq.sqlite3, cfg.db, observed);
    handles = relocated.handles;
    // The helper's own require('sqlite3') (standalone mode in sqlite-driver.js)
    // receives the relocated driver; nothing else in this process loads sqlite3.
    const originalLoad = Module._load;
    let helperDir = null;
    Module._load = function (request, parent, isMain) {
      if (request === 'sqlite3' && helperDir && parent && parent.filename && parent.filename.startsWith(helperDir + path.sep)) return relocated.driver;
      if (request === 'sqlite3') throw new Error('boot runner: unexpected sqlite3 load from ' + (parent && parent.filename));
      return originalLoad.call(this, request, parent, isMain);
    };
    const helperPath = Module.createRequire(path.join(cfg.userDir, 'node_modules', 'osi-db-helper')).resolve('osi-db-helper');
    helperDir = path.dirname(fs.realpathSync(helperPath));
    const { lib, modulePath } = await importHelper(cfg.userDir);
    const version = await new Promise((resolve, reject) => {
      const probe = new sq.sqlite3.Database(':memory:', (e) => { if (e) return reject(e);
        probe.get('SELECT sqlite_version() AS v', (e2, row) => probe.close(() => (e2 ? reject(e2) : resolve(row.v)))); });
    });
    const addons = mappedAddons();
    Object.assign(report, { helper: modulePath, sqlite_node: sq.sqliteNode, sqlite3_module: sq.modulePath, sqlite_addons: addons, sqlite_version: version });
    log('INFO', `start node=${process.versions.node} sha256=${generated.sha256.slice(0, 16)} db=${cfg.db} helper=${modulePath} sqlite3=${sq.modulePath} addon=${addons ? addons.join(',') || 'none-mapped' : 'unobservable'} sqlite=${version} device_eui=${/^[0-9A-F]{16}$/.test(String(process.env.DEVICE_EUI || '').trim().toUpperCase()) ? 'set' : 'unset-or-invalid'}`);
    // As osi-db-helper/startup.js: count from /proc/self/maps; zero or an
    // unreadable map is "not observable", more than one is refused.
    if (addons && addons.length > 1) throw new SetupError('more than one native sqlite3 addon in this process: ' + addons.join(', '));

    const { sandbox, nodeInfo } = makeSandbox(generated, lib, events);
    const context = vm.createContext(sandbox);
    const script = new vm.Script(functionText(generated.func), { filename: `Function node:${nodeInfo.id} [${nodeInfo.name}]`, displayErrors: true });
    // The inject node's message: payload = timestamp (payloadType "date"), topic "".
    context.msg = { _msgid: crypto.randomBytes(8).toString('hex'), payload: Date.now(), topic: '' };
    context.__send__ = (msgs) => events.push({ level: 'send', text: util.inspect(msgs) });
    let doneError = null;
    context.__done__ = (err) => { if (err) doneError = err; };
    script.runInContext(context);
    let result;
    try { result = await context.results; }
    catch (err) { doneError = err; }
    if (doneError) {
      // Node-RED passes a rejection to done(err), which logs it as a node error.
      const text = 'function rejected: ' + (doneError.stack || doneError);
      events.push({ level: 'error', text });
      log('ERROR', text);
    }
    if (result != null) events.push({ level: 'send', text: util.inspect(result) });
  } catch (e) {
    if (e instanceof SetupError) { log('ERROR', 'setup: ' + e.message); report.setup_error = e.message; return finish(report, events, observed, handles, EXIT_SETUP); }
    log('ERROR', 'runner: ' + (e && e.stack || e));
    report.runner_error = String(e && e.stack || e);
    return finish(report, events, observed, handles, EXIT_NODE_FAILED);
  }
  return finish(report, events, observed, handles, null);
}

async function finish(report, events, observed, handles, forced) {
  // Close the native connection the helper keeps open (its facade close() is
  // a no-op): SQLite checkpoints the WAL when the last connection closes.
  for (const h of handles) {
    await new Promise((resolve) => h.close((e) => { if (e) { log('ERROR', 'close: ' + e.message); report.close_error = e.message; } resolve(); }));
  }
  const failed = observed.filter((s) => s.error);
  const byClass = {};
  for (const s of failed) byClass[s.class] = (byClass[s.class] || 0) + 1;
  for (const s of failed) {
    const head = s.sql.replace(/\s+/g, ' ').slice(0, 120);
    if (s.class === 'hard') log('ERROR', `statement #${s.seq} failed (${s.code || 'error'}): ${s.error} :: ${head}`);
    else if (s.class !== 'duplicate_column') log('WARN', `statement #${s.seq} failed (${s.class}): ${s.error} :: ${head}`);
  }
  const errors = events.filter((e) => e.level === 'error');
  const warns = events.filter((e) => e.level === 'warn');
  const unknownWarns = warns.filter((w) => !BENIGN_WARN.some((re) => re.test(w.text)));
  const completed = events.some((e) => e.level === 'info' && e.text === COMPLETION);
  let code = forced;
  const reasons = [];
  if (code === null) {
    if (errors.length) reasons.push(`${errors.length} node error(s)`);
    if (!completed) reasons.push('completion line missing');
    if (byClass.hard) reasons.push(`${byClass.hard} storage-class SQLite error(s)`);
    if (unknownWarns.length) reasons.push(`${unknownWarns.length} warning(s) not known as benign`);
    code = reasons.length ? EXIT_NODE_FAILED : EXIT_OK;
  }
  const wallMs = Number(process.hrtime.bigint() - T0) / 1e6;
  const maxRss = process.resourceUsage().maxRSS;
  Object.assign(report, {
    exit: code, reasons, completed, wall_ms: Math.round(wallMs), max_rss_kib: maxRss,
    statements: observed.length, failed_by_class: byClass,
    devices_rebuild: events.some((e) => e.level === 'status' && e.status && e.status.text === 'devices CHECK upgraded') ? 'upgraded'
      : events.some((e) => e.level === 'error' && /devices rebuild/.test(e.text)) ? 'aborted' : 'not needed',
    fk_self_heal: warns.some((w) => /^Self-healed FK refs/.test(w.text)) ? 'healed' : warns.some((w) => /^FK self-heal failed/.test(w.text)) ? 'failed' : 'not needed',
    events, observed,
  });
  if (report.db && process.env.OSI_BOOT_REPORT) {
    try { fs.writeFileSync(process.env.OSI_BOOT_REPORT, JSON.stringify(report, null, 1) + '\n'); }
    catch (e) { log('ERROR', 'report not written: ' + e.message); if (code === EXIT_OK) code = EXIT_NODE_FAILED; }
  }
  log(code === EXIT_OK ? 'INFO' : 'ERROR', `done exit=${code}${reasons.length ? ' (' + reasons.join('; ') + ')' : ''} statements=${observed.length} failed=${failed.length} ${JSON.stringify(byClass)} devices_rebuild=${report.devices_rebuild} fk_self_heal=${report.fk_self_heal} wall_ms=${Math.round(wallMs)} maxrss_kib=${maxRss}`);
  return code;
}

if (require.main === module) {
  process.on('unhandledRejection', (e) => { log('ERROR', 'unhandled rejection: ' + (e && e.stack || e)); process.exitCode = EXIT_NODE_FAILED; });
  run().then((code) => { if (!process.exitCode) process.exitCode = code; },
    (e) => { log('ERROR', 'runner crashed: ' + (e && e.stack || e)); process.exitCode = EXIT_NODE_FAILED; });
}
module.exports = { run, functionText, classify, IMAGE_DB_PATH };
