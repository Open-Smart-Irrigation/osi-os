import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {inflateSync} from 'node:zlib';
import {isPaletteKey, palette} from '../art/palette';
import {dripRows} from '../art/sprites/world';
import {gradePixel, lightingAt} from '../src/view/lighting';
import {type bakeAtlas, type Bitmap, encodePng, generatedDirectory, spriteFamilies} from './bake-atlas';

type Atlas = ReturnType<typeof bakeAtlas>['atlas'];
type Font = ReturnType<typeof bakeAtlas>['font'];
type Frame = Atlas['frames'][string];

async function loadBitmap(image: string): Promise<Bitmap> {
  return decodeBakedBitmap(await readFile(new URL(image, generatedDirectory)), image);
}

export function decodeBakedBitmap(png: Buffer, image: string): Bitmap {
  // The bake writes one IDAT chunk with unfiltered RGBA8 scanlines.
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  if (png.toString('ascii', 37, 41) !== 'IDAT' || png[24] !== 8 || png[25] !== 6) {
    throw new Error(`unexpected baked PNG layout: ${image}`);
  }
  const scanlines = inflateSync(png.subarray(41, 41 + png.readUInt32BE(33)));
  const stride = width * 4;
  const rgba = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const start = y * (stride + 1);
    if (scanlines[start] !== 0) throw new Error(`unexpected PNG filter: ${image}`);
    scanlines.copy(rgba, y * stride, start + 1, start + 1 + stride);
  }
  return {width, height, rgba};
}

function board(width: number, height: number, css: string): Bitmap {
  return {width, height, rgba: Buffer.alloc(width * height * 4, Buffer.from(css.slice(1) + 'ff', 'hex'))};
}

function paint(target: Bitmap, source: Bitmap, frame: Frame, x: number, y: number) {
  for (let sy = 0; sy < frame.height; sy++) {
    for (let sx = 0; sx < frame.width; sx++) {
      const dx = x + sx;
      const dy = y + sy;
      if (dx < 0 || dx >= target.width || dy < 0 || dy >= target.height) continue;
      const src = ((frame.y + sy) * source.width + frame.x + sx) * 4;
      if (!source.rgba[src + 3]) continue;
      source.rgba.copy(target.rgba, (dy * target.width + dx) * 4, src, src + 4);
    }
  }
}

function scaleFour(source: Bitmap): Bitmap {
  const width = source.width * 4;
  const height = source.height * 4;
  const rgba = Buffer.alloc(width * height * 4);
  for (let y = 0; y < source.height; y++) {
    const row = y * width * 16;
    for (let x = 0; x < source.width; x++) {
      const pixel = source.rgba.readUInt32LE((y * source.width + x) * 4);
      for (let dx = 0; dx < 4; dx++) rgba.writeUInt32LE(pixel, row + (x * 4 + dx) * 4);
    }
    for (let dy = 1; dy < 4; dy++) rgba.copy(rgba, row + dy * width * 4, row, row + width * 4);
  }
  return {width, height, rgba};
}

function contactSheet(atlas: Atlas, image: Bitmap, font: Font, glyphs: Bitmap): Bitmap {
  const width = 816;
  let y = 14;
  const labels: {text: string; y: number}[] = [];
  const stamps: {source: Bitmap; frame: Frame; x: number; y: number}[] = [];
  function group(title: string, source: Bitmap, frames: readonly Frame[]) {
    labels.push({text: title, y});
    y += 15;
    let x = 12;
    let rowHeight = 0;
    for (const frame of frames) {
      if (x + frame.width + 12 > width) {
        x = 12;
        y += rowHeight + 4;
        rowHeight = 0;
      }
      stamps.push({source, frame, x, y});
      x += frame.width + 4;
      rowHeight = Math.max(rowHeight, frame.height);
    }
    y += rowHeight + 12;
  }
  for (const [family, sprites] of Object.entries(spriteFamilies)) {
    // The shadow masks would be cream on the cream sheet; the browser frames show them in use.
    if (family === 'shadows') continue;
    group(family.toUpperCase(), image, sprites.map(({id}) => atlas.frames[id]));
  }
  for (const face of ['body', 'heading']) {
    group(`FONT - ${face.toUpperCase()}`, glyphs, Object.entries(font.frames)
      .filter(([id]) => id.startsWith(`font.${face}.`))
      .sort(([a], [b]) => Number(a.split('.')[2]) - Number(b.split('.')[2]))
      .map(([, frame]) => frame));
  }
  const sheet = board(width, y, palette.c);
  for (const label of labels) {
    Array.from(label.text).forEach((character, i) => {
      paint(sheet, glyphs, font.frames[`font.heading.${character.codePointAt(0)}`], 12 + i * 7, label.y);
    });
  }
  for (const stamp of stamps) paint(sheet, stamp.source, stamp.frame, stamp.x, stamp.y);
  return scaleFour(sheet);
}

