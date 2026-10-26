# Audit intake and implementation decisions

The supplied audit advances offline work, but several recommendations depended on
assumptions that cannot become parser or recipe guarantees. This review checked
the claims used by the next implementation slice, not all 139 research claims.
The original five JSON files remain research provenance. Their quotations,
annotations and reported hashes must be checked before a new rule depends on them.

Luna checked the PR2 command tables and standard framing; Terra checked TEROS and
Tensiomark applicability/timing; Sol reviewed the cross-sensor recommendations and
bench procedures. Root checked the standard's grouping/abortion rules. Astra then
reviewed the protocol-preview implementation plan independently.

## Adopted corrections

| Finding | Implementation decision | Basis |
|---|---|---|
| Packed block counts are not sensor behavior | Read D0 onward until announced count; tolerate sparse groups, never split a value; stop by D9 | SDI-12 §§4.4.8.3–5 explicitly allow smaller groups even when D0 has room |
| Empty D response is terminal | Report aborted, never skip to the next block or complete a partial vector | SDI-12 §4.4.8 |
| CRC has its own bytes | Verify CRC before numeric parsing; exclude address/CRC/CRLF from the 35/75 character value budget; allow DEL in encoded CRC | SDI-12 §§4.4.8, 4.4.12 |
| PR2 printed C response has one count digit | Refuse it as a C announcement; do not pad or silently reinterpret | PR2 pp. 49–50 versus standard `atttnn` |
| Tensiomark prints four-character announcements | Keep `0082`/`0011` as incomplete published notation; reject them as wire frames | Manual §5.1.5 versus standard `atttn` |
| Full-response forwarding crosses two protocols | First preserve converter wrappers from bytes; then parse labelled SDI-12 replies. This slice implements only the latter | Dragino ALLDATAMOD/DATACUT documentation; current codec drops marker and length bytes |
| Fixed-cut prohibition was too broad | Existing verified Sentek behavior stays unchanged; no general variable-width cut is established for these new recipes | Audit examples and Dragino documentation |

Standard source: [SDI-12 1.4, February 2023](https://www.sdi-12.org/current_specification/SDI-12%20Specification%201.4%20February%2020%202023.pdf).
Probe source: [Delta-T PR2 v4.1](https://delta-t.co.uk/wp-content/uploads/2016/09/PR2_SDI-12-_User_Manual_version_4_1.pdf).
Converter source: [Dragino SDI-12-LB/LS](https://wiki.dragino.com/docs/LoRaWAN-End-Node/io-controllers-sensor-nodes/sdi-12-lb/).

The `calculations.json` formula `ceil(k / floor(cap/w))` remains correct for equal
widths and tight packing. Its `blocks` fields are capacity estimates, not predicted
or maximum observed blocks. The preview names this result `packed_blocks` and
reports `actual_block_count_known: false`. CRC adds three bytes to each D response.
These counts exclude converter headers, radio overhead and acquisition commands.

## Sensor qualification remains separate

PR2 readbacks must establish the intended mode/calibration at every installed
position. The only printed calibration reply is an M2 example, so the audit does
not yet supply a validated M3 parser. PR2/4 and PR2/6 identification strings alone
do not distinguish the installed depth count. The manufacturer's reference check
uses raw mV, with the probe protected as instructed in pp. 39–40; derived M3
air/water percentages are not acceptance limits.

TEROS guide editions disagree on older EC units. The current guide is labelled
3.00+ but still prints a `114` identity example. Preserve observed identity digits;
do not treat that example as a 3.x capture or automatically qualify a descriptor
from it. The RAW-to-calibrated-count equivalence is a supported inference, not an
explicit equation-to-wire declaration. Sentinel handling before the reviewed
1.14-era guide is unestablished; whole-vector refusal remains a software policy.
The proposed 250 ms startup delay is based on typical timing, not a guaranteed
maximum. Sources: [METER integrator guide](https://publications.metergroup.com/Integrator%20Guide/18224%20TEROS%2011-12%20Integrator%20Guide.pdf),
[METER manual](https://publications.metergroup.com/Manuals/20587_TEROS11-12_Manual_Web.pdf).

Tensiomark's specification allows 7–14 V and recommends 12 V. Its 15–20 s warm-up
discussion concerns analog logger experience; adding the separately stated eight
seconds gives an experiment, not a proven SDI-12 power window. Keep at least 15
minutes between measurement starts, including comparative trials. Variant 1's
quantities are pF and temperature, but the manual supplies no D-response ordering.
This slice parses raw numbers without binding those positions. Source:
[ecoTech May 2014 manual](https://www.stevenswater.com/resources/documentation/Stevens_Tensiomark_Manual.pdf).

The [2026-10-05 unit investigation](../tensiomark-output-units-investigation.md)
adds a GeoPrecision 2019 protocol manual with selectable pF/mbar output and a
temperature-first example. Its flag examples contradict its bit table. The legacy
download's hardware applicability remains unresolved; the pF-only and unknown-order
statements above describe the 2014 source, not the whole product family. Keep the
raw capture path unbound until the installed revision is established.

HydraScout's archived quantity list does not establish SDI-12 command mapping or
grouping. It leaves the legacy EC interleave unsupported; it does not prove an
alternative wire layout. Keep `protocol_evidence_required`. No applicable protocol
reference was found in the reviewed source set; that is narrower than claiming
none exists. The archived pages and catalogue access limits remain listed in
`hydrascout.evidence.json` and the audit report.

The old review note about a second circulated Tensiomark manual is not a verified
source here. The current audit found distributor material with differing bounds,
but did not identify that alleged second manual. Variants 2/3 remain outside the
candidate scope; no extra manual is required to preserve that refusal.

## Next boundary

The [protocol preview](../sdi12-protocol-preview.md) accepts raw command-labelled
responses. A future converter emulator must establish wrapper lengths, slot
mapping, retry behavior and retention of CR/LF/CRC from raw payload bytes before
joining this parser to the transport lab. It must also account for sensor timing
and regional radio limits. No current preview establishes command application,
measurement freshness or revision eligibility.
