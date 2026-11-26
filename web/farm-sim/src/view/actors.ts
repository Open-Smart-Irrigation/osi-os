import {Container, Matrix, Sprite} from 'pixi.js';
import {palette} from '../../art/palette';
import {diskTexture, type FarmAtlas} from './atlas';
import {TILE_SIZE, tileFoot} from './camera';
import {type LightKind, type lightingAt, silhouetteFrame} from './lighting';
import {dripEmitters, hedgeMask, tileAt} from './terrain';
import type {ViewModel} from './view-model';

type Point = {x: number; y: number};
type Lighting = ReturnType<typeof lightingAt>;
type Tile = ViewModel['map']['tiles'][number];
type Light = Point & {strength: number; kind: LightKind};
type Pose = {sprite: Sprite; blob?: Sprite; silhouette?: Sprite};
type Prop = {feature: Tile['feature']; id: string; foot: Point; pose: Pose};

const DIRECTION = {north: 'up', south: 'down', east: 'right', west: 'left'} as const;
const PLAYER_FPS = {idle: 2, walk: 8, carry: 8, hoe: 12, pour: 10, pump: 10, harvest: 10};
const CASTERS: ReadonlySet<Tile['feature']> = new Set(['house', 'acacia', 'tank', 'well', 'shared-well', 'gateway']);
const PIPE_JOINT = [[-8, -8], [9, -8], [9, 9], [-8, 9]] as const;
// Plants stand a little north of their tile centre so the hose on the drip rows shows
// just in front of the plant bases instead of running through the stems.
const CROP_RISE = 3;
// The top row of a bed stands just south of its hose instead, so a grown canopy does not
// reach far over the bed's north edge; the hose then runs behind the stems.
const TOP_ROW_DROP = 7;
// Light from the lit farmhouse, in its emissive order (window, window, door gap, lantern):
// the glow at the opening and the light it throws on the ground as [kind, strength, px in
// front of the wall foot, px east of the opening]. The door pool stays about as wide as the
// door; each window throws only a small patch.
const HOUSE_LIGHTS: readonly {glow: LightKind; strength: number; pool?: readonly [LightKind, number, number, number]}[] = [
  {glow: 'window', strength: 1, pool: ['sill', .35, 3, 0]},
  {glow: 'window', strength: 1, pool: ['sill', .35, 3, 0]},
  {glow: 'door', strength: .9, pool: ['spill', .9, 2, -2]},
  {glow: 'lamp', strength: .7},
];
// Beds marked out with corner pegs and twine, and the twine's height on the pegs in px.
const MARKED_BEDS: ReadonlySet<Tile['bed']> = new Set(['B']);
const TWINE_HEIGHT = 4;
// A hose catches the sky by day; at night it takes the soil's value instead of glowing blue.
const HOSE_NIGHT = [.42, .46, .55] as const;

/** A fixed integer hash of a tile, mixed with the map's own per-tile variant. */
function tileHash(x: number, y: number, variant: number) {
  let h = Math.imul(x + 1, 0x9e3779b1) ^ Math.imul(y + 7, 0x85ebca6b) ^ Math.imul(variant + 3, 0xc2b2ae35);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  return (h ^ (h >>> 12)) >>> 0;
}

function tankFrame(water: ViewModel['water']) {
  const fraction = water.tankCapacityLiters > 0 ? water.tankLiters / water.tankCapacityLiters : 0;
  if (fraction <= 0) return 'water.tank.0';
  if (fraction >= 1) return 'water.tank.3';
  return fraction < .5 ? 'water.tank.1' : 'water.tank.2';
}

function turnMask(mask: number) {
  return ((mask << 1) | (mask >> 3)) & 15;
}

function pipeFrame(shapes: FarmAtlas['data']['autotiles']['dripShapes'], mask: number) {
  for (const [shape, initial] of Object.entries(shapes)) {
    let rotated: number = initial;
    for (let turns = 0; turns < 4; turns++, rotated = turnMask(rotated)) {
      if (mask === rotated) return {shape, turns};
    }
  }
  throw new Error('Unsupported farm drip connection mask: ' + mask);
}

