'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const recipe = require('./index.js');

function frameHex(frame) {
  return Buffer.from(frame.hex, 'hex').toString('hex').toUpperCase();
}

function buildLayout(length, typeMask, address) {
  const sensors = [];
  for (let position = 1; position <= length; position++) {
    // Stable channel IDs deliberately differ from response positions. Recipe
    // bytes must depend only on response groups, not this persistent identity.
    const channel = 11 - position;
    sensors.push({
      channel,
      response_position: position,
      depth_cm: 100 + channel,
      type: (typeMask & (1 << (position - 1))) ? 'TRISCAN' : 'ENVIROSCAN',
    });
  }
  return { version: 1, address, sensors: sensors.reverse() };
}

function compiled(layout) {
  const result = recipe.compileSentekRecipe(layout);
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.recipe;
}

function commandSlots(compiledRecipe) {
  return compiledRecipe.slots.map((slot) => slot.command);
}

function valuesInCut(cut) {
  const match = /^(\d+),2,2~\d+$/.exec(cut);
  assert.ok(match, `unexpected cut: ${cut}`);
  return (Number(match[1]) - 3) / 9;
}

function assertAfLengthsMatchAscii(compiledRecipe) {
  for (const entry of compiledRecipe.frames.filter((frame) => frame.hex.startsWith('AF'))) {
    const bytes = Buffer.from(entry.hex, 'hex');
    assert.equal(bytes[3], bytes.length - 5, entry.hex);
  }
}

function expectedFamilySlots(address, measure, count) {
  const chunks = count === 10
    ? [3, 3, 3, 1]
    : [Math.min(count, 3), Math.min(Math.max(count - 3, 0), 3), Math.max(count - 6, 0)].filter(Boolean);
  const tenthMeasure = measure === `${address}M!,1,1,2`
    ? `${address}M1!,1,1,2`
    : `${address}M3!,1,1,2`;
  const commands = count === 10
    ? [measure, `${address}D1!,0,0,2`, `${address}D2!,0,0,2`, tenthMeasure]
    : [measure].concat(count > 3 ? [`${address}D1!,0,0,2`] : [], count > 6 ? [`${address}D2!,0,0,2`] : []);
  return { commands, chunks };
}

test('canonical layout hash ignores object key and sensor input order while response order stays canonical', () => {
  const unordered = {
    sensors: [
      { type: 'ENVIROSCAN', depth_cm: 400, channel: 7, response_position: 2 },
      { response_position: 1, channel: 3, type: 'TRISCAN', depth_cm: 200 },
    ],
    address: 'C',
    version: 1,
  };
  const ordered = {
    version: 1,
    address: 'C',
    sensors: [
      { channel: 3, response_position: 1, depth_cm: 200, type: 'TRISCAN' },
      { channel: 7, response_position: 2, depth_cm: 400, type: 'ENVIROSCAN' },
    ],
  };

  assert.equal(recipe.canonicalLayoutHash(unordered), recipe.canonicalLayoutHash(ordered));
  assert.deepEqual(commandSlots(compiled(unordered)), ['CM!,1,1,2', 'CM2!,1,1,2']);
  assert.equal(compiled(unordered).address, 'C');
});

test('invalid layouts fail through the existing normalizer gate with a bounded error', () => {
  const result = recipe.compileSentekRecipe({ version: 1, address: '!', sensors: [] });
  assert.deepEqual(Object.keys(result).sort(), ['code', 'message', 'ok']);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'invalid_layout');
  assert.match(result.message, /sensor_count|invalid_address/);
  assert.throws(() => recipe.canonicalLayoutHash({ version: 1, address: '!', sensors: [] }), /invalid layout/);
});

