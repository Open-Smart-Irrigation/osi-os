'use strict';

const { inspectExchange } = require('./sdi12-protocol-lab');

const QUALIFICATION = Object.freeze({
  hardware_verified: false,
  acquisition_available: false,
  eligible: false,
  configuration_verified: false,
});

function flags() { return { ...QUALIFICATION }; }
function invalid(code, extra) { return { ok: false, disposition: 'invalid', code, ...(extra || {}), ...flags() }; }
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function exact(value, keys) {
  if (!object(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every(key => Object.prototype.hasOwnProperty.call(value, key));
}
function byteArray(value, minimum, maximum) {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (!(index in value) || !Number.isSafeInteger(value[index]) || value[index] < 0 || value[index] > 255) return false;
  }
  return true;
}
function copiedBytes(value) { return value.slice(); }
function byteText(bytes) { return String.fromCharCode(...bytes); }
function copyConfiguration(configuration) {
  return { dataup: configuration.dataup, payver: configuration.payver, alldatamod: configuration.alldatamod,
    datacut: configuration.datacut, dataconv: configuration.dataconv, ext: configuration.ext.slice() };
}

function configurationState(value) {
  const keys = ['dataup', 'payver', 'alldatamod', 'datacut', 'dataconv', 'ext'];
  if (!exact(value, keys) || !Number.isSafeInteger(value.dataup) || (value.dataup !== 0 && value.dataup !== 1)
    || !Number.isSafeInteger(value.payver) || value.payver < 0 || value.payver > 255
    || !Number.isSafeInteger(value.alldatamod) || (value.alldatamod !== 0 && value.alldatamod !== 1)
    || (value.datacut !== 'none' && value.datacut !== 'configured')
    || (value.dataconv !== 'none' && value.dataconv !== 'configured')
    || !Array.isArray(value.ext) || value.ext.length !== 3) {
    return { valid: false };
  }
  for (let index = 0; index < value.ext.length; index += 1) {
    const entry = value.ext[index];
    if (!(index in value.ext) || !Number.isSafeInteger(entry) || (entry !== 0 && entry !== 1)) return { valid: false };
  }
  const configuration = copyConfiguration(value);
  const supported = configuration.alldatamod === 1 && configuration.datacut === 'none'
    && configuration.dataconv === 'none' && configuration.ext.every(entry => entry === 0);
  return { valid: true, supported, configuration };
}

function frameInput(input) {
  if (!exact(input, ['fport', 'bytes', 'configuration']) || input.fport !== 2 || !byteArray(input.bytes, 3, 255)) return null;
  return { bytes: copiedBytes(input.bytes), configuration: configurationState(input.configuration) };
}

function header(bytes, dataup) {
  const battery = (bytes[0] << 8) | bytes[1];
  const result = { battery_mv: battery & 0x7fff, interrupt: (battery & 0x8000) !== 0, payver: bytes[2], dataup };
  if (dataup === 1) {
    if (bytes.length < 5) return null;
    result.segment_count = bytes[3];
    result.segment_index = bytes[4];
  }
  return result;
}

function inspectFrame(input) {
  const parsed = frameInput(input);
  if (!parsed) {
    const evidence = object(input) && byteArray(input.bytes, 3, 255)
      ? { raw_bytes: copiedBytes(input.bytes) } : undefined;
    return invalid('invalid_input', evidence);
  }
  const raw = parsed.bytes;
  if (!parsed.configuration.valid) return invalid('invalid_configuration', { raw_bytes: raw });
  const configuration = parsed.configuration.configuration;
  if (!parsed.configuration.supported) return invalid('unsupported_configuration', { raw_bytes: raw, configuration });
  const currentHeader = header(raw, configuration.dataup);
  if (!currentHeader) return invalid('short_header', { raw_bytes: raw, configuration });
  const offset = configuration.dataup === 0 ? 3 : 5;
  const body = raw.slice(offset);
  const base = { raw_bytes: raw, header: currentHeader, configuration, body_bytes: body };
  if (currentHeader.payver !== configuration.payver) return invalid('payver_mismatch', base);
  if (configuration.dataup === 1) {
    if (currentHeader.segment_count < 1 || currentHeader.segment_count > 15 || currentHeader.segment_index >= currentHeader.segment_count) {
      return invalid('invalid_segment_header', base);
    }
    return { ok: false, disposition: 'fragment', code: 'fragment_requires_reassembly', ...base, ...flags() };
  }
  const records = [];
  const seen = new Set();
  for (let position = 3; position < raw.length;) {
    const marker = raw[position];
    if (marker < 0xf1 || marker > 0xff) return invalid('unexpected_byte', base);
    if (position + 1 >= raw.length) return invalid('truncated_length', base);
    const slot = marker & 0x0f;
    const length = raw[position + 1];
    const start = position + 2;
    const end = start + length;
    if (end > raw.length) return invalid('truncated_body', base);
    if (seen.has(slot)) return invalid('duplicate_slot', base);
    const bytes = raw.slice(start, end);
    records.push({ slot, offset: position, length, bytes, text: byteText(bytes) });
    seen.add(slot);
    position = end;
  }
  if (records.length === 0) return { ok: false, disposition: 'empty', code: 'no_records', ...base, records: [], ...flags() };
  return { ok: true, disposition: 'wrapped', ...base, records, ...flags() };
}

function modelInput(input) {
  if (!exact(input, ['battery_mv', 'interrupt', 'payver', 'returns', 'max_payload_bytes'])
    || !Number.isSafeInteger(input.battery_mv) || input.battery_mv < 0 || input.battery_mv > 32767
    || typeof input.interrupt !== 'boolean' || !Number.isSafeInteger(input.payver) || input.payver < 0 || input.payver > 255
    || !Number.isSafeInteger(input.max_payload_bytes) || input.max_payload_bytes < 3 || input.max_payload_bytes > 255
    || !Array.isArray(input.returns) || input.returns.length < 1 || input.returns.length > 15) return null;
  const returns = [];
  const slots = new Set();
  for (let index = 0; index < input.returns.length; index += 1) {
    const item = input.returns[index];
    if (!(index in input.returns) || !exact(item, ['slot', 'bytes']) || !Number.isSafeInteger(item.slot)
      || item.slot < 1 || item.slot > 15 || slots.has(item.slot) || !byteArray(item.bytes, 0, 100)) return null;
    slots.add(item.slot);
    returns.push({ slot: item.slot, bytes: copiedBytes(item.bytes) });
  }
  return { battery_mv: input.battery_mv, interrupt: input.interrupt, payver: input.payver,
    returns, max_payload_bytes: input.max_payload_bytes };
}

function modelSingleUplink(input) {
  const model = modelInput(input);
  if (!model) return invalid('invalid_model_input');
  const first = (model.battery_mv >>> 8) | (model.interrupt ? 0x80 : 0);
  const bytes = [first, model.battery_mv & 0xff, model.payver];
  for (const item of model.returns) bytes.push(0xf0 | item.slot, item.bytes.length, ...item.bytes);
  const requiredBytes = bytes.length;
  if (requiredBytes > model.max_payload_bytes || requiredBytes > 255) {
    return invalid('payload_budget_exceeded', { required_bytes: requiredBytes, max_payload_bytes: model.max_payload_bytes });
  }
  return { ok: true, disposition: 'modelled', model: 'all_data_no_cut_single_v1', bytes, required_bytes: requiredBytes,
    max_payload_bytes: model.max_payload_bytes, ...flags() };
}

function bindingsInput(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 11) return null;
  const slots = new Set();
  const bindings = [];
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    if (!(index in value) || !exact(item, ['slot', 'response_command']) || !Number.isSafeInteger(item.slot)
      || item.slot < 1 || item.slot > 15 || slots.has(item.slot) || typeof item.response_command !== 'string'
      || item.response_command.length < 1 || item.response_command.length > 6) return null;
    slots.add(item.slot);
    bindings.push({ slot: item.slot, response_command: item.response_command });
  }
  return bindings;
}

