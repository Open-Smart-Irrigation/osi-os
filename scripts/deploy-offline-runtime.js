#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { constants: osConstants } = require('node:os');
const { verifiedBundle, extract, hash } = require('./deploy-archive');
const { createVerifiedServer } = require('./deploy-local-server');

const reasons = Object.freeze({
  pending: 'A final deploy verdict is not available yet.',
  verified: 'Activation and local health self-check passed.',
  unverified: 'The new payload runs but its start could not be verified.',
  rollback_verified: 'Deploy failed; the previous compatible payload was restored and its readiness confirmed.',
  recovery_incomplete: 'Recovery is incomplete; inspect the deploy log and service state before restarting.',
  services_held: 'Services are held stopped; inspect DEPLOY-HELD and the deploy log.',
  deploy_refused: 'Deploy refused before activation; inspect the deploy log.',
  deploy_failed: 'Deploy failed after live-file publication, activation or migration; inspect the deploy log.',
  report_missing: 'The deploy process exited without a final lifecycle report; inspect the deploy log.',
  process_failed: 'The deploy process failed after its lifecycle report; inspect the deploy log.',
  bundle_invalid: 'Bundle sha256 mismatch or manifest/archive validation failed; deploy was not started.',
  disk_preflight_failed: 'Insufficient scratch space for extraction; deploy was not started.',
  server_bind_failed: 'The private deploy server could not bind its port; deploy was not started.',
  interrupted: 'The supervisor was interrupted before deploy started.',
  interrupted_deploy: 'The deploy was interrupted; inspect the deploy log and final service state.',
  supervisor_failed: 'The supervisor failed; inspect the deploy log and service state.',
  receipt_persistence_failed: 'Final receipt publication is unconfirmed; recovery status requires operator inspection.',
});
const verdictReasons = { success: 'verified', unverified: 'unverified', 'auto-rollback': 'rollback_verified', 'incomplete-recovery': 'recovery_incomplete', hold: 'services_held', refused: 'deploy_refused', failed: 'deploy_failed', pending: 'pending' };
const stamp = value => /^[a-zA-Z0-9_-]{1,100}$/.test(value || '') ? value : 'unknown';
function encode(record) {
  const reason = Object.hasOwn(reasons, record.reason_code) ? record.reason_code : 'supervisor_failed';
  return Object.entries({ schema: 'osi-deploy-result/1', state: record.state || 'complete', exit_code: record.exit_code, deploy_exit_code: record.deploy_exit_code ?? '', verdict: record.verdict,
    payload_stamp: stamp(record.payload_stamp), active_payload_stamp: stamp(record.active_payload_stamp),
    bundle_sha256: /^[a-f0-9]{64}$/.test(record.bundle_sha256 || '') ? record.bundle_sha256 : 'unknown',
    identityd_state: ['running', 'stopped'].includes(record.identityd_state) ? record.identityd_state : 'unknown',
    publication: 'guarded/1', service_state: ['running', 'stopped'].includes(record.service_state) ? record.service_state : 'unknown', reason_code: reason, reason: reasons[reason],
  }).map(([key, value]) => `${key}=${value}\n`).join('');
}
function durableWrite(file, bytes, io = fs) {
  const temp = `${file}.tmp-${process.pid}`;
  let fd;
  try {
    fd = io.openSync(temp, 'wx', 0o600);
    io.writeFileSync(fd, bytes);
    io.fsyncSync(fd);
    io.closeSync(fd); fd = undefined;
    io.renameSync(temp, file);
    const dir = io.openSync(path.dirname(file), fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
    try { io.fsyncSync(dir); } finally { io.closeSync(dir); }
  } finally {
    if (fd !== undefined) io.closeSync(fd);
    try { io.unlinkSync(temp); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
}
class Receipts {
  constructor(file, io = fs) { this.file = file; this.reserve = `${file}.recovery`; this.guard = `${file}.publishing`; this.io = io; }
  prepare() {
    // Preallocate the fail-closed receipt before allowing activation. Completing
    // a deploy on a full filesystem needs no new data blocks for this fallback.
    durableWrite(this.reserve, encode({ verdict: 'incomplete-recovery', exit_code: 74, reason_code: 'receipt_persistence_failed' }), this.io);
    this.io.mkdirSync(this.guard, { mode: 0o700 });
    const guard = this.io.openSync(this.guard, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
    try { this.io.fsyncSync(guard); } finally { this.io.closeSync(guard); }
    const dir = this.io.openSync(path.dirname(this.file), fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
    try { this.io.fsyncSync(dir); } finally { this.io.closeSync(dir); }
    durableWrite(this.file, encode({ state: 'pending', verdict: 'pending', exit_code: 125, reason_code: 'pending' }), this.io);
  }
  finish(record) {
    try {
      durableWrite(this.file, encode(record), this.io);
      // Only remove the guard after the receipt file AND directory fsync have
      // succeeded. Removal exposes an already durable result. Readers sync the
      // directory themselves before acknowledging it, including on reconnect.
      this.io.rmdirSync(this.guard);
      return record.exit_code;
    }
    catch (error) {
      console.error('ERROR: receipt publication failed:', error);
      // If fsync/rename also fails here, the caller still cannot acknowledge
      // success. The already durable .recovery file remains readable.
      try {
        const fallback = `${this.file}.fallback-${process.pid}`;
        this.io.linkSync(this.reserve, fallback);
        this.io.renameSync(fallback, this.file);
        const fd = this.io.openSync(path.dirname(this.file), fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
        try { this.io.fsyncSync(fd); } finally { this.io.closeSync(fd); }
      } catch (fallback) { console.error('ERROR: receipt fallback failed:', fallback); }
      return 74;
    }
  }
}
function readReceipt(file, observedCode, io = fs) {
  const recovery = () => {
    try { return { text: io.readFileSync(`${file}.recovery`, 'utf8'), code: 74 }; }
    catch { return { text: encode({ verdict: 'incomplete-recovery', exit_code: 74, reason_code: 'receipt_persistence_failed' }), code: 74 }; }
  };
  try {
    if (observedCode === 125) return { text: encode({ state: 'pending', verdict: 'pending', exit_code: 125, reason_code: 'supervisor_failed' }), code: 125 };
    if (observedCode === 74) return recovery();
    const text = io.readFileSync(file, 'utf8');
    if (!/^state=complete$/m.test(text)) return { text, code: 125 };
    if (!/^publication=guarded\/1$/m.test(text)) return recovery();
    if (io.existsSync(`${file}.publishing`)) return recovery();
    const dir = io.openSync(path.dirname(file), fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
    try { io.fsyncSync(dir); } finally { io.closeSync(dir); }
    if (io.existsSync(`${file}.publishing`)) return recovery();
    const code = Number(/^exit_code=(\d+)$/m.exec(text)?.[1] ?? 125);
    if (observedCode !== undefined && observedCode !== code) return { text: encode({ state: 'pending', verdict: 'pending', exit_code: 125, reason_code: 'supervisor_failed' }), code: 125 };
    return { text, code };
  } catch { return recovery(); }
}
function outcome(file, rc, bundleHash) {
  let fields = {};
  try { fields = Object.fromEntries(fs.readFileSync(file, 'utf8').trim().split('\n').map(line => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)]; })); } catch (e) { if (e.code !== 'ENOENT') console.error(e); }
  const valid = fields.schema === 'osi-deploy-result/1' && fields.state === 'complete' && Object.hasOwn(verdictReasons, fields.verdict) && fields.verdict !== 'pending';
  let verdict = valid ? fields.verdict : rc ? 'failed' : 'unverified';
  let reason = valid ? verdictReasons[verdict] : 'report_missing';
  if (rc && ['success', 'unverified'].includes(verdict)) { verdict = 'failed'; reason = 'process_failed'; }
  return { ...fields, state: 'complete', verdict, reason_code: reason, exit_code: rc || (verdict === 'success' ? 0 : verdict === 'unverified' ? 3 : 1), deploy_exit_code: rc, bundle_sha256: bundleHash };
}
function config(args) {
  const cfg = { port: 9876, wait: false };
  while (args.length) {
    const arg = args.shift();
    if (arg === '--wait') cfg.wait = true;
    else if (arg === '--expected-sha256') { if (cfg.expectedSha) throw new Error('duplicate expected digest'); cfg.expectedSha = args.shift(); }
    else if (arg === '--port') cfg.port = Number(args.shift());
    else if (arg.startsWith('--port=')) cfg.port = Number(arg.slice(7));
    else if (!arg.startsWith('-') && !cfg.bundle) cfg.bundle = path.resolve(arg);
    else throw new Error('usage: deploy-offline.sh <bundle.tar.gz> [--port N] [--wait]');
  }
  if (!cfg.bundle || !Number.isInteger(cfg.port) || cfg.port < 1 || cfg.port > 65535) throw new Error('invalid bundle or port');
  cfg.ts = process.env.DEPLOY_OFFLINE_TS || `${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z/, 'Z')}-${process.pid}`;
  if (!/^[a-zA-Z0-9_-]+$/.test(cfg.ts)) throw new Error('invalid run stamp');
  cfg.logDir = path.resolve(process.env.DEPLOY_OFFLINE_LOG_DIR || '/data');
  cfg.tmpRoot = path.resolve(process.env.DEPLOY_OFFLINE_TMP_ROOT || '/tmp');
  cfg.extract = path.join(cfg.tmpRoot, `deploy-bundle-${cfg.ts}`);
  cfg.private = path.join(cfg.logDir, `.deploy-${cfg.ts}`);
  cfg.log = path.join(cfg.logDir, `deploy-${cfg.ts}.log`);
  cfg.result = path.join(cfg.logDir, `deploy-${cfg.ts}.result`);
  if (!fs.existsSync(cfg.bundle)) throw new Error('bundle not found');
  cfg.expectedSha ||= fs.readFileSync(process.env.DEPLOY_OFFLINE_SHA256 || `${cfg.bundle}.sha256`, 'utf8').trim().split(/\s+/)[0];
  if (!/^[a-f0-9]{64}$/.test(cfg.expectedSha)) throw new Error('sha256 mismatch: invalid expected digest');
  return cfg;
}
const signalStatus = signal => 128 + (osConstants.signals[signal] || 0);
async function supervise(cfg, hooks = {}) {
  let child, server, interrupted;
  let phase = 'bundle_invalid';
  let bundleHash;
  const receipt = new Receipts(cfg.result);
  const outcomeFile = path.join(cfg.private, 'outcome');
  const notify = message => { if (process.connected) process.send(message, () => {}); };
  for (const signal of ['SIGHUP', 'SIGTERM', 'SIGINT']) process.on(signal, () => {
    interrupted ||= signal;
    if (child) {
      // The child owns its process group. Its shell traps run the real recovery
      // handler; this supervisor remains alive until that handler has exited.
      try { process.kill(-child.pid, signal); } catch (e) { if (e.code !== 'ESRCH') console.error(e); }
    }
  });
  // Backstop: an exception that escapes every local handler must neither kill
  // this process (which owns the server, signal forwarding and the receipt)
  // nor let the receipt stay at state=running. The supervisor keeps waiting
  // for a running deploy and then publishes a non-success verdict.
  let fault = false, launched = false, raiseFault;
  const faulted = new Promise((resolve, reject) => { raiseFault = reject; });
  faulted.catch(() => {});
  const onFault = error => {
    const code = /^[A-Z][A-Z0-9_]{0,63}$/.test(error?.code || '') ? error.code : 'uncaught';
    console.error(`ERROR: offline supervisor fault (${code}); the final receipt reports supervisor_failed`);
    if (!fault) { fault = true; raiseFault(new Error('supervisor fault')); }
  };
  process.on('uncaughtException', onFault);
  process.on('unhandledRejection', onFault);
  // Steps before the deploy starts give up on a fault; the deploy itself is
  // always waited for, because its own traps run the recovery.
  const guarded = promise => Promise.race([promise, faulted]);
  let record;
  try {
    fs.mkdirSync(cfg.private, { mode: 0o700 });
    receipt.prepare();
    fs.writeFileSync(path.join(cfg.private, 'supervisor.pid'), String(process.pid), { mode: 0o600 });
    const bytes = fs.readFileSync(cfg.bundle);
    bundleHash = hash(bytes);
    if (bundleHash !== cfg.expectedSha) throw new Error('sha256 mismatch');
    const tree = verifiedBundle(bytes);
    // All archive entries (including its verifier) were checked by trusted
    // launcher code before extraction, execution or serving.
    phase = 'disk_preflight_failed';
    const space = fs.statfsSync(cfg.tmpRoot);
    if (space.bavail * space.bsize < bytes.length * 3 + 4 * 1024 * 1024) throw new Error('insufficient extraction space');
    extract(tree, cfg.extract);
    console.log(`OK: extracted and verified ${cfg.extract}`);
    phase = 'server_bind_failed';
    const serverLog = fs.openSync(path.join(cfg.extract, '.local-server.log'), 'a', 0o600);
    const nonce = crypto.randomBytes(24).toString('hex');
    server = createVerifiedServer(tree.files, { hashes: tree.hashes, nonce, log: hooks.accessLog || (line => fs.writeSync(serverLog, `${line}\n`)) });
    await guarded(new Promise((resolve, reject) => { server.once('error', reject); server.listen(cfg.port, '127.0.0.1', resolve); }));
    fs.writeSync(serverLog, `READY http://127.0.0.1:${cfg.port} root=${cfg.extract}\n`);
    fs.writeFileSync(path.join(cfg.extract, '.local-server.pid'), String(process.pid), { mode: 0o600 });
    // Probe this instance, never a pre-existing listener on the same port.
    await guarded(new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: cfg.port, path: '/deploy.sh', method: 'HEAD' }, res => {
        res.resume(); res.on('end', () => res.statusCode === 200 && res.headers['x-deploy-instance'] === nonce ? resolve() : reject(new Error('wrong server instance')));
      }); req.on('error', reject); req.end();
    }));
    phase = 'supervisor_failed';
    if (hooks.beforeDeploy) await guarded(Promise.resolve(hooks.beforeDeploy()));
    await guarded(new Promise(resolve => setImmediate(resolve)));
    if (fault) throw new Error('supervisor fault before deploy start');
    if (interrupted) record = { verdict: 'interrupted', exit_code: signalStatus(interrupted), reason_code: 'interrupted' };
    else {
      durableWrite(cfg.result, encode({ state: 'running', verdict: 'pending', exit_code: 125, bundle_sha256: bundleHash, reason_code: 'pending' }));
      // The deploy's stdin is the very deploy.sh buffer already verified. Its
      // Keep argv[0] as sh: BusyBox selects its applet from that name. The
      // second positional argument identifies this run in /proc for operators.
      child = spawn('sh', ['-s', '--', String(cfg.port), path.join(cfg.extract, 'deploy.sh')], { detached: true, stdio: ['pipe', process.stdout, process.stderr], env: { ...process.env, DEPLOY_OFFLINE_MODE: '1', DEPLOY_OUTCOME_FILE: outcomeFile, DEPLOY_LOGFILE: cfg.log, DEPLOY_BUNDLE_SHA256: bundleHash } });
      child.stdin.on('error', e => { if (e.code !== 'EPIPE') console.error(e); });
      child.stdin.end(tree.files.get('deploy.sh'));
      launched = true;
      notify({ launched: true });
      const rc = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve(code ?? signalStatus(signal))); });
      child = undefined;
      record = outcome(outcomeFile, rc, bundleHash);
      if (interrupted && record.verdict === 'refused') record = { ...record, verdict: 'interrupted', reason_code: 'interrupted_deploy' };
    }
  } catch (error) {
    console.error('ERROR: offline supervisor:', error);
    record = { verdict: interrupted ? 'interrupted' : phase === 'supervisor_failed' ? 'incomplete-recovery' : 'refused', exit_code: interrupted ? signalStatus(interrupted) : 1, reason_code: interrupted ? 'interrupted' : phase, bundle_sha256: bundleHash };
  }
  if (fault) {
    // Fail closed: a supervisor that faulted cannot vouch for the result. A
    // proven hold keeps its DEPLOY-HELD pointer; before the deploy started,
    // nothing ran.
    if (!launched) record = { verdict: interrupted ? 'interrupted' : 'refused', exit_code: interrupted ? signalStatus(interrupted) : 1, reason_code: interrupted ? 'interrupted' : 'supervisor_failed', bundle_sha256: bundleHash };
    else if (record.verdict !== 'hold') record = { ...record, verdict: 'incomplete-recovery', exit_code: 1, reason_code: 'supervisor_failed' };
  }
  try { if (server?.listening) await new Promise(resolve => { server.close(resolve); server.closeAllConnections?.(); }); }
  catch (error) { console.error('WARN: deploy server close:', error); }
  const code = receipt.finish(record);
  // Compatibility marker is best effort; --wait observes supervisor exit and
  // cannot be stranded by a full /tmp or a failed marker write.
  try { fs.writeFileSync(path.join(cfg.extract, '.deploy.rc'), `${code}\n`, { mode: 0o600 }); } catch (e) { console.error('WARN: completion marker:', e); }
  notify({ complete: true, code });
  if (process.connected) process.disconnect();
  process.removeListener('uncaughtException', onFault);
  process.removeListener('unhandledRejection', onFault);
  return code;
}
async function launch(cfg, hooks = {}) {
  if (!fs.existsSync(cfg.bundle) || !fs.statSync(cfg.bundle).isFile()) throw new Error('bundle not found');
  fs.mkdirSync(cfg.logDir, { recursive: true }); fs.mkdirSync(cfg.tmpRoot, { recursive: true });
  if ([cfg.private, cfg.result, cfg.extract].some(file => fs.existsSync(file))) throw new Error('deploy run already exists; choose a new run stamp');
  const log = fs.openSync(cfg.log, 'wx', 0o600);
  for (const signal of ['SIGHUP', 'SIGTERM', 'SIGINT']) process.on(signal, () => process.exit(signalStatus(signal)));
  const child = spawn(process.execPath, [__filename, 'supervise', JSON.stringify(cfg)], { detached: true, stdio: ['ignore', log, log, 'ipc'] });
  if (hooks.supervisorSpawned) child.once('spawn', () => hooks.supervisorSpawned(child));
  fs.closeSync(log);
  console.log(`Log: ${cfg.log}\nFollow it with: tail -f '${cfg.log}'\nRaw candidate (unacknowledged): ${cfg.result}\nRead result: sh '${path.join(__dirname, 'deploy-offline.sh')}' --result '${cfg.result}'`);
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (status, signal) => resolve(status ?? (signal ? 125 : 1)));
    child.on('message', message => {
      if (message.launched) {
        console.log('=== Deploy launched (immune to this session dropping) ===');
        if (!cfg.wait) { child.disconnect(); child.unref(); resolve(0); }
      }
    });
  });
  if (cfg.wait || code) {
    const result = readReceipt(cfg.result, code);
    process.stdout.write(result.text);
    if (result.code) console.error(/^reason=(.*)$/m.exec(result.text)?.[1] || reasons.supervisor_failed);
    return result.code;
  }
  return code;
}
async function main(args) {
  if (args[0] === 'supervise') return supervise(JSON.parse(args[1]));
  if (args[0] === '--result' && args.length === 2) {
    const result = readReceipt(args[1]);
    process.stdout.write(result.text);
    return result.code;
  }
  return launch(config(args));
}
if (require.main === module) main(process.argv.slice(2)).then(code => { process.exitCode = code; }, error => { console.error(`ERROR: ${error.message}`); process.exitCode = 1; });
module.exports = { readReceipt, durableWrite, Receipts, encode, outcome, reasons, supervise, launch, config };
