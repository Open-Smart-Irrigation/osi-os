#!/usr/bin/env node
'use strict';
// verify-agronomy-contract: docs/contracts/agronomy is the source; every copy
// must be byte-identical, and the edge modules must reproduce the vectors.
// Contract v2 (spec docs/superpowers/specs/2026-09-27-daily-agronomy-parity-design.md,
// A1 and B1). Given an osi-server checkout as the first argument (CI passes
// `osi-server`; locally `node scripts/verify-agronomy-contract.js $CLOUD_WT`),
// the four cloud copies are byte-compared too.
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const dir = path.join(root, 'docs', 'contracts', 'agronomy');
const source = fs.readFileSync(path.join(dir, 'crop-kc.json'));
const copies = [
  'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-crop-kc/crop-kc.json',
  'conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-crop-kc/crop-kc.json',
  'web/react-gui/src/agronomy/crop-kc.json',
];
const CLOUD_COPIES = [
  ['backend/src/main/resources/agronomy/crop-kc.json', 'crop-kc.json'],
  ['frontend/src/agronomy/crop-kc.json', 'crop-kc.json'],
  ['backend/src/test/resources/agronomy/kc-vectors.json', 'kc-vectors.json'],
  ['backend/src/test/resources/agronomy/et0-vectors.json', 'et0-vectors.json'],
];
const LENGTH_FIELDS = ['initial', 'development', 'mid_season', 'late_season'];
const PROVENANCE_FIELDS = ['table11_row', 'plant_date', 'region', 'selection_rule'];
const failures = [];
for (const rel of copies) {
  const abs = path.join(root, rel);
  if (!fs.existsSync(abs)) { failures.push(rel + ': missing'); continue; }
  if (Buffer.compare(fs.readFileSync(abs), source) !== 0) failures.push(rel + ': differs from docs/contracts/agronomy/crop-kc.json');
}
const catalogue = JSON.parse(source.toString('utf8'));
if (catalogue.version !== 2) failures.push('crop-kc.json: version must be 2, found ' + catalogue.version);
const groups = new Set((catalogue.groups || []).map((g) => g.id));
for (const g of catalogue.groups || []) if (!['woody', 'annual'].includes(g.stageFamily)) failures.push('group ' + g.id + ': stageFamily must be woody or annual');
// A default length is a positive integer or null (A1). An alternative may
// also carry Table 11's printed 0 ("Faba bean, broad bean - green", late
// season): no code reads alternatives, and the cell stays verbatim.
function lengthRowProblems(label, s, allowZero = false) {
  const out = [];
  if (!s || typeof s !== 'object' || Array.isArray(s)) return [label + ' must be an object'];
  const keys = Object.keys(s);
  const want = [...LENGTH_FIELDS, ...PROVENANCE_FIELDS, 'verified'];
  if (keys.length !== want.length || want.some((k) => !keys.includes(k))) out.push(label + ' must have exactly ' + want.join(', '));
  for (const k of LENGTH_FIELDS) if (!(s[k] === null || (Number.isInteger(s[k]) && (s[k] > 0 || (allowZero && s[k] === 0))))) out.push(label + '.' + k + ' must be a positive integer or null');
  for (const k of PROVENANCE_FIELDS) if (typeof s[k] !== 'string') out.push(label + '.' + k + ' must be a string');
  if (typeof s.verified !== 'boolean') out.push(label + '.verified must be a boolean');
  return out;
}
const ids = new Set();
for (const crop of catalogue.crops) {
  if (ids.has(crop.id)) failures.push('duplicate crop id ' + crop.id);
  ids.add(crop.id);
  if (!groups.has(crop.group)) failures.push(crop.id + ': unknown group ' + crop.group);
  for (const k of ['kc_ini', 'kc_mid', 'kc_end']) if (!(crop[k] > 0 && crop[k] < 2)) failures.push(crop.id + ': ' + k + ' out of range');
  if (crop.variant_of && !catalogue.crops.some((c) => c.id === crop.variant_of && c.group === crop.group && !c.variant_of)) failures.push(crop.id + ': variant_of must name a default entry of the same group');
  failures.push(...lengthRowProblems(crop.id + '.stage_lengths_days', crop.stage_lengths_days));
  if (!Array.isArray(crop.stage_length_alternatives)) failures.push(crop.id + ': stage_length_alternatives must be an array');
  else crop.stage_length_alternatives.forEach((s, i) => failures.push(...lengthRowProblems(crop.id + '.stage_length_alternatives[' + i + ']', s, true)));
}
if (catalogue.crops.length !== 136) failures.push('expected 136 crops, found ' + catalogue.crops.length);
const kcModulePath = path.join(root, copies[0], '..', 'index.js');
const kc = require(kcModulePath);
const kcVectors = JSON.parse(fs.readFileSync(path.join(dir, 'kc-vectors.json'), 'utf8'));
if (kcVectors.length !== 1335) failures.push('kc-vectors.json: expected 1335 vectors, found ' + kcVectors.length);
let bad = 0;
for (const v of kcVectors) {
  const r = kc.resolveKc({ cropType: v.cropType, phenologicalStage: v.phenologicalStage, stageStartedOn: v.stageStartedOn, date: v.date });
  if (r.kc !== v.kc || r.kcSource !== v.kcSource || r.cropId !== v.cropId || r.stage !== v.stage || r.kcStageDay !== v.kcStageDay || r.stageOverrun !== v.stageOverrun) {
    bad += 1;
    if (bad <= 5) failures.push('kc vector mismatch: ' + JSON.stringify(v) + ' got ' + JSON.stringify(r));
  }
}
if (bad > 5) failures.push('kc vector mismatches: ' + bad);
// FAO-56 Example 28 (climate-adjusted Kc ini 0.15, Kc mid 1.19, Kc end 0.35): no catalogue row.
if (kc.kcRamp(0.15, 1.19, 14, 25) !== 0.77) failures.push('kcRamp: FAO-56 Example 28 day 40 must be 0.77');
if (kc.kcRamp(1.19, 0.35, 14, 20) !== 0.56) failures.push('kcRamp: FAO-56 Example 28 day 95 must be 0.56');
const et0 = require(path.join(root, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-agronomy-daily/et0.js'));
const vectors = JSON.parse(fs.readFileSync(path.join(dir, 'et0-vectors.json'), 'utf8'));
const near = (got, want, tol) => (want == null ? got === null : typeof got === 'number' && Math.abs(got - want) <= tol);
for (const v of [...vectors.fao56, ...vectors.fao56Rejects]) {
  const got = et0.fao56Et0(v.input);
  if (!near(got, v.et0Mm, 0.005)) failures.push('fao56 vector ' + v.name + ': expected ' + v.et0Mm + ' got ' + got);
}
for (const v of vectors.hargreaves) {
  const got = et0.hargreavesEt0(v.input);
  if (!near(got, v.et0Mm, 0.005)) failures.push('hargreaves vector ' + v.name + ': expected ' + v.et0Mm + ' got ' + got);
}
for (const v of vectors.luxToRadiation) {
  const got = et0.luxToWm2(v.lux, catalogue.luxPerWm2);
  if (!near(got, v.wm2, 0.01)) failures.push('lux vector ' + v.lux + ': expected ' + v.wm2 + ' got ' + got);
}
for (const v of vectors.elevationFromPressure) {
  const got = et0.elevationFromPressure(v.pressureKpa);
  if (!near(got, v.elevationM, 0.05)) failures.push('pressure vector ' + v.pressureKpa + ': expected ' + v.elevationM + ' got ' + got);
}
for (const v of vectors.fao56Hourly || []) {
  const terms = et0.fao56HourlyTerms(v.input);
  if (!terms) { failures.push('fao56Hourly vector ' + v.name + ': got null'); continue; }
  if (!near(terms.et0Mm, v.et0Mm, v.tolerance)) failures.push('fao56Hourly vector ' + v.name + ': expected ' + v.et0Mm + ' got ' + terms.et0Mm);
  for (const [name, want] of Object.entries(v.terms || {})) {
    const tol = v.termTolerance ? (v.termTolerance[name] ?? v.termTolerance.default) : v.tolerance;
    if (!near(terms[name], want, tol)) failures.push('fao56Hourly vector ' + v.name + '.' + name + ': expected ' + want + ' got ' + terms[name]);
  }
}
for (const v of vectors.fao56HourlyDays || []) {
  const day = et0.fao56Et0HourlyDay(v.input);
  if (!day) { failures.push('fao56HourlyDays vector ' + v.name + ': got null'); continue; }
  if (!near(day.sumMm, v.sumMm, 1e-4) || day.et0Mm !== v.et0Mm || !near(day.lastRsRso, v.lastRsRso, 1e-4)) failures.push('fao56HourlyDays vector ' + v.name + ': got ' + JSON.stringify({ sumMm: day.sumMm, et0Mm: day.et0Mm, lastRsRso: day.lastRsRso }));
  v.hourly.forEach((want, i) => {
    const got = day.hourly[i];
    if (!got || got.hourStartUtc !== want.hourStartUtc || !near(got.et0Mm, want.et0Mm, 1e-4) || got.sunUp !== want.sunUp || got.rsRsoSource !== want.rsRsoSource) failures.push('fao56HourlyDays vector ' + v.name + ' hour ' + want.hourStartUtc + ': got ' + JSON.stringify(got));
  });
}
if (!(vectors.fao56Hourly || []).length || !(vectors.fao56HourlyDays || []).length) failures.push('et0-vectors.json: fao56Hourly and fao56HourlyDays must not be empty');
let cloudLine = 'cloud copies not checked (pass an osi-server checkout as the first argument)';
const serverArg = process.argv[2];
if (serverArg) {
  const serverRoot = path.resolve(process.cwd(), serverArg);
  for (const [rel, name] of CLOUD_COPIES) {
    const abs = path.join(serverRoot, rel);
    if (!fs.existsSync(abs)) { failures.push('osi-server ' + rel + ': missing'); continue; }
    if (Buffer.compare(fs.readFileSync(abs), fs.readFileSync(path.join(dir, name))) !== 0) failures.push('osi-server ' + rel + ': differs from docs/contracts/agronomy/' + name);
  }
  cloudLine = 'cloud copies byte-identical in ' + serverRoot;
}
if (failures.length) { console.error('verify-agronomy-contract: FAIL\n  ' + failures.join('\n  ')); process.exit(1); }
console.log(cloudLine);
console.log('verify-agronomy-contract: OK (' + catalogue.crops.length + ' crops, contract v2, ' + kcVectors.length + ' Kc vectors, ' + vectors.fao56Hourly.length + ' hourly and ' + vectors.fao56HourlyDays.length + ' daily hourly-sum vectors, copies byte-identical)');
