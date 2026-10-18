# Tensiomark acceptance hardening

Independent review found and corrected two data-path defects after the initial
field integration. A customer UI fix also restores the sensor card's Details
link. Fresh target-network telemetry remains pending; software verification does
not establish reception or sensor accuracy.

This continues the [initial execution report](2026-10-15-tensiomark-field-execution-report.md)
under the [reviewed hardening plan](2026-10-16-tensiomark-acceptance-hardening.md).
Customer identities, access details and live captures remain outside this public
repository.

## Corrected behavior

The shared codec previously removed some non-printable and high-bit bytes before
the strict Tensiomark parser could inspect them. That could turn a malformed
response into an apparently valid measurement. Edge commit `273a9e797` validates
the original uplink bytes for explicitly configured Tensiomarks, checks each
command envelope, and requires a complete addressed record in each envelope.
Rejected frames retain their raw evidence and cannot write soil channels. Both
runtime profiles contain the same fix; other probe decoders are unchanged.

Cloud commit `2db1b066` includes the saved SDI-12 layout in the JDBC history
projection. Before the fix, a rejected latest reading could hide older valid
channels when depths were unknown. The PostgreSQL regression now proves that
all four configured channels remain available to the catalog, history analysis
and CSV export. Unknown depths remain empty, and these channels remain excluded
from root-zone aggregation.

The customer UI fix passes the device identifier to its existing card footer.
Rendered tests cover the Details link and a two-probe history page with four
series and unknown depths. The public footer has a different interface, so this
change belongs only to the customer overlay.

Edge commit `83ae9a97d` replaces the generic wet/moist/dry indicator for an explicit
unverified Tensiomark layout with a neutral calibration note, including when no
readings are available. Numeric values and history controls remain visible.
Rendered tests cover German labels and preserve the ordinary status indicator for
other probes. Public test fixtures use synthetic identities.

## Verification evidence

Reviewers reran these checks on the final code. Counts overlap and must not be
added into a unique-test total.

| Check | Result |
|---|---|
| Edge focused normalizer, runtime and related suites | 177 passed |
| Independent malformed byte and envelope cases | 569 passed |
| Production ingest replays | 17 passed, including three captured packets |
| Full edge sync verifier | Exit 0; all profile parity checks passed |
| Edge codec, wiring, helper registration and function parsing | Exit 0 |
| PostgreSQL history continuity, soil policy and analysis catalog | Build successful |
| Cloud API adapter, card, history modal, Details page and model | 56 passed |
| Customer frontend build | Exit 0 |
| Edge card and real-locale presentation tests | 34 passed |
| Edge presentation typecheck and public/customer builds | Exit 0 |

The captured packets came through the previous network. Their replay preserved
the four canonical values exactly, but it does not prove reception on the target
network. Invalid-byte and command-boundary regression tests failed before their
corresponding fixes and passed afterward.

## Remaining acceptance

Independent edge readback confirmed the reviewed helper hashes, preserved all
10,447 previous history rows exactly after the final UI rollout, and found healthy services, an unchanged
device configuration, migration head 74, valid database integrity and no foreign
key violations. Independent cloud readback confirmed the exact reviewed image,
healthy services, preserved peer containers, unchanged migration ledger and
matching device metadata. Gateway heartbeats and sync processing resumed with no
recent rejection or pending delivery age. All 96 deployed edge GUI files match
the reviewed build; independent HTTP checks also matched the index, application
assets and English/German device locales.

The radio handover must produce a fresh target join and an addressed uplink linked to
both its raw observation and canonical four-channel row. Cloud acceptance requires
the same timestamp and values, followed by ordinary authenticated dashboard and
history checks. Repeated cycles are needed to check ongoing operation.

A bounded, read-only operator-side analyzer is ready to inspect arriving data.
It independently checks payload framing, address attribution, raw conversion,
configuration and normalized snapshots, battery bytes and cloud equality. Its
three-cycle verdict requires the expected 20-minute cadence; pending cloud rows,
rejections and analysis issues block that verdict. Fourteen local tests and
17 independent adversarial cases passed, including evidence retention across
restarts and transient read failures. The conversion check agreed with production
rounding for all 7,001 pF values from 0 to 7 in steps of 0.001.

Installation depths and zone assignment require operator input. The calibration
range remains `unverified`, and the field interpretation remains `bench_observed`.
No calibration accuracy, battery lifetime or unattended field acceptance is
claimed by the software tests.
