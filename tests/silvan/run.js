#!/usr/bin/env node
'use strict';
// Silvan end-to-end harness runner.
//
//   node tests/silvan/run.js --cases A1,Z1 --out /tmp/silvan-run
//   node tests/silvan/run.js --list
//
// Exits non-zero if any selected case fails. See tests/silvan/README.md.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const {
  Ctx, config, assertSilvanViaSsh, assertSilvanViaApi,
  Ssh, Rest, DownlinkObserver, readGatewayEnv, readDeployedFlows,
} = require('./lib/harness');
const { makeProfiles } = require('./lib/uplinks');
const { CaseEvidence, writeRunSummary } = require('./lib/evidence');

const CASES = [
  { id: 'A1', file: './cases/A1-accounts.js' },
  { id: 'A2', file: './cases/A2-roles.js' },
  { id: 'Z1', file: './cases/Z1-zones-devices.js' },
  { id: 'Z2', file: './cases/Z2-zones-invalid.js' },
  { id: 'V1', file: './cases/V1-valve-actions.js' },
  { id: 'V2', file: './cases/V2-valve-acks.js' },
  { id: 'S1', file: './cases/S1-schedules.js' },
  { id: 'S2', file: './cases/S2-schedule-boundaries.js' },
  { id: 'P1', file: './cases/P1-precedence.js' },
  { id: 'D1', file: './cases/D1-sensor-data.js' },
  { id: 'ST1', file: './cases/ST1-settings.js' },
  { id: 'C1', file: './cases/C1-sync-outbox.js' },
  { id: 'R1', file: './cases/R1-runtime-recovery.js' },
  { id: 'U1', file: './ui/smoke.js' },
];

function parseArgs(argv) {
  const out = { cases: null, out: null, list: false, keep: false, user: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--cases') out.cases = String(argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--list') out.list = true;
    else if (a === '--keep') out.keep = true;             // skip cleanup (debugging only)
    else if (a === '--user') out.user = argv[++i];        // reuse an existing account instead of registering
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error('unknown argument: ' + a);
  }
  return out;
}

function usage() {
  console.log([
    'Usage: node tests/silvan/run.js [--cases A1,Z1] [--out DIR] [--user NAME] [--keep] [--list]',
    '',
    '  --cases   comma-separated case ids (default: all)',
    '  --out     run directory for evidence (default: ./silvan-run-<timestamp>)',
    '  --user    reuse an existing gateway account (token is minted on the Pi)',
    '            instead of registering a throwaway harness account',
    '  --keep    leave created resources on the gateway (debugging only)',
    '  --list    print the case list and exit',
  ].join('\n'));
}

