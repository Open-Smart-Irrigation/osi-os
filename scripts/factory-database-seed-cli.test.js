'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const factorySeed = require('./lib/factory-database-seed');

const cli = path.join(__dirname, 'factory-database-seed-cli.js');
const TEST_BOUNDARY = path.join('/tmp', `osi-factory-seed-tests-${process.getuid()}`);
const MOUNT_ADAPTER = path.join(TEST_BOUNDARY, 'factory-mountinfo.test');

test('factory CLI pins the OpenWrt node interpreter instead of env PATH lookup', () => {
  assert.equal(fs.readFileSync(cli, 'utf8').split('\n', 1)[0], '#!/usr/bin/node');
});

function writeDirectMountAdapter(majorMinor = '8:1', source = '/dev/test-factory') {
  fs.writeFileSync(MOUNT_ADAPTER,
    `36 25 ${majorMinor} / @DATA_ROOT@ rw,relatime - ext4 ${source} rw\n`, { mode: 0o600 });
  fs.chmodSync(MOUNT_ADAPTER, 0o600);
}

function writeOverlayMountAdapter(backingRoot, upperName = 'upper-a', workName = 'work-a') {
  fs.writeFileSync(MOUNT_ADAPTER,
    `36 25 0:42 / @DATA_ROOT@ rw,relatime - overlay overlay rw,lowerdir=/rom,upperdir=${backingRoot}/${upperName},workdir=${backingRoot}/${workName}\n`
    + `37 25 8:1 / ${backingRoot} rw,relatime - ext4 /dev/test-factory rw\n`, { mode: 0o600 });
  fs.chmodSync(MOUNT_ADAPTER, 0o600);
}

test.beforeEach(() => {
  fs.mkdirSync(TEST_BOUNDARY, { recursive: true, mode: 0o700 });
  fs.chmodSync(TEST_BOUNDARY, 0o700);
  process.env.OSI_REPAIR_PROGRAM_MODE = '1';
  process.env.OSI_DEPLOY_ARTIFACT_MODE = 'test';
  process.env.OSI_FACTORY_SEED_TEST_ROOT = TEST_BOUNDARY;
  process.env.OSI_FACTORY_SEED_TEST_MOUNTINFO = MOUNT_ADAPTER;
  writeDirectMountAdapter();
});

test.afterEach(() => {
  delete process.env.OSI_FACTORY_SEED_TEST_ROOT;
  delete process.env.OSI_DEPLOY_ARTIFACT_MODE;
  delete process.env.OSI_FACTORY_SEED_TEST_MOUNTINFO;
});

function scratch(prefix) {
  return fs.mkdtempSync(path.join(TEST_BOUNDARY, prefix));
}

function makeDb(file) {
  const r = cp.spawnSync('sqlite3', [file, 'CREATE TABLE t(id INTEGER PRIMARY KEY);'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
}
function run(args, extraEnv = {}) {
  return cp.spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...extraEnv },
  });
}

test('realize atomically seeds an absent SQLite set and writes one-use receipt plus lineage', () => {
  const d = scratch('factory-seed-');
  const seed = path.join(d, 'seed.db'); makeDb(seed);
  const target = path.join(d, 'data/db/farming.db');
  const receipt = path.join(d, 'receipts/base.factory-seed.json');
  const lineage = path.join(d, 'factory-database-lineage.json');
  const seedSha = crypto.createHash('sha256').update(fs.readFileSync(seed)).digest('hex');
  const result = run(['realize', '--factory-seed', seed, '--expected-seed-sha256', seedSha,
    '--database', target, '--operation-id', 'baseline-1', '--receipt-out', receipt,
    '--database-lineage-out', lineage]);
  assert.equal(result.status, 0, result.stderr);
  const out = JSON.parse(result.stdout);
  assert.match(out.databaseLineageSha256, /^[0-9a-f]{64}$/);
  assert.equal(fs.statSync(target).mode & 0o777, 0o600);
  assert.equal(fs.statSync(receipt).mode & 0o777, 0o600);
  assert.equal(fs.statSync(lineage).mode & 0o777, 0o600);
  assert.equal(JSON.parse(fs.readFileSync(receipt)).databasePath, target, 'receipt must name the database inode actually opened');
  assert.equal(JSON.parse(fs.readFileSync(lineage)).databasePath, target, 'lineage must cross-bind the same opened database path');
  assert.match(JSON.parse(fs.readFileSync(receipt)).dataMountIdentitySha256, /^[0-9a-f]{64}$/);
  assert.equal(JSON.parse(fs.readFileSync(receipt)).dataMountIdentitySha256,
    JSON.parse(fs.readFileSync(lineage)).dataMountIdentitySha256);
  assert.equal(run(['realize', '--factory-seed', seed, '--expected-seed-sha256', seedSha,
    '--database', target, '--operation-id', 'baseline-1', '--receipt-out', receipt,
    '--database-lineage-out', lineage]).status, 0, 'an exact completed operation must resume');
});