export class Actors {
  readonly pipes = new Container();
  readonly shadows = new Container();
  readonly sprites = new Container({sortableChildren: true});
  readonly lights: Light[] = [];
  readonly wetEmitters: Point[] = [];
  private readonly blobTexture = diskTexture(12, 6, [255, 255, 192, 110]);
  private readonly wetTexture = diskTexture(10, 6, [255, 255, 255]);
  private readonly poseMatrix = new Matrix();
  private props: Prop[] = [];
  private readonly crops: Pose[] = [];
  private readonly fruit: Pose[] = [];
  private readonly pipeSprites: Sprite[] = [];
  private readonly spots: Sprite[] = [];
  private readonly sheens: Sprite[] = [];
  private readonly wetGround = new Container();
  private readonly twine = new Container();
  private readonly pegs: Pose[] = [];
  private readonly player: Pose;
  private playerActivity: ViewModel['player']['activity'] | undefined;
  private activityStart = 0;
  private lastMap: ViewModel['map'] | undefined;
  private lastDripMap: ViewModel['map'] | undefined;
  private pipeState: ViewModel['dripLine'] | undefined;

  constructor(private readonly atlas: FarmAtlas) {
    this.player = this.addPose(true, true);
    // Wet patches and their sheen lie on the soil, under the hose sprites, and so does
    // the twine round a marked-out bed.
    this.pipes.addChild(this.wetGround, this.twine);
  }

  private addPose(blob: boolean, silhouette = false): Pose {
    const pose: Pose = {sprite: this.sprites.addChild(new Sprite())};
    if (blob) pose.blob = this.shadows.addChild(new Sprite({
      texture: this.blobTexture, tint: palette.k, blendMode: 'multiply',
    }));
    if (silhouette) pose.silhouette = this.shadows.addChild(new Sprite({
      tint: palette.k, blendMode: 'multiply',
    }));
    return pose;
  }

  private place(pose: Pose, id: string, point: Point, light: Lighting, order = 0, mirror = false) {
    const {width, height, anchor} = this.atlas.frame(id);
    const {x, y} = point;
    const texture = this.atlas.texture(id);
    const front = pose.sprite;
    front.texture = texture;
    // A mirrored frame flips about the foot pixel, so it stays on the same pixel grid.
    front.scale.x = mirror ? -1 : 1;
    front.position.set(mirror ? x + anchor[0] + 1 : x - anchor[0], y - anchor[1]);
    front.zIndex = y * 4 + order;
    if (pose.blob) {
      const blobWidth = Math.max(6, Math.round(width * .58));
      const blobHeight = Math.max(4, Math.round(width * .15));
      pose.blob.position.set(x - Math.floor(blobWidth / 2), y + 1 - Math.floor(blobHeight / 2));
      pose.blob.width = blobWidth;
      pose.blob.height = blobHeight;
      pose.blob.alpha = light.shadow.blobOpacity;
    }
    if (pose.silhouette) {
      const shadow = pose.silhouette;
      const length = Math.min(TILE_SIZE * 3, Math.round(height * light.shadow.lengthPerHeight * .30));
      shadow.visible = length >= 4 && light.shadow.opacity > .02;
      if (shadow.visible) {
        const xReach = Math.round(length * light.shadow.east);
        const yReach = Math.round(length * .42);
        const shear = -xReach / height;
        const squash = -yReach / height;
        // A cream mask of the frame, so the shadow takes the tint and not the caster's own paint.
        shadow.texture = this.atlas.texture(silhouetteFrame(id));
        shadow.tint = light.shadow.tint;
        shadow.setFromMatrix(this.poseMatrix.set(1, 0, shear, squash,
          Math.round(x - anchor[0] - shear * anchor[1]), Math.round(y - squash * anchor[1])));
        shadow.alpha = light.shadow.opacity;
      }
    }
  }

  private basePropFrame(tile: Tile, map: ViewModel['map']): string | undefined {
    const {x, y} = tile.at;
    switch (tile.feature) {
      case 'house': return 'structure.farmhouse';
      case 'tank': return 'water.tank.0';
      case 'pump': return 'water.hand-pump';
      case 'well': return 'water.well.hand-dug';
      case 'shared-well': return 'water.well.shared.0';
      case 'nursery': return 'structure.nursery-tray';
      case 'acacia': return 'nature.acacia';
      case 'hedge': {
        // Long straight runs pick one of three clump layouts per tile, so the strip is irregular.
        const id = 'nature.hedge.' + this.atlas.data.autotiles.hedgeTileForMask[hedgeMask(map, x, y)];
        const variant = tileHash(x, y, tile.variant) % 3;
        return variant && this.atlas.data.frames[id + '.' + variant] ? id + '.' + variant : id;
      }
      case 'rock': return 'nature.rock.' + tile.variant % 2;
      case 'tuft': return 'nature.tuft.' + tile.variant % 4;
      case 'probe': return 'device.soil-probe.idle';
      case 'gateway': return 'device.gateway.idle';
      case 'rain-gauge': return 'device.rain-gauge';
      case 'flow-meter': return 'device.flow-meter';
      case 'valve': return 'device.valve-box.closed';
      default: return undefined;
    }
  }

