'use strict';
// osi-crop-kc: the FAO-56 crop coefficient resolver. crop-kc.json here is a
// byte copy of docs/contracts/agronomy/crop-kc.json (verify-agronomy-contract).
// Contract v2 (spec docs/superpowers/specs/2026-09-27-daily-agronomy-parity-design.md,
// A5): with a stage start date and the stage's Table 11 length, the
// development and late-season stages follow FAO-56 equation 66 day by day.
const catalogue = require('./crop-kc.json');

const STAGES = Object.freeze(['initial', 'development', 'mid_season', 'late_season', 'dormancy']);
const LEGACY = Object.freeze({
  budbreak: 'initial', bud_break: 'initial',
  fruitset: 'development', cell_division: 'development', cell_expansion: 'development',
  veraison: 'mid_season', fruit_maturation: 'mid_season',
  harvest: 'late_season', post_harvest: 'late_season',
  dormancy: 'dormancy',
});
const HEURISTIC = Object.freeze({ initial: 0.45, development: 0.70, mid_season: 0.90, late_season: 0.60, dormancy: 0.25, unset: 0.75 });
const DAY_MS = 86400000;
const byId = new Map(catalogue.crops.map((crop) => [crop.id, crop]));

function round2(value) { return Math.round(value * 100) / 100; }

function normalizeStage(value) {
  const s = String(value == null ? '' : value).trim().toLowerCase();
  if (STAGES.includes(s)) return s;
  return LEGACY[s] || null;
}

function cropById(id) {
  return byId.get(String(id == null ? '' : id).trim().toLowerCase()) || null;
}

// A calendar date 'YYYY-MM-DD' as whole days since 1970-01-01 (Date.UTC
// parts, so daylight saving never moves it); null for anything else,
// including an impossible date such as 2026-02-30.
function dayNumber(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value == null ? '' : value));
  // Date.UTC maps the years 0-99 to 1900-1999; the contract refuses them (spec A5).
  if (!m || Number(m[1]) < 100) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return new Date(ms).toISOString().slice(0, 10) === m[0] ? ms / DAY_MS : null;
}

// FAO-56 eq. 66 for a stage that started d whole days ago (d = 0 on the start
// date): FAO's day in the stage is d + 1, clamped to the stage's length. The
// operation order is part of the contract (A5).
function kcRamp(prev, next, d, L) {
  const p = Math.min(1, Math.max(0, (d + 1) / L));
  return round2(prev + p * (next - prev));
}

function stageLengths(cropId) {
  const crop = cropById(cropId);
  if (!crop) return null;
  const s = crop.stage_lengths_days;
  return { initial: s.initial, development: s.development, mid_season: s.mid_season, late_season: s.late_season };
}

function resolveKc({ cropType, phenologicalStage, stageStartedOn = null, date = null }) {
  const stage = normalizeStage(phenologicalStage);
  const crop = cropById(cropType);
  if (!crop) return { kc: HEURISTIC[stage || 'unset'], kcSource: 'heuristic_phenology', cropId: null, stage, kcStageDay: null, stageOverrun: null };
  if (!stage) return { kc: round2(crop.kc_mid), kcSource: 'fao56_crop_stage_unset', cropId: crop.id, stage: null, kcStageDay: null, stageOverrun: null };
  // Without a start date the ramp stages take the table value they end on
  // (development: kc_mid) or reach (late season: kc_end).
  const table = { initial: crop.kc_ini, development: crop.kc_mid, mid_season: crop.kc_mid, late_season: crop.kc_end, dormancy: 0.25 };
  const out = { kc: round2(table[stage]), kcSource: 'fao56_crop', cropId: crop.id, stage, kcStageDay: null, stageOverrun: null };
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

module.exports = { catalogue, STAGES, normalizeStage, cropById, resolveKc, stageLengths, kcRamp };
