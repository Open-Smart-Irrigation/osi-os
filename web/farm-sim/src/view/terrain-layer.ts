import {Container, RenderTexture, Sprite, type WebGLRenderer} from 'pixi.js';
import {TILE_SIZE} from './camera';
import {CHUNK_SIZE, chunkInputs, crackFrame, sameTerrain, terrainFrames, tileAt} from './terrain';
import type {FarmAtlas} from './atlas';
import type {ViewModel} from './view-model';

const HALF = TILE_SIZE / 2;
const QUADRANTS = [[0, 0], [HALF, 0], [HALF, HALF], [0, HALF]] as const;
type MapView = ViewModel['map'];

function tileSprite(atlas: FarmAtlas, id: string, x: number, y: number, quadrant?: typeof QUADRANTS[number]) {
  const texture = atlas.texture(id, quadrant && [...quadrant, HALF, HALF]);
  return new Sprite({texture, x, y});
}

export class TerrainChunk {
  readonly target: RenderTexture;
  readonly sprite: Sprite;
  private inputs: ReturnType<typeof chunkInputs> | undefined;
  private wetting = 0;

  constructor(readonly left: number, readonly top: number, readonly columns: number, readonly rows: number) {
    this.target = RenderTexture.create({
      width: columns * TILE_SIZE, height: rows * TILE_SIZE, resolution: 1, scaleMode: 'nearest',
    });
    this.sprite = new Sprite({texture: this.target, x: left * TILE_SIZE, y: top * TILE_SIZE});
  }

  sync(map: MapView, atlas: FarmAtlas, renderer: WebGLRenderer, wetting: number) {
    const inputs = chunkInputs(map, this.left, this.top);
    if (this.wetting === wetting && this.inputs?.every((previous, i) => sameTerrain(previous, inputs[i]))) return;
    this.rebake(map, atlas, renderer, wetting);
    this.inputs = inputs;
    this.wetting = wetting;
  }

  rebake(map: MapView, atlas: FarmAtlas, renderer: WebGLRenderer, wetting: number) {
    const layer = new Container();
    for (let y = -1; y < this.rows; y++) {
      for (let x = -1; x < this.columns; x++) {
        const frames = terrainFrames(map, this.left + x, this.top + y, wetting);
        const px = x * TILE_SIZE + HALF;
        const py = y * TILE_SIZE + HALF;
        if (frames.every(frame => frame === frames[0])) {
          layer.addChild(tileSprite(atlas, frames[0], px, py));
        } else {
          QUADRANTS.forEach(([dx, dy], i) =>
            layer.addChild(tileSprite(atlas, frames[i], px + dx, py + dy, QUADRANTS[i])));
        }
      }
    }
    for (let y = 0; y < this.rows; y++) {
      for (let x = 0; x < this.columns; x++) {
        const tile = tileAt(map, this.left + x, this.top + y);
        if (!tile) continue;
        const cracks = crackFrame(tile, wetting);
        if (cracks) layer.addChild(tileSprite(atlas, cracks, x * TILE_SIZE, y * TILE_SIZE));
      }
    }
    renderer.render({container: layer, target: this.target, clear: true});
    layer.destroy({children: true});
  }

  invalidate() {
    this.inputs = undefined;
  }

  destroy() {
    this.sprite.destroy();
    this.target.destroy(true);
  }
}

export class TerrainLayer {
  readonly container = new Container();
  private chunks: TerrainChunk[] = [];
  private previous: MapView | undefined;
  private wetting = 0;

  constructor(private readonly atlas: FarmAtlas, private readonly renderer: WebGLRenderer) {}

  /** `wetting` shifts the soil bands while rain falls; `tint` darkens the whole ground with it. */
  sync(map: MapView, wetting = 0, tint = 0xffffff) {
    for (const chunk of this.chunks) chunk.sprite.tint = tint;
    if (this.previous?.tiles === map.tiles && this.wetting === wetting) return;
    if (this.previous?.width !== map.width || this.previous?.height !== map.height) {
      this.clear();
      for (let y = 0; y < map.height; y += CHUNK_SIZE) {
        for (let x = 0; x < map.width; x += CHUNK_SIZE) {
          const chunk = new TerrainChunk(x, y, Math.min(CHUNK_SIZE, map.width - x), Math.min(CHUNK_SIZE, map.height - y));
          this.chunks.push(chunk);
          this.container.addChild(chunk.sprite);
        }
      }
    }
    for (const chunk of this.chunks) {
      chunk.sync(map, this.atlas, this.renderer, wetting);
      chunk.sprite.tint = tint;
    }
    this.previous = map;
    this.wetting = wetting;
  }

  invalidate() {
    for (const chunk of this.chunks) chunk.invalidate();
    this.previous = undefined;
  }

  clear() {
    for (const chunk of this.chunks) chunk.destroy();
    this.chunks = [];
  }
}