  private propFrame(prop: Prop, vm: ViewModel, light: Lighting, ms: number): string | undefined {
    switch (prop.feature) {
      case 'house': return light.windowGlow > .15 ? 'structure.farmhouse.lit' : prop.id;
      case 'tank': return tankFrame(vm.water);
      case 'shared-well': return 'water.well.shared.' + (Math.floor(ms / 125) % 4);
      case 'valve':
        if (vm.valve === 'absent') return undefined;
        return 'device.valve-box.' + (vm.valve === 'pending' || vm.valve === 'closing' ? 'opening' : vm.valve);
      default: return prop.id;
    }
  }

  private prepareProps(map: ViewModel['map'], light: Lighting) {
    const previous = this.lastMap;
    if (previous?.tiles === map.tiles) return;
    this.lastMap = map;
    if (previous?.width === map.width && previous.height === map.height && map.tiles.every((tile, i) => {
      const old = previous.tiles[i];
      return tile === old || (tile.feature === old.feature && (!tile.feature || tile.variant === old.variant));
    })) return;

    for (const {pose} of this.props) {
      pose.sprite.destroy();
      pose.blob?.destroy();
      pose.silhouette?.destroy();
    }
    this.props = [];
    for (const tile of map.tiles) {
      if (!tile.feature) continue;
      const id = this.basePropFrame(tile, map);
      if (!id) continue;
      const foot = tileFoot(tile.at);
      if (tile.feature === 'house') {
        // The map gives the north-west corner of the 4 x 4 footprint.
        foot.x = tile.at.x * TILE_SIZE + 32;
        foot.y = tile.at.y * TILE_SIZE + 58;
      }
      // A hedge tile with no east or west neighbour may be mirrored without opening a seam.
      const mirror = tile.feature === 'hedge'
        && (hedgeMask(map, tile.at.x, tile.at.y) & 0xee) === 0 && (tileHash(tile.at.x, tile.at.y, 9) & 8) !== 0;
      if (tile.feature === 'hedge') foot.y += 7;
      const pose = this.addPose(tile.feature !== 'hedge', CASTERS.has(tile.feature));
      this.place(pose, id, foot, light, 2, mirror);
      this.props.push({feature: tile.feature, id, foot, pose});
    }
    this.markBeds(map, light);
  }

  /** Corner pegs and a sagging twine round each marked-out bed, from the map's bed tiles. */
  private markBeds(map: ViewModel['map'], light: Lighting) {
    for (const pose of this.pegs) pose.sprite.destroy();
    this.pegs.length = 0;
    for (const child of this.twine.removeChildren()) child.destroy();
    const bounds = new Map<Tile['bed'], {left: number; top: number; right: number; bottom: number}>();
    for (const {bed, at} of map.tiles) {
      if (!MARKED_BEDS.has(bed)) continue;
      const box = bounds.get(bed);
      if (!box) bounds.set(bed, {left: at.x, top: at.y, right: at.x, bottom: at.y});
      else Object.assign(box, {left: Math.min(box.left, at.x), top: Math.min(box.top, at.y),
        right: Math.max(box.right, at.x), bottom: Math.max(box.bottom, at.y)});
    }
    const texture = this.atlas.texture('structure.bed-twine');
    const line = (x: number, y: number, width: number, height: number) => {
      if (width > 0 && height > 0) this.twine.addChild(new Sprite({texture, x, y})).setSize(width, height);
    };
    for (const box of bounds.values()) {
      const west = box.left * TILE_SIZE - 1;
      const east = (box.right + 1) * TILE_SIZE;
      const north = box.top * TILE_SIZE;
      const south = (box.bottom + 1) * TILE_SIZE;
      for (const [x, y] of [[west, north], [east, north], [west, south], [east, south]]) {
        const pose = this.addPose(false);
        this.place(pose, 'structure.bed-peg', {x, y}, light, 1);
        this.pegs.push(pose);
      }
      for (const y of [north - TWINE_HEIGHT, south - TWINE_HEIGHT]) {
        // The long runs sag one pixel over their middle half.
        const quarter = Math.round((east - west) / 4);
        line(west + 1, y, quarter - 1, 1);
        line(west + quarter, y + 1, east - west - 2 * quarter, 1);
        line(east - quarter, y, quarter, 1);
      }
      line(west, north - TWINE_HEIGHT + 1, 1, south - north - 1);
      line(east, north - TWINE_HEIGHT + 1, 1, south - north - 1);
    }
  }

