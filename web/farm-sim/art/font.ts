import {sprite, type Sprite} from './core';

// Literal brush patterns. A slash separates rows and a missing row is blank.
const ascii: Record<string, string> = {
  ' ': '',
  '!': '..KK./..KK./..KK./..K../..K../...../..K..',
  '"': '.K.K./.K.K./.K.K.',
  '#': '.K.K./.K.K./KKKKK/.K.K./KKKKK/.K.K./.K.K.',
  '$': '..K../.KKKK/KKK../.KKK./..KKK/KKKK./..K..',
  '%': 'KK..K/KK.K./...K./..K../.K.../.K.KK/K..KK',
  '&': '.KK../K..K./K.K../.K..K/K.K.K/K..K./.KK.K',
  "'": '..KK./..K../.K...',
  '(': '...K./..K../.K.../.K.../.K.../..K../...K.',
  ')': '.K.../..K../...K./...K./...K./..K../.K...',
  '*': '...../.K.K./..K../KKKKK/..K../.K.K.',
  '+': '...../..K../..K../KKKKK/..K../..K..',
  ',': '...../...../...../...../...../..KK./..K..',
  '-': '...../...../...../.KKK.',
  '.': '...../...../...../...../...../...../..KK.',
  '/': '....K/...K./...K./..K../.K.../.K.../K....',
  '0': '.KKK./KK..K/K..KK/K.K.K/KK..K/K..KK/.KKK.',
  '1': '..K../.KK../..K../..K../..K../..K../.KKK.',
  '2': '.KKK./K...K/....K/..KK./.K.../K..K./KKKKK',
  '3': 'KKKK./....K/...K./.KKK./....K/K...K/.KKK.',
  '4': '...K./..KK./.K.K./K..K./KKKKK/...K./...K.',
  '5': 'KKKKK/K..../KKKK./....K/....K/K...K/.KKK.',
  '6': '..KK./.K.../K..../KKKK./K...K/K...K/.KKK.',
  '7': 'KKKKK/....K/...K./..K../..K../.K.../.K...',
  '8': '.KKK./K...K/K...K/.KKK./K...K/K...K/.KKK.',
  '9': '.KKK./K...K/K...K/.KKKK/....K/...K./.KK..',
  ':': '...../...../..KK./...../...../..KK.',
  ';': '...../...../..KK./...../...../..KK./..K..',
  '<': '....K/...K./.KK../K..../.KK../...K./....K',
  '=': '...../...../KKKKK/...../KKKKK',
  '>': 'K..../.K.../..KK./....K/..KK./.K.../K....',
  '?': '.KKK./K...K/....K/...K./..K../...../..K..',
  '@': '.KKK./K...K/K.KKK/K.K.K/K.KKK/K..../.KKK.',
  A: '..K../.K.K./.K.K./K...K/KKKKK/K...K/K...K',
  B: 'KKKK./K...K/K..K./KKKK./K...K/K...K/KKKK.',
  C: '..KKK/.K.../K..../K..../K..../.K.../..KKK',
  D: 'KKK../K..K./K...K/K...K/K...K/K..K./KKK..',
  E: 'KKKKK/K..../K..../KKKK./K..../K..../KKKKK',
  F: 'KKKKK/K..../K..../KKKK./K..../K..../K....',
  G: '..KKK/.K.../K..../K.KKK/K...K/.K..K/..KKK',
  H: 'K...K/K...K/K...K/KKKKK/K...K/K...K/K...K',
  I: '.KKK./..K../..K../..K../..K../..K../.KKK.',
  J: '...KK/....K/....K/....K/K...K/K...K/.KKK.',
  K: 'K...K/K..K./K.K../KK.../K.K../K..K./K...K',
  L: 'K..../K..../K..../K..../K..../K...K/KKKKK',
  M: 'K...K/KK.KK/K.K.K/K.K.K/K...K/K...K/K...K',
  N: 'K...K/KK..K/K.K.K/K.K.K/K..KK/K...K/K...K',
  O: '.KKK./K...K/K...K/K...K/K...K/K...K/.KKK.',
  P: 'KKKK./K...K/K...K/KKKK./K..../K..../K....',
  Q: '.KKK./K...K/K...K/K...K/K.K.K/K..K./.KK.K',
  R: 'KKKK./K...K/K...K/KKKK./K.K../K..K./K...K',
  S: '.KKKK/K..../K..../.KKK./....K/....K/KKKK.',
  T: 'KKKKK/..K../..K../..K../..K../..K../..K..',
  U: 'K...K/K...K/K...K/K...K/K...K/K...K/.KKK.',
  V: 'K...K/K...K/K...K/.K.K./.K.K./.K.K./..K..',
  W: 'K...K/K...K/K...K/K.K.K/K.K.K/KK.KK/K...K',
  X: 'K...K/K...K/.K.K./..K../.K.K./K...K/K...K',
  Y: 'K...K/K...K/.K.K./..K../..K../..K../..K..',
  Z: 'KKKKK/....K/...K./..K../.K.../K..../KKKKK',
  '[': '..KK./..K../..K../..K../..K../..K../..KK.',
  '\\': 'K..../.K.../.K.../..K../...K./...K./....K',
  ']': '.KK../..K../..K../..K../..K../..K../.KK..',
  '^': '..K../.K.K./K...K',
  '_': '...../...../...../...../...../...../KKKKK',
  '`': '.K.../..K..',
  a: '...../.KK../...K./.KKK./K..K./K..K./.KK.K',
  b: 'K..../K..../KKK../K..K./K...K/K...K/KKKK.',
  c: '...../...../.KKK./K..../K..../K...K/.KKK.',
  d: '....K/....K/..KKK/.K..K/K...K/K...K/.KKKK',
  e: '...../...../.KK../K..K./KKKK./K..../.KKK.',
  f: '..KK./.K..K/.K.../KKK../.K.../.K.../.K...',
  g: '...../.KKKK/K...K/K...K/.KKKK/....K/.KKK.',
  h: 'K..../K..../K.K../KK.K./K..K./K..K./K..K.',
  i: '..K../...../.KK../..K../..K../..K../.KKK.',
  j: '...K./...../..KK./...K./...K./K..K./.KK..',
  k: 'K..../K..../K..K./K.K../KK.../K.K../K..K.',
  l: '.KK../..K../..K../..K../..K../..K../...K.',
  m: '...../...../KK.K./K.K.K/K.K.K/K.K.K/K.K.K',
  n: '...../...../K.K../KK.K./K..K./K..K./K..K.',
  o: '...../...../.KK../K..K./K..K./K..K./.KK..',
  p: '...../KKK../K..K./K..K./KKK../K..../K....',
  q: '...../.KKK./K..K./K..K./.KKK./...K./...KK',
  r: '...../...../K.KK./KK..K/K..../K..../K....',
  s: '...../...../.KKK./K..../.KK../...K./KKK..',
  t: '...../.K.../.K.../KKKK./.K.../.K..K/..KK.',
  u: '...../...../K..K./K..K./K..K./K..K./.KKK.',
  v: '...../...../K...K/K...K/.K.K./.K.K./..K..',
  w: '...../...../K...K/K...K/K.K.K/K.K.K/.K.K.',
  x: '...../...../K...K/.K.K./..K../.K.K./K...K',
  y: '...../K...K/K...K/.KKKK/....K/...K./.KK..',
  z: '...../...../KKKK./...K./..K../.K.../KKKK.',
  '{': '...KK/..K../..K../.K.../..K../..K../...KK',
  '|': '..K../..K../..K../..K../..K../..K../..K..',
  '}': 'KK.../..K../..K../...K./..K../..K../KK...',
  '~': '...../...../.KK.K/K..K.',
};

