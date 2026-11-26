import {Assets, BufferImageSource, Rectangle, Texture} from 'pixi.js';
import type {bakeAtlas} from '../../scripts/bake-atlas';

type AtlasMetadata = ReturnType<typeof bakeAtlas>['atlas'];
type Region = readonly [number, number, number, number];

export class FarmAtlas {
  private readonly textures = new Map<string, Texture>();

  constructor(readonly data: AtlasMetadata, private readonly page: Texture) {}

  frame(id: string) {
    const info = this.data.frames[id];
    if (!info) throw new Error('Missing farm atlas frame: ' + id);
    return info;
  }

  texture(id: string, region?: Region) {
    const key = region ? id + ':' + region.join(',') : id;
    let texture = this.textures.get(key);
    if (!texture) {
      const {x, y, width, height} = this.frame(id);
      const [left, top, w, h] = region ?? [0, 0, width, height];
      texture = new Texture({source: this.page.source, frame: new Rectangle(x + left, y + top, w, h)});
      this.textures.set(key, texture);
    }
    return texture;
  }

  destroy() {
    for (const texture of this.textures.values()) texture.destroy();
    this.textures.clear();
  }
}

export async function loadFarmAtlas(base: URL) {
  await Assets.init({preferences: {preferWorkers: false}});
  const response = await fetch(new URL('atlas.json', base));
  if (!response.ok) throw new Error('Farm atlas unavailable (' + response.status + ')');
  const data: AtlasMetadata = await response.json();
  if (data.version !== 1 || data.format !== 'rgba8') throw new Error('Unsupported farm atlas format');
  const page = await Assets.load<Texture>({
    src: new URL(data.image, base).href,
    data: {scaleMode: 'nearest'},
  });
  page.source.scaleMode = 'nearest';
  return new FarmAtlas(data, page);
}

/** Stepped light and shadow masks on the same pixel grid as the art. */
export function diskTexture(width: number, height: number, rings: readonly number[]) {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const distance = Math.hypot((2 * x + 1) / width - 1, (2 * y + 1) / height - 1);
      const value = rings[Math.floor(distance * rings.length)] ?? 0;
      data.fill(value, (y * width + x) * 4, (y * width + x + 1) * 4);
    }
  }
  return new Texture({source: new BufferImageSource({
    resource: data, width, height, alphaMode: 'premultiplied-alpha', scaleMode: 'nearest',
  })});
}
