'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const REPO = path.resolve(__dirname, '..', '..');
const DEFAULT_FLOWS = path.join(REPO, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json');

function scratchDir(prefix = 'soak-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function copyFixture(srcDbPath, destDir) {
  if (!fs.existsSync(srcDbPath)) throw new Error(`fixture does not exist: ${srcDbPath}`);
  const dbPath = path.join(destDir, path.basename(srcDbPath));
  fs.copyFileSync(srcDbPath, dbPath);
  return { dbPath, srcSha256: sha256(srcDbPath) };
}

function assertFixtureUnchanged(srcDbPath, srcSha256) {
  const now = sha256(srcDbPath);
  if (now !== srcSha256) {
    throw new Error(`source fixture changed during run (farm-data guard): ${srcDbPath}`);
  }
}

function funcText(nodeId, flowsPath = DEFAULT_FLOWS) {
  const node = JSON.parse(fs.readFileSync(flowsPath, 'utf8')).find((n) => n.id === nodeId);
  if (!node) throw new Error(`flows node not found: ${nodeId}`);
  if (typeof node.func !== 'string') throw new Error(`flows node ${nodeId} has no func body`);
  return node.func;
}

function makeFacadeShim(dbPath) {
  const db = new DatabaseSync(dbPath);
  const call = (kind) => (sql, cb) => {
    try {
      let r;
      const plain = (row) => row == null ? row : Object.assign({}, row);
      if (kind === 'run' || kind === 'exec') { db.exec(sql); r = undefined; }
      else if (kind === 'get') r = plain(db.prepare(sql).get());
      else r = db.prepare(sql).all().map(plain);
      if (typeof cb === 'function') { process.nextTick(() => cb(null, r)); return; }
      return Promise.resolve(r);
    } catch (e) {
      if (typeof cb === 'function') { process.nextTick(() => cb(e)); return; }
      return Promise.reject(e);
    }
  };
  const scope = { run: call('run'), all: call('all'), get: call('get'), exec: call('exec') };
  return Object.assign({}, scope, {
    async transaction(executor) {
      db.exec('BEGIN IMMEDIATE');
      try { const r = await executor(scope); db.exec('COMMIT'); return r; }
      catch (e) { try { db.exec('ROLLBACK'); } catch (_) {} throw e; }
    },
    close(cb) { try { db.close(); } catch (_) {} if (typeof cb === 'function') cb(); },
  });
}

function emitArtifact(dir, scenario, result) {
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, `${scenario}-${stamp}.json`);
  const doc = Object.assign({ scenario, timestamp: new Date().toISOString() }, result);
  fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
  return file;
}

module.exports = {
  REPO,
  DEFAULT_FLOWS,
  scratchDir,
  sha256,
  copyFixture,
  assertFixtureUnchanged,
  funcText,
  makeFacadeShim,
  emitArtifact,
};