test('all 2,046 Sentek type masks compile response-position-only recipes within eight slots', () => {
  let cases = 0;
  const addresses = ['0', 'C', '9', 'a'];
  for (let length = 1; length <= 10; length++) {
    for (let typeMask = 0; typeMask < (1 << length); typeMask++) {
      const layout = buildLayout(length, typeMask, addresses[cases % addresses.length]);
      const compiledRecipe = compiled(layout);
      const expectedVwc = length;
      const expectedVic = layout.sensors.filter((sensor) => sensor.type === 'TRISCAN').length;
      const commands = commandSlots(compiledRecipe);
      const commandAscii = commands.join('|');

      assert.equal(compiledRecipe.address, layout.address);
      assert.equal(compiledRecipe.slots.length <= 8, true);
      assertAfLengthsMatchAscii(compiledRecipe);
      const vwcEnd = commands.findIndex((command) => command.includes('M2!') || command.includes('M3!'));
      const vicStart = vwcEnd === -1 ? commands.length : vwcEnd;
      assert.equal(compiledRecipe.slots.slice(0, vicStart).reduce((sum, slot) => sum + valuesInCut(slot.cut), 0), expectedVwc);
      assert.equal(compiledRecipe.slots.slice(vicStart).reduce((sum, slot) => sum + valuesInCut(slot.cut), 0), expectedVic);
      assert.equal(commands.slice(0, vicStart).every((command) => /^(?:0|C|9|a)(?:M!?|M1!?|D1!?|D2!?),[01],[01],2$/.test(command)), true);
      assert.equal(commands.slice(vicStart).every((command) => /^(?:0|C|9|a)(?:M2!?|M3!?|D1!?|D2!?),[01],[01],2$/.test(command)), true);
      assert.equal(commands.every((command) => command.startsWith(layout.address)), true);
      for (const sensor of layout.sensors) {
        assert.equal(commandAscii.includes(String(sensor.depth_cm)), false);
      }
      cases++;
    }
  }
  assert.equal(cases, 2046);
});

test('VWC and TriSCAN response boundaries select measurement and D-response slots with exact cuts', () => {
  for (const count of [3, 4, 6, 7, 9, 10]) {
    const vwc = compiled(buildLayout(count, 0, '0'));
    const expectedVwc = expectedFamilySlots('0', '0M!,1,1,2', count);
    assert.deepEqual(commandSlots(vwc), expectedVwc.commands);
    assert.deepEqual(vwc.slots.map((slot) => slot.cut), expectedVwc.chunks.map((values) => `${3 + 9 * values},2,2~${1 + 9 * values}`));

    const allTriScanMask = (1 << count) - 1;
    const vic = compiled(buildLayout(count, allTriScanMask, '0'));
    const vicCommands = commandSlots(vic).filter((command) => command.includes('M2!') || command.includes('M3!') || command.includes('D'));
    const expectedVic = expectedFamilySlots('0', '0M2!,1,1,2', count);
    assert.deepEqual(vicCommands.slice(-expectedVic.commands.length), expectedVic.commands);
    const vicSlots = vic.slots.slice(-expectedVic.commands.length);
    assert.deepEqual(vicSlots.map((slot) => slot.cut), expectedVic.chunks.map((values) => `${3 + 9 * values},2,2~${1 + 9 * values}`));
  }
});

test('the bench fixture produces the exact four-slot ordered recipe and Dragino frames', () => {
  const layout = {
    version: 1,
    address: '0',
    sensors: [
      { channel: 1, response_position: 1, depth_cm: 10, type: 'TRISCAN' },
      { channel: 2, response_position: 2, depth_cm: 20, type: 'ENVIROSCAN' },
      { channel: 3, response_position: 3, depth_cm: 30, type: 'ENVIROSCAN' },
      { channel: 4, response_position: 4, depth_cm: 40, type: 'ENVIROSCAN' },
      { channel: 5, response_position: 5, depth_cm: 50, type: 'TRISCAN' },
      { channel: 6, response_position: 6, depth_cm: 60, type: 'ENVIROSCAN' },
      { channel: 7, response_position: 7, depth_cm: 80, type: 'ENVIROSCAN' },
      { channel: 8, response_position: 8, depth_cm: 100, type: 'ENVIROSCAN' },
    ],
  };
  const compiledRecipe = compiled(layout);
  assert.deepEqual(compiledRecipe.slots, [
    { slot: 1, command: '0M!,1,1,2', cut: '30,2,2~28' },
    { slot: 2, command: '0D1!,0,0,2', cut: '30,2,2~28' },
    { slot: 3, command: '0D2!,0,0,2', cut: '21,2,2~19' },
    { slot: 4, command: '0M2!,1,1,2', cut: '21,2,2~19' },
  ]);
  assert.equal(compiledRecipe.slots.slice(0, 3).reduce((sum, slot) => sum + valuesInCut(slot.cut), 0), 8);
  assert.equal(compiledRecipe.slots.slice(3).reduce((sum, slot) => sum + valuesInCut(slot.cut), 0), 2);
  assert.deepEqual(compiledRecipe.frames.map(frameHex), [
    '07031F40', 'AB01', 'AE02', 'AD01', 'A90D09',
    'AF010109304D212C312C312C3200', 'AF01020933302C322C327E323800',
    'AF02010A304431212C302C302C3200', 'AF02020933302C322C327E323800',
    'AF03010A304432212C302C302C3200', 'AF03020932312C322C327E313900',
    'AF04010A304D32212C312C312C3200', 'AF04020932312C322C327E313900',
    '09050F', '010004B0',
  ]);
  assertAfLengthsMatchAscii(compiledRecipe);
});

