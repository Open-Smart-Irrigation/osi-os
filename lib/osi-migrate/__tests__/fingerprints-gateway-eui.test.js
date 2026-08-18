'use strict';
// osi-os#153: fingerprints must be blind to (a) which gateway's real EUI got
// baked into a trigger body by the boot node's live substitution, and (b)
// pure SQL token-spacing differences between hand-formatted migration/seed
// DDL and the boot node's compact JS template literals. These tests exercise
// lib/osi-migrate/fingerprints.js's v3 normalizer both directly (unit) and
// through computeFingerprints() against a real sqlite3 connection
// (integration), and include the mandatory over-normalization guards: a REAL
// schema change, and a NULL that is NOT in gateway-EUI position, must still
// fingerprint differently.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const { cliRunner } = require('../runner-iface');
const { computeFingerprints, normalizeSqlV3, canonicalizeGatewayEuiCoalesce } = require('../fingerprints');

function tmpDb() { return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'osimig-fp-eui-')), 't.db'); }

// A representative slice of the real trg_sync_devices_outbox_au shape: an
// outbox insert whose payload and top-level column both carry the
// gateway-EUI COALESCE fallback (matches 0047__sdi12_value_count.sql /
// seed-blank.sql exactly in structure).
function outboxTriggerSql(euiLiteralOrNull, opts = {}) {
  const watchedCol = opts.watchedCol || 'sdi12_value_count';
  const opName = opts.opName || 'DEVICE_FLAGS_UPDATED';
  const eq = opts.tightEquals ? "peer_node='cloud'" : "peer_node = 'cloud'";
  return `
    CREATE TABLE devices (deveui TEXT PRIMARY KEY, gateway_device_eui TEXT, ${watchedCol} INTEGER, sync_version INTEGER);
    CREATE TABLE sync_outbox (event_uuid TEXT, aggregate_type TEXT, aggregate_key TEXT, op TEXT, payload_json TEXT, sync_version INTEGER, occurred_at TEXT, gateway_device_eui TEXT);
    CREATE TRIGGER trg_sync_devices_outbox_au AFTER UPDATE ON devices
    WHEN COALESCE(NEW.${watchedCol},-1) <> COALESCE(OLD.${watchedCol},-1)
    BEGIN
      INSERT INTO sync_outbox(event_uuid, aggregate_type, aggregate_key, op, payload_json, sync_version, occurred_at, gateway_device_eui)
      VALUES (
        lower(hex(randomblob(16))), 'DEVICE', NEW.deveui, '${opName}',
        json_object('${watchedCol}', NEW.${watchedCol}, 'gateway_device_eui', COALESCE(NEW.gateway_device_eui, ${euiLiteralOrNull})),
        NEW.sync_version, strftime('%Y-%m-%dT%H:%M:%fZ','now'),
        COALESCE(NEW.gateway_device_eui, ${euiLiteralOrNull})
      );
    END;
    CREATE TRIGGER trg_uses_peer_node AFTER INSERT ON sync_outbox
    WHEN (SELECT 1 FROM sync_outbox WHERE ${eq} LIMIT 1) IS NULL
    BEGIN SELECT 1; END;
  `;
}

async function fpFor(sql) {
  const r = cliRunner(tmpDb());
  await r.exec(sql);
  return computeFingerprints(r);
}

function triggerFp(fps, name) {
  const f = fps.find((x) => x.object_type === 'trigger' && x.object_name === name);
  assert.ok(f, `expected trigger ${name} in fingerprint set`);
  return f.fingerprint;
}

test('gateway-EUI literal is blind: Silvan-EUI text and kaba100-EUI text fingerprint identically', async () => {
  const silvan = await fpFor(outboxTriggerSql("'0016C001F11715E2'"));
  const kaba100 = await fpFor(outboxTriggerSql("'0016C001F11766E7'"));
  assert.equal(triggerFp(silvan, 'trg_sync_devices_outbox_au'), triggerFp(kaba100, 'trg_sync_devices_outbox_au'));
});

test('unset-EUI NULL fingerprints the same as a configured EUI literal in the same COALESCE slot', async () => {
  const withEui = await fpFor(outboxTriggerSql("'0016C001F11715E2'"));
  const withNull = await fpFor(outboxTriggerSql('NULL'));
  assert.equal(triggerFp(withEui, 'trg_sync_devices_outbox_au'), triggerFp(withNull, 'trg_sync_devices_outbox_au'));
});

