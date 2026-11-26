import {Pixels, sprite, type Sprite} from '../core';

// Ink is applied to the four-neighbour contour, including holes in handles.
const iconGrids = {
  hoe: [
    '.........TTT',
    '........TRR.',
    '.......jR...',
    '......j.....',
    '.....j......',
    '....j.......',
    '...j........',
    '..j.........',
    '.j..........',
    'j...........',
  ],
  can: [
    '....RRR.....',
    '...R...R....',
    '...R...R..T.',
    '.TTTTT.R.TTR',
    'TTggggR.TRR.',
    'TgggggRRR...',
    'TgggggRR....',
    'RgggRR......',
    '.RRRR.......',
  ],
  jerrycan: [
    '.rr....o..',
    '.rr.YYYY..',
    '..YYYY.Y..',
    '.YYYYYYYo.',
    '.YooooYYo.',
    '.YoYYoYYo.',
    '.YoYYoYYo.',
    '.YooooYYo.',
    '.YYYYYYor.',
    '..ooooor..',
  ],
  basket: [
    '....jj....',
    '..jj..jj..',
    '..j....j..',
    '.GGGGGGGG.',
    'GHHGHHGHHG',
    '.IHIHHIHI.',
    '.HIHIHIII.',
    '..IIIIII..',
  ],
  seedling: [
    '...L.....',
    '..LMM....',
    '..MN..L..',
    '...N.LMN.',
    '...MMNn..',
    '...nN....',
    '..CCDC...',
    '.CDDDDE..',
    '..DEEE...',
  ],
  tomato: [
    '....N.....',
    '..LMMNn...',
    '.ooNMrxx..',
    'oorrrrxxr.',
    'orrrrrrrr.',
    '.rrrrrrr..',
    '..rrrrr...',
  ],
  phone: [
    '..RTTTTR..',
    '..RgggkR..',
    '..RccckR..',
    '..RcTckR..',
    '..RccckR..',
    '..RccckR..',
    '..RkkkRR..',
    '..RRgTRR..',
    '...RRRR...',
  ],
  energy: [
    '.....GG...',
    '....GGY...',
    '...GGY....',
    '..GGYYYY..',
    '.GYYYYY...',
    '....Yo....',
    '...Yo.....',
    '..Yo......',
  ],
  water: [
    '....X.....',
    '...Xv.....',
    '...uvv....',
    '..XuuvW...',
    '.XuvvvWW..',
    '.uvvvWWW..',
    '.vuvuWWW..',
    '..WWWWW...',
  ],
  probe: [
    '.....R....',
    '.....R....',
    '...TTTTT..',
    '..TccccR..',
    '..TcgcTR..',
    '...RRRR...',
    '....TR....',
    '....TR....',
    '....RR....',
    '....R.....',
  ],
  valve: [
    '......gg..',
    '.....gn...',
    '....n.....',
    '..TTTTTT..',
    '.RccccTRR.',
    'RRccccTRRR',
    'TTgggRRRTT',
    'RRRRRRRRRR',
  ],
  report: [
    '...TTT....',
    '..TTcTT...',
    '.RccccTR..',
    '.RcgcRTR..',
    '.RcccRTR..',
    '.RcMcRTR..',
    '.RcccRTR..',
    '.RcocRTR..',
    '.RRRRRRR..',
  ],
} as const;

function icon(id: string, rows: readonly string[]): Sprite {
  const fill = new Pixels([16, 16]);
  const x = Math.floor((16 - rows[0].length) / 2);
  const y = Math.floor((16 - rows.length) / 2);
  fill.stamp(x, y, rows);
  const pixels = new Pixels(fill.size);
  for (let py = 0; py < 16; py++) {
    for (let px = 0; px < 16; px++) {
      if (fill.get(px, py) === '.') continue;
      pixels.put(px - 1, py, 'K');
      pixels.put(px + 1, py, 'K');
      pixels.put(px, py - 1, 'K');
      pixels.put(px, py + 1, 'K');
    }
  }
  pixels.stamp(0, 0, fill.rows());
  return sprite({id: `icon.${id}`, size: pixels.size, kind: 'icon', rows: pixels.rows()});
}

export const iconSprites = Object.entries(iconGrids).map(([id, rows]) => icon(id, rows));

const signboard = new Pixels([24, 24]);
signboard.rect(1, 0, 22, 24, 'K');
signboard.rect(0, 1, 24, 22, 'K');
signboard.rect(1, 1, 22, 22, 'c');
signboard.rect(2, 1, 20, 1, 'T');

const phone = new Pixels([96, 176]);
phone.rect(2, 0, 92, 176, 'K');
phone.rect(0, 2, 96, 172, 'K');
phone.rect(3, 2, 90, 171, 'k');
phone.rect(1, 5, 1, 164, 'R');
phone.rect(3, 1, 90, 1, 'T');
phone.rect(6, 9, 84, 159, 'K');
phone.rect(7, 10, 82, 157, '.');
phone.rect(40, 5, 16, 2, 'K');
phone.rect(41, 5, 14, 1, 'R');
phone.rect(46, 170, 4, 1, 'g');

export const uiSprites = [
  sprite({id: 'ui.signboard', size: signboard.size, slice: [3, 3, 3, 3], rows: signboard.rows()}),
  sprite({id: 'ui.phone-bezel', size: phone.size, slice: [8, 12, 8, 10], rows: phone.rows()}),
];
