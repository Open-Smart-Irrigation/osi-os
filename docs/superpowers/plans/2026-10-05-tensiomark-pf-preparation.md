# Tensiomark pF preparation

Implement the user's approved pF acquisition and edge-conversion decision on
`feat/sdi12-profile-foundation`, following the
[unit investigation](../../devices/tensiomark-output-units-investigation.md).
This slice prepares interpretation and display. Sensor settings, field order,
firmware applicability and acquisition freshness still need bench evidence.

## Contract

The offline TENSIOMARK descriptor advances from version 2 to version 3. Its exact
settings contain `source_unit: "pF"`, `variant: "1"` and a required `field_order`
of `pf_temperature` or `temperature_pf`. These are explicit rehearsal assumptions,
not hardware qualification. Missing/automatic order, pressure units, unsupported
variants and old descriptor versions are refused. Source positions affect both
the channel descriptor and interpretation hash. Other profiles retain their
version and digest.

Conversion remains the existing OSI log-hPa convention: `10 ** pF / 10` kPa.
The pF range is 0 through 7, yielding 0.1 through 1,000,000 kPa. Neither range
clips readings. Invalid pF, invalid temperature, malformed values or wrong count
quarantine the soil vector atomically while retaining battery. Temperature
-9.88 °C is valid and must not be confused with an error in the tension slot.
No magnitude-based unit or field-order detection is allowed.

Sol's before-code review requires a single source-position map for both descriptor
surfaces and separate hash tests for each order. On candidate quarantine, retain
the original decoded `data_sum` string in `unknown.sdi12_tensiomark_raw` alongside
the reason. This is the complete input to the normalizer, not a claim that the
legacy codec preserved wire framing. Legacy quarantine also retains that input
without trimming. Original bus/radio bytes remain the capture tool's responsibility.

The unversioned runtime TENSIOMARK path cannot prove units or ordering. It will
retain the reply in `unknown.sdi12_tensiomark_unqualified` and emit battery only.
The legacy descriptor adapter will return `protocol_evidence_required` for that
profile. Empty/NULL responses retain their existing no-response behavior.
Do not connect the offline candidate to the live flow or alter other profiles.
This deliberately supersedes the earlier legacy-preservation rule for Tensiomark.
Deploying this change stops new unqualified Tensiomark soil values; it does not
repair or remove historical rows.

The SDI-12 card will display finite Tensiomark SWT in 0.1..1,000,000 kPa with
derived pF. Other profiles retain the current formatter. Keep the shared VIA
classification and irrigation thresholds unchanged: values above 300 kPa can be
displayed without a status classification. Invalid values must not receive a
status badge. This is display preparation, not proof that existing stored values
were produced by a qualified sensor.

## Work and ownership

1. Root writes failing normalizer tests for explicit order, old/missing contracts,
   pF endpoints and 4 -> 1,000 kPa, sentinel/range rejection, negative temperature,
   raw quarantine and battery retention. Update existing legacy expectations to
   the deliberate refusal. Run the canonical normalizer tests and inspect RED.
2. Root changes `osi-sdi12-normalize/configuration.js` and `index.js`, updates the
   versioned hash pins and synthetic configuration fixtures, then runs the same
   tests to GREEN. Mirror changed payload files and tests from bcm2712 to bcm2709.
   Raw protocol recipes remain independent of numeric interpretation.
3. Terra updates `web/react-gui/src/components/farming/Sdi12SoilCard.tsx` and its
   component test only, with failing rendering tests first. Check 0.1, 1,000 and
   1,000,000 kPa; reject values outside the range; preserve other profiles' limits
   and measured-zero behavior. Do not broaden shared SWT status rules.
4. Root updates affected golden fixtures and verifies codec -> normalizer ->
   SQLite behavior: unqualified Tensiomark must not write soil values; prepared
   candidate conversion must retain dry values and canonical units. Update the
   profile preview guide and investigation with implemented versus pending work.
5. Independent Sol reviews this plan before code changes. Independent Astra
   reviews the final diff and behavior. Address required findings before completion.

## Verification

Run `node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-sdi12-normalize/*.test.js`
for RED/GREEN. Then run the complete offline SDI-12 test command from
`.github/workflows/verify-sync-flow.yml`, `node scripts/verify-device-integration.js`,
`node scripts/verify-codec-robustness.js`, and
`node scripts/verify-profile-parity.js`.

From `web/react-gui`, run `npm run typecheck`, `npm run test:unit`, and
`npm run build`. Run prose lint, documentation hygiene and `git diff --check` on
the final changes. Record exact outcomes and review findings in the execution
report. No schema, flow wiring, deployment or sensor configuration is changed.
