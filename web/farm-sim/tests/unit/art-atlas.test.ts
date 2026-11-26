import assert from 'node:assert/strict';
import test from 'node:test';
import {brotliCompressSync} from 'node:zlib';
import {derive, sprite, type Remap, type SpriteSource, validateSprite} from '../../art/core';
import {fontSprites} from '../../art/font';
import {hedgeTileForMask, terrainSprites} from '../../art/generators/terrain';
import {isPaletteKey, palette, ramps} from '../../art/palette';
import {bakeAtlas, spriteFamilies} from '../../scripts/bake-atlas';
import {decodeBakedBitmap, sampleScene} from '../../scripts/render-art-review';

test('the art review scene connects both sides of the first drip tee and its vertical main', () => {
  const {atlas, png} = bakeAtlas();
  const {width, rgba} = sampleScene(atlas, decodeBakedBitmap(png, atlas.image));
  const pixel = (x: number, y: number) => {
    const offset = (y * width + x) * 4;
    return '#' + rgba.subarray(offset, offset + 3).toString('hex');
  };
  for (const seam of [9 * 16, 10 * 16]) {
    for (const x of [seam - 1, seam]) {
      assert.equal(pixel(x, 7 * 16 + 8), palette.R, `hose top at x=${x}`);
      assert.equal(pixel(x, 7 * 16 + 9), palette.k, `hose underside at x=${x}`);
    }
  }
  for (const seam of [8, 9, 10, 11].map(y => y * 16)) {
    for (const y of [seam - 1, seam]) {
      assert.equal(pixel(9 * 16 + 8, y), palette.R, `hose top at y=${y}`);
      assert.equal(pixel(9 * 16 + 9, y), palette.k, `hose underside at y=${y}`);
    }
  }
});

