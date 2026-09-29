"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const cp = require("node:child_process");

const modulePath = process.env.WATERMARK_ANALYZER_MODULE || "./watermark-drydown-analysis";
const analyzer = require(modulePath);
const legacyMode = Boolean(process.env.WATERMARK_ANALYZER_MODULE);
const criterion = (report, name) => report.criteria?.[name] || { verdict: "missing" };
const probe = (report, channel) => Array.isArray(report.probes) ? report.probes[channel - 1] : report.probes?.[channel];

const EUI = "A84041A171000001";
const CAL = {
  schema_version: 1, device_eui: EUI, sync_version: 1,
  pullup_1_ohm: 41670, pulldown_1_ohm: 41260, series_fwd_1_ohm: 130, series_rev_1_ohm: 112,
  pullup_2_ohm: 42530, pulldown_2_ohm: 42070, series_fwd_2_ohm: 46, series_rev_2_ohm: 27,
  provenance: { physical_board_id: "board-7", previous_device_eui: "E605002000000001", circuit_revision: "rev-c", source_record_path: "/records/old.json" }
};

function runMetadata(overrides = {}) {
  return {
    schema_version: 1, run_id: "run-1", operator: "bench-operator", recorded_at: "2026-10-01T00:00:00.000Z",
    identity: {
      physical_board_id: "board-7", previous_device_eui: "E605002000000001", current_device_eui: EUI,
      physical_board_statement: "same board and circuit was reprogrammed", uart_device_eui: EUI,
      chirpstack_device_eui: EUI, edge_device_eui: EUI
    },
    firmware: { commit: "0123456789abcdef0123456789abcdef01234567", image_sha256: "a".repeat(64), build_id: "build-1" },
    circuit: { revision: "rev-c", channel_1_probe_id: "wm1", channel_2_probe_id: "wm2" },
    calibration_record_path: "/records/old.json",
    capture: { source_type: "edge_db_csv", source_record: "sqlite3 -readonly export tool v1", raw_source_path: null, raw_source_sha256: null },
    ...overrides,
  };
}

function calibrationWithProvenance(overrides = {}) { return { ...CAL, ...overrides, provenance: { ...CAL.provenance, ...(overrides.provenance || {}) } }; }

function codeForResistance(ohm, cal, offsetMv = 0, supplyMv = 3300, earlyDelta = 0) {
  const f = (r, series) => Math.round(4095 * ((offsetMv / supplyMv) + (r + series) / cal.pullup) / (1 + (r + series) / cal.pullup));
  const rev = 4095 * cal.pulldown / (cal.pulldown + ohm + cal.seriesRev);
  const lateFwd = f(ohm, cal.seriesFwd);
  const lateRev = Math.round(rev);
  return { fwd_early: Math.max(1, lateFwd + earlyDelta), fwd: lateFwd, rev_early: Math.min(4094, lateRev - earlyDelta), rev: lateRev };
}

function framePayload({ channel1 = {}, channel2 = {}, temp = 24, status = 0x02, supply = 3300 } = {}) {
  const b = Buffer.alloc(27);
  b[0] = 0xa2; b[1] = 3; b.writeUInt16BE(supply, 2); b.writeInt16BE(Math.round(temp * 100), 4); b.writeInt16BE(2400, 6); b[8] = status;
  for (const [offset, ch] of [[9, channel1], [18, channel2]]) {
    b[offset] = ch.flags || 0;
    b.writeUInt16BE(ch.fwd_early, offset + 1); b.writeUInt16BE(ch.fwd, offset + 3);
    b.writeUInt16BE(ch.rev_early, offset + 5); b.writeUInt16BE(ch.rev, offset + 7);
  }
  return b.toString("hex").toUpperCase();
}

function reading({ id = "r1", at = "2026-10-01T00:00:00.000Z", fCnt = Number(id.replace(/\D/g, "")) || 0, r1 = 4000, r2 = 5000, temp = 24, supply = 3300, unsettled1 = false, unsettled2 = false, deveui = EUI, earlyDelta1 = unsettled1 ? 100 : 0, earlyDelta2 = unsettled2 ? 100 : 0, offsetMv1 = 0, offsetMv2 = 0, lowercasePayload = false } = {}) {
  const c1 = codeForResistance(r1, { pullup: CAL.pullup_1_ohm, pulldown: CAL.pulldown_1_ohm, seriesFwd: CAL.series_fwd_1_ohm, seriesRev: CAL.series_rev_1_ohm }, offsetMv1, 3300, earlyDelta1);
  const c2 = codeForResistance(r2, { pullup: CAL.pullup_2_ohm, pulldown: CAL.pulldown_2_ohm, seriesFwd: CAL.series_fwd_2_ohm, seriesRev: CAL.series_rev_2_ohm }, offsetMv2, 3300, earlyDelta2);
  const payload = framePayload({ channel1: { ...c1, flags: unsettled1 ? 0x04 : 0 }, channel2: { ...c2, flags: unsettled2 ? 0x04 : 0 }, temp, supply });
  return { id, deveui, recorded_at: at, f_cnt: fCnt, frame_status: "accepted", payload_hex: lowercasePayload ? payload.toLowerCase() : payload };
}

function referenceRows(rows) { return rows.map((r) => ({ reference_id: r.id, recorded_at: r.at, reference_c: r.celsius })); }
function atMinutes(minutes) { return new Date(Date.parse("2026-10-01T00:00:00.000Z") + minutes * 60000).toISOString(); }

