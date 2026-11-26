import {Pixels, rampStep, seeded, sprite, variants, type Pixel, type Sprite} from '../core';
import {ramps} from '../palette';

const tileSize = [16, 16] as const;
const terrainSeed = 137;
const base = sprite({id: 'terrain.laterite.base', size: tileSize, rows: Array<string>(16).fill('B'.repeat(16))});

export const wetnessBands = ['saturated', 'wet', 'moist', 'dry', 'very-dry'] as const;
const wetnessSteps = [-2, -2, -1, 0, 1] as const;

const laterite = variants(base, terrainSeed, 8, (source, random, index) => {
  const tile = new Pixels(tileSize);
  tile.stamp(0, 0, source.rows);
  for (let i = 0; i < 10; i++) {
    const x = 1 + Math.floor(random() * 14);
    const y = 1 + Math.floor(random() * 14);
    if (tile.get(x, y) !== 'B') continue;
    tile.put(x, y, i % 3 ? 'A' : 'C');
    if (i < 3) tile.put(x + 1, y, 'B');
    if (i < 3) tile.put(x, y + 1, 'C');
  }
  return sprite({...source, id: `terrain.laterite.${index}`, rows: tile.rows()});
});

// Dual-grid bits describe the four logic tiles around the display tile's centre.
export const terrainCorners = {nw: 1, ne: 2, se: 4, sw: 8} as const;
const cornerMasks = Array.from({length: 16}, (_, mask) => mask);

function cornerCoverage(mask: number, x: number, y: number): boolean {
  const east = x / 15;
  const south = y / 15;
  const top = (mask & terrainCorners.nw ? 1 - east : 0) + (mask & terrainCorners.ne ? east : 0);
  const bottom = (mask & terrainCorners.sw ? 1 - east : 0) + (mask & terrainCorners.se ? east : 0);
  // The bilinear contour rounds single corners. Shared edges use the same interpolation.
  return top * (1 - south) + bottom * south >= 0.5;
}

function dualGrid(id: string, mask: number, material: (x: number, y: number) => Pixel): Sprite {
  const tile = new Pixels(tileSize);
  tile.stamp(0, 0, laterite[0].rows);
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      if (cornerCoverage(mask, x, y)) tile.put(x, y, material(x, y));
    }
  }
  return sprite({id, size: tileSize, rows: tile.rows()});
}

const grass = cornerMasks.map(mask => dualGrid(`terrain.grass.${mask}`, mask, (x, y) => {
  // Fine straw strokes stay subordinate to the taller tuft overlays.
  const fleck = (x * 13 + y * 23 + (y % 3) * x * 3) % 37;
  return fleck < 4 ? 'G' : fleck < 10 ? 'I' : 'H';
}));

const path = cornerMasks.map(mask => dualGrid(`terrain.path.${mask}`, mask, (x, y) => {
  const grit = (x * 17 + y * 7 + (x % 5) * y * 3) % 41;
  return grit < 9 ? 'B' : 'A';
}));

const furrow = ['B', 'B', 'C', 'D'] as const;

