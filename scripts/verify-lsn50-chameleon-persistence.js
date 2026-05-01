#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const repoRoot = path.resolve(__dirname, '..');
const flowsPath = path.join(repoRoot, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json');
const flows = JSON.parse(fs.readFileSync(flowsPath, 'utf8'));

function nodeById(id) {
  const node = flows.find((entry) => entry.id === id);
  assert(node, `missing flow node ${id}`);
  return node;
}

function funcOf(id) {
  const node = nodeById(id);
  assert.strictEqual(node.type, 'function', `${id} must be a function node`);
  return String(node.func || '');
}

function assertIncludes(haystack, needle, label) {
  assert(haystack.includes(needle), `${label}: expected to find ${needle}`);
}

function compileFunctionNode(id) {
  const source = funcOf(id);
  new vm.Script(`(async function(msg,node,flow,env,context,global,get,set){${source}\n})`);
}

async function runFunctionNode(id, msg) {
  const source = funcOf(id);
  const writes = [];
  const statuses = [];
  const errors = [];
  let closeCount = 0;

  class FakeDatabase {
    constructor(dbPath) {
      this.dbPath = dbPath;
    }

    run(sql, params, callback) {
      writes.push({ dbPath: this.dbPath, sql, params });
      callback(null);
    }

    close(callback) {
      closeCount += 1;
      callback(null);
    }
  }

  const fn = new vm.Script(`(async function(msg,node){${source}\n})`).runInNewContext({
    osiDb: { Database: FakeDatabase },
    Buffer,
    Number,
    String,
    console,
    Promise,
  });

  const result = await fn(msg, {
    status(value) { statuses.push(value); },
    error(value) { errors.push(value); },
    warn(value) { errors.push(value); },
  });

  return { result, writes, statuses, errors, closeCount };
}

const syncInit = funcOf('sync-init-fn');
assertIncludes(syncInit, 'CREATE TABLE IF NOT EXISTS chameleon_readings', 'schema creates chameleon_readings');
assertIncludes(syncInit, 'idx_chameleon_readings_deveui_time', 'schema indexes by device/time');
assertIncludes(syncInit, 'idx_chameleon_readings_array_id', 'schema indexes array id');

const decode = funcOf('lsn50-decode-fn');
assertIncludes(decode, 'isChameleon', 'decode marks chameleon payloads');
assertIncludes(decode, 'Chameleon_Payload_Version', 'decode reads payload version');
assertIncludes(decode, 'chameleonR1OhmComp', 'decode normalizes R1 compensated');
assertIncludes(decode, 'chameleonR1OhmRaw', 'decode normalizes R1 raw');
assertIncludes(decode, 'Chameleon_Array_ID', 'decode normalizes array id');

const apply = funcOf('lsn50-apply-config');
assertIncludes(apply, '} else if (d.isChameleon === true) {', 'chameleon branch sits between MOD9 and dendrometer logic');
assertIncludes(apply, 'Chameleon flags 0x', 'apply-config surfaces chameleon status flags');
assertIncludes(apply, 'd.dendroValid = null', 'chameleon branch keeps dendrometer insert guard closed');
assertIncludes(apply, 'd.dendroCalibrationMissing = false;\n    flow.set(prevKey, undefined);', 'chameleon branch clears dendrometer previous state');

const chameleonInsert = funcOf('chameleon-readings-insert-fn');
assertIncludes(chameleonInsert, 'if (!d || d.isChameleon !== true) return msg;', 'insert passes non-chameleon payloads downstream');
assertIncludes(chameleonInsert, 'INSERT INTO chameleon_readings', 'insert function writes chameleon table');
assertIncludes(chameleonInsert, 'r1_ohm_comp', 'insert stores compensated resistance');
assertIncludes(chameleonInsert, 'r1_ohm_raw', 'insert stores raw resistance');
assertIncludes(chameleonInsert, 'payload_b64', 'insert stores raw payload for replay');
assertIncludes(chameleonInsert, 'return msg;', 'insert function passes through downstream flow');

const dendroInsert = funcOf('dendro-readings-insert-fn');
assertIncludes(dendroInsert, 'd.isChameleon === true', 'dendrometer insert skips chameleon frames');

const zoneAgg = nodeById('lsn50-zone-agg-fn');
const zoneAggTargets = (zoneAgg.wires && zoneAgg.wires[0]) || [];
assert(zoneAggTargets.includes('chameleon-readings-insert-fn'), 'zone agg first output must feed chameleon insert');
const chameleonInsertNode = nodeById('chameleon-readings-insert-fn');
const chameleonTargets = (chameleonInsertNode.wires && chameleonInsertNode.wires[0]) || [];
assert(chameleonTargets.includes('dendro-readings-insert-fn'), 'chameleon insert must pass through to dendro insert');

compileFunctionNode('lsn50-decode-fn');
compileFunctionNode('lsn50-apply-config');
compileFunctionNode('chameleon-readings-insert-fn');
compileFunctionNode('dendro-readings-insert-fn');

(async () => {
  const passThroughMsg = { formattedData: { devEui: 'AA', isChameleon: false } };
  const passThrough = await runFunctionNode('chameleon-readings-insert-fn', passThroughMsg);
  assert.strictEqual(passThrough.result, passThroughMsg, 'non-chameleon payload passes through unchanged');
  assert.strictEqual(passThrough.writes.length, 0, 'non-chameleon payload does not write chameleon_readings');

  const normalMsg = {
    formattedData: {
      devEui: 'a84041ffffffffff',
      timestamp: '2026-05-01T10:00:00.000Z',
      isChameleon: true,
      chameleonPayloadVersion: 1,
      chameleonStatusFlags: 0,
      chameleonI2cMissing: 0,
      chameleonTimeout: 0,
      chameleonTempFault: 0,
      chameleonIdFault: 0,
      chameleonCh1Open: 0,
      chameleonCh2Open: 0,
      chameleonCh3Open: 0,
      chameleonTempC: 28.43,
      chameleonR1OhmComp: 1168,
      chameleonR2OhmComp: 10257,
      chameleonR3OhmComp: 101195,
      chameleonR1OhmRaw: 1168,
      chameleonR2OhmRaw: 10257,
      chameleonR3OhmRaw: 101195,
      chameleonArrayId: '286D6ADB0F0000F1',
      adcV: 0.085,
      adcCh1V: 0.521,
      adcCh4V: 0.002,
      batV: 3.6,
      rawPayloadB64: 'AAECAwQ=',
      fPort: 2,
      fCnt: 123,
    },
  };
  const normal = await runFunctionNode('chameleon-readings-insert-fn', normalMsg);
  assert.strictEqual(normal.result, normalMsg, 'normal chameleon payload passes downstream');
  assert.strictEqual(normal.writes.length, 1, 'normal chameleon payload writes one row');
  assert(normal.writes[0].sql.includes('INSERT INTO chameleon_readings'), 'normal write targets chameleon_readings');
  assert.strictEqual(normal.writes[0].params.length, 26, 'normal write uses all insert parameters');
  assert.strictEqual(normal.writes[0].params[0], 'A84041FFFFFFFFFF', 'devEui is stored uppercase');
  assert.strictEqual(normal.writes[0].params[11], 28.43, 'temp_c is stored for valid data');
  assert.strictEqual(normal.writes[0].params[12], 1168, 'r1_ohm_comp is stored for valid data');
  assert.strictEqual(normal.writes[0].params[15], 1168, 'r1_ohm_raw is stored for valid data');
  assert.strictEqual(normal.writes[0].params[18], '286D6ADB0F0000F1', 'array_id is stored for valid data');
  assert.strictEqual(normal.writes[0].params[23], 'AAECAwQ=', 'payload_b64 stores the LoRaWAN payload base64');
  assert.strictEqual(normal.writes[0].params[24], 2, 'f_port is stored when present');
  assert.strictEqual(normal.writes[0].params[25], 123, 'f_cnt is stored when present');
  assert.strictEqual(normal.closeCount, 1, 'normal write closes the database handle');

  const faultMsg = JSON.parse(JSON.stringify(normalMsg));
  faultMsg.formattedData.chameleonI2cMissing = 1;
  faultMsg.formattedData.chameleonStatusFlags = 1;
  faultMsg.formattedData.chameleonTempC = 0;
  faultMsg.formattedData.chameleonR1OhmComp = 0;
  faultMsg.formattedData.chameleonR1OhmRaw = 0;
  faultMsg.formattedData.chameleonArrayId = 'SHOULD_NOT_STORE';
  const fault = await runFunctionNode('chameleon-readings-insert-fn', faultMsg);
  assert.strictEqual(fault.writes.length, 1, 'fault chameleon payload still writes one row');
  assert.strictEqual(fault.writes[0].params[4], 1, 'i2c_missing flag is persisted');
  assert.strictEqual(fault.writes[0].params[11], null, 'temp_c is nulled when data is invalid');
  assert.strictEqual(fault.writes[0].params[12], null, 'r1_ohm_comp is nulled when data is invalid');
  assert.strictEqual(fault.writes[0].params[15], null, 'r1_ohm_raw is nulled when data is invalid');
  assert.strictEqual(fault.writes[0].params[18], null, 'array_id is nulled when data is invalid');

  const emptyFieldMsg = JSON.parse(JSON.stringify(normalMsg));
  emptyFieldMsg.formattedData.chameleonTempC = '';
  emptyFieldMsg.formattedData.chameleonR1OhmComp = '';
  emptyFieldMsg.formattedData.fCnt = undefined;
  const emptyFields = await runFunctionNode('chameleon-readings-insert-fn', emptyFieldMsg);
  assert.strictEqual(emptyFields.writes[0].params[11], null, 'empty temp string stores NULL');
  assert.strictEqual(emptyFields.writes[0].params[12], null, 'empty resistance string stores NULL');
  assert.strictEqual(emptyFields.writes[0].params[25], null, 'missing fCnt stores NULL');

  console.log('LSN50 Chameleon persistence checks passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
