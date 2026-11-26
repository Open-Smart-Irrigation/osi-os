import {Pixels, sprite, type Pixel, type Remap, type Sprite} from '../core';

export const tomatoStages = ['transplant', 'vegetative', 'flowering', 'green-fruit', 'ripe-fruit'] as const;
export const tomatoStates = ['turgid', 'rolling', 'grey-green', 'wilted', 'dead'] as const;
export const swayFrames = [0, 1, 2] as const;

// Five silhouettes, each with the stem ending at column six. Fruit and yellow
// flowers sit on side clusters rather than replacing the tip of the main stem.
const canopies = [
  [
    '......L......',
    '.....LMN.....',
    '..LMN.N.LMN..',
    '.LMMNnMnMMNn.',
    '..nN..N..Nn..',
    'LMMN..M..LMMn',
    '.nNNn.N.nNNn.',
    '......N......',
    '......n......',
  ],
  [
    '.......ML....',
    '.....LMMN....',
    '....LMNNn....',
    '..LM...M..LM.',
    '.LMMNN.M.MMNn',
    '..nNNNMNnNNn.',
    '......M......',
    '...LM.M.MN...',
    '..MMNNNNMn...',
    '....n.n......',
    '......N......',
    '......n......',
  ],
  [
    '.....LM......',
    '...LMMNN.LM..',
    '..LMNNMM.MMN.',
    '.LMN.nMNLMNn.',
    '..nLMMNMMNY..',
    '.LMMNYNMNnYG.',
    'LMMNYGnMLMMN.',
    '.nNN.MMNMMNNn',
    '..LMMNMNNYN..',
    '.LMMYNNMNYGY.',
    'LMMNYGNMNNYn.',
    '.nNNYnMNMNn..',
    '...nN.MNLMN..',
    '..LMn.MNnn...',
    '......n......',
  ],
  [
    '......LM.....',
    '....LMMNNLM..',
    '...LMNNMMMNn.',
    '..LMMn.MNLMN.',
    '.LMMNNLMMMNn.',
    'LMMMNMMNNnLM.',
    '.nNNNMMNLMMNn',
    '..LMNMNMNNMn.',
    '.LMMONMMOONn.',
    'LMMOONMLOOMNn',
    '.nNOOnMNOOn..',
    '..LMMNMNNMMN.',
    '.LMMNnMNnNNn.',
    '..nN..Mn.....',
    '......n......',
  ],
  [
    '.....LM......',
    '...LMMNN..LM.',
    '..LMNNMMMLMNn',
    '.LMM.nMMNMNn.',
    'LMMNMMMNN.LM.',
    '.nNNNMMNMLMMn',
    '..LoNMNMMNNn.',
    '.LorxNMMMNor.',
    'LMrrrNMNorxr.',
    '.nNrnMMNrrrn.',
    '..LMMNMNnrNn.',
    '.LMMNNMNLMMN.',
    '..NNn.MNNMNn.',
    '......MN..Nn.',
    '......n......',
  ],
] as const;

// A transplant whose leaves have rolled up along the midrib: a narrow upright V of
// thin blades with their pale undersides out. Drawn by hand, because at this size the
// generic fold leaves too few pixels to read at 1x.
const rolledTransplant = [
  '......O......',
  '.....QON.....',
  '....Q.O.N....',
  '...QO.O.OP...',
  '....Q.O.P....',
  '..QO..O..OP..',
  '...Q..O..P...',
  '......O......',
  '......n......',
] as const;

const stressRemaps: readonly Remap[] = [
  {},
  {L: 'O', M: 'O', N: 'N', n: 'n'},
  {L: 'Q', M: 'P', N: 'P', n: 'Q'},
  {L: 'Q', M: 'P', N: 'P', n: 'H', Y: '.', G: '.'},
  {L: 'G', M: 'H', N: 'I', n: 'I', O: 'I', Y: '.', G: '.', o: 'I', x: 'I', r: 'I'},
];

