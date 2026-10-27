'use strict';

// Focused transport/reservation proof.  The contention workers each open the
// same SQLite file independently; they do not share osi-db-helper's cached
// connection.  This is intentionally separate from the production Node-RED
// facade, whose run() method resolves undefined.

const assert = require('node:assert/strict');
const child = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
const SEED = path.join(ROOT, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db');
const DISPATCH = path.join(ROOT, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-valve-control/dispatch');
const HELPERS = path.join(ROOT, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-valve-control/test-helpers');

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function command(id) {
  return {
    device_eui: '0016C001F1000001', command_id: id,
    action: 'OPEN_FOR_DURATION', duration_minutes: 5,
    commanded_at: '2026-10-17T10:00:00.000Z',
  };
}

async function worker(filename, role) {
  const { facade } = require(HELPERS);
  const raw = new DatabaseSync(filename);
  raw.exec('PRAGMA busy_timeout=1000');
  const db = facade(raw);
  const dispatch = require(DISPATCH);
  await sleep(role === 'first' ? 0 : 25);
  let result;
  let error;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      result = await db.transaction(async (tx) => {
        const outcome = await dispatch.reserveValveCommand({ db, tx, command: command('command-first'), now: '2026-10-17T10:00:00.000Z' });
        if (role === 'first') await sleep(180);
        return outcome;
      });
      break;
    } catch (caught) {
      if (!/busy|locked/i.test(String(caught && caught.message))) { error = caught; break; }
      await sleep(35);
    }
  }
  if (error) process.send({ ok: false, error: { code: error.code, message: error.message } });
  else process.send({ ok: true, result: { replayed: result.replayed, send: result.send, expectation_id: result.expectation && result.expectation.expectation_id } });
  raw.close();
}

async function main() {
  if (process.argv[2] === '--worker') {
    await worker(process.argv[3], process.argv[4]);
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conditional-transport-'));
  const filename = path.join(dir, 'farming.db');
  fs.copyFileSync(SEED, filename);
  const raw = new DatabaseSync(filename);
  raw.exec("INSERT INTO users(id, username, password_hash, created_at) VALUES (1,'transport-test','x',datetime('now'))");
  raw.exec("INSERT INTO devices(deveui, name, type_id, user_id, created_at, updated_at) VALUES ('0016C001F1000001','Valve A','STREGA_VALVE',1,datetime('now'),datetime('now'))");
  raw.close();

  const runWorker = (role) => new Promise((resolve, reject) => {
    const proc = child.fork(__filename, ['--worker', filename, role], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    proc.once('message', resolve);
    proc.once('error', reject);
    proc.once('exit', (code) => { if (code !== 0) reject(new Error(`${role} worker exited ${code}`)); });
  });
  const [first, second] = await Promise.all([runWorker('first'), runWorker('second')]);
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(first.result.send, true, JSON.stringify(first));
  assert.equal(second.result.send, false, JSON.stringify(second));
  assert.equal(second.result.replayed, true, JSON.stringify(second));
  assert.equal(first.result.expectation_id, second.result.expectation_id);

  // A different command is rejected after the first connection has committed.
  const { facade } = require(HELPERS);
  const checkRaw = new DatabaseSync(filename);
  const check = facade(checkRaw);
  await assert.rejects(require(DISPATCH).reserveValveCommand({ db: check, command: command('different-command'), now: '2026-10-17T10:00:01.000Z' }), (error) => error.code === 'valve_busy');
  checkRaw.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('OK (conditional irrigation transport: independent SQLite contention, stable replay, valve_busy)');
}

main().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