export function sampleScene(atlas: Atlas, image: Bitmap): Bitmap {
  const scene = board(480, 270, palette.B);
  const tile = (id: string, x: number, y: number) => paint(scene, image, atlas.frames[id], x, y);
  const actors: {id: string; x: number; y: number; shadow: number}[] = [];
  const actor = (id: string, x: number, y: number, shadow = 0) => actors.push({id, x, y, shadow});
  const rectangle = (x: number, y: number, left: number, top: number, right: number, bottom: number) =>
    x >= left && x <= right && y >= top && y <= bottom;
  const mainBed = (x: number, y: number) => rectangle(x, y, 9, 6, 17, 12);
  const spareBed = (x: number, y: number) => rectangle(x, y, 22, 7, 25, 10);
  // Behind the house the clearing rises in steps of at least two columns, so its top edge
  // is a low dome; a single raised column draws a point that reads as a gable over the roof.
  const yardTop = [3, 3, 2, 1, 1, 1, 1, 2, 2, 2];
  const grass = (x: number, y: number) => y < (yardTop[x] ?? 2 + Math.floor((x * 7 % 9) / 3))
    || y > 13 + x % 3 || x < 2 && y > 9 || x > 26 && y < 8 || (x > 21 && y < 4);
  const path = (x: number, y: number) => rectangle(x, y, 19, 3, 20, 16)
    || rectangle(x, y, 2, 13, 19, 14) || rectangle(x, y, 20, 11, 29, 12)
    || rectangle(x, y, 4, 4, 19, 4) || rectangle(x, y, 4, 4, 5, 12);
  const cornerMask = (x: number, y: number, ground: (x: number, y: number) => boolean) =>
    Number(ground(x - 1, y - 1)) + 2 * Number(ground(x, y - 1))
    + 4 * Number(ground(x, y)) + 8 * Number(ground(x - 1, y));
  for (let y = 0; y <= 17; y++) {
    for (let x = 0; x <= 30; x++) {
      const left = x * 16 - 8;
      const top = y * 16 - 8;
      const tilled = cornerMask(x, y, mainBed);
      const dryBed = cornerMask(x, y, spareBed);
      const trail = cornerMask(x, y, path);
      const straw = cornerMask(x, y, grass);
      if (tilled) tile(`terrain.tilled.${y < 8 ? 'moist' : 'wet'}.${tilled}`, left, top);
      else if (dryBed) tile(`terrain.tilled.dry.${dryBed}`, left, top);
      else if (trail) tile(`terrain.path.${trail}`, left, top);
      else if (straw) tile(`terrain.grass.${straw}`, left, top);
      else tile(`terrain.laterite.${(x * 5 + y * 3 + x * y) % 8}`, left, top);
      if (!tilled && !trail && !dryBed && !straw && (x * 3 + y * 7) % 17 === 2) {
        tile(`terrain.crack.${(x + y) % 4}`, left, top);
      }
      if (straw === 15 && (x * 7 + y * 11 + x * y) % 13 < 4) {
        actor(`nature.tuft.${(x + y) % 2}`, left + 6 + y % 5, top + 10 + x % 4);
      }
    }
  }

  const [n, e, s, w] = [1, 2, 4, 8];
  const pipe = (x: number, y: number, mask: number) => {
    for (const [dy, row] of dripRows(mask, true).entries()) {
      for (let dx = 0; dx < row.length; dx++) {
        const ink = row[dx];
        if (isPaletteKey(ink)) {
          const offset = ((y * 16 + dy) * scene.width + x * 16 + dx) * 4;
          scene.rgba.writeUInt32BE(Number.parseInt(palette[ink].slice(1) + 'ff', 16), offset);
        }
      }
    }
  };
  pipe(9, 7, e | s | w);
  pipe(9, 9, n | e | s);
  pipe(9, 11, n | e);
  for (const y of [7, 9, 11]) {
    for (let x = 10; x < 17; x++) pipe(x, y, e | w);
    pipe(17, y, w);
  }
  for (const y of [8, 10]) pipe(9, y, n | s);
  for (let x = 6; x < 9; x++) pipe(x, 7, e | w);

  // The spare bed is marked out with corner pegs and twine four pixels up, as the view
  // draws it from the map's bed tiles; the long runs sag a pixel over their middle half.
  const [west, east, north, south] = [22 * 16 - 1, 26 * 16, 7 * 16, 11 * 16];
  const twine = (x: number, y: number) => tile('structure.bed-twine', x, y);
  const quarter = Math.round((east - west) / 4);
  for (const y of [north - 4, south - 4]) {
    for (let x = west + 1; x < east; x++) twine(x, x >= west + quarter && x < east - quarter ? y + 1 : y);
  }
  for (let y = north - 3; y < south - 4; y++) {
    twine(west, y);
    twine(east, y);
  }
  for (const x of [west, east]) for (const y of [north, south]) actor('structure.bed-peg', x, y);

  const stages = ['transplant', 'vegetative', 'flowering', 'green-fruit', 'ripe-fruit'];
  for (const y of [7, 9, 11]) {
    for (let x = 10; x <= 17; x++) {
      const stage = stages[Math.min(4, Math.floor((x - 10) * 5 / 8))];
      const state = y === 7 && x > 14 ? 'rolling' : 'turgid';
      actor(`crop.tomato.${stage}.${state}.${(x + y) % 3}`, x * 16 + 8, y * 16 + 12, stage === 'transplant' ? 3 : 6);
    }
  }
  for (const x of [22, 23, 24]) {
    for (const y of [8, 9]) actor('crop.tomato.transplant.rolling.0', x * 16 + 8, y * 16 + 8, 3);
  }
  // The straight run cycles its clump layouts, as the view does per tile.
  for (let x = 8; x <= 17; x++) {
    actor(`nature.hedge.${x === 8 ? 4 : x === 17 ? 64 : ['68', '68.1', '68.2'][x * 7 % 3]}`, x * 16 + 8, 83);
  }
  actor('structure.farmhouse', 70, 79, 27);
  actor('nature.acacia', 399, 80, 24);
  actor('nature.acacia', 33, 247, 21);
  actor('water.well.hand-dug', 43, 134, 15);
  actor('water.hand-pump', 52, 128, 6);
  actor('water.tank.2', 87, 142, 16);
  actor('water.well.shared.1', 437, 187, 15);
  actor('structure.nursery-tray', 368, 112, 15);
  actor('device.valve-box.open', 114, 123, 8);
  actor('device.soil-probe.idle', 242, 142, 6);
  actor('device.gateway.idle', 128, 115, 6);
  actor('player.left.carry.0', 309, 171, 8);
  actor('nature.rock.0', 323, 224, 4);
  actor('nature.rock.1', 420, 222, 4);
  actor('nature.rock.0', 36, 156, 4);
  actor('nature.rock.1', 100, 109, 4);
  actor('nature.tuft.2', 394, 122);

  for (const {x, y, shadow} of actors) {
    if (!shadow) continue;
    const radiusY = Math.ceil(shadow / 3);
    for (let dy = -radiusY; dy <= radiusY; dy++) {
      for (let dx = -shadow; dx <= shadow; dx++) {
        if ((dx / shadow) ** 2 + (dy / radiusY) ** 2 > 1) continue;
        const px = x + dx + 3;
        const py = y + dy + 1;
        if (px < 0 || px >= scene.width || py < 0 || py >= scene.height) continue;
        const offset = (py * scene.width + px) * 4;
        for (let channel = 0; channel < 3; channel++) scene.rgba[offset + channel] = Math.round(scene.rgba[offset + channel] * 0.78);
      }
    }
  }
  for (const {id, x, y} of actors.sort((a, b) => a.y - b.y)) {
    const [ax, ay] = atlas.frames[id].anchor;
    tile(id, x - ax, y - ay);
  }
  return scene;
}

