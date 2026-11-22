'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { archive, verifiedBundle, hash } = require('./deploy-archive');
const { durableWrite, Receipts, encode, outcome } = require('./deploy-offline-runtime');

function tar(entries) {
  const blocks = [];
  for (const [name, data = '', type = '0'] of entries) {
    const bytes = Buffer.from(data);
    const header = Buffer.alloc(512);
    header.write(name); header.write('0000644\0', 100); header.write('0000000\0', 108); header.write('0000000\0', 116);
    header.write(bytes.length.toString(8).padStart(11, '0') + '\0', 124);
    header.write('00000000000\0', 136); header.fill(32, 148, 156); header.write(type, 156);
    const checksum = header.reduce((a, b) => a + b, 0);
    header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148);
    blocks.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  return zlib.gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}
function bundle(gui) {
  const files = new Map([['deploy.sh', Buffer.from('exit 0')], ['scripts/deploy-bundle-manifest.js', Buffer.from('throw Error("must never execute")')], ['react_gui.tar.gz', gui]]);
  const manifest = JSON.stringify({ schema: 'osi-deploy-bundle/1', files: Object.fromEntries([...files].map(([name, data]) => [name, hash(data)])) });
  return tar([...files, ['bundle-manifest.json', manifest]]);
}
test('trusted verifier checks its bundled counterpart as data, and recursively refuses unsafe GUI archives', () => {
  assert.equal(verifiedBundle(bundle(tar([['index.html', 'gui']]))).files.get('deploy.sh').toString(), 'exit 0');
  for (const entry of [['escape', '', '2'], ['escape', '', '1'], ['../escape', 'bad'], ['/escape', 'bad'], ['dir/../../escape', 'bad'], ['pipe', '', '6']]) {
    assert.throws(() => verifiedBundle(bundle(tar([entry]))));
  }
  const modified = zlib.gunzipSync(bundle(tar([['index.html', 'gui']])));
  const at = modified.indexOf(Buffer.from('throw Error'));
  modified[at] = 88;
  assert.throws(() => verifiedBundle(zlib.gzipSync(modified)), /hash mismatch/);
});
test('archive parser rejects truncated, duplicate and conflicting entries', () => {
  assert.throws(() => archive(tar([['one', 'a'], ['one', 'b']])));
  assert.throws(() => archive(tar([['one', 'a'], ['one/two', 'b']])));
  assert.throws(() => archive(zlib.gzipSync(Buffer.alloc(512))));
});
test('durable receipts fsync the temporary file before rename and fsync the directory after it', () => {
  const events = [];
  const io = {
    openSync(name, flags, mode) { events.push(['open', name, flags, mode]); return name; },
    writeFileSync(fd) { events.push(['write', fd]); },
    fsyncSync(fd) { events.push(['fsync', fd]); },
    closeSync(fd) { events.push(['close', fd]); },
    renameSync(from, to) { events.push(['rename', from, to]); },
    unlinkSync() { const e = new Error(); e.code = 'ENOENT'; throw e; },
  };
  durableWrite('/receipts/final', 'result', io);
  assert.deepEqual(events.map(e => e[0]), ['open', 'write', 'fsync', 'close', 'rename', 'open', 'fsync', 'close']);
  assert.equal(events[0][3], 0o600);
  assert.equal(events[6][1], '/receipts');
});
for (const fail of ['writeFileSync', 'renameSync', 'file-fsync', 'directory-fsync']) {
  test(`a ${fail} publication fault cannot acknowledge success; the reserved receipt survives`, t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-fault-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const io = Object.create(fs);
    const receipt = new Receipts(path.join(root, 'result'), io);
    receipt.prepare();
    let armed = true;
    function fault() { if (armed) { armed = false; const error = new Error('synthetic full filesystem'); error.code = 'ENOSPC'; throw error; } }
    if (fail.includes('fsync')) io.fsyncSync = fd => { if (fs.fstatSync(fd).isDirectory() === (fail === 'directory-fsync')) fault(); return fs.fsyncSync(fd); };
    else io[fail] = (...args) => { fault(); return fs[fail](...args); };
    assert.equal(receipt.finish({ verdict: 'success', exit_code: 0, reason_code: 'verified' }), 74);
    const text = fs.readFileSync(receipt.file, 'utf8');
    assert.match(text, /^verdict=incomplete-recovery$/m);
    assert.match(text, /^reason_code=receipt_persistence_failed$/m);
    assert.equal(fs.statSync(receipt.file).mode & 0o777, 0o600);
  });
}
test('receipt reconciliation ignores raw sensitive diagnostic fields', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-privacy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const privateFile = path.join(root, 'private');
  fs.writeFileSync(privateFile, 'schema=osi-deploy-result/1\nstate=complete\nverdict=hold\nreason_code=0016C001F1000001\nreason=https://user:password@example.invalid/private\nlog=0016C001F1000001\n');
  const result = encode(outcome(privateFile, 1, 'a'.repeat(64)));
  assert.match(result, /^reason_code=services_held$/m);
  assert.doesNotMatch(result, /0016C001F1000001|password|https:|log=/);
});

