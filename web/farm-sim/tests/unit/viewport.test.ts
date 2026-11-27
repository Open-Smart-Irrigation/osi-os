import assert from 'node:assert/strict';
import test from 'node:test';
import {FARM_HEIGHT, FARM_SITES, FARM_WIDTH, farmMap} from '../../src/core/map';
import {fitViewport, followCamera, portraitViewport, TILE_SIZE} from '../../src/view/camera';

const MAP_HEIGHT = FARM_HEIGHT * TILE_SIZE;

// The portrait layout gives the farm scene the band between the tool row and the status bar
// (src/ui/farm-ui.css); the renderer measures it in device pixels (src/view/renderer.ts). The
// band heights below were measured in the built game, with the first day's hint showing.
test('a 412 x 760 portrait phone at DPR 2 shows 17 tiles across at zoom 3', () => {
  assert.deepEqual(portraitViewport(824, 844, MAP_HEIGHT),
    {scale: 3, width: 822, height: 843, left: 1, top: 0, view: {width: 274, height: 281}});
});

test('a 360 x 740 portrait phone at DPR 3 shows 16.9 tiles across at zoom 4', () => {
  assert.deepEqual(portraitViewport(1080, 1176, MAP_HEIGHT),
    {scale: 4, width: 1080, height: 1152, left: 0, top: 0, view: {width: 270, height: 288}});
});

test('a short 412 x 600 portrait phone keeps zoom 3 and gives up rows, not width', () => {
  assert.deepEqual(portraitViewport(824, 524, MAP_HEIGHT),
    {scale: 3, width: 822, height: 522, left: 1, top: 0, view: {width: 274, height: 174}});
});

test('a portrait view is no taller than the map and at least one tile each way', () => {
  assert.deepEqual(portraitViewport(824, 1200, MAP_HEIGHT).view, {width: 274, height: MAP_HEIGHT});
  assert.deepEqual(portraitViewport(824, 1200).view, {width: 274, height: 400});
  assert.deepEqual(portraitViewport(824, 0, MAP_HEIGHT).view, {width: 274, height: TILE_SIZE});
  assert.deepEqual(portraitViewport(0, 0, MAP_HEIGHT), {scale: 1, width: TILE_SIZE, height: TILE_SIZE, left: 0, top: 0,
    view: {width: TILE_SIZE, height: TILE_SIZE}});
});

test('landscape and desktop windows keep whole-number zoom however much width it leaves', () => {
  // 16:9 landscape: 960 x 540 at DPR 2, and a 760 x 412 phone on its side at DPR 2.
  assert.deepEqual(fitViewport(1920, 1080), {scale: 4, width: 1920, height: 1080, left: 0, top: 0});
  assert.deepEqual(fitViewport(1520, 824), {scale: 3, width: 1440, height: 810, left: 40, top: 7});
  // Desktop: 1280 x 900 (the game-phone e2e size) at 75 % of the width, 1366 x 768 at 70 %.
  assert.deepEqual(fitViewport(1280, 900), {scale: 2, width: 960, height: 540, left: 160, top: 180});
  assert.deepEqual(fitViewport(1366, 768), {scale: 2, width: 960, height: 540, left: 203, top: 114});
});

test('a portrait view takes the largest exact zoom that shows 15 tiles across and stays inside its band', () => {
  for (let width = 240; width <= 2560; width++) {
    for (const height of [0, 200, Math.floor(width * 1.1), 3000]) {
      const fit = portraitViewport(width, height, MAP_HEIGHT);
      const at = width + ' x ' + height + ': ' + JSON.stringify(fit);
      assert.ok(Number.isInteger(fit.scale) && fit.scale >= 1, at);
      assert.equal(fit.width, fit.view.width * fit.scale, at);
      assert.equal(fit.height, fit.view.height * fit.scale, at);
      assert.ok(fit.view.width >= 15 * TILE_SIZE, at);
      // A larger zoom would leave fewer than 15 tiles.
      assert.ok(width / (fit.scale + 1) < 15 * TILE_SIZE, at);
      assert.ok(fit.left >= 0 && fit.left + fit.width <= width && width - fit.width < 2 * fit.scale, at);
      assert.ok(fit.view.height <= MAP_HEIGHT && (fit.view.height === TILE_SIZE || fit.height <= height), at);
      assert.ok(fit.view.height === MAP_HEIGHT || fit.view.height === TILE_SIZE || height - fit.height < fit.scale, at);
    }
  }
});

test('the camera follows the player inside the map for the portrait view', () => {
  const map = {width: FARM_WIDTH, height: FARM_HEIGHT, tiles: farmMap(0)};
  const view = {width: 274, height: 174};
  // At the start the view sits against the west hedge; further east it centres the player.
  assert.deepEqual(followCamera(map, {x: 7, y: 8}, view), {x: 0, y: 49, subX: 0, subY: 0});
  assert.deepEqual(followCamera(map, {x: 20, y: 9}, view), {x: 191, y: 65, subX: 0, subY: 0});
  // In the south-east corner it stops at the map's edges.
  assert.deepEqual(followCamera(map, {x: FARM_WIDTH - 1, y: FARM_HEIGHT - 1}, view), {x: 398, y: 114, subX: 0, subY: 0});
  // A view as tall as the map never scrolls north or south.
  assert.equal(followCamera(map, FARM_SITES.houseDoor, {width: 274, height: MAP_HEIGHT}).y, 0);
  assert.equal(followCamera(map, {x: 20, y: FARM_HEIGHT - 1}, {width: 274, height: MAP_HEIGHT}).y, 0);
});
