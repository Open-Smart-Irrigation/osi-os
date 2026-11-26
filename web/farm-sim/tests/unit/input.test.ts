import assert from 'node:assert/strict';
import test from 'node:test';
import {farmMap, FARM_HEIGHT, FARM_SITES, FARM_WIDTH} from '../../src/core/map';
import {defaultHeader, TUTORIAL_SCENARIO} from '../../src/core/scenario';
import {World} from '../../src/core/world';
import {keyboardDirection, routeStep, stickDirection, toolForKey} from '../../src/input/mapping';
import {pointerTile} from '../../src/input/pointer';
import {currentViewport, followCamera, LANDSCAPE_VIEW, setCurrentViewport, TILE_SIZE} from '../../src/view/camera';

test('keys combine into diagonals, opposing axes cancel and number keys select tools', () => {
  assert.deepEqual(keyboardDirection(new Set(['ArrowUp', 'KeyD'])), {dx: 1, dy: -1});
  assert.deepEqual(keyboardDirection(new Set(['ArrowUp', 'KeyW', 'KeyS'])), {dx: 0, dy: 0});
  assert.equal(toolForKey('Digit5', ['hoe', 'seedling', 'can', 'jerrycan', 'basket']), 'basket');
  assert.equal(toolForKey('Digit6', ['hoe']), undefined);
});

test('touch stick has a dead zone and eight directions', () => {
  assert.deepEqual(stickDirection(6, 6), {dx: 0, dy: 0});
  assert.deepEqual(stickDirection(-18, 20), {dx: -1, dy: 1});
  assert.deepEqual(stickDirection(25, 5), {dx: 1, dy: 0});
  assert.deepEqual(stickDirection(0, -20), {dx: 0, dy: -1});
});

test('pointer mapping includes the camera position and canvas scaling', () => {
  const header = defaultHeader('test');
  const vm = new World(header, TUTORIAL_SCENARIO).viewModel(header.start);
  const bounds = {left: 40, top: 80, width: 960, height: 540};
  // The middle of the player's tile on screen, after the camera offset, at 2x canvas scaling.
  const camera = followCamera(vm.map, vm.player.at);
  const screenX = (vm.player.at.x + .5) * TILE_SIZE - camera.x - camera.subX;
  const screenY = (vm.player.at.y + .5) * TILE_SIZE - camera.y - camera.subY;
  assert.deepEqual(pointerTile(vm, bounds, 40 + screenX * 2, 80 + screenY * 2), vm.player.at);
  assert.deepEqual(pointerTile(vm, bounds, 40 + (screenX + TILE_SIZE) * 2, 80 + screenY * 2),
    {x: vm.player.at.x + 1, y: vm.player.at.y});
  assert.equal(pointerTile(vm, bounds, 39, 80), null);
});

test('pointer mapping uses the portrait view size, passed in or fitted last by the renderer', () => {
  const header = defaultHeader('test');
  const start = new World(header, TUTORIAL_SCENARIO).viewModel(header.start);
  // East of the start, where the portrait and landscape cameras differ.
  const vm = {...start, player: {...start.player, at: {x: 20, y: 9}}};
  // 412 x 760 at DPR 2: a 274 x 281 view at zoom 3 is 1.5 CSS px per logical pixel, 0.5 px in.
  const view = {width: 274, height: 281};
  const viewport = {view, scale: 3};
  const bounds = {left: .5, top: 100, width: 411, height: 421.5};
  assert.deepEqual(followCamera(vm.map, vm.player.at, view), {x: 191, y: 7, subX: 0, subY: 0});
  // The middle of tile (24, 12) is logical (201, 193) in this view.
  const [x, y] = [.5 + 201 * 1.5, 100 + 193 * 1.5];
  assert.deepEqual(pointerTile(vm, bounds, x, y, viewport), {x: 24, y: 12});
  assert.deepEqual(pointerTile(vm, bounds, .5 + 1, 100 + 1, viewport), {x: 11, y: 0});
  assert.equal(pointerTile(vm, bounds, 412, y, viewport), null);
  assert.equal(pointerTile(vm, bounds, x, 522, viewport), null);
  // The 480 x 270 view would map the same point three tiles further east.
  assert.deepEqual(pointerTile(vm, bounds, x, y, {view: LANDSCAPE_VIEW, scale: 1}), {x: 27, y: 12});
  // The input controller passes no size: the one the renderer fitted last applies.
  assert.deepEqual(currentViewport(), {view: LANDSCAPE_VIEW, scale: 1});
  setCurrentViewport(view, 3);
  try {
    assert.deepEqual(pointerTile(vm, bounds, x, y), {x: 24, y: 12});
  } finally {
    setCurrentViewport(LANDSCAPE_VIEW, 1);
  }
});

test('pointer mapping follows the device-pixel seam in an odd portrait view', () => {
  const header = defaultHeader('test');
  const start = new World(header, TUTORIAL_SCENARIO).viewModel(header.start);
  const vm = {...start, player: {...start.player, at: {x: 20, y: 8}}};
  const view = {width: 274, height: 175};
  const bounds = {left: 0, top: 0, width: 411, height: 262.5};
  setCurrentViewport(view, 3);
  try {
    assert.deepEqual(pointerTile(vm, bounds, 150, 79.5 * 1.5), {x: 18, y: 7});
    assert.deepEqual(pointerTile(vm, bounds, 150, 79.8 * 1.5), {x: 18, y: 8});
  } finally {
    setCurrentViewport(LANDSCAPE_VIEW, 1);
  }
});

test('tap route avoids walls and houses and stops within reach of the pump', () => {
  const map = {width: FARM_WIDTH, height: FARM_HEIGHT, tiles: farmMap(0)};
  const {houseDoor: door, tank, pump} = FARM_SITES;
  // Into the house: the diagonal past the wall corner is refused, so the route steps under the door first.
  assert.deepEqual(routeStep(map, {x: door.x - 1, y: door.y + 1}, {x: door.x, y: door.y - 1}, false), {dx: 1, dy: 0});
  // East of the tank, the pump sits beyond its south-west corner: the route goes round the tank, not through it.
  assert.deepEqual(routeStep(map, {x: tank.x + 1, y: tank.y}, pump, true), {dx: 0, dy: 1});
  assert.equal(routeStep(map, {x: pump.x, y: pump.y - 1}, pump, true), null);
});
