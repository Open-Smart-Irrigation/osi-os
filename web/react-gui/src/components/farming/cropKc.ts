/**
 * FAO-56 Penman-Monteith crop coefficient (Kc) reference data.
 * Source: Allen et al. (1998) Crop Evapotranspiration —
 *         FAO Irrigation and Drainage Paper No. 56, Table 12.
 *
 * Kc_ini  = initial growth stage (crop establishment)
 * Kc_mid  = mid-season (full canopy, peak demand)
 * Kc_end  = late season (senescence / post-harvest)
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

// ── FAO-56 Kc table ───────────────────────────────────────────────────────────

export const CROP_GROUPS: CropGroup[] = [
  {
    groupLabel: 'Field Crops',
    crops: [
      { value: 'maize',      label: 'Maize / Corn', kc_ini: 0.30, kc_mid: 1.20, kc_end: 0.35 },
      { value: 'wheat',      label: 'Wheat',        kc_ini: 0.30, kc_mid: 1.15, kc_end: 0.30 },
      { value: 'potato',     label: 'Potato',       kc_ini: 0.50, kc_mid: 1.15, kc_end: 0.75 },
      { value: 'sugar_beet', label: 'Sugar Beet',   kc_ini: 0.35, kc_mid: 1.20, kc_end: 0.70 },
    ],
  },
  {
    groupLabel: 'Vegetables',
    crops: [
      { value: 'tomato',  label: 'Tomato',  kc_ini: 0.60, kc_mid: 1.15, kc_end: 0.70 },
      { value: 'cabbage', label: 'Cabbage', kc_ini: 0.45, kc_mid: 1.05, kc_end: 0.90 },
    ],
  },
  {
    groupLabel: 'Fruit Trees',
    crops: [
      { value: 'apple', label: 'Apple', kc_ini: 0.45, kc_mid: 0.95, kc_end: 0.70 },
    ],
  },
];

// ── Flat lookup map ───────────────────────────────────────────────────────────

const KC_MAP: Record<string, CropEntry> = Object.fromEntries(
  CROP_GROUPS.flatMap(g => g.crops).map(c => [c.value, c])
);

// ── Phenological stage → FAO growth stage ────────────────────────────────────

const STAGE_KC_KEY: Record<string, keyof Pick<CropEntry, 'kc_ini' | 'kc_mid' | 'kc_end'>> = {
  dormancy:  'kc_end',   // minimal water use, closest to late season
  budbreak:  'kc_ini',   // early establishment / initial stage
  fruitset:  'kc_mid',   // rapid development into mid-season
  veraison:  'kc_mid',   // peak demand
  harvest:   'kc_end',   // senescence / post-harvest
  default:   'kc_mid',   // conservative: peak demand as default
};

// ── Public helpers ────────────────────────────────────────────────────────────

/**
 * Look up FAO-56 Kc for the given crop and phenological stage.
 * Returns null if crop is unknown.
 */
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

/**
 * Get the CropEntry for a given crop type value, or null.
 */
export function getCropEntry(cropType: string | null | undefined): CropEntry | null {
  if (!cropType) return null;
  return KC_MAP[cropType] ?? null;
}

/** Flat list for a simple <select> without groups (fallback). */
export const CROP_OPTIONS_FLAT: Array<{ value: string; label: string }> = [
  { value: '', label: '— Select crop —' },
  ...CROP_GROUPS.flatMap(g => g.crops.map(c => ({ value: c.value, label: c.label }))),
  { value: 'other', label: 'Other / Custom' },
];