function completeResistorMatrix({ phase, errorRel = 0 }) {
  const bands = [["R22", "2k2", 2200], ["R47", "4k7", 4700], ["R10", "10k", 10000], ["R15", "15k", 14500]];
  const rows = [];
  for (const channel of [1, 2]) for (const [resistor_id, nominal_band, nominal] of bands) for (const repeat of [1, 2, 3]) {
    const c = channel === 1 ? { pullup: CAL.pullup_1_ohm, pulldown: CAL.pulldown_1_ohm, seriesFwd: CAL.series_fwd_1_ohm, seriesRev: CAL.series_rev_1_ohm } : { pullup: CAL.pullup_2_ohm, pulldown: CAL.pulldown_2_ohm, seriesFwd: CAL.series_fwd_2_ohm, seriesRev: CAL.series_rev_2_ohm };
    const actual = nominal * (1 + errorRel);
    const code = codeForResistance(actual, c);
    rows.push({ resistor_id, nominal_band, channel, repeat, meter_ohm: nominal, fwd_early: code.fwd_early, fwd_late: code.fwd, rev_early: code.rev_early, rev_late: code.rev, supply_mv: 3300, phase });
  }
  return rows;
}

function csv(rows, columns = Object.keys(rows[0] || {})) { const escape = (value) => { const text = String(value ?? ""); return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text; }; return [columns.join(","), ...rows.map((row) => columns.map((c) => escape(row[c])).join(","))].join("\n") + "\n"; }

function analyzeFixture({ readings = [], before = completeResistorMatrix({ phase: "before" }), after = completeResistorMatrix({ phase: "after" }), references = [], metadata = runMetadata(), calibration = calibrationWithProvenance() } = {}) {
  const input = { readings, calibration, runMetadata: metadata, resistorsBefore: before, resistorsAfter: after, intervalMin: 5 };
  if (legacyMode) input.referenceTemperature = references;
  else input.references = references;
  return analyzer.analyze(input);
}

test("CSV quoting and required-column validation", () => {
  const parsed = analyzer.parseCsv("id,note\n1,\"a,b\"\n");
  assert.deepEqual(parsed, [{ id: "1", note: "a,b" }]);
  assert.throws(() => analyzer.parseCsv("id\n1\n", ["id", "recorded_at"]), /required column/i);
  assert.throws(() => analyzer.parseCsv("id,note\n1,a,b\n"), /columns/i);
});

test("complete 24-cell before and after matrices pass P1 and report all cells", () => {
  const report = analyzeFixture({ readings: [reading()] });
  assert.equal(report.criteria.P1.verdict, "pass");
  assert.equal(report.criteria.P1.cells.length, 48);
});

test("regression: P1 rejects a duplicate substituted for a missing cell", () => {
  const after = completeResistorMatrix({ phase: "after" });
  after.splice(after.findIndex((r) => r.channel === 2 && r.nominal_band === "10k" && r.repeat === 3), 1);
  after.push({ ...after.find((r) => r.channel === 2 && r.nominal_band === "2k2" && r.repeat === 3) });
  const report = analyzeFixture({ after });
  assert.equal(report.criteria.P1.verdict, "no_data");
  assert.deepEqual(report.criteria.P1.missing, ["2|10k|3"]);
  assert.deepEqual(report.criteria.P1.duplicates, ["2|2k2|3"]);
  assert.equal(report.verdict, "INCONCLUSIVE");
});

test("adversarial: a valid P1 failure outranks missing evidence", () => {
  const after = completeResistorMatrix({ phase: "after" });
  after.splice(after.findIndex((r) => r.channel === 2 && r.nominal_band === "10k" && r.repeat === 3), 1);
  const bad = after.find((r) => r.channel === 1 && r.nominal_band === "2k2" && r.repeat === 1);
  bad.fwd_late = 4095;
  const report = analyzeFixture({ after });
  assert.equal(report.criteria.P1.verdict, "fail");
  assert.ok(report.criteria.P1.missing.includes("2|10k|3"));
  assert.ok(report.criteria.P1.failures.some((c) => c.key === "1|2k2|1"));
  assert.equal(report.verdict, "FAIL");
});

test("electrically complete matrix with one late solve above tolerance fails P1", () => {
  const after = completeResistorMatrix({ phase: "after" });
  const bad = after.find((r) => r.channel === 1 && r.nominal_band === "10k" && r.repeat === 1);
  const c = { pullup: CAL.pullup_1_ohm, pulldown: CAL.pulldown_1_ohm, seriesFwd: CAL.series_fwd_1_ohm, seriesRev: CAL.series_rev_1_ohm };
  const code = codeForResistance(12000, c); Object.assign(bad, { fwd_late: code.fwd, rev_late: code.rev, fwd_early: code.fwd_early, rev_early: code.rev_early });
  const report = analyzeFixture({ after });
  assert.equal(report.criteria.P1.verdict, "fail");
});

test("resistor identity conflicts are structural no_data, while an unrelated ADC failure still dominates", () => {
  const after = completeResistorMatrix({ phase: "after" });
  const conflict = after.find((r) => r.resistor_id === "R22" && r.channel === 1 && r.repeat === 1);
  conflict.meter_ohm = 2300;
  const goodConflict = analyzeFixture({ after });
  assert.equal(goodConflict.criteria.P1.verdict, "no_data");
  assert.ok(goodConflict.criteria.P1.reason);
  const withFailure = completeResistorMatrix({ phase: "after" });
  const conflictAndFailure = withFailure.find((r) => r.resistor_id === "R22" && r.channel === 1 && r.repeat === 1);
  conflictAndFailure.meter_ohm = 2300;
  const unrelated = withFailure.find((r) => r.resistor_id === "R47" && r.channel === 2 && r.repeat === 1);
  unrelated.fwd_late = 4095;
  assert.equal(analyzeFixture({ after: withFailure }).criteria.P1.verdict, "fail");
});

