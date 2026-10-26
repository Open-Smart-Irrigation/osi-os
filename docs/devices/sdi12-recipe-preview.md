# Preview sensor command plans without hardware

The recipe preview generates addressed discovery/readback commands and a logical
measurement plan for PR2/4, PR2/6, TEROS 11/12 and Tensiomark variant 1. A supplied
exchange can then pass through standard SDI-12 validation and the single-payload
converter model. This checks software assumptions before a bench capture.

```sh
node scripts/preview-sdi12-recipe.js --list
node scripts/preview-sdi12-recipe.js --example pr2-four-plan
node scripts/preview-sdi12-recipe.js --example pr2-six-split
node scripts/preview-sdi12-recipe.js input.json
```

All results keep `hardware_verified`, `configuration_verified`,
`acquisition_available`, `eligible` and `recipe_deployable` false. A plan is not
a fixed Dragino recipe. The tool emits no AT configuration or downlinks, and
does not assign numeric replies to canonical sensor channels.

## Input and result

File mode accepts a regular JSON file up to 1 MiB. Supply every field explicitly:

```json
{
  "configuration": {
    "version": 1, "profile_id": "METER_TEROS_11", "profile_version": 2,
    "address": "1", "settings": {"calibration": "mineral"}, "depths": [30]
  },
  "command_family": "M",
  "supply_v": 12,
  "power_mode": "switched",
  "interval_seconds": 1200,
  "converter": {
    "battery_mv": 3300, "interrupt": false, "payver": 1,
    "max_slots": 8, "max_payload_bytes": 51
  },
  "exchange": null
}
```

The configuration follows the existing [candidate profile grammar](sdi12-offline-preview.md).
An arbitrary firmware string cannot qualify a profile. `supply_v` describes the
probe supply, while `battery_mv` is a synthetic converter-header input; they are
different rails. `power_mode` is `continuous` or `switched`. The interval is an
integer from 1 to 86,400 seconds, with the additional Tensiomark minimum below.
Converter slots are a caller budget from 1 to 15 and payload bytes from 3 to 255;
slot limits are hypothetical retention capacity, not installed firmware support.
The preview does not select or verify a regional/data-rate radio limit.

With `exchange:null`, success is `disposition:planned`. The report contains exact
SDI-12 command bytes, separate discovery/readback commands, adaptive D retrieval,
source references and unresolved qualification requirements. `power_window_ms`
and `fixed_converter_recipe` remain null.

## Supported measurement paths

| Profile | Families | Measurement | Expected count | Preparation constraints |
|---|---|---|---|---|
| PR2/4 | M, MC, C, CC | Address + family + `3!` | 4 | Read M3 settings at positions 1–4; establish installed model |
| PR2/6 | M, MC, C, CC | Address + family + `3!` | 6 | Read M3 settings at positions 1–6; establish installed model |
| TEROS 11 | M, MC | Address + family + `!` | 2 | Establish firmware applicability and startup behavior |
| TEROS 12 | M, MC | Address + family + `!` | 3 | Also establish EC-unit applicability |
| Tensiomark 4244/1 | M | Address + `M!` | 2 | At least 900 seconds between starts; keep response positions unbound |
| HydraScout | Unavailable | None | Unknown | `protocol_evidence_required` |

PR2 discovery includes `aI!` followed by `aXRM3S1!` through the installed model's
last position. This generates readback requests, not an acceptance parser for
their responses. A plausible percent vector cannot establish the installed units
or calibration. No calibration writes are generated.

TEROS C/CC forms are documented but excluded here because their concurrent
behavior deviates from the standard. Address 0 with switched power is refused
until startup-string handling exists. Continuous power at address 0 can be planned,
but initial startup handling remains unresolved. The guide's typical startup time
is not a worst-case power-delay guarantee.

Tensiomark CRC/concurrent forms, variants 2/3 and hPa interpretation are unavailable.
Its printed `0082` is not repaired into a standard announcement. The preview can
check the framing and count of a synthetic two-number response without claiming
that its first field is pF. It does not call the provisional normalizer.
Tensiomark inputs now require version 3 and an explicit `field_order` in their
configuration. This is a synthetic interpretation assumption for later rehearsal;
the recipe and capture checkers still leave observed numeric positions unbound.
Neither order qualifies hardware or generates a unit-setting write.

Declared probe supply must be within 7.2–16 V for PR2, 4–15 V for TEROS or 7–14 V
for Tensiomark. Passing that check does not establish available current, wiring,
power-up behavior or a suitable converter power window.

References: [PR2 manual v4.1, pp. 17 and 49–52](https://delta-t.co.uk/wp-content/uploads/2016/09/PR2_SDI-12-_User_Manual_version_4_1.pdf),
[TEROS integrator guide 18224-12, pp. 1 and 7–8](https://publications.metergroup.com/Integrator%20Guide/18224%20TEROS%2011-12%20Integrator%20Guide.pdf),
and [Tensiomark May 2014 manual, §§5.1.5, 6, 7](https://www.stevenswater.com/resources/documentation/Stevens_Tensiomark_Manual.pdf).

## Replay a supplied exchange

Replace null with the [protocol preview's exchange shape](sdi12-protocol-preview.md):
`command`, exact framed `response`, and ordered `{command,response}` data blocks.
The measurement command must match the selected model and family, and the announced
count must match the profile. The actual announcement supplies the wait; the tool
does not hard-code a wait from a printed sensor example. An interval shorter than
that wait is refused, but a longer interval is not proof of adequate cycle timing.

Incomplete and aborted exchanges remain diagnostic. No payload is modelled until
the protocol exchange completes. On completion, the tool models an announcement
slot followed by one slot per supplied data reply, checks the caller's budgets,
and passes the resulting bytes through the [converter preview](sdi12-converter-preview.md)
and protocol parser again. Successful replay is `disposition:simulated` with
`evidence:modelled_from_supplied_exchange`. This preserves raw values and CRC;
it does not validate units, calibration, firmware or measurement freshness.

Exit 0 means planning or simulation succeeded. Every refusal, incomplete exchange
or aborted measurement exits 1. All bundled measurement transcripts are synthetic;
none is labelled an installed-device capture.

## Budget interpretation

The capacity report uses hypothetical nine-character signed values. It compares
tight packing against one value-bearing D reply per value, includes the announcement,
two wrapper bytes per reply and the three-byte converter header. CRC overhead is
included when requested. Discovery/readbacks are separate and excluded from the
periodic measurement budget.

These bounds do not predict actual grouping. A width-nine estimate can exceed a
budget while a supplied shorter transcript fits it. Simulation checks that supplied
transcript exactly and refuses to truncate it or split it automatically. Logical
slot numbers are modelling assignments, not evidence that the converter retains
the corresponding announcement or executes an adaptive retrieval loop.

Retrieve D0 onward only until the announced count is complete, stopping on an
empty reply or at D9. The listed D commands are alternatives in that rule, not ten
unconditional reads. No service-request or elapsed-time simulation is performed.

Before fixed converter programming, capture identity, PR2 calibration readbacks,
actual reply grouping and byte widths, startup behavior and converter settings.
Tensiomark also needs response order and heating-cycle evidence. The
[audit reconciliation](sdi12-protocol-audit/RECONCILIATION.md) records the remaining
source limitations; the [readiness programme](../superpowers/specs/2026-10-04-sdi12-prebench-readiness.md)
tracks activation and persistence work.

Use the [bench capture package](sdi12-bench-capture.md) to turn an explicit recipe
input into an empty evidence record, then check observed command timing and raw
radio correspondence. Its successful results remain unqualified.