test('global frames bracket active command/cut pairs and only clear the unused tail', () => {
  const compiledRecipe = compiled(buildLayout(8, 0b00010001, '0'));
  const frames = compiledRecipe.frames.map(frameHex);
  assert.deepEqual(frames.slice(0, 5), ['07031F40', 'AB01', 'AE02', 'AD01', 'A90D09']);
  assert.equal(frames.at(-1), '010004B0');
  const activeSlots = compiledRecipe.slots.map((slot) => slot.slot);
  for (const slot of activeSlots) {
    assert.equal(frames.some((hex) => hex.startsWith(`AF${slot.toString(16).padStart(2, '0').toUpperCase()}01`)), true);
    assert.equal(frames.some((hex) => hex.startsWith(`AF${slot.toString(16).padStart(2, '0').toUpperCase()}02`)), true);
  }
  const tail = frames.filter((hex) => hex.startsWith('09'));
  assert.deepEqual(tail, [`09${(activeSlots.length + 1).toString(16).padStart(2, '0').toUpperCase()}0F`]);
  assert.equal(frames.some((hex) => /^(?:08|0A|AC|B0)/.test(hex)), false);
});

test('an eight-slot recipe clears slot 9 before setting the normal interval', () => {
  const compiledRecipe = compiled(buildLayout(10, 0b1111111111, '0'));
  assert.equal(compiledRecipe.slots.length, 8);
  assert.deepEqual(compiledRecipe.frames.slice(-2).map(frameHex), ['09090F', '010004B0']);
});

test('stable channel IDs and depths change the layout hash but never the recipe frames', () => {
  const first = {
    version: 1,
    address: 'C',
    sensors: Array.from({ length: 8 }, (_, index) => ({
      channel: index + 1,
      response_position: index + 1,
      depth_cm: (index + 1) * 10,
      type: index === 0 || index === 4 ? 'TRISCAN' : 'ENVIROSCAN',
    })),
  };
  const second = {
    version: 1,
    address: 'C',
    sensors: Array.from({ length: 8 }, (_, index) => ({
      channel: 10 - index,
      response_position: index + 1,
      depth_cm: 101 + index,
      type: index === 0 || index === 4 ? 'TRISCAN' : 'ENVIROSCAN',
    })).reverse(),
  };
  const firstRecipe = compiled(first);
  const secondRecipe = compiled(second);
  assert.notEqual(firstRecipe.layoutHash, secondRecipe.layoutHash);
  assert.deepEqual(firstRecipe.slots, secondRecipe.slots);
  assert.deepEqual(firstRecipe.frames, secondRecipe.frames);
});

test('identify encoding accepts only discovery or one validated address plus I', () => {
  for (const [command, hex] of [
    ['?!', 'A8023F21010100'],
    ['0I!', 'A803304921010100'],
    ['CI!', 'A803434921010100'],
  ]) {
    const frame = recipe.encodeIdentifyFrame(command);
    assert.equal(Buffer.isBuffer(frame), true);
    assert.equal(frame.toString('hex').toUpperCase(), hex);
    assert.equal(frame[frame.length - 3], 1); // one second delay
    assert.equal(frame[frame.length - 2], 1); // echo/FPort 100 enabled
    assert.equal(frame[frame.length - 1], 0); // automatic D0 disabled
    assert.equal(Object.hasOwn(frame, 'fPort'), false);
  }
  for (const command of ['', 'I!', '00I!', '0M!', '?! ', 'éI!', 'A?!', 'AI!!']) {
    assert.throws(() => recipe.encodeIdentifyFrame(command), /identify command/);
  }
});
