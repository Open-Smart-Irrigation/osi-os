import {derive, Pixels, sprite, type Pixel, type Point, type Sprite} from '../core';

export const dripShapes = {straight: 10, corner: 3, tee: 11, end: 8} as const;
const dripSegments = [[8, 0], [15, 8], [8, 15], [0, 8]] as const;

export function dripRows(mask: number, wet: boolean): string[] {
  const pixels = new Pixels([16, 16]);
  // A two-pixel hose: a grey top that catches the sky over a dark underside, so it reads
  // on dark wet soil. Emitters sit 2 and 6 px from the centre, as dripEmitters expects.
  const arms = dripSegments.filter((_, i) => mask & (1 << i));
  arms.forEach(([x, y]) => {
    const dx = Math.sign(x - 8);
    const dy = Math.sign(y - 8);
    pixels.line(8 + Math.abs(dy), 8 + Math.abs(dx), x + Math.abs(dy), y + Math.abs(dx), 'k');
  });
  arms.forEach(([x, y]) => pixels.line(8, 8, x, y, 'R'));
  pixels.put(8, 8, 'R');
  arms.forEach(([x, y]) => {
    const dx = Math.sign(x - 8);
    const dy = Math.sign(y - 8);
    for (const gap of [2, 6]) {
      const bumpX = 8 + gap * dx;
      const bumpY = 8 + gap * dy;
      // The emitter button, and when the line runs, a bead and a drop on the shadow side.
      pixels.put(bumpX, bumpY, wet ? 'X' : 'T');
      if (wet) pixels.put(bumpX + Math.abs(dy), bumpY + Math.abs(dx), 'v');
    }
  });
  return pixels.rows();
}

function dripLine(shape: keyof typeof dripShapes, wet: boolean): Sprite {
  return sprite({id: `water.drip.${shape}.${wet ? 'wet' : 'dry'}`, size: [16, 16],
    rows: dripRows(dripShapes[shape], wet)});
}

function tank(level: number): Sprite {
  const pixels = new Pixels([32, 48]);
  pixels.rect(5, 25, 3, 19, 'J');
  pixels.rect(24, 25, 3, 19, 'J');
  pixels.line(7, 29, 24, 42, 'j');
  pixels.line(7, 42, 24, 29, 'j');
  pixels.rect(5, 25, 1, 18, 'C');
  pixels.rect(24, 25, 1, 18, 'C');
  pixels.rect(3, 25, 26, 4, 'J');
  pixels.rect(3, 25, 26, 1, 'j');
  pixels.ellipse(15, 23, 13, 4, 'k');
  pixels.rect(2, 9, 27, 15, 'k');
  pixels.rect(3, 9, 23, 14, 'W');
  pixels.rect(5, 10, 2, 13, 'v');
  pixels.rect(7, 10, 1, 11, 'u');
  pixels.rect(2, 15, 27, 1, 'k');
  pixels.rect(3, 16, 22, 1, 'v');
  pixels.rect(2, 21, 27, 1, 'k');
  pixels.ellipse(15, 8, 13, 5, 'W');
  pixels.ellipse(14, 7, 11, 3, 'v');
  pixels.rect(12, 3, 7, 3, 'k');
  pixels.rect(12, 3, 6, 1, 'R');
  pixels.line(6, 7, 10, 6, 'u');
  pixels.rect(20, 12, 4, 11, 'k');
  pixels.rect(21, 13, 2, 9, 'R');
  if (level) {
    pixels.rect(21, 22 - 3 * level, 2, 3 * level, 'v');
    pixels.rect(21, 22 - 3 * level, 2, 1, 'X');
  }
  pixels.line(26, 24, 26, 35, 'R');
  pixels.line(26, 35, 30, 35, 'R');
  pixels.put(27, 34, 'T');
  pixels.put(28, 34, 'o');
  return sprite({id: `water.tank.${level}`, size: pixels.size, anchor: [16, 44], rows: pixels.rows()});
}

function well(shared: boolean, phase: number): Sprite {
  const pixels = new Pixels([32, 32]);
  pixels.ellipse(16, 25, 13, 5, 'D');
  pixels.rect(3, 19, 27, 5, 'J');
  pixels.ellipse(16, 19, 13, 6, 'A');
  pixels.ellipse(16, 19, 9, 4, 'k');
  pixels.ellipse(16, 21, 7, 2, 'W');
  pixels.line(12, 21, 17, 21, 'u');
  for (const [x, y] of [[6, 18], [9, 16], [16, 14], [23, 16], [25, 20], [19, 24], [11, 24]]) {
    pixels.line(x, y, x + 2, y + 1, 'C');
  }
  if (shared) {
    pixels.rect(5, 5, 2, 18, 'J');
    pixels.rect(26, 5, 2, 18, 'J');
    pixels.rect(6, 5, 21, 3, 'j');
    pixels.rect(10, 8, 13, 3, 'J');
    pixels.rect(12, 8, 9, 1, 'A');
    const bucketY = [13, 16, 19, 16][phase];
    pixels.line(16, 10, 16, bucketY, 'H');
    pixels.stamp(13, bucketY, ['.RRR.', 'TTRRJ', 'RRTTJ', '.RRJ.']);
    if (phase === 2) pixels.put(20, 22, 'X');
  } else {
    pixels.stamp(9, 17, ['TTTTTRRRRRRRR', 'RRRRRRRRRRTTR', 'RRRRTTRRRRRRR']);
    pixels.rect(12, 15, 8, 2, 'R');
    pixels.line(20, 17, 25, 19, 'T');
  }
  return sprite({id: shared ? `water.well.shared.${phase}` : 'water.well.hand-dug',
    size: pixels.size, anchor: [16, 27], rows: pixels.rows()});
}

