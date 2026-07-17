'use strict';

const sqlite3 = require('sqlite3');
const { AsyncLocalStorage } = require('node:async_hooks');

const DB_PATH = '/data/db/farming.db';
const PRAGMAS = [
  'PRAGMA journal_mode=WAL',
  'PRAGMA synchronous=NORMAL',
  'PRAGMA foreign_keys=ON',
  'PRAGMA busy_timeout=5000',
  'PRAGMA wal_autocheckpoint=1000'
];

let sharedDatabase = null;
let initPromise = null;
let operationQueue = Promise.resolve();
let activeDbPath = DB_PATH;
const health = {
  dbPath: DB_PATH,
  initializedAt: null,
  lastPragmaAt: null,
  lastError: null
};

// --- durableTransaction / enterFailStop shared state -----------------------
//
// durableWorkContext: an AsyncLocalStorage whose store is set only while a
// durableTransaction() work callback is executing, so a nested
// durableTransaction()/transaction() call made from inside that callback can
// be rejected immediately instead of deadlocking the serialized operation
// queue (the nested call would otherwise wait forever on a queue slot that
// can't free up until the outer work itself resolves). Async-context based,
// so an unrelated caller invoking transaction() concurrently from outside
// the work callback is NOT affected.
//
// synchronousPoison: set when durableTransaction fails to restore the saved
// PRAGMA synchronous mode after COMMIT/ROLLBACK. While set, every new queued
// operation attempts the restore again (using the saved mode) before doing
// its own work; a successful attempt clears it, a repeat failure keeps the
// facade rejecting new work with a bounded error naming the cause.
//
// failStopState / failStopRetainedDatabases: set once by enterFailStop() and
// never cleared for the remaining lifetime of the process. Every dedicated
// database ever handed to enterFailStop is added to
// failStopRetainedDatabases, a strong reference that keeps it reachable (and
// therefore un-garbage-collected, keeping its native handle and any
// uncommitted transaction open) even after the caller drops its own
// reference.
const durableWorkContext = new AsyncLocalStorage();
let synchronousPoison = null;
let failStopState = null;
const failStopRetainedDatabases = new Set();

const SYNCHRONOUS_MODE_NAMES = ['OFF', 'NORMAL', 'FULL', 'EXTRA'];

function boundedString(value, maxLength) {
  const limit = typeof maxLength === 'number' ? maxLength : 500;
  const text = value === undefined || value === null ? '' : String(value);
  return text.length > limit ? `${text.slice(0, limit)}…(truncated)` : text;
}

function facadeFailStopGuardOrNull() {
  if (!failStopState) return null;
  const error = new Error(
    `osi-db-helper: fail-stop active (${failStopState.name}): ${failStopState.reason}`
  );
  error.code = 'OSI_DB_FAIL_STOP';
  error.failStopName = failStopState.name;
  error.failStopReason = failStopState.reason;
  return error;
}

// Any shared-facade call made from inside a durableTransaction work callback
// would wait on the queue slot the durable transaction itself holds — a
// silent permanent deadlock of the whole facade. Reject it up front; work
// must use the tx scope it was handed.
function durableWorkGuardOrNull() {
  if (!durableWorkContext.getStore()) return null;
  const error = new Error(
    'osi-db-helper: shared-facade call inside durableTransaction work is not allowed; use the tx scope passed to work'
  );
  error.code = 'OSI_DB_CALL_INSIDE_DURABLE_WORK';
  return error;
}

function buildSynchronousPoisonError() {
  const error = new Error(
    'osi-db-helper: durableTransaction failed to restore synchronous mode ' +
    `(${synchronousPoison.cause}); facade rejects new work until restoration succeeds`
  );
  error.code = 'OSI_DB_SYNCHRONOUS_POISONED';
  return error;
}