test('factory database rejects symlinked data ancestors and mount-identity drift', () => {
  const d = scratch('factory-seed-mount-authority-');
  const seed = path.join(d, 'seed.db'); makeDb(seed);
  const expectedSeedSha256 = crypto.createHash('sha256').update(fs.readFileSync(seed)).digest('hex');
  const realData = path.join(d, 'real-data');
  fs.mkdirSync(path.join(realData, 'db'), { recursive: true });
  fs.symlinkSync(realData, path.join(d, 'data'));
  const symlinkDatabase = path.join(d, 'data/db/farming.db');
  assert.throws(() => factorySeed.realize({ factorySeed: seed, expectedSeedSha256,
    database: symlinkDatabase, operationId: 'symlink-data', receiptOut: path.join(d, 'symlink-receipt.json'),
    databaseLineageOut: path.join(d, 'symlink-lineage.json') }), /symlink|ancestor|authority/i);

  fs.unlinkSync(path.join(d, 'data'));
  const database = path.join(d, 'data/db/farming.db');
  const receiptOut = path.join(d, 'receipt.json');
  const databaseLineageOut = path.join(d, 'lineage.json');
  factorySeed.realize({ factorySeed: seed, expectedSeedSha256, database,
    operationId: 'mount-bound', receiptOut, databaseLineageOut });
  fs.writeFileSync(MOUNT_ADAPTER,
    '36 25 8:2 / @DATA_ROOT@ rw,relatime - ext4 /dev/replaced-factory rw\n', { mode: 0o600 });
  fs.chmodSync(MOUNT_ADAPTER, 0o600);
  assert.throws(() => factorySeed.realize({ factorySeed: seed, expectedSeedSha256, database,
    operationId: 'mount-bound', receiptOut, databaseLineageOut }), /mount|identity|intent/i);
});

test('factory publication revalidates mount identity after link and immediately before receipts', () => {
  for (const hook of ['beforePublish', 'afterPublish']) {
    const d = scratch(`factory-seed-mount-race-${hook}-`);
    const seed = path.join(d, 'seed.db'); makeDb(seed);
    const database = path.join(d, 'data/db/farming.db');
    const receiptOut = path.join(d, 'receipt.json');
    const databaseLineageOut = path.join(d, 'lineage.json');
    const expectedSeedSha256 = crypto.createHash('sha256').update(fs.readFileSync(seed)).digest('hex');
    assert.throws(() => factorySeed.realize({ factorySeed: seed, expectedSeedSha256, database,
      operationId: `mount-race-${hook}`, receiptOut, databaseLineageOut }, {
      [hook]() { writeDirectMountAdapter('8:2', '/dev/replaced-factory'); },
    }), /mount|identity/i, hook);
    assert.equal(fs.existsSync(receiptOut), false, `${hook}: receipt must not publish under drifted mount authority`);
    assert.equal(fs.existsSync(databaseLineageOut), false, `${hook}: lineage must not publish under drifted mount authority`);
    writeDirectMountAdapter();
  }
});

test('factory mount identity binds overlay upperdir and workdir as well as backing device', () => {
  for (const drift of ['upperdir', 'workdir', 'backing-device']) {
    const d = scratch(`factory-seed-overlay-${drift}-`);
    const seed = path.join(d, 'seed.db'); makeDb(seed);
    const database = path.join(d, 'data/db/farming.db');
    const receiptOut = path.join(d, 'receipt.json');
    const databaseLineageOut = path.join(d, 'lineage.json');
    const backingRoot = path.join(d, 'persistent');
    fs.mkdirSync(backingRoot, { mode: 0o700 });
    writeOverlayMountAdapter(backingRoot);
    const expectedSeedSha256 = crypto.createHash('sha256').update(fs.readFileSync(seed)).digest('hex');
    factorySeed.realize({ factorySeed: seed, expectedSeedSha256, database,
      operationId: `overlay-${drift}`, receiptOut, databaseLineageOut });
    if (drift === 'upperdir') writeOverlayMountAdapter(backingRoot, 'upper-b', 'work-a');
    if (drift === 'workdir') writeOverlayMountAdapter(backingRoot, 'upper-a', 'work-b');
    if (drift === 'backing-device') {
      fs.writeFileSync(MOUNT_ADAPTER,
        `36 25 0:42 / @DATA_ROOT@ rw,relatime - overlay overlay rw,lowerdir=/rom,upperdir=${backingRoot}/upper-a,workdir=${backingRoot}/work-a\n`
        + `37 25 8:2 / ${backingRoot} rw,relatime - ext4 /dev/replaced-factory rw\n`, { mode: 0o600 });
      fs.chmodSync(MOUNT_ADAPTER, 0o600);
    }
    assert.throws(() => factorySeed.realize({ factorySeed: seed, expectedSeedSha256, database,
      operationId: `overlay-${drift}`, receiptOut, databaseLineageOut }), /mount|identity|intent/i, drift);
    writeDirectMountAdapter();
  }
});

