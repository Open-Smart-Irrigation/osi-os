import type {DripTileView, TileFeature, TileRef, TileTerrain, TileView, Tier} from './types';

// The map is one tile taller than the 30 x 17 tile landscape view, so there the camera hardly moves
// north or south and the default view shows both beds whole; it runs east past the view to the shared
// well. The narrower portrait view follows the farmer.
export const FARM_WIDTH = 42;
export const FARM_HEIGHT = 18;
export const BED_A_AREA_M2 = 64;
export const BED_A_ZONE = 1;
export const BED_A_TOP_LEFT: TileRef = Object.freeze({x: 12, y: 3});
export const BED_B_TOP_LEFT: TileRef = Object.freeze({x: 22, y: 4});
export const HOUSE_TOP_LEFT: TileRef = Object.freeze({x: 2, y: 3});
/** The tank stands on the yard west of bed A; its outlet feeds the header through a short supply pipe. */
export const TANK_TILE: TileRef = Object.freeze({x: 9, y: 10});
/** The main path runs east from the house door and leaves the farm through a gap in the east hedge. */
export const PATH_ROW = 13;
export const START_TILE: TileRef = Object.freeze({x: 7, y: 8});

const DOOR: TileRef = Object.freeze({x: HOUSE_TOP_LEFT.x + 2, y: HOUSE_TOP_LEFT.y + 3});
const PUMP: TileRef = Object.freeze({x: TANK_TILE.x - 1, y: TANK_TILE.y + 1});
/** Places that guidance can point the player to. */
export const FARM_SITES = Object.freeze({
  houseDoor: DOOR,
  tank: TANK_TILE,
  pump: PUMP,
  firstBed: Object.freeze({x: BED_A_TOP_LEFT.x, y: BED_A_TOP_LEFT.y + 7}),
});
/** The drip header runs along bed A's west edge, on the yard, from the top lateral to the supply row. */
const HEADER_X = BED_A_TOP_LEFT.x - 1;
const LATERAL_ROWS = [0, 2, 4, 6].map(dy => BED_A_TOP_LEFT.y + dy);

const at = (x: number, y: number): TileRef => ({x, y});

function inRect(tile: TileRef, origin: TileRef, width: number, height: number): boolean {
  return tile.x >= origin.x && tile.x < origin.x + width && tile.y >= origin.y && tile.y < origin.y + height;
}

const FEATURES: readonly {at: TileRef; feature: TileFeature; tier?: Tier; walkable?: boolean}[] = [
  {at: HOUSE_TOP_LEFT, feature: 'house'},
  {at: at(HOUSE_TOP_LEFT.x + 1, HOUSE_TOP_LEFT.y + 1), feature: 'bed'},
  {at: DOOR, feature: 'door', walkable: true},
  {at: at(HOUSE_TOP_LEFT.x + 3, HOUSE_TOP_LEFT.y + 3), feature: 'lamp'},
  // Hand-dug well beside the house path, its pump, then the tank: the water goes west to east.
  {at: TANK_TILE, feature: 'tank'},
  {at: PUMP, feature: 'pump'},
  {at: at(TANK_TILE.x - 3, TANK_TILE.y + 2), feature: 'well'},
  // Thirty tiles east of the tank, beside the path where it leaves the farm.
  {at: at(TANK_TILE.x + 30, PATH_ROW - 1), feature: 'shared-well'},
  {at: at(BED_B_TOP_LEFT.x + 1, BED_B_TOP_LEFT.y + 5), feature: 'nursery'},
  // The south yard, between the path and the hedge.
  {at: at(25, 16), feature: 'acacia'},
  {at: at(3, 15), feature: 'rock'},
  {at: at(16, 16), feature: 'rock'},
  {at: at(29, 14), feature: 'rock'},
  {at: at(35, 15), feature: 'rock'},
  {at: at(10, 15), feature: 'tuft', walkable: true},
  {at: at(20, 15), feature: 'tuft', walkable: true},
  {at: at(32, 16), feature: 'tuft', walkable: true},
  {at: at(38, 15), feature: 'tuft', walkable: true},
  {at: at(30, 2), feature: 'tuft', walkable: true},
  // On the third drip lateral, beside a plant, where the emitters wet the soil.
  {at: at(BED_A_TOP_LEFT.x + 2, LATERAL_ROWS[2]), feature: 'probe', tier: 1, walkable: true},
  {at: at(TANK_TILE.x + 1, TANK_TILE.y - 4), feature: 'gateway', tier: 1},
  {at: at(TANK_TILE.x, TANK_TILE.y - 4), feature: 'rain-gauge', tier: 2},
  // Both sit on the tank outlet line: the valve under the tap, the meter at the header's foot.
  {at: at(TANK_TILE.x + 1, TANK_TILE.y), feature: 'valve', tier: 3},
  {at: at(HEADER_X, TANK_TILE.y), feature: 'flow-meter', tier: 2},
];

