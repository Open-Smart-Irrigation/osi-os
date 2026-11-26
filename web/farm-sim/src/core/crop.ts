import type {CropSpriteStage, CropStressState} from './types';
import {round2} from './units';

export const TOMATO = Object.freeze({
  id: 'tomato', kcInitial: .60, kcMid: 1.15, kcEnd: .70,
  initialDays: 30, developmentDays: 40, midDays: 45, lateDays: 30,
  minRootM: .10, maxRootM: 1, ky: 1.05, potentialKgPerM2: 2,
  plantDensityPerM2: 1 / (.9 * .5), rotDays: 4, yieldWindowDays: 7,
});

export interface FruitSeed {
  readonly green: number;
  readonly ripening: number;
  readonly ripe: number;
}

interface RipeBatch {
  readonly grams: number;
  readonly ripeOnDay: number;
}

export interface Crop {
  /** Zero-based days since transplant on the edge stage calendar. */
  readonly ageDays: number;
  readonly fruit: FruitSeed;
  readonly ripe: readonly RipeBatch[];
  readonly yieldWindow: readonly number[];
  readonly severeDays: number;
  readonly dead: boolean;
}

/**
 * A seeded ripe batch holds one day's potential ripening mass per tile (the
 * yield model's daily batch) and counts as ripened at the end of ripeOnDay.
 */
export function tomato(ageDays = 0, fruit: FruitSeed = {green: 0, ripening: 0, ripe: 0}, ripeOnDay = 0): Crop {
  const grams = Math.round(TOMATO.potentialKgPerM2 * 1000 / (TOMATO.midDays + TOMATO.lateDays));
  const ripe = Array.from({length: fruit.ripe}, () => ({grams, ripeOnDay}));
  return {ageDays, fruit: {...fruit}, ripe, yieldWindow: [], severeDays: 0, dead: false};
}

export function phenology(crop: Crop) {
  const a = crop.ageDays;
  const t = TOMATO;
  const developmentEnd = t.initialDays + t.developmentDays;
  const midEnd = developmentEnd + t.midDays;
  const lateEnd = midEnd + t.lateDays;
  const rootDepthM = t.minRootM + (t.maxRootM - t.minRootM) * Math.min(1, a / developmentEnd);
  if (a < t.initialDays) return {stage: 'initial', dayInStage: a, kc: t.kcInitial, rootDepthM} as const;
  if (a < developmentEnd) {
    const dayInStage = a - t.initialDays;
    const kc = round2(t.kcInitial + (t.kcMid - t.kcInitial) * (dayInStage + 1) / t.developmentDays);
    return {stage: 'development', dayInStage, kc, rootDepthM} as const;
  }
  if (a < midEnd) return {stage: 'mid_season', dayInStage: a - developmentEnd, kc: t.kcMid, rootDepthM} as const;
  if (a < lateEnd) {
    const dayInStage = a - midEnd;
    const kc = round2(t.kcMid + (t.kcEnd - t.kcMid) * (dayInStage + 1) / t.lateDays);
    return {stage: 'late_season', dayInStage, kc, rootDepthM} as const;
  }
  return {stage: 'dormancy', dayInStage: a - lateEnd, kc: .25, rootDepthM} as const;
}

export function cropSpriteStage(crop: Crop): CropSpriteStage {
  if (crop.ripe.length > 0) return 'ripe-fruit';
  const {stage, dayInStage} = phenology(crop);
  if (stage === 'initial') return 'transplant';
  if (stage === 'development') return dayInStage < 20 ? 'vegetative' : 'flowering';
  return 'green-fruit';
}

export function cropStress(ks: number, hour: number, dead: boolean): CropStressState {
  if (dead) return 'dead';
  if (ks < .5) return 'wilted';
  if (ks < .8) return 'grey-green';
  if (ks < 1 && hour >= 11 && hour < 16) return 'rolling';
  return 'turgid';
}

export function yieldFactor(ratios: readonly number[]): number {
  const recent = ratios.slice(-TOMATO.yieldWindowDays);
  const mean = recent.length ? recent.reduce((sum, ratio) => sum + ratio, 0) / recent.length : 1;
  return Math.max(0, Math.min(1, 1 - TOMATO.ky * (1 - mean)));
}

export function ripeGrams(crop: Crop): number {
  return crop.ripe.reduce((sum, batch) => sum + batch.grams, 0);
}

export function finishCropDay(crop: Crop, day: number, meanKs: number, etaOverEtc: number) {
  if (crop.dead) return {crop, lostGrams: 0};
  const {stage} = phenology(crop);
  const ageDays = crop.ageDays + 1;
  const severeDays = meanKs < .2 ? crop.severeDays + 1 : 0;
  const dead = severeDays >= 3;
  const yieldWindow = [...crop.yieldWindow, Math.max(0, Math.min(1, etaOverEtc))].slice(-TOMATO.yieldWindowDays);
  const ripe: RipeBatch[] = [];
  let lostGrams = 0;
  for (const batch of crop.ripe) {
    if (dead || day - batch.ripeOnDay >= TOMATO.rotDays) lostGrams += batch.grams;
    else ripe.push(batch);
  }
  const productive = stage === 'mid_season' || stage === 'late_season';
  const dailyPotential = TOMATO.potentialKgPerM2 * 1000 / (TOMATO.midDays + TOMATO.lateDays);
  const productionDay = crop.ageDays - TOMATO.initialDays - TOMATO.developmentDays;
  // Allocate the seasonal gram total once across days to avoid a rounding bias.
  const potential = Math.round(dailyPotential * (productionDay + 1)) - Math.round(dailyPotential * productionDay);
  const grams = productive ? Math.round(potential * yieldFactor(yieldWindow)) : 0;
  if (dead) lostGrams += grams;
  else if (grams > 0) ripe.push({grams, ripeOnDay: day});

  // Fruit counts are visual cues. Ripening mass follows the yield response above.
  const green = Math.max(0, crop.fruit.green - (productive && crop.fruit.ripening === 0 ? 2 : 0));
  const ripening = productive && crop.fruit.ripening === 0 ? Math.min(2, crop.fruit.green) : 0;
  const fruit = dead ? {green: 0, ripening: 0, ripe: 0}
    : {green, ripening, ripe: ripe.length};
  return {crop: {ageDays, fruit, ripe, yieldWindow, severeDays, dead}, lostGrams};
}

export function harvestTomato(crop: Crop) {
  return {crop: {...crop, fruit: {...crop.fruit, ripe: 0}, ripe: []}, grams: ripeGrams(crop)};
}
