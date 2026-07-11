#!/usr/bin/env node
'use strict';

// Deploy canary gate, refactor-program item 0.2.
// Polls osi-server's admin sync-health endpoint and refuses to advance a
// staged rollout until the target gateway reports N consecutive healthy
// post-deploy heartbeats.

const http = require('node:http');
const https = require('node:https');

const DEFAULTS = {
  consecutive: 5,
  intervalMs: 60000,
  timeoutMs: 900000,
  minDiskFreePct: 10,
};

function requireAdminToken(token) {
  if (!token) throw new Error('Set OSI_ADMIN_TOKEN to run this script.');
  return token;
}

function fetchSyncHealth(serverBase, eui, adminToken) {
  return new Promise((resolve, reject) => {
    const url = new URL(
      `/api/v1/admin/sync-health?gatewayEui=${encodeURIComponent(eui)}&limit=1`,
      serverBase
    );
    const client = url.protocol === 'http:' ? http : https;
    const req = client.request(
      {
        method: 'GET',
        hostname: url.hostname,
        port: url.port || undefined,
        path: url.pathname + url.search,
        headers: { Authorization: `Bearer ${adminToken}` },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => {
          if (res.statusCode === 401 || res.statusCode === 403) {
            reject(new Error(`auth failure: HTTP ${res.statusCode}`));
            return;
          }
          if (res.statusCode !== 200) {
            reject(new Error(`sync-health HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
            return;
          }
          try {
            resolve(JSON.parse(body));
          } catch (err) {
            reject(new Error(`sync-health response was not valid JSON: ${err.message}`));
          }
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

function asReasons(edgeHealth, ctx) {
  const reasons = Array.isArray(edgeHealth.reasons) ? [...edgeHealth.reasons] : [];
  if (ctx.expectSchemaSig && edgeHealth.schemaSig === ctx.expectSchemaSig) {
    return reasons.filter((reason) => reason !== 'schema_sig_not_accepted');
  }
  return reasons;
}

function evaluatePoll(body, ctx) {
  const reasons = [];
  const gateway = (body.gateways || []).find((g) => g.gatewayEui === ctx.eui);
  if (!gateway) return { pass: false, reasons: ['gateway_not_found'] };

  const heartbeatAgeSeconds = Number(gateway.heartbeatAgeSeconds);
  if (!Number.isFinite(heartbeatAgeSeconds) || heartbeatAgeSeconds > 120) {
    reasons.push('heartbeat_stale');
  }

  const recordedAtMs = Date.parse(gateway.currentStateRecordedAt || '');
  if (!Number.isFinite(recordedAtMs) || recordedAtMs < ctx.sinceMs) {
    reasons.push('heartbeat_before_deploy');
  }

  const edgeHealth = gateway.edgeHealth || {};
  for (const reason of asReasons(edgeHealth, ctx)) reasons.push(reason);
  if (ctx.expectSchemaSig && edgeHealth.schemaSig !== ctx.expectSchemaSig) {
    reasons.push('schema_sig_mismatch');
  }

  const diskFreePct = Number(edgeHealth.diskFreePct);
  if (Number.isFinite(diskFreePct) && diskFreePct < ctx.minDiskFreePct
      && !reasons.includes('disk_free_low')) {
    reasons.push('disk_free_low');
  }

  const errorsTotal = Number(edgeHealth.errorsTotal);
  if (Number.isFinite(ctx.errorsBaseline) && Number.isFinite(errorsTotal)
      && errorsTotal > ctx.errorsBaseline) {
    reasons.push('errors_total_increased');
  }

  return { pass: reasons.length === 0, reasons };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runGate(opts) {
  const consecutive = opts.consecutive ?? DEFAULTS.consecutive;
  const intervalMs = opts.intervalMs ?? DEFAULTS.intervalMs;
  const timeoutMs = opts.timeoutMs ?? DEFAULTS.timeoutMs;
  const minDiskFreePct = opts.minDiskFreePct ?? DEFAULTS.minDiskFreePct;
  const sinceMs = Date.parse(opts.since);
  if (!Number.isFinite(sinceMs)) {
    throw new Error(`--since is not a valid ISO8601 timestamp: ${opts.since}`);
  }

  const deadline = Date.now() + timeoutMs;
  let consecutivePasses = 0;
  let errorsBaseline = null;
  let lastReasons = ['timeout_no_poll_completed'];

  while (Date.now() < deadline) {
    const body = await fetchSyncHealth(opts.server, opts.eui, opts.adminToken);
    const gateway = (body.gateways || []).find((g) => g.gatewayEui === opts.eui);
    const errorsTotal = gateway && gateway.edgeHealth
      ? Number(gateway.edgeHealth.errorsTotal)
      : NaN;
    if (errorsBaseline === null && Number.isFinite(errorsTotal)) {
      errorsBaseline = errorsTotal;
    }

    const { pass, reasons } = evaluatePoll(body, {
      eui: opts.eui,
      sinceMs,
      nowMs: Date.now(),
      minDiskFreePct,
      expectSchemaSig: opts.expectSchemaSig,
      errorsBaseline,
    });
    lastReasons = reasons.length ? reasons : lastReasons;

    if (pass) {
      consecutivePasses += 1;
      if (consecutivePasses >= consecutive) {
        return { ok: true, reasons: [] };
      }
    } else {
      consecutivePasses = 0;
      errorsBaseline = null;
    }

    if (Date.now() + intervalMs >= deadline) break;
    await sleep(intervalMs);
  }

  return { ok: false, reasons: lastReasons };
}

function requireValue(argv, index, flag) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function parseArgs(argv) {
  const out = {
    consecutive: DEFAULTS.consecutive,
    intervalMs: DEFAULTS.intervalMs,
    timeoutMs: DEFAULTS.timeoutMs,
    minDiskFreePct: DEFAULTS.minDiskFreePct,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--eui') out.eui = requireValue(argv, i++, arg);
    else if (arg === '--since') out.since = requireValue(argv, i++, arg);
    else if (arg === '--server') out.server = requireValue(argv, i++, arg);
    else if (arg === '--expect-schema-sig') out.expectSchemaSig = requireValue(argv, i++, arg);
    else if (arg === '--consecutive') out.consecutive = Number(requireValue(argv, i++, arg));
    else if (arg === '--interval') out.intervalMs = Number(requireValue(argv, i++, arg)) * 1000;
    else if (arg === '--timeout') out.timeoutMs = Number(requireValue(argv, i++, arg)) * 1000;
    else if (arg === '--min-disk-free-pct') out.minDiskFreePct = Number(requireValue(argv, i++, arg));
    else throw new Error(`unknown argument: ${arg}`);
  }
  return out;
}

function validateNumber(name, value) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
    if (!opts.eui) throw new Error('--eui <EUI> is required');
    if (!opts.since) throw new Error('--since <ISO8601 deploy timestamp> is required');
    validateNumber('--consecutive', opts.consecutive);
    validateNumber('--interval', opts.intervalMs);
    validateNumber('--timeout', opts.timeoutMs);
    validateNumber('--min-disk-free-pct', opts.minDiskFreePct);
    opts.server = opts.server || process.env.OSI_SERVER_BASE_URL || 'https://server.opensmartirrigation.org';
    opts.adminToken = requireAdminToken(process.env.OSI_ADMIN_TOKEN);
  } catch (err) {
    console.error(`[deploy-canary-gate] usage error: ${err.message}`);
    process.exit(2);
  }

  try {
    const result = await runGate(opts);
    if (result.ok) {
      console.log(`[deploy-canary-gate] PASS - ${opts.eui} healthy for ${opts.consecutive} consecutive polls`);
      process.exit(0);
    }
    console.error(`[deploy-canary-gate] FAIL - reasons: ${result.reasons.join(', ')}`);
    process.exit(1);
  } catch (err) {
    console.error(`[deploy-canary-gate] transport/auth error: ${err.message}`);
    process.exit(2);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  evaluatePoll,
  fetchSyncHealth,
  parseArgs,
  requireAdminToken,
  runGate,
};