test("syntactically valid unexpected resistor coordinates are structural evidence, not input errors", () => {
  const after = completeResistorMatrix({ phase: "after" });
  after[0].channel = 3; after[1].nominal_band = "unknown"; after[2].repeat = 4;
  const report = analyzeFixture({ after });
  assert.equal(report.criteria.P1.verdict, "no_data");
  assert.ok(report.criteria.P1.unexpected.length >= 3);
});

test("resistor whitespace is normalized before identity and meter consistency checks", () => {
  const after = completeResistorMatrix({ phase: "after" });
  for (const row of after) if (row.resistor_id === "R22") row.resistor_id = " R22 ";
  assert.equal(analyzeFixture({ after }).criteria.P1.verdict, "pass");
});

test("cross-file band remaps exclude that band while an unrelated valid ADC failure still dominates", () => {
  const after = completeResistorMatrix({ phase: "after" });
  for (const row of after) if (row.nominal_band === "2k2") row.resistor_id = "R22-new";
  const structural = analyzeFixture({ after });
  assert.equal(structural.criteria.P1.verdict, "no_data");
  const remapped = structural.criteria.P1.cells.filter((cell) => cell.band === "2k2");
  assert.ok(remapped.length > 0); assert.ok(remapped.every((cell) => cell.evidence_valid === false && cell.excluded_reason === "cross_file_band_resistor_remap"));
  const withFailure = completeResistorMatrix({ phase: "after" });
  for (const row of withFailure) if (row.nominal_band === "2k2") row.resistor_id = "R22-new";
  const unrelated = withFailure.find((r) => r.nominal_band === "4k7" && r.channel === 2 && r.repeat === 1); unrelated.fwd_late = 4095;
  assert.equal(analyzeFixture({ after: withFailure }).criteria.P1.verdict, "fail");
});

test("identity, provenance, EUI and capture validation reject before analysis", () => {
  assert.throws(() => analyzeFixture({ metadata: runMetadata({ identity: { ...runMetadata().identity, current_device_eui: "BAD" } }) }), /canonical|identity/i);
  assert.throws(() => analyzeFixture({ metadata: runMetadata({ identity: { ...runMetadata().identity, current_device_eui: EUI.toLowerCase(), uart_device_eui: EUI.toLowerCase(), chirpstack_device_eui: EUI.toLowerCase(), edge_device_eui: EUI.toLowerCase() } }) }), /canonical/i);
  assert.throws(() => analyzeFixture({ calibration: calibrationWithProvenance({ provenance: { ...CAL.provenance, physical_board_id: "other" } }) }), /provenance/i);
  assert.throws(() => analyzeFixture({ readings: [{ ...reading(), deveui: "" }] }), /deveui/i);
  assert.throws(() => analyzeFixture({ readings: [{ ...reading(), deveui: "0000000000000000" }] }), /deveui/i);
  assert.throws(() => analyzeFixture({ metadata: runMetadata({ capture: { source_type: "raw_logger_json", source_record: "convert v1", raw_source_path: null, raw_source_sha256: null } }) }), /raw.source/i);
  assert.throws(() => analyzeFixture({ metadata: runMetadata({ capture: { source_type: "edge_db_csv", source_record: "export", raw_source_path: "/tmp/a", raw_source_sha256: "a".repeat(64) } }) }), /raw.source/i);
  assert.throws(() => analyzeFixture({ metadata: runMetadata({ recorded_at: "2026-10-01T00:00:00" }) }), /timestamp|recorded/i);
  assert.throws(() => analyzeFixture({ readings: [{ ...reading(), recorded_at: "2026-10-01 00:00:00" }] }), /timestamp/i);
  assert.throws(() => analyzeFixture({ metadata: runMetadata({ recorded_at: "2026-02-30T00:00:00Z" }) }), /timestamp|recorded/i);
  assert.throws(() => analyzeFixture({ readings: [{ ...reading(), recorded_at: "2026-02-30T00:00:00Z" }] }), /timestamp/i);
  assert.throws(() => analyzeFixture({ references: [{ reference_id: "r", recorded_at: "2026-02-30T00:00:00Z", reference_c: 24 }] }), /timestamp|temperature|reference/i);
  assert.throws(() => analyzeFixture({ metadata: runMetadata({ identity: { ...runMetadata().identity, current_device_eui: ` ${EUI}` } }) }), /canonical/i);
  assert.throws(() => analyzeFixture({ metadata: runMetadata({ identity: { ...runMetadata().identity, previous_device_eui: ` ${runMetadata().identity.previous_device_eui}` } }) }), /canonical/i);
  assert.throws(() => analyzeFixture({ calibration: calibrationWithProvenance({ device_eui: ` ${EUI}` }) }), /calibration|canonical/i);
  assert.throws(() => analyzeFixture({ calibration: calibrationWithProvenance({ provenance: { ...CAL.provenance, previous_device_eui: ` ${CAL.provenance.previous_device_eui}` } }) }), /provenance|canonical/i);
});

