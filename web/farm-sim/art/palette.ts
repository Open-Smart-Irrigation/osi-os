export const palette = {
  K: '#1f1720', k: '#3b2a33',
  A: '#f0c08a', B: '#d98c52', C: '#b8643a', D: '#8e4530', E: '#5e2c26',
  G: '#f4dc8c', H: '#d6b25a', I: '#a8823e',
  L: '#b6d65a', M: '#6fa83f', N: '#3f7a3a', n: '#24503a',
  O: '#7a8f55', P: '#5d6b5c', Q: '#8b8f80',
  t: '#fff4d6', u: '#9fd0e6', v: '#5b9fd0', W: '#3a6fa0', X: '#bfe6f0',
  h: '#7f9cc0', w: '#f7b26a', x: '#e0735a', y: '#6e4f86', z: '#2e3560', Z: '#171c38',
  1: '#e3a97c', 2: '#c0835a', 3: '#9a5e3e', 4: '#74402d', 5: '#532c23', 6: '#3a1f1b',
  r: '#c8323c', o: '#f08a24', Y: '#f2c230', g: '#1f8a7a', i: '#2f4fa0', p: '#8a3a78',
  c: '#f6efe0', R: '#8a9aa6', T: '#c3ccd0', j: '#7a5236', J: '#4e3426', F: '#fff1b8',
} as const;

export type PaletteKey = `${keyof typeof palette}`;

export const ramps = {
  soil: 'EDCBA', straw: 'IHG', foliage: 'nNML',
  rolling: 'ONn', greyGreen: 'PQ', wilted: 'PQH', dead: 'IHG',
  water: 'WvuX', preDawn: 'Zzy', goldenHour: 'yxwG', midday: 'vut',
  storm: 'kyhQTc', hills: 'yhu',
  skinA: '123', skinB: '234', skinC: '345', skinD: '456',
  metal: 'kRTc', rust: 'DC', wood: 'KJj', lamp: 'roYF',
} as const;

export const accents = {
  skinRim: '3',
  waterGlint: 't',
  clothShade: {Y: 'o', o: 'r', r: 'p', p: 'k', g: 'n', i: 'z', c: 'G', G: 'H'},
  ui: {paper: 'c', ink: 'K', header: 'g', warn: 'o', alert: 'r', ok: 'M', info: 'v'},
} as const;

export function isPaletteKey(value: unknown): value is PaletteKey {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(palette, value);
}
