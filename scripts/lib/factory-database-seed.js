'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const deploymentStatePath = [
  path.join(__dirname, 'deployment-state.js'),
  path.join(__dirname, 'osi-deployment-state.js'),
].find((candidate) => fs.existsSync(candidate));
if (!deploymentStatePath) throw new Error('shared deployment-state publication primitive is unavailable');
const deploymentState = require(deploymentStatePath);
const SQLITE3 = '/usr/bin/sqlite3';

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function hashBytes(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function hashObject(value) { return hashBytes(Buffer.from(canonical(value))); }
function fsyncDir(dir) { const fd = fs.openSync(dir, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
function writeExclusive(file, value) {
  const bytes = Buffer.from(`${canonical(value)}\n`);
  return deploymentState.publishImmutableBytes(file, bytes, {
    crashLabelPrefix: `factory-authority:${path.basename(file)}`,
  }).rawSha256;
}
function assertRegular(file, label) { const stat = fs.lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular nonsymlink file`); return stat; }
function quickCheck(database) { const result = cp.spawnSync(SQLITE3, ['-readonly', database, 'PRAGMA quick_check;'], { encoding: 'utf8', timeout: 30000 }); if (result.status !== 0 || result.stdout.trim() !== 'ok') throw new Error('SQLite quick_check failed'); }
function lstatOrNull(file) { try { return fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }
function requireOwned0600(file, label) { const stat = assertRegular(file, label); if (stat.uid !== process.getuid()) throw new Error(`${label} owner mismatch`); if ((stat.mode & 0o777) !== 0o600) throw new Error(`${label} must be mode 0600`); return stat; }
function requireSqliteSetAbsent(database) { for (const suffix of ['', '-wal', '-shm', '-journal']) if (lstatOrNull(`${database}${suffix}`)) throw new Error(`database SQLite set is not absent: ${suffix || 'main'}`); }
function requireSqliteSidecarsAbsent(database) { for (const suffix of ['-wal', '-shm', '-journal']) if (lstatOrNull(`${database}${suffix}`)) throw new Error(`database SQLite sidecar exists: ${suffix}`); }
function readExactJson(file, expected, label) {
  requireOwned0600(file, label);
  let actual;
  try { actual = JSON.parse(fs.readFileSync(file)); } catch (_error) { throw new Error(`${label} is invalid JSON`); }
  if (canonical(actual) !== canonical(expected)) throw new Error(`${label} does not match this operation`);
  return actual;
}

function validateDatabaseAuthority(database) {
  const resolved = path.resolve(database);
  const boundary = path.join('/tmp', `osi-factory-seed-tests-${process.getuid()}`);
  const configured = process.env.OSI_FACTORY_SEED_TEST_ROOT;
  const testMode = process.env.OSI_REPAIR_PROGRAM_MODE === '1'
      && process.env.OSI_DEPLOY_ARTIFACT_MODE === 'test'
      && configured === boundary
      && resolved.startsWith(`${boundary}${path.sep}`)
      && resolved.endsWith(`${path.sep}data${path.sep}db${path.sep}farming.db`);
  if (resolved !== '/data/db/farming.db' && !testMode) {
    throw new Error('factory database must use canonical /data/db/farming.db (temporary paths require the fixed hermetic test adapter)');
  }
  const dataRoot = testMode ? resolved.slice(0, -`${path.sep}db${path.sep}farming.db`.length) : '/data';
  const scanRoot = testMode ? boundary : '/data';
  let cursor = scanRoot;
  const scan = [scanRoot];
  if (testMode) {
    const relative = path.relative(scanRoot, resolved);
    for (const part of relative.split(path.sep).filter(Boolean)) { cursor = path.join(cursor, part); scan.push(cursor); }
  } else {
    scan.push('/data/db', '/data/db/farming.db');
  }
  for (const candidate of scan) {
    const stat = lstatOrNull(candidate);
    if (!stat) continue;
    if (stat.isSymbolicLink()) throw new Error(`factory database ancestor is a symlink: ${candidate}`);
    if (candidate !== resolved && !stat.isDirectory()) throw new Error(`factory database ancestor is not a directory: ${candidate}`);
  }

  let mountInfo;
  if (testMode) {
    const adapter = process.env.OSI_FACTORY_SEED_TEST_MOUNTINFO;
    const expected = path.join(boundary, 'factory-mountinfo.test');
    if (!adapter || path.resolve(adapter) !== expected) throw new Error('fixed factory mountinfo test adapter is required');
    const stat = fs.lstatSync(adapter);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600) {
      throw new Error('factory mountinfo test adapter must be an owned mode-0600 regular file');
    }
    const template = fs.readFileSync(adapter, 'utf8');
    if (!template.includes('@DATA_ROOT@')) throw new Error('factory mountinfo test adapter must bind @DATA_ROOT@');
    mountInfo = template.replaceAll('@DATA_ROOT@', dataRoot);
  } else {
    mountInfo = fs.readFileSync('/proc/self/mountinfo', 'utf8');
  }
  const profile = deploymentState.validatePersistentMountProfile(dataRoot, mountInfo, {
    simulatedRoot: testMode ? dataRoot : null,
  });
  const mountFact = (mount) => mount ? {
    majorMinor: mount.majorMinor,
    mountRoot: mount.mountRoot,
    point: mount.point,
    mountOptions: [...mount.mountOptions].sort(),
    optionalFields: [...mount.optionalFields].sort(),
    fsType: mount.fsType,
    source: mount.source,
    superOptions: mount.superOptions,
  } : null;
  let overlay = null;
  if (profile.mode === 'persistent-overlay-upperdir') {
    const upperdir = /(?:^|,)upperdir=([^,\s]+)/.exec(profile.selected.superOptions);
    const workdir = /(?:^|,)workdir=([^,\s]+)/.exec(profile.selected.superOptions);
    if (!upperdir || !workdir || !path.isAbsolute(upperdir[1]) || !path.isAbsolute(workdir[1])) {
      throw new Error('factory overlay mount identity requires absolute upperdir and workdir');
    }
    overlay = { upperdir: upperdir[1], workdir: workdir[1] };
  }
  const dataMountIdentitySha256 = hashObject({ mode: profile.mode, dataRoot,
    selected: mountFact(profile.selected), backing: mountFact(profile.backing), overlay });
  return { database: resolved, dataRoot, dataMountIdentitySha256, testMode };
}

function ensureDatabaseDirectory(authority, adapters = {}) {
  let dataStat = lstatOrNull(authority.dataRoot);
  if (!dataStat) {
    if (!authority.testMode) throw new Error('canonical /data mount directory is missing');
    fs.mkdirSync(authority.dataRoot, { mode: 0o700 });
    dataStat = fs.lstatSync(authority.dataRoot);
  }
  if (!dataStat.isDirectory() || dataStat.isSymbolicLink()) throw new Error('factory data ancestor must be a real directory');
  if (dataStat.uid !== process.getuid() || (dataStat.mode & 0o022) !== 0) {
    throw new Error('factory data ancestor must have safe ownership and mode');
  }
  const databaseDirectory = path.dirname(authority.database);
  let databaseDirectoryStat = lstatOrNull(databaseDirectory);
  if (!databaseDirectoryStat) {
    fs.mkdirSync(databaseDirectory, { mode: 0o700 });
    databaseDirectoryStat = fs.lstatSync(databaseDirectory);
  }
  if (!databaseDirectoryStat.isDirectory() || databaseDirectoryStat.isSymbolicLink()) {
    throw new Error('factory database ancestor must be a real directory');
  }
  if (databaseDirectoryStat.uid !== process.getuid() || (databaseDirectoryStat.mode & 0o777) !== 0o700) {
    throw new Error('factory database directory must be owned and mode 0700');
  }
  fsyncDir(databaseDirectory);
  fsyncDir(authority.dataRoot);
  if (adapters.afterDatabaseDirectoryDurable) adapters.afterDatabaseDirectoryDurable(authority.dataRoot);
}

function databasePublicationRecord(intent, databaseStat) {
  return {
    format: 1,
    operationId: intent.operationId,
    database: intent.database,
    seedSha256: intent.seedSha256,
    dataMountIdentitySha256: intent.dataMountIdentitySha256,
    createdDevice: databaseStat.dev,
    createdInode: databaseStat.ino,
    createdAt: intent.createdAt,
  };
}

function databaseLinkIntentRecord(intent, temporary, temporaryStat) {
  return {
    format: 1,
    operationId: intent.operationId,
    database: intent.database,
    temporary,
    seedSha256: intent.seedSha256,
    dataMountIdentitySha256: intent.dataMountIdentitySha256,
    temporaryDevice: temporaryStat.dev,
    temporaryInode: temporaryStat.ino,
    createdAt: intent.createdAt,
  };
}

function readDatabaseLinkIntent(linkIntentPath, intent) {
  const raw = fs.readFileSync(linkIntentPath);
  let linkIntent;
  try { linkIntent = JSON.parse(raw); } catch (_error) { throw new Error('factory database link intent is invalid JSON'); }
  const keys = ['format', 'operationId', 'database', 'temporary', 'seedSha256',
    'dataMountIdentitySha256', 'temporaryDevice', 'temporaryInode', 'createdAt'];
  if (!linkIntent || Object.keys(linkIntent).sort().join() !== keys.sort().join()
      || linkIntent.format !== 1 || linkIntent.operationId !== intent.operationId
      || linkIntent.database !== intent.database || !path.isAbsolute(linkIntent.temporary)
      || linkIntent.seedSha256 !== intent.seedSha256
      || linkIntent.dataMountIdentitySha256 !== intent.dataMountIdentitySha256
      || !Number.isInteger(linkIntent.temporaryDevice) || !Number.isInteger(linkIntent.temporaryInode)
      || linkIntent.createdAt !== intent.createdAt) {
    throw new Error('factory database link intent does not match this operation');
  }
  requireOwned0600(linkIntentPath, 'factory database link intent');
  return linkIntent;
}

function verifyIntentOwnedTemporary(linkIntent, intent) {
  const databaseDirectory = path.dirname(intent.database);
  const expectedPrefix = `${path.basename(intent.database)}.factory-`;
  if (path.dirname(linkIntent.temporary) !== databaseDirectory
      || !path.basename(linkIntent.temporary).startsWith(expectedPrefix)) {
    throw new Error('factory database temporary path is outside the durable link intent authority');
  }
  if (!lstatOrNull(linkIntent.temporary)) {
    throw new Error('factory database temporary named by the durable link intent is missing');
  }
  const temporaryStat = requireOwned0600(linkIntent.temporary, 'factory database temporary');
  if (temporaryStat.dev !== linkIntent.temporaryDevice || temporaryStat.ino !== linkIntent.temporaryInode) {
    throw new Error('factory database temporary inode does not match the durable link intent');
  }
  if (hashBytes(fs.readFileSync(linkIntent.temporary)) !== intent.seedSha256) {
    throw new Error('factory database temporary hash does not match the durable link intent');
  }
  quickCheck(linkIntent.temporary);
  return temporaryStat;
}

function verifyPublishedDatabase(database, intent, publicationPath) {
  requireSqliteSidecarsAbsent(database);
  const databaseStat = requireOwned0600(database, 'live database');
  if (hashBytes(fs.readFileSync(database)) !== intent.seedSha256) {
    throw new Error('published factory database hash does not match the operation intent');
  }
  quickCheck(database);
  const publication = databasePublicationRecord(intent, databaseStat);
  readExactJson(publicationPath, publication, 'factory database publication authority');
  return { databaseStat, publication, publicationSha256: hashBytes(fs.readFileSync(publicationPath)) };
}

function retireIntentOwnedTemporary(linkIntent, intent, adapters = {}) {
  if (path.resolve(linkIntent.temporary) === path.resolve(intent.database)) {
    throw new Error('factory database cleanup must never target the live database name');
  }
  const liveBefore = requireOwned0600(intent.database, 'live database');
  if (liveBefore.dev !== linkIntent.temporaryDevice || liveBefore.ino !== linkIntent.temporaryInode) {
    throw new Error('live database inode does not match the durable factory link intent during cleanup');
  }
  const temporary = lstatOrNull(linkIntent.temporary);
  if (temporary) {
    const ownedTemporary = verifyIntentOwnedTemporary(linkIntent, intent);
    if (liveBefore.nlink !== 2 || ownedTemporary.nlink !== 2) {
      throw new Error('factory database publication has an unexpected second inode alias');
    }
    fs.unlinkSync(linkIntent.temporary);
    if (adapters.afterIntentTemporaryUnlink) adapters.afterIntentTemporaryUnlink(linkIntent.temporary);
  }
  fsyncDir(path.dirname(linkIntent.temporary));
  if (lstatOrNull(linkIntent.temporary)) {
    throw new Error('intent-owned factory database temporary remains after cleanup');
  }
  const liveAfter = requireOwned0600(intent.database, 'live database');
  if (liveAfter.dev !== linkIntent.temporaryDevice || liveAfter.ino !== linkIntent.temporaryInode
      || liveAfter.nlink !== 1) {
    throw new Error('factory database cleanup did not leave exactly one live inode name');
  }
}

function realize(options, adapters = {}) {
  for (const key of ['factorySeed', 'expectedSeedSha256', 'database', 'operationId', 'receiptOut', 'databaseLineageOut']) if (!options[key]) throw new Error(`missing ${key}`);
  let databaseAuthority = validateDatabaseAuthority(options.database);
  options.database = databaseAuthority.database;
  if (!/^[0-9a-f]{64}$/.test(options.expectedSeedSha256)) throw new Error('expected seed hash must be lowercase sha256');
  assertRegular(options.factorySeed, 'factory seed');
  const seedSha256 = hashBytes(fs.readFileSync(options.factorySeed));
  if (seedSha256 !== options.expectedSeedSha256) throw new Error('factory seed hash mismatch');
  quickCheck(options.factorySeed);
  const intentPath = `${options.databaseLineageOut}.seed-intent.json`;
  let intent;
  if (!lstatOrNull(intentPath)) {
    requireSqliteSetAbsent(options.database);
    if (lstatOrNull(options.receiptOut) || lstatOrNull(options.databaseLineageOut)) throw new Error('factory seed outputs exist without an operation intent');
    intent = {
      format: 1,
      operationId: options.operationId,
      database: options.database,
      seedSha256,
      receiptOut: options.receiptOut,
      databaseLineageOut: options.databaseLineageOut,
      dataMountIdentitySha256: databaseAuthority.dataMountIdentitySha256,
      createdAt: new Date().toISOString(),
    };
    writeExclusive(intentPath, intent);
  } else {
    requireOwned0600(intentPath, 'factory seed operation intent');
    intent = JSON.parse(fs.readFileSync(intentPath));
    if (!intent || Object.keys(intent).sort().join() !== ['format', 'operationId', 'database', 'seedSha256', 'receiptOut', 'databaseLineageOut', 'dataMountIdentitySha256', 'createdAt'].sort().join() ||
        intent.format !== 1 || intent.operationId !== options.operationId || intent.database !== options.database ||
        intent.seedSha256 !== seedSha256 || intent.receiptOut !== options.receiptOut || intent.databaseLineageOut !== options.databaseLineageOut ||
        intent.dataMountIdentitySha256 !== databaseAuthority.dataMountIdentitySha256 ||
        typeof intent.createdAt !== 'string' || !intent.createdAt) throw new Error('factory seed operation intent does not match this operation');
  }
  if (adapters.beforeDatabaseDirectory) adapters.beforeDatabaseDirectory(databaseAuthority);
  ensureDatabaseDirectory(databaseAuthority, adapters);
  databaseAuthority = validateDatabaseAuthority(options.database);
  if (databaseAuthority.dataMountIdentitySha256 !== intent.dataMountIdentitySha256) throw new Error('factory data mount identity changed after directory creation');
  const publicationPath = `${options.databaseLineageOut}.seed-publication.json`;
  const linkIntentPath = `${options.databaseLineageOut}.seed-link-intent.json`;
  let publishedNow = false;
  if (!lstatOrNull(options.database)) {
    if (lstatOrNull(publicationPath)) throw new Error('factory database publication authority exists without its database inode');
    for (const suffix of ['-wal', '-shm', '-journal']) if (lstatOrNull(`${options.database}${suffix}`)) throw new Error(`database SQLite sidecar exists during intent resume: ${suffix}`);
    let linkIntent = lstatOrNull(linkIntentPath) ? readDatabaseLinkIntent(linkIntentPath, intent) : null;
    const temporary = linkIntent
      ? linkIntent.temporary
      : `${options.database}.factory-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
    let linkIntentDurable = Boolean(linkIntent);
    let createdTemporaryIdentity = null;
    try {
      if (linkIntent) {
        verifyIntentOwnedTemporary(linkIntent, intent);
      } else {
        const source = fs.openSync(options.factorySeed, 'r'); const target = fs.openSync(temporary, 'wx', 0o600);
        try { const buffer = Buffer.alloc(1024 * 1024); let position = 0; for (;;) { const count = fs.readSync(source, buffer, 0, buffer.length, position); if (!count) break; fs.writeSync(target, buffer, 0, count); position += count; } fs.fsyncSync(target); }
        finally { fs.closeSync(source); fs.closeSync(target); }
        createdTemporaryIdentity = fs.lstatSync(temporary);
        if (hashBytes(fs.readFileSync(temporary)) !== options.expectedSeedSha256) throw new Error('copied factory seed hash mismatch');
        quickCheck(temporary);
        if (adapters.beforePublish) adapters.beforePublish(temporary);
      }
      requireSqliteSetAbsent(options.database);
      databaseAuthority = validateDatabaseAuthority(options.database);
      if (databaseAuthority.dataMountIdentitySha256 !== intent.dataMountIdentitySha256) {
        throw new Error('factory data mount identity changed before link intent publication');
      }
      if (!linkIntent) {
        const temporaryStat = requireOwned0600(temporary, 'factory database temporary');
        linkIntent = databaseLinkIntentRecord(intent, temporary, temporaryStat);
        writeExclusive(linkIntentPath, linkIntent);
        linkIntentDurable = true;
        if (adapters.afterLinkIntentDurable) adapters.afterLinkIntentDurable(temporary, linkIntentPath);
      }
      verifyIntentOwnedTemporary(linkIntent, intent);
      requireSqliteSetAbsent(options.database);
      databaseAuthority = validateDatabaseAuthority(options.database);
      if (databaseAuthority.dataMountIdentitySha256 !== intent.dataMountIdentitySha256) {
        throw new Error('factory data mount identity changed immediately before database publication');
      }
      if (adapters.beforeDatabaseLink) adapters.beforeDatabaseLink(temporary, linkIntentPath);
      verifyIntentOwnedTemporary(linkIntent, intent);
      requireSqliteSetAbsent(options.database);
      fs.linkSync(temporary, options.database);
      publishedNow = true;
      fs.chmodSync(options.database, 0o600);
      const liveFd = fs.openSync(options.database, 'r'); try { fs.fsyncSync(liveFd); } finally { fs.closeSync(liveFd); }
      fsyncDir(path.dirname(options.database));
      databaseAuthority = validateDatabaseAuthority(options.database);
      if (databaseAuthority.dataMountIdentitySha256 !== intent.dataMountIdentitySha256) {
        throw new Error('factory data mount identity changed after database publication');
      }
      requireSqliteSidecarsAbsent(options.database);
      quickCheck(options.database);
      const linkedDatabaseStat = requireOwned0600(options.database, 'live database');
      if (hashBytes(fs.readFileSync(options.database)) !== seedSha256) {
        throw new Error('published factory database hash does not match the operation intent');
      }
      if (adapters.afterDatabaseLinkDurable) adapters.afterDatabaseLinkDurable(options.database, linkIntentPath);
      writeExclusive(publicationPath, databasePublicationRecord(intent, linkedDatabaseStat));
    } finally {
      if (!linkIntentDurable) {
        try {
          const temporaryStat = lstatOrNull(temporary);
          const expectedIdentity = linkIntent || createdTemporaryIdentity;
          if (temporaryStat && expectedIdentity
              && temporaryStat.dev === (expectedIdentity.temporaryDevice ?? expectedIdentity.dev)
              && temporaryStat.ino === (expectedIdentity.temporaryInode ?? expectedIdentity.ino)) {
            fs.unlinkSync(temporary);
            fsyncDir(path.dirname(temporary));
          }
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
    }
  }
  const linkIntent = readDatabaseLinkIntent(linkIntentPath, intent);
  const linkedDatabaseStat = requireOwned0600(options.database, 'live database');
  if (linkedDatabaseStat.dev !== linkIntent.temporaryDevice || linkedDatabaseStat.ino !== linkIntent.temporaryInode) {
    throw new Error('live database inode does not match the durable factory link intent');
  }
  if (!lstatOrNull(publicationPath)) {
    databaseAuthority = validateDatabaseAuthority(options.database);
    if (databaseAuthority.dataMountIdentitySha256 !== intent.dataMountIdentitySha256) {
      throw new Error('factory data mount identity changed before resumed publication');
    }
    requireSqliteSidecarsAbsent(options.database);
    if (hashBytes(fs.readFileSync(options.database)) !== seedSha256) {
      throw new Error('resumed factory database hash does not match the durable link intent');
    }
    quickCheck(options.database);
    writeExclusive(publicationPath, databasePublicationRecord(intent, linkedDatabaseStat));
  }
  if (!lstatOrNull(publicationPath)) throw new Error('factory database inode has no publication authority');
  if (publishedNow && adapters.afterPublish) adapters.afterPublish(options.database);
  databaseAuthority = validateDatabaseAuthority(options.database);
  if (databaseAuthority.dataMountIdentitySha256 !== intent.dataMountIdentitySha256) {
    throw new Error('factory data mount identity changed before receipt publication');
  }
  const published = verifyPublishedDatabase(options.database, intent, publicationPath);
  const databaseStat = published.databaseStat;
  const databasePublicationSha256 = published.publicationSha256;
  const createdAt = intent.createdAt;
  const receipt = { format: 1, receiptKind: 'factory-seed', operationId: options.operationId, databasePath: options.database,
    seedSha256, dataMountIdentitySha256: databaseAuthority.dataMountIdentitySha256, databasePublicationSha256,
    createdDevice: databaseStat.dev, createdInode: databaseStat.ino, createdAt };
  let receiptCreated = false;
  let seedReceiptSha256;
  if (lstatOrNull(options.receiptOut)) {
    readExactJson(options.receiptOut, receipt, 'factory seed receipt');
    seedReceiptSha256 = hashBytes(fs.readFileSync(options.receiptOut));
  } else {
    seedReceiptSha256 = writeExclusive(options.receiptOut, receipt);
    receiptCreated = true;
  }
  if (receiptCreated && adapters.afterReceipt) adapters.afterReceipt(options.receiptOut);
  const lineage = { format: 1, databasePath: options.database, seedReceiptSha256, seedSha256,
    dataMountIdentitySha256: databaseAuthority.dataMountIdentitySha256, databasePublicationSha256,
    createdDevice: databaseStat.dev, createdInode: databaseStat.ino, createdAt };
  let lineageCreated = false;
  if (lstatOrNull(options.databaseLineageOut)) readExactJson(options.databaseLineageOut, lineage, 'factory database lineage');
  else { writeExclusive(options.databaseLineageOut, lineage); lineageCreated = true; }
  if (lineageCreated && adapters.afterLineage) adapters.afterLineage(options.databaseLineageOut);
  retireIntentOwnedTemporary(linkIntent, intent, adapters);
  return { seedReceiptSha256, databaseLineageSha256: hashObject(lineage), databaseIdentitySha256: hashObject({ device: databaseStat.dev, inode: databaseStat.ino }) };
}

function verifyFactoryDatabaseLineage(lineagePath, options) {
  const databaseAuthority = validateDatabaseAuthority(options.database);
  options.database = databaseAuthority.database;
  requireOwned0600(lineagePath, 'factory database lineage');
  const lineageBytes = fs.readFileSync(lineagePath);
  const lineage = JSON.parse(lineageBytes);
  const keys = ['format', 'databasePath', 'seedReceiptSha256', 'seedSha256', 'dataMountIdentitySha256', 'databasePublicationSha256', 'createdDevice', 'createdInode', 'createdAt'];
  if (!lineage || Object.keys(lineage).sort().join() !== keys.sort().join() || lineage.format !== 1 || lineage.databasePath !== options.database) throw new Error('invalid factory database lineage shape or database path binding');
  const lineageSha256 = hashObject(lineage);
  if (options.expectedDatabaseLineageSha256 !== lineageSha256) throw new Error('factory database lineage hash mismatch');
  const receiptStat = requireOwned0600(options.seedReceiptPath, 'factory seed receipt');
  void receiptStat;
  const receiptBytes = fs.readFileSync(options.seedReceiptPath);
  if (hashBytes(receiptBytes) !== options.expectedSeedReceiptSha256 || lineage.seedReceiptSha256 !== options.expectedSeedReceiptSha256) throw new Error('factory seed receipt mismatch');
  const receipt = JSON.parse(receiptBytes);
  const receiptKeys = ['format', 'receiptKind', 'operationId', 'databasePath', 'seedSha256', 'dataMountIdentitySha256', 'databasePublicationSha256', 'createdDevice', 'createdInode', 'createdAt'];
  if (!receipt || Object.keys(receipt).sort().join() !== receiptKeys.sort().join() || receipt.format !== 1 || receipt.receiptKind !== 'factory-seed' || receipt.databasePath !== options.database) throw new Error('invalid factory seed receipt shape or database path binding');
  if (receipt.seedSha256 !== options.expectedSeedSha256 || lineage.seedSha256 !== options.expectedSeedSha256) throw new Error('factory seed hash mismatch');
  if (receipt.dataMountIdentitySha256 !== databaseAuthority.dataMountIdentitySha256
      || lineage.dataMountIdentitySha256 !== databaseAuthority.dataMountIdentitySha256) throw new Error('factory data mount identity mismatch');
  const publicationPath = `${lineagePath}.seed-publication.json`;
  requireOwned0600(publicationPath, 'factory database publication authority');
  const publicationSha256 = hashBytes(fs.readFileSync(publicationPath));
  if (receipt.databasePublicationSha256 !== publicationSha256
      || lineage.databasePublicationSha256 !== publicationSha256) {
    throw new Error('factory database publication authority mismatch');
  }
  if (receipt.createdDevice !== lineage.createdDevice || receipt.createdInode !== lineage.createdInode || receipt.createdAt !== lineage.createdAt) throw new Error('factory seed receipt and lineage mismatch');
  const state = options.databaseLineageState;
  const stateKeys = ['status', 'databaseLineageSha256', 'seedReceiptSha256'];
  if (!state || Object.keys(state).sort().join() !== stateKeys.sort().join() || state.status !== 'valid' || state.databaseLineageSha256 !== lineageSha256 || state.seedReceiptSha256 !== lineage.seedReceiptSha256) throw new Error('factory database journal lineage state is not valid');
  const stat = requireOwned0600(options.database, 'live database');
  if (stat.dev !== lineage.createdDevice || stat.ino !== lineage.createdInode) throw new Error('factory database lineage inode mismatch');
  requireSqliteSidecarsAbsent(options.database);
  if (hashBytes(fs.readFileSync(options.database)) !== lineage.seedSha256) throw new Error('factory database lineage seed hash mismatch');
  quickCheck(options.database); return { databaseLineageSha256: lineageSha256 };
}

module.exports = { canonical, hashBytes, hashObject, realize, verifyFactoryDatabaseLineage };