const latin: Record<string, string> = {
  '¡': '..K../...../..K../..K../..KK./..KK./..KK.',
  '¢': '..K../.KKK./K.K../K.K../K.K../.KKK./..K..',
  '£': '..KK./.K..K/.K.../KKKK./.K.../K..../KKKKK',
  '¤': 'K...K/.KKK./.K.K./.K.K./.KKK./K...K',
  '¥': 'K...K/.K.K./..K../KKKKK/..K../KKKKK/..K..',
  '¦': '..K../..K../..K../...../..K../..K../..K..',
  '§': '.KKK./K..../.KK../K..K./.KK../...K./KKK..',
  '¨': '.K.K.',
  '©': '.KKK./KKKKK/KK..K/KK..K/KKKKK/.KKK.',
  'ª': '.KK../...K./.KKK./K..K./.KKK./...../KKKK.',
  '«': '...../...K./.K.K./K.K../.K.K./...K.',
  '¬': '...../...../...../KKKKK/....K',
  '®': '.KKK./KKKKK/KK.KK/KKKKK/KK.KK/.KKK.',
  '¯': 'KKKKK',
  '°': '.KK../K..K./.KK..',
  '±': '...../..K../KKKKK/..K../...../KKKKK',
  '²': '.KK../...K./..K../.KKK.',
  '³': '.KKK./...K./..KK./.KKK.',
  '´': '...K./..K..',
  'µ': '...../...../K..K./K..K./K..K./KKKK./K....',
  '¶': '.KKKK/KK.K./KK.K./.K.K./.K.K./.K.K./.K.K.',
  '·': '...../...../...../..K..',
  '¸': '...../...../...../...../...../..K../.K...',
  '¹': '..K../.KK../..K../.KKK.',
  'º': '.KK../K..K./K..K./.KK../...../KKKK.',
  '»': '...../.K.../.K.K./..K.K/.K.K./.K...',
  '¼': '.K..K/KK.K./.K.K./..K.K/.K.KK/K.KKK/....K',
  '½': '.K..K/KK.K./.K.K./..K../.K.KK/K...K/..KKK',
  '¾': 'KKK.K/..KK./KK.K./..K.K/.K.KK/K.KKK/....K',
  '¿': '..K../...../..K../.K.../K..../K...K/.KKK.',
  'Æ': '..KKK/.K.K./.K.K./K.KKK/KKKK./K.K../K.KKK',
  'Ð': '.KKK./.K..K/.K..K/KKK.K/.K..K/.K..K/.KKK.',
  '×': '...../K...K/.K.K./..K../.K.K./K...K',
  'Ø': '.KKKK/K..KK/K..KK/K.K.K/KK..K/KK..K/KKKK.',
  'Þ': 'K..../K..../KKKK./K...K/K...K/KKKK./K....',
  'ß': '.KK../K..K./K.K../K..K./K...K/K...K/K.KK.',
  'æ': '...../...../.KKK./...KK/.KKKK/K.K../.KKKK',
  'ð': '...K./.KKK./...K./.KKKK/K...K/K...K/.KKK.',
  '÷': '...../..K../...../KKKKK/...../..K..',
  'ø': '...../...../.KKKK/K..KK/K.K.K/KK..K/KKKK.',
  'þ': 'K..../K..../KKK../K..K./K..K./KKK../K....',
};