test("accepted readings accept lowercase stored payload hex but require f_cnt and reject duplicate observation identity", () => {
  const lower = reading({ id: "lower", fCnt: 91, lowercasePayload: true });
  assert.equal(analyzeFixture({ readings: [lower] }).identity.current_device_eui, EUI);
  assert.throws(() => analyzeFixture({ readings: [lower, { ...lower, id: "duplicate", payload_hex: lower.payload_hex.toUpperCase() }] }), /duplicate.*(lower|duplicate).*91|observation identity/i);
  assert.throws(() => analyzeFixture({ readings: [{ ...lower, f_cnt: " " }] }), /f_cnt/i);
  assert.throws(() => analyzeFixture({ readings: [{ ...lower, f_cnt: -1 }] }), /f_cnt/i);
  assert.throws(() => analyzeFixture({ readings: [{ ...lower, deveui: EUI.toLowerCase() }] }), /canonical|deveui/i);
});

test("accepted frame identity is counter-bound, including timestamp changes and payload conflicts", () => {
  const first = reading({ id: "counter-a", fCnt: 17 });
  const same = { ...first, id: "counter-b", recorded_at: "2026-10-01T00:00:01Z" };
  assert.throws(() => analyzeFixture({ readings: [first, same] }), /duplicate.*counter-a.*counter-b|observation identity/i);
  const conflict = { ...same, payload_hex: reading({ id: "counter-c", fCnt: 18, r1: 5000 }).payload_hex };
  assert.throws(() => analyzeFixture({ readings: [first, conflict] }), /conflicting.*counter-a.*counter-b|counter-a.*counter-b|frame counter/i);
  assert.doesNotThrow(() => analyzeFixture({ readings: [first] }));
  assert.doesNotThrow(() => analyzeFixture({ readings: [{ ...first, id: "new-run-counter" }] }));
});

test("accepted frame counters must increase with recorded_at order, rejecting out-of-order and reset counters", () => {
  const outOfOrder = [
    reading({ id: "fc-a", fCnt: 5, at: atMinutes(0), r1: 4000 }),
    reading({ id: "fc-b", fCnt: 3, at: atMinutes(5), r1: 4200 }),
  ];
  assert.throws(() => analyzeFixture({ readings: outOfOrder }), /frame counter/i);

  const resetMidRun = [
    reading({ id: "fc-c", fCnt: 10, at: atMinutes(0), r1: 4000 }),
    reading({ id: "fc-d", fCnt: 11, at: atMinutes(5), r1: 4100 }),
    reading({ id: "fc-e", fCnt: 1, at: atMinutes(10), r1: 4200 }),
  ];
  assert.throws(() => analyzeFixture({ readings: resetMidRun }), /frame counter/i);

  const equalTimestampsIncreasingCounters = [
    reading({ id: "fc-f", fCnt: 20, at: atMinutes(0), r1: 4000 }),
    reading({ id: "fc-g", fCnt: 21, at: atMinutes(0), r1: 4100 }),
  ];
  assert.doesNotThrow(() => analyzeFixture({ readings: equalTimestampsIncreasingCounters }));
});

test("duplicate receptions cannot inflate a twelve-frame dry-down into PASS", () => {
  const unique = Array.from({ length: 12 }, (_, i) => reading({ id: `u${i}`, fCnt: i + 1, at: atMinutes(i * 5), r1: 2200 + i * 500, r2: 2300 + i * 500 }));
  const receptions = unique.flatMap((row) => [0, 1, 2].map((seconds) => ({ ...row, id: `${row.id}-${seconds}`, recorded_at: new Date(Date.parse(row.recorded_at) + seconds * 1000).toISOString() })));
  assert.equal(receptions.length, 36);
  assert.throws(() => analyzeFixture({ readings: receptions }), /duplicate.*observation|identity|frame counter/i);
});

test("strict manifest and calibration provenance rejects every required blank or mismatch", () => {
  const metadataCases = [
    ["run_id", (m) => { m.run_id = ""; }], ["operator", (m) => { m.operator = " "; }], ["recorded_at", (m) => { m.recorded_at = "not-a-time"; }],
    ["physical_board_id", (m) => { m.identity.physical_board_id = ""; }], ["previous_device_eui", (m) => { m.identity.previous_device_eui = "bad"; }],
    ["physical_board_statement", (m) => { m.identity.physical_board_statement = ""; }], ["firmware.build_id", (m) => { m.firmware.build_id = ""; }],
    ["circuit.revision", (m) => { m.circuit.revision = ""; }], ["channel_1_probe_id", (m) => { m.circuit.channel_1_probe_id = ""; }],
    ["channel_2_probe_id", (m) => { m.circuit.channel_2_probe_id = ""; }], ["calibration_record_path", (m) => { m.calibration_record_path = ""; }],
    ["capture.source_record", (m) => { m.capture.source_record = ""; }]
  ];
  for (const [name, mutate] of metadataCases) { const metadata = JSON.parse(JSON.stringify(runMetadata())); mutate(metadata); assert.throws(() => analyzeFixture({ metadata }), /metadata|identity|provenance|capture|recorded|run_id|operator|build_id|probe|circuit|source_record|calibration_record_path|physical_board|previous|canonical/i, name); }
  for (const [name, mutate] of [
    ["schema_version", (c) => { c.schema_version = 2; }], ["physical_board_id", (c) => { c.provenance.physical_board_id = ""; }],
    ["previous_device_eui", (c) => { c.provenance.previous_device_eui = "bad"; }], ["circuit_revision", (c) => { c.provenance.circuit_revision = ""; }],
    ["source_record_path", (c) => { c.provenance.source_record_path = ""; }]
  ]) { const calibration = calibrationWithProvenance(); mutate(calibration); assert.throws(() => analyzeFixture({ calibration }), /calibration|provenance/i, name); }
});