function cropBase(stage: number, rows: readonly string[] = canopies[stage]): Sprite {
  const pixels = new Pixels([16, stage < 2 ? 16 : 24]);
  const foot = pixels.size[1] - 3;
  // A transplant sits in its own dug planting basin, which keeps a young bed readable at 1x.
  if (stage === 0) pixels.stamp(4, foot, ['.DEEEEED.', '..DDDDD..']);
  pixels.stamp(2, foot - rows.length + 1, rows);
  return sprite({id: `crop.tomato.${tomatoStages[stage]}.base`, size: pixels.size, anchor: [8, foot], rows: pixels.rows()});
}

const leafKeys: ReadonlySet<string> = new Set(['L', 'M', 'N', 'n']);

function posture(source: Sprite, stage: number, state: number, frame: number): Sprite {
  const pixels = new Pixels(source.size);
  const [footX, footY] = source.anchor;
  const height = canopies[stage].length - 1;
  if (stage >= 2) {
    // Two stake legs and a lashing stay fixed while the plant bends, and keep their colour.
    pixels.line(4, footY, 6, footY - height, 'J');
    pixels.line(12, footY, 10, footY - height, 'j');
    pixels.line(5, footY - 8, 11, footY - 8, 'I');
  }
  const handRolled = stage === 0 && (state === 1 || state === 2);
  // The hand-rolled transplant is olive already; grey-green turns its olive grey too.
  const remap: Remap = handRolled && state === 2 ? {...stressRemaps[2], O: 'P'} : stressRemaps[state];
  const wind = [0, -1, 1][frame];
  const rolled = state === 1 || state === 2;
  const leafAbove = (x: number, y: number) => y > 0 && leafKeys.has(source.rows[y - 1][x]);
  source.rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const key = row[x] as Pixel;
      if (key === '.') continue;
      const away = x - footX;
      const reach = Math.abs(away);
      const aloft = (footY - y) / height;
      let nx = x;
      let ny = y;
      if (handRolled || key === 'D' || key === 'E') {
        // Drawn already rolled, or the planting basin: only sway, and only above the soil.
      } else if (rolled && reach >= 2 && leafKeys.has(key)) {
        // Rolled leaflets fold up along the midrib: only the upper edge of each blade
        // shows, the plant narrows and the outer leaves stand more upright.
        if (reach >= 3 && key !== 'L' && leafAbove(x, y)) continue;
        nx = footX + Math.sign(away) * (reach - Math.floor(reach / 3));
        ny = y - (reach >= 3 ? 1 : 0) - (stage < 2 && reach >= 4 ? 1 : 0);
      } else if (state >= 3 && reach >= 3) {
        // Wilting pulls the tips in as the outer growth folds toward the ground.
        nx = x - Math.sign(away);
      }
      const soil = key === 'D' || key === 'E';
      const droop = state >= 3 && !soil ? Math.round(aloft * (2 + reach / 2)) : 0;
      const sway = state < 3 && !soil && aloft >= (state === 0 ? 0.4 : 0.68) ? wind : 0;
      const shade = state === 0 && sway === 1 && x > footX && key === 'L' ? 'M' : key;
      const ink = remap[shade] ?? shade;
      if (ink !== '.') pixels.put(nx + sway, ny + droop, ink);
    }
  });
  return sprite({...source, rows: pixels.rows()});
}

const tomatoes = tomatoStages.flatMap((stage, stageIndex) => {
  const base = cropBase(stageIndex);
  const rolled = stageIndex === 0 ? cropBase(0, rolledTransplant) : base;
  return tomatoStates.flatMap((state, stateIndex) => swayFrames.map(frame =>
    sprite({...posture(stateIndex === 1 || stateIndex === 2 ? rolled : base, stageIndex, stateIndex, frame),
      id: `crop.tomato.${stage}.${state}.${frame}`})));
});

const fruit = new Pixels([16, 16]);
fruit.stamp(3, 4, [
  '..N.......',
  '.orx...N..',
  '.rrr..orx.',
  '..r...rrr.',
  '.......r..',
  '...N......',
  '..orx.....',
  '..rrr.....',
  '...r......',
]);

export const cropSprites = [...tomatoes, sprite({
  id: 'crop.tomato.ripe-overlay', size: fruit.size, anchor: [8, 13], rows: fruit.rows(),
})];