// Attempts to restore the previously-saved PRAGMA synchronous mode when the
// facade is poisoned. Returns null (and clears the poison) on success, or a
// bounded error to reject the caller's operation with on failure. A no-op
// (returns null) when the facade isn't poisoned.
async function attemptSynchronousPoisonRecovery(database) {
  if (!synchronousPoison) return null;
  const mode = synchronousPoison.mode;
  try {
    await runRaw(database, 'exec', `PRAGMA synchronous=${SYNCHRONOUS_MODE_NAMES[mode]};`);
    synchronousPoison = null;
    return null;
  } catch (restoreError) {
    synchronousPoison = {
      mode,
      cause: boundedString((restoreError && restoreError.message) || restoreError),
      at: new Date().toISOString()
    };
    return buildSynchronousPoisonError();
  }
}

async function readSynchronousMode(database) {
  const { rows } = await runRaw(database, 'all', 'PRAGMA synchronous');
  const raw = rows && rows[0] ? rows[0].synchronous : undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || !SYNCHRONOUS_MODE_NAMES[value]) {
    throw new Error(
      `osi-db-helper: unable to validate current synchronous mode (got ${JSON.stringify(raw)})`
    );
  }
  return value;
}

// The durableTransaction executor: runs entirely inside one enqueueOperation
// slot (serialized with every other facade operation). Reads/validates the
// current synchronous mode, elevates to FULL, BEGIN IMMEDIATE, awaits work(),
// COMMIT on success / ROLLBACK on throw, then always attempts to restore the
// saved mode (success or failure of that restore never changes work's
// resolution/rejection — it only ever affects future operations via
// synchronousPoison).
async function runDurableTransactionExecutor(database, work) {
  const originalMode = await readSynchronousMode(database);
  await runRaw(database, 'exec', 'PRAGMA synchronous=FULL;');

  try {
    await runRaw(database, 'exec', 'BEGIN IMMEDIATE;');
  } catch (beginError) {
    try {
      await runRaw(database, 'exec', `PRAGMA synchronous=${SYNCHRONOUS_MODE_NAMES[originalMode]};`);
      synchronousPoison = null;
    } catch (restoreError) {
      synchronousPoison = {
        mode: originalMode,
        cause: boundedString((restoreError && restoreError.message) || restoreError),
        at: new Date().toISOString()
      };
    }
    throw beginError;
  }

  let workError = null;
  let workResult;
  try {
    workResult = await durableWorkContext.run(
      { active: true },
      () => work(createTransactionScope(database))
    );
  } catch (error) {
    workError = error;
  }

  if (workError) {
    try {
      await runRaw(database, 'exec', 'ROLLBACK;');
    } catch (rollbackError) {
      if (workError && typeof workError === 'object') {
        workError.rollbackError = rollbackError;
      }
    }
  } else {
    try {
      await runRaw(database, 'exec', 'COMMIT;');
    } catch (commitError) {
      workError = commitError;
      try {
        await runRaw(database, 'exec', 'ROLLBACK;');
      } catch (rollbackError) {
        if (commitError && typeof commitError === 'object') {
          commitError.rollbackError = rollbackError;
        }
      }
    }
  }

  try {
    await runRaw(database, 'exec', `PRAGMA synchronous=${SYNCHRONOUS_MODE_NAMES[originalMode]};`);
    synchronousPoison = null;
  } catch (restoreError) {
    synchronousPoison = {
      mode: originalMode,
      cause: boundedString((restoreError && restoreError.message) || restoreError),
      at: new Date().toISOString()
    };
  }

  if (workError) throw workError;
  return workResult;
}

function setLastError(error) {
  health.lastError = error
    ? {
        at: new Date().toISOString(),
        message: String(error.message || error)
      }
    : null;
}

function markHealthy() {
  setLastError(null);
}

function runRaw(database, method, sql, params) {
  return new Promise((resolve, reject) => {
    const callback = function callback(error, rows) {
      if (error) {
        reject(error);
        return;
      }
      resolve({ rows, statement: this });
    };
    if (params === undefined) {
      database[method](sql, callback);
      return;
    }
    database[method](sql, params, callback);
  });
}