  private syncProps(vm: ViewModel, light: Lighting, ms: number) {
    this.prepareProps(vm.map, light);
    for (const prop of this.props) {
      if (prop.feature === 'hedge') continue;
      const {pose, foot} = prop;
      const id = this.propFrame(prop, vm, light, ms);
      pose.sprite.visible = id !== undefined;
      if (pose.blob) pose.blob.visible = id !== undefined;
      if (!id) continue;
      this.place(pose, id, foot, light, 2);
      for (const [index, [x, y]] of (this.atlas.frame(id).emissive ?? []).entries()) {
        if (prop.feature !== 'house') {
          this.lights.push({x: pose.sprite.x + x, y: pose.sprite.y + y, strength: 1, kind: 'device'});
          continue;
        }
        // Each lit opening of the house glows round its frame, and the door and windows throw
        // a soft pool of light onto the ground in front of the house, where the step and path are.
        const {glow, strength, pool} = HOUSE_LIGHTS[index] ?? HOUSE_LIGHTS[0];
        this.lights.push({x: pose.sprite.x + x, y: pose.sprite.y + y, strength: strength * light.windowGlow, kind: glow});
        if (pool) this.lights.push({x: pose.sprite.x + x + pool[3], y: foot.y + pool[2],
          strength: pool[1] * light.windowGlow, kind: pool[0]});
      }
    }
  }

  private syncCrops(vm: ViewModel, light: Lighting, ms: number) {
    for (let i = 0; i < vm.plants.length; i++) {
      const plant = vm.plants[i];
      const {x, y} = plant.at;
      // The map's per-tile variant picks a mirror, a 1 px nudge and a sway phase, so the
      // bed reads as separate plants rather than one stamp repeated 64 times.
      const hash = tileHash(x, y, tileAt(vm.map, x, y)?.variant ?? 0);
      const mirror = (hash & 1) === 1;
      const foot = tileFoot(plant.at);
      // Transplants are short enough to stay inside the bed and keep the even grid.
      const topRow = plant.stage !== 'transplant' && tileAt(vm.map, x, y - 1)?.bed !== tileAt(vm.map, x, y)?.bed;
      foot.x += (hash >>> 1) % 3 - 1;
      foot.y += (topRow ? TOP_ROW_DROP : 0) - CROP_RISE - ((hash >>> 3) % 2);
      const clip = this.atlas.data.clips.tomatoes[plant.stage][plant.stress];
      const rate = plant.stress === 'turgid' ? 4 : 2;
      const phase = plant.stress === 'wilted' || plant.stress === 'dead' ? 0
        : (Math.floor(ms * rate / 1_000) + (hash >>> 5)) % clip.length;
      const pose = this.crops[i] ??= this.addPose(true);
      pose.sprite.visible = pose.blob!.visible = true;
      this.place(pose, clip[phase], foot, light, 0, mirror);
      if (plant.ripeKg > 0 && plant.stress !== 'dead') {
        const fruit = this.fruit[i] ??= this.addPose(false);
        fruit.sprite.visible = true;
        this.place(fruit, 'crop.tomato.ripe-overlay', foot, light, 1, mirror);
      } else if (this.fruit[i]) {
        this.fruit[i].sprite.visible = false;
      }
    }
    for (let i = vm.plants.length; i < this.crops.length; i++) {
      const pose = this.crops[i];
      pose.sprite.visible = pose.blob!.visible = false;
      if (this.fruit[i]) this.fruit[i].sprite.visible = false;
    }
  }