test("strict resistor evidence rejects blanks, non-integers, invalid ADCs and zero supply", () => {
  const cases = [
    ["meter", (r) => { r.meter_ohm = " "; }], ["resistor_id", (r) => { r.resistor_id = ""; }],
    ["channel", (r) => { r.channel = "1.0"; }], ["repeat", (r) => { r.repeat = ""; }],
    ["fwd_early", (r) => { r.fwd_early = ""; }], ["fwd_late", (r) => { r.fwd_late = 4096; }],
    ["supply_mv", (r) => { r.supply_mv = ""; }]
  ];
  for (const [name, mutate] of cases) { const after = completeResistorMatrix({ phase: "after" }); mutate(after[0]); assert.throws(() => analyzeFixture({ after }), /input|resistor|ADC|supply|matrix/i, name); }
});

test("accepted malformed Profile-3 frame is rejected with row identity and zero-supply evidence is not P3", () => {
  assert.throws(() => analyzeFixture({ readings: [{ ...reading({ id: "bad-frame" }), payload_hex: "A2" }] }), /bad-frame|profile|payload/i);
  const report = analyzeFixture({ readings: Array.from({ length: 36 }, (_, i) => reading({ id: `z${i}`, at: atMinutes(i * 5), supply: 0 })) });
  assert.equal(criterion(report, "P3").verdict, "no_data");
});

test("P4 excessive settled continuity residual is scientific no_data", () => {
  const values = [4000, 4000, 10000, 4000, 4000];
  const report = analyzeFixture({ readings: values.map((r, i) => reading({ id: `p4-${i}`, at: atMinutes(i * 5), r1: r, r2: r })) });
  assert.equal(criterion(report, "P4").verdict, "no_data"); assert.equal(report.verdict, "INCONCLUSIVE");
});

test("P1 groups duplicate logical cells before electrical verdict", () => {
  const after = completeResistorMatrix({ phase: "after" }); const keyRow = after.find((r) => r.channel === 1 && r.nominal_band === "2k2" && r.repeat === 1); const valid = { ...keyRow }; keyRow.meter_ohm = 5000; const missing = after.findIndex((r) => r.channel === 2 && r.nominal_band === "10k" && r.repeat === 3); after.splice(missing, 1); after.push(valid);
  const report = analyzeFixture({ after }); assert.equal(criterion(report, "P1").verdict, "no_data");
});

test("clean settled dry-down passes with null global envelope and zero P5 unusable rows", () => {
  const readings = Array.from({ length: 36 }, (_, i) => reading({ id: `r${i + 1}`, at: atMinutes(i * 5), r1: 2200 + i * 300, r2: 2300 + i * 300 }));
  const report = analyzeFixture({ readings, references: referenceRows([{ id: "ref", at: atMinutes(90), celsius: 24 }]) });
  assert.equal(report.envelope, null);
  assert.equal(report.criteria.P5.probes[0].unusable, 0);
  for (const criterionResult of Object.values(report.criteria)) assert.ok(Object.prototype.hasOwnProperty.call(criterionResult, "reason"));
  if (!legacyMode) assert.equal(report.verdict, "PASS");
});

test("trustworthy unsettled rows produce candidate tables for both probes", () => {
  const readings = Array.from({ length: 8 }, (_, i) => reading({ id: `r${i + 1}`, at: atMinutes(i * 5), r1: 4000 + i * 100, r2: 5000 + i * 100, unsettled1: true, unsettled2: true }));
  const report = analyzeFixture({ readings });
  assert.equal(report.probes[0].candidates.length, 6);
  assert.equal(report.probes[1].candidates.length, 6);
});

test("dropped accepted-frame channels are counted per probe without changing pass/fail criteria", () => {
  const goodC1 = codeForResistance(4000, { pullup: CAL.pullup_1_ohm, pulldown: CAL.pulldown_1_ohm, seriesFwd: CAL.series_fwd_1_ohm, seriesRev: CAL.series_rev_1_ohm });
  const goodC2 = codeForResistance(5000, { pullup: CAL.pullup_2_ohm, pulldown: CAL.pulldown_2_ohm, seriesFwd: CAL.series_fwd_2_ohm, seriesRev: CAL.series_rev_2_ohm });
  const untrustedC1 = { ...goodC1, flags: 0x1b };
  const openCircuitC2 = { fwd_early: 1, fwd: 1, rev_early: 4095, rev: 4095, flags: 0 };

  const rowUntrusted = {
    id: "drop-1", deveui: EUI, recorded_at: atMinutes(0), f_cnt: 1, frame_status: "accepted",
    payload_hex: framePayload({ channel1: untrustedC1, channel2: { ...goodC2, flags: 0 } }),
  };
  const rowOpenCircuit = {
    id: "drop-2", deveui: EUI, recorded_at: atMinutes(5), f_cnt: 2, frame_status: "accepted",
    payload_hex: framePayload({ channel1: { ...goodC1, flags: 0 }, channel2: openCircuitC2 }),
  };

  const report = analyzeFixture({ readings: [rowUntrusted, rowOpenCircuit] });

  assert.equal(probe(report, 1).dropped_channels.untrusted_flags, 1);
  assert.equal(probe(report, 1).dropped_channels.total, 1);
  assert.equal(probe(report, 2).dropped_channels.open_circuit, 1);
  assert.equal(probe(report, 2).dropped_channels.total, 1);
  // Each probe kept exactly its one valid channel reading; the dropped channel never entered the criteria evidence.
  assert.equal(probe(report, 1).in_band, 1);
  assert.equal(probe(report, 2).in_band, 1);
  assert.equal(report.criteria.P2.verdict, "no_data");
});

