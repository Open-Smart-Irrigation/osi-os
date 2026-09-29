import type { TFunction } from 'i18next';
import { stageFamily, type StageFamily, type StageId } from './cropKc';

/**
 * FAO-56 growth stages, labelled by crop family: woody crops (vines, fruit
 * trees, berries) name the stage by bud break and leaf fall, annual crops by
 * sowing and harvest. The English fallbacks mirror the en bundle.
 */
export const STAGE_LABEL_FALLBACK: Record<StageFamily, Record<StageId, string>> = {
  woody: {
    initial: 'Initial (bud break)',
    development: 'Development (flowering, fruit set)',
    mid_season: 'Mid-season (fruit growth, ripening)',
    late_season: 'Late season (after harvest, until leaf fall)',
    dormancy: 'Dormancy (winter rest)',
  },
  annual: {
    initial: 'Initial (sowing, emergence)',
    development: 'Development (canopy closing)',
    mid_season: 'Mid-season (full cover, flowering)',
    late_season: 'Late season (ripening, harvest)',
    dormancy: 'Dormancy (no crop)',
  },
};

/** English fallbacks of `zoneConfig.stage.*`, the short stage names used inline. */
export const STAGE_FALLBACK: Record<StageId, string> = {
  initial: 'Initial',
  development: 'Crop development',
  mid_season: 'Mid-season',
  late_season: 'Late season',
  dormancy: 'Dormancy',
};

/** The option label for one FAO-56 stage, in the crop's label family. */
export function stageOptionLabel(t: TFunction<'devices'>, cropType: unknown, stage: StageId): string {
  const family = stageFamily(cropType);
  return t(`zoneConfig.stageLabel.${family}.${stage}`, { defaultValue: STAGE_LABEL_FALLBACK[family][stage] });
}
