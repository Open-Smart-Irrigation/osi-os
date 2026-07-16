#!/usr/bin/env node
'use strict';
// scripts/dev/apply-device-api-auth-tags.js
//
// One-shot, guarded parse-mutate-serialize repair for the Device API auth
// status regression (commit e100c796 made device-api-http500 read
// msg.error.statusCode, which a Node-RED catch message never carries, so
// every shared-catch auth failure came back as HTTP 500 instead of 401).
//
// What this does, mechanically, to the canonical flows.json:
//   1. Verifies the file round-trips byte-for-byte through
//      JSON.parse -> JSON.stringify(parsed, null, 2) + '\n' before touching
//      anything (proves our serializer reproduces Node-RED's own formatting,
//      so any diff after mutation is only the intended change).
//   2. For every function node listed as a distinct `authNodeId` in
//      scripts/fixtures/device-api-auth-routes.json (41 reviewed sources):
//        - inserts `delete msg._osiAuthFailure;` as the first statement of
//          the `verifyBearer` function body;
//        - immediately before every throw whose Error message is exactly
//          'Unauthorized' / 'Invalid token' / 'Token expired' inside that
//          same `verifyBearer` body, inserts
//          `msg._osiAuthFailure = { format: 1, code: '<CODE>', sourceId: '<node id>' };`
//      Nothing else in the node is touched; no new try/catch, no new
//      validation. The tag protocol is added, not the business logic.
//   3. Replaces device-api-http500's func with an exact validator that only
//      trusts `msg._osiAuthFailure` (never `msg.error.statusCode`, never raw
//      message text) and classifies via a closed source allowlist derived
//      from the same fixture.
//   4. Asserts exactly 42 node `func` values changed (41 verifiers + the
//      responder) and every other node serializes identically.
//   5. Mirrors the canonical file byte-for-byte to the bcm2709 profile.
//
// Usage: node scripts/dev/apply-device-api-auth-tags.js [--dry-run]
//
// Safe to run only once: it aborts if the responder already looks patched.

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const CANONICAL_REL = 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json';
const MIRROR_REL = 'conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json';
const FIXTURE_REL = 'scripts/fixtures/device-api-auth-routes.json';
const TAB_ID = 'device-api-tab';
const HTTP500_ID = 'device-api-http500';

const CODE_BY_MESSAGE = {
  Unauthorized: 'MISSING_BEARER',
  'Invalid token': 'INVALID_TOKEN',
  'Token expired': 'TOKEN_EXPIRED',
};

function fail(message) {
  console.error('apply-device-api-auth-tags: FAIL - ' + message);
  process.exit(1);
}

function readJsonExact(relPath) {
  const raw = fs.readFileSync(path.join(ROOT, relPath), 'utf8');
  const parsed = JSON.parse(raw);
  const roundTrip = JSON.stringify(parsed, null, 2) + '\n';
  if (roundTrip !== raw) {
    fail(relPath + ': failed the no-op round-trip guard (serializer does not reproduce the file byte-for-byte); refusing to mutate.');
  }
  return { raw, parsed };
}

// Locate the `function verifyBearer(...) { ... }` span inside a node's func
// source using brace counting (not a single regex) so nested braces inside
// the body cannot truncate the match early.
function findVerifyBearerSpan(func) {
  const startMatch = func.match(/function\s+verifyBearer\s*\([^)]*\)\s*\{/);
  if (!startMatch) return null;
  const bodyStart = startMatch.index + startMatch[0].length; // just after the opening '{'
  let depth = 1;
  let i = bodyStart;
  for (; i < func.length && depth > 0; i += 1) {
    if (func[i] === '{') depth += 1;
    else if (func[i] === '}') depth -= 1;
  }
  if (depth !== 0) return null;
  const bodyEnd = i - 1; // index of the matching closing '}'
  return { headerEnd: startMatch.index + startMatch[0].length, bodyStart, bodyEnd, fnStart: startMatch.index };
}

