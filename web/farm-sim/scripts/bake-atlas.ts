import {createHash} from 'node:crypto';
import {mkdir, readdir, unlink, writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {deflateSync} from 'node:zlib';
import {type Sprite, validateSprite} from '../art/core';
import {fontFaces, fontSprites} from '../art/font';
import {cropSprites, swayFrames, tomatoStages, tomatoStates} from '../art/generators/crops';
import {hedgeNeighbors, hedgeTileForMask, hedgeTiles, terrainCorners, terrainSprites, tufts, wetnessBands} from '../art/generators/terrain';
import {palette, type PaletteKey} from '../art/palette';
import {playerClips, playerDirections, playerSprites} from '../art/sprites/player';
import {shadowSprites} from '../art/sprites/shadows';
import {iconSprites, uiSprites} from '../art/sprites/ui';
import {deviceSprites, dripShapes, effectSprites, structureSprites, waterSprites} from '../art/sprites/world';

export const generatedDirectory = new URL('../public/generated/', import.meta.url);

export const spriteFamilies = {
  terrain: terrainSprites,
  water: waterSprites,
  structures: [...structureSprites, ...hedgeTiles, ...tufts],
  crop: cropSprites,
  devices: deviceSprites,
  player: playerSprites,
  icons: iconSprites,
  ui: uiSprites,
  effects: effectSprites,
  shadows: shadowSprites,
};

export interface Bitmap {
  width: number;
  height: number;
  rgba: Buffer;
}

function chunk(type: string, data: Buffer): Buffer {
  const name = Buffer.from(type, 'ascii');
  let crc = -1;
  for (const bytes of [name, data]) {
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE((~crc) >>> 0);
  return Buffer.concat([length, name, data, checksum]);
}

export function encodePng({width, height, rgba}: Bitmap): Buffer {
  const stride = width * 4;
  const scanlines = Buffer.alloc(height * (stride + 1));
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6; // RGBA8
  for (let row = 0; row < height; row++) {
    rgba.copy(scanlines, row * (stride + 1) + 1, row * stride, (row + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(scanlines, {level: 9})),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const colors = Object.fromEntries(Object.entries(palette).map(([key, css]) =>
  [key, Buffer.from(css.slice(1) + 'ff', 'hex')])) as Record<PaletteKey, Buffer>;

interface Frame {
  x: number;
  y: number;
  width: number;
  height: number;
  anchor: Sprite['anchor'];
  emissive?: Sprite['emissive'];
  slice?: Sprite['slice'];
}

function pack(sprites: readonly Sprite[], width: number, height: number) {
  const rgba = Buffer.alloc(width * height * 4);
  const frames = new Map<string, Frame>();
  // One transparent pixel around each frame, including the outer page border.
  let x = 1;
  let y = 1;
  let shelfHeight = 0;
  const byHeight = [...sprites].sort((a, b) => b.size[1] - a.size[1] || b.size[0] - a.size[0]
    || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const sprite of byHeight) {
    validateSprite(sprite);
    if (frames.has(sprite.id)) throw new Error(`duplicate sprite id: ${sprite.id}`);
    const [w, h] = sprite.size;
    if (w + 2 > width) throw new Error(`frame ${sprite.id} is wider than the atlas`);
    if (x + w >= width) {
      x = 1;
      y += shelfHeight + 2;
      shelfHeight = 0;
    }
    if (y + h >= height) throw new Error(`atlas page is full at ${sprite.id}`);
    frames.set(sprite.id, {x, y, width: w, height: h, anchor: sprite.anchor, emissive: sprite.emissive, slice: sprite.slice});
    sprite.rows.forEach((row, dy) => {
      for (let dx = 0; dx < row.length; dx++) {
        if (row[dx] !== '.') colors[row[dx] as PaletteKey].copy(rgba, ((y + dy) * width + x + dx) * 4);
      }
    });
    x += w + 2;
    shelfHeight = Math.max(shelfHeight, h);
  }
  return {bitmap: {width, height, rgba}, frames: Object.fromEntries(frames)};
}

export function bakeAtlas() {
  const {bitmap, frames} = pack(Object.values(spriteFamilies).flat(), 2048, 2048);
  const png = encodePng(bitmap);
  // pack() emits frames in packing order, with sprite IDs breaking size ties.
  const layout = JSON.stringify({width: bitmap.width, height: bitmap.height, frames});
  const hash = createHash('sha256').update(layout).update(bitmap.rgba).digest('base64url');
  const atlas = {
    version: 1, format: 'rgba8', provenance: 'original',
    image: `atlas-${hash}.png`, width: bitmap.width, height: bitmap.height, hash, frames,
    autotiles: {terrainCorners, wetnessBands, hedgeNeighbors, hedgeTileForMask, dripShapes},
    clips: {
      player: Object.fromEntries(playerDirections.map(direction =>
        [direction, Object.fromEntries(Object.entries(playerClips).map(([clip, count]) =>
          [clip, Array.from({length: count}, (_, i) => `player.${direction}.${clip}.${i}`)] as const))] as const)),
      tomatoes: Object.fromEntries(tomatoStages.map(stage =>
        [stage, Object.fromEntries(tomatoStates.map(state =>
          [state, swayFrames.map(i => `crop.tomato.${stage}.${state}.${i}`)] as const))] as const)),
    },
  };

  const fontPage = pack(fontSprites(), 256, 256);
  const fontPng = encodePng(fontPage.bitmap);
  const font = {
    version: 1, provenance: 'original', image: 'font.png', width: fontPage.bitmap.width, height: fontPage.bitmap.height,
    faces: fontFaces, fallback: 63, frames: fontPage.frames,
  };
  return {atlas, png, font, fontPng};
}

async function main() {
  const {atlas, png, font, fontPng} = bakeAtlas();
  await mkdir(generatedDirectory, {recursive: true});
  await writeFile(new URL(atlas.image, generatedDirectory), png);
  await writeFile(new URL(font.image, generatedDirectory), fontPng);
  await writeFile(new URL('font.json', generatedDirectory), JSON.stringify(font) + '\n');
  await writeFile(new URL('atlas.json', generatedDirectory), JSON.stringify(atlas) + '\n');
  for (const file of await readdir(generatedDirectory)) {
    if (/^atlas-[\w-]{43}\.png$/.test(file) && file !== atlas.image) await unlink(new URL(file, generatedDirectory));
  }
  console.log(`Atlas ${atlas.width} x ${atlas.height}, ${Object.keys(atlas.frames).length} frames, ${png.length} bytes, layout and pixels SHA-256 ${atlas.hash}`);
  console.log(`Font ${font.width} x ${font.height}, ${Object.keys(font.frames).length} glyphs, ${fontPng.length} bytes`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