test('token spacing around = is blind: "peer_node = \'cloud\'" vs "peer_node=\'cloud\'"', async () => {
  const spaced = await fpFor(outboxTriggerSql("'0016C001F11715E2'", { tightEquals: false }));
  const tight = await fpFor(outboxTriggerSql("'0016C001F11715E2'", { tightEquals: true }));
  assert.equal(triggerFp(spaced, 'trg_uses_peer_node'), triggerFp(tight, 'trg_uses_peer_node'));
});

test('OVER-NORMALIZATION GUARD: an extra watched column still fingerprints differently', async () => {
  const base = await fpFor(outboxTriggerSql("'0016C001F11715E2'"));
  const changed = await fpFor(outboxTriggerSql("'0016C001F11715E2'", { watchedCol: 'sdi12_value_count_v2' }));
  assert.notEqual(triggerFp(base, 'trg_sync_devices_outbox_au'), triggerFp(changed, 'trg_sync_devices_outbox_au'));
});

test('OVER-NORMALIZATION GUARD: a changed op name (payload key content) still fingerprints differently', async () => {
  const updated = await fpFor(outboxTriggerSql("'0016C001F11715E2'", { opName: 'DEVICE_FLAGS_UPDATED' }));
  const update = await fpFor(outboxTriggerSql("'0016C001F11715E2'", { opName: 'DEVICE_FLAGS_UPDATE' }));
  assert.notEqual(triggerFp(updated, 'trg_sync_devices_outbox_au'), triggerFp(update, 'trg_sync_devices_outbox_au'));
});

test('OVER-NORMALIZATION GUARD: NULL outside gateway-EUI COALESCE position stays significant', () => {
  const a = normalizeSqlV3("SELECT COALESCE(some_other_col, NULL) FROM t;");
  const b = normalizeSqlV3("SELECT COALESCE(some_other_col, '0016C001F11715E2') FROM t;");
  assert.notEqual(a, b, 'a NULL fallback unrelated to gateway_device_eui must not be swept into the placeholder');
});

test('unit: canonicalizeGatewayEuiCoalesce only rewrites a trailing NULL or 16-hex literal when the arg list mentions gateway_device_eui', () => {
  assert.equal(
    canonicalizeGatewayEuiCoalesce("coalesce(new.gateway_device_eui,null)"),
    "coalesce(new.gateway_device_eui,'<gateway_eui>')");
  assert.equal(
    canonicalizeGatewayEuiCoalesce("coalesce(new.gateway_device_eui,'0016c001f11766e7')"),
    "coalesce(new.gateway_device_eui,'<gateway_eui>')");
  assert.equal(
    canonicalizeGatewayEuiCoalesce("coalesce((select gateway_device_eui from devices where deveui=new.deveui and deleted_at is null),null)"),
    "coalesce((select gateway_device_eui from devices where deveui=new.deveui and deleted_at is null),'<gateway_eui>')");
  assert.equal(
    canonicalizeGatewayEuiCoalesce("coalesce(some_other_col,null)"),
    "coalesce(some_other_col,null)",
    'no gateway_device_eui mention -> left untouched');
});

// --- Fable review (c28ebcbf) FIX 1: narrow rule 2a to the gateway-EUI
// coalesce slot only, and make the coalesce scan recursive. ---

test('FABLE PAIR: a bare 16-hex literal OUTSIDE the gateway-EUI coalesce slot is a real semantic difference, not swept', () => {
  // Same shape a WHEN clause or join condition could plausibly use: comparing
  // deveui to a specific device is never "the same" as comparing it to a
  // different device, even though both operands happen to be EUI-shaped.
  const a = normalizeSqlV3("SELECT 1 FROM devices WHERE deveui <> '0101010101010101';");
  const b = normalizeSqlV3("SELECT 1 FROM devices WHERE deveui <> '0016C001F11766E7';");
  assert.notEqual(a, b, 'a 16-hex literal compared against deveui (not the gateway_device_eui COALESCE fallback) must stay significant');
});

test('unit: canonicalizeGatewayEuiCoalesce is recursive — a nested coalesce(x, coalesce(gateway_device_eui, NULL)) still canonicalizes the inner null', () => {
  const nestedNull = canonicalizeGatewayEuiCoalesce("coalesce(x,coalesce(new.gateway_device_eui,null))");
  const nestedEui = canonicalizeGatewayEuiCoalesce("coalesce(x,coalesce(new.gateway_device_eui,'0016c001f11766e7'))");
  assert.equal(nestedNull, "coalesce(x,coalesce(new.gateway_device_eui,'<gateway_eui>'))");
  assert.equal(nestedEui, "coalesce(x,coalesce(new.gateway_device_eui,'<gateway_eui>'))");
  assert.equal(nestedNull, nestedEui, 'nested-NULL and nested-real-EUI must canonicalize identically, same as the flat (non-nested) case');
});

