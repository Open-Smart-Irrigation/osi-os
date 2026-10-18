# Preview SDI-12 profiles without hardware

The profile preview resolves a proposed sensor configuration and optionally
decodes a synthetic FPort 2 uplink. Run it from a development checkout with
Node.js. It performs no network calls, database writes or device configuration.

```bash
node scripts/preview-sdi12-profile.js --example teros12
```

The sample produces `vwc_1: 46.81`, `soil_temp_1: -10`, `soil_ec_1: 0` and
`bat_v: 3.3`. Its output remains `hardware_verified: false`; the resolved profile
also reports `provisional: true` and `acquisition_available: false`. These flags
are constant for this preparation API. A successful preview cannot promote a
profile or activate a recipe.

## Available examples

| Example name | Meaning |
|---|---|
| `pr2-4` | Four VWC-percent channels with explicit depths |
| `pr2-6` | Six VWC-percent channels with explicit depths |
| `teros11` | Mineral-soil VWC and temperature, including −40 °C |
| `teros12` | Mineral-soil VWC, temperature and a real zero EC reading |
| `tensiomark-pf` | Variant 1 pF 4 converts to 1,000 kPa in the candidate path |
| `hydrascout-blocked` | Refuses candidate resolution with `protocol_evidence_required` |

All examples in
`scripts/fixtures/device-integration/sdi12/configuration-examples.json` are
synthetic. Existing captured Sentek integration fixtures remain separate.

## Preview an explicit configuration

Save this as a local JSON file, then pass its path to the command:

```json
{
  "configuration": {
    "version": 1,
    "profile_id": "METER_TEROS_12",
    "profile_version": 2,
    "address": "1",
    "settings": {"calibration": "mineral"},
    "depths": [30]
  }
}
```

```bash
node scripts/preview-sdi12-profile.js /path/to/configuration.json
```

`depths` contains one integer depth in centimetres per physical depth position,
in response order. PR2/4 requires four and PR2/6 six; the other supported
candidates require one. Each depth must be distinct and in 1..1000 cm. The
resolver does not silently install default depths.

Settings are explicit and bounded:

- `DELTAT_PR2_4` and `DELTAT_PR2_6` accept
  `{"measurement_mode":"mineral_vwc_percent"}`. These previews assume the
  configured response is already mineral VWC percent. They do not detect the
  probe's command mode from a numeric payload.
- `METER_TEROS_11` and `METER_TEROS_12` accept
  `{"calibration":"mineral"}`. Firmware is not a setting. Future commissioning
  must retain identity readback and evaluate compatibility with the applicable
  manual; an offline preview does not establish firmware compatibility.
- `TENSIOMARK` version 3 accepts
  `{"source_unit":"pF","variant":"1","field_order":"pf_temperature"}` for
  the variant-1 rehearsal. `temperature_pf` is the other explicit order. Both
  describe offline assumptions; neither establishes the installed model's order.
  Missing or automatic order is refused. hPa, mbar, kPa and variants 2/3 return
  `protocol_evidence_required`. The installed variant and pF output mode still
  need readback or other applicable evidence.

Unknown fields, settings and versions are rejected. Tensiomark requires
`profile_version: 3`; its previous versions are refused. PR2 and TEROS remain at
version 2. The unversioned live Tensiomark path now retains decoded replies in
`unknown.sdi12_tensiomark_unqualified` and emits battery only. Its descriptor
adapter returns `protocol_evidence_required`. Other live profiles are unchanged.
No versioned candidate is connected to live acquisition.

`interpretation_hash` identifies the returned rule descriptor: profile/version,
settings, parser and rounding identifiers, units, response positions, transforms,
ranges, sentinels and failure policies. Tests pin this digest per profile/version;
rule changes require a new version. `configuration_hash` covers that digest plus
the complete canonical configuration, including address and depths. Depth or
address edits change only the configuration hash. Neither hash proves the probe
is configured accordingly or identifies the recipe that produced an uplink.

To preview an uplink, add `"uplink":{"fPort":2,"bytes":[...]}` to the outer
object. Bytes must be integers in 0..255, with a complete payload of 3..255
bytes. The tool runs the shipped Dragino codec in a VM. It accepts PAYVER 1;
PAYVER 2 fragments return `reassembly_required`. Multi-frame cases remain in
the existing `scripts/verify-device-integration.js` suite. The separate
[transport replay lab](sdi12-transport-lab.md) compares the shipped assembly
behavior with an offline candidate and exposes their remaining ambiguities.

Exit 0 means configuration resolution and any requested sample preview passed.
The JSON result distinguishes `complete` from `no_response`; a missing response
does not produce sensor values. Invalid inputs, partial samples and quarantined
samples return exit 1 with a bounded reason code. A partial result retains its
valid channels and reports `sample_partial`. No branch claims hardware verification.