const handPump = sprite({
  id: 'water.hand-pump', size: [16, 24], anchor: [8, 21], rows: [
    '................',
    '................',
    '..jJ............',
    '...Jj.....RR....',
    '....Jj...TRTk...',
    '.....Jj.RRgRk...',
    '......JjRTgRk...',
    '.......RTTgRk...',
    '........RRgRk...',
    '.........TgRk...',
    '....TRRRRTgRk...',
    '...TRTTTRRgRk...',
    '...RRk...TgRk...',
    '...RTk...TgRk...',
    '.........TgRk...',
    '.........TgRk...',
    '.........TgRk...',
    '.........TgRk...',
    '........TRRk....',
    '.......TRRRRk...',
    '......jTTTTTRJ..',
    '....CjjjjJJJJJ..',
    '.....DDDDDDD....',
    '................',
  ],
});

export const waterSprites = [
  ...Object.keys(dripShapes).flatMap(shape => [false, true].map(wet => dripLine(shape as keyof typeof dripShapes, wet))),
  ...Array.from({length: 4}, (_, level) => tank(level)),
  handPump, well(false, 0), ...Array.from({length: 4}, (_, phase) => well(true, phase)),
];

function farmhouse(lit: boolean): Sprite {
  const pixels = new Pixels([64, 64]);
  // House faces south under a lean-to iron roof that falls towards the back, so
  // from the south only the high front eave and a short, foreshortened run of
  // roof show, like the tank lid. Light from the top left; outline bottom and
  // right only. Walls x 6..57, roof x 2..61 (4 px verge overhang).
  const glass: Point[] = [];
  const barredWindow = (x: number, y: number) => {
    pixels.rect(x - 1, y - 1, 12, 1, 'j');                  // timber lintel
    pixels.rect(x, y, 10, 10, 'J');                         // frame
    pixels.rect(x + 1, y + 1, 8, 8, lit ? 'Y' : 'k');
    if (lit) pixels.rect(x + 1, y + 1, 2, 3, 'F');
    for (const bar of [3, 6]) pixels.rect(x + bar, y + 1, 1, 8, lit ? 'J' : 'R');
    pixels.rect(x - 1, y + 10, 12, 1, 'T');                 // cement sill
    glass.push([x + 5, y + 5]);                             // light leaves from the middle of the pane
  };
  // Lime-washed earth plaster, a 3-row eave shadow, darker splash band, footing.
  pixels.rect(6, 28, 52, 29, 'A');
  pixels.rect(6, 28, 52, 3, 'C');
  pixels.rect(55, 31, 2, 17, 'B');
  for (let x = 6; x < 57; x++) {
    const top = 48 - Number(x % 7 === 2 || x % 11 === 5) + Number(x % 9 === 0);
    pixels.rect(x, top, 1, 56 - top, x > 54 ? 'D' : 'C');
  }
  for (const [x, y] of [[9, 54], [14, 52], [22, 54], [41, 53], [47, 54], [52, 51]]) pixels.put(x, y, 'D');
  pixels.rect(6, 56, 52, 1, 'D');
  pixels.rect(6, 57, 52, 1, 'k');
  // The base course stands 1 px proud of the wall at the west end, so its edge stays crisp
  // against the laterite instead of dissolving into it.
  pixels.rect(5, 48, 1, 9, 'D');
  pixels.put(5, 57, 'k');
  pixels.rect(57, 28, 1, 30, 'k');
  // Rafter ends under the eave.
  for (let x = 9; x < 56; x += 6) pixels.rect(x, 28, 1, 2, 'J');
  // A hurricane lantern on a bracket beside the door; lit at night.
  pixels.rect(39, 34, 2, 1, 'k');
  pixels.put(40, 35, 'k');
  pixels.rect(39, 36, 3, 1, 'R');
  pixels.rect(39, 37, 3, 2, 'R');
  pixels.put(40, 37, lit ? 'F' : 'T');
  pixels.put(40, 38, lit ? 'Y' : 'k');
  pixels.rect(39, 39, 3, 1, 'J');
  barredWindow(10, 35);
  barredWindow(44, 35);
  // Plank door under a lintel, on a stone step.
  pixels.rect(26, 32, 13, 1, 'j');
  pixels.rect(27, 33, 11, 22, 'J');
  pixels.rect(28, 34, 9, 21, 'j');
  for (const x of [31, 34]) pixels.rect(x, 34, 1, 21, 'J');
  for (const y of [37, 50]) pixels.rect(28, y, 9, 1, 'J');
  pixels.put(35, 44, 'Y');
  if (lit) {
    // The door stands ajar: lamplight in the gap on the latch side and across the sill.
    pixels.rect(35, 34, 2, 21, 'Y');
    pixels.rect(36, 35, 1, 19, 'F');
  }
  pixels.rect(25, 55, 15, 1, 'A');
  pixels.rect(25, 56, 15, 1, 'B');
  // Roof surface: mid grey with a faint crest every 4 px running down the
  // slope. The cut front edge is the nearest line and shows the corrugation
  // profile end-on, kept low in contrast.
  for (let y = 17; y <= 25; y++) {
    for (let x = 2; x <= 61; x++) {
      const crest = (x - 2) % 4 === 0 && y >= 18;
      pixels.put(x, y, crest ? 'T' : 'R');
    }
  }
  const profile: readonly Pixel[] = ['T', 'T', 'R', 'R'];
  for (let x = 2; x <= 61; x++) {
    pixels.put(x, 26, profile[(x - 2) % 4]);
    pixels.put(x, 27, 'k');
  }
  pixels.rect(61, 17, 1, 11, 'k');
  // A little rust on the cut edge, creeping up both verges from the corners.
  for (const [x, y, key] of [[2, 26, 'D'], [3, 26, 'C'], [2, 25, 'C'], [2, 24, 'C'], [2, 23, 'C'], [3, 25, 'D'],
    [60, 26, 'D'], [59, 26, 'C'], [60, 25, 'C'], [60, 24, 'C'], [60, 23, 'C']] as const) pixels.put(x, y, key);
  return sprite({id: lit ? 'structure.farmhouse.lit' : 'structure.farmhouse',
    // Emissive order is part of the view contract: window, window, door gap, lantern.
    size: pixels.size, anchor: [32, 58], rows: pixels.rows(), emissive: lit ? [...glass, [36, 44], [40, 37]] : undefined});
}

