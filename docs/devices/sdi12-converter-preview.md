# Preview Dragino SDI-12 wrappers offline

The converter preview retains raw reply bytes and command-slot boundaries before
the shipped codec discards them. It can inspect a single wrapped payload, model
its serialization and check an explicitly labelled exchange with the
[SDI-12 protocol parser](sdi12-protocol-preview.md).

```sh
node scripts/preview-sdi12-converter.js --list
node scripts/preview-sdi12-converter.js --example vendor-pdta
node scripts/preview-sdi12-converter.js --example wrapped-crc
node scripts/preview-sdi12-converter.js input.json
```

File mode accepts a regular JSON file up to 1 MiB, with exactly `operation` and
`input`. Operations are `frame`, `model` and `exchange`. Successful inspection or
modelling exits 0; diagnostic, incomplete, aborted and invalid results exit 1.
Every result has `hardware_verified`, `acquisition_available`, `eligible` and
`configuration_verified` set to false. No command is sent or setting changed.

## Declare the layout

The manual treats PAYVER as configurable independently of DATAUP. The shipped
decoder instead uses the pairing 1/single and 2/segmented as its layout convention.
This offline tool requires the caller to declare DATAUP and the expected PAYVER.

| Caller DATAUP | Expected PAYVER | Offline interpretation |
|---|---|---|
| 0 | Any byte matching the frame | Three-byte header, followed by wrapped returns |
| 1 | Any byte matching the frame | Five-byte header; retain fragment bytes, refuse exchange assembly |
| Either | Does not match the frame | Refuse with a PAYVER mismatch |

The configuration also asserts ALLDATAMOD=1, DATACUT and DATACONV cleared for every slot and
EXT=0,0,0. Other configurations are outside this preview. A matching byte or a
well-formed body does not verify those assertions on a device.

```json
{
  "operation": "frame",
  "input": {
    "fport": 2,
    "bytes": [12,132,1,241,13,48,43,49,46,48,56,43,50,52,46,54,13,10],
    "configuration": {
      "dataup": 0, "payver": 1,
      "alldatamod": 1, "datacut": "none", "dataconv": "none", "ext": [0,0,0]
    }
  }
}
```

The bytes above come from the manual's PDTA example. Extraction removes the log
address, date/time and stored-length field, then joins two printed hex lines.
The 18-byte result contains a 3204 mV battery field and slot 1's 13-byte return
`0+1.08+24.6\r\n`. It is a vendor log example interpreted under declared settings,
not an installed-device uplink capture or proof of those settings.

The inspector consumes each slot marker and length exactly. It retains byte arrays
and direct byte-to-character text, including CR/LF, DEL and binary bytes. It rejects
duplicate slots, unknown markers and truncated records rather than searching for
a plausible next marker. Empty returns remain empty. Successful wrapper parsing
does not validate the response as SDI-12.
The inspector's 255-byte frame bound is a software input limit, not a radio budget.
It can retain records longer than the model's documented 100-byte return limit
for diagnosis; that does not establish converter support for those records.

## Check a labelled exchange

An `exchange` input contains `frame` in the form above and `bindings` such as:

```json
[
  {"slot": 1, "response_command": "0MC!"},
  {"slot": 2, "response_command": "0D0!"}
]
```

Bindings must cover every received slot exactly once. The parser uses wire order
and requires the first reply to be an M/C announcement, then sequential D replies.
It never invents an announcement, repairs missing CR/LF or selects convenient
records while dropping others. The nested `exchange` reports standard framing,
count and CRC validation; incomplete and aborted measurements retain those states.

`response_command` identifies the command that elicited the preserved reply. It
is not necessarily the configured COMMANDx text: automatic D0 can return D0 data
from a slot configured with M. Bindings are caller hypotheses, reported with
`bindings_verified:false`. Even a complete result proves neither command execution
nor that the replies came from one fresh acquisition.
Reports retain detached configuration and binding copies so the exact caller
assumptions, including measurement-command suffixes, remain inspectable.

## Model a payload

`model` input specifies `battery_mv`, `interrupt`, `payver`, `returns` as an ordered
array of `{slot,bytes}`, and `max_payload_bytes`. The model emits literal header,
slot, length and return bytes. It reports `required_bytes` and refuses a payload
that exceeds the supplied budget. Each modelled return is limited to 100 bytes. The budget is caller policy; the tool does not
choose a legal LoRaWAN region/data-rate limit.

This model serializes supplied replies. It does not emulate SDI-12 command timing,
retries, automatic D0, DATACUT/DATACONV, EXT, NEWLINE or radio scheduling. Modelling success
is not evidence that a firmware version supports the constructed payload.

## Source and bench boundary

The [Dragino manual](https://wiki.dragino.com/docs/LoRaWAN-End-Node/io-controllers-sensor-nodes/sdi-12-lb/),
checked 2026-10-04, supplies the wrapper rule in §2.3.4, independent PAYVER setting
in §3.6, PDTA bytes in §3.7, added EXT fields in §3.11 and NEWLINE behavior in
§3.12. F1..FF follows its COMMAND1..COMMANDF slot range; F0 has no documented slot.
DATACUT takes precedence over ALLDATAMOD, so enabling all-data mode alone does not
establish whole-reply forwarding. The model's assumptions require readback.

DATAUP=1 accepts counts 1..15 with zero-based indexes and remains diagnostic even
when its count is one. Fragment boundaries can
split slot headers or replies. The tool retains each fragment without claiming
that counters, indexes or PAYVER identify a common acquisition. The
[transport lab](sdi12-transport-lab.md) demonstrates the unresolved mixed-cycle
problem separately. The shipped codec also filters DEL and drops markers before
assembly; its `data_sum` cannot reconstruct their original positions.

At the bench, retain configuration readbacks, console commands and byte-exact
responses together with raw radio payloads, timestamps, frame counters and session
information. Compare changing widths, CRC replies including DEL, missing replies
and fragment boundaries. Record retries and resets. Those captures can replace
specific model assumptions without changing the parser's raw-evidence interface.
Include COMMAND, DATACUT, DATACONV, ALLDATAMOD, DATAUP, PAYVER, EXT and NEWLINE in
the configuration record. Never infer cleared cuts or conversions from ALLDATAMOD
alone.

The [sensor recipe preview](sdi12-recipe-preview.md) supplies model-specific
logical commands, discovery/readbacks and transcript checks on top of this wrapper
model. It emits no fixed converter recipe or deployment commands.