test('factory directory creation refuses an ancestor symlink planted after mount preflight', () => {
  const d = scratch('factory-seed-directory-race-');
  const seed = path.join(d, 'seed.db'); makeDb(seed);
  const database = path.join(d, 'data/db/farming.db');
  const outside = path.join(d, 'outside'); fs.mkdirSync(outside);
  const expectedSeedSha256 = crypto.createHash('sha256').update(fs.readFileSync(seed)).digest('hex');
  assert.throws(() => factorySeed.realize({ factorySeed: seed, expectedSeedSha256, database,
    operationId: 'directory-race', receiptOut: path.join(d, 'receipt.json'),
    databaseLineageOut: path.join(d, 'lineage.json') }, {
    beforeDatabaseDirectory() { fs.symlinkSync(outside, path.join(d, 'data')); },
  }), /symlink|ancestor|directory/i);
  assert.equal(fs.existsSync(path.join(outside, 'db')), false, 'must not create through the raced symlink');
});

test('factory database directory is private, owned, and durably linked from the data root', () => {
  for (const unsafe of ['data-root', 'database-directory']) {
    const d = scratch(`factory-seed-directory-mode-${unsafe}-`);
    const seed = path.join(d, 'seed.db'); makeDb(seed);
    const database = path.join(d, 'data/db/farming.db');
    fs.mkdirSync(path.dirname(database), { recursive: true, mode: 0o700 });
    fs.chmodSync(unsafe === 'data-root' ? path.join(d, 'data') : path.dirname(database), 0o777);
    const expectedSeedSha256 = crypto.createHash('sha256').update(fs.readFileSync(seed)).digest('hex');
    assert.throws(() => factorySeed.realize({ factorySeed: seed, expectedSeedSha256, database,
      operationId: `unsafe-${unsafe}`, receiptOut: path.join(d, 'receipt.json'),
      databaseLineageOut: path.join(d, 'lineage.json') }), /owner|mode|private|directory/i, unsafe);
  }

  const d = scratch('factory-seed-directory-durability-');
  const seed = path.join(d, 'seed.db'); makeDb(seed);
  const database = path.join(d, 'data/db/farming.db');
  const expectedSeedSha256 = crypto.createHash('sha256').update(fs.readFileSync(seed)).digest('hex');
  let durableDataRoot = null;
  factorySeed.realize({ factorySeed: seed, expectedSeedSha256, database,
    operationId: 'directory-durable', receiptOut: path.join(d, 'receipt.json'),
    databaseLineageOut: path.join(d, 'lineage.json') }, {
    afterDatabaseDirectoryDurable(dataRoot) { durableDataRoot = dataRoot; },
  });
  assert.equal(durableDataRoot, path.join(d, 'data'));
  assert.equal(fs.statSync(path.join(d, 'data')).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.dirname(database)).mode & 0o777, 0o700);
});

test('production realize rejects every database path except canonical /data/db/farming.db', () => {
  const d = scratch('factory-seed-production-path-');
  const source = path.join(d, 'seed.db'); makeDb(source);
  const target = path.join(d, 'data/db/farming.db');
  const seedSha = crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex');
  const env = { ...process.env };
  delete env.OSI_FACTORY_SEED_TEST_ROOT;
  delete env.OSI_DEPLOY_ARTIFACT_MODE;
  const result = cp.spawnSync(process.execPath, [cli, 'realize', '--factory-seed', source,
    '--expected-seed-sha256', seedSha, '--database', target, '--operation-id', 'production-path',
    '--receipt-out', path.join(d, 'receipt.json'), '--database-lineage-out', path.join(d, 'lineage.json')],
  { encoding: 'utf8', env });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /canonical|\/data\/db\/farming\.db/);
  assert.equal(fs.existsSync(target), false);
});

