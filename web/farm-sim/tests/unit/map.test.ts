import assert from 'node:assert/strict';
import test from 'node:test';
import {dripMasks, waterSprites} from '../../art/sprites/world';
import {LABOUR} from '../../src/core/labour';
import {
  BED_A_TOP_LEFT, BED_B_TOP_LEFT, DRIP_TILES, FARM_HEIGHT, FARM_WIDTH, farmMap, START_TILE, TANK_TILE, tileIndex,
} from '../../src/core/map';
import type {Tier, TileRef, TileView} from '../../src/core/types';
import {followCamera, LANDSCAPE_VIEW, TILE_SIZE} from '../../src/view/camera';

const TIERS: readonly Tier[] = [0, 1, 2, 3, 4];
const NORTH = 1;
const ARMS = [[0, -1, 1, 4], [1, 0, 2, 8], [0, 1, 4, 1], [-1, 0, 8, 2]] as const;
// A ripe plant sprite stands 21 px above its foot, and the view sets the foot 4 px north of
// the tile centre, so the top bed row reaches 17 px above the bed's edge.
const PLANT_RISE_PX = 17;

type Rect = {left: number; top: number; right: number; bottom: number};

function spriteRect(id: string, tile: TileRef): Rect {
  const sprite = waterSprites.find(candidate => candidate.id === id);
  assert.ok(sprite?.anchor, id);
  const left = (tile.x + .5) * TILE_SIZE - sprite.anchor[0];
  const top = (tile.y + .5) * TILE_SIZE - sprite.anchor[1];
  return {left, top, right: left + sprite.size[0], bottom: top + sprite.size[1]};
}

function bedRect(origin: TileRef, width: number, height: number): Rect {
  return {left: origin.x * TILE_SIZE, top: origin.y * TILE_SIZE - PLANT_RISE_PX,
    right: (origin.x + width) * TILE_SIZE, bottom: (origin.y + height) * TILE_SIZE};
}

const overlaps = (a: Rect, b: Rect) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
const featureTile = (map: readonly TileView[], feature: TileView['feature']) => {
  const tile = map.find(candidate => candidate.feature === feature);
  assert.ok(tile, feature + ' is missing');
  return tile;
};

test('the drip line is one pipe from the tank outlet, drawn only with shapes the atlas has', () => {
  const byTile = new Map(DRIP_TILES.map(tile => [tileIndex(tile.at), tile]));
  assert.equal(byTile.size, DRIP_TILES.length);
  const open: (TileRef & {arm: number})[] = [];
  for (const tile of DRIP_TILES) {
    assert.ok(dripMasks.includes(tile.connections), 'no drip sprite for mask ' + tile.connections);
    for (const [dx, dy, arm, opposite] of ARMS) {
      if (!(tile.connections & arm)) continue;
      const next = byTile.get(tileIndex({x: tile.at.x + dx, y: tile.at.y + dy}));
      if (!next) open.push({...tile.at, arm});
      else assert.ok(next.connections & opposite, 'one-way joint at ' + JSON.stringify(tile.at));
    }
  }
  // The only open end is the supply arm that reaches up to the tap on the tank's east side.
  const outlet = {x: TANK_TILE.x + 1, y: TANK_TILE.y};
  assert.deepEqual(open, [{...outlet, arm: NORTH}]);
  const reached = new Set([tileIndex(outlet)]);
  const queue = [outlet];
  for (let tile = queue.shift(); tile; tile = queue.shift()) {
    const connections = byTile.get(tileIndex(tile))!.connections;
    for (const [dx, dy, arm] of ARMS) {
      const next = {x: tile.x + dx, y: tile.y + dy};
      if (connections & arm && byTile.has(tileIndex(next)) && !reached.has(tileIndex(next))) {
        reached.add(tileIndex(next));
        queue.push(next);
      }
    }
  }
  assert.equal(reached.size, DRIP_TILES.length);
});