test("regression: an unmatched thermometer row is never dropped", () => {
  const report = analyzeFixture({ readings: [reading({ id: "near", at: "2026-10-01T00:00:00.000Z" })], references: referenceRows([{ id: "ref-near", at: "2026-10-01T00:01:00.000Z", celsius: 24 }, { id: "ref-far", at: "2026-10-01T02:00:00.000Z", celsius: 24 }]) });
  if (legacyMode) { assert.equal(report.criteria.P6.verdict, "no_data"); return; }
  assert.equal(report.criteria.P6.total, 2); assert.equal(report.criteria.P6.matched, 1); assert.equal(report.criteria.P6.unmatched, 1);
  assert.equal(report.criteria.P6.verdict, "no_data"); assert.ok(report.criteria.P6.details.some((d) => d.reference_id === "ref-far")); assert.equal(report.verdict, "INCONCLUSIVE");
});

test("fully matched reference row more than 1 C away fails P6", () => {
  const report = analyzeFixture({ readings: [reading({ id: "near", at: "2026-10-01T00:00:00.000Z", temp: 24 })], references: referenceRows([{ id: "ref", at: "2026-10-01T00:01:00.000Z", celsius: 30 }]) });
  assert.equal(report.criteria.P6.verdict, "fail"); assert.equal(report.verdict, "FAIL");
});

test("regression: candidate needs five observations inside itself", () => {
  const rows = [];
  for (let i = 0; i < 6; i++) rows.push(reading({ id: `s${i}`, fCnt: i * 2 + 1, at: atMinutes(i * 10), r1: 4000, r2: 4000 }));
  for (const [i, delta] of [8, 8, 8, 8, 8, 13].entries()) rows.push(reading({ id: `r${i + 1}`, fCnt: i * 2 + 2, at: atMinutes(i * 10 + 5), r1: 4000, r2: 4000, unsettled1: true, earlyDelta1: delta }));
  const report = analyzeFixture({ readings: rows });
  if (legacyMode) { assert.equal(probe(report, 1)?.envelope, 0.03); return; }
  assert.equal(probe(report, 1)?.candidates?.find((c) => c.value === 0.02)?.count, 0);
  assert.equal(probe(report, 1)?.candidates?.find((c) => c.value === 0.03)?.qualifies, true);
  assert.equal(probe(report, 1)?.envelope, 0.03);
});

test("adversarial: envelope needs observed support in its grid interval", () => {
  const rows = [];
  for (let i = 0; i < 6; i++) rows.push(reading({ id: `s${i}`, fCnt: i * 2 + 1, at: atMinutes(i * 10), r1: 4000, r2: 4000 }));
  for (let i = 0; i < 5; i++) rows.push(reading({ id: `r${i + 1}`, fCnt: i * 2 + 2, at: atMinutes(i * 10 + 5), r1: 4000, r2: 4000, unsettled1: true, earlyDelta1: 8 }));
  const report = analyzeFixture({ readings: rows });
  assert.equal(probe(report, 1)?.envelope, 0.03);
  assert.equal(probe(report, 1)?.candidates?.find((c) => c.value === 0.05)?.reason, "no_observed_support");
  assert.equal(probe(report, 1)?.candidates?.find((c) => c.value === 0.08)?.reason, "no_observed_support");
});

test("regression: P5 is recomputed under the global envelope", () => {
  const rows = [];
  for (let i = 0; i < 4; i++) rows.push(reading({ id: `s${i}`, fCnt: i * 3 + 1, at: atMinutes(i * 20), r1: 4000, r2: 5000 }));
  const r1FrameCounts = [2, 3, 5, 6, 8];
  for (let i = 0; i < 5; i++) rows.push(reading({ id: `r1-${i}`, fCnt: r1FrameCounts[i], at: atMinutes(i * 10 + 5), r1: 4000, r2: 5000, unsettled1: true, unsettled2: true, earlyDelta1: 4, earlyDelta2: [4, 6, 10, 12, 16][i] }));
  rows.push(reading({ id: "r2-bad", fCnt: 9, at: atMinutes(55), r1: 4000, r2: 5000, unsettled1: true, unsettled2: true, earlyDelta1: 4, earlyDelta2: 24 }));
  const report = analyzeFixture({ readings: rows });
  if (legacyMode) { assert.equal(report.criteria.P5_ch2.value, 0.4); return; }
  assert.equal(report.envelope, 0.02); assert.equal(report.criteria.P5.probes[1].unusable, 4); assert.equal(report.criteria.P5.probes[1].denominator, 10); assert.equal(report.criteria.P5.probes[1].share, 0.4); assert.equal(report.criteria.P5.verdict, "fail"); assert.equal(report.verdict, "FAIL");
});

