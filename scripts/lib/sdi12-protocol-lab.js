'use strict';

const QUALIFICATION = Object.freeze({
  hardware_verified: false,
  acquisition_available: false,
  eligible: false,
});

function qualifications() { return { ...QUALIFICATION }; }
function invalid(code) { return { ok: false, disposition: 'invalid', code, ...qualifications() }; }
function isObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }

function exactObject(value, keys) {
  if (!isObject(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every(key => Object.prototype.hasOwnProperty.call(value, key));
}

function crc16(text) {
  let crc = 0;
  for (let index = 0; index < text.length; index += 1) {
    crc ^= text.charCodeAt(index);
    for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? ((crc >>> 1) ^ 0xa001) : (crc >>> 1);
  }
  return crc & 0xffff;
}

function encodedCrc(text) {
  const crc = crc16(text);
  return String.fromCharCode(0x40 | (crc >>> 12), 0x40 | ((crc >>> 6) & 63), 0x40 | (crc & 63));
}

function parseCommand(command) {
  if (typeof command !== 'string' || command.length > 6) return null;
  const match = /^([0-9A-Za-z])(MC|CC|M|C)([1-9]?)!$/.exec(command);
  if (!match) return null;
  return { address: match[1], family: match[2][0], crc_requested: match[2].length === 2 };
}

function parseAnnouncement(response, command) {
  if (typeof response !== 'string' || response.length > 8 || !response.endsWith('\r\n')) return null;
  const body = response.slice(0, -2);
  const match = (command.family === 'M'
    ? /^([0-9A-Za-z])(\d{3})(\d)$/
    : /^([0-9A-Za-z])(\d{3})(\d{2})$/).exec(body);
  if (!match || match[1] !== command.address) return null;
  return { wait_seconds: Number(match[2]), announced_count: Number(match[3]) };
}

function validateBlocks(blocks) {
  if (!Array.isArray(blocks) || blocks.length > 10) return 'invalid_blocks';
  for (let index = 0; index < blocks.length; index += 1) {
    if (!(index in blocks) || !exactObject(blocks[index], ['command', 'response'])
      || typeof blocks[index].command !== 'string' || typeof blocks[index].response !== 'string'
      || blocks[index].response.length > 81) return 'invalid_block';
  }
  return null;
}

function parseTokens(body) {
  if (body === '') return { tokens: [], values: [] };
  const tokens = [];
  for (let index = 0; index < body.length;) {
    if (body[index] !== '+' && body[index] !== '-') return null;
    const start = index;
    index += 1;
    while (index < body.length && body[index] !== '+' && body[index] !== '-') {
      const character = body[index];
      if ((character < '0' || character > '9') && character !== '.') return null;
      index += 1;
    }
    const token = body.slice(start, index);
    const digits = token.slice(1).replace('.', '');
    if (token.length > 9 || digits.length < 1 || digits.length > 7 || (token.match(/\./g) || []).length > 1) return null;
    tokens.push(token);
  }
  const values = tokens.map(token => Number(token));
  return values.every(Number.isFinite) ? { tokens, values } : null;
}

function parseDataReply(raw, address, crcRequested, cap) {
  if (!raw.endsWith('\r\n')) return { code: 'invalid_data_framing' };
  const content = raw.slice(0, -2);
  if (content[0] !== address) return { code: 'data_address_mismatch' };
  let numericBody;
  if (crcRequested) {
    if (content.length < 4) return { code: 'invalid_crc' };
    numericBody = content.slice(1, -3);
    if (content.slice(-3) !== encodedCrc(address + numericBody)) return { code: 'invalid_crc' };
  } else {
    numericBody = content.slice(1);
  }
  if (numericBody.length > cap) return { code: 'data_body_too_long' };
  const parsed = parseTokens(numericBody);
  if (!parsed) return { code: 'invalid_numeric_body' };
  return {
    numericBody,
    tokens: parsed.tokens,
    values: parsed.values,
    block: {
      raw_response: raw,
      value_characters: numericBody.length,
      wire_bytes: raw.length,
      tokens: parsed.tokens.slice(),
    },
  };
}

function exchangeFields(command, announcement) {
  return {
    address: command.address,
    family: command.family,
    crc_requested: command.crc_requested,
    wait_seconds: announcement.wait_seconds,
    announced_count: announcement.announced_count,
  };
}

function inspectExchange(input) {
  if (!exactObject(input, ['command', 'response', 'blocks'])) return invalid('invalid_input');
  const command = parseCommand(input.command);
  if (!command) return invalid('invalid_command');
  const announcement = parseAnnouncement(input.response, command);
  if (!announcement) return invalid('invalid_announcement');
  const blockError = validateBlocks(input.blocks);
  if (blockError) return invalid(blockError);
  const fields = exchangeFields(command, announcement);
  if (announcement.announced_count === 0) {
    if (announcement.wait_seconds !== 0 || input.blocks.length !== 0) return invalid('invalid_zero_count');
    return { ok: false, disposition: 'no_values', code: 'no_values', ...fields, values: [], tokens: [], blocks: [], ...qualifications() };
  }

  const values = [];
  const tokens = [];
  const blocks = [];
  const cap = command.family === 'M' ? 35 : 75;
  for (let index = 0; index < input.blocks.length; index += 1) {
    if (values.length === announcement.announced_count) return invalid('extra_block_after_completion');
    const item = input.blocks[index];
    if (item.command !== `${command.address}D${index}!`) return invalid('unexpected_data_command');
    const parsed = parseDataReply(item.response, command.address, command.crc_requested, cap);
    if (parsed.code) return invalid(parsed.code);
    blocks.push({ command: item.command, ...parsed.block });
    if (parsed.values.length === 0) {
      if (index + 1 < input.blocks.length) return invalid('extra_block_after_abortion');
      return { ok: false, disposition: 'aborted', code: 'measurement_aborted', ...fields, blocks, ...qualifications() };
    }
    if (values.length + parsed.values.length > announcement.announced_count) return invalid('announced_count_exceeded');
    values.push(...parsed.values);
    tokens.push(...parsed.tokens);
  }
  if (values.length === announcement.announced_count) {
    return { ok: true, disposition: 'complete', ...fields, values, tokens, blocks, ...qualifications() };
  }
  if (input.blocks.length === 10) {
    return { ok: false, disposition: 'incomplete', code: 'data_blocks_exhausted', ...fields, values, tokens, blocks, ...qualifications() };
  }
  return {
    ok: false,
    disposition: 'incomplete',
    code: 'incomplete_data',
    ...fields,
    values,
    tokens,
    blocks,
    next_command: `${command.address}D${input.blocks.length}!`,
    ...qualifications(),
  };
}

function calculateCapacity(input) {
  if (!exactObject(input, ['family', 'value_count', 'value_width', 'crc'])) return invalid('invalid_capacity_input');
  const validFamily = input.family === 'M' || input.family === 'C';
  const maxValues = input.family === 'M' ? 9 : 99;
  if (!validFamily || !Number.isSafeInteger(input.value_count) || input.value_count < 1 || input.value_count > maxValues
    || !Number.isSafeInteger(input.value_width) || input.value_width < 2 || input.value_width > 9 || typeof input.crc !== 'boolean') {
    return invalid('invalid_capacity_input');
  }
  const valueCharactersPerBlock = input.family === 'M' ? 35 : 75;
  const valuesPerPackedBlock = Math.floor(valueCharactersPerBlock / input.value_width);
  const packedBlocks = Math.ceil(input.value_count / valuesPerPackedBlock);
  return {
    ok: true,
    disposition: 'capacity',
    family: input.family,
    value_count: input.value_count,
    value_width: input.value_width,
    crc: input.crc,
    value_characters_per_block: valueCharactersPerBlock,
    values_per_packed_block: valuesPerPackedBlock,
    packed_blocks: packedBlocks,
    packed_wire_bytes: input.value_count * input.value_width + packedBlocks * (3 + (input.crc ? 3 : 0)),
    fits_ten_blocks: packedBlocks <= 10,
    packing_assumption: 'equal_width_tightly_packed',
    actual_block_count_known: false,
    ...qualifications(),
  };
}

module.exports = { inspectExchange, calculateCapacity };
