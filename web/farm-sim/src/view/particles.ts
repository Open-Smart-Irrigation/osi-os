import {Container, Sprite} from 'pixi.js';
import type {FarmAtlas} from './atlas';
import {TILE_SIZE, tileFoot, type followCamera, type ViewSize} from './camera';
import {tileAt} from './terrain';
import type {ViewModel} from './view-model';

type Camera = ReturnType<typeof followCamera>;
type Point = {x: number; y: number};

function sample(index: number, salt: number) {
  // Avalanche the index and stream separately so X and Y do not march together.
  let value = index ^ Math.imul(salt, 0x9e3779b9);
  value = Math.imul(value ^ (value >>> 16), 0x85ebca6b);
  value = Math.imul(value ^ (value >>> 13), 0xc2b2ae35);
  return ((value ^ (value >>> 16)) >>> 0) / 0x100000000;
}

function wrap(value: number, size: number) {
  return ((value % size) + size) % size;
}

export class Particles {
  readonly container = new Container();
  private readonly pool: Sprite[] = [];
  private used = 0;

  constructor(private readonly atlas: FarmAtlas) {}

  private emit(id: string, x: number, y: number, alpha: number) {
    const sprite = this.pool[this.used++] ??= this.container.addChild(new Sprite());
    sprite.texture = this.atlas.texture('effect.' + id);
    sprite.position.set(Math.floor(x), Math.floor(y));
    sprite.alpha = alpha;
    sprite.visible = true;
  }

  sync(vm: ViewModel, camera: Camera, view: ViewSize, ms: number, limit: number, wetEmitters: readonly Point[]) {
    const previous = this.used;
    this.used = 0;
    const width = view.width + TILE_SIZE;
    const height = view.height + TILE_SIZE;
    if (vm.sky.raining) {
      // Streaks lean with the wind: they drift west as they fall, along their own slant.
      const intensity = Math.min(1, vm.sky.rainMmPerHour / 12);
      const count = Math.round(limit * (.50 + intensity * .30));
      const fall = .30 + intensity * .10;
      for (let i = 0; i < count; i++) {
        const drop = ms * fall + sample(i, 3227) * height;
        const x = camera.x + wrap(sample(i, 429) * width - drop * .34, width);
        const y = camera.y + wrap(drop, height);
        this.emit('rain.' + (i % 3), x, y, .55 + intensity * .30);
      }
      // Small crowns on the ground; each lives four frames at a new place.
      const splashes = Math.round(count / 4);
      for (let i = 0; i < splashes && this.used < limit; i++) {
        const frame = Math.floor(ms / 70 + sample(i, 18) * 12);
        const location = i + 79 * Math.floor(frame / 4);
        this.emit('splash.' + frame % 4, camera.x + sample(location, 884) * width,
          camera.y + sample(location, 483) * height, .8);
      }
    }

    for (let i = 0; i < wetEmitters.length && this.used < limit; i++) {
      const {x, y} = wetEmitters[i];
      if (x < camera.x - 4 || y < camera.y - 4 || x > camera.x + width || y > camera.y + height) continue;
      const phase = (Math.floor(ms / 90) + Math.floor(sample(i, 852) * 9)) % 9;
      if (phase < 3) this.emit('drip.' + phase, x, y + 1 + phase, .94);
    }

    const {at, activity} = vm.player;
    const ground = tileAt(vm.map, Math.floor(at.x), Math.floor(at.y));
    if (!vm.sky.raining && activity === 'walk' && ground && (ground.surfaceBand === 'very-dry'
      || ground.surfaceBand === 'dry' || (ground.surfaceBand === null && ground.terrain !== 'grass'))) {
      const foot = tileFoot(at);
      for (let i = 0; i < 5 && this.used < limit; i++) {
        const age = (ms + i * 87) % 440 / 440;
        const drift = (sample(i, 844) - .5) * 20;
        this.emit('dust.' + Number(age > .4), foot.x + drift * age, foot.y + 3 - age * 5, (1 - age) * .56);
      }
    }

    for (let i = this.used; i < previous; i++) this.pool[i].visible = false;
  }
}