## Candidate measurement rules

TEROS uses the mineral calibration from equation 6 of the
[manufacturer's user manual](https://publications.metergroup.com/Manuals/20587_TEROS11-12_Manual_Web.pdf):
`VWC percent = 100 * (3.879e-4 * RAW - 0.6956)`.
The candidate treats the first SDI-12 field, calibrated ADC counts, as `RAW`.
The audit's numerical checks support this mapping, but neither manual explicitly
equates the field with the equation's input. It remains an inference requiring
firmware-applicable confirmation, not a moisture-fraction input. The
[integrator guide](https://publications.metergroup.com/Integrator%20Guide/18224%20TEROS%2011-12%20Integrator%20Guide.pdf)
documents that response field, the firmware floor and error codes. The candidate
rejects `-9999`, `-9992` and `-9991` before conversion; accepted mineral VWC is
0..70%, temperature is −40..60 °C and TEROS 12 bulk EC is 0..20,000 µS/cm.

The PR2 candidates enforce exact counts and VWC in 0..100%. Tensiomark variant 1
accepts pF 0..7, converts to canonical positive kPa and retains the full converted
range. Its temperature check is −40..80 °C, from the
[ecoTech manual's technical table, page 18](https://www.stevenswater.com/resources/documentation/Stevens_Tensiomark_Manual.pdf).
The same manual documents SDI-12 pF output, without an hPa mode. A later manual
adds pressure output and a different field order; see the
[unit investigation](tensiomark-output-units-investigation.md). We prepare pF
acquisition with one edge conversion using OSI's log-hPa convention. Field order
is explicit because a swapped pair can pass numeric range checks.

Tensiomark candidate failures retain the complete input `data_sum` under
`unknown.sdi12_tensiomark_raw` alongside the specific diagnostic. That decoded
string is not the original radio or SDI-12 frame: retain those separately with the
capture tools. Negative tension and out-of-range temperature reject the soil
vector before conversion. A valid temperature of −9.88 °C is not a tension error.

The SDI-12 Tensiomark card can display 0.1..1,000,000 kPa and derived pF. Values
above 300 kPa have no VIA status badge. Zone summaries retain their separate
0..300 kPa rule; this slice does not revise irrigation thresholds. Existing
historical values are not repaired or retrospectively qualified.

Validation occurs before returning sensor channels. An isolated PR2 range failure
or TEROS VWC range failure omits that channel with a diagnostic and returns
`partial` when another sensor channel survives. For example, TEROS RAW 1780
converts below 0%: temperature and EC remain available. Negative VWC is not
clamped to zero. These are explicit software acceptance policies, not inferred
sensor error codes.

Framing/count errors, non-finite numbers, every TEROS sentinel and other range
failures quarantine the whole vector. A fatal error overrides any partial result,
regardless of field order; no surviving sensor channels also means quarantine.
Battery diagnostics survive. Accepted values are rounded to two decimals after
range checking. This API assumes a complete single-cycle input; the current
reassembler does not yet prove that provenance.

## Legacy compatibility and next integration step

The existing `normalize()` and `listProfiles()` APIs retain their behavior.
Existing PR2 devices keep their learned counts; existing Tensiomark readings
still use the deployed clamp until a separately reviewed revision transition
is implemented. No old row is recalculated by this work.

The new helper exports `resolveConfiguration`, `normalizeConfigured` and
`resolveLegacyConfiguration`. The last function describes the legacy normalizer
configuration using its current registry and Sentek validator, including mixed
VWC/VIC source positions. Generic and PR2 legacy depths preserve finite values in 0..500 cm, including
zero and fractions; validated Sentek layout depths keep their separate domain.
Missing legacy depths stay null. It does not upgrade
the configuration or establish that the observed response matches it.

Before calling the candidate normalizer from live ingestion, implement durable
desired/observed revisions and the acquisition transition fence described in the
[preparation design](../superpowers/specs/2026-10-02-sdi12-sensor-expansion-preparation.md).
That prevents an old recipe's payload being interpreted using newly saved units
or calibration. Cloud/UI integration and hardware recipe activation follow that
boundary.

The [protocol preview](sdi12-protocol-preview.md) separately checks raw framed
replies and packed response capacity. See the
[audit reconciliation](sdi12-protocol-audit/RECONCILIATION.md) for firmware, units
and response-order assumptions that remain outside these provisional previews.
The [recipe preview](sdi12-recipe-preview.md) generates logical probe commands and
checks supplied exchanges and modelled payload budgets. It deliberately returns
raw values without calling this provisional normalizer.
