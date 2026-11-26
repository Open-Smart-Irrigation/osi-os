import {isPaletteKey, ramps, type PaletteKey} from './palette';

export type Point = readonly [x: number, y: number];
export type Pixel = PaletteKey | '.';
export type Remap = Partial<Record<Pixel, Pixel>>;
export type Slice = readonly [left: number, top: number, right: number, bottom: number];

export interface SpriteSource {
  id: string;
  size: Point;
  rows: readonly string[];
  anchor?: Point;
  kind?: 'icon';
  emissive?: readonly Point[];
  slice?: Slice;
}

export interface Sprite extends SpriteSource {
  anchor: Point;
}

export function validateSprite(source: SpriteSource): void {
  const [width, height] = source.size;
  const fail = (reason: string): never => { throw new Error(`${source.id}: ${reason}`); };
  if (!/^[a-z][a-z0-9_-]*(\.[a-z0-9_-]+)*$/.test(source.id)) fail('invalid sprite id');
  if (![width, height].every(n => Number.isInteger(n) && n > 0)) fail('invalid size');
  if (source.rows.length !== height) fail(`expected ${height} rows, got ${source.rows.length}`);
  const inside = ([x, y]: Point) => Number.isInteger(x) && Number.isInteger(y)
    && x >= 0 && x < width && y >= 0 && y < height;
  if (source.anchor && !inside(source.anchor)) fail('anchor outside sprite');
  if (source.kind === 'icon' && (width !== 16 || height !== 16)) fail('icon must be 16 x 16');
  const colors = new Set<string>();
  source.rows.forEach((row, y) => {
    if (row.length !== width) fail(`row ${y} must have ${width} pixels, got ${row.length}`);
    for (const key of row) {
      if (key === '.') continue;
      if (!isPaletteKey(key)) fail(`unknown palette key ${JSON.stringify(key)} in row ${y}`);
      colors.add(key);
    }
  });
  const budget = source.kind === 'icon' ? 8 : 12;
  if (colors.size > budget) fail(`uses ${colors.size} colors, maximum is ${budget}`);
  for (const point of source.emissive ?? []) {
    const [x, y] = point;
    if (!inside(point) || source.rows[y][x] === '.') fail('emissive point needs a visible pixel');
  }
  if (source.slice) {
    const [left, top, right, bottom] = source.slice;
    if (!source.slice.every(n => Number.isInteger(n) && n > 0)
      || left + right >= width || top + bottom >= height) fail('invalid nine-slice margins');
  }
}

export function sprite(source: SpriteSource): Sprite {
  const frame = {...source, anchor: source.anchor ?? [0, 0] as const};
  validateSprite(frame);
  return frame;
}

export function compose(size: Point, layers: readonly {at: Point; rows: readonly string[]}[]): string[] {
  const sheet = new Pixels(size);
  for (const {at: [x, y], rows} of layers) {
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0
      || y + rows.length > size[1] || rows.some(row => x + row.length > size[0])) {
      throw new Error('overlay outside sprite');
    }
    sheet.stamp(x, y, rows);
  }
  return sheet.rows();
}

interface Derivation {
  id: string;
  remap?: Remap;
  mirror?: boolean;
  shiftRamp?: {ramp: keyof typeof ramps; steps: number};
  overlay?: readonly {at: Point; rows: readonly string[]}[];
}

export function rampStep(key: Pixel, ramp: string, steps: number): Pixel {
  const index = ramp.indexOf(key);
  return index < 0 ? key : ramp[Math.min(ramp.length - 1, Math.max(0, index + steps))] as Pixel;
}

