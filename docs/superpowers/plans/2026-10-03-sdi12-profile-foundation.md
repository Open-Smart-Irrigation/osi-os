# SDI-12 profile foundation implementation plan

Historical plan for `40fc259ed`. The
[external review follow-up](2026-10-03-sdi12-external-review-followup.md) supersedes
its candidate version, unit settings, hash and range-failure rules.

> For agentic workers: execute this slice inline with the executing-plans and
> test-driven-development skills. Use an independent reviewer before completion.

Goal: resolve and preview versioned SDI-12 measurement configurations offline,
while retaining the deployed normalizer's behavior for existing devices.

Architecture: add a pure configuration module to `osi-sdi12-normalize`, expose
it through additive lazy exports, and provide a local CLI that exercises the
real codec and candidate normalizer. The existing `normalize`, profile listing,
commissioning and Node-RED routes keep their current semantics. Deployment must
include the additional module file in both Pi payloads and `deploy.sh`.

Tech stack: existing CommonJS helpers, Node's built-in test runner, JSON fixtures.
No additional package dependency.

Spec: [sensor expansion preparation](../specs/2026-10-02-sdi12-sensor-expansion-preparation.md),
pre-bench package 1. This slice does not implement revision persistence, REST
commands, cloud/UI changes, or acquisition recipe activation.

## Global constraints

- Load canonical manifest units with `require('../edge-channels.json')` relative
  to the module, verify every referenced key, and never read a live gateway path.
- Preserve existing legacy profile IDs, learned-count rules and normalizer output.
- Candidate configurations remain provisional and cannot enable acquisition.
- Never infer units from value size; quarantine a candidate vector atomically
  on framing, sentinel, transform or range failure, retaining battery diagnostics.
- No live gateway access, downlinks, migration or historical rewrite.
- Mirror runtime source and tests byte-for-byte to bcm2709.
- Keep original root-checkout drafts untouched. Carry copies in this branch so
  the implementation and its design record can be reviewed together.

## Interfaces

In `osi-sdi12-normalize/configuration.js`, export these synchronous functions
and expose lazy wrappers from the existing `index.js`:

```js
resolveConfiguration(input)       // {ok:true, configuration, channels,
                                  //  expected_values, configuration_hash,
                                  //  provisional:true, acquisition_available:false}
                                  // or {ok:false, code}
resolveLegacyConfiguration(input) // {ok:true, profile_id, profile_version:0,
                                  //  channels, expected_values, legacy:true}
                                  // or {ok:false, code}
normalizeConfigured(decoded, input, meta) // existing normalize-compatible
                                  // channels/unknown/recordedAt/noResponse,
                                  // plus disposition and configuration_hash
```

Configuration content excludes revision UUIDs: persistence owns the request
envelope, while this resolver owns only interpretation. Accept exactly:

```json
{
  "version": 1,
  "profile_id": "METER_TEROS_12",
  "profile_version": 1,
  "address": "1",
  "settings": {"calibration": "mineral", "firmware": "3.00"},
  "depths": [30]
}
```

Reject unknown fields and versions. Address is one SDI-12 alphanumeric character.
Depths are distinct integers in 1..1000 cm, in response-depth order. Canonicalize
settings in fixed key order and hash the canonical JSON with SHA-256. Profiles
and version belong in the hash, as do mode, address and depths. Return detached
objects; mutations of one result must not alter future resolutions.

Channels contain `key`, `unit`, `depth_cm` and zero-based `source_index`.
PR2/4 and /6 require four/six explicit depths and
`settings: {measurement_mode:'mineral_vwc_percent'}`. TEROS 11/12 require one
depth, mineral calibration and a firmware string in `major.minor` format with
two minor digits and version >=3.00. Tensiomark requires one depth and
`settings: {source_unit:'pF'}` or `hPa`. HydraScout version 1 returns
`protocol_evidence_required`; legacy HydraScout remains available only through
the unchanged legacy interpretation, never promoted to a verified candidate.

Candidate rules: PR2 VWC 0..100%; TEROS mineral VWC
`100 * (3.879e-4 * RAW - 0.6956)` in 0..70%, temperature -40..60 °C,
TEROS 12 bulk EC 0..20000 µS/cm; reject -9999/-9992/-9991 before any transform.
Tensiomark pF 0..7 or hPa 1..10000000 maps to positive kPa without clipping at
300; temperature retains the existing provisional -30..70 °C envelope.
Round accepted canonical values to two decimals after validation. Record these
declared assumptions in the CLI documentation; none establishes hardware support.

Legacy input is the existing normalizer configuration (`probeProfile`,
`sdi12ValueCount`, `sdi12ChannelLayout`) plus optional channel-keyed `depths`.
Use the existing registry and Sentek validator; do not copy their definitions.
Missing legacy depths stay null. Sentek's canonical layout supplies its depths
and mixed VWC/VIC source positions. Preserve the existing learned-count fallback
and the fixed-profile rule that ignores stale learned counts.

## Review focus

- An old PR2 with a learned count different from its model suffix must retain its
  old interpretation; test adapter metadata and unchanged golden-vector results.