function gitCommit() {
  try {
    return execFileSync('git', ['-C', __dirname, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch (_) { return 'unknown'; }
}

// Mints a throwaway, short-lived, read-only identity token so the API identity
// guard can run BEFORE the first mutation.
//
// /api/sync/state is bearer-gated, but its handler does `userRows[0] || {}` --
// it tolerates a token whose user does not exist and still returns
// gatewayIdentity.currentEui. That matters: a freshly deployed gateway has an
// EMPTY users table, so there is no real account to borrow, and registering one
// first would mean mutating a gateway whose HTTP identity is still unverified.
//
// The token is signed with the gateway's own secret (computed on the Pi, never
// copied off it) and expires in 60 seconds.
async function mintIdentityProbeToken(ssh) {
  return ssh.mintToken({
    userId: 0,
    username: 'osi-harness-identity-probe',
    iat: Date.now(),
    exp: Date.now() + 60 * 1000,
  });
}

// Authenticates the run. Assumes NOTHING about existing gateway state: a freshly
// deployed gateway has an empty users table, so the default path registers its
// own throwaway account through the real /auth/register + /auth/login routes.
async function bootstrapAuth(rest, ssh, ev, opts) {
  if (opts.user) {
    const row = await ssh.sqlOne(
      "SELECT id, username FROM users WHERE username = '" + String(opts.user).replace(/'/g, "''") + "' LIMIT 1"
    );
    if (!row) throw new Error('--user ' + opts.user + ' does not exist on the gateway');
    const token = await ssh.mintToken({ userId: row.id, username: row.username });
    return { username: row.username, userId: row.id, token, password: null, created: false };
  }

  const runId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const username = 'osi_harness_' + runId;
  const password = 'Hx' + require('node:crypto').randomBytes(12).toString('base64url');

  let reg = await rest.post('/auth/register', { username, password });
  if (reg.status !== 201) {
    throw new Error('harness account registration failed: ' + reg.status + ' ' + JSON.stringify(reg.body));
  }
  const login = await rest.post('/auth/login', { username, password });
  if (login.status !== 200 || !login.body || !login.body.token) {
    throw new Error('harness account login failed: ' + login.status + ' ' + JSON.stringify(login.body));
  }
  const row = await ssh.sqlOne("SELECT id FROM users WHERE username = '" + username + "' LIMIT 1");
  return { username, userId: row ? row.id : null, token: login.body.token, password, created: true };
}

async function main() {
  const opts = parseArgs(process.argv);
  if (opts.help) { usage(); return 0; }
  if (opts.list) {
    for (const c of CASES) {
      const mod = require(c.file);
      console.log(c.id.padEnd(4) + ' ' + mod.title);
    }
    return 0;
  }

  const selected = opts.cases ? CASES.filter((c) => opts.cases.includes(c.id)) : CASES;
  if (!selected.length) throw new Error('no matching cases; try --list');
  const unknown = (opts.cases || []).filter((id) => !CASES.some((c) => c.id === id));
  if (unknown.length) throw new Error('unknown case id(s): ' + unknown.join(', '));

  const runDir = path.resolve(opts.out || ('silvan-run-' + new Date().toISOString().replace(/[:.]/g, '-')));
  fs.mkdirSync(runDir, { recursive: true });

  const cfg = config();
  const ssh = new Ssh(cfg);

  // GUARD 1 (pre-flight, read-only, before any HTTP call): the gateway's own
  // configured EUI must be Silvan's.
  const sshEui = await assertSilvanViaSsh(ssh);
  console.log('EUI guard (ssh): ' + sshEui + ' OK');

  const transcript = [];
  const anonRest = new Rest(cfg.apiBase, { transcript });

  // GUARD 2 (over the tunnel, still BEFORE any mutation): the HTTP endpoint must
  // be the same gateway the SSH guard just verified. This runs before
  // bootstrapAuth registers anything, so a tunnel aimed at the wrong Node-RED
  // is caught before this harness writes a single row to it.
  const probeToken = await mintIdentityProbeToken(ssh);
  const apiEui = await assertSilvanViaApi(new Rest(cfg.apiBase, { token: probeToken, transcript }));
  console.log('EUI guard (api): ' + apiEui + ' OK');

  const env = await readGatewayEnv(ssh);
  const deployedFlows = await readDeployedFlows(ssh);
  const profiles = makeProfiles(env);

  // Only now, with both guards green, is the gateway written to.
  const auth = await bootstrapAuth(anonRest, ssh, null, opts);
  const rest = new Rest(cfg.apiBase, { token: auth.token, transcript });
  console.log('harness account: ' + auth.username + (auth.created ? ' (registered by this run)' : ' (existing)'));

  const observer = await new DownlinkObserver({
    cfg, profiles, actuatorsAppId: env.CHIRPSTACK_APP_ACTUATORS,
  }).start();

  const meta = {
    gatewayEui: apiEui,
    sshHost: cfg.sshHost,
    apiBase: cfg.apiBase,
    mqttHost: cfg.mqttHost,
    mqttPort: cfg.mqttPort,
    startedAt: new Date().toISOString(),
    commit: gitCommit(),
    harnessAccount: auth.username,
    scopedAccess: env.OSI_SCOPED_ACCESS === '1',
    deployedFlows,
  };

  const results = [];
  for (const c of selected) {
    const mod = require(c.file);
    const ev = new CaseEvidence(runDir, c.id, mod.title);
    const before = transcript.length;
    const ctx = new Ctx({ cfg, ssh, rest, transcript, evidence: ev, observer, profiles, env, user: auth });
    ctx.runDir = runDir;
    ctx.runSalt = meta.startedAt + '|' + meta.harnessAccount;
    ctx.keep = opts.keep;
    ctx.anonRest = anonRest;

    const startedAt = Date.now();
    process.stdout.write('--- ' + c.id + ' ' + mod.title + ' ... ');
    let error = null;
    try {
      await mod.run(ctx);
    } catch (e) {
      error = e;
      ev.check('case ran to completion', false, e.message);
    } finally {
      if (!opts.keep) {
        try { if (mod.cleanup) await mod.cleanup(ctx); } catch (e) { ev.cleanupStep('case cleanup hook', false, e.message); }
      } else {
        ev.cleanupStep('skipped (--keep)', true);
      }
    }
    ev.http = transcript.slice(before);
    const status = (!error && ev.failedChecks.length === 0) ? 'PASS' : 'FAIL';
    ev.finish(status, error);
    ev.write();
    console.log(status + ' (' + ev.checks.filter((x) => x.passed).length + '/' + ev.checks.length + ' checks)');
    results.push({
      caseId: c.id,
      title: mod.title,
      status,
      passedChecks: ev.checks.filter((x) => x.passed).length,
      totalChecks: ev.checks.length,
      durationMs: Date.now() - startedAt,
      failures: ev.failedChecks,
      error: ev.error,
    });
  }

  await observer.stop();
  meta.finishedAt = new Date().toISOString();
  const summary = writeRunSummary(runDir, meta, results);

  console.log('');
  console.log('Matrix:');
  for (const r of results) {
    console.log('  ' + r.caseId.padEnd(4) + ' ' + (r.status === 'PASS' ? 'PASS' : 'FAIL') +
      '  ' + String(r.passedChecks + '/' + r.totalChecks).padEnd(7) + r.title);
  }
  console.log('');
  console.log('Evidence: ' + summary.mdPath);
  if (auth.created) {
    console.log('NOTE: the harness account "' + auth.username + '" cannot be removed through the API ' +
      '(no DELETE /api/users route exists) and stays on the gateway.');
  }

  return results.some((r) => r.status !== 'PASS') ? 1 : 0;
}

main().then((code) => process.exit(code)).catch((e) => {
  console.error('\nHARNESS ERROR: ' + e.message);
  if (process.env.SILVAN_DEBUG) console.error(e.stack);
  process.exit(2);
});
