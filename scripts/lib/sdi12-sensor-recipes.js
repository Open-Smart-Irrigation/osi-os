'use strict';

const path = require('node:path');
const { inspectExchange, calculateCapacity } = require('./sdi12-protocol-lab');
const { modelSingleUplink, inspectWrappedExchange } = require('./sdi12-converter-lab');
const normalizer = require(path.resolve(__dirname,
  '../../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-sdi12-normalize/configuration.js'));

const FLAGS = Object.freeze({
  hardware_verified: false,
  acquisition_available: false,
  eligible: false,
  configuration_verified: false,
  recipe_deployable: false,
});

const PROFILES = Object.freeze({
  DELTAT_PR2_4: {
    families: ['M', 'MC', 'C', 'CC'], suffix: '3', supply: [7.2, 16],
    reference: { url: 'https://delta-t.co.uk/wp-content/uploads/2016/09/PR2_SDI-12-_User_Manual_version_4_1.pdf', locator: 'pp.49-52', scope: 'PR2 SDI-12 manual v4.1' },
    unresolved: ['calibration_readback_and_units', 'installed_model_depth_count'], readbacks: 4,
  },
  DELTAT_PR2_6: {
    families: ['M', 'MC', 'C', 'CC'], suffix: '3', supply: [7.2, 16],
    reference: { url: 'https://delta-t.co.uk/wp-content/uploads/2016/09/PR2_SDI-12-_User_Manual_version_4_1.pdf', locator: 'pp.49-52', scope: 'PR2 SDI-12 manual v4.1' },
    unresolved: ['calibration_readback_and_units', 'installed_model_depth_count'], readbacks: 6,
  },
  METER_TEROS_11: {
    families: ['M', 'MC'], suffix: '', supply: [4, 15],
    reference: { url: 'https://publications.metergroup.com/Integrator%20Guide/18224%20TEROS%2011-12%20Integrator%20Guide.pdf', locator: 'pp.7-8', scope: 'TEROS 11/12 integrator guide revision 12, firmware 3.00+' },
    unresolved: ['firmware_applicability', 'raw_equation_mapping'], readbacks: 0,
  },
  METER_TEROS_12: {
    families: ['M', 'MC'], suffix: '', supply: [4, 15],
    reference: { url: 'https://publications.metergroup.com/Integrator%20Guide/18224%20TEROS%2011-12%20Integrator%20Guide.pdf', locator: 'pp.7-8', scope: 'TEROS 11/12 integrator guide revision 12, firmware 3.00+' },
    unresolved: ['firmware_applicability', 'raw_equation_mapping', 'ec_units'], readbacks: 0,
  },
  TENSIOMARK: {
    families: ['M'], suffix: '', supply: [7, 14],
    reference: { url: 'https://www.stevenswater.com/resources/documentation/Stevens_Tensiomark_Manual.pdf', locator: '§§5.1.5, 6, 7', scope: 'ecoTech Tensiomark May 2014, variant 1' },
    unresolved: ['installed_variant', 'response_order', 'sensor_error_contract'], readbacks: 0,
  },
});