export function derive(source: Sprite, options: Derivation): Sprite {
  const {id, remap = {}, mirror, shiftRamp, overlay = []} = options;
  for (const [key, value] of Object.entries(remap)) {
    if ((key !== '.' && !isPaletteKey(key)) || (value !== '.' && !isPaletteKey(value))) {
      throw new Error(`${id}: invalid palette remap ${key} → ${value}`);
    }
  }
  if (shiftRamp && !Number.isInteger(shiftRamp.steps)) throw new Error(`${id}: ramp steps must be integral`);
  const flippedX = (x: number) => mirror ? source.size[0] - 1 - x : x;
  const rows = source.rows.map(row => {
    const pixels = [...row].map(value => {
      const key = value as Pixel;
      return remap[key] ?? (shiftRamp ? rampStep(key, ramps[shiftRamp.ramp], shiftRamp.steps) : key);
    });
    return (mirror ? pixels.reverse() : pixels).join('');
  });
  const [x, y] = source.anchor;
  const slice = source.slice;
  return sprite({
    ...source, id, anchor: [flippedX(x), y],
    emissive: source.emissive?.map(([px, py]) => [flippedX(px), py]),
    slice: slice && mirror ? [slice[2], slice[1], slice[0], slice[3]] : slice,
    rows: compose(source.size, [{at: [0, 0], rows}, ...overlay]),
  });
}

/** The frame's shape in one colour, same size and anchor, as `shadow.<id>`; the view tints it as a cast shadow. */
export function silhouette(source: Sprite, ink: PaletteKey = 'c'): Sprite {
  return sprite({id: `shadow.${source.id}`, size: source.size, anchor: source.anchor,
    rows: source.rows.map(row => row.replace(/[^.]/g, ink))});
}

export function seeded(seed: number): () => number {
  if (!Number.isInteger(seed)) throw new Error('sprite seed must be an integer');
  let state = (seed >>> 0) || 0x6d2b79f5;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x100000000;
  };
}

export function variants(
  source: Sprite, seed: number, count: number,
  op: (source: Sprite, random: () => number, index: number) => Sprite,
): Sprite[] {
  const random = seeded(seed);
  return Array.from({length: count}, (_, index) => op(source, random, index));
}

export class Pixels {
  private readonly grid: string[][];

  constructor(readonly size: Point) {
    this.grid = Array.from({length: size[1]}, () => Array<string>(size[0]).fill('.'));
  }

  get(x: number, y: number): Pixel {
    return (this.grid[y]?.[x] ?? '.') as Pixel;
  }

  put(x: number, y: number, ink: Pixel): void {
    if (x >= 0 && x < this.size[0] && y >= 0 && y < this.size[1]) this.grid[y][x] = ink;
  }

  rect(x: number, y: number, width: number, height: number, ink: Pixel): void {
    for (let row = y; row < y + height; row++) {
      for (let col = x; col < x + width; col++) this.put(col, row, ink);
    }
  }

  line(x: number, y: number, endX: number, endY: number, ink: Pixel): void {
    const dx = Math.abs(endX - x);
    const dy = -Math.abs(endY - y);
    const stepX = x < endX ? 1 : -1;
    const stepY = y < endY ? 1 : -1;
    let error = dx + dy;
    while (true) {
      this.put(x, y, ink);
      if (x === endX && y === endY) return;
      const doubled = 2 * error;
      if (doubled >= dy) { error += dy; x += stepX; }
      if (doubled <= dx) { error += dx; y += stepY; }
    }
  }

  ellipse(cx: number, cy: number, rx: number, ry: number, ink: Pixel): void {
    for (let y = -ry; y <= ry; y++) {
      for (let x = -rx; x <= rx; x++) {
        if ((x * ry) ** 2 + (y * rx) ** 2 <= (rx * ry) ** 2) this.put(cx + x, cy + y, ink);
      }
    }
  }

  stamp(x: number, y: number, rows: readonly string[]): void {
    rows.forEach((row, dy) => {
      for (let dx = 0; dx < row.length; dx++) {
        if (row[dx] !== '.') this.put(x + dx, y + dy, row[dx] as Pixel);
      }
    });
  }

  rows(): string[] {
    return this.grid.map(row => row.join(''));
  }
}