function openDatabase(filename, mode) {
  return new Promise((resolve, reject) => {
    const callback = (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(database);
    };
    const database = mode == null
      ? new sqlite3.Database(filename, callback)
      : new sqlite3.Database(filename, mode, callback);
  });
}

function closeDatabase(database) {
  return new Promise((resolve, reject) => {
    database.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function createTransactionScope(database) {
  return {
    run(sql, params) {
      return runRaw(database, 'run', sql, params).then(() => undefined);
    },
    all(sql, params) {
      return runRaw(database, 'all', sql, params).then(({ rows }) => rows || []);
    },
    get(sql, params) {
      return runRaw(database, 'all', sql, params).then(({ rows }) => (rows && rows[0]) || undefined);
    },
    exec(sql) {
      return runRaw(database, 'exec', sql).then(() => undefined);
    }
  };
}

function ensureSharedDatabase(filename) {
  if (initPromise) {
    return initPromise;
  }
  if (sharedDatabase) {
    return Promise.resolve(sharedDatabase);
  }
  activeDbPath = typeof filename === 'string' && filename.trim() ? filename : activeDbPath;
  initPromise = (async () => {
    try {
      sharedDatabase = await openDatabase(activeDbPath);
      for (const pragma of PRAGMAS) {
        await runRaw(sharedDatabase, 'all', pragma);
      }
      const journal = await runRaw(sharedDatabase, 'all', 'PRAGMA journal_mode');
      const synchronous = await runRaw(sharedDatabase, 'all', 'PRAGMA synchronous');
      health.initializedAt = new Date().toISOString();
      health.lastPragmaAt = health.initializedAt;
      health.dbPath = activeDbPath;
      health.journalMode = journal.rows && journal.rows[0] ? journal.rows[0].journal_mode || null : null;
      health.synchronous = synchronous.rows && synchronous.rows[0] ? synchronous.rows[0].synchronous ?? null : null;
      setLastError(null);
      return sharedDatabase;
    } catch (error) {
      sharedDatabase = null;
      initPromise = null;
      setLastError(error);
      throw error;
    }
  })();
  return initPromise;
}

function enqueueOperation(executor) {
  // Single choke point for queue admission: a call arriving from inside a
  // durableTransaction work callback can never be given a queue slot (the
  // slot is held by the durable transaction it came from — waiting would
  // deadlock the facade forever). Covers run/all/get/exec/quickCheck/
  // serialize; transaction() and durableTransaction() additionally reject at
  // entry with their more specific nested-call errors.
  const nestedGuard = durableWorkGuardOrNull();
  if (nestedGuard) return Promise.reject(nestedGuard);
  const scheduled = operationQueue
    .catch(() => undefined)
    .then(async () => {
      try {
        // Fail-stop is also re-checked here (not only at method entry) so an
        // operation that was already enqueued when enterFailStop() ran still
        // cannot produce a success side effect.
        const failStopGuard = facadeFailStopGuardOrNull();
        if (failStopGuard) throw failStopGuard;
        const database = await ensureSharedDatabase();
        const recoveryError = await attemptSynchronousPoisonRecovery(database);
        if (recoveryError) throw recoveryError;
        const result = await executor(database);
        markHealthy();
        return result;
      } catch (error) {
        setLastError(error);
        throw error;
      }
    });
  operationQueue = scheduled.then(
    () => undefined,
    () => undefined
  );
  return scheduled;
}

function normalizeArgs(args) {
  if (!args.length) return { sql: '', params: undefined, callback: undefined };
  const [sql, paramsOrCallback, callback] = args;
  if (typeof paramsOrCallback === 'function') {
    return { sql, params: undefined, callback: paramsOrCallback };
  }
  return { sql, params: paramsOrCallback, callback };
}

function invokeCallback(callback, context, error, result) {
  if (typeof callback !== 'function') return;
  process.nextTick(() => callback.call(context, error, result));
}

function runQueued(method, args, mapper) {
  const { sql, params, callback } = normalizeArgs(args);
  // Fail-stop rejects before enqueue: no SQL may reach the connection and no
  // queue slot is consumed once the process-lifetime write gate is active.
  const failStopGuard = facadeFailStopGuardOrNull();
  if (failStopGuard) {
    invokeCallback(callback, null, failStopGuard);
    if (typeof callback === 'function') return Promise.resolve(undefined);
    return Promise.reject(failStopGuard);
  }
  // await callers expect the mapped value (row for .get(), rows[] for .all(),
  // undefined for .run()) — the mapper has to run on the returned promise, not
  // only on the callback path.
  return enqueueOperation((database) => runRaw(database, method, sql, params))
    .then(({ rows, statement }) => {
      const mapped = mapper(rows);
      invokeCallback(callback, statement, null, mapped);
      return mapped;
    }, (error) => {
      invokeCallback(callback, null, error);
      if (typeof callback === 'function') return undefined;
      throw error;
    });
}

class DatabaseFacade {
  constructor(filename, mode, callback) {
    this.filename = filename || DB_PATH;
    this.mode = typeof mode === 'number' ? mode : undefined;
    const finalCallback =
      typeof mode === 'function' ? mode : typeof callback === 'function' ? callback : null;
    // Fail-stop poisons new facade construction too: report the gate error
    // and do not touch the shared connection at all.
    const failStopGuard = facadeFailStopGuardOrNull();
    if (failStopGuard) {
      invokeCallback(finalCallback, this, failStopGuard);
      return;
    }
    ensureSharedDatabase(this.filename).then(
      () => invokeCallback(finalCallback, this, null),
      (error) => invokeCallback(finalCallback, this, error)
    );
  }

  all(...args) {
    return runQueued('all', args, (rows) => rows || []);
  }

  get(...args) {
    return runQueued('all', args, (rows) => (rows && rows[0]) || undefined);
  }

  run(...args) {
    return runQueued('run', args, () => undefined);
  }

  transaction(executor) {
    if (typeof executor !== 'function') {
      throw new TypeError('Database.transaction requires an executor function');
    }
    const failStopGuard = facadeFailStopGuardOrNull();
    if (failStopGuard) return Promise.reject(failStopGuard);
    if (durableWorkContext.getStore()) {
      return Promise.reject(new Error(
        'osi-db-helper: nested transaction inside durableTransaction work is not allowed'
      ));
    }
    return enqueueOperation(async (database) => {
      await runRaw(database, 'exec', 'BEGIN IMMEDIATE;');
      const transaction = createTransactionScope(database);
      try {
        const result = await executor(transaction);
        await runRaw(database, 'exec', 'COMMIT;');
        return result;
      } catch (error) {
        try {
          await runRaw(database, 'exec', 'ROLLBACK;');
        } catch (rollbackError) {
          if (error && typeof error === 'object') {
            error.rollbackError = rollbackError;
          }
        }
        throw error;
      }
    });
  }

  // Serialized pre-external-effect intent barrier (stop-loss plan Task 3).
  // Takes one queue slot like every other facade operation; inside that slot
  // it validates/saves the current PRAGMA synchronous mode, elevates to FULL,
  // runs work(tx) inside BEGIN IMMEDIATE, commits or rolls back, then
  // restores the exact saved mode. A failed restore poisons the facade (see
  // synchronousPoison above). Resolves with work's return value; a rollback
  // rethrows work's original error.
  durableTransaction(work) {
    if (typeof work !== 'function') {
      throw new TypeError('Database.durableTransaction requires a work function');
    }
    const failStopGuard = facadeFailStopGuardOrNull();
    if (failStopGuard) return Promise.reject(failStopGuard);
    if (durableWorkContext.getStore()) {
      return Promise.reject(new Error(
        'osi-db-helper: nested durableTransaction inside durableTransaction work is not allowed'
      ));
    }
    return enqueueOperation((database) => runDurableTransactionExecutor(database, work));
  }

  async readSnapshot(executor) {
    if (typeof executor !== 'function') {
      throw new TypeError('Database.readSnapshot requires an executor function');
    }
    const failStopGuard = facadeFailStopGuardOrNull();
    if (failStopGuard) throw failStopGuard;
    if (synchronousPoison) throw buildSynchronousPoisonError();
    const nestedGuard = durableWorkGuardOrNull();
    if (nestedGuard) throw nestedGuard;
    const database = await openDatabase(this.filename, sqlite3.OPEN_READONLY);
    let began = false;
    let operationFailed = false;
    let failure;
    let result;
    try {
      await runRaw(database, 'all', 'PRAGMA query_only=ON');
      await runRaw(database, 'all', 'PRAGMA foreign_keys=ON');
      await runRaw(database, 'all', 'PRAGMA busy_timeout=5000');
      await runRaw(database, 'exec', 'BEGIN;');
      began = true;
      // Re-check after the open/PRAGMA/BEGIN awaits: a fail-stop entered
      // while this snapshot was setting up must still block the executor
      // (the entry check alone leaves a window). The throw lands in the
      // existing rollback/close cleanup below.
      const postOpenFailStopGuard = facadeFailStopGuardOrNull();
      if (postOpenFailStopGuard) throw postOpenFailStopGuard;
      result = await executor(createTransactionScope(database));
      await runRaw(database, 'exec', 'COMMIT;');
      began = false;
    } catch (error) {
      operationFailed = true;
      failure = error;
      if (began) {
        try {
          await runRaw(database, 'exec', 'ROLLBACK;');
        } catch (rollbackError) {
          if (failure &&
              (typeof failure === 'object' || typeof failure === 'function')) {
            failure.rollbackError = rollbackError;
          }
        }
      }
    }
    let closeError = null;
    try {
      await closeDatabase(database);
    } catch (error) {
      closeError = error;
      setLastError(error);
    }
    if (operationFailed) {
      if (closeError && failure &&
          (typeof failure === 'object' || typeof failure === 'function')) {
        failure.closeError = closeError;
      }
      throw failure;
    }
    if (closeError) throw closeError;
    return result;
  }

  exec(sql, callback) {
    const failStopGuard = facadeFailStopGuardOrNull();
    if (failStopGuard) {
      invokeCallback(callback, null, failStopGuard);
      const rejected = Promise.reject(failStopGuard);
      if (typeof callback === 'function') {
        // Mark handled for fire-and-forget callback callers while still
        // returning the rejection to await callers.
        rejected.catch(() => undefined);
      }
      return rejected;
    }
    const scheduled = enqueueOperation(
      (database) =>
        new Promise((resolve, reject) => {
          database.exec(sql, function onExec(error) {
            if (error) {
              reject(error);
              return;
            }
            resolve({ statement: this });
          });
        })
    );
    scheduled.then(
      ({ statement }) => invokeCallback(callback, statement, null),
      (error) => invokeCallback(callback, null, error)
    );
    return scheduled;
  }

  close(callback) {
    invokeCallback(callback, this, null);
  }

  serialize(callback) {
    if (typeof callback !== 'function') return this;
    enqueueOperation(async () => {
      callback();
    }).catch(() => undefined);
    return this;
  }

  parallelize(callback) {
    if (typeof callback === 'function') {
      callback();
    }
    return this;
  }

  configure() {
    return this;
  }
}

// A fully separate sqlite3 connection with its own serialized operation
// queue — never the module-global shared connection, and deliberately NOT
// poisoned by enterFailStop (the fail-stop caller must keep using its
// dedicated connection, e.g. to hold an uncommitted EXCLUSIVE transaction
// open). No auto-transaction helpers: the caller drives BEGIN
// EXCLUSIVE/COMMIT/ROLLBACK manually through run(), and nothing here ever
// issues a COMMIT/ROLLBACK on its own.
class DedicatedDatabase {
  constructor(filename) {
    this._filename = filename;
    this._queue = Promise.resolve();
    this._dbPromise = null;
    this._closed = false;
  }

  _ensure() {
    if (this._closed) {
      return Promise.reject(new Error('osi-db-helper: dedicated database is closed'));
    }
    if (!this._dbPromise) {
      this._dbPromise = openDatabase(this._filename).then(async (database) => {
        // Connection-local lock patience only; journal/synchronous modes are
        // deliberately left untouched — callers own transaction semantics.
        await runRaw(database, 'all', 'PRAGMA busy_timeout=5000');
        return database;
      });
    }
    return this._dbPromise;
  }

  _enqueue(executor) {
    const scheduled = this._queue
      .catch(() => undefined)
      .then(async () => {
        if (this._closed) {
          throw new Error('osi-db-helper: dedicated database is closed');
        }
        const database = await this._ensure();
        return executor(database);
      });
    this._queue = scheduled.then(
      () => undefined,
      () => undefined
    );
    return scheduled;
  }

  run(sql, params) {
    return this._enqueue((database) => runRaw(database, 'run', sql, params).then(() => undefined));
  }

  all(sql, params) {
    return this._enqueue((database) => runRaw(database, 'all', sql, params).then(({ rows }) => rows || []));
  }

  get(sql, params) {
    return this._enqueue((database) =>
      runRaw(database, 'all', sql, params).then(({ rows }) => (rows && rows[0]) || undefined));
  }

  exec(sql) {
    return this._enqueue((database) => runRaw(database, 'exec', sql).then(() => undefined));
  }

  close() {
    return this._enqueue(async (database) => {
      this._closed = true;
      await closeDatabase(database);
    });
  }
}

function createDedicatedDatabase(filename) {
  if (typeof filename !== 'string' || !filename.trim()) {
    throw new TypeError('createDedicatedDatabase requires a database path');
  }
  return new DedicatedDatabase(filename);
}

// Process-lifetime write gate. Atomically poisons every new shared-facade
// operation and every new shared-facade construction (see the guards in
// runQueued/exec/transaction/durableTransaction/readSnapshot/enqueueOperation
// and the DatabaseFacade constructor), retains the caller's dedicated
// database in a module-level strong-reference set so it is never garbage
// collected — keeping its uncommitted EXCLUSIVE transaction open so other
// SQLite connections get SQLITE_BUSY until process exit — and returns a
// promise that never settles. It never commits, rolls back, or closes the
// dedicated connection. Idempotent-safe: a second call keeps the first
// poison identity and additionally retains the second handle.
function enterFailStop(name, dedicatedDb, reason) {
  if (dedicatedDb !== undefined && dedicatedDb !== null) {
    failStopRetainedDatabases.add(dedicatedDb);
  }
  if (!failStopState) {
    failStopState = {
      name: boundedString(name, 120),
      reason: boundedString(reason, 500),
      at: new Date().toISOString()
    };
    health.failStop = Object.assign({}, failStopState);
    setLastError(facadeFailStopGuardOrNull());
  }
  return new Promise(() => {});
}

function getHealth() {
  return Object.assign({}, health);
}

async function quickCheck() {
  const result = await enqueueOperation((database) => runRaw(database, 'all', 'PRAGMA quick_check'));
  return result.rows || [];
}

module.exports = {
  Database: DatabaseFacade,
  OPEN_READONLY: sqlite3.OPEN_READONLY,
  OPEN_READWRITE: sqlite3.OPEN_READWRITE,
  OPEN_CREATE: sqlite3.OPEN_CREATE,
  verbose: () => module.exports,
  getHealth,
  quickCheck,
  createDedicatedDatabase,
  enterFailStop
};