test('FABLE PAIR: a real trigger using the nested coalesce shape fingerprints the same across kaba100 and unset-EUI', async () => {
  // The exact shape Fable's pair I targets, wired through the full
  // computeFingerprints() path (not just the string-level helper above), so
  // the recursion is proven at the fingerprint level too.
  const withEui = await fpFor(`
    CREATE TABLE devices (deveui TEXT PRIMARY KEY, gateway_device_eui TEXT, x INTEGER);
    CREATE TRIGGER trg_nested AFTER UPDATE ON devices
    BEGIN UPDATE devices SET x = length(COALESCE(x, COALESCE(NEW.gateway_device_eui, '0016C001F11766E7'))); END;
  `);
  const withNull = await fpFor(`
    CREATE TABLE devices (deveui TEXT PRIMARY KEY, gateway_device_eui TEXT, x INTEGER);
    CREATE TRIGGER trg_nested AFTER UPDATE ON devices
    BEGIN UPDATE devices SET x = length(COALESCE(x, COALESCE(NEW.gateway_device_eui, NULL))); END;
  `);
  assert.equal(triggerFp(withEui, 'trg_nested'), triggerFp(withNull, 'trg_nested'));
});

// --- 22 real boot-node sites: extract sync-init-fn's actual `triggers` array
// (not `stmts` — those are ADD COLUMN/one-off UPDATE backfills that never
// land in sqlite_master, so they are irrelevant to fingerprinting) at
// kaba100's EUI, Uganda's EUI, and unset (NULL), and confirm every
// gatewaySql-bearing CREATE TRIGGER statement normalizes identically across
// all three, covering all 22 real interpolation sites. ---

function extractBootTriggers(gatewaySqlLiteral) {
  const flowsPath = path.join(__dirname, '..', '..', '..',
    'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json');
  const flows = JSON.parse(fs.readFileSync(flowsPath, 'utf8'));
  const node = flows.find((n) => n && n.id === 'sync-init-fn');
  const lines = node.func.split('\n');
  const i = lines.findIndex((l) => /^const triggers = \[/.test(l));
  const j = lines.findIndex((l, k) => k > i && /^\];\s*$/.test(l));
  const src = lines.slice(i, j + 1).join('\n').replace(/^const \w+ = /, 'return ');
  return new Function('gatewaySql', src)(gatewaySqlLiteral);
}

test('22 real boot-node sites: every gatewaySql-bearing CREATE TRIGGER normalizes identically across kaba100, Uganda, and unset-EUI', () => {
  const kaba100 = extractBootTriggers("'0016C001F11766E7'");
  const uganda = extractBootTriggers("'0016C001F151B1D6'");
  const unset = extractBootTriggers('NULL');
  assert.equal(kaba100.length, uganda.length);
  assert.equal(kaba100.length, unset.length);

  let differingStatements = 0;
  let totalSites = 0;
  for (let k = 0; k < kaba100.length; k += 1) {
    const a = kaba100[k], b = uganda[k], c = unset[k];
    if (a === b && a === c) continue; // statement has no gatewaySql interpolation at all
    differingStatements += 1;
    totalSites += (a.match(/0016C001F11766E7/g) || []).length;
    const na = normalizeSqlV3(a), nb = normalizeSqlV3(b), nc = normalizeSqlV3(c);
    assert.equal(na, nb, `statement ${k} (kaba100 vs Uganda) must normalize identically`);
    assert.equal(na, nc, `statement ${k} (kaba100 vs unset-EUI) must normalize identically`);
  }
  assert.ok(differingStatements > 0, 'sanity: at least one real boot trigger statement must actually interpolate gatewaySql');
  assert.equal(totalSites, 22, 'must cover all 22 known real gateway-EUI interpolation sites (osi-os#153 / Fable review count)');
});

test('unit: normalizeSqlV3 leaves a non-EUI string literal, including a 16-CHAR non-hex one, untouched', () => {
  assert.equal(normalizeSqlV3("'DEVICE_FLAGS_UPDATED'"), "'DEVICE_FLAGS_UPDATED'");
  assert.equal(normalizeSqlV3("'sixteen_char_str'"), "'sixteen_char_str'"); // 16 chars, not all hex
});