test('drip pipes cross bed A only as laterals on every second row', () => {
  const map = farmMap(0);
  const laterals = DRIP_TILES.filter(tile => map[tileIndex(tile.at)].bed === 'A');
  assert.equal(laterals.length, 4 * 8);
  for (const tile of laterals) {
    assert.equal((tile.at.y - BED_A_TOP_LEFT.y) % 2, 0);
    assert.equal(tile.connections & (1 | 4), 0, 'a north-south pipe runs under the plants at ' + JSON.stringify(tile.at));
  }
  for (const tile of DRIP_TILES) assert.notEqual(map[tileIndex(tile.at)].bed, 'B');
});

test('the default view shows both beds whole, with the tank and wells clear of the beds and the path', () => {
  const map = farmMap(4);
  const camera = followCamera({width: FARM_WIDTH, height: FARM_HEIGHT, tiles: map}, START_TILE, LANDSCAPE_VIEW);
  const view = {left: camera.x, top: camera.y, right: camera.x + LANDSCAPE_VIEW.width, bottom: camera.y + LANDSCAPE_VIEW.height};
  const bedA = bedRect(BED_A_TOP_LEFT, 8, 8);
  for (const bed of [bedA, bedRect(BED_B_TOP_LEFT, 6, 4)]) {
    assert.ok(bed.left >= view.left && bed.right <= view.right, 'bed cut at the side: ' + JSON.stringify(bed));
    assert.ok(bed.top >= view.top && bed.bottom <= view.bottom, 'bed cut at the top or bottom: ' + JSON.stringify(bed));
  }
  const tank = featureTile(map, 'tank');
  assert.deepEqual(tank.at, TANK_TILE);
  assert.ok(!overlaps(spriteRect('water.tank.0', tank.at), bedA));
  const path = map.filter(tile => tile.terrain === 'path').map(tile => ({
    left: tile.at.x * TILE_SIZE, top: tile.at.y * TILE_SIZE,
    right: (tile.at.x + 1) * TILE_SIZE, bottom: (tile.at.y + 1) * TILE_SIZE,
  }));
  for (const [feature, sprite] of [['well', 'water.well.hand-dug'], ['shared-well', 'water.well.shared.0']] as const) {
    const rect = spriteRect(sprite, featureTile(map, feature).at);
    assert.ok(path.every(tile => !overlaps(rect, tile)), feature + ' stands on the path');
    assert.ok(path.some(tile => overlaps({...rect, left: rect.left - 8, right: rect.right + 8, bottom: rect.bottom + 8}, tile)),
      feature + ' is not beside the path');
  }
  // The carry time assumes the shared well's distance from the tank (plan 6.5).
  assert.equal(featureTile(map, 'shared-well').at.x - TANK_TILE.x, LABOUR.sharedWellDistanceM);
});

test('from the start tile the player reaches both beds and every water point at every tier', () => {
  for (const tier of TIERS) {
    const map = farmMap(tier);
    assert.ok(map[tileIndex(START_TILE)].walkable && map[tileIndex(START_TILE)].feature === null);
    const reached = new Set([tileIndex(START_TILE)]);
    const queue = [START_TILE];
    for (let tile = queue.shift(); tile; tile = queue.shift()) {
      for (const [dx, dy] of ARMS) {
        const index = tileIndex({x: tile.x + dx, y: tile.y + dy});
        if (index >= 0 && map[index].walkable && !reached.has(index)) {
          reached.add(index);
          queue.push(map[index].at);
        }
      }
    }
    for (const tile of map) if (tile.bed) assert.ok(reached.has(tileIndex(tile.at)), 'T' + tier + ' bed tile ' + JSON.stringify(tile.at));
    const besideReach = (at: TileRef) => ARMS.some(([dx, dy]) => reached.has(tileIndex({x: at.x + dx, y: at.y + dy})));
    for (const feature of ['door', 'tank', 'pump', 'well', 'shared-well', 'nursery'] as const) {
      assert.ok(besideReach(featureTile(map, feature).at), 'T' + tier + ' cannot reach the ' + feature);
    }
    if (tier >= 3) assert.ok(besideReach(featureTile(map, 'valve').at));
  }
});
