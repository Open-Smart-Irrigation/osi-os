import predictionCropCatalog from './predictionCropCatalog.json';

/**
 * FAO-56 Penman-Monteith crop coefficient (Kc) reference data aligned with the
 * server-side prediction crop catalog.
 */

export interface CropEntry {
  value: string;
  label: string;
  kc_ini: number;
  kc_mid: number;
  kc_end: number;
}

export interface CropGroup {
  groupLabel: string;
  crops: CropEntry[];
}

interface PredictionCropCatalogEntry {
  code: string;
  displayName: string;
  groupLabel: string;
  kcIni: number;
  kcMid: number;
  kcEnd: number;
}

const PREDICTION_CROPS = predictionCropCatalog as PredictionCropCatalogEntry[];
const GROUP_ORDER = Array.from(new Set(PREDICTION_CROPS.map((crop) => crop.groupLabel)));

export const CROP_GROUPS: CropGroup[] = GROUP_ORDER.map((groupLabel) => ({
  groupLabel,
  crops: PREDICTION_CROPS
    .filter((crop) => crop.groupLabel === groupLabel)
    .map((crop) => ({
      value: crop.code,
      label: crop.displayName,
      kc_ini: crop.kcIni,
      kc_mid: crop.kcMid,
      kc_end: crop.kcEnd,
    })),
})).filter((group) => group.crops.length > 0);

const KC_MAP: Record<string, CropEntry> = Object.fromEntries(
  CROP_GROUPS.flatMap((group) => group.crops).map((crop) => [crop.value, crop])
);

const STAGE_KC_KEY: Record<string, keyof Pick<CropEntry, 'kc_ini' | 'kc_mid' | 'kc_end'>> = {
  dormancy: 'kc_end',
  budbreak: 'kc_ini',
  fruitset: 'kc_mid',
  veraison: 'kc_mid',
  harvest: 'kc_end',
  default: 'kc_mid',
};

export function getCropKc(
  cropType: string | null | undefined,
  phenologicalStage: string | null | undefined,
): number | null {
  if (!cropType || cropType === 'other') return null;
  const entry = KC_MAP[cropType];
  if (!entry) return null;
  const key = STAGE_KC_KEY[phenologicalStage ?? 'default'] ?? 'kc_mid';
  return entry[key];
}

export function getCropEntry(cropType: string | null | undefined): CropEntry | null {
  if (!cropType) return null;
  return KC_MAP[cropType] ?? null;
}

export const CROP_OPTIONS_FLAT: Array<{ value: string; label: string }> = [
  { value: '', label: '— Select crop —' },
  ...CROP_GROUPS.flatMap((group) => group.crops.map((crop) => ({ value: crop.value, label: crop.label }))),
];

export const PREDICTION_CROP_CODES = PREDICTION_CROPS.map((crop) => crop.code);