// Insert `delete msg._osiAuthFailure;` as the first statement of the body,
// and immediately before every throw whose Error carries one of the three
// canonical messages, insert the tag assignment. Handles both throw styles
// observed in the shipped flows.json:
//   Style A: const err = new Error('MSG'); err.statusCode = 401; [err.isAuthFailure = true;] throw err;
//   Style B: throw Object.assign(new Error('MSG'), { statusCode: 401 });
function tagVerifyBearerBody(body, sourceId) {
  let mutated = body;
  let tagCount = 0;

  for (const [message, code] of Object.entries(CODE_BY_MESSAGE)) {
    const tagStmt = `msg._osiAuthFailure = { format: 1, code: '${code}', sourceId: '${sourceId}' };`;
    const escaped = message.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    // Style A: new Error('MSG'); ... err.statusCode = 401; [err.isAuthFailure = true;] throw err;
    const styleA = new RegExp(
      "(new Error\\('" + escaped + "'\\)\\s*;\\s*err\\.statusCode\\s*=\\s*401\\s*;(?:\\s*err\\.isAuthFailure\\s*=\\s*true\\s*;)?\\s*)(throw err;)",
      'g'
    );
    mutated = mutated.replace(styleA, (whole, before, throwStmt) => {
      tagCount += 1;
      return before + tagStmt + ' ' + throwStmt;
    });

    // Style B: if (COND) throw Object.assign(new Error('MSG'), { statusCode: 401 });
    // Observed usage (s2120-zones-get-fn, s2120-zones-put-auth-fn) is a
    // brace-less single-statement `if`. Turning that into two statements
    // without adding braces would make the throw unconditional (a real bug
    // caught by this script's own re-run against the executable test), so
    // this wraps the whole thing in an explicit block.
    const styleB = new RegExp(
      "if\\s*(\\([^;]*?\\))\\s*throw Object\\.assign\\(new Error\\('" + escaped + "'\\), \\{ statusCode: 401 \\}\\);",
      'g'
    );
    mutated = mutated.replace(styleB, (whole, cond) => {
      tagCount += 1;
      return 'if ' + cond + ' { ' + tagStmt + " throw Object.assign(new Error('" + message + "'), { statusCode: 401 }); }";
    });
  }

  // Insert the entry-clear as the very first statement of the body.
  mutated = ' delete msg._osiAuthFailure;' + mutated;

  return { mutated, tagCount };
}

function buildHttp500Func(authSources) {
  const sourceList = authSources.map((id) => `  '${id}',`).join('\n');
  return `if (!msg.res) return null;
const sourceId = String(msg.error?.source?.id || '');
const tag = msg._osiAuthFailure;
const authSources = new Set([
${sourceList}
]);
const publicByCode = new Map([
  ['MISSING_BEARER', 'Unauthorized'],
  ['INVALID_TOKEN', 'Invalid token'],
  ['TOKEN_EXPIRED', 'Token expired'],
]);
const exactKeys = tag && Object.keys(tag).sort().join(',') === 'code,format,sourceId';
const authMessage = exactKeys && tag.format === 1 &&
  authSources.has(sourceId) && tag.sourceId === sourceId
  ? publicByCode.get(tag.code)
  : undefined;
const statusCode = authMessage ? 401 : 500;
delete msg._osiAuthFailure;
if (statusCode === 500) {
  const boundedSourceId = String(sourceId || 'unknown')
    .replace(/[^A-Za-z0-9_.:-]/g, '_')
    .slice(0, 64);
  node.warn('Device API handler failed at node ' + boundedSourceId);
}
msg.statusCode = statusCode;
msg.headers = { 'Content-Type': 'application/json; charset=utf-8' };
msg.payload = {
  error: statusCode === 401 ? 'Unauthorized' : 'device-api failed',
  message: statusCode === 401 ? authMessage : 'Internal server error',
};
return msg;`;
}