function thatchNoise(a: number, b: number): number {
  let h = (Math.imul(a, 374761393) + Math.imul(b, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 0x100000000;
}

// Not placed in M1; a house choice for the run-setup screen (plan section 14).
// Known fixes: 1) the lit roof shares the grass keys G/H/I: add a 1 px j edge down its left silhouette.
// 2) Draw the thatch courses as 4 rings that come back to the right edge, not a spiral down to the right.
// 3) Raise the roof 3 px and add 3 wall rows so the 6 x 12 door suits the 23 px farmer.
function roundThatchFarmhouse(lit: boolean): Sprite {
  const pixels = new Pixels([64, 64]);
  // Round house seen from the south in the same three-quarter view as the tank and well:
  // a mud-plastered wall cylinder under a conical thatch roof, light from the top left.
  const cx = 32;
  const wall = {rx: 22, ry: 9, baseY: 47};
  const eave = {rx: 28, ry: 11, y: 31};
  const apexY = 8;
  const rise = eave.y - apexY;
  const eaveFront = (x: number) => eave.y + eave.ry * Math.sqrt(Math.max(0, 1 - ((x - cx) / eave.rx) ** 2));

  for (let x = cx - wall.rx; x <= cx + wall.rx; x++) {
    const s = (x - cx) / wall.rx;
    const base = Math.round(wall.baseY + wall.ry * Math.sqrt(1 - s * s));
    const band = s < -0.2 ? 0 : s < 0.35 ? 1 : s < 0.75 ? 2 : 3;
    for (let y = 26; y <= base; y++) pixels.put(x, y, 'ABCD'[band] as Pixel);
    pixels.put(x, base, 'CCDD'[band] as Pixel);
    pixels.put(x, base - 1, 'BCDD'[band] as Pixel);
    pixels.put(x, base + 1, 'k');
    const under = Math.floor(eaveFront(x)) + 1;
    pixels.put(x, under, 'D');
    pixels.put(x, under + 1, s < 0.3 ? 'C' : 'D');
    if (s > 0.5) pixels.put(x, under + 2, 'D');
  }
  for (const [x, y, key] of [[11, 45, 'B'], [22, 48, 'B'], [24, 52, 'C'], [39, 49, 'C'], [46, 45, 'D'], [43, 53, 'D']] as const) {
    pixels.line(x, y, x + 2, y, key);
  }

  pixels.rect(28, 43, 9, 1, 'J');
  pixels.rect(29, 44, 7, 12, 'k');
  pixels.rect(29, 44, 1, 12, 'J');
  pixels.rect(28, 56, 9, 1, 'A');
  if (lit) {
    pixels.rect(30, 55, 6, 1, 'Y');
    pixels.rect(31, 55, 3, 1, 'F');
    pixels.put(30, 54, 'Y');
  }
  pixels.rect(15, 44, 7, 6, 'J');
  pixels.rect(16, 45, 5, 4, lit ? 'Y' : 'k');
  if (lit) pixels.rect(16, 45, 2, 2, 'F');
  pixels.rect(15, 50, 7, 1, 'A');

  const yt = -(eave.ry ** 2) / rise;
  const xt = eave.rx * Math.sqrt(1 - (yt / eave.ry) ** 2);
  const courses = 5;
  const knotT = 0.1;
  const roof: [number, number, number][] = [];
  for (let y = 0; y < 48; y++) {
    for (let x = 0; x < 64; x++) {
      const dx = x - cx;
      const a = Math.abs(dx) / eave.rx;
      const target = y - eave.y + rise;
      if (a > 1 || target < 0) continue;
      const surface = (t: number) => t * rise + eave.ry * Math.sqrt(Math.max(0, t * t - a * a));
      if (surface(1) < target) continue;
      let t = a;
      if (surface(a) >= target) {
        if (target < Math.abs(dx) * (yt + rise) / xt) continue;
      } else {
        let low = a;
        let high = 1;
        for (let i = 0; i < 24; i++) {
          t = (low + high) / 2;
          if (surface(t) < target) low = t; else high = t;
        }
      }
      roof.push([x, y, t]);
    }
  }
  const ramp = 'kjIHG';
  const tips: [number, number, number][] = [];
  for (const [x, y, t] of roof) {
    const sin = Math.max(-1, Math.min(1, (x - cx) / (eave.rx * Math.max(t, 0.01))));
    const course = Math.min(courses - 1, Math.floor((t - knotT) / (1 - knotT) * courses));
    const bundle = Math.floor((Math.asin(sin) * eave.rx * t + course * 2 + 60) / 4);
    const jitter = thatchNoise(bundle, course);
    const u = (t - knotT) / (1 - knotT) * courses - course + (jitter - 0.5) * 0.3;
    const side = sin + (jitter - 0.5) * 0.2;
    let level = side < -0.35 ? 4 : side < 0.25 ? (jitter < 0.3 ? 2 : 3) : side < 0.7 ? 2 : 1;
    if (u < 0.24) level -= u < 0.12 && level === 4 ? 2 : 1;
    else if (u > 0.84) {
      level += 1;
      tips.push([x, y, level]);
    }
    pixels.put(x, y, ramp[Math.max(1, Math.min(4, level))] as Pixel);
  }
  for (const [x, y, level] of tips) {
    const side = x < cx ? -1 : 1;
    if (pixels.get(x + side, y) === '.' && pixels.get(x + side, y + 1) === '.') {
      pixels.put(x + side, y, ramp[Math.max(1, level - 1)] as Pixel);
    }
  }
  for (let x = cx - eave.rx + 1; x < cx + eave.rx; x++) {
    if (thatchNoise(Math.floor((x + 40) / 3), 99) > 0.45) {
      pixels.put(x, Math.floor(eaveFront(x)) + 1, x < cx - 10 ? 'H' : x < cx + 8 ? 'I' : 'j');
    }
  }
  for (const [x, y] of roof) {
    if (x >= cx && (pixels.get(x + 1, y) === '.' || pixels.get(x, y - 1) === '.')) pixels.put(x, y, 'k');
  }
  for (let x = cx - eave.rx - 1; x <= cx + eave.rx + 1; x++) {
    let y = 47;
    while (y > 0 && !'GHIj'.includes(pixels.get(x, y))) y--;
    if (y > 0 && pixels.get(x, y + 1) === '.' && x > cx - 12) pixels.put(x, y, 'k');
  }
  pixels.stamp(cx - 3, apexY - 5, [
    '...G...',
    '..GHI..',
    '..GHIk.',
    '..JJJk.',
    '..GHIk.',
    '.GGHIjk',
    '.GHHIjk',
  ]);
  return sprite({id: lit ? 'structure.farmhouse.round-thatch.lit' : 'structure.farmhouse.round-thatch',
    size: pixels.size, anchor: [32, 58], rows: pixels.rows(), emissive: lit ? [[16, 45]] : undefined});
}

// Hipped thatch over a recessed veranda; three-quarter view from the south, light from the top left.
const roofTop = 5;
const shoulder = 16;
const hipEave = 31;
const hipRidge = [23, 40] as const;

function roofEdge(y: number): number {
  return y <= shoulder ? Math.round(hipRidge[0] - (y - roofTop) * (hipRidge[0] - 1) / (shoulder - roofTop)) : 1;
}

function hipLine(y: number): number {
  return Math.round(hipRidge[0] - (y - roofTop) * (hipRidge[0] - 1) / (hipEave - roofTop));
}

const hipCourses = [12, 19, 25] as const;

function grain(x: number, y: number): number {
  return ((Math.imul(x + 11, 0x9e3779b1) ^ Math.imul(y + 7, 0x85ebca6b)) >>> 13) % 12;
}

function thatch(x: number, y: number): Pixel {
  const hip = hipLine(y);
  if (x < hip) return 'G';
  if (x > 63 - hip) return 'I';
  // Front slope: each course ends in a dark lip, and loose straw ends hang over the next one.
  for (const c of hipCourses) {
    const g = grain(x, c);
    if (y === c) return g === 0 ? 'H' : 'I';
    if (y === c + 1 && g % 3 === 1) return 'I';
    if (y === c + 2 && g === 4) return 'I';
    if (y === c - 1 && g === 7 && x < 40) return 'G';
  }
  return 'H';
}

// Not placed in M1; a house choice for the run-setup screen (plan section 14).
// Known fixes: 1) the roof shares the grass keys G/H/I and dash texture: remap it, use 1 x 2 straw strokes.
// 2) Deepen the veranda slab to 4 rows, run the posts down to its front edge, widen the eave shadow.
// 3) Once placed, its ground shadow must cover the whole footprint and fall past the right side.
function hippedThatchFarmhouse(lit: boolean): Sprite {
  const pixels = new Pixels([64, 64]);
  // Veranda slab: contact shadow, earth floor, lit lip, riser, ground line.
  pixels.rect(1, 53, 62, 1, 'C');
  pixels.rect(1, 54, 62, 1, 'B');
  pixels.rect(1, 55, 62, 1, 'A');
  pixels.rect(1, 56, 62, 1, 'C');
  pixels.rect(1, 57, 62, 1, 'k');
  pixels.rect(60, 54, 3, 3, 'D');
  // Earth-plastered wall in the shade of the eave, with a darker mud dado.
  pixels.rect(5, 34, 54, 19, 'A');
  pixels.rect(5, 34, 54, 1, 'k');
  pixels.rect(5, 35, 54, 2, 'C');
  pixels.rect(5, 37, 54, 1, 'B');
  pixels.rect(5, 49, 54, 4, 'C');
  pixels.rect(5, 49, 54, 1, 'D');
  // Plaster worn through to mud brick in two places.
  for (const [x, y] of [[24, 43], [51, 40]]) {
    pixels.stamp(x, y, ['.BBCB', 'CCCCC', 'BCBB.']);
  }
  // Door, right of centre.
  pixels.rect(36, 37, 10, 16, 'J');
  pixels.rect(37, 38, 8, 15, 'j');
  pixels.line(39, 38, 39, 52, 'J');
  pixels.line(42, 38, 42, 52, 'J');
  pixels.put(38, 45, 'H');
  // Small window, left of centre.
  pixels.rect(13, 39, 9, 7, 'J');
  pixels.rect(14, 40, 7, 5, lit ? 'Y' : 'k');
  if (lit) pixels.rect(14, 40, 3, 2, 'F');
  pixels.line(17, 40, 17, 44, 'J');
  pixels.rect(12, 46, 11, 1, 'j');
  // Veranda posts: lit face on the left.
  for (const x of [3, 31, 59]) {
    pixels.rect(x, 34, 1, 22, 'j');
    pixels.rect(x + 1, 34, 1, 22, 'J');
    pixels.rect(x, 34, 2, 1, 'k');
  }
  // Roof faces: west hip lit, front slope mid, east hip in shade.
  for (let y = roofTop; y < hipEave; y++) {
    for (let x = roofEdge(y); x <= 63 - roofEdge(y); x++) pixels.put(x, y, thatch(x, y));
  }
  // Hip rolls: a lit edge, then the shadow they cast across the slope.
  for (let y = roofTop + 1; y < hipEave; y++) {
    const hip = hipLine(y);
    pixels.put(hip, y, 'I');
    pixels.put(63 - hip, y, 'G');
    pixels.put(64 - hip, y, 'j');
  }
  // Eave fringe: course edge, straw butts, ragged underside.
  for (let x = 1; x <= 62; x++) {
    pixels.put(x, hipEave, 'I');
    pixels.put(x, hipEave + 1, x % 4 === 1 ? 'I' : x < 32 && x % 4 === 3 ? 'G' : 'H');
    pixels.put(x, hipEave + 2, x % 3 === 0 ? 'J' : 'I');
  }
  pixels.put(1, hipEave + 2, '.');
  pixels.put(62, hipEave + 2, '.');
  // Ridge roll.
  pixels.rect(hipRidge[0], roofTop - 1, hipRidge[1] - hipRidge[0] + 1, 1, 'I');
  pixels.rect(hipRidge[0], roofTop, hipRidge[1] - hipRidge[0] + 1, 1, 'G');
  pixels.rect(hipRidge[0], roofTop + 1, hipRidge[1] - hipRidge[0] + 1, 1, 'I');
  pixels.line(1, shoulder, hipRidge[0], roofTop - 1, 'I');
  pixels.line(62, shoulder, hipRidge[1], roofTop - 1, 'j');
  pixels.line(62, shoulder, 62, hipEave + 1, 'k');
  return sprite({id: lit ? 'structure.farmhouse.hipped-thatch.lit' : 'structure.farmhouse.hipped-thatch',
    size: pixels.size, anchor: [32, 58], rows: pixels.rows(), emissive: lit ? [[14, 40]] : undefined});
}

// Corrugated iron seen from above: crests catch the light, every fourth column.
function ironRib(x: number): Pixel {
  return x % 4 === 0 ? 'T' : 'R';
}

// Not placed in M1; a house choice for the run-setup screen (plan section 14).
// Known fixes: 1) the east wall recedes sideways: step its base, eave and rake up 1 px per 2 columns.
// 2) Use straight vertical T crests every 4 px, keeping the screw row and rust; stepped crests read as slate.
// 3) Move the veranda posts and slab 2 px forward so the canopy has a floor in front of the wall.
function gableTinFarmhouse(lit: boolean): Sprite {
  const pixels = new Pixels([64, 64]);
  // House faces south; the ridge runs east-west. Depth leans up and to the right, so the
  // front slope is a parallelogram and the east gable end shows on the right, in shade.
  const eave = 26;
  const ridge = 12;
  const lean = 5;
  const shear = (y: number) => Math.round((eave - y) * lean / (eave - ridge));
  // East end: side wall and gable triangle up to the ridge end, under the back verge.
  pixels.rect(46, eave + 1, 10, 53 - eave, 'C');
  for (let y = ridge - 1; y <= eave + 1; y++) {
    const half = Math.round((y - ridge + 1) * lean / (eave + 2 - ridge));
    for (let x = 51 - half; x <= 51 + half; x++) pixels.put(x, y, 'D');
    pixels.put(52 + half, y, 'R');
    pixels.put(53 + half, y, 'k');
  }
  pixels.rect(46, eave + 2, 10, 1, 'D');
  pixels.rect(56, eave + 1, 1, 54 - eave, 'k');
  pixels.rect(49, 34, 4, 8, 'J');
  pixels.rect(50, 35, 2, 6, 'j');
  pixels.rect(49, 42, 4, 1, 'D');
  // Front wall: earth plaster, shadow band under the eave, darker splash course at the foot.
  pixels.rect(7, eave + 2, 39, 52 - eave, 'A');
  pixels.rect(7, eave + 2, 39, 1, 'C');
  pixels.rect(7, eave + 3, 39, 1, 'B');
  pixels.rect(7, 50, 39, 4, 'C');
  pixels.rect(7, 50, 39, 1, 'B');
  pixels.rect(45, eave + 3, 1, 47 - eave, 'B');
  for (const [x, y] of [[20, 31], [9, 47], [43, 33], [16, 46]]) pixels.line(x, y, x + 2, y, 'B');
  pixels.rect(7, 54, 50, 1, 'k');
  // Window left of the veranda, out of its shade.
  pixels.rect(10, 33, 11, 11, 'J');
  pixels.rect(11, 34, 9, 9, lit ? 'Y' : 'k');
  if (lit) pixels.rect(11, 34, 4, 4, 'F');
  pixels.line(15, 34, 15, 42, 'j');
  pixels.line(11, 38, 19, 38, 'j');
  pixels.rect(9, 44, 13, 1, 'T');
  // Veranda: a lean-to of the same sheet on a beam and two posts, shading wall and door.
  pixels.rect(24, 35, 18, 15, 'B');
  pixels.rect(24, 36, 18, 2, 'C');
  pixels.rect(29, 34, 9, 20, 'J');
  pixels.rect(30, 36, 7, 18, 'j');
  pixels.line(32, 36, 32, 53, 'J');
  pixels.line(35, 36, 35, 53, 'J');
  pixels.put(36, 45, 'Y');
  for (let x = 23; x <= 43; x++) {
    pixels.put(x, 30, 'R');
    pixels.put(x, 31, ironRib(x));
    pixels.put(x, 32, ironRib(x));
    pixels.put(x, 33, 'T');
  }
  pixels.rect(24, 34, 18, 1, 'j');
  pixels.rect(24, 35, 18, 1, 'J');
  pixels.rect(43, 30, 1, 4, 'k');
  pixels.rect(22, 54, 23, 2, 'A');
  pixels.rect(30, 54, 15, 2, 'B');
  pixels.rect(22, 56, 23, 1, 'C');
  pixels.rect(22, 57, 23, 1, 'k');
  for (const x of [24, 40]) {
    pixels.rect(x, 34, 2, 22, 'j');
    pixels.rect(x + 1, 34, 1, 22, 'J');
  }
  // Front roof slope, foreshortened; ribs run down the slope and lean with it.
  for (let y = ridge + 1; y <= eave; y++) {
    const s = shear(y);
    for (let x = 4 + s; x <= 47 + s; x++) pixels.put(x, y, ironRib(x - s));
    pixels.put(4 + s, y, 'T');
  }
  // Nail line where the upper sheet laps the lower one, and rust running down from nails.
  const lap = ridge + 7;
  for (let x = 4 + shear(lap); x <= 47 + shear(lap); x++) {
    if ((x - shear(lap)) % 4 === 2) pixels.put(x, lap, 'k');
  }
  for (const [x, y, length] of [[13, 19, 4], [26, 15, 3], [37, 20, 5], [20, 22, 3], [44, 16, 3]]) {
    for (let i = 0; i < length; i++) pixels.put(x + shear(y + i) - shear(y), y + i, i ? 'C' : 'D');
  }
  pixels.rect(4, eave, 44, 1, 'T');
  pixels.rect(4, eave + 1, 44, 1, 'k');
  // Ridge cap: a rolled sheet catching the light, with its shadow on the slope below.
  pixels.rect(4 + lean, ridge - 1, 44, 1, 'c');
  pixels.rect(4 + lean, ridge, 44, 1, 'T');
  pixels.rect(4 + lean, ridge + 1, 44, 1, 'k');
  pixels.put(48 + lean, ridge - 1, 'k');
  return sprite({id: lit ? 'structure.farmhouse.gable-tin.lit' : 'structure.farmhouse.gable-tin',
    size: pixels.size, anchor: [32, 58], rows: pixels.rows(), emissive: lit ? [[12, 35]] : undefined});
}

function acacia(): Sprite {
  const pixels = new Pixels([64, 48]);
  pixels.line(30, 42, 22, 17, 'J');
  pixels.line(34, 42, 32, 20, 'J');
  pixels.line(31, 42, 27, 19, 'j');
  pixels.line(33, 41, 35, 26, 'j');
  pixels.line(36, 28, 51, 14, 'J');
  pixels.line(30, 34, 12, 20, 'J');
  pixels.line(29, 30, 12, 18, 'j');
  pixels.line(32, 30, 39, 16, 'j');
  pixels.line(32, 40, 27, 44, 'J');
  pixels.line(34, 40, 41, 44, 'J');
  const crown = [
    [11, 19, 10, 4], [19, 14, 14, 6], [29, 11, 14, 6],
    [37, 12, 13, 6], [49, 15, 13, 6], [55, 20, 7, 4],
    [9, 11, 8, 3], [45, 21, 10, 4], [24, 22, 8, 3],
  ];
  for (const [x, y, rx, ry] of crown) pixels.ellipse(x, y, rx, ry, 'n');
  // The crown is foliage green, not the near-grey P of stressed leaves and rocks: the dawn
  // and dusk grade gives mid-dark albedo the cool shade colour, and a near-grey takes that
  // colour over and goes slate while saturated greens keep their hue.
  for (const [x, y, rx, ry] of crown) {
    pixels.ellipse(x - 1, y - 1, rx - 1, ry - 1, 'N');
    pixels.line(x - (rx >> 1), y - ry + 1, x + 1, y - ry + 1, 'O');
    pixels.put(x - 1, y - ry + 2, 'M');
    pixels.put(x + (rx >> 1), y + 1, 'n');
  }
  pixels.put(4, 12, '.');
  pixels.put(52, 20, '.');
  return sprite({id: 'nature.acacia', size: pixels.size, anchor: [33, 43], rows: pixels.rows()});
}

const rocks = [
  ['...QQQ..', '..QTTQR.', '.QQQRQk.', '.PRQQk..', '..kkkk..'],
  ['....Q......', '...TQRR....', '..QQQQk.Q..', '..PQQk.QRR.', '...kkk.QPk.', '........k..'],
].map((rows, index) => {
  const pixels = new Pixels([16, 16]);
  pixels.stamp(3, 7, rows);
  return sprite({id: `nature.rock.${index}`, size: pixels.size, anchor: [8, 12], rows: pixels.rows()});
});

function nursery(): Sprite {
  const pixels = new Pixels([32, 16]);
  pixels.stamp(2, 4, [
    '..jjjjjjjjjjjjjjjjjjjjjjjj..',
    '.jJJJJJJJJJJJJJJJJJJJJJJJJj.',
    'jJJJJJJJJJJJJJJJJJJJJJJJJJJj',
    'jJJJJJJJJJJJJJJJJJJJJJJJJJJj',
    'jJJJJJJJJJJJJJJJJJJJJJJJJJJj',
    'jJJJJJJJJJJJJJJJJJJJJJJJJJJj',
    'jJJJJJJJJJJJJJJJJJJJJJJJJJJj',
    'jjjjjjjjjjjjjjjjjjjjjjjjjjjj',
    '.DDDDDDDDDDDDDDDDDDDDDDDDDD.',
  ]);
  for (let x = 6; x < 29; x += 4) {
    for (const y of [6, 10]) {
      pixels.stamp(x - 1, y - 2, y === 6 ? ['.L.', '.MN', 'CMn'] : ['LM.', '.NM', 'CN.']);
    }
  }
  return sprite({id: 'structure.nursery-tray', size: pixels.size, anchor: [16, 12], rows: pixels.rows()});
}

// A corner peg of a bed marked out for digging: a split stake with a pale cut top and the
// twine knotted round it four pixels up. The view runs the twine from peg to peg.
const bedPeg = sprite({
  id: 'structure.bed-peg', size: [3, 7], anchor: [1, 6], rows: [
    '.Hj',
    '.jJ',
    'GGJ',
    '.jJ',
    '.jJ',
    '.jJ',
    'DDk',
  ],
});
const bedTwine = sprite({id: 'structure.bed-twine', size: [1, 1], rows: ['G']});

export const structureSprites = [
  farmhouse(false), farmhouse(true),
  ...[roundThatchFarmhouse, hippedThatchFarmhouse, gableTinFarmhouse].flatMap(house => [house(false), house(true)]),
  acacia(), ...rocks, nursery(), bedPeg, bedTwine,
];

// A cream housing with a teal cap, ringed in the dark outline, so the T1 device stands out
// among the green and red of a grown bed at 1x. The LED sits at (7, 5).
const probe = sprite({
  id: 'device.soil-probe.idle', size: [16, 16], anchor: [8, 13], rows: [
    '....k...........',
    '....R...........',
    '...kkkkkkkk.....',
    '...kggggggk.....',
    '...kcccccck.....',
    '...kcccgcck.....',
    '...kcccccck.....',
    '...kcccccck.....',
    '...kkkkkkkk.....',
    '......Rk........',
    '......Rk........',
    '......Rk........',
    '....BCRkD.......',
    '..BCCDkDDD......',
    '...DDDDDD.......',
    '................',
  ],
});
const probeLed = derive(probe, {id: 'device.soil-probe.led', overlay: [{at: [7, 5], rows: ['F']}]});

// An open collecting funnel above a graduated tube on a short stand.
const rainGauge = sprite({
  id: 'device.rain-gauge', size: [16, 16], anchor: [8, 14], rows: [
    '.....TTTTTT.....',
    '...TcRRRRRRTk...',
    '...Tggggggggk...',
    '....TcccccRk....',
    '.....TcccRk.....',
    '......TcRk......',
    '......ccTk......',
    '......cgTk......',
    '......ccTk......',
    '......cgTk......',
    '......ccTk......',
    '......TRRk......',
    '.......Rk.......',
    '......TRRk......',
    '.....TRRRRk.....',
    '................',
  ],
});

// A dial and needle on the elbow where the tank outlet turns up the header.
const flowMeter = sprite({
  id: 'device.flow-meter', size: [16, 16], anchor: [8, 10], rows: [
    '.......TRk......',
    '.......TRk......',
    '.....TggggR.....',
    '....TccccccR....',
    '...Tcccccgcck...',
    '...Tccccgccck...',
    '...Tcccgcccck...',
    '....Tcccccck....',
    '.....Tggggk.....',
    '...TTRTRRk......',
    '.RRRTRTRRk......',
    '.kkkRTRkkk......',
    '....kk..........',
    '................',
    '................',
    '................',
  ],
});

function valve(position: string, tip: Point): Sprite {
  const pixels = new Pixels([16, 16]);
  pixels.stamp(0, 4, [
    '....TTTTTTTT....',
    '...TccccccccR...',
    '...TccccccccR...',
    '...Tcccccccck...',
    'TRRTRRRRRRRRkRRT',
    'RRRRkkkkkkkkRRRR',
    'kkkkk......kkkkk',
    '....k......k....',
  ]);
  pixels.line(8, 7, ...tip, 'n');
  pixels.stamp(tip[0] - 1, tip[1] - 1, ['.g.', 'ggn', '.n.']);
  if (position === 'open') pixels.put(13, 8, 'u');
  return sprite({id: `device.valve-box.${position}`, size: pixels.size, anchor: [8, 12], rows: pixels.rows()});
}

function gateway(led: boolean): Sprite {
  const pixels = new Pixels([16, 48]);
  pixels.rect(7, 15, 3, 29, 'J');
  pixels.rect(7, 15, 1, 29, 'j');
  pixels.line(8, 8, 8, 2, 'R');
  pixels.put(8, 2, 'k');
  pixels.stamp(1, 8, [
    '..TTTTTTTTTTT.',
    '..TiizzTiizzR.',
    '.TiizzTiizzR..',
    '.TTRRRTRTRRR..',
    'TiizzRiizzR...',
    'TiizzRiizzR...',
    'RRRRRRRRRR....',
  ]);
  pixels.stamp(5, 19, ['.TTTTT.', 'TcccccR', 'TcccccR', 'TccgccR', 'RRRRRkk']);
  if (led) pixels.put(8, 22, 'F');
  return sprite({id: `device.gateway.${led ? 'led' : 'idle'}`, size: pixels.size, anchor: [8, 43],
    rows: pixels.rows(), emissive: led ? [[8, 22]] : undefined});
}

export const deviceSprites = [
  probe, sprite({...probeLed, emissive: [[7, 5]]}),
  valve('closed', [8, 3]), valve('opening', [10, 4]), valve('open', [12, 7]),
  gateway(false), gateway(true), rainGauge, flowMeter,
];

const effects = {
  // Streaks slant one pixel west for every three they fall, as the particles drift.
  'effect.rain.0': ['.X', '.u', '.u', 'u.', 'u.', 'v.'],
  'effect.rain.1': ['..X', '..u', '..u', '.u.', '.u.', '.v.', 'u..', 'v..', 'v..'],
  'effect.rain.2': ['.X', '.u', 'u.', 'v.'],
  // A drop lands, throws up a small crown and leaves a dark wet ring.
  'effect.splash.0': ['.....', '..X..', '.uWu.'],
  'effect.splash.1': ['.X.X.', 'u...u', '.vWv.'],
  'effect.splash.2': ['X...X', '.....', 'v.W.v'],
  'effect.splash.3': ['.....', '.....', '.W.W.'],
  'effect.drip.0': ['X', '.'],
  'effect.drip.1': ['u', 'X'],
  'effect.drip.2': ['.', 'v'],
  'effect.dust.0': ['.A..', 'AB..', '.A..'],
  'effect.dust.1': ['..AA..', '.ABBA.', 'AAB.A.'],
  'effect.sheen.0': ['X'],
  'effect.sheen.1': ['uX'],
  'effect.sheen.2': ['.X', 'u.'],
};

export const effectSprites = Object.entries(effects).map(([id, rows]) =>
  sprite({id, size: [rows[0].length, rows.length], rows}));
