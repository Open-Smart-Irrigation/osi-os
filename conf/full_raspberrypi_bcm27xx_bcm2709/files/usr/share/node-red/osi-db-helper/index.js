'use strict';

const sqlite3 = require('sqlite3');

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

function openDatabase(filename) {
  return new Promise((resolve, reject) => {
    const database = new sqlite3.Database(filename, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(database);
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
  const scheduled = operationQueue
    .catch(() => undefined)
    .then(async () => {
      try {
        const database = await ensureSharedDatabase();
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
  const scheduled = enqueueOperation((database) => runRaw(database, method, sql, params));
  scheduled.then(
    ({ rows, statement }) => invokeCallback(callback, statement, null, mapper(rows)),
    (error) => invokeCallback(callback, null, error)
  );
  return scheduled;
}

class DatabaseFacade {
  constructor(filename, mode, callback) {
    this.filename = filename || DB_PATH;
    this.mode = typeof mode === 'number' ? mode : undefined;
    const finalCallback =
      typeof mode === 'function' ? mode : typeof callback === 'function' ? callback : null;
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

  exec(sql, callback) {
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
  quickCheck
};