test('realize resumes exact durable prefixes after database publication and receipt publication', () => {
  for (const crashPoint of ['afterPublish', 'afterReceipt']) {
    const d = scratch(`factory-seed-resume-${crashPoint}-`);
    const seed = path.join(d, 'seed.db'); makeDb(seed);
    const database = path.join(d, 'data/db/farming.db');
    const receiptOut = path.join(d, 'receipt.json');
    const databaseLineageOut = path.join(d, 'lineage.json');
    const expectedSeedSha256 = crypto.createHash('sha256').update(fs.readFileSync(seed)).digest('hex');
    assert.throws(() => factorySeed.realize({ factorySeed: seed, expectedSeedSha256, database,
      operationId: 'baseline-resume', receiptOut, databaseLineageOut }, {
      [crashPoint]() { throw new Error(`crash:${crashPoint}`); },
    }), new RegExp(`crash:${crashPoint}`));
    const published = fs.statSync(database);
    const resumed = factorySeed.realize({ factorySeed: seed, expectedSeedSha256, database,
      operationId: 'baseline-resume', receiptOut, databaseLineageOut });
    const final = fs.statSync(database);
    assert.equal(final.ino, published.ino, 'resume must preserve the already-published database inode');
    assert.match(resumed.seedReceiptSha256, /^[0-9a-f]{64}$/);
    assert.equal(fs.existsSync(receiptOut), true);
    assert.equal(fs.existsSync(databaseLineageOut), true);
  }
});

test('factory publishes a durable inode-bound link intent before the live database link', () => {
  const d = scratch('factory-seed-link-intent-');
  const seed = path.join(d, 'seed.db'); makeDb(seed);
  const database = path.join(d, 'data/db/farming.db');
  const receiptOut = path.join(d, 'receipt.json');
  const databaseLineageOut = path.join(d, 'lineage.json');
  const expectedSeedSha256 = crypto.createHash('sha256').update(fs.readFileSync(seed)).digest('hex');
  let intentOwnedTemporary;
  let intentOwnedTemporaryStat;
  const options = { factorySeed: seed, expectedSeedSha256, database,
    operationId: 'link-intent', receiptOut, databaseLineageOut };
  assert.throws(() => factorySeed.realize(options, {
    afterLinkIntentDurable(temporary, linkIntentPath) {
      assert.equal(fs.existsSync(database), false, 'live link must not exist before the durable intent');
      const temporaryStat = fs.statSync(temporary);
      intentOwnedTemporary = temporary;
      intentOwnedTemporaryStat = temporaryStat;
      const linkIntent = JSON.parse(fs.readFileSync(linkIntentPath));
      assert.equal(linkIntent.temporaryDevice, temporaryStat.dev);
      assert.equal(linkIntent.temporaryInode, temporaryStat.ino);
      assert.equal(linkIntent.seedSha256, expectedSeedSha256);
      assert.match(linkIntent.dataMountIdentitySha256, /^[0-9a-f]{64}$/);
      throw new Error('crash:after-link-intent');
    },
  }), /crash:after-link-intent/);
  assert.equal(fs.existsSync(database), false);
  assert.equal(fs.existsSync(intentOwnedTemporary), true, 'durable intent must retain its exact temporary inode');
  assert.equal(fs.existsSync(receiptOut), false);
  assert.equal(fs.existsSync(databaseLineageOut), false);
  const resumed = factorySeed.realize(options);
  const published = fs.statSync(database);
  assert.equal(published.dev, intentOwnedTemporaryStat.dev);
  assert.equal(published.ino, intentOwnedTemporaryStat.ino);
  assert.equal(fs.existsSync(intentOwnedTemporary), false, 'successful publication may retire the temporary name');
  assert.match(resumed.seedReceiptSha256, /^[0-9a-f]{64}$/);
  assert.equal(fs.existsSync(receiptOut), true);
  assert.equal(fs.existsSync(databaseLineageOut), true);
});

