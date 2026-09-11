#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const { syncFingerprints, sortFps, readStoredFingerprints } = require('../lib/osi-migrate/runner');
const { computeFingerprints, PREVIOUS_NORMALIZER_VERSION, NORMALIZER_VERSION } = require('../lib/osi-migrate/fingerprints');
const { cliRunner } = require('../lib/osi-migrate/runner-iface');

// Report mode (osi-os#212 deliverable b): today this script restamps
// UNCONDITIONALLY on invocation, with no way to first ask "would this even
// change anything?" without mutating the DB. `--report` answers that
// read-only, printing stored-vs-live diffs under BOTH the current
// (NORMALIZER_VERSION) and previous (PREVIOUS_NORMALIZER_VERSION) schemes —
// mirroring the two-tier check runner.js's drift preflight already performs
// (see lib/osi-migrate/runner.js `isPureNormalizerSchemeUpgrade`) — and never
// writes schema_object_fingerprints. Exit 0 when there is nothing a restamp
// would actually change (no diffs at all, or the only diffs are explained by
// the normalizer version having advanced since the last stamp); exit 1 when
// real diffs remain even under the previous scheme, meaning an `--apply`
// restamp would actually launder something an operator should look at first.
//
// The default (no flags) behaviour is UNCHANGED and remains the sanctioned,
// backward-compatible recovery verb documented throughout
// osi-schema-change-control and osi-live-ops-runbook, and referenced verbatim
// (`node scripts/restamp-fingerprints.js <db>`) by runner.js's own drift
// refusal message: it still restamps unconditionally on a bare
// `restamp-fingerprints.js <db>` call. `--apply` is accepted as an explicit,
// equivalent alias for that default so a caller that wants to be unambiguous
// (e.g. a future deploy.sh invocation) can say so; it is optional, not
// required, precisely so every existing positional call site (docs, the
// runner's own error text, on-call muscle memory) keeps working unchanged.
function diffFingerprints(storedRows, liveRows) {
  const storedByKey = new Map(storedRows.map((f) => [`${f.object_type}|${f.object_name}`, f.fingerprint]));
  const liveByKey = new Map(liveRows.map((f) => [`${f.object_type}|${f.object_name}`, f.fingerprint]));
  const diffs = [];
  for (const [key, liveFp] of liveByKey) {
    const storedFp = storedByKey.get(key);
    if (storedFp === undefined) diffs.push({ key, kind: 'extra (live-only)' });
    else if (storedFp !== liveFp) diffs.push({ key, kind: 'changed' });
  }
  for (const key of storedByKey.keys()) {
    if (!liveByKey.has(key)) diffs.push({ key, kind: 'missing (stored-only)' });
  }
  return diffs.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

async function runReport(dbPath, log = console.error) {
  const runner = cliRunner(dbPath);
  const stored = await readStoredFingerprints(runner);
  const liveCurrent = sortFps(await computeFingerprints(runner, { normalizerVersion: NORMALIZER_VERSION }));
  const livePrevious = sortFps(await computeFingerprints(runner, { normalizerVersion: PREVIOUS_NORMALIZER_VERSION }));
  const diffsCurrent = diffFingerprints(stored, liveCurrent);
  const diffsPrevious = diffFingerprints(stored, livePrevious);

  log(`[restamp --report] ${dbPath}`);
  log(`[restamp --report] stored=${stored.length} live(current normalizer v${NORMALIZER_VERSION})=${liveCurrent.length} diffs=${diffsCurrent.length}`);
  for (const d of diffsCurrent) log(`  [current] ${d.kind}: ${d.key}`);
  log(`[restamp --report] live(previous normalizer v${PREVIOUS_NORMALIZER_VERSION}) diffs=${diffsPrevious.length}`);
  for (const d of diffsPrevious) log(`  [previous] ${d.kind}: ${d.key}`);

  const onlyNormalizerAdvanced = diffsCurrent.length > 0 && diffsPrevious.length === 0;
  if (diffsCurrent.length === 0) {
    log('[restamp --report] no diffs under the current normalizer; a restamp would be a no-op.');
  } else if (onlyNormalizerAdvanced) {
    log('[restamp --report] diffs under the current normalizer are fully explained by the normalizer version bump alone (stored fingerprints match live under the previous scheme, osi-os#153); a restamp is safe.');
  } else {
    log('[restamp --report] real diffs remain even under the previous normalizer; a restamp would launder them — investigate before running --apply.');
  }
  return { diffsCurrent, diffsPrevious, ok: diffsCurrent.length === 0 || onlyNormalizerAdvanced };
}

function parseArgs(argv) {
  const opts = { dbPath: null, report: false, apply: false };
  for (const a of argv) {
    if (a === '--report') opts.report = true;
    else if (a === '--apply') opts.apply = true;
    else if (!opts.dbPath) opts.dbPath = a;
    else throw new Error(`unknown argument: ${a}`);
  }
  return opts;
}

async function main() {
  const { dbPath, report } = parseArgs(process.argv.slice(2));
  if (!dbPath) {
    console.error('usage: restamp-fingerprints.js <path-to-farming.db> [--report | --apply]');
    console.error('Default (no flags) and --apply both re-baseline schema_object_fingerprints to the CURRENT live schema.');
    console.error('--report only prints stored-vs-live diffs (current + previous normalizer); it never writes.');
    process.exit(2);
  }
  if (!fs.existsSync(dbPath)) {
    // sqlite3 would otherwise CREATE an empty DB for a typoed path and restamp THAT,
    // silently "succeeding" while the real target is left untouched.
    console.error(`[restamp] refusing: database file does not exist: ${dbPath}`);
    process.exit(2);
  }
  if (report) {
    const { ok } = await runReport(dbPath);
    process.exit(ok ? 0 : 1);
    return;
  }
  const runner = cliRunner(dbPath);
  console.error(`[restamp] re-baselining fingerprints for ${dbPath} to the current live schema`);
  await syncFingerprints(runner);
  console.error('[restamp] done. Run verifyHead to confirm ok:true.');
}
if (require.main === module) {
  main().catch((e) => { console.error(`[restamp] FAILED: ${e.message}`); process.exit(1); });
}

module.exports = { parseArgs, runReport, diffFingerprints };
