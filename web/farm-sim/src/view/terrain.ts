import {TILE_SIZE} from './camera';
import type {ViewModel} from './view-model';

type MapView = ViewModel['map'];
type Tile = MapView['tiles'][number];

export const CHUNK_SIZE = 32;
const CORNERS = [1, 2, 4, 8] as const;
const HEDGE_NEIGHBORS = [[0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1]] as const;

export function tileAt(map: MapView, x: number, y: number): Tile | undefined {
  return x >= 0 && y >= 0 && x < map.width && y < map.height ? map.tiles[y * map.width + x] : undefined;
}

export function cornerMask(corners: readonly (Tile | undefined)[], terrain: Tile['terrain']) {
  return corners.reduce((mask, tile, i) => tile?.terrain === terrain ? mask | CORNERS[i] : mask, 0);
}

const BANDS = ['saturated', 'wet', 'moist', 'dry', 'very-dry'] as const;
type Band = typeof BANDS[number];

/**
 * How many bands wetter the soil surface looks while rain falls: one in light rain, two in
 * a downpour. View only: the soil model keeps its own bands, and the look returns when the
 * rain stops.
 */
export function rainWetting(sky: ViewModel['sky']) {
  if (!sky.raining) return 0;
  return sky.rainMmPerHour >= 8 ? 2 : 1;
}

/** Multiply colour for the ground while rain falls: the surface film darkens bare earth too. */
export function rainGroundTint(sky: ViewModel['sky']) {
  if (!sky.raining) return 0xffffff;
  const soak = Math.min(1, .55 + sky.rainMmPerHour / 12);
  const channel = (drop: number) => Math.round(255 * (1 - drop * soak));
  return channel(.24) * 65536 + channel(.27) * 256 + channel(.2);
}

function shownBand(band: Band | null, wetting: number): Band | null {
  return band === null ? null : BANDS[Math.max(0, BANDS.indexOf(band) - wetting)];
}

/** A display tile is centred on the shared corner of four logic tiles. */
export function terrainFrames(map: MapView, x: number, y: number, wetting = 0): readonly string[] {
  const corners = [tileAt(map, x, y), tileAt(map, x + 1, y), tileAt(map, x + 1, y + 1), tileAt(map, x, y + 1)];
  const tilled = cornerMask(corners, 'tilled');
  if (tilled) {
    const fallback = corners.find(tile => tile?.terrain === 'tilled')?.surfaceBand ?? 'dry';
    return corners.map(tile => `terrain.tilled.${shownBand(tile?.terrain === 'tilled'
      ? tile.surfaceBand ?? 'dry' : fallback, wetting)}.${tilled}`);
  }
  const path = cornerMask(corners, 'path');
  if (path) return [`terrain.path.${path}`];
  const grass = cornerMask(corners, 'grass');
  if (grass) return [`terrain.grass.${grass}`];
  return [`terrain.laterite.${(corners[0]?.variant ?? corners.find(Boolean)?.variant ?? 0) % 8}`];
}

/** Rain closes the cracks while it falls, because the surface no longer reads very dry. */
export function crackFrame(tile: Tile, wetting = 0) {
  return shownBand(tile.surfaceBand, wetting) === 'very-dry' ? `terrain.crack.${tile.variant % 4}` : null;
}

export function hedgeMask(map: MapView, x: number, y: number) {
  return HEDGE_NEIGHBORS.reduce((mask, [dx, dy], i) =>
    tileAt(map, x + dx, y + dy)?.feature === 'hedge' ? mask | (1 << i) : mask, 0);
}

/** Include neighbours whose display quadrants straddle the chunk boundary. */
export function chunkInputs(map: MapView, left: number, top: number) {
  const right = Math.min(map.width - 1, left + CHUNK_SIZE);
  const bottom = Math.min(map.height - 1, top + CHUNK_SIZE);
  const tiles: Tile[] = [];
  for (let y = Math.max(0, top - 1); y <= bottom; y++) {
    const start = y * map.width + Math.max(0, left - 1);
    tiles.push(...map.tiles.slice(start, y * map.width + right + 1));
  }
  return tiles;
}

export function sameTerrain(a: Tile, b: Tile) {
  return a === b || (a.terrain === b.terrain && a.variant === b.variant && a.surfaceBand === b.surfaceBand);
}

const PIPE_DIRECTIONS = [[0, -1], [1, 0], [0, 1], [-1, 0]] as const;

/** World-space emitter coordinates match the pairs of bumps on the art. */
export function dripEmitters(segment: ViewModel['dripLine'][number]) {
  const x = segment.at.x * TILE_SIZE + TILE_SIZE / 2;
  const y = segment.at.y * TILE_SIZE + TILE_SIZE / 2;
  return PIPE_DIRECTIONS.flatMap(([dx, dy], i) => segment.connections & (1 << i)
    ? [2, 6].map(distance => ({x: x + dx * distance, y: y + dy * distance}))
    : []);
}
