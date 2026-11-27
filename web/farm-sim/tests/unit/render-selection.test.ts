import assert from 'node:assert/strict';
import test from 'node:test';
import {Sprite as PixiSprite, Texture, TextureSource} from 'pixi.js';
import type {Sprite} from '../../art/core';
import {palette, type PaletteKey} from '../../art/palette';
import {bakeAtlas, spriteFamilies} from '../../scripts/bake-atlas';
import {defaultHeader, TUTORIAL_SCENARIO} from '../../src/core/scenario';
import {World} from '../../src/core/world';
import {Actors} from '../../src/view/actors';
import {FarmAtlas} from '../../src/view/atlas';
import {fitViewport, followCamera, TILE_SIZE} from '../../src/view/camera';
import {gradePixel, lightingAt, shadowPixel, silhouetteFrame} from '../../src/view/lighting';
import {FrameQuality, frameSlot} from '../../src/view/quality';
import {chunkInputs, crackFrame, dripEmitters, hedgeMask, sameTerrain, terrainFrames} from '../../src/view/terrain';
import type {ViewModel} from '../../src/view/view-model';

type Tile = ViewModel['map']['tiles'][number];

function mapOf(width: number, height: number, overrides: Map<number, Partial<Tile>> = new Map()): ViewModel['map'] {
  const tiles = Array.from({length: width * height}, (_, i): Tile => ({
    at: {x: i % width, y: Math.floor(i / width)}, terrain: 'laterite', variant: i % 8, walkable: true,
    bed: null, feature: null, surfaceBand: null, wetness: null, ...overrides.get(i),
  }));
  return {width, height, tiles};
}

test('every blocked farm feature has a visible prop on its tile at every tier', () => {
  const {atlas: data} = bakeAtlas();
  const page = new Texture({source: new TextureSource({width: data.width, height: data.height})});
  const atlas = new FarmAtlas(data, page);
  const actors = new Actors(atlas);
  const propFrames = new Map([...spriteFamilies.structures, ...spriteFamilies.water, ...spriteFamilies.devices]
    .map(frame => [atlas.texture(frame.id), frame] as const));
  const missing: string[] = [];
  for (const tier of [0, 1, 2, 3, 4] as const) {
    const header = defaultHeader('test', TUTORIAL_SCENARIO, tier);
    const vm = new World(header, TUTORIAL_SCENARIO).viewModel(header.start);
    actors.sync(vm, lightingAt(vm.sky), 0);
    const props = new Map<string, string>();
    for (const sprite of actors.sprites.children) {
      if (!(sprite instanceof PixiSprite) || !sprite.visible) continue;
      const frame = propFrames.get(sprite.texture);
      if (!frame) continue;
      if (frame.id.startsWith('structure.farmhouse')) {
        // The house, bed and lamp share the farmhouse's four-by-four footprint.
        for (let y = 0; y < frame.size[1]; y += TILE_SIZE) {
          for (let x = 0; x < frame.size[0]; x += TILE_SIZE) {
            props.set(`${(sprite.x + x) / TILE_SIZE},${(sprite.y + y) / TILE_SIZE}`, frame.id);
          }
        }
      } else {
        const x = sprite.x + (sprite.scale.x < 0 ? -frame.anchor[0] - 1 : frame.anchor[0]);
        const y = sprite.y + frame.anchor[1];
        props.set(`${Math.floor(x / TILE_SIZE)},${Math.floor(y / TILE_SIZE)}`, frame.id);
      }
    }
    for (const {at, feature, walkable} of vm.map.tiles) {
      if (!feature || walkable) continue;
      if (!props.has(`${at.x},${at.y}`)) {
        missing.push(`T${tier} ${feature} at (${at.x}, ${at.y})`);
      }
    }
    for (const [feature, position] of [['rain-gauge', '9,6'], ['flow-meter', '11,10']]) {
      assert.equal(props.get(position), tier >= 2 ? 'device.' + feature : undefined, `T${tier} ${feature}`);
    }
  }
  actors.sprites.destroy({children: true});
  actors.shadows.destroy({children: true});
  actors.pipes.destroy({children: true});
  actors.destroy();
  atlas.destroy();
  page.destroy(true);
  assert.deepEqual(missing, []);
});