test('factory retires its temporary name only after receipt and lineage publication', () => {
  const d = scratch('factory-seed-cleanup-order-');
  const seed = path.join(d, 'seed.db'); makeDb(seed);
  const database = path.join(d, 'data/db/farming.db');
  const receiptOut = path.join(d, 'receipt.json');
  const databaseLineageOut = path.join(d, 'lineage.json');
  const expectedSeedSha256 = crypto.createHash('sha256').update(fs.readFileSync(seed)).digest('hex');
  let temporary;
  let observedDurableOutputs = false;
  factorySeed.realize({ factorySeed: seed, expectedSeedSha256, database,
    operationId: 'cleanup-order', receiptOut, databaseLineageOut }, {
    afterLinkIntentDurable(candidate) { temporary = candidate; },
    afterLineage() {
      assert.equal(fs.existsSync(receiptOut), true, 'receipt must precede temporary cleanup');
      assert.equal(fs.existsSync(databaseLineageOut), true, 'lineage must precede temporary cleanup');
      assert.equal(fs.existsSync(temporary), true, 'intent-owned temporary must remain until both outputs are durable');
      assert.equal(fs.statSync(database).nlink, 2, 'only live and intent-owned temporary names may exist');
      observedDurableOutputs = true;
    },
  });
  assert.equal(observedDurableOutputs, true);
  assert.equal(fs.existsSync(temporary), false, 'successful publication must retire the temporary name');
  assert.equal(fs.statSync(database).nlink, 1, 'successful cleanup must leave no second inode alias');
});

test('factory resumes deterministically after cleanup unlinks the temporary before parent fsync', () => {
  const d = scratch('factory-seed-cleanup-crash-');
  const seed = path.join(d, 'seed.db'); makeDb(seed);
  const database = path.join(d, 'data/db/farming.db');
  const receiptOut = path.join(d, 'receipt.json');
  const databaseLineageOut = path.join(d, 'lineage.json');
  const expectedSeedSha256 = crypto.createHash('sha256').update(fs.readFileSync(seed)).digest('hex');
  const options = { factorySeed: seed, expectedSeedSha256, database,
    operationId: 'cleanup-crash', receiptOut, databaseLineageOut };
  let temporary;
  assert.throws(() => factorySeed.realize(options, {
    afterLinkIntentDurable(candidate) { temporary = candidate; },
    afterIntentTemporaryUnlink() {
      assert.equal(fs.existsSync(temporary), false);
      assert.equal(fs.existsSync(database), true, 'cleanup must never unlink the live database name');
      assert.equal(fs.existsSync(receiptOut), true);
      assert.equal(fs.existsSync(databaseLineageOut), true);
      throw new Error('crash:after-intent-temporary-unlink');
    },
  }), /crash:after-intent-temporary-unlink/);
  assert.equal(fs.existsSync(temporary), false);
  assert.equal(fs.statSync(database).nlink, 1);

  const resumed = factorySeed.realize(options);
  assert.match(resumed.seedReceiptSha256, /^[0-9a-f]{64}$/);
  assert.equal(fs.existsSync(temporary), false);
  assert.equal(fs.statSync(database).nlink, 1);
});

test('factory cleanup rejects an unaccounted hardlink and never unlinks the live database', () => {
  const d = scratch('factory-seed-extra-alias-');
  const seed = path.join(d, 'seed.db'); makeDb(seed);
  const database = path.join(d, 'data/db/farming.db');
  const receiptOut = path.join(d, 'receipt.json');
  const databaseLineageOut = path.join(d, 'lineage.json');
  const unexpectedAlias = path.join(d, 'unexpected-farming-alias.db');
  const expectedSeedSha256 = crypto.createHash('sha256').update(fs.readFileSync(seed)).digest('hex');
  const options = { factorySeed: seed, expectedSeedSha256, database,
    operationId: 'extra-alias', receiptOut, databaseLineageOut };
  let temporary;
  assert.throws(() => factorySeed.realize(options, {
    afterLinkIntentDurable(candidate) { temporary = candidate; },
    afterLineage() { fs.linkSync(database, unexpectedAlias); },
  }), /alias|hardlink/i);
  assert.equal(fs.existsSync(database), true, 'cleanup must preserve the canonical live database');
  assert.equal(fs.existsSync(temporary), true, 'cleanup must not mutate an ambiguous alias set');
  assert.equal(fs.statSync(database).nlink, 3);

  fs.unlinkSync(unexpectedAlias);
  factorySeed.realize(options);
  assert.equal(fs.existsSync(database), true);
  assert.equal(fs.existsSync(temporary), false);
  assert.equal(fs.statSync(database).nlink, 1);
});