function bridgeInvalid(code, wrapper, bindings) {
  return invalid(code, { bindings_verified: false,
    ...(wrapper === undefined ? {} : { wrapper }),
    ...(bindings === undefined ? {} : { bindings }) });
}

function inspectWrappedExchange(input) {
  if (!exact(input, ['frame', 'bindings'])) return bridgeInvalid('invalid_bridge_input');
  const wrapper = inspectFrame(input.frame);
  if (!wrapper.ok || wrapper.disposition !== 'wrapped') return bridgeInvalid('wrapper_not_complete', wrapper);
  const bindings = bindingsInput(input.bindings);
  if (!bindings) return bridgeInvalid('invalid_bindings', wrapper);
  if (bindings.length !== wrapper.records.length) return bridgeInvalid('bindings_do_not_match_records', wrapper, bindings);
  const bySlot = new Map(bindings.map(item => [item.slot, item]));
  if (wrapper.records.some(record => !bySlot.has(record.slot))) return bridgeInvalid('bindings_do_not_match_records', wrapper, bindings);
  const ordered = wrapper.records.map(record => ({ command: bySlot.get(record.slot).response_command, response: record.text }));
  const exchange = inspectExchange({ command: ordered[0].command, response: ordered[0].response, blocks: ordered.slice(1) });
  return { ok: exchange.ok, disposition: exchange.disposition, wrapper, bindings, exchange, bindings_verified: false,
    hardware_verified: false, acquisition_available: false, eligible: false, configuration_verified: false };
}

module.exports = { inspectFrame, modelSingleUplink, inspectWrappedExchange };
