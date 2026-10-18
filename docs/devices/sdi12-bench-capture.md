# Capture and replay an SDI-12 bench run

Use this package to prepare PR2/4, PR2/6, TEROS 11/12 and Tensiomark variant 1
captures before connecting hardware. It generates an empty evidence record from
an explicit recipe input, then checks filled records with the existing protocol
and converter previews. HydraScout measurement planning remains unavailable.

A `consistent` result checks the supplied record. It does not establish valid
calibration, field meaning, applied converter settings or a fresh acquisition.
Every result keeps hardware, configuration, acquisition, eligibility and deployment
qualification false. No command in the checker opens a serial port or sends data.

## Prepare a record now

From the repository root, list and replay the synthetic examples:

```sh
node scripts/check-sdi12-capture.js --list
node scripts/check-sdi12-capture.js --example pr2-six-radio
```

Start a new record from a recipe input in the
[recipe preview format](sdi12-recipe-preview.md). Use the actual intended profile,
address, depths, supply and interval; `exchange` must be null. Converter budgets
are explicit assumptions until the installed firmware and regional/data-rate limit
are established. Existing example inputs are available in
`scripts/fixtures/device-integration/sdi12/recipe-examples.json`; their defaults
are synthetic and must be reviewed for the intended setup.

```sh
node scripts/check-sdi12-capture.js --template /tmp/recipe-input.json > /tmp/template-result.json
node -e 'const fs = require("node:fs"); const r = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); if (!r.ok || !r.capture) process.exit(1); process.stdout.write(JSON.stringify(r.capture, null, 2) + "\n");' /tmp/template-result.json > /tmp/capture.json
node scripts/check-sdi12-capture.js /tmp/capture.json
```

Run the second command only if template generation exited 0. The last command
initially exits 1 with missing-evidence paths. Keep that empty template separately
from each completed or failed trial. The CLI accepts regular JSON files up to
1 MiB and also works by absolute script path from another directory.

## Evidence to keep together

Give every run a distinct `capture_id` and UTC capture-start `captured_at` timestamp, including
milliseconds. Use a separate local directory for its JSON, original console/bus
logs, raw radio event and photos of labels/wiring. Keep actual captures outside
the public repository; reviewed fixtures can be added later with clear provenance.
Exclude AppKeys, passwords and access tokens from exported evidence.

| Record field | What to record |
|---|---|
| `evidence` | `bench` for an observed run, `synthetic` for a constructed rehearsal; this is a declaration, not authentication |
| `setup.sensor_label` | Physical model/variant/serial label; keep a photo alongside the JSON |
| `setup.converter_*` | Actual model, firmware and unmodified settings text with credentials omitted; required for radio scope |
| `recipe_input` | Intended configuration plus the exact observed command/announcement/D replies in `exchange` |
| `discovery` | Each generated command and its observed response bytes in the generated order; null means absent, an empty array means an empty reply |
| `timing` | Command/announcement times in milliseconds from one monotonic clock origin; never derive them from the expected wait |
| `radio` | Original FPort 2 payload bytes, settings interpretation, explicit slot bindings, receive timestamp, DevEUI, frame counter and local session reference |

The discovery responses remain uninterpreted. Even arbitrary nonempty bytes can
satisfy structural completeness; a person must establish identity, installed depth
count and calibration semantics before using values. The checker cannot verify
that free-text settings agree with structured frame configuration.

Keep `\r\n` in JSON response strings as escaped carriage-return and newline bytes.
Preserve signs, decimal precision, addresses, CRC and DEL. Do not trim a terminal
copy or reconstruct a framed reply from numeric decoder output. Discovery uses
integer byte arrays so even an unexpected response remains intact. For missing
announcements, preserve the empty response and original timeout log; for a missing
D reply, omit that uncaptured block. Neither should be filled from a manual example.

`measurement_started_ms` records the measurement command. `announcement_received_ms`
records its full response. `data_requested_ms` has one entry per recorded D block;
null preserves a missing timestamp. Check against the conservative rule of waiting
the full announced seconds after receiving the announcement. The tool does not
schedule early reads from service requests. Record `power_on_ms` when observed;
no delay is treated as sufficient for startup. `since_previous_start_ms` is the
observed gap to the previous measurement start, including comparison/retry starts.
Null leaves prior history unresolved, even when the rest of the record is consistent.

## Per-sensor sequence and stop conditions

Use one isolated probe with an appropriate SDI-12 interface and the model's
specified supply/wiring. Confirm physical labels and the installed adapter's
instructions before powering it. A compatible voltage alone does not establish
available current or correct wiring. The [recipe preview](sdi12-recipe-preview.md)
contains the documented supply ranges and source editions.

The table uses `a` for the known sensor address. Generate the actual command bytes
with the recipe preview. Record discovery replies before the periodic measurement.
Do not change addresses, calibration or converter settings through this package.

| Sensor | Discovery and measurement | Stop or retain as unqualified when |
|---|---|---|
| PR2/4 | `aI!`, `aXRM3S1!` through `aXRM3S4!`; selected M3/MC3/C3/CC3 | Installed four-position model or any M3 calibration/unit readback is unresolved |
| PR2/6 | `aI!`, `aXRM3S1!` through `aXRM3S6!`; selected M3/MC3/C3/CC3 | Installed six-position model or any readback is unresolved; never assume D0 holds all six values |
| TEROS 11 | `aI!`, selected M/MC, two values | Firmware applicability, raw-field meaning, sensor errors or startup behavior is unresolved |
| TEROS 12 | `aI!`, selected M/MC, three values | Same constraints, plus EC-unit applicability |
| Tensiomark 4244/1 | `aI!`, M, two raw values | Variant/output mode, field order, sensor errors or power/heating behavior is unresolved |
| HydraScout | Preserve labels and existing logs; seek the installed model's applicable command reference | No measurement command, grouping or conductivity interpretation is established |