test('factory retry resumes the exact intent-owned temporary at the final pre-link boundary', () => {
  const d = scratch('factory-seed-before-link-');
  const seed = path.join(d, 'seed.db'); makeDb(seed);
  const database = path.join(d, 'data/db/farming.db');
  const receiptOut = path.join(d, 'receipt.json');
  const databaseLineageOut = path.join(d, 'lineage.json');
  const expectedSeedSha256 = crypto.createHash('sha256').update(fs.readFileSync(seed)).digest('hex');
  const options = { factorySeed: seed, expectedSeedSha256, database,
    operationId: 'before-link', receiptOut, databaseLineageOut };
  let temporary;
  assert.throws(() => factorySeed.realize(options, {
    beforeDatabaseLink(candidate) { temporary = candidate; throw new Error('crash:before-database-link'); },
  }), /crash:before-database-link/);
  const temporaryStat = fs.statSync(temporary);
  assert.equal(fs.existsSync(database), false);
  factorySeed.realize(options);
  const databaseStat = fs.statSync(database);
  assert.equal(databaseStat.dev, temporaryStat.dev);
  assert.equal(databaseStat.ino, temporaryStat.ino);
  assert.equal(fs.existsSync(receiptOut), true);
  assert.equal(fs.existsSync(databaseLineageOut), true);
});

test('factory pre-link retry rejects a missing, replaced, or tampered intent-owned temporary', () => {
  for (const mutation of ['missing', 'foreign-same-hash', 'tampered']) {
    const d = scratch(`factory-seed-pre-link-${mutation}-`);
    const seed = path.join(d, 'seed.db'); makeDb(seed);
    const database = path.join(d, 'data/db/farming.db');
    const receiptOut = path.join(d, 'receipt.json');
    const databaseLineageOut = path.join(d, 'lineage.json');
    const expectedSeedSha256 = crypto.createHash('sha256').update(fs.readFileSync(seed)).digest('hex');
    const options = { factorySeed: seed, expectedSeedSha256, database,
      operationId: `pre-link-${mutation}`, receiptOut, databaseLineageOut };
    let temporary;
    assert.throws(() => factorySeed.realize(options, {
      afterLinkIntentDurable(candidate) { temporary = candidate; throw new Error('crash:after-link-intent'); },
    }), /crash:after-link-intent/);
    if (mutation === 'missing') fs.unlinkSync(temporary);
    if (mutation === 'foreign-same-hash') {
      const replacement = `${temporary}.replacement`;
      fs.copyFileSync(seed, replacement); fs.chmodSync(replacement, 0o600);
      fs.renameSync(replacement, temporary);
    }
    if (mutation === 'tampered') fs.writeFileSync(temporary, 'not-the-authorized-seed', { mode: 0o600 });
    assert.throws(() => factorySeed.realize(options), /temporary|link intent|inode|hash|SQLite/i, mutation);
    assert.equal(fs.existsSync(database), false, mutation);
    assert.equal(fs.existsSync(receiptOut), false, mutation);
    assert.equal(fs.existsSync(databaseLineageOut), false, mutation);
  }
});

test('post-link crash resumes only the exact hardlinked factory database inode', () => {
  for (const replacement of ['exact', 'foreign-same-hash']) {
    const d = scratch(`factory-seed-post-link-${replacement}-`);
    const seed = path.join(d, 'seed.db'); makeDb(seed);
    const database = path.join(d, 'data/db/farming.db');
    const receiptOut = path.join(d, 'receipt.json');
    const databaseLineageOut = path.join(d, 'lineage.json');
    const expectedSeedSha256 = crypto.createHash('sha256').update(fs.readFileSync(seed)).digest('hex');
    const options = { factorySeed: seed, expectedSeedSha256, database,
      operationId: `post-link-${replacement}`, receiptOut, databaseLineageOut };
    assert.throws(() => factorySeed.realize(options, {
      afterDatabaseLinkDurable() { throw new Error('crash:after-database-link'); },
    }), /crash:after-database-link/);
    const linked = fs.statSync(database);
    assert.equal(fs.existsSync(`${databaseLineageOut}.seed-link-intent.json`), true);
    assert.equal(fs.existsSync(`${databaseLineageOut}.seed-publication.json`), false);

    if (replacement === 'foreign-same-hash') {
      fs.unlinkSync(database);
      fs.copyFileSync(seed, database);
      fs.chmodSync(database, 0o600);
      assert.notEqual(fs.statSync(database).ino, linked.ino);
      assert.throws(() => factorySeed.realize(options), /inode|link intent/i);
      assert.equal(fs.existsSync(receiptOut), false);
      assert.equal(fs.existsSync(databaseLineageOut), false);
    } else {
      const resumed = factorySeed.realize(options);
      assert.equal(fs.statSync(database).ino, linked.ino);
      assert.match(resumed.seedReceiptSha256, /^[0-9a-f]{64}$/);
      assert.equal(fs.existsSync(receiptOut), true);
      assert.equal(fs.existsSync(databaseLineageOut), true);
    }
  }
});