test('camera follows the foot, keeps only a fractional remainder, and clamps at map edges', () => {
  const map = mapOf(48, 32);
  assert.deepEqual(followCamera(map, {x: 0, y: 0}), {x: 0, y: 0, subX: 0, subY: 0});
  assert.deepEqual(followCamera(map, {x: 24.125, y: 16.03125}), {x: 154, y: 129, subX: 0, subY: .5});
  assert.deepEqual(followCamera(map, {x: 47.9, y: 31.9}), {x: 288, y: 242, subX: 0, subY: 0});
  assert.deepEqual(followCamera(mapOf(4, 4), {x: 3, y: 3}), {x: 0, y: 0, subX: 0, subY: 0});
});

test('live hose sprites join on both pixels of each horizontal and vertical seam', t => {
  const {atlas: data} = bakeAtlas();
  const page = new Texture({source: new TextureSource({width: data.width, height: data.height})});
  const atlas = new FarmAtlas(data, page);
  const actors = new Actors(atlas);
  t.after(() => {
    actors.sprites.destroy({children: true});
    actors.shadows.destroy({children: true});
    actors.pipes.destroy({children: true});
    actors.destroy();
    atlas.destroy();
    page.destroy(true);
  });
  const frames = new Map(spriteFamilies.water.map(frame => [atlas.texture(frame.id), frame]));
  const header = defaultHeader('test');
  const initial = new World(header, TUTORIAL_SCENARIO).viewModel(header.start);
  for (const wet of [false, true]) {
    const vm = {...initial, dripLine: initial.dripLine.map(segment => ({...segment, wet}))};
    actors.sync(vm, lightingAt(vm.sky), 0);
    const pipes = actors.pipes.children.filter(sprite => sprite instanceof PixiSprite);
    assert.equal(pipes.length, vm.dripLine.length);
    const byTile = new Map(vm.dripLine.map(({at}, i) => [`${at.x},${at.y}`, pipes[i]]));
    const ink = (sprite: PixiSprite, x: number, y: number) => {
      const local = sprite.toLocal({x: x + .5, y: y + .5});
      return frames.get(sprite.texture)?.rows[Math.floor(local.y)]?.[Math.floor(local.x)];
    };
    for (const {at: {x, y}, connections} of vm.dripLine) {
      const pipe = byTile.get(`${x},${y}`)!;
      for (const [arm, dx, dy] of [[2, 1, 0], [4, 0, 1]]) {
        const next = byTile.get(`${x + dx},${y + dy}`);
        if (!next || !(connections & arm)) continue;
        const seamX = (x + dx) * TILE_SIZE + dy * 8;
        const seamY = (y + dy) * TILE_SIZE + dx * 8;
        for (const [offset, key] of [[0, 'R'], [1, 'k']] as const) {
          const px = seamX + dy * offset;
          const py = seamY + dx * offset;
          assert.equal(ink(pipe, px - dx, py - dy), key, `pipe at (${x}, ${y}) near side`);
          assert.equal(ink(next, px, py), key, `pipe at (${x + dx}, ${y + dy}) far side`);
        }
      }
    }
  }
});

test('viewport fits whole device pixels, including odd and undersized windows', () => {
  assert.deepEqual(fitViewport(1921, 1081), {scale: 4, width: 1920, height: 1080, left: 0, top: 0});
  assert.deepEqual(fitViewport(1197, 801), {scale: 2, width: 960, height: 540, left: 118, top: 130});
  assert.deepEqual(fitViewport(320, 200), {scale: 1, width: 480, height: 270, left: -80, top: -35});
});

