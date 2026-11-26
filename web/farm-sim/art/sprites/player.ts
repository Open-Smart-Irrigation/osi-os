import {derive, Pixels, sprite, type Sprite} from '../core';

export const playerClips = {idle: 2, walk: 4, hoe: 4, pour: 3, carry: 4, pump: 4, harvest: 3} as const;
export const playerDirections = ['down', 'up', 'right', 'left'] as const;
type Direction = typeof playerDirections[number];
type Action = keyof typeof playerClips;

const cell = [24, 32] as const;
const foot = [12, 29] as const;

// Faces read as lit skin with dark eyes under the hat brim; the back of the head is hair.
// Skin keys 3 4 5 (rim, base, shade) keep every frame within the 12-colour budget.
const downHead = [
  '..GGGGG..',
  '.GGHHHGG.',
  'GGHHHHHHG',
  'HHHHHHHHH',
  '.k45554k.',
  '.53k3k35.',
  '..43334..',
  '...45....',
];
const upHead = [
  '..GGGGG..',
  '.GGGHHHG.',
  'GGGHHHHHG',
  'HHHHHHHHH',
  '.kkkkkkk.',
  '.5kkkkk5.',
  '..kkkkk..',
  '...45....',
];
const sideHead = [
  '..GGGG...',
  '.GGGHHHG.',
  'GGGHHHHHG',
  '.HHHHHHHH',
  '.kk5555..',
  '.kk43k33.',
  '..k4334..',
  '...45....',
];

const stride = [[-1, 1], [0, -1], [1, -1], [-1, 0]] as const;

function body(direction: Exclude<Direction, 'left'>, action: Action, frame: number): Sprite {
  const pixels = new Pixels(cell);
  const moving = action === 'walk' || action === 'carry';
  const side = direction === 'right';
  const bob = moving ? frame % 2 : action === 'idle' ? frame : 0;
  const bend = action === 'harvest' && frame === 1 || action === 'hoe' && frame === 2 ? 2 : 0;
  const shoulders = 14 + bob + bend;
  const yHead = shoulders - 8;
  const [a, b] = moving ? stride[frame] : [0, 0];
  pixels.line(10, 22, side ? 10 + a * 3 : 9, side ? 28 : 28 - a, 'z');
  pixels.line(11, 22, side ? 11 + a * 3 : 10, side ? 28 : 28 - a, 'z');
  pixels.line(13, 22, side ? 13 + b * 3 : 13, side ? 28 : 28 - b, 'z');
  pixels.line(14, 22, side ? 14 + b * 3 : 14, side ? 28 : 28 - b, 'z');
  pixels.rect(side ? 9 + a * 3 : 8, side ? 28 : 28 - a, 4, 1, 'k');
  pixels.rect(side ? 13 + b * 3 : 13, side ? 28 : 28 - b, 4, 1, 'k');
  const hems = side ? 7 : 8;
  const shirtLeft = side ? 8 : 7;
  // The tunic ends one row higher than before so both 2 px legs show below the hem.
  pixels.rect(shirtLeft, shoulders, hems + 1, 22 - shoulders, 'g');
  pixels.rect(shirtLeft + 1, shoulders + 1, hems + 1, 22 - shoulders, 'n');
  pixels.rect(shirtLeft + 1, shoulders + 1, hems - 1, 21 - shoulders, 'g');
  // A repeating two-stroke chevron sits on the fabric with a dark hem.
  for (let x = 0; x < hems - 1; x++) {
    const stagger = Math.min(x % 4, 4 - x % 4);
    if (shoulders + 2 + stagger < 23) pixels.put(shirtLeft + 1 + x, shoulders + 2 + stagger, 'c');
  }
  pixels.stamp(side ? 8 : 7, yHead, direction === 'down' ? downHead : side ? sideHead : upHead);
  if (action === 'carry') {
    pixels.line(shirtLeft, shoulders + 1, 6, yHead + 1, '5');
    pixels.line(shirtLeft + hems, shoulders + 1, 17, yHead + 1, '4');
  } else {
    pixels.line(shirtLeft, shoulders + 1, side ? 10 : 6, shoulders + 6 + a, '5');
    pixels.line(shirtLeft + hems, shoulders + 1, side ? 18 : 16, shoulders + 6 + b, '4');
  }
  return sprite({id: 'player.body', size: cell, anchor: foot, rows: pixels.rows()});
}

function heldItem(direction: Direction, action: Action, frame: number): {rows: string[]; front: boolean} {
  const pixels = new Pixels(cell);
  const left = direction === 'left' || direction === 'down';
  const sign = left ? -1 : 1;
  const x = left ? 7 : 16;
  const hand = (y: number) => {
    pixels.line(left ? 8 : 15, 16, x, y, '5');
    pixels.put(x, y, '4');
  };
  if (action === 'hoe') {
    const to = [[2, -8], [4, -11], [6, 5], [5, 1]][frame];
    const y = [16, 15, 21, 19][frame];
    hand(y);
    pixels.line(x - 2 * sign, y + 4, x + to[0] * sign, y + to[1], 'J');
    pixels.line(x + to[0] * sign, y + to[1], x + (to[0] + 1) * sign, y + to[1] + 2, 'R');
    pixels.put(x, y, '4');
  }
  if (action === 'pour') {
    const y = [21, 18, 21][frame];
    const reach = x + 2 * sign;
    hand(y);
    pixels.stamp(reach - 2, y - 1, ['.RR..', 'R..R.', 'RTTR.', 'RTRR.', '.RR..']);
    pixels.line(reach + sign, y + 1, reach + 4 * sign, y + (frame === 1 ? 3 : -1), 'R');
  }
  if (action === 'carry') {
    pixels.stamp(8, 2 + frame % 2, ['...kk..', '.okYYk.', '.YYYYo.', '.YoYYo.', '.ooooo.']);
  }
  if (action === 'pump') {
    hand([16, 18, 20, 18][frame]);
  }
  if (action === 'harvest') {
    const y = [20, 23, 19][frame];
    hand(y);
    pixels.stamp(x + sign - 2, y + 1, ['.JJ..', 'J..J.', 'JGGGJ', '.HHH.', '.JJJ.']);
  }
  return {rows: pixels.rows(), front: direction === 'down' || direction === 'right' || action === 'carry'};
}

function playerFrame(direction: Direction, action: Action, frame: number): Sprite {
  const left = direction === 'left';
  const base = body(left ? 'right' : direction, action, frame);
  const pose = left ? derive(base, {id: base.id, mirror: true}) : base;
  // Draw props in the player's right hand after mirroring the side body.
  const prop = heldItem(direction, action, frame);
  const pixels = new Pixels(cell);
  if (!prop.front) pixels.stamp(0, 0, prop.rows);
  pixels.stamp(0, 0, pose.rows);
  if (prop.front) pixels.stamp(0, 0, prop.rows);
  return sprite({id: `player.${direction}.${action}.${frame}`, size: cell, anchor: foot, rows: pixels.rows()});
}

export const playerSprites = playerDirections.flatMap(direction =>
  (Object.keys(playerClips) as Action[]).flatMap(action =>
    Array.from({length: playerClips[action]}, (_, frame) => playerFrame(direction, action, frame))));