const marks: Record<string, readonly string[]> = {
  '\u0300': ['.K...', '..K..'],
  '\u0301': ['...K.', '..K..'],
  '\u0302': ['..K..', '.K.K.'],
  '\u0303': ['..KK.', '.K...'],
  '\u0308': ['.K.K.', '.....'],
  '\u030a': ['..KK.', '..KK.'],
  '\u0327': ['..K..', '.K...'],
};

function bodyRows(character: string): string[] {
  if (character === '\u00a0') return Array<string>(7).fill('.....');
  if (character === '\u00ad') character = '-';
  const source = ascii[character] ?? latin[character];
  if (source !== undefined) {
    const rows = source ? source.split('/') : [];
    return Array.from({length: 7}, (_, y) => rows[y] ?? '.....');
  }

  const [base, accent] = [...character.normalize('NFD')];
  const mark = marks[accent];
  if (!ascii[base] || !mark) throw new Error(`missing font glyph: ${character}`);
  const rows = bodyRows(base === 'i' ? 'l' : base);
  // Retain the letter's outline while making room for the two-row mark.
  while (rows.length > 5) {
    const redundant = rows.findIndex((row, y) => y < rows.length - 1 && row === rows[y + 1]);
    rows.splice(redundant < 0 ? (rows.length === 7 ? 2 : 4) : redundant, 1);
  }
  if (accent === '\u0327') rows.push(...mark);
  else rows.unshift(...mark);
  return rows;
}

function headingRows(body: readonly string[]): string[] {
  // Add weight through the centre and repeat the shoulder and foot rows.
  const widen = (row: string) => row.slice(0, 2) + row[2] + row.slice(2);
  return [body[0], body[1], body[1], ...body.slice(2, 6), body[5], body[6]].map(widen);
}

export const fontFaces = {
  body: {width: 5, height: 7, advance: 6, lineHeight: 9},
  heading: {width: 6, height: 9, advance: 7, lineHeight: 11},
} as const;

export const glyphCodePoints = [
  ...Array.from({length: 95}, (_, i) => i + 32),
  ...Array.from({length: 96}, (_, i) => i + 160),
];

export function fontSprites(): Sprite[] {
  return (['body', 'heading'] as const).flatMap(face => {
    const {width, height} = fontFaces[face];
    return glyphCodePoints.map(code => {
      const rows = bodyRows(String.fromCodePoint(code));
      return sprite({id: `font.${face}.${code}`, size: [width, height],
        rows: face === 'heading' ? headingRows(rows) : rows});
    });
  });
}