- Invalid pF and TEROS sentinels must not become plausible zero measurements;
  test errors in every position and all-or-nothing candidate quarantine.
- Invalid configurations must not appear healthy when the sensor returns NULL;
  resolve configuration before accepting a no-response case.
- A newly added file must reach deployed gateways, not only work in a checkout;
  test the exact deploy fetch pair and both payload copies.
- A fixture labeled synthetic must not acquire bench-verified status; the CLI
  prints provisional metadata even for successfully normalized data.

## Task 1: Resolver and legacy descriptor

Files: add `configuration.js` and `configuration.test.js` under canonical
`conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-sdi12-normalize/`;
modify the package's `index.js`; mirror those files to bcm2709.

- [x] Write tests for exact channels, units, counts, depths, versions, setting
  grammar, stable hashes and detached results. Include all five candidate
  profiles, unknown/HydraScout profiles, malformed depth/settings inputs and
  legacy Sentek/PR2 descriptors.
- [x] Run the new suite; expect failure because `resolveConfiguration` is absent.
- [x] Implement the interfaces and validation above. Load the existing module
  lazily to reuse its registry/validator without a circular initialization path.
- [x] Run new and existing normalizer tests; expect exit 0.

Example assertion to implement before resolver code:

```js
const result = normalize.resolveConfiguration(teros12);
assert.equal(result.ok, true);
assert.deepEqual(result.channels.map(c => [c.key, c.unit, c.depth_cm]), [
  ['vwc_1', '%', 30], ['soil_temp_1', '°C', 30], ['soil_ec_1', 'µS/cm', 30]
]);
assert.equal(result.acquisition_available, false);
```

## Task 2: Candidate normalization

Files: same helper source/test pair.

- [x] Write tests before adding `normalizeConfigured`. Input `+3000-10+0` for
  TEROS 12 must yield VWC 46.81%, -10 °C and zero EC. Tensiomark `+4+20`
  must yield 1000 kPa; `-9999+20` must yield battery only and a diagnostic.
- [x] Run tests and confirm the missing behavior fails.
- [x] Use the existing strict sign-delimited parser, exact resolved count and
  profile-specific rules above. Stage all sensor values before accepting any.
- [x] Test NULL/empty, malformed grammar, count mismatch, out-of-range values,
  non-finite values, all documented TEROS error codes, and unknown config.
- [x] Run both normalizer suites and the existing SDI-12 database replay suite.
  Expected: exit 0; legacy vector expectations unchanged.

## Task 3: Offline preview and delivery

Files: add `scripts/preview-sdi12-profile.js`, its `.test.js`,
`scripts/fixtures/device-integration/sdi12/configuration-examples.json`, and
`docs/devices/sdi12-offline-preview.md`; modify `deploy.sh` and
`.github/workflows/verify-sync-flow.yml`.

- [x] CLI tests first: `node scripts/preview-sdi12-profile.js <input.json>` reads
  `{configuration, uplink?: {fPort:2, bytes:[...]}}`, resolves configuration,
  and optionally runs the real codec and candidate normalizer. Invalid config,
  malformed bytes, unsupported ports/PAYVER2 fragments and quarantined samples
  return exit 1 with a JSON diagnostic. Successful previews return exit 0.
- [x] Confirm missing CLI behavior fails, then implement it using built-ins.
  Load the non-CommonJS codec in `vm.Script`, following the existing integration
  verifier, and call its global `decodeUplink({fPort, bytes})`. Do not change the
  deployed codec for this tool. No network, state mutation or command compilation. PAYVER2 replay belongs to
  the existing integration harness; this CLI rejects fragments explicitly.
- [x] Add labeled synthetic examples for all five candidates and a documented
  HydraScout refusal case. Test examples through the CLI so they remain usable.
- [x] Add an exact `fetch_required` block for `configuration.js` next to the
  existing normalizer fetches; test source/destination pairing and mirror bytes.
- [x] Run all changed suites, all four SDI-12 helper suites, codec and SDI-12
  database replay, profile parity, helper registration,
  `node scripts/verify-module-file-deploy-coverage.js`, shell syntax, prose lint
  and `git diff --check`. Record exit codes in an execution report.
- [x] Add the new suites and existing SDI-12 helper regressions to CI.
- [x] Obtain independent whole-diff review and verification; correct substantive
  findings with failing regression tests before committing the completed slice.

## Execution record

Base: `031cfaf4b` (`origin/main`, fetched 2026-10-03). The original local checkout
is untouched. The baseline normalizer suite and profile parity both exit 0.
The existing SDI-12 runtime files are identical between that base and the local
checkout used for preparation.

Plan review: the independent reviewer required the explicit VM codec loader,
relative bundled-manifest loading, and the repository's module-file deploy gate.
All three are included above before implementation.

Implementation decisions: the preview also accepts `--example <name>` so the
checked synthetic fixtures are runnable without creating temporary input files.
Candidate results use `no_response` alongside `complete` and `quarantined`;
there is no `partial` acceptance in this slice because independent per-position
error semantics have not been established. No persisted status enum is changed.

Final inspection found no CI step running the new resolver or preview suites.
The sync-flow workflow now runs them with the four existing SDI-12 helper suites.