test('factory SQLite checks ignore caller PATH shadows', () => {
  const d = scratch('factory-seed-path-authority-');
  const seed = path.join(d, 'seed.db'); makeDb(seed);
  const shadowDir = path.join(d, 'shadow'); fs.mkdirSync(shadowDir);
  const sentinel = path.join(d, 'ambient-sqlite3-ran');
  const shadow = path.join(shadowDir, 'sqlite3');
  fs.writeFileSync(shadow, `#!/bin/sh\nprintf shadow >${JSON.stringify(sentinel)}\nexec /usr/bin/sqlite3 "$@"\n`, { mode: 0o755 });
  const previousPath = process.env.PATH;
  process.env.PATH = `${shadowDir}:${previousPath}`;
  try {
    const expectedSeedSha256 = crypto.createHash('sha256').update(fs.readFileSync(seed)).digest('hex');
    factorySeed.realize({ factorySeed: seed, expectedSeedSha256,
      database: path.join(d, 'data/db/farming.db'), operationId: 'path-authority',
      receiptOut: path.join(d, 'receipt.json'), databaseLineageOut: path.join(d, 'lineage.json') });
  } finally {
    process.env.PATH = previousPath;
  }
  assert.equal(fs.existsSync(sentinel), false, 'factory checks must invoke the pinned sqlite3 binary');
});

test('an intent cannot adopt a foreign same-hash database inode', () => {
  const d = scratch('factory-seed-foreign-inode-');
  const seed = path.join(d, 'seed.db'); makeDb(seed);
  const database = path.join(d, 'data/db/farming.db');
  const receiptOut = path.join(d, 'receipt.json');
  const databaseLineageOut = path.join(d, 'lineage.json');
  const expectedSeedSha256 = crypto.createHash('sha256').update(fs.readFileSync(seed)).digest('hex');
  const args = ['realize', '--factory-seed', seed, '--expected-seed-sha256', expectedSeedSha256,
    '--database', database, '--operation-id', 'foreign-inode', '--receipt-out', receiptOut,
    '--database-lineage-out', databaseLineageOut];
  const intentCrashLabel = `factory-authority:${path.basename(`${databaseLineageOut}.seed-intent.json`)}:after-parent-fsync`;
  const crashed = run(args, {
    OSI_DEPLOY_TEST_BOUNDARY: path.join('/tmp', `osi-deploy-startup-tests-${process.getuid()}`),
    OSI_DEPLOY_STATE_CRASH_AT: intentCrashLabel,
  });
  assert.equal(crashed.status, 137, crashed.stderr);
  fs.mkdirSync(path.dirname(database), { recursive: true, mode: 0o700 });
  fs.copyFileSync(seed, database); fs.chmodSync(database, 0o600);
  const resumed = run(args);
  assert.notEqual(resumed.status, 0, 'intent resume must not adopt an inode it did not publish');
  assert.match(resumed.stderr, /publication|inode|authority|resume/i);
  assert.equal(fs.existsSync(receiptOut), false);
  assert.equal(fs.existsSync(databaseLineageOut), false);
});

test('sidecars, wrong seed hash, unknown flags, and changed database inode fail closed', () => {
  const d = scratch('factory-seed-negative-');
  const seed = path.join(d, 'seed.db'); makeDb(seed);
  const target = path.join(d, 'farming.db'); fs.writeFileSync(`${target}-wal`, 'x');
  assert.notEqual(run(['realize', '--factory-seed', seed, '--expected-seed-sha256', 'a'.repeat(64),
    '--database', target, '--operation-id', 'x', '--receipt-out', path.join(d, 'r.json'),
    '--database-lineage-out', path.join(d, 'l.json')]).status, 0);
  assert.notEqual(run(['realize', '--bogus', 'x']).status, 0);
});