/** The sample scene under the grade of one hour, through the CPU copy of the composite; no cast shadows. */
function graded(scene: Bitmap, hour: number): Bitmap {
  const light = lightingAt({hour, sunriseHour: 6, sunsetHour: 18, date: '2027-01-11', day: 1, season: 'Hot Dry',
    raining: false, rainMmPerHour: 0});
  const rgba = Buffer.from(scene.rgba);
  for (let i = 0; i < rgba.length; i += 4) rgba.set(gradePixel([rgba[i], rgba[i + 1], rgba[i + 2]], light), i);
  return {width: scene.width, height: scene.height, rgba};
}

async function main() {
  const output = process.argv[2];
  if (!output) throw new Error('usage: render-art-review.ts <output-directory>');
  const out = resolve(output);
  const atlas = JSON.parse(await readFile(new URL('atlas.json', generatedDirectory), 'utf8')) as Atlas;
  const font = JSON.parse(await readFile(new URL('font.json', generatedDirectory), 'utf8')) as Font;
  const [image, glyphs] = await Promise.all([loadBitmap(atlas.image), loadBitmap(font.image)]);
  await mkdir(out, {recursive: true});
  const scene = sampleScene(atlas, image);
  for (const [file, bitmap] of [
    ['contact-sheet.png', contactSheet(atlas, image, font, glyphs)],
    ['sample-scene.png', scene],
    ['sample-scene-dawn.png', graded(scene, 6.5)],
    ['sample-scene-dusk.png', graded(scene, 17.5)],
  ] as const) {
    await writeFile(join(out, file), encodePng(bitmap));
    console.log(`${join(out, file)} (${bitmap.width} x ${bitmap.height})`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