test('dual-grid tiles select the four corners and preserve individual soil bands', () => {
  const map = mapOf(2, 2, new Map([
    [0, {terrain: 'tilled', surfaceBand: 'saturated', wetness: 1}],
    [1, {terrain: 'tilled', surfaceBand: 'wet'}],
    [2, {terrain: 'tilled', surfaceBand: 'very-dry'}],
    [3, {terrain: 'tilled', surfaceBand: 'moist'}],
  ]));
  assert.deepEqual(terrainFrames(map, 0, 0), [
    'terrain.tilled.saturated.15', 'terrain.tilled.wet.15', 'terrain.tilled.moist.15', 'terrain.tilled.very-dry.15',
  ]);
  assert.deepEqual(terrainFrames(map, -1, -1), Array(4).fill('terrain.tilled.saturated.4'));
  assert.equal(crackFrame(map.tiles[1]), null);
  assert.equal(crackFrame(map.tiles[2]), 'terrain.crack.2');
  assert.equal(sameTerrain(map.tiles[0], {...map.tiles[0], wetness: .98}), true);
  assert.equal(sameTerrain(map.tiles[0], {...map.tiles[0], surfaceBand: 'wet'}), false);
});

test('edge masks join grass and paths, and chunk dependencies include adjacent tiles', () => {
  const map = mapOf(34, 2, new Map([
    [0, {terrain: 'grass', feature: 'hedge'}], [1, {terrain: 'grass', feature: 'hedge'}],
    [34, {terrain: 'path', feature: 'hedge'}],
  ]));
  assert.deepEqual(terrainFrames(map, 0, 0), ['terrain.path.8']);
  assert.deepEqual(terrainFrames(map, 0, -1), ['terrain.grass.12']);
  assert.deepEqual(terrainFrames(map, 2, 0), ['terrain.laterite.2']);
  assert.equal(hedgeMask(map, 0, 0), 4 | 16);
  assert.ok(chunkInputs(map, 0, 0).includes(map.tiles[32]));
  assert.ok(chunkInputs(map, 32, 0).includes(map.tiles[31]));
  assert.ok(!chunkInputs(map, 32, 0).includes(map.tiles[30]));
  assert.deepEqual(dripEmitters({at: {x: 1, y: 0}, connections: 1 | 2, wet: true}),
    [{x: 24, y: 6}, {x: 24, y: 2}, {x: 26, y: 8}, {x: 30, y: 8}]);
});

function sky(hour: number, options: Partial<ViewModel['sky']> = {}): ViewModel['sky'] {
  return {hour, sunriseHour: 6, sunsetHour: 18, date: '2027-01-11', day: 1, season: 'Hot Dry',
    raining: false, rainMmPerHour: 0, ...options};
}

test('lighting is continuous at the four anchors and across midnight', () => {
  for (const h of [6.5, 12, 17.5, 18.75]) {
    const before = lightingAt(sky(h - .001)).ambient;
    const after = lightingAt(sky(h + .001)).ambient;
    before.forEach((channel, i) => assert.ok(Math.abs(channel - after[i]) < .001));
  }
  assert.deepEqual(lightingAt(sky(0)).ambient, lightingAt(sky(23.999)).ambient);
  assert.ok(lightingAt(sky(6.5)).ambient[1] > lightingAt(sky(17.5)).ambient[1]);
  assert.ok(lightingAt(sky(12)).ambient[1] > lightingAt(sky(6.5)).ambient[1]);
  assert.equal(lightingAt(sky(21)).windowGlow, 1);
  assert.equal(lightingAt(sky(12)).windowGlow, 0);
  assert.equal(lightingAt(sky(12)).shadow.lengthPerHeight, 0);
  assert.ok(lightingAt(sky(7)).shadow.east < 0);
  assert.ok(lightingAt(sky(17)).shadow.east > 0);
});

test('rain dims daylight and weakens shadows without turning off the night window', () => {
  const rain = {raining: true, rainMmPerHour: 10} as const;
  const dry = lightingAt(sky(12));
  const wet = lightingAt(sky(12, rain));
  assert.ok(wet.ambient.every((channel, i) => channel < dry.ambient[i]));
  assert.ok(wet.shadow.opacity < dry.shadow.opacity);
  assert.equal(lightingAt(sky(21, rain)).windowGlow, 1);
  assert.notDeepEqual(lightingAt(sky(12, {season: 'Long Rains'})).ambient, dry.ambient);
});