function flags() { return { ...FLAGS }; }
function result(ok, disposition, extra) { return { ok, disposition, ...(extra || {}), ...flags() }; }
function invalid(code, extra) { return result(false, 'invalid', { code, ...(extra || {}) }); }
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function exact(value, keys) {
  if (!object(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every(key => Object.prototype.hasOwnProperty.call(value, key));
}
function ascii(value) { return Array.from(Buffer.from(value, 'ascii')); }
function rawBytes(value) { return Array.from(Buffer.from(value, 'latin1')); }
function copyConverter(value) {
  return { battery_mv: value.battery_mv, interrupt: value.interrupt, payver: value.payver,
    max_slots: value.max_slots, max_payload_bytes: value.max_payload_bytes };
}

function converterValid(value) {
  return exact(value, ['battery_mv', 'interrupt', 'payver', 'max_slots', 'max_payload_bytes'])
    && Number.isSafeInteger(value.battery_mv) && value.battery_mv >= 0 && value.battery_mv <= 32767
    && typeof value.interrupt === 'boolean'
    && Number.isSafeInteger(value.payver) && value.payver >= 0 && value.payver <= 255
    && Number.isSafeInteger(value.max_slots) && value.max_slots >= 1 && value.max_slots <= 15
    && Number.isSafeInteger(value.max_payload_bytes) && value.max_payload_bytes >= 3 && value.max_payload_bytes <= 255;
}

function validInput(input) {
  return exact(input, ['configuration', 'command_family', 'supply_v', 'power_mode', 'interval_seconds', 'converter', 'exchange'])
    && typeof input.command_family === 'string' && ['M', 'MC', 'C', 'CC'].includes(input.command_family)
    && typeof input.supply_v === 'number' && Number.isFinite(input.supply_v)
    && (input.power_mode === 'continuous' || input.power_mode === 'switched')
    && Number.isSafeInteger(input.interval_seconds) && input.interval_seconds >= 1 && input.interval_seconds <= 86400
    && converterValid(input.converter) && Object.prototype.hasOwnProperty.call(input, 'exchange');
}

function sourceCommand(purpose, command) { return { purpose, command, bytes: ascii(command) }; }
function capacity(commandFamily, expectedValues, converter) {
  const family = commandFamily[0];
  const crc = commandFamily.length === 2;
  const packed = calculateCapacity({ family, value_count: expectedValues, value_width: 9, crc });
  const announcementLength = family === 'M' ? 7 : 8;
  const packedPayloadBytes = 3 + 2 + announcementLength + packed.packed_wire_bytes + (2 * packed.packed_blocks);
  const maxPayloadBytes = 3 + 2 + announcementLength
    + expectedValues * (2 + 3 + 9 + (crc ? 3 : 0));
  return {
    assumption: 'hypothetical_signed_token_width_9',
    packed_data_blocks: packed.packed_blocks,
    max_successful_data_blocks: expectedValues,
    packed_slots: 1 + packed.packed_blocks,
    max_slots: 1 + expectedValues,
    packed_payload_bytes: packedPayloadBytes,
    max_payload_bytes: maxPayloadBytes,
    packed_payload_fits: packedPayloadBytes <= converter.max_payload_bytes,
    max_payload_fits: maxPayloadBytes <= converter.max_payload_bytes,
    max_slots_fit: 1 + expectedValues <= converter.max_slots,
    actual_layout_known: false,
    regional_budget_verified: false,
  };
}

function buildRecipe(input, resolved, profile) {
  const address = resolved.configuration.address;
  const command = address + input.command_family + profile.suffix + '!';
  const discovery = [sourceCommand('identify', address + 'I!')];
  for (let index = 1; index <= profile.readbacks; index += 1) {
    discovery.push(sourceCommand('calibration_readback', address + 'XRM3S' + index + '!'));
  }
  const unresolved = [...profile.unresolved, 'converter_application', 'whole_reply_preservation',
    'acquisition_freshness', 'startup_power_timing'];
  if (resolved.configuration.profile_id.startsWith('METER_TEROS') && address === '0' && input.power_mode === 'continuous') {
    unresolved.push('initial_startup_handling');
  }
  return {
    version: 1,
    configuration: structuredClone(resolved.configuration),
    expected_values: resolved.expected_values,
    command_family: input.command_family,
    supply_v: input.supply_v,
    power_mode: input.power_mode,
    interval_seconds: input.interval_seconds,
    converter: copyConverter(input.converter),
    discovery,
    measurement: { command, bytes: ascii(command) },
    retrieval: {
      policy: 'until_announced_count', wait: 'announced_seconds',
      commands: Array.from({ length: 10 }, (_, index) => address + 'D' + index + '!'),
      stop_on_empty: true, max_successful_data_blocks: resolved.expected_values,
    },
    reference: { ...profile.reference },
    unresolved,
    fixed_converter_recipe: null,
    power_window_ms: null,
    capacity: capacity(input.command_family, resolved.expected_values, input.converter),
  };
}

function withRecipe(ok, disposition, recipe, extra) {
  return result(ok, disposition, { recipe, ...(extra || {}) });
}

function simulate(input, recipe, expectedValues) {
  if (!object(input.exchange) || input.exchange.command !== recipe.measurement.command) {
    return invalid('recipe_command_mismatch', { recipe });
  }
  const protocol = inspectExchange(input.exchange);
  const simulation = { protocol };
  if (Object.prototype.hasOwnProperty.call(protocol, 'announced_count') && protocol.announced_count !== expectedValues) {
    return withRecipe(false, 'invalid', recipe, { code: 'profile_count_mismatch', simulation });
  }
  if (Object.prototype.hasOwnProperty.call(protocol, 'wait_seconds') && protocol.wait_seconds > input.interval_seconds) {
    return withRecipe(false, 'invalid', recipe, { code: 'interval_below_announced_wait', simulation });
  }
  if (!protocol.ok || protocol.disposition !== 'complete') {
    return withRecipe(false, protocol.disposition, recipe, { code: protocol.code, simulation });
  }
  const rawResponses = [input.exchange.response, ...input.exchange.blocks.map(item => item.response)];
  const commands = [input.exchange.command, ...input.exchange.blocks.map(item => item.command)];
  const requiredSlots = rawResponses.length;
  if (requiredSlots > input.converter.max_slots) {
    return withRecipe(false, 'invalid', recipe, { code: 'command_slot_budget_exceeded', required_slots: requiredSlots, simulation });
  }
  const payload = modelSingleUplink({
    battery_mv: input.converter.battery_mv, interrupt: input.converter.interrupt, payver: input.converter.payver,
    returns: rawResponses.map((response, index) => ({ slot: index + 1, bytes: rawBytes(response) })),
    max_payload_bytes: input.converter.max_payload_bytes,
  });
  simulation.payload = payload;
  if (!payload.ok) return withRecipe(false, 'invalid', recipe, { code: payload.code, simulation });
  const roundtrip = inspectWrappedExchange({
    frame: {
      fport: 2, bytes: payload.bytes,
      configuration: { dataup: 0, payver: input.converter.payver, alldatamod: 1, datacut: 'none', dataconv: 'none', ext: [0, 0, 0] },
    },
    bindings: commands.map((responseCommand, index) => ({ slot: index + 1, response_command: responseCommand })),
  });
  simulation.roundtrip = roundtrip;
  simulation.evidence = 'modelled_from_supplied_exchange';
  simulation.timing_verified = false;
  if (!roundtrip.ok) return withRecipe(false, 'invalid', recipe, { code: roundtrip.code || 'model_roundtrip_failed', simulation });
  return withRecipe(true, 'simulated', recipe, { simulation });
}

function previewRecipe(input) {
  if (!validInput(input)) return invalid('invalid_input');
  const resolved = normalizer.resolveConfiguration(input.configuration);
  if (!resolved.ok) return invalid(resolved.code);
  const profile = PROFILES[resolved.configuration.profile_id];
  if (!profile) return invalid('unknown_profile');
  if (!profile.families.includes(input.command_family)) return invalid('unsupported_sensor_command');
  if (input.supply_v < profile.supply[0] || input.supply_v > profile.supply[1]) return invalid('unsupported_supply_voltage');
  if (resolved.configuration.profile_id === 'TENSIOMARK' && input.interval_seconds < 900) {
    return invalid('measurement_interval_too_short');
  }
  if (resolved.configuration.profile_id.startsWith('METER_TEROS')
    && resolved.configuration.address === '0' && input.power_mode === 'switched') {
    return invalid('startup_string_requires_handling');
  }
  const recipe = buildRecipe(input, resolved, profile);
  if (input.exchange === null) return withRecipe(true, 'planned', recipe);
  return simulate(input, recipe, resolved.expected_values);
}

module.exports = { previewRecipe };