test('GUI packaging normalizes different source permissions and packaging environments', t => {
  const { execFileSync } = require('node:child_process');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gui-modes-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const output = [];
  for (const [label, mode] of [['first', 0o600], ['second', 0o777]]) {
    const dir = path.join(root, label);
    fs.mkdirSync(dir); fs.mkdirSync(path.join(dir, 'assets'), { mode: mode === 0o600 ? 0o700 : 0o777 });
    fs.writeFileSync(path.join(dir, 'assets/app.js'), 'same GUI bytes', { mode });
    const file = path.join(root, `${label}.tar.gz`);
    execFileSync('bash', [path.join(__dirname, 'package-deploy-gui.sh'), dir, file], { env: { ...process.env, TAR_OPTIONS: '--mtime=now', GZIP: '-9', SOURCE_DATE_EPOCH: '0' } });
    output.push(fs.readFileSync(file));
    const tarBytes = zlib.gunzipSync(output.at(-1));
    // Root and assets are directories; the JS file is always 0644.
    assert.equal(tarBytes.subarray(100, 107).toString(), '0000755');
    assert.equal(tarBytes.subarray(512 + 100, 512 + 107).toString(), '0000755');
    assert.equal(tarBytes.subarray(1024 + 100, 1024 + 107).toString(), '0000644');
  }
  assert.equal(hash(output[0]), hash(output[1]));
});

test('server snapshot uses the original manifest expectations even if an archive buffer changes', () => {
  const { createVerifiedServer } = require('./deploy-local-server');
  const tree = verifiedBundle(bundle(tar([['index.html', 'gui']])));
  tree.files.get('deploy.sh').fill(88);
  assert.throws(() => createVerifiedServer(tree.files, { hashes: tree.hashes }), /snapshot hash mismatch/);
});

test('readers cannot acknowledge a candidate during rename/fsync or after a second fallback fault', t => {
  const { readReceipt } = require('./deploy-offline-runtime');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-ack-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const io = Object.create(fs);
  const receipt = new Receipts(path.join(root, 'result'), io);
  receipt.prepare();
  let during;
  let finalRenamed = false;
  io.renameSync = (src, dst) => {
    if (src.includes('.fallback-') || src === receipt.reserve) throw Object.assign(new Error('second storage error'), { code: 'EIO' });
    fs.renameSync(src, dst);
    if (dst === receipt.file) finalRenamed = true;
  };
  io.fsyncSync = fd => {
    if (finalRenamed && fs.fstatSync(fd).isDirectory()) {
      const cli = require('node:child_process').spawnSync('sh', [path.join(__dirname, 'deploy-offline.sh'), '--result', receipt.file], { encoding: 'utf8' });
      during = { code: cli.status, text: cli.stdout };
      throw Object.assign(new Error('directory fsync failed'), { code: 'EIO' });
    }
    fs.fsyncSync(fd);
  };
  assert.equal(receipt.finish({ verdict: 'success', exit_code: 0, reason_code: 'verified' }), 74);
  assert.match(fs.readFileSync(receipt.file, 'utf8'), /^verdict=success$/m, 'the raw candidate reproduces the visibility window');
  assert.equal(during.code, 74, 'a reconnect during publication cannot acknowledge success');
  for (const result of [during, readReceipt(receipt.file), readReceipt(receipt.file, 74)]) {
    assert.equal(result.code, 74);
    assert.doesNotMatch(result.text, /^verdict=success$/m);
  }
  const { spawnSync } = require('node:child_process');
  const cli = spawnSync('sh', [path.join(__dirname, 'deploy-offline.sh'), '--result', receipt.file], { encoding: 'utf8' });
  assert.equal(cli.status, 74);
  assert.doesNotMatch(cli.stdout, /^verdict=success$/m);
});

test('a committed result reader syncs the acknowledgement directory before returning success', t => {
  const { readReceipt } = require('./deploy-offline-runtime');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-commit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const receipt = new Receipts(path.join(root, 'result'));
  receipt.prepare();
  assert.equal(receipt.finish({ verdict: 'success', exit_code: 0, reason_code: 'verified' }), 0);
  const io = Object.create(fs); let synced = false;
  io.fsyncSync = fd => { synced ||= fs.fstatSync(fd).isDirectory(); fs.fsyncSync(fd); };
  assert.equal(readReceipt(receipt.file, 0, io).code, 0);
  assert.equal(synced, true);
  assert.equal(readReceipt(receipt.file, 74).code, 74, 'the waiter cannot print success after observing publication failure');
});

test('a guard lookup that fails with anything but ENOENT leaves publication unconfirmed', t => {
  const { readReceipt } = require('./deploy-offline-runtime');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-guard-io-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const receipt = new Receipts(path.join(root, 'result'));
  receipt.prepare();
  assert.equal(receipt.finish({ verdict: 'success', exit_code: 0, reason_code: 'verified' }), 0);
  // existsSync reports false on an I/O error as well as on absence.
  const io = Object.create(fs);
  io.existsSync = () => false;
  io.lstatSync = file => { if (file.endsWith('.publishing')) throw Object.assign(new Error('guard lookup failed'), { code: 'EIO' }); return fs.lstatSync(file); };
  const result = readReceipt(receipt.file, undefined, io);
  assert.equal(result.code, 74);
  assert.doesNotMatch(result.text, /^verdict=success$/m);
  assert.equal(readReceipt(receipt.file).code, 0, 'a real absence still acknowledges the committed result');
});
