#!/usr/bin/env node
'use strict';
// Regenerates docs/contracts/agronomy/kc-vectors.json from crop-kc.json and
// the Kc rules in the README (contract v2: the FAO-56 curve, spec
// docs/superpowers/specs/2026-09-27-daily-agronomy-parity-design.md, A5-A6).
// It carries its own copy of the rule, so the vectors do not come from the
// code they test. Every runtime (edge helper, edge GUI, cloud backend, cloud
// frontend) reproduces every record exactly.
const fs = require('fs');
const path = require('path');
const dir = path.join(__dirname, '..', 'docs', 'contracts', 'agronomy');
const catalogue = JSON.parse(fs.readFileSync(path.join(dir, 'crop-kc.json'), 'utf8'));
const HEURISTIC = { initial: 0.45, development: 0.70, mid_season: 0.90, late_season: 0.60, dormancy: 0.25, unset: 0.75 };
const LEGACY = { budbreak: 'initial', bud_break: 'initial', fruitset: 'development', cell_division: 'development', cell_expansion: 'development', veraison: 'mid_season', fruit_maturation: 'mid_season', harvest: 'late_season', post_harvest: 'late_season', dormancy: 'dormancy' };
const STAGES = ['initial', 'development', 'mid_season', 'late_season', 'dormancy'];
const DAY_MS = 86400000;
function round2(v) { return Math.round(v * 100) / 100; }
function normalizeStage(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  if (STAGES.includes(s)) return s;
  return LEGACY[s] || null;
}
function isoDay(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value == null ? '' : value));
  // Date.UTC maps the years 0-99 to 1900-1999; the contract refuses them (spec A5).
  if (!m || Number(m[1]) < 100) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return new Date(ms).toISOString().slice(0, 10) === m[0] ? ms / DAY_MS : null;
}
function ramp(prev, next, d, L) {
  const p = Math.min(1, Math.max(0, (d + 1) / L));
  return round2(prev + p * (next - prev));
}
function resolve(cropType, stageIn, stageStartedOn, date) {
  const stage = normalizeStage(stageIn);
  const id = String(cropType == null ? '' : cropType).trim().toLowerCase();
  const crop = catalogue.crops.find((c) => c.id === id);
  if (!crop) return { kc: HEURISTIC[stage || 'unset'], kcSource: 'heuristic_phenology', cropId: null, stage, kcStageDay: null, stageOverrun: null };
  const table = { initial: crop.kc_ini, development: crop.kc_mid, mid_season: crop.kc_mid, late_season: crop.kc_end, dormancy: 0.25 };
  if (!stage) return { kc: round2(crop.kc_mid), kcSource: 'fao56_crop_stage_unset', cropId: crop.id, stage: null, kcStageDay: null, stageOverrun: null };
  const out = { kc: round2(table[stage]), kcSource: 'fao56_crop', cropId: crop.id, stage, kcStageDay: null, stageOverrun: null };
  if (stage === 'dormancy') return out;
  const L = crop.stage_lengths_days[stage];
  const start = isoDay(stageStartedOn);
  const day = isoDay(date);
  if (L == null || start == null || day == null) return out;
  const d = day - start;
  out.kcStageDay = d + 1;
  out.stageOverrun = d + 1 > L;
  if (stage === 'development') { out.kc = ramp(crop.kc_ini, crop.kc_mid, d, L); out.kcSource = 'fao56_curve'; }
  if (stage === 'late_season') { out.kc = ramp(crop.kc_mid, crop.kc_end, d, L); out.kcSource = 'fao56_curve'; }
  return out;
}
function record(cropType, phenologicalStage, stageStartedOn, date) {
  return { cropType, phenologicalStage, stageStartedOn, date, ...resolve(cropType, phenologicalStage, stageStartedOn, date) };
}
function plusDays(iso, n) { return new Date(Date.parse(iso + 'T00:00:00Z') + n * DAY_MS).toISOString().slice(0, 10); }

const vectors = [];
// The 1,252 v1 records, undated: their values do not change.
for (const crop of catalogue.crops) {
  for (const stage of [...STAGES, null, 'default', 'budbreak', 'veraison']) vectors.push(record(crop.id, stage, null, null));
}
for (const cropType of ['other', 'unknown_crop', null, '']) {
  for (const stage of [...STAGES, null, 'harvest']) vectors.push(record(cropType, stage, null, null));
}
// 70 dated ramp cases (A6): five crops, both ramp stages, seven cases each.
const START = '2026-05-01';
for (const cropType of ['maize', 'tomato', 'potato', 'grapevine', 'apple']) {
  const crop = catalogue.crops.find((c) => c.id === cropType);
  for (const stage of ['development', 'late_season']) {
    const L = crop.stage_lengths_days[stage];
    for (const d of [0, Math.floor(L / 2), L - 1, L, L + 10, -5]) vectors.push(record(cropType, stage, START, plusDays(START, d)));
    vectors.push(record(cropType, stage, null, '2026-05-21'));
  }
}
// 13 cases on the edges of the rule (A6).
for (const cropType of ['maize', 'tomato', 'potato', 'grapevine', 'apple']) vectors.push(record(cropType, 'dormancy', START, '2026-05-11'));
vectors.push(record('grass', 'development', START, '2026-05-11'));
vectors.push(record('grass', 'late_season', START, '2026-05-11'));
vectors.push(record('maize', 'initial', START, '2026-05-11'));
vectors.push(record('maize', 'initial', START, '2026-06-05'));
vectors.push(record('maize', 'mid_season', START, '2026-05-11'));
vectors.push(record('maize', 'late_season', START, '2026-05-15'));
vectors.push(record('maize', 'default', START, '2026-05-11'));
vectors.push(record('other', 'development', START, '2026-05-11'));
fs.writeFileSync(path.join(dir, 'kc-vectors.json'), JSON.stringify(vectors, null, 2) + '\n');
console.log('kc-vectors:', vectors.length);
