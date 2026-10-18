# Preview SDI-12 replies and response capacity

The offline protocol preview checks command-labelled M/C exchanges before recipe
compilers depend on their framing. It verifies addressed numeric replies and CRC,
collects D blocks by announced count, and reports incomplete or aborted exchanges.
It also calculates response capacity under an explicit packing assumption.

```sh
node scripts/preview-sdi12-exchange.js --list
node scripts/preview-sdi12-exchange.js --example standard-crc
node scripts/preview-sdi12-exchange.js --example sparse-concurrent
node scripts/preview-sdi12-exchange.js --example pr2-six-m
node scripts/preview-sdi12-exchange.js input.json
```

Every result keeps `hardware_verified`, `acquisition_available` and `eligible`
false. Exit 0 means a complete framed exchange, a valid capacity calculation or
successful listing. Incomplete, aborted, zero-value and invalid exchanges exit 1.
No hardware commands, persistence or live ingestion are involved.
File input must be a regular file of at most 1 MiB. The limit applies to bytes
read, including when a file grows after its initial size check.

## Inspect an exchange

A file has an operation and its input. This synthetic example intentionally
returns one value per block even though both fit D0:

```json
{
  "operation": "exchange",
  "input": {
    "command": "1M3!",
    "response": "10022\r\n",
    "blocks": [
      {"command": "1D0!", "response": "1+12.3\r\n"},
      {"command": "1D1!", "response": "1-0.5\r\n"}
    ]
  }
}
```

The output retains the signed token strings, numbers and raw D responses. It
does not decide which sensor channels those values represent. CRC variants use
commands such as `1MC3!` or `1CC3!`; a required CRC is checked rather than stripped
without validation. Encoded CRC bytes may include DEL (0x7f).

Addresses are case-sensitive. CR/LF must be present exactly; the parser does not
repair copied display text. Each D command must be supplied in sequence starting
at D0 because its response carries no block index. Up to D9 is supported. A value
must fit within one reply. The numeric grammar allows signed decimals with up to
seven digits, without exponent notation or whitespace.

If supplied replies stop before the announced count, the report is `incomplete`
and supplies the next D command, unless D9 is exhausted. An empty valid D response
means `aborted`, clears the top-level partial values and supplies no next D command.
Extra blocks after completion or abortion invalidate the transcript. Zero-count
announcements are accepted only as the terminal `no_values` diagnostic when wait
is also zero and no blocks are supplied; this is a conservative preview policy.

The tool reports the announced wait but cannot verify elapsed time, service
requests or bus timing. A complete transcript does not establish that its blocks
came from one fresh acquisition or that a sensor used the intended calibration.

## Calculate capacity

```json
{
  "operation": "capacity",
  "input": {"family": "M", "value_count": 6, "value_width": 6, "crc": true}
}
```

This returns `packed_blocks: 2` and `packed_wire_bytes: 48`: 36 numeric characters,
plus two sets of address/CRLF and CRC bytes. It also returns
`actual_block_count_known: false`. Width includes each value's sign and decimal
point. The calculation assumes equal widths and tight packing; the standard lets
sensors use smaller groups. The count excludes commands, announcements, converter
wrappers and radio overhead. It is not a regional payload or airtime budget.

Sequential M replies allow 35 numeric characters per block; concurrent C replies
allow 75. Address, CRC and CR/LF are outside that value limit. The implementation
follows [SDI-12 1.4 §§4.4.8–4.4.12](https://www.sdi-12.org/current_specification/SDI-12%20Specification%201.4%20February%2020%202023.pdf).

## Evidence and remaining integration

The [example corpus](../../scripts/fixtures/device-integration/sdi12/protocol-examples.json)
distinguishes a published standard CRC example from synthetic cases. It records
framing substitutions and omitted service requests. The malformed Tensiomark case
adds synthetic framing to the printed `0082` notation to demonstrate rejection;
it is not a manufacturer wire capture. The 36 SDI-12 arithmetic cases in the
external audit are tested as packed-capacity estimates.

The [audit reconciliation](sdi12-protocol-audit/RECONCILIATION.md) records why this
slice does not select a PR2 fixed block layout, qualify TEROS firmware/EC scaling,
bind Tensiomark response positions or enable HydraScout. Existing candidate
normalizers remain provisional and their interpretation rules are unchanged.

The [transport replay lab](sdi12-transport-lab.md) begins at LoRaWAN payloads; this
tool begins at labelled SDI-12 replies. Joining them requires a converter-wrapper
parser over preserved raw bytes. The shipped codec's `data_sum` has already lost
slot/length markers, so it is not input for reconstructing those boundaries.
The [converter preview](sdi12-converter-preview.md) now preserves single-frame
wrappers under explicit configuration assumptions and can supply labelled replies
to this parser. Segmented assembly, command execution/timing, source-backed recipe
generation and installed-device qualification remain later work.
