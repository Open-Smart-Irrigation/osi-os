/** Integer hundredths, with halfway cases rounded away from zero. */
export function hundredths(value: number): number {
  const magnitude = Math.abs(value) * 100;
  // Recover decimal halves that landed one floating-point operation below the tie.
  const rounded = Math.round(magnitude + Number.EPSILON * magnitude);
  return value < 0 && rounded !== 0 ? -rounded : rounded;
}

export function round2(value: number): number {
  return hundredths(value) / 100;
}
