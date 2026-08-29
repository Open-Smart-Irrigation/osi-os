'use strict';
// osi-sdi12-recipe — deterministic Dragino SDI-12 recipe compiler.
// Layout validation remains owned by osi-sdi12-normalize so persistence,
// normalization, and deployment share one exact accepted-layout grammar.
const crypto = require('crypto');
const { validateSentekLayout } = require('../osi-sdi12-normalize');

const MAX_SLOTS = 8;
const NORMAL_INTERVAL_SECONDS = 1200;
const POWER_WINDOW_MS = 8000;

function layoutOrThrow(layout) {
  const validated = validateSentekLayout(layout);
  if (!validated.ok) throw new Error('invalid layout: ' + validated.error);
  return validated.layout;
}

function canonicalLayoutHash(layout) {
  const canonical = layoutOrThrow(layout);
  return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

function cutForValueCount(valueCount) {
  const responseLength = 3 + (9 * valueCount);
  return `0,${responseLength},2,2~${1 + (9 * valueCount)}`;
}

function addSlot(slots, command, valueCount) {
  slots.push({ slot: slots.length + 1, command, cut: cutForValueCount(valueCount) });
}

function addResponseFamily(slots, address, firstCommand, tenthCommand, valueCount) {
  if (valueCount < 1) return;
  const firstNine = Math.min(valueCount, 9);
  addSlot(slots, address + firstCommand + '!,1,1,2', Math.min(firstNine, 3));
  if (firstNine > 3) addSlot(slots, address + 'D1!,0,0,2', Math.min(firstNine - 3, 3));
  if (firstNine > 6) addSlot(slots, address + 'D2!,0,0,2', firstNine - 6);
  if (valueCount === 10) addSlot(slots, address + tenthCommand + '!,1,1,2', 1);
}

function frame(purpose, bytes) {
  const value = Buffer.from(bytes);
  return { purpose, hex: value.toString('hex').toUpperCase(), base64: value.toString('base64') };
}

function afFrame(slot, selector, ascii, purpose) {
  const payload = Buffer.from(ascii, 'ascii');
  // Dragino's AF command-length field counts one extra byte for D-response
  // commands. The bench-approved wire fixture is authoritative here.
  const length = payload.length + (/^[0-9A-Za-z]D[12]!/.test(ascii) ? 1 : 0);
  return frame(purpose, Buffer.concat([Buffer.from([0xAF, slot, selector, length]), payload, Buffer.from([0x00])]));
}

function compileSentekRecipe(layout) {
  const validated = validateSentekLayout(layout);
  if (!validated.ok) {
    return { ok: false, code: 'invalid_layout', message: 'invalid Sentek layout: ' + validated.error };
  }
  const canonical = validated.layout;
  const slots = [];
  const sensors = canonical.sensors;
  addResponseFamily(slots, canonical.address, 'M', 'M1', sensors.length);

  const firstNineTriScanCount = sensors.filter((sensor) => sensor.type === 'TRISCAN' && sensor.response_position <= 9).length;
  addResponseFamily(slots, canonical.address, 'M2', 'M3', firstNineTriScanCount);
  const tenth = sensors.find((sensor) => sensor.response_position === 10);
  if (tenth && tenth.type === 'TRISCAN') addSlot(slots, canonical.address + 'M3!,1,1,2', 1);

  if (slots.length > MAX_SLOTS) {
    return { ok: false, code: 'invalid_layout', message: 'invalid Sentek layout: recipe exceeds eight slots' };
  }

  const frames = [
    frame('power_window', [0x07, 0x03, 0x1F, 0x40]),
    frame('all_data_mode', [0xAB, 0x01]),
    frame('payload_version', [0xAE, 0x02]),
    frame('data_uplink', [0xAD, 0x01]),
    frame('sdi12_timing', [0xA9, 0x0D, 0x09]),
  ];
  for (const active of slots) {
    frames.push(afFrame(active.slot, 0x01, active.command, 'command_' + active.slot));
    frames.push(afFrame(active.slot, 0x02, active.cut, 'cut_' + active.slot));
  }
  if (slots.length < MAX_SLOTS) frames.push(frame('clear_unused_tail', [0x09, slots.length + 1, 0x0F]));
  frames.push(frame('normal_interval', [0x01, 0x00, 0x04, 0xB0]));

  return {
    ok: true,
    recipe: {
      version: 1,
      profile: 'SENTEK_ENVIROSCAN',
      address: canonical.address,
      layoutHash: crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex'),
      normalIntervalSeconds: NORMAL_INTERVAL_SECONDS,
      powerWindowMs: POWER_WINDOW_MS,
      slots,
      frames,
    },
  };
}

function encodeIdentifyFrame(command) {
  if (command !== '?!' && !/^[0-9A-Za-z]I!$/.test(command)) {
    throw new Error('invalid identify command');
  }
  const ascii = Buffer.from(command, 'ascii');
  return Buffer.concat([Buffer.from([0xA8, ascii.length]), ascii, Buffer.from([0x01, 0x01, 0x00])]);
}

module.exports = { compileSentekRecipe, canonicalLayoutHash, encodeIdentifyFrame };
