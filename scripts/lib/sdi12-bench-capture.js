'use strict';

const { previewRecipe } = require('./sdi12-sensor-recipes');
const { inspectExchange } = require('./sdi12-protocol-lab');
const { inspectWrappedExchange } = require('./sdi12-converter-lab');

const FLAGS = Object.freeze({
  hardware_verified: false,
  configuration_verified: false,
  acquisition_available: false,
  eligible: false,
  recipe_deployable: false,
});

const RECORD_KEYS = ['version', 'evidence', 'scope', 'capture_id', 'captured_at', 'setup', 'recipe_input', 'discovery', 'timing', 'radio'];
const SETUP_KEYS = ['sensor_label', 'converter_model', 'converter_firmware', 'converter_settings_text'];
const TIMING_KEYS = ['measurement_started_ms', 'announcement_received_ms', 'data_requested_ms', 'since_previous_start_ms', 'power_on_ms'];
const RADIO_KEYS = ['received_at', 'dev_eui', 'session_ref', 'fcnt_up', 'frame', 'bindings'];

function flags() { return { ...FLAGS }; }
function outcome(ok, disposition, extra) { return { ok, disposition, ...(extra || {}), ...flags() }; }
function invalid(code, extra) { return outcome(false, 'invalid', { code, ...(extra || {}) }); }
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function exact(value, keys) {
  if (!object(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every(key => Object.prototype.hasOwnProperty.call(value, key));
}
function denseArray(value, maximum) {
  if (!Array.isArray(value) || value.length > maximum) return false;
  for (let index = 0; index < value.length; index += 1) if (!(index in value)) return false;
  return true;
}
function byteArray(value, maximum) {
  if (!denseArray(value, maximum)) return false;
  return value.every(byte => Number.isSafeInteger(byte) && byte >= 0 && byte <= 255);
}
function nonblank(value, maximum) {
  return typeof value === 'string' && value.length <= maximum && value.trim().length > 0;
}
function nullableText(value, maximum) { return value === null || nonblank(value, maximum); }
function utcTimestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const date = new Date(value);
  return !Number.isNaN(date.valueOf()) && date.toISOString() === value;
}
function nullableTime(value) { return value === null || (Number.isSafeInteger(value) && value >= 0 && value <= 86400000); }
function cloneSafely(value) {
  try {
    return { ok: true, value: structuredClone(value) };
  } catch (error) {
    return { ok: false, error_name: error && error.name ? error.name : 'clone_failed' };
  }
}

function validSetup(value) {
  return exact(value, SETUP_KEYS)
    && nullableText(value.sensor_label, 256)
    && nullableText(value.converter_model, 256)
    && nullableText(value.converter_firmware, 256)
    && nullableText(value.converter_settings_text, 32768);
}

function validTiming(value) {
  return exact(value, TIMING_KEYS)
    && nullableTime(value.measurement_started_ms)
    && nullableTime(value.announcement_received_ms)
    && nullableTime(value.since_previous_start_ms)
    && nullableTime(value.power_on_ms)
    && denseArray(value.data_requested_ms, 10)
    && value.data_requested_ms.every(nullableTime);
}

function validDiscovery(value) {
  if (!denseArray(value, 7)) return false;
  return value.every(item => exact(item, ['command', 'response_bytes'])
    && typeof item.command === 'string' && item.command.length >= 1 && item.command.length <= 16
    && (item.response_bytes === null || byteArray(item.response_bytes, 1024)));
}

function validRadioMetadata(value) {
  return exact(value, RADIO_KEYS)
    && utcTimestamp(value.received_at)
    && typeof value.dev_eui === 'string' && /^[0-9a-fA-F]{16}$/.test(value.dev_eui)
    && nullableText(value.session_ref, 128)
    && Number.isSafeInteger(value.fcnt_up) && value.fcnt_up >= 0 && value.fcnt_up <= 0xffffffff
    && Object.prototype.hasOwnProperty.call(value, 'frame')
    && Object.prototype.hasOwnProperty.call(value, 'bindings');
}

function validRecord(record) {
  return exact(record, RECORD_KEYS)
    && record.version === 1
    && (record.evidence === 'bench' || record.evidence === 'synthetic')
    && (record.scope === 'serial' || record.scope === 'radio')
    && nullableText(record.capture_id, 128)
    && (record.captured_at === null || utcTimestamp(record.captured_at))
    && validSetup(record.setup)
    && validDiscovery(record.discovery)
    && validTiming(record.timing)
    && (record.radio === null || validRadioMetadata(record.radio));
}

function logicalPlanInput(recipeInput) {
  if (!object(recipeInput) || !Object.prototype.hasOwnProperty.call(recipeInput, 'exchange')) return recipeInput;
  return { ...recipeInput, exchange: null };
}

function completeExchangeShape(exchange) {
  return exact(exchange, ['command', 'response', 'blocks'])
    && typeof exchange.command === 'string'
    && typeof exchange.response === 'string'
    && denseArray(exchange.blocks, 10)
    && exchange.blocks.every(block => exact(block, ['command', 'response'])
      && typeof block.command === 'string' && typeof block.response === 'string');
}

function exchangeHasBlocksArray(exchange) {
  return object(exchange) && Array.isArray(exchange.blocks);
}

function announcementInput(exchange) {
  if (!object(exchange) || typeof exchange.command !== 'string' || typeof exchange.response !== 'string') return null;
  return { command: exchange.command, response: exchange.response, blocks: [] };
}

function publicFields(capture, plan, preview, radioCheck) {
  const unresolved = [];
  if (plan && plan.recipe && Array.isArray(plan.recipe.unresolved)) unresolved.push(...plan.recipe.unresolved);
  unresolved.push('identity_and_readback_semantics', 'operator_metadata_unverified', 'cross_observation_freshness');
  if (capture.timing.since_previous_start_ms === null) unresolved.push('previous_start_unknown');
  return {
    capture,
    plan,
    ...(preview === undefined ? {} : { preview }),
    ...(radioCheck === undefined ? {} : { radio_check: radioCheck }),
    evidence: capture.evidence,
    timing_verified: false,
    bindings_verified: false,
    qualification: 'not_assessed',
    unresolved: [...new Set(unresolved)],
  };
}

function planFailure(capture, plan) {
  return outcome(false, plan.disposition, { code: plan.code, capture, plan });
}

function discoveryMatches(capture, plan) {
  const expected = plan.recipe.discovery;
  return capture.discovery.length === expected.length
    && capture.discovery.every((item, index) => item.command === expected[index].command);
}

function missingEvidence(capture, hasBlocksArray) {
  const missing = [];
  if (capture.capture_id === null) missing.push('capture_id');
  if (capture.captured_at === null) missing.push('captured_at');
  if (capture.setup.sensor_label === null) missing.push('setup.sensor_label');
  for (let index = 0; index < capture.discovery.length; index += 1) {
    const response = capture.discovery[index].response_bytes;
    if (response === null || response.length === 0) missing.push(`discovery[${index}].response_bytes`);
  }
  if (capture.recipe_input === null || !object(capture.recipe_input) || capture.recipe_input.exchange === null) missing.push('exchange');
  if (capture.timing.measurement_started_ms === null) missing.push('timing.measurement_started_ms');
  if (capture.timing.announcement_received_ms === null) missing.push('timing.announcement_received_ms');
  if (hasBlocksArray) {
    for (let index = 0; index < capture.timing.data_requested_ms.length; index += 1) {
      if (capture.timing.data_requested_ms[index] === null) missing.push(`timing.data_requested_ms[${index}]`);
    }
  }
  if (capture.scope === 'radio') {
    if (capture.setup.converter_model === null) missing.push('setup.converter_model');
    if (capture.setup.converter_firmware === null) missing.push('setup.converter_firmware');
    if (capture.setup.converter_settings_text === null) missing.push('setup.converter_settings_text');
    if (capture.radio === null) missing.push('radio');
    else if (capture.radio.session_ref === null) missing.push('radio.session_ref');
  }
  return missing;
}

function timingError(capture, hasBlocksArray, plan) {
  const timing = capture.timing;
  const exchange = object(capture.recipe_input) ? capture.recipe_input.exchange : undefined;
  if (exchange === null && timing.data_requested_ms.length > 0) return 'timing_blocks_mismatch';
  if (hasBlocksArray && timing.data_requested_ms.length !== exchange.blocks.length) return 'timing_blocks_mismatch';
  if (timing.measurement_started_ms !== null && timing.announcement_received_ms !== null
    && timing.announcement_received_ms < timing.measurement_started_ms) return 'timing_order_invalid';
  if (timing.power_on_ms !== null && timing.measurement_started_ms !== null
    && timing.power_on_ms > timing.measurement_started_ms) return 'timing_order_invalid';
  let previous = null;
  for (const requested of timing.data_requested_ms) {
    if (requested === null) continue;
    if ((timing.measurement_started_ms !== null && requested < timing.measurement_started_ms)
      || (timing.announcement_received_ms !== null && requested < timing.announcement_received_ms)
      || (previous !== null && requested < previous)) return 'timing_order_invalid';
    previous = requested;
  }
  const announcementRequest = announcementInput(exchange);
  if (announcementRequest) {
    const announcement = inspectExchange(announcementRequest);
    if (typeof announcement.wait_seconds === 'number' && timing.announcement_received_ms !== null) {
      const notBefore = timing.announcement_received_ms + announcement.wait_seconds * 1000;
      if (timing.data_requested_ms.some(requested => requested !== null && requested < notBefore)) return 'announced_wait_not_observed';
    }
  }
  if (plan.recipe.configuration.profile_id === 'TENSIOMARK'
    && timing.since_previous_start_ms !== null && timing.since_previous_start_ms < 900000) return 'measurement_interval_not_observed';
  return null;
}

function serialPairs(exchange) {
  if (!completeExchangeShape(exchange)) return null;
  return [{ command: exchange.command, response: exchange.response }, ...exchange.blocks];
}

function radioPairs(radioCheck) {
  if (!radioCheck || !radioCheck.wrapper || !Array.isArray(radioCheck.wrapper.records) || !Array.isArray(radioCheck.bindings)) return null;
  const labels = new Map(radioCheck.bindings.map(binding => [binding.slot, binding.response_command]));
  return radioCheck.wrapper.records.map(record => ({ command: labels.get(record.slot), response: record.text }));
}

function radioError(capture, radioCheck) {
  if (capture.scope === 'serial') return capture.radio === null ? null : 'scope_radio_mismatch';
  if (capture.radio === null) return null;
  if (capture.captured_at !== null && new Date(capture.radio.received_at).valueOf() < new Date(capture.captured_at).valueOf()) return 'radio_time_order_invalid';
  if (!radioCheck.ok) return 'radio_not_complete';
  const wrapper = radioCheck.wrapper;
  const converter = object(capture.recipe_input) ? capture.recipe_input.converter : undefined;
  if (!object(converter)) return null;
  if (wrapper.raw_bytes.length > converter.max_payload_bytes) return 'radio_payload_budget_exceeded';
  if (wrapper.records.length > converter.max_slots) return 'radio_slot_budget_exceeded';
  if (wrapper.header.payver !== converter.payver) return 'radio_payver_mismatch';
  const serial = object(capture.recipe_input) ? serialPairs(capture.recipe_input.exchange) : null;
  const radio = radioPairs(radioCheck);
  if (serial && radio && (serial.length !== radio.length || serial.some((item, index) => item.command !== radio[index].command || item.response !== radio[index].response))) {
    return 'radio_exchange_mismatch';
  }
  return null;
}

function createCaptureTemplate(recipeInput) {
  if (object(recipeInput) && Object.prototype.hasOwnProperty.call(recipeInput, 'exchange') && recipeInput.exchange !== null) {
    return invalid('template_requires_plan');
  }
  const plan = previewRecipe(recipeInput);
  if (!plan.ok) return outcome(false, plan.disposition, { code: plan.code });
  const copied = cloneSafely(recipeInput);
  if (!copied.ok) return invalid('invalid_input');
  const input = copied.value;
  return outcome(true, 'template', { capture: {
    version: 1,
    evidence: 'bench',
    scope: 'serial',
    capture_id: null,
    captured_at: null,
    setup: { sensor_label: null, converter_model: null, converter_firmware: null, converter_settings_text: null },
    recipe_input: input,
    discovery: plan.recipe.discovery.map(item => ({ command: item.command, response_bytes: null })),
    timing: { measurement_started_ms: null, announcement_received_ms: null, data_requested_ms: [], since_previous_start_ms: null, power_on_ms: null },
    radio: null,
  } });
}

function inspectCapture(record) {
  if (!validRecord(record)) return invalid('invalid_capture');
  const copied = cloneSafely(record);
  if (!copied.ok) return invalid('invalid_capture');
  const capture = copied.value;
  const plan = previewRecipe(logicalPlanInput(capture.recipe_input));
  if (!plan.ok) return planFailure(capture, plan);
  if (!discoveryMatches(capture, plan)) return outcome(false, 'invalid', { code: 'discovery_commands_mismatch', ...publicFields(capture, plan) });

  const preview = previewRecipe(capture.recipe_input);
  const exchange = object(capture.recipe_input) ? capture.recipe_input.exchange : undefined;
  const hasBlocksArray = exchangeHasBlocksArray(exchange);
  const timing = timingError(capture, hasBlocksArray, plan);
  if (timing) return outcome(false, 'invalid', { code: timing, ...publicFields(capture, plan, preview) });

  const radioCheck = capture.scope === 'radio' && capture.radio !== null
    ? inspectWrappedExchange({ frame: capture.radio.frame, bindings: capture.radio.bindings }) : undefined;
  const radio = radioError(capture, radioCheck);
  if (radio) return outcome(false, 'invalid', { code: radio, ...publicFields(capture, plan, preview, radioCheck) });
  if (!preview.ok) return outcome(false, preview.disposition, { code: preview.code, ...publicFields(capture, plan, preview, radioCheck) });

  const missing = missingEvidence(capture, hasBlocksArray);
  if (missing.length > 0) return outcome(false, 'incomplete', { code: 'capture_incomplete', missing, ...publicFields(capture, plan, preview, radioCheck) });
  return outcome(true, 'consistent', publicFields(capture, plan, preview, radioCheck));
}

module.exports = { createCaptureTemplate, inspectCapture };