test('publish is no-replace against a concurrent target or dangling symlink and rechecks sidecars', () => {
  for (const collision of ['file', 'dangling-symlink', 'wal']) {
    const d = scratch(`factory-seed-race-${collision}-`);
    const seed = path.join(d, 'seed.db'); makeDb(seed);
    const database = path.join(d, 'data/db/farming.db');
    const expectedSeedSha256 = crypto.createHash('sha256').update(fs.readFileSync(seed)).digest('hex');
    fs.mkdirSync(path.dirname(database), { recursive: true });
    fs.chmodSync(path.join(d, 'data'), 0o700);
    fs.chmodSync(path.dirname(database), 0o700);
    const planted = collision === 'wal' ? `${database}-wal` : database;
    assert.throws(() => factorySeed.realize({
      factorySeed: seed,
      expectedSeedSha256,
      database,
      operationId: 'baseline-race',
      receiptOut: path.join(d, 'receipt.json'),
      databaseLineageOut: path.join(d, 'lineage.json'),
    }, {
      beforePublish() {
        if (collision === 'dangling-symlink') fs.symlinkSync(path.join(d, 'missing-target'), planted);
        else fs.writeFileSync(planted, 'concurrent-writer');
      },
    }));
    const stat = fs.lstatSync(planted);
    if (collision === 'dangling-symlink') assert.equal(stat.isSymbolicLink(), true);
    else assert.equal(fs.readFileSync(planted, 'utf8'), 'concurrent-writer');
    assert.equal(fs.existsSync(path.join(d, 'receipt.json')), false);
  }
});

test('shared lineage verifier binds record hash, receipt, seed, owner/mode, live inode, quick-check, and valid state', () => {
  const d = scratch('factory-lineage-verify-');
  const seed = path.join(d, 'seed.db'); makeDb(seed);
  const database = path.join(d, 'data/db/farming.db');
  const receipt = path.join(d, 'receipt.json');
  const lineagePath = path.join(d, 'lineage.json');
  const seedSha256 = crypto.createHash('sha256').update(fs.readFileSync(seed)).digest('hex');
  const realized = factorySeed.realize({ factorySeed: seed, expectedSeedSha256: seedSha256, database, operationId: 'base', receiptOut: receipt, databaseLineageOut: lineagePath });
  const validState = { status: 'valid', databaseLineageSha256: realized.databaseLineageSha256, seedReceiptSha256: realized.seedReceiptSha256 };
  assert.deepEqual(factorySeed.verifyFactoryDatabaseLineage(lineagePath, {
    database, seedReceiptPath: receipt, expectedSeedReceiptSha256: realized.seedReceiptSha256,
    expectedSeedSha256: seedSha256, expectedDatabaseLineageSha256: realized.databaseLineageSha256,
    databaseLineageState: validState,
  }), { databaseLineageSha256: realized.databaseLineageSha256 });

  const replacement = path.join(d, 'replacement.db'); makeDb(replacement);
  fs.chmodSync(replacement, 0o600);
  fs.renameSync(replacement, database);
  assert.throws(() => factorySeed.verifyFactoryDatabaseLineage(lineagePath, {
    database, seedReceiptPath: receipt, expectedSeedReceiptSha256: realized.seedReceiptSha256,
    expectedSeedSha256: seedSha256, expectedDatabaseLineageSha256: realized.databaseLineageSha256,
    databaseLineageState: validState,
  }), /inode/);
});

test('shared lineage verifier rehashes the live database and rejects every SQLite sidecar', () => {
  for (const mutation of ['content', '-wal', '-shm', '-journal']) {
    const d = scratch(`factory-lineage-live-${mutation.replace('-', '')}-`);
    const seed = path.join(d, 'seed.db'); makeDb(seed);
    const database = path.join(d, 'data/db/farming.db');
    const receipt = path.join(d, 'receipt.json');
    const lineagePath = path.join(d, 'lineage.json');
    const seedSha256 = crypto.createHash('sha256').update(fs.readFileSync(seed)).digest('hex');
    const realized = factorySeed.realize({ factorySeed: seed, expectedSeedSha256: seedSha256,
      database, operationId: `verify-${mutation}`, receiptOut: receipt, databaseLineageOut: lineagePath });
    const validState = { status: 'valid', databaseLineageSha256: realized.databaseLineageSha256,
      seedReceiptSha256: realized.seedReceiptSha256 };
    if (mutation === 'content') fs.appendFileSync(database, 'foreign-trailer');
    else fs.writeFileSync(`${database}${mutation}`, 'foreign-sidecar');
    assert.throws(() => factorySeed.verifyFactoryDatabaseLineage(lineagePath, {
      database, seedReceiptPath: receipt, expectedSeedReceiptSha256: realized.seedReceiptSha256,
      expectedSeedSha256: seedSha256, expectedDatabaseLineageSha256: realized.databaseLineageSha256,
      databaseLineageState: validState,
    }), mutation === 'content' ? /hash|seed/i : /sidecar|SQLite set/i, mutation);
  }
});