test("wandering offset fails P3 while insufficient coverage and noisy leave-one-out remain inconclusive", () => {
  const rows = Array.from({ length: 36 }, (_, i) => reading({ id: `r${i + 1}`, at: atMinutes(i * 5), r1: 4000, r2: 4000, offsetMv1: i % 2 ? 200 : 0 }));
  const report = analyzeFixture({ readings: rows });
  assert.equal(report.criteria.P3.verdict, "fail");
  assert.equal(report.criteria.P4.verdict, "no_data");
  assert.ok(report.criteria.P4.probes.some((probeResult) => probeResult.value > analyzer.LIMITS.kpaTolerance));
  assert.equal(analyzeFixture({ readings: [reading()] }).criteria.P2.verdict, "no_data");
});

test("evaluateP5 empty denominator is no_data and candidate eligibility is finite-only", () => {
  assert.equal(analyzer.evaluateP5([], 0.02).verdict, "no_data");
  assert.equal(analyzer.deriveProbeEnvelope(Array.from({ length: 5 }, () => ({ rho: 0.02, epsilon: Number.NaN, unsettled: true }))), null);
  assert.equal(analyzer.selectGlobalEnvelope(Number.NaN, 0.02), null);
});

test("CLI writes both artifacts, input hashes/counts, and exact exit semantics", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wm-analysis-"));
  const files = {
    readings: path.join(dir, "readings.csv"), calibration: path.join(dir, "calibration.json"), metadata: path.join(dir, "metadata.json"), before: path.join(dir, "before.csv"), after: path.join(dir, "after.csv"), references: path.join(dir, "references.csv")
  };
  fs.writeFileSync(files.readings, csv([reading({ id: 'id,"quoted"', unsettled1: true, unsettled2: true })])); fs.writeFileSync(files.calibration, JSON.stringify(calibrationWithProvenance())); fs.writeFileSync(files.metadata, JSON.stringify(runMetadata())); fs.writeFileSync(files.before, csv(completeResistorMatrix({ phase: "before" }), ["resistor_id", "nominal_band", "channel", "repeat", "meter_ohm", "fwd_early", "fwd_late", "rev_early", "rev_late", "supply_mv"])); fs.writeFileSync(files.after, csv(completeResistorMatrix({ phase: "after" }), ["resistor_id", "nominal_band", "channel", "repeat", "meter_ohm", "fwd_early", "fwd_late", "rev_early", "rev_late", "supply_mv"])); fs.writeFileSync(files.references, "reference_id,recorded_at,reference_c\n");
  const out = path.join(dir, "report");
  const result = cp.spawnSync(process.execPath, [path.join(__dirname, "watermark-drydown-analysis.js"), "--readings", files.readings, "--calibration", files.calibration, "--run-metadata", files.metadata, "--resistors-before", files.before, "--resistors-after", files.after, "--reference-temperature", files.references, "--interval-min", "5", "--out", out], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr); assert.ok(fs.existsSync(path.join(out, "summary.json"))); assert.ok(fs.existsSync(path.join(out, "readings.csv")));
  const summary = JSON.parse(fs.readFileSync(path.join(out, "summary.json"), "utf8")); assert.equal(summary.schema_version, 1); assert.equal(summary.input_manifest.readings.count, 1); assert.match(summary.input_manifest.readings.sha256, /^[0-9a-f]{64}$/); assert.deepEqual(summary.run_metadata.identity, runMetadata().identity); assert.equal(summary.calibration.schema_version, 1); assert.deepEqual(summary.calibration.provenance, CAL.provenance); assert.equal(summary.criteria.P1.reason, null); assert.equal(typeof summary.criteria.P2.reason, "string"); for (const name of ["P2", "P3", "P4"]) { assert.ok(Array.isArray(summary.criteria[name].value)); assert.equal(typeof summary.criteria[name].limit, "number"); } assert.ok(summary.criteria.P5.value === null || typeof summary.criteria.P5.value === "number"); assert.equal(typeof summary.criteria.P5.limit, "number");
  const outputCsv = fs.readFileSync(path.join(out, "readings.csv"), "utf8"); const header = outputCsv.split("\n")[0]; assert.deepEqual(header.split(","), ["deveui", "id", "f_cnt", "recorded_at", "channel", "band", "settled", "unsettled", "r_late", "r_early", "rho", "drift_fwd", "drift_rev", "drift_fwd_x_tol", "drift_rev_x_tol", "offset_mv", "r_fwd", "r_rev", "kpa_late", "kpa_early", "epsilon", "temp_c", "final_envelope_acceptance"]); assert.match(outputCsv, /"id,""quoted"""/); assert.match(outputCsv, /,rejected\n/);
  const invalidCalibration = path.join(dir, "invalid-calibration.json"); const invalidOut = path.join(dir, "invalid-report"); fs.writeFileSync(invalidCalibration, "{"); const invalidResult = cp.spawnSync(process.execPath, [path.join(__dirname, "watermark-drydown-analysis.js"), "--readings", files.readings, "--calibration", invalidCalibration, "--run-metadata", files.metadata, "--resistors-before", files.before, "--resistors-after", files.after, "--reference-temperature", files.references, "--interval-min", "5", "--out", invalidOut], { encoding: "utf8" }); assert.equal(invalidResult.status, 2); assert.equal(fs.existsSync(invalidOut), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("input_manifest.path records the basename of each input, not the given path", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wm-manifest-"));
  const inputDir = path.join(dir, "inputs", "nested");
  fs.mkdirSync(inputDir, { recursive: true });
  const files = {
    readings: path.join(inputDir, "readings.csv"), calibration: path.join(inputDir, "calibration.json"), metadata: path.join(inputDir, "metadata.json"),
    before: path.join(inputDir, "before.csv"), after: path.join(inputDir, "after.csv"), references: path.join(inputDir, "references.csv"),
  };
  const resistorColumns = ["resistor_id", "nominal_band", "channel", "repeat", "meter_ohm", "fwd_early", "fwd_late", "rev_early", "rev_late", "supply_mv"];
  fs.writeFileSync(files.readings, csv([reading()]));
  fs.writeFileSync(files.calibration, JSON.stringify(calibrationWithProvenance()));
  fs.writeFileSync(files.metadata, JSON.stringify(runMetadata()));
  fs.writeFileSync(files.before, csv(completeResistorMatrix({ phase: "before" }), resistorColumns));
  fs.writeFileSync(files.after, csv(completeResistorMatrix({ phase: "after" }), resistorColumns));
  fs.writeFileSync(files.references, "reference_id,recorded_at,reference_c\n");
  const out = path.join(dir, "report");
  const result = cp.spawnSync(process.execPath, [path.join(__dirname, "watermark-drydown-analysis.js"), "--readings", files.readings, "--calibration", files.calibration, "--run-metadata", files.metadata, "--resistors-before", files.before, "--resistors-after", files.after, "--reference-temperature", files.references, "--interval-min", "5", "--out", out], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(fs.readFileSync(path.join(out, "summary.json"), "utf8"));
  assert.equal(summary.input_manifest.readings.path, "readings.csv");
  assert.equal(summary.input_manifest.calibration.path, "calibration.json");
  assert.equal(summary.input_manifest.run_metadata.path, "metadata.json");
  assert.equal(summary.input_manifest.resistors_before.path, "before.csv");
  assert.equal(summary.input_manifest.resistors_after.path, "after.csv");
  assert.equal(summary.input_manifest.reference_temperature.path, "references.csv");
  for (const entry of Object.values(summary.input_manifest)) assert.ok(!entry.path.includes(path.sep));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("CLI rejects output collisions without modifying the input", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wm-collision-")); const file = path.join(dir, "readings.csv"); fs.writeFileSync(file, "deveui,id,recorded_at,frame_status,payload_hex\n"); const before = fs.readFileSync(file); const result = cp.spawnSync(process.execPath, [path.join(__dirname, "watermark-drydown-analysis.js"), "--readings", file, "--calibration", file, "--run-metadata", file, "--resistors-before", file, "--resistors-after", file, "--reference-temperature", file, "--interval-min", "5", "--out", file], { encoding: "utf8" }); assert.equal(result.status, 2); assert.deepEqual(fs.readFileSync(file), before); fs.rmSync(dir, { recursive: true, force: true });
});

test("CLI rejects stale or symlinked output paths before writing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wm-stale-output-")); const file = path.join(dir, "input.csv"); fs.writeFileSync(file, "unchanged\n");
  const args = [path.join(__dirname, "watermark-drydown-analysis.js"), "--readings", file, "--calibration", file, "--run-metadata", file, "--resistors-before", file, "--resistors-after", file, "--reference-temperature", file, "--interval-min", "5"];
  const stale = path.join(dir, "stale"); fs.mkdirSync(stale); fs.writeFileSync(path.join(stale, "summary.json"), "keep"); const staleResult = cp.spawnSync(process.execPath, [...args, "--out", stale], { encoding: "utf8" }); assert.equal(staleResult.status, 2); assert.equal(fs.readFileSync(path.join(stale, "summary.json"), "utf8"), "keep");
  const target = path.join(dir, "target"); fs.mkdirSync(target); const link = path.join(dir, "out-link"); fs.symlinkSync(target, link); const linkResult = cp.spawnSync(process.execPath, [...args, "--out", link], { encoding: "utf8" }); assert.equal(linkResult.status, 2); assert.equal(fs.existsSync(path.join(target, "summary.json")), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("CLI reports output failures as exit 1", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wm-output-failure-")); const files = { readings: path.join(dir, "readings.csv"), calibration: path.join(dir, "calibration.json"), metadata: path.join(dir, "metadata.json"), before: path.join(dir, "before.csv"), after: path.join(dir, "after.csv"), references: path.join(dir, "references.csv") }; const resistorColumns = ["resistor_id", "nominal_band", "channel", "repeat", "meter_ohm", "fwd_early", "fwd_late", "rev_early", "rev_late", "supply_mv"]; fs.writeFileSync(files.readings, csv([reading()])); fs.writeFileSync(files.calibration, JSON.stringify(calibrationWithProvenance())); fs.writeFileSync(files.metadata, JSON.stringify(runMetadata())); fs.writeFileSync(files.before, csv(completeResistorMatrix({ phase: "before" }), resistorColumns)); fs.writeFileSync(files.after, csv(completeResistorMatrix({ phase: "after" }), resistorColumns)); fs.writeFileSync(files.references, "reference_id,recorded_at,reference_c\n"); const parentFile = path.join(dir, "parent"); fs.writeFileSync(parentFile, "not-a-directory"); const output = path.join(parentFile, "nested"); const result = cp.spawnSync(process.execPath, [path.join(__dirname, "watermark-drydown-analysis.js"), "--readings", files.readings, "--calibration", files.calibration, "--run-metadata", files.metadata, "--resistors-before", files.before, "--resistors-after", files.after, "--reference-temperature", files.references, "--interval-min", "5", "--out", output], { encoding: "utf8" }); assert.equal(result.status, 1); fs.rmSync(dir, { recursive: true, force: true });
});