  private syncPipes(vm: ViewModel) {
    if (this.pipeState === vm.dripLine && this.lastDripMap?.tiles === vm.map.tiles) return;
    this.lastDripMap = vm.map;
    let spots = 0;
    let sheens = 0;
    this.wetEmitters.length = 0;
    const previous = this.pipeState;
    for (let i = 0; i < vm.dripLine.length; i++) {
      const segment = vm.dripLine[i];
      const foot = tileFoot(segment.at);
      const old = previous?.[i];
      if (old?.at !== segment.at || old.connections !== segment.connections || old.wet !== segment.wet) {
        const {shape, turns} = pipeFrame(this.atlas.data.autotiles.dripShapes, segment.connections);
        const pipe = this.pipeSprites[i] ??= this.pipes.addChild(new Sprite());
        pipe.texture = this.atlas.texture(`water.drip.${shape}.${segment.wet ? 'wet' : 'dry'}`);
        pipe.angle = turns * 90;
        pipe.position.set(foot.x + PIPE_JOINT[turns][0], foot.y + PIPE_JOINT[turns][1]);
        pipe.visible = true;
      }
      if (!segment.wet) continue;
      const soil = tileAt(vm.map, segment.at.x, segment.at.y);
      if (soil?.terrain !== 'tilled') continue;
      for (const point of dripEmitters(segment)) {
        this.wetEmitters.push(point);
        const spot = this.spots[spots++] ??= this.wetGround.addChildAt(new Sprite({
          texture: this.wetTexture, tint: palette.E,
        }), 0);
        const wetness = Math.max(0, Math.min(1, soil.wetness ?? 0));
        const width = 4 + Math.round(4 * wetness);
        spot.width = width;
        spot.height = 4;
        spot.position.set(point.x - Math.floor(width / 2), point.y);
        spot.visible = true;
        // Sparse sheen on some of the wet patches: a fixed choice per emitter, more when wetter.
        const hash = tileHash(point.x, point.y, 5);
        if (hash % 8 >= 2 + Math.round(4 * wetness)) continue;
        const sheen = this.sheens[sheens++] ??= this.wetGround.addChild(new Sprite());
        sheen.texture = this.atlas.texture('effect.sheen.' + (hash >>> 3) % 3);
        // The hose covers the emitter row and the row below it; the sheen starts one row further south.
        sheen.position.set(point.x - 3 + (hash >>> 5) % 6, point.y + 2 + (hash >>> 8) % 2);
        sheen.visible = true;
      }
    }
    this.pipeState = vm.dripLine;
    for (let i = vm.dripLine.length; i < this.pipeSprites.length; i++) this.pipeSprites[i].visible = false;
    for (let i = spots; i < this.spots.length; i++) this.spots[i].visible = false;
    for (let i = sheens; i < this.sheens.length; i++) this.sheens[i].visible = false;
  }

  sync(vm: ViewModel, light: Lighting, ms: number, playerElapsedMs?: number) {
    this.lights.length = 0;
    this.syncProps(vm, light, ms);
    this.syncPipes(vm);
    const hose = HOSE_NIGHT.reduce((tint, drop) => tint * 256 + Math.round(255 * (1 - drop * light.darkness)), 0);
    for (const pipe of this.pipeSprites) pipe.tint = hose;
    this.syncCrops(vm, light, ms);

    const {activity, facing, at} = vm.player;
    if (playerElapsedMs === undefined && (activity !== this.playerActivity || ms < this.activityStart)) {
      this.playerActivity = activity;
      this.activityStart = ms;
    }
    const clip = this.atlas.data.clips.player[DIRECTION[facing]][activity];
    const frame = Math.floor((playerElapsedMs ?? ms - this.activityStart) * PLAYER_FPS[activity] / 1_000);
    const looping = activity === 'idle' || activity === 'walk' || activity === 'carry' || activity === 'pump';
    const foot = tileFoot(at);
    foot.x = Math.floor(foot.x);
    foot.y = Math.floor(foot.y);
    this.place(this.player, clip[looping ? frame % clip.length : Math.min(frame, clip.length - 1)], foot, light, 3);
    if (vm.phoneOpen) this.lights.push({x: foot.x + 4, y: foot.y - 13, strength: .72, kind: 'phone'});
  }

  destroy() {
    this.blobTexture.destroy(true);
    this.wetTexture.destroy(true);
  }
}