type Rgb = readonly [number, number, number];
const frames = new Map<string, Sprite>(Object.values(spriteFamilies).flat().map(frame => [frame.id, frame]));
const rgbOf = (key: string): Rgb => {
  const hex = palette[key as PaletteKey];
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
};
const luma = ([r, g, b]: Rgb) => (.299 * r + .587 * g + .114 * b) / 255;
const hue = ([r, g, b]: Rgb) => {
  const max = Math.max(r, g, b);
  const spread = max - Math.min(r, g, b);
  const sector = max === r ? (g - b) / spread : max === g ? 2 + (b - r) / spread : 4 + (r - g) / spread;
  return (sector * 60 + 360) % 360;
};
const keysOf = (id: string) => {
  const frame = frames.get(id);
  assert.ok(frame, 'missing sprite ' + id);
  return frame.rows.flatMap(row => [...row].filter(key => key !== '.'));
};
const mean = (colors: readonly Rgb[]): Rgb => {
  const channel = (i: number) => colors.reduce((sum, color) => sum + color[i], 0) / colors.length;
  return [channel(0), channel(1), channel(2)];
};

// Consultation 7 (U1): at dusk the colour goes into the shade and the long shadows, since warm
// light hardly shows on orange ground; the light drops about a fifth, water stays blue, and
// dawn stays the cooler and paler of the two.
test('dusk dims by about a fifth and casts violet shadows, keeps water blue, and dawn stays cooler and paler', () => {
  const noon = lightingAt(sky(12));
  const dawn = lightingAt(sky(6.5));
  const dusk = lightingAt(sky(17.5));
  const lumaOf = (rgb: Rgb) => luma([rgb[0] * 255, rgb[1] * 255, rgb[2] * 255]);
  const dimming = lumaOf(dusk.ambient) / lumaOf(noon.ambient);
  assert.ok(dimming > .72 && dimming < .82, 'dusk light is ' + dimming.toFixed(3) + ' of noon');
  assert.ok(lumaOf(lightingAt(sky(18.5)).ambient) < .8 * lumaOf(noon.ambient));
  assert.ok(dawn.ambient[2] / dawn.ambient[0] > dusk.ambient[2] / dusk.ambient[0]);
  assert.ok(lumaOf(dawn.ambient) > lumaOf(dusk.ambient));
  assert.ok(dawn.shadow.opacity < dusk.shadow.opacity);

  // A long shadow on laterite: the tinted cream mask multiplied into the ground, then graded.
  const ground = rgbOf('B');
  const mask = rgbOf('c');
  const duskShadow = gradePixel(shadowPixel(ground, mask, dusk.shadow), dusk);
  const dawnShadow = gradePixel(shadowPixel(ground, mask, dawn.shadow), dawn);
  assert.ok(hue(duskShadow) > 260 && hue(duskShadow) < 310, 'dusk shadow ' + duskShadow.join(','));
  assert.ok(duskShadow[2] > duskShadow[1] && duskShadow[0] > duskShadow[1], 'dusk shadow ' + duskShadow.join(','));
  assert.ok(luma(dawnShadow) > luma(duskShadow) + .08, 'dawn shadow ' + dawnShadow.join(','));

  // The tank's water and its highlights keep blue as their strongest channel, well clear of black.
  for (const key of ['W', 'v', 'u']) {
    const water = gradePixel(rgbOf(key), dusk);
    assert.ok(water[2] >= Math.max(water[0], water[1]), key + ' at dusk ' + water.join(','));
    assert.ok(luma(water) > .24, key + ' at dusk ' + water.join(','));
  }
});

