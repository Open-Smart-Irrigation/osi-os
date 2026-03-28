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
    groupLabel: 'Fruit Trees',
    crops: [
      { value: 'apple',   label: 'Apple',              kc_ini: 0.45, kc_mid: 1.20, kc_end: 0.85 },
      { value: 'pear',    label: 'Pear',               kc_ini: 0.45, kc_mid: 1.20, kc_end: 0.85 },
      { value: 'cherry',  label: 'Cherry',             kc_ini: 0.45, kc_mid: 1.20, kc_end: 0.85 },
      { value: 'peach',   label: 'Peach / Nectarine',  kc_ini: 0.45, kc_mid: 1.20, kc_end: 0.85 },
      { value: 'plum',    label: 'Plum',               kc_ini: 0.45, kc_mid: 1.20, kc_end: 0.85 },
      { value: 'apricot', label: 'Apricot',            kc_ini: 0.45, kc_mid: 1.10, kc_end: 0.65 },
      { value: 'olive',   label: 'Olive',              kc_ini: 0.65, kc_mid: 0.70, kc_end: 0.70 },
      { value: 'citrus',  label: 'Citrus',             kc_ini: 0.70, kc_mid: 0.65, kc_end: 0.70 },
      { value: 'fig',     label: 'Fig',                kc_ini: 0.50, kc_mid: 1.15, kc_end: 0.85 },
      { value: 'pomegranate', label: 'Pomegranate',    kc_ini: 0.50, kc_mid: 0.90, kc_end: 0.75 },
    ],
  },
  {
    groupLabel: 'Vines & Berries',
    crops: [
      { value: 'grapevine',   label: 'Grapevine (wine/table)', kc_ini: 0.30, kc_mid: 0.85, kc_end: 0.45 },
      { value: 'strawberry',  label: 'Strawberry',             kc_ini: 0.40, kc_mid: 0.85, kc_end: 0.75 },
      { value: 'blueberry',   label: 'Blueberry',              kc_ini: 0.40, kc_mid: 0.85, kc_end: 0.60 },
      { value: 'raspberry',   label: 'Raspberry / Blackberry', kc_ini: 0.40, kc_mid: 1.05, kc_end: 0.85 },
      { value: 'kiwi',        label: 'Kiwi',                   kc_ini: 0.40, kc_mid: 1.05, kc_end: 1.05 },
    ],
  },
  {
    groupLabel: 'Nuts',
    crops: [
      { value: 'walnut',    label: 'Walnut',   kc_ini: 0.50, kc_mid: 1.10, kc_end: 0.65 },
      { value: 'almond',    label: 'Almond',   kc_ini: 0.40, kc_mid: 0.90, kc_end: 0.65 },
      { value: 'pistachio', label: 'Pistachio', kc_ini: 0.40, kc_mid: 1.00, kc_end: 0.45 },
      { value: 'hazelnut',  label: 'Hazelnut', kc_ini: 0.45, kc_mid: 1.05, kc_end: 0.65 },
      { value: 'pecan',     label: 'Pecan',    kc_ini: 0.50, kc_mid: 1.10, kc_end: 0.65 },
    ],
  },
  {
    groupLabel: 'Vegetables',
    crops: [
      { value: 'tomato',      label: 'Tomato',          kc_ini: 0.60, kc_mid: 1.15, kc_end: 0.70 },
      { value: 'pepper',      label: 'Pepper / Capsicum', kc_ini: 0.60, kc_mid: 1.05, kc_end: 0.90 },
      { value: 'eggplant',    label: 'Eggplant / Aubergine', kc_ini: 0.60, kc_mid: 1.05, kc_end: 0.90 },
      { value: 'cucumber',    label: 'Cucumber',         kc_ini: 0.60, kc_mid: 1.00, kc_end: 0.75 },
      { value: 'watermelon',  label: 'Watermelon',       kc_ini: 0.40, kc_mid: 1.00, kc_end: 0.75 },
      { value: 'potato',      label: 'Potato',           kc_ini: 0.50, kc_mid: 1.15, kc_end: 0.75 },
      { value: 'onion',       label: 'Onion',            kc_ini: 0.70, kc_mid: 1.05, kc_end: 0.75 },
      { value: 'carrot',      label: 'Carrot',           kc_ini: 0.70, kc_mid: 1.05, kc_end: 0.95 },
      { value: 'lettuce',     label: 'Lettuce',          kc_ini: 0.70, kc_mid: 1.00, kc_end: 0.95 },
      { value: 'cabbage',     label: 'Cabbage / Broccoli', kc_ini: 0.70, kc_mid: 1.05, kc_end: 0.95 },
      { value: 'green_bean',  label: 'Green Bean',       kc_ini: 0.50, kc_mid: 1.05, kc_end: 0.90 },
      { value: 'peas',        label: 'Peas',             kc_ini: 0.50, kc_mid: 1.15, kc_end: 1.10 },
      { value: 'spinach',     label: 'Spinach',          kc_ini: 0.70, kc_mid: 1.00, kc_end: 0.95 },
      { value: 'garlic',      label: 'Garlic',           kc_ini: 0.70, kc_mid: 1.00, kc_end: 0.70 },
    ],
  },
  {
    groupLabel: 'Field Crops',
    crops: [
      { value: 'wheat',       label: 'Wheat',           kc_ini: 0.30, kc_mid: 1.15, kc_end: 0.30 },
      { value: 'maize',       label: 'Maize / Corn',    kc_ini: 0.30, kc_mid: 1.20, kc_end: 0.35 },
      { value: 'rice',        label: 'Rice (paddy)',     kc_ini: 1.05, kc_mid: 1.20, kc_end: 0.75 },
      { value: 'soybean',     label: 'Soybean',         kc_ini: 0.40, kc_mid: 1.15, kc_end: 0.50 },
      { value: 'cotton',      label: 'Cotton',          kc_ini: 0.35, kc_mid: 1.15, kc_end: 0.70 },
      { value: 'sunflower',   label: 'Sunflower',       kc_ini: 0.35, kc_mid: 1.10, kc_end: 0.35 },
      { value: 'sorghum',     label: 'Sorghum',         kc_ini: 0.30, kc_mid: 1.00, kc_end: 0.55 },
      { value: 'sugarcane',   label: 'Sugarcane',       kc_ini: 0.40, kc_mid: 1.25, kc_end: 0.75 },
      { value: 'groundnut',   label: 'Groundnut / Peanut', kc_ini: 0.40, kc_mid: 1.15, kc_end: 0.60 },
      { value: 'cassava',     label: 'Cassava',         kc_ini: 0.30, kc_mid: 0.80, kc_end: 0.30 },
      { value: 'sweet_potato', label: 'Sweet Potato',   kc_ini: 0.50, kc_mid: 1.15, kc_end: 0.65 },
    ],
  },
  {
    groupLabel: 'Tropical / Subtropical',
    crops: [
      { value: 'banana',    label: 'Banana',   kc_ini: 0.50, kc_mid: 1.10, kc_end: 1.00 },
      { value: 'mango',     label: 'Mango',    kc_ini: 0.60, kc_mid: 1.05, kc_end: 0.75 },
      { value: 'avocado',   label: 'Avocado',  kc_ini: 0.60, kc_mid: 0.85, kc_end: 0.75 },
      { value: 'pineapple', label: 'Pineapple', kc_ini: 0.50, kc_mid: 0.30, kc_end: 0.30 },
      { value: 'papaya',    label: 'Papaya',   kc_ini: 0.60, kc_mid: 1.05, kc_end: 0.90 },
      { value: 'coffee',    label: 'Coffee',   kc_ini: 0.90, kc_mid: 0.95, kc_end: 0.90 },
      { value: 'tea',       label: 'Tea',      kc_ini: 0.95, kc_mid: 1.00, kc_end: 1.00 },
      { value: 'cocoa',     label: 'Cocoa',    kc_ini: 1.00, kc_mid: 1.05, kc_end: 1.05 },
    ],
  },
  {
    groupLabel: 'Forage',
    crops: [
      { value: 'alfalfa',     label: 'Alfalfa',           kc_ini: 0.40, kc_mid: 1.20, kc_end: 1.15 },
      { value: 'grass',       label: 'Grass / Pasture',   kc_ini: 0.90, kc_mid: 1.00, kc_end: 1.00 },
      { value: 'bermuda',     label: 'Bermuda Grass',     kc_ini: 0.55, kc_mid: 0.85, kc_end: 0.75 },
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