// A fixed hash keeps standing water irregular without tying it to the tile grid phase.
function speckle(x: number, y: number, salt: number): number {
  let h = Math.imul(x + 31 * salt, 0x27d4eb2d) ^ Math.imul(y + 17, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  return ((h ^ (h >>> 13)) >>> 0) % 16;
}

// Wet soil is darker only. Sheen is placed by the view near the emitters, so the bed
// does not repeat a dot every tile.
const tilled = wetnessBands.flatMap((band, index) => cornerMasks.map(mask =>
  dualGrid(`terrain.tilled.${band}.${mask}`, mask, (x, y) => {
    const phase = y % 4;
    const fleck = (x + 3 * y) % 13;
    const ridge = phase === 0 && fleck < 9 ? 'A' : furrow[phase];
    if (band === 'saturated' && phase === 3 && speckle(x >> 1, y, 3) < 11) return speckle(x, y, 5) < 2 ? 'X' : 'W';
    return rampStep(ridge, ramps.soil, wetnessSteps[index]);
  }),
));

// Hairline cracks: one wandering fracture per tile with a side branch, kept off the tile
// edges so neighbouring tiles never join into a net. The middle of each fracture is dark
// and its tips fade out; a pale crust lip catches the light along its upper side.
const cracks = variants(base, terrainSeed + 1, 4, (_source, random, index) => {
  const tile = new Pixels(tileSize);
  const walk = (x: number, y: number, dx: number, dy: number, steps: number) => {
    const points: [number, number][] = [];
    for (let i = 0; i < steps; i++) {
      if (x < 2 || x > 13 || y < 2 || y > 13) break;
      points.push([x, y]);
      // Mostly along the main heading, sometimes a sideways kink.
      const turn = random();
      if (turn < 0.22) x += dy === 0 ? 0 : (random() < 0.5 ? -1 : 1);
      else if (turn < 0.44) y += dx === 0 ? 0 : (random() < 0.5 ? -1 : 1);
      x += dx;
      y += dy;
    }
    return points;
  };
  const ink = (points: readonly [number, number][], tips: number) => points.forEach(([x, y], i) => {
    const tip = i < tips || i >= points.length - tips;
    if (tile.get(x, y) === '.' || !tip) tile.put(x, y, tip ? 'C' : 'D');
  });
  const headings = [[1, 0], [1, 1], [0, 1], [1, -1], [-1, 0], [-1, -1], [0, -1], [-1, 1]] as const;
  const [dx, dy] = headings[Math.floor(random() * 8)];
  const long = index < 2;
  const length = long ? 10 + Math.floor(random() * 3) : 7 + Math.floor(random() * 2);
  // Start so the fracture crosses an off-centre part of the tile.
  const centre = () => 5 + Math.floor(random() * 6);
  const clamp = (value: number) => Math.max(2, Math.min(13, value));
  const trunk = walk(clamp(centre() - Math.round(dx * length / 2)), clamp(centre() - Math.round(dy * length / 2)),
    dx, dy, length);
  ink(trunk, 2);
  if (trunk.length > 4) {
    const [bx, by] = trunk[2 + Math.floor(random() * (trunk.length - 4))];
    const side = random() < 0.5 ? 1 : -1;
    // The branch leaves at a slant, like a desiccation crack's Y junction.
    const branch = dx && dy ? [dx, 0] : dx ? [dx, side] : [side, dy];
    ink(walk(bx + branch[0], by + branch[1], branch[0], branch[1], long ? 3 + Math.floor(random() * 3) : 3), 1);
  }
  // Pale crust lips on the side the light comes from, on every other point of the dark core.
  trunk.forEach(([x, y], i) => {
    if (i % 2 === 1 && tile.get(x, y) === 'D' && tile.get(x, y - 1) === '.') tile.put(x, y - 1, 'A');
  });
  return sprite({id: `terrain.crack.${index}`, size: tileSize, rows: tile.rows()});
});

// N, NE, E, SE, S, SW, W, NW, clockwise. A diagonal joins only with both sides.
export const hedgeNeighbors = {n: 1, ne: 2, e: 4, se: 8, s: 16, sw: 32, w: 64, nw: 128} as const;
export const hedgeTileForMask = Array.from({length: 256}, (_, mask) => {
  for (const [corner, sides] of [[2, 5], [8, 20], [32, 80], [128, 65]]) {
    if ((mask & sides) !== sides) mask &= ~corner;
  }
  return mask;
});

// Sisal: dull grey-green rosettes of stiff sword leaves. Each tile seeds its own clumps,
// so a run is irregular instead of one repeated zigzag.
function hedge(mask: number, variant = 0): Sprite {
  const pixels = new Pixels([16, 24]);
  const random = seeded(terrainSeed + 300 + mask * 7 + variant * 131);
  const {n, ne, e, se, s, sw, w, nw} = hedgeNeighbors;
  // Upper eight rows overhang the logic tile. Connections live in the lower sixteen: a low
  // root band, narrower than the tile and with wobbling edges, so ground shows between
  // the clumps and the strip has no ruled side.
  const band = (x: number, y: number, width: number, height: number) => {
    for (let row = y; row < y + height; row++) {
      const left = Math.floor(random() * 3) - 1;
      const right = Math.floor(random() * 3) - 1;
      for (let col = x + left; col < x + width + right; col++) pixels.put(col, row, random() < .3 ? 'n' : 'P');
    }
  };
  band(5, 16, 6, 5);
  if (mask & n) band(5, 8, 6, 10);
  if (mask & s) band(5, 18, 6, 6);
  if (mask & e) band(10, 16, 6, 4);
  if (mask & w) band(0, 16, 7, 4);
  if (mask & ne) band(10, 8, 6, 8);
  if (mask & se) band(10, 18, 6, 6);
  if (mask & sw) band(0, 18, 6, 6);
  if (mask & nw) band(0, 8, 6, 8);
  const rosette = (bx: number, by: number, reach: number) => {
    // Old outer leaves dry out and lie flat; the live ones fan upward from a dark heart.
    if (random() < .45) pixels.line(bx, by, bx + (random() < .5 ? -1 : 1) * (reach - 2), by + 1, 'I');
    pixels.rect(bx - 1, by, 3, 1, 'n');
    const leaves = 6 + Math.floor(random() * 3);
    for (let i = 0; i < leaves; i++) {
      const spread = i / (leaves - 1) - .5;
      const angle = -Math.PI / 2 + spread * 2.6 + (random() - .5) * .3;
      const length = reach * (.6 + random() * .4) * (Math.abs(spread) < .2 ? 1.2 : 1);
      const tipX = Math.round(bx + Math.cos(angle) * length);
      const tipY = Math.round(by - 1 + Math.sin(angle) * length);
      // Light from the upper left: west and upright blades are olive with a pale tip,
      // east ones grey-green in their own shade.
      const lit = tipX <= bx;
      pixels.line(bx, by - 1, tipX, tipY, lit ? 'O' : 'P');
      pixels.put(tipX, tipY, lit ? 'Q' : 'O');
    }
  };
  const clumps = 2 + Number(random() < .5);
  for (let i = 0; i < clumps; i++) {
    const big = i === 0 || random() < .35;
    rosette(3 + Math.floor(random() * 10), 15 + Math.floor(random() * 7),
      big ? 8 + Math.floor(random() * 3) : 5 + Math.floor(random() * 2));
  }
  const id = variant ? `nature.hedge.${mask}.${variant}` : `nature.hedge.${mask}`;
  return sprite({id, size: pixels.size, anchor: [8, 23], rows: pixels.rows()});
}

// The two straight runs of the boundary get two extra clump layouts each.
const hedgeRuns = [hedgeNeighbors.n | hedgeNeighbors.s, hedgeNeighbors.e | hedgeNeighbors.w];
export const hedgeTiles = [
  ...[...new Set(hedgeTileForMask)].sort((a, b) => a - b).map(mask => hedge(mask)),
  ...hedgeRuns.flatMap(mask => [1, 2].map(variant => hedge(mask, variant))),
];

export const tufts = Array.from({length: 4}, (_, index) => {
  const random = seeded(terrainSeed + 20 + index);
  const pixels = new Pixels(tileSize);
  for (let blade = 0; blade < 7; blade++) {
    const x = 5 + Math.floor(random() * 6);
    const reach = Math.round(random() * 6 - 3);
    const top = 12 - Math.floor(random() * (index < 2 ? 6 : 8));
    const keys = index < 2 ? ['I', 'H', 'G'] as const : ['N', 'M', 'L'] as const;
    pixels.line(x, 13, x + reach, top, keys[0]);
    pixels.line(x, 12, x + reach, top, keys[1]);
    pixels.put(x + reach, top, keys[2]);
  }
  return sprite({id: `nature.tuft.${index}`, size: tileSize, anchor: [8, 13], rows: pixels.rows()});
});

export const terrainSprites = [...laterite, ...tilled, ...grass, ...path, ...cracks];
