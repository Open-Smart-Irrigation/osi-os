import catalogueJson from './crop-kc.json';
import predictionCropCatalog from '../components/farming/predictionCropCatalog.json';

/** The FAO-56 Kc resolver, the GUI copy of osi-crop-kc (same contract vectors). */
export type StageId = 'initial' | 'development' | 'mid_season' | 'late_season' | 'dormancy';
export type StageFamily = 'woody' | 'annual';
export type KcSource = 'fao56_crop' | 'fao56_crop_stage_unset' | 'fao56_curve' | 'heuristic_phenology';
export interface StageLengths { initial: number | null; development: number | null; mid_season: number | null; late_season: number | null }
export interface StageLengthRow extends StageLengths { table11_row: string; plant_date: string; region: string; selection_rule: string; verified: boolean }
export interface CropEntry { id: string; group: string; label: string; kc_ini: number; kc_mid: number; kc_end: number; variant_of: string | null; fao_row: string | null; stage_lengths_days: StageLengthRow; stage_length_alternatives: StageLengthRow[] }
export interface KcResult { kc: number; kcSource: KcSource; cropId: string | null; stage: StageId | null; kcStageDay: number | null; stageOverrun: boolean | null }
export interface CropGroupEntry { id: string; order: number; label: string; stageFamily: StageFamily }
interface Catalogue { version: number; luxPerWm2: number; stationWindHeightM: number; stages: Array<{ id: StageId; order: number; label: string }>; groups: CropGroupEntry[]; crops: CropEntry[] }

export const CATALOGUE = catalogueJson as Catalogue;
export const STAGES: StageId[] = ['initial', 'development', 'mid_season', 'late_season', 'dormancy'];
const LEGACY: Record<string, StageId> = {
  budbreak: 'initial', bud_break: 'initial',
  fruitset: 'development', cell_division: 'development', cell_expansion: 'development',
  veraison: 'mid_season', fruit_maturation: 'mid_season',
  harvest: 'late_season', post_harvest: 'late_season',
  dormancy: 'dormancy',
};
const HEURISTIC: Record<StageId | 'unset', number> = { initial: 0.45, development: 0.7, mid_season: 0.9, late_season: 0.6, dormancy: 0.25, unset: 0.75 };
const BY_ID = new Map(CATALOGUE.crops.map((crop) => [crop.id, crop]));
const round2 = (v: number) => Math.round(v * 100) / 100;
const DAY_MS = 86400000;

export function normalizeStage(value: unknown): StageId | null {
  const s = String(value ?? '').trim().toLowerCase();
  if ((STAGES as string[]).includes(s)) return s as StageId;
  return LEGACY[s] ?? null;
}

export function cropById(id: unknown): CropEntry | null {
  return BY_ID.get(String(id ?? '').trim().toLowerCase()) ?? null;
}

/**
 * A stored crop as the crop selector's value: a catalogue id or 'other' in
 * the catalogue's lower case (a stored 'Maize' selects the maize option),
 * anything else as stored, so a legacy value keeps its own option.
 */
export function formCropValue(value: unknown): string {
  const stored = String(value ?? '').trim();
  const lower = stored.toLowerCase();
  return cropById(lower) || lower === 'other' ? lower : stored;
}

/** A calendar date 'YYYY-MM-DD' as whole days since 1970-01-01 (Date.UTC parts); null for anything else. */
function dayNumber(value: unknown): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? ''));
  // Date.UTC maps the years 0-99 to 1900-1999; the contract refuses them (spec A5).
  if (!m || Number(m[1]) < 100) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return new Date(ms).toISOString().slice(0, 10) === m[0] ? ms / DAY_MS : null;
}

/** FAO-56 eq. 66: FAO's day in the stage is d + 1 (1 on the start date), clamped to the stage length. */
export function kcRamp(prev: number, next: number, d: number, L: number): number {
  const p = Math.min(1, Math.max(0, (d + 1) / L));
  return round2(prev + p * (next - prev));
}

/** The default Table 11 lengths of a catalogue crop, or null for a crop outside the catalogue. */
export function stageLengths(cropId: unknown): StageLengths | null {
  const crop = cropById(cropId);
  if (!crop) return null;
  const s = crop.stage_lengths_days;
  return { initial: s.initial, development: s.development, mid_season: s.mid_season, late_season: s.late_season };
}

export function resolveKc({ cropType, phenologicalStage, stageStartedOn = null, date = null }: { cropType: unknown; phenologicalStage: unknown; stageStartedOn?: unknown; date?: unknown }): KcResult {
  const stage = normalizeStage(phenologicalStage);
  const crop = cropById(cropType);
  if (!crop) return { kc: HEURISTIC[stage ?? 'unset'], kcSource: 'heuristic_phenology', cropId: null, stage, kcStageDay: null, stageOverrun: null };
  if (!stage) return { kc: round2(crop.kc_mid), kcSource: 'fao56_crop_stage_unset', cropId: crop.id, stage: null, kcStageDay: null, stageOverrun: null };
  // Without a start date the ramp stages take the table value they end on
  // (development: kc_mid) or reach (late season: kc_end), contract v2 A5.
  const table: Record<StageId, number> = { initial: crop.kc_ini, development: crop.kc_mid, mid_season: crop.kc_mid, late_season: crop.kc_end, dormancy: 0.25 };
  const out: KcResult = { kc: round2(table[stage]), kcSource: 'fao56_crop', cropId: crop.id, stage, kcStageDay: null, stageOverrun: null };
  if (stage === 'dormancy') return out;
  const L = crop.stage_lengths_days[stage];
  const start = dayNumber(stageStartedOn);
  const day = dayNumber(date);
  if (L == null || start == null || day == null) return out;
  const d = day - start;
  out.kcStageDay = d + 1;
  out.stageOverrun = d + 1 > L;
  if (stage === 'development') { out.kc = kcRamp(crop.kc_ini, crop.kc_mid, d, L); out.kcSource = 'fao56_curve'; }
  if (stage === 'late_season') { out.kc = kcRamp(crop.kc_mid, crop.kc_end, d, L); out.kcSource = 'fao56_curve'; }
  return out;
}

export function stageFamily(cropType: unknown): StageFamily {
  const crop = cropById(cropType);
  return CATALOGUE.groups.find((g) => g.id === crop?.group)?.stageFamily ?? 'annual';
}

export const CROP_OPTION_GROUPS = [...CATALOGUE.groups].sort((a, b) => a.order - b.order).map((group) => ({
  group,
  crops: CATALOGUE.crops.filter((c) => c.group === group.id && !c.variant_of).map((crop) => ({ crop, variants: CATALOGUE.crops.filter((v) => v.variant_of === crop.id) })),
}));

export const PREDICTION_CROP_NAMES: string[] = (predictionCropCatalog as Array<{ displayName: string }>).map((c) => c.displayName);