For Tensiomark, read the [unit investigation](tensiomark-output-units-investigation.md)
before preparing hardware. A later GeoPrecision manual documents a different field
order and selectable pressure output, but its setting examples contradict each
other. The table above does not establish that manual's applicability or authorize
the checker to interpret its flag replies.

After the announcement, wait as recorded, then retrieve D0 onward until the
announced count is complete. Stop on an empty reply, invalid CRC/framing, wrong
address/count, or D9 without completion. Preserve partial and aborted transcripts.
PR2 identity alone does not establish four versus six positions. Its manufacturer
reference check uses raw mV with specified protective geometry; do not substitute
M3 air/water percentages as acceptance thresholds. See
[Delta-T PR2 manual v4.1, pp. 39–40 and 49–52](https://delta-t.co.uk/wp-content/uploads/2016/09/PR2_SDI-12-_User_Manual_version_4_1.pdf).

TEROS concurrent forms are excluded from this preview because the documented
behavior deviates from the standard. Switched power at address 0 is refused.
Preserve observed firmware digits; an example identification string does not
qualify the installed firmware. Known error sentinels must remain diagnostic even
if they form a valid numeric vector. See
[METER guide 18224-12, firmware applicability and SDI-12 sections](https://publications.metergroup.com/Integrator%20Guide/18224%20TEROS%2011-12%20Integrator%20Guide.pdf).

Keep at least 15 minutes between Tensiomark measurement starts, including retries
and comparison trials. If the previous start is unknown, establish a full waiting
interval before another start and record the basis in the original log. The
15–20-second warm-up discussion plus the eight-second announcement does not prove
a 25–30-second SDI-12 power window. Keep both response positions unbound until
confirmed. See [Tensiomark May 2014 manual, §§5.1.5, 5.2.5, 6 and 7](https://www.stevenswater.com/resources/documentation/Stevens_Tensiomark_Manual.pdf).

The [audit reconciliation](sdi12-protocol-audit/RECONCILIATION.md) takes precedence
over unreconciled recommendations in the original research files.

## Add radio evidence

Start with `scope:serial` and `radio:null`. For a run observed through a converter,
use `scope:radio` and preserve its settings snapshot and original event. Capture
COMMAND slots, DATACUT, DATACONV, ALLDATAMOD, DATAUP, PAYVER, EXT and NEWLINE through
the installed firmware's documented readback procedure. This guide does not supply
unverified AT commands or a configuration-write sequence.

The `radio.frame` and `radio.bindings` fields use the
[converter preview input](sdi12-converter-preview.md). `received_at` is UTC with
milliseconds; `dev_eui` is 16 hex characters; `fcnt_up` is an unsigned 32-bit
counter; `session_ref` identifies the retained local join/session evidence. Use
null when unknown; this preserves the frame and reports missing evidence. A
nonblank session label or frame counter by itself does not establish freshness.

The checker currently compares one complete DATAUP=0 uplink with the serial
exchange, byte for byte and command for command, using the supplied slot bindings.
Slot numbers need not match the preview's hypothetical assignments. Battery and
interrupt header values may differ from modelling inputs; PAYVER and budgets must
match. Equal numeric values with different framing or formatting fail comparison.
A matching pair still cannot prove the converter took those values in that cycle.

Preserve DATAUP=1 fragments separately with timestamps, counters and session data;
this checker returns a diagnostic instead of joining them. Replay transport cases
through the [transport lab](sdi12-transport-lab.md). Keep any FPort 100 debug frames,
queue IDs, ACKs and resets in the original run directory. They do not fit this
single-measurement record and must not be rewritten as FPort 2 data.

## Trials and decisions to prepare

| Trial | Evidence and decision |
|---|---|
| Cold start | Observe supply/current and startup traffic before discovery; determine whether unsolicited bytes or insufficient warm-up affect the first exchange |
| Normal cycles | Capture complete command timing, every D block and radio bytes; repeat across observed value widths to establish grouping and wrapper preservation |
| No response | With the isolated setup safely powered down before rewiring, arrange the documented disconnected-probe test; retain timeout/empty evidence and confirm it never becomes a complete vector |
| Interrupted configuration | Rehearse failure in offline fixtures now; physical interruption belongs to a separately reviewed converter configuration procedure with before/after readbacks |
| PR2 calibration | Preserve all XRM3 replies and request an applicable reply grammar before accepting units; compare M3/C3 grouping only as separate permitted trials |
| TEROS interpretation | Establish firmware, error values and raw/EC meanings with applicable documentation and a trusted comparison instrument |
| Tensiomark timing/order | Record power/current and complete replies over properly spaced starts; obtain field-order/error confirmation before assigning channels |
| HydraScout protocol | Obtain the exact installed model's command/count/unit/timing contract before designing a measurement trial |

Exit 1 can describe a useful failed capture: inspect `code`, `missing`, `preview`
and `radio_check`. Preserve the original JSON and record corrections separately;
never edit readings or invent timestamps to make a check pass. Templates and all
bundled successful examples are preparation aids, not installed-device evidence.

A later integration trial must also retain the stored row, API result, local/cloud
history and export alongside the raw capture. This package does not replay into
production or enable candidate sensors. Those boundaries remain in the
[readiness programme](../superpowers/specs/2026-10-04-sdi12-prebench-readiness.md).
