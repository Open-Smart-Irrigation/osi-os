import { describe, expect, it } from 'vitest';

import vectors from '../../../../../docs/contracts/matric-potential/vectors.json';
import { kpaToPf, pfToKpa } from '../matricPotential';

type Vector = { input: number | string | null; expected: number | null };

function asInput(value: Vector['input']): unknown {
  return typeof value === 'string' ? Number(value) : value;
}

function expectVectorValue(actual: number | null, expected: number | null) {
  if (expected === null) {
    expect(actual).toBeNull();
    return;
  }

  expect(actual).not.toBeNull();
  const tolerance = Math.max(vectors.absolute_tolerance, Math.abs(expected) * vectors.relative_tolerance);
  expect(Math.abs(actual! - expected)).toBeLessThanOrEqual(tolerance);
}

describe('matric potential conversion', () => {
  it.each(vectors.kpa_to_pf)('converts %j kPa to pF', ({ input, expected }: Vector) => {
    expectVectorValue(kpaToPf(asInput(input)), expected);
  });

  it.each(vectors.pf_to_kpa)('converts pF %j to kPa', ({ input, expected }: Vector) => {
    expectVectorValue(pfToKpa(asInput(input)), expected);
  });

  it('accepts only finite numbers at its public boundary', () => {
    for (const value of [null, undefined, '', '30', Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(kpaToPf(value)).toBeNull();
      expect(pfToKpa(value)).toBeNull();
    }
  });
});
