export type Random = () => number;

/** Small Fast Counter PRNG. Returns a uniform draw in [0, 1). */
export function sfc32(a: number, b: number, c: number, d: number): Random {
  return () => {
    a |= 0;
    b |= 0;
    c |= 0;
    d |= 0;
    const output = (a + b + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (((c << 21) | (c >>> 11)) + output) | 0;
    return (output >>> 0) / 0x1_0000_0000;
  };
}

/** Derive independent streams from stable, length-delimited keys. */
export function namedStream(seed: number, system: string, ...keys: (number | string)[]): Random {
  const key = JSON.stringify([seed, system, ...keys]);
  let hash = 2166136261;
  for (let index = 0; index < key.length; index++) {
    hash = Math.imul(hash ^ key.charCodeAt(index), 16777619);
  }
  const word = () => {
    hash = (hash + 0x9e3779b9) | 0;
    let mixed = Math.imul(hash ^ (hash >>> 16), 0x21f0aaad);
    mixed = Math.imul(mixed ^ (mixed >>> 15), 0x735a2d97);
    return mixed ^ (mixed >>> 15);
  };
  const draw = sfc32(word(), word(), word(), word());
  for (let index = 0; index < 12; index++) draw();
  return draw;
}

export function normal(draw: Random): number {
  return Math.sqrt(-2 * Math.log(1 - draw())) * Math.cos(2 * Math.PI * draw());
}

export function lognormal(draw: Random, sigma: number): number {
  return Math.exp(sigma * normal(draw) - sigma ** 2 / 2);
}

export function uniformInt(draw: Random, min: number, max: number): number {
  return min + Math.floor(draw() * (max - min + 1));
}

/** Marsaglia–Tsang gamma sampler with the shape-boost transform below one. */
export function gamma(draw: Random, shape: number, scale: number): number {
  if (!(shape > 0 && scale > 0)) throw new RangeError('Gamma requires positive shape and scale');
  if (shape < 1) return gamma(draw, shape + 1, scale) * (1 - draw()) ** (1 / shape);

  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    const z = normal(draw);
    const base = 1 + c * z;
    if (base <= 0) continue;
    const v = base ** 3;
    const u = draw();
    if (u < 1 - 0.0331 * z ** 4 || Math.log(u) < z ** 2 / 2 + d * (1 - v + Math.log(v))) {
      return scale * d * v;
    }
  }
}