export function farmMap(tier: Tier): readonly TileView[] {
  const tiles: TileView[] = [];
  for (let y = 0; y < FARM_HEIGHT; y++) {
    for (let x = 0; x < FARM_WIDTH; x++) {
      const here = Object.freeze({x, y});
      const bed = inRect(here, BED_A_TOP_LEFT, 8, 8) ? 'A' : inRect(here, BED_B_TOP_LEFT, 6, 4) ? 'B' : null;
      const hedge = y === 0 || y === FARM_HEIGHT - 1 || x === 0 || (x === FARM_WIDTH - 1 && y !== PATH_ROW);
      const object = FEATURES.find(item => item.at.x === x && item.at.y === y && (item.tier ?? 0) <= tier);
      const houseWall = inRect(here, HOUSE_TOP_LEFT, 4, 4)
        && !inRect(here, at(HOUSE_TOP_LEFT.x + 1, HOUSE_TOP_LEFT.y + 1), 2, 2);
      const path = (y === PATH_ROW && x >= DOOR.x) || (x === DOOR.x && y >= DOOR.y && y <= PATH_ROW);
      const yard = inRect(here, at(2, 2), 29, 15);
      const terrain: TileTerrain = bed === 'A' ? 'tilled' : path ? 'path' : yard ? 'laterite' : 'grass';
      tiles.push(Object.freeze({
        at: here, bed, terrain, variant: (x * 19 ^ y * 37 ^ x * y) & 7,
        feature: object?.feature ?? (hedge ? 'hedge' : null),
        walkable: !(hedge || houseWall || object) || object?.walkable === true,
        surfaceBand: null, wetness: null,
      }));
    }
  }
  return Object.freeze(tiles);
}

const NORTH = 1;
const EAST = 2;
const SOUTH = 4;
const WEST = 8;

function pipe(x: number, y: number, connections: number): Omit<DripTileView, 'wet'> {
  return Object.freeze({at: Object.freeze({x, y}), connections});
}

/**
 * Bed A's drip line: four laterals on every second row from the top, a header on the yard
 * along the bed's west edge, and a supply pipe that leaves the tank outlet and turns east to
 * the foot of the header. No pipe runs under a plant column.
 */
export const DRIP_TILES: readonly Omit<DripTileView, 'wet'>[] = Object.freeze([
  ...LATERAL_ROWS.flatMap(y => Array.from({length: 8}, (_, column) =>
    pipe(BED_A_TOP_LEFT.x + column, y, column < 7 ? EAST | WEST : WEST))),
  ...Array.from({length: TANK_TILE.y - BED_A_TOP_LEFT.y + 1}, (_, i) => {
    const y = BED_A_TOP_LEFT.y + i;
    const lateral = LATERAL_ROWS.includes(y) ? EAST : 0;
    const up = y > BED_A_TOP_LEFT.y ? NORTH : 0;
    const down = y < TANK_TILE.y ? SOUTH : WEST;
    return pipe(HEADER_X, y, lateral | up | down);
  }),
  ...Array.from({length: HEADER_X - TANK_TILE.x - 1}, (_, i) =>
    pipe(TANK_TILE.x + 1 + i, TANK_TILE.y, i === 0 ? NORTH | EAST : EAST | WEST)),
]);

export function tileIndex(tile: TileRef): number {
  if (!Number.isInteger(tile.x) || !Number.isInteger(tile.y)
    || tile.x < 0 || tile.y < 0 || tile.x >= FARM_WIDTH || tile.y >= FARM_HEIGHT) return -1;
  return tile.y * FARM_WIDTH + tile.x;
}
