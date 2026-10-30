#!/usr/bin/env node
'use strict';

// Behavioural test for the display fallback reason code in
// GET /api/zones/:id/environment (zone-env-fn, "Get Zone Environment
// Summary", assembly in osi-zone-env buildDisplayStatus).
//
// The banner sentence in display.fallbackReason is English prose the GUI
// cannot translate (#310, follow-up to F100/X-16). The two sentences the
// edge itself writes now travel with a stable code in
// display.fallbackReasonCode; prose a linked cloud bundle authored keeps its
// code null so the GUI shows its own generic wording instead of guessing.
//
// The code is derived inside buildDisplayStatus from the pairing of display
// mode and the exact sentence: the stale-cache catch is the only producer of
// 'Using last synced OSI Server values.' and always pairs with mode
// shared_server_stale; the expired-cache catch is the only producer of
// 'Using local fallback because the OSI Server bundle is unavailable.' and
// always pairs with mode local_fallback. Inherited cloud prose reaches the
// field only under mode shared_server (the flow's `||` short-circuits once
// its own reason is set), so it can never satisfy either pairing.
//
// Run: node --test scripts/test-zone-env-fallback-reason-code.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const { executeFunction, loadNode, makeAuthHeader, seedTestDb } = require('./lib/flow-node-harness');

const SECRET = 'zone-env-fallback-code-secret';
const NOW_ISO = '2026-10-30T10:00:00.000Z';
const NOW_MS = Date.parse(NOW_ISO);
const MINUTE_MS = 60000;
const GATEWAY_EUI = '0016C001F1000001';

const STALE_SENTENCE = 'Using last synced OSI Server values.';
const UNAVAILABLE_SENTENCE = 'Using local fallback because the OSI Server bundle is unavailable.';
const CLOUD_SENTENCE = 'The linked cloud authored this banner itself.';

const PROFILE_PATHS = [
  'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-zone-env/index.js',
  'conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-zone-env/index.js',
];
const ROOT = path.resolve(__dirname, '..');

function httpsFailStub() {
  return {
    request(_url, _options, callback) {
      const req = new EventEmitter();
      req.setTimeout = () => req;
      req.write = () => {};
      req.destroy = (error) => req.emit('error', error);
      req.end = () => {
        process.nextTick(() => {
          const res = new EventEmitter();
          res.statusCode = 503;
          callback(res);
          process.nextTick(() => {
            res.emit('data', 'Service Unavailable');
            res.emit('end');
          });
        });
      };
      return req;
    },
  };
}

function cloudBundle(displayFallbackReason) {
  return {
    zoneId: 2,
    zoneName: 'Z Two',
    water: { available: true, waterNeededTodayMm: 3.1, rainTodayMm: 0.8, daily: [] },
    display: displayFallbackReason === undefined ? undefined : { fallbackReason: displayFallbackReason },
  };
}

function fixedDate(RealDate) {
  return class FixedDate extends RealDate {
    constructor(...args) { super(...(args.length ? args : [NOW_MS])); }
    static now() { return NOW_MS; }
    static parse(value) { return RealDate.parse(value); }
    static UTC(...args) { return RealDate.UTC(...args); }
  };
}

async function zoneDisplay({ linkMode = 'server', bundleAgeMinutes = null, bundleDisplayReason = undefined } = {}) {
  const db = seedTestDb();
  db.prepare("UPDATE irrigation_zones SET gateway_device_eui = ? WHERE id = 2").run(GATEWAY_EUI);
  if (linkMode === 'server') {
    db.prepare("UPDATE users SET auth_mode = 'server', server_url = 'https://cloud.example.test', server_sync_token = ? WHERE id = 1").run('vector-token');
  }
  if (bundleAgeMinutes != null) {
    db.prepare(`
      INSERT INTO zone_shared_environment(zone_uuid,zone_id,gateway_device_eui,summary_json,shared_generated_at,shared_observed_at,last_received_at)
      VALUES('z-2',2,?,?,?,?,?)
    `).run(
      GATEWAY_EUI,
      JSON.stringify(cloudBundle(bundleDisplayReason)),
      new Date(NOW_MS - bundleAgeMinutes * MINUTE_MS).toISOString(),
      new Date(NOW_MS - bundleAgeMinutes * MINUTE_MS).toISOString(),
      new Date(NOW_MS - bundleAgeMinutes * MINUTE_MS).toISOString(),
    );
  }
  const stub = httpsFailStub();
  const RealDate = global.Date;
  global.Date = fixedDate(RealDate);
  try {
    const out = await executeFunction(loadNode('zone-env-fn'), {
      db,
      env: { AUTH_TOKEN_SECRET: SECRET },
      msg: {
        req: {
          headers: { authorization: makeAuthHeader({ userId: 1, username: 'admin1', secret: SECRET, expiresAt: NOW_MS + 60 * MINUTE_MS }) },
          params: { zone_id: '2' },
          query: {},
        },
      },
      libOverrides: { httpLib: stub, httpsLib: stub },
    });
    const response = out.result && out.result.payload ? out.result : null;
    assert.ok(response, 'the node answers');
    assert.equal(response.statusCode, 200, JSON.stringify(response.payload));
    return response.payload.display;
  } finally {
    global.Date = RealDate;
    db.close();
  }
}