function run() {
  const dryRun = process.argv.includes('--dry-run');

  const fixture = JSON.parse(fs.readFileSync(path.join(ROOT, FIXTURE_REL), 'utf8'));
  const authSources = [...new Set(fixture.routes.map((r) => r.authNodeId))].sort();
  if (authSources.length !== 41) {
    fail('expected 41 distinct authNodeId values in the fixture, found ' + authSources.length);
  }

  const { raw: canonicalRaw, parsed: canonicalFlows } = readJsonExact(CANONICAL_REL);
  const byId = new Map(canonicalFlows.map((n) => [n.id, n]));

  const http500 = byId.get(HTTP500_ID);
  if (!http500) fail(HTTP500_ID + ' not found on ' + TAB_ID);
  if (/_osiAuthFailure/.test(http500.func)) {
    fail(HTTP500_ID + ' already references msg._osiAuthFailure - repair already applied, refusing to double-apply.');
  }

  const beforeSerialized = new Map(canonicalFlows.map((n) => [n.id, JSON.stringify(n)]));

  let totalTagCount = 0;
  const perNodeTagCounts = {};

  for (const sourceId of authSources) {
    const node = byId.get(sourceId);
    if (!node) fail('fixture authNodeId ' + sourceId + ' does not exist in ' + CANONICAL_REL);
    if (node.z !== TAB_ID) fail('fixture authNodeId ' + sourceId + ' is not on ' + TAB_ID);
    if (node.type !== 'function') fail('fixture authNodeId ' + sourceId + ' is not a function node');
    if (!/function\s+verifyBearer/.test(node.func)) fail('fixture authNodeId ' + sourceId + ' has no function verifyBearer');
    if (/_osiAuthFailure/.test(node.func)) fail(sourceId + ' already references msg._osiAuthFailure - refusing to double-apply.');

    const span = findVerifyBearerSpan(node.func);
    if (!span) fail('could not locate verifyBearer body span in ' + sourceId);

    const body = node.func.slice(span.bodyStart, span.bodyEnd);
    const { mutated, tagCount } = tagVerifyBearerBody(body, sourceId);
    if (tagCount < 4) {
      fail(sourceId + ': only found ' + tagCount + ' taggable throw sites (expected at least 4: missing bearer, invalid token x>=1, expired)');
    }

    node.func = node.func.slice(0, span.bodyStart) + mutated + node.func.slice(span.bodyEnd);
    perNodeTagCounts[sourceId] = tagCount;
    totalTagCount += tagCount;
  }

  http500.func = buildHttp500Func(authSources);

  // Assert exactly 42 node objects changed (41 verifiers + http500) and every
  // other node on the whole flows array serializes identically.
  let changedCount = 0;
  const changedIds = [];
  for (const n of canonicalFlows) {
    const before = beforeSerialized.get(n.id);
    const after = JSON.stringify(n);
    if (before !== after) {
      changedCount += 1;
      changedIds.push(n.id);
    }
  }
  const expectedChanged = new Set([...authSources, HTTP500_ID]);
  const changedSet = new Set(changedIds);
  if (changedCount !== 42) {
    fail('expected exactly 42 changed node objects (41 verifiers + ' + HTTP500_ID + '), got ' + changedCount + ': ' + changedIds.join(', '));
  }
  for (const id of changedIds) {
    if (!expectedChanged.has(id)) fail('unexpected node changed outside the reviewed set: ' + id);
  }
  for (const id of expectedChanged) {
    if (!changedSet.has(id)) fail('expected node to change but it did not: ' + id);
  }

  const newRaw = JSON.stringify(canonicalFlows, null, 2) + '\n';
  if (newRaw === canonicalRaw) fail('serialized output is identical to the input - mutation had no effect');

  console.log('apply-device-api-auth-tags: 41 verifiers tagged (' + totalTagCount + ' throw sites total), ' + HTTP500_ID + ' replaced.');
  for (const [id, count] of Object.entries(perNodeTagCounts).sort()) {
    console.log('  ' + id + ': ' + count + ' tag site(s)');
  }

  if (dryRun) {
    console.log('apply-device-api-auth-tags: --dry-run, not writing files.');
    return;
  }

  fs.writeFileSync(path.join(ROOT, CANONICAL_REL), newRaw);
  fs.writeFileSync(path.join(ROOT, MIRROR_REL), newRaw);
  console.log('apply-device-api-auth-tags: wrote ' + CANONICAL_REL + ' and mirrored byte-for-byte to ' + MIRROR_REL + '.');
}

run();