test('sprite grammar validates every frame and rejects invalid dimensions, anchors, keys and budgets', () => {
  const colors = Object.values(palette);
  assert.equal(colors.length, 46);
  assert.equal(new Set(colors).size, 46);
  assert.ok(colors.every(value => /^#[0-9a-f]{6}$/.test(value)));
  for (const ramp of Object.values(ramps)) assert.ok([...ramp].every(isPaletteKey));
  for (const frame of [...Object.values(spriteFamilies).flat(), ...fontSprites()]) validateSprite(frame);

  const source: SpriteSource = {id: 'test.frame', size: [3, 2], rows: ['AB.', '.C.'], anchor: [1, 1]};
  assert.throws(() => sprite({...source, rows: ['AB.']}), /expected 2 rows/);
  assert.throws(() => sprite({...source, rows: ['AB.', '.C']}), /row 1 must have 3 pixels/);
  assert.throws(() => sprite({...source, rows: ['A?.', '.C.']}), /unknown palette key/);
  assert.throws(() => sprite({...source, rows: ['AB ', '.C.']}), /unknown palette key/);
  assert.throws(() => sprite({...source, anchor: [3, 0]}), /anchor outside/);
  assert.throws(() => sprite({...source, emissive: [[2, 0]]}), /needs a visible pixel/);
  assert.throws(() => sprite({...source, slice: [1, 1, 1, 1]}), /invalid nine-slice margins/);
  assert.throws(() => sprite({...source, kind: 'icon'}), /icon must be 16 x 16/);
  assert.throws(() => sprite({...source, rows: ['kKABCDEGHILMN'], size: [13, 1], anchor: [0, 0]}),
    /maximum is 12/);
  assert.throws(() => sprite({...source, kind: 'icon', size: [16, 16],
    rows: ['ABCDGHIkL.......', ...Array<string>(15).fill('.'.repeat(16))]}), /maximum is 8/);
  const left = derive(sprite(source), {id: 'test.left', mirror: true, remap: {B: 'D'}});
  assert.deepEqual(left.rows, ['.DA', '.C.']);
  assert.deepEqual(left.anchor, [1, 1]);
  assert.throws(() => derive(sprite(source), {id: 'test.bad', remap: {A: '?'} as unknown as Remap}), /invalid palette remap/);
  assert.throws(() => derive(sprite(source), {id: 'test.bad', overlay: [{at: [2, 0], rows: ['AB']}]}), /overlay outside sprite/);
});

test('atlas and font bytes reproduce locally and the atlas layout and pixels match the portable pin', () => {
  const first = bakeAtlas();
  const second = bakeAtlas();
  assert.deepEqual(first.png, second.png);
  assert.deepEqual(first.fontPng, second.fontPng);
  assert.equal(JSON.stringify(first.atlas), JSON.stringify(second.atlas));
  assert.equal(JSON.stringify(first.font), JSON.stringify(second.font));
  assert.equal(first.atlas.hash, 'po4fWnnTLNywMCgtMW3I_5NBKoGg3vu8hevBfxR_jgQ');
  assert.equal(first.atlas.image, `atlas-${first.atlas.hash}.png`);
  assert.deepEqual([first.png.readUInt32BE(16), first.png.readUInt32BE(20)], [2048, 2048]);
  assert.deepEqual([first.png[24], first.png[25]], [8, 6]);
  assert.ok(brotliCompressSync(first.png).length <= 130_000, 'atlas exceeds the M1 download budget');
});

function ids(prefix: string, count: number): string[] {
  return Array.from({length: count}, (_, index) => `${prefix}.${index}`);
}

test('each M1 asset is addressable in the atlas and both font sizes cover printable ASCII and Latin-1', () => {
  const {atlas, font} = bakeAtlas();
  const bands = ['saturated', 'wet', 'moist', 'dry', 'very-dry'];
  const stages = ['transplant', 'vegetative', 'flowering', 'green-fruit', 'ripe-fruit'];
  const stress = ['turgid', 'rolling', 'grey-green', 'wilted', 'dead'];
  const actions = {idle: 2, walk: 4, hoe: 4, pour: 3, carry: 4, pump: 4, harvest: 3};
  const expected = [
    ...ids('terrain.laterite', 8),
    ...bands.flatMap(band => ids(`terrain.tilled.${band}`, 16)),
    ...ids('terrain.grass', 16), ...ids('terrain.path', 16), ...ids('terrain.crack', 4),
    ...['straight', 'corner', 'tee', 'end'].flatMap(shape => [
      `water.drip.${shape}.dry`, `water.drip.${shape}.wet`,
    ]),
    ...ids('water.tank', 4), 'water.hand-pump', 'water.well.hand-dug', ...ids('water.well.shared', 4),
    'structure.farmhouse', 'structure.farmhouse.lit', 'nature.acacia',
    ...ids('nature.rock', 2), ...ids('nature.tuft', 4), 'structure.nursery-tray',
    ...stages.flatMap(stage => stress.flatMap(state => ids(`crop.tomato.${stage}.${state}`, 3))),
    'crop.tomato.ripe-overlay', 'device.soil-probe.idle', 'device.soil-probe.led',
    'device.valve-box.closed', 'device.valve-box.opening', 'device.valve-box.open',
    'device.gateway.idle', 'device.gateway.led', 'device.rain-gauge', 'device.flow-meter',
    ...['down', 'up', 'right', 'left'].flatMap(dir =>
      Object.entries(actions).flatMap(([action, count]) => ids(`player.${dir}.${action}`, count))),
    ...['hoe', 'can', 'jerrycan', 'basket', 'seedling', 'tomato', 'phone', 'energy', 'water', 'probe', 'valve', 'report'].map(id => `icon.${id}`),
    'ui.signboard', 'ui.phone-bezel',
  ];

  const blobMasks = new Set<number>();
  for (let raw = 0; raw < 256; raw++) {
    let effective = raw;
    for (let direction = 0; direction < 8; direction += 2) {
      const next = (direction + 2) % 8;
      if (!(raw & (1 << direction)) || !(raw & (1 << next))) effective &= ~(1 << (direction + 1));
    }
    assert.equal(hedgeTileForMask[raw], effective);
    blobMasks.add(effective);
  }
  assert.equal(blobMasks.size, 47);
  expected.push(...[...blobMasks].map(mask => `nature.hedge.${mask}`));
  for (const id of expected) assert.ok(atlas.frames[id], `missing frame: ${id}`);

  const tiles = new Map(terrainSprites.map(frame => [frame.id, frame]));
  for (const band of bands) {
    const frame = tiles.get(`terrain.tilled.${band}.15`);
    assert.ok(frame);
    assert.equal(frame.size[0], 16);
    assert.equal(frame.size[1], 16);
  }
  assert.equal(new Set(bands.map(band => tiles.get(`terrain.tilled.${band}.15`)?.rows.join(''))).size, 5);
  assert.deepEqual(atlas.frames['ui.signboard'].slice, [3, 3, 3, 3]);
  assert.deepEqual(atlas.frames['device.soil-probe.led'].emissive, [[7, 5]]);
  for (const direction of ['down', 'up', 'right', 'left']) {
    for (const [action, count] of Object.entries(actions)) {
      assert.deepEqual(atlas.clips.player[direction][action], ids(`player.${direction}.${action}`, count));
      for (const id of atlas.clips.player[direction][action]) {
        const {width, height} = atlas.frames[id];
        assert.deepEqual([width, height], [24, 32]);
      }
    }
  }

  const fontIds = [...Array.from({length: 95}, (_, i) => i + 32), ...Array.from({length: 96}, (_, i) => i + 160)];
  const glyphs = new Map(fontSprites().map(frame => [frame.id, frame]));
  for (const [face, width, height] of [['body', 5, 7], ['heading', 6, 9]] as const) {
    for (const code of fontIds) {
      const id = `font.${face}.${code}`;
      assert.ok(font.frames[id], `missing U+${code.toString(16)} in ${face}`);
      assert.deepEqual([font.frames[id].width, font.frames[id].height], [width, height]);
      assert.equal(glyphs.get(id)?.rows.some(row => row.includes('K')), code !== 32 && code !== 160);
    }
    assert.notDeepEqual(glyphs.get(`font.${face}.244`)?.rows, glyphs.get(`font.${face}.246`)?.rows);
  }
});