test('a failed bundle fetch with a cache at most 180 minutes old answers shared_server_stale with code using_last_synced', async () => {
  const display = await zoneDisplay({ bundleAgeMinutes: 10 });
  assert.equal(display.mode, 'shared_server_stale');
  assert.equal(display.fallbackReason, STALE_SENTENCE);
  assert.equal(display.fallbackReasonCode, 'using_last_synced');
});

test('a failed bundle fetch with an expired cache answers local_fallback with code bundle_unavailable', async () => {
  const display = await zoneDisplay({ bundleAgeMinutes: 240 });
  assert.equal(display.mode, 'local_fallback');
  assert.equal(display.fallbackReason, UNAVAILABLE_SENTENCE);
  assert.equal(display.fallbackReasonCode, 'bundle_unavailable');
});

test('inherited cloud display prose keeps its bytes and carries no code', async () => {
  const display = await zoneDisplay({ bundleAgeMinutes: 2, bundleDisplayReason: CLOUD_SENTENCE });
  assert.equal(display.mode, 'shared_server');
  assert.equal(display.fallbackReason, CLOUD_SENTENCE);
  assert.equal(display.fallbackReasonCode, null);
});

test('a zone without a fallback reason carries neither sentence nor code', async () => {
  const display = await zoneDisplay({ linkMode: 'local' });
  assert.equal(display.mode, 'unlinked_local');
  assert.equal(display.fallbackReason, null);
  assert.equal(display.fallbackReasonCode, null);
});

test('buildDisplayStatus derives the code from the mode-and-sentence pairing in both runtime profiles', () => {
  const first = fs.readFileSync(path.join(ROOT, PROFILE_PATHS[0]), 'utf8');
  const second = fs.readFileSync(path.join(ROOT, PROFILE_PATHS[1]), 'utf8');
  assert.equal(first, second, 'both profiles ship osi-zone-env/index.js byte-identical');
  const ZE = require(path.join(ROOT, PROFILE_PATHS[0]));
  const ZE2709 = require(path.join(ROOT, PROFILE_PATHS[1]));

  const legacyFields = (status) => ({
    mode: status.mode,
    schedulingMode: status.schedulingMode,
    sourceLabel: status.sourceLabel,
    sharedGeneratedAt: status.sharedGeneratedAt,
    sharedObservedAt: status.sharedObservedAt,
    lastReceivedAt: status.lastReceivedAt,
    fallbackReason: status.fallbackReason,
  });

  for (const [label, ZE_] of [['bcm2712', ZE], ['bcm2709', ZE2709]]) {
    const stale = ZE_.buildDisplayStatus('shared_server_stale', 'local', 'OSI Server', ' g ', null, null, ' ' + STALE_SENTENCE + ' ');
    assert.equal(stale.fallbackReasonCode, 'using_last_synced', label);
    assert.equal(stale.fallbackReason, STALE_SENTENCE, 'prose stays trimmed, byte-for-byte: ' + label);

    const unavailable = ZE_.buildDisplayStatus('local_fallback', 'local', 'Local fallback', null, null, null, UNAVAILABLE_SENTENCE);
    assert.equal(unavailable.fallbackReasonCode, 'bundle_unavailable', label);

    // Inherited prose never matches a known code, even when a cloud bundle
    // re-uses the edge's own sentence word-for-word: mode shared_server means
    // the edge did not write it.
    const inheritedLookalike = ZE_.buildDisplayStatus('shared_server', 'local', 'OSI Server', null, null, null, STALE_SENTENCE);
    assert.equal(inheritedLookalike.fallbackReasonCode, null, label);
    const inheritedUnknown = ZE_.buildDisplayStatus('shared_server', 'local', 'OSI Server', null, null, null, CLOUD_SENTENCE);
    assert.equal(inheritedUnknown.fallbackReasonCode, null, label);
    const localUnknownProse = ZE_.buildDisplayStatus('local_fallback', 'local', 'Local fallback', null, null, null, CLOUD_SENTENCE);
    assert.equal(localUnknownProse.fallbackReasonCode, null, label);

    // An explicit code wins over derivation and passes unknown codes through
    // (open vocabulary): newer flows may set it directly.
    const explicitKnown = ZE_.buildDisplayStatus('shared_server', 'local', 'OSI Server', null, null, null, CLOUD_SENTENCE, 'bundle_unavailable');
    assert.equal(explicitKnown.fallbackReasonCode, 'bundle_unavailable', label);
    const explicitFuture = ZE_.buildDisplayStatus('shared_server', 'local', 'OSI Server', null, null, null, CLOUD_SENTENCE, 'future_reason_code');
    assert.equal(explicitFuture.fallbackReasonCode, 'future_reason_code', label);

    // No reason means no code, under every mode.
    const quiet = ZE_.buildDisplayStatus('shared_server_stale', 'local', 'OSI Server', null, null, null, null);
    assert.equal(quiet.fallbackReasonCode, null, label);

    // The seven legacy fields keep their exact pre-code shape.
    assert.deepEqual(legacyFields(stale), {
      mode: 'shared_server_stale',
      schedulingMode: 'local',
      sourceLabel: 'OSI Server',
      sharedGeneratedAt: 'g',
      sharedObservedAt: null,
      lastReceivedAt: null,
      fallbackReason: STALE_SENTENCE,
    }, label);
  }
});