// Consultation 7 (U2): the acacia crown went slate at dawn and dusk. It was painted in P, a
// near-grey green that the split tone gives mostly the cool shade colour, which then
// replaces its hue. Healthy foliage, over the pixels that are green at noon, must stay green.
test('healthy foliage keeps its green at dawn and dusk, the acacia crown included', () => {
  const noon = lightingAt(sky(12));
  const ids = ['nature.acacia', 'nature.tuft.2', 'nature.tuft.3', 'structure.nursery-tray',
    ...[...frames.keys()].filter(id => /^crop\.tomato\.[a-z-]+\.turgid\.\d$/.test(id))];
  for (const id of ids) {
    const green = keysOf(id).map(rgbOf).filter(color => {
      const [r, g, b] = gradePixel(color, noon);
      return g > r && g > b;
    });
    assert.ok(green.length > 0, id);
    for (const hour of [6.5, 17.5]) {
      const light = lightingAt(sky(hour));
      const [r, g, b] = mean(green.map(color => gradePixel(color, light)));
      assert.ok(g > 1.05 * Math.max(r, b), `${id} at ${hour}: ${[r, g, b].map(Math.round).join(',')}`);
    }
  }
});

// Consultation 7 (U4): the probe, the T1 device, was small and grey inside the foliage.
test('the soil probe is a cream housing with a teal accent that stays light against a grown bed', () => {
  const keys = keysOf('device.soil-probe.idle');
  assert.ok(keys.filter(key => key === 'c').length >= 20);
  assert.ok(keys.includes('g'));
  assert.ok(!keys.includes('T'));
  const leaves = keysOf('crop.tomato.ripe-fruit.turgid.0').filter(key => 'LMNn'.includes(key)).map(rgbOf);
  for (const hour of [6.5, 12, 17.5]) {
    const light = lightingAt(sky(hour));
    const housing = luma(gradePixel(rgbOf('c'), light));
    const foliage = luma(mean(leaves.map(color => gradePixel(color, light))));
    assert.ok(housing - foliage > .35, `housing ${housing.toFixed(2)}, foliage ${foliage.toFixed(2)} at ${hour}`);
  }
});

test('every frame that casts a long shadow has a one-colour mask of the same shape', () => {
  const casters = ['structure.farmhouse', 'structure.farmhouse.lit', 'nature.acacia', 'water.well.hand-dug',
    'device.gateway.idle', ...[0, 1, 2, 3].flatMap(i => [`water.tank.${i}`, `water.well.shared.${i}`]),
    ...[...frames.keys()].filter(id => id.startsWith('player.'))];
  assert.equal(casters.length, 13 + 96);
  for (const id of casters) {
    const frame = frames.get(id)!;
    const mask = frames.get(silhouetteFrame(id));
    assert.ok(frame && mask, 'missing shadow mask for ' + id);
    assert.deepEqual([mask.size, mask.anchor], [frame.size, frame.anchor]);
    assert.deepEqual(mask.rows, frame.rows.map(row => row.replace(/[^.]/g, 'c')));
  }
});

test('quality selects the two tiers from memory and the visible frame probe', () => {
  const fast = new FrameQuality();
  const slow = new FrameQuality();
  for (let ms = 0; ms <= 2_100; ms += 20) {
    fast.observe(ms, 2);
    slow.observe(ms, 9);
  }
  assert.equal(fast.current, 'standard');
  assert.equal(slow.current, 'low');
  assert.equal(new FrameQuality(2).current, 'low');
  assert.equal(frameSlot(100, 'low'), 3);
  assert.equal(frameSlot(100, 'standard'), 6);
});

test('the quality probe keeps slow frames when their work accounts for the gap', () => {
  const quality = new FrameQuality();
  for (let ms = 0; ms < 2_000; ms += 300) quality.observe(ms, 280);
  assert.equal(quality.current, 'standard');
  quality.observe(2_100, 280);
  assert.equal(quality.current, 'low');
});

test('the quality probe still restarts after a gap spent outside frame work', () => {
  const quality = new FrameQuality();
  for (let ms = 0; ms <= 1_900; ms += 100) quality.observe(ms, 9);
  for (let ms = 2_200; ms <= 4_200; ms += 20) quality.observe(ms, 2);
  assert.equal(quality.current, 'standard');
});
