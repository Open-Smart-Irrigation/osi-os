# Raspberry Pi 5 candidate acceptance

Run this local step of Release Runtime Smoke for each candidate image before sending
the real-device test sheet to Phil. The stock cases take about 45 minutes in
one `osi-heavy` slot. Allow extra time for the power-cut cases selected by the
candidate capability check.
The same candidate requires a green Pi 4 run for its 32-bit bcm2709 image.
[Pi 4 runbook](raspi4-emulator-acceptance.md).
The hosted smoke jobs use runtime fixtures. The emulator run needs the built
candidate, previous factory images and the workstation's offline deployment cache.

## Prepare the inputs

Set `GATE_TREE` to a separate tools checkout from `main` and `GATE_SHA`
to its pinned full commit SHA. Keep that checkout under the build directory.
The candidate image and offline deployment tree come from the release build
receipt and can use a different commit.

Build the `raspi5b` QEMU once via `osi-heavy` using the pinned tools, or reuse the
matching build. Keep `dtmerge` and `rpi5-bl31.bin` beside its executable. Install
host `qemu-system-x86_64` with the user-network backend, mtools, dosfstools,
Python 3.11 or newer, Node.js, Playwright and Chromium. Set `NODE_PATH` to the
directory containing the Playwright package if needed. Set `CHROMIUM_PATH` when
using a browser outside the Playwright cache. [Build the emulator](../../tools/raspi5/README.md#build-on-linux).

Use the Pi 5 factory archive and its SHA-256 from the candidate build receipt.
Prepare an offline release tree from the same revision with `react_gui.tar.gz`,
the deploy scripts and `SERVED-FROM.txt` containing the full Git SHA. Populate the
workstation npm cache with the tarballs from that tree's runtime lockfile.
Under the fixture root, provide one Pi 5 factory archive and its `SHA256SUMS`
in each of `v0.8.0/` and `v0.8.1/`. Use factory inputs and synthetic test data.

## Run the gate

```bash
"$GATE_TREE/tools/raspi5/acceptance.sh" --tools-revision "$GATE_SHA" \
  --candidate "$PI5_FACTORY_IMAGE" --candidate-sha256 "$PI5_FACTORY_SHA256" \
  --osi-version "$OSI_VERSION" --chirpstack-version "$CHIRPSTACK_VERSION" \
  --release "$OFFLINE_RELEASE_TREE" --release-revision "$CANDIDATE_SHA" \
  --fixtures "$FIXTURE_ROOT" --run-root "$EVIDENCE_ROOT" \
  --qemu "$PI5_QEMU"
```

Set `OSI_HEAVY` if the workstation wrapper is installed outside its default
location. Invoke the command outside any current `osi-heavy` holder so it can
queue its own slot. The evidence root must exist outside every Git worktree
and have room for sparse writable SD copies and USB media. The guest network is
restricted to the emulated link and a host-loopback GUI forward. Each boot
passes a fresh Unix socket pair to QEMU for the radio.

Record the command's exit code, `inputs.txt` and `results.log` from the printed
run directory with the candidate SHA, image checksum, and tools revision. The run must exit zero. The final table lists each expected case, its observed
result, and the reason and required replacements for every N/A. The run
fails if any replacement or other required case lacks a recorded PASS. The runner removes guest disks and USB media after cleanup and
keeps the compact receipts. Each case directory also holds the guest console
of every boot as `qemu-N.serial`, except for the private customer fixture.
When a boot stops, the runner reads leftover console output for at most 2 s;
if it gives up, the receipt can miss the last output and
`harness-events.log` records that. A boot that writes more than 16 MiB keeps
its first 16 MiB and its last 4 MiB, with a line between them that counts
the omitted bytes. The first-start marker wait allows 900 s. So does
the readiness wait on the 0.8.1 boot before an upgrade and on the customer
fixture's 0.7.0 and 0.8.1 boots, because a loaded host slowed the 0.8.1 boot
about sixfold. Use `--keep-scratch` for an owner-only copy of
the scratch media when diagnosing a failure. Keep private receipts local.
A missing or failed run holds the candidate. Physical SD power-cut, upgrade and
valve checks still belong on the real-device sheet.

## Additional cases

The default suite checks cold boot, GUI registration and login, WM1302 uplinks,
a STREGA valve open and its reported state, reboot persistence, three SQLite
power cuts and offline upgrades from 0.8.0 and 0.8.1.

Both radio cases drain pending radio packets, and each injection needs a WM1302
model receipt with the matching request ID. Rebuild QEMU with these tools if
the cached binary lacks the matching receipt protocol. Radio evidence comes
from the guest's persistent log, `/data/log/osi-system.log*`. The RAM ring
(`logread`) appears only in failure text and diagnostics.

Each join attempt reads ChirpStack's state, notes the size and inode of the
active persistent log, writes a marker to syslog and sends on a recorded
channel (902300000 Hz, 125000 Hz, SF7 for every uplink today). When the
join-accept has arrived or its wait has run out, the runner writes an end
marker and reads the log forward from the noted position, following that file
into the active file if logd rotated it. A change in the log files' inodes
during a read repeats the read, a failed file read fails the window, and a
stable layout without the noted inode means the evidence rotated away. The
read waits up to 10 s for the end marker to reach the file.
The window is the text between the two markers. The attempt counts as
received only with three parts:

1. A Concentratord `Frame received, uplink_id: N` line in the window at the
   recorded channel whose `count_us` comes from this request. The model's
   delivery receipt carries the 32 MHz timestamp it stamped on the frame. The
   HAL (sx1302_hal 2.1.0) turns that into `count_us` as timestamp / 32 in 27
   bits, adds its wrap bits and subtracts a decoding delay of about 0.46 ms at
   SF7 (15.4 ms at SF12). The line must sit within 20 ms below the stamp,
   modulo 2^27. Harness uplinks are seconds apart, so no other frame
   qualifies. A downlink that Concentratord enqueued, sent or dropped 5 s
   (RX1) or 6 s (RX2) after the frame corroborates it and is reported, but is
   not required. Concentratord 4.4.8 logs
   `Frame received` at INFO only after its CRC filter, and the image sets
   `disable_crc_filter=false`, so the line proves a CRC-valid frame. The
   stamp binding assumes the HAL's legacy timestamps, so the case fails
   with a named reason if the guest's `concentratord.toml` enables
   `[gateway.fine_timestamp]`. The image leaves that section unset.
2. The change in ChirpStack's state for that DevEUI across the send, read from
   `/srv/chirpstack/chirpstack.sqlite`: the attempt's DevNonce absent from
   `device_keys.dev_nonces` before and present after, `device_keys.join_nonce`
   advanced by one, and a new `device.dev_addr`. Once the join-accept has
   verified, its DevAddr must equal ChirpStack's new DevAddr, and its JoinNonce
   must equal ChirpStack's pre-send JoinNonce: ChirpStack 4.12.1 stores the
   incremented counter and sends the stored value minus one. No timestamps
   are compared. ChirpStack writes no log line for a join: the 0.8.3 candidate
   images do not route its output to syslog, and main routes it at `warn`
   only. ChirpStack 4.12.1 stores the DevNonce and increments the JoinNonce
   only after the MIC check, and writes the DevAddr before it sends the
   join-accept.
3. The join-accept at the emulated device inside the 40 s join window, with
   its delay.

The runner prints one line per attempt with the channel it sent on and all
three parts, or `MISSING` and the reason for each absent part. When parts 1
and 2 hold and only the join-accept is late or absent, the attempt is retried
with a fresh DevNonce, at most three attempts in total. Any other missing part
fails the case on that attempt, even if a later attempt could pass.

A failed join-accept reason says what Concentratord did with this join's
downlink, matched by its scheduled `count_us`:
`join-accept dropped by concentratord: too old, 6.5 ms after its TX time`
(the queue reached it after its time), `refused by concentratord at enqueue:
too late` with the lead time it had or how far past its time it was, or
`Concentratord scheduled the join-accept for TX`. One retained 0.8.3 run lost
a join-accept to the first case, with no counter wrap. The valve case has its
own receipt, under [Valve open and outcome](#valve-open-and-outcome).

`radio-diagnostics.log` counts selected log lines in both sinks (including
`Scheduled packet is too old`), lists ChirpStack's DevNonce count and DevAddr
state per device, and sums Concentratord's stats per process. Concentratord
publishes stats every 30 s and resets its counters after each publish
(`libconcentratord/src/stats.rs`), so one `Publishing stats event` line covers
one window, not the run. The persistent log also spans every guest boot on the
disk.

In the first 0.8.3 Pi 5 candidate run of 22 Nov 2026 (the radio guest's
Concentratord had PID 10075), the rotated and active log files together hold
six frames from that guest. Its publish at 16:45:27 (guest clock) reads
`rx_received: 1` for the frame at 16:45:27, and its publish at 16:45:57 reads
`rx_received: 3` for the frames at 16:45:33, 16:45:35 and 16:45:41. The frames
at 16:46:00 and 16:46:01 were never published: the guest's last line is at
16:46:09, before the next publish was due at 16:46:27. The last stats lines in
the file, all `rx_received: 0`, come from later boots of the same disk with no
radio traffic. The counts for the rotated file come from the gate's
per-attempt evidence analysis. This repository's own read of that disk could
not extract the rotated file, so it checked only the active file's window at
16:45:57.

### Valve open and outcome

The valve case proves three things about one open: the edge queued exactly the
timed open, the radio delivered that command to the emulated valve, and the
edge attributed the valve's OPEN report to that open. An emulator loss of the
downlink leads to a bounded retry. Every other failure ends the case on the
attempt where it shows.

Each attempt follows the same steps:

1. The runner notes the active persistent log, then issues the one-minute open
   from the GUI. A re-send skips this step: ChirpStack still holds the item.
2. No downlink for the valve may reach the model in the next 2 s. One that
   does fails the attempt, and its line names the decoded frame.
3. The edge's own database must show an accepted queue item for this open: the
   newest expectation the read before the issue did not hold, or the
   expectation carrying the re-sent item. Its `effect_snapshot` must name FPort
   2 and payload `4101`.
4. ChirpStack's `device_queue_item` must hold that item as FPort 2, payload
   `4101`, with `is_encrypted 0` and `is_pending 0`, as the first item for the
   device. ChirpStack 4.12.1 builds the next downlink from the first queue
   item and stores an edge enqueue as plaintext. On a fresh open the item must
   not carry `f_cnt_down` yet. Nothing is sent until steps 3 and 4 hold.
5. The runner sends one uplink and waits 40 s for the command at the model.
   Every downlink for the valve that carries an application port is decoded,
   on time or late, and must be FPort 2 with payload `4101`. MAC-only frames
   and FPort 0 frames are left alone. On a miss the runner keeps reading the
   socket until 150 s after the uplink, so a wrapped command and any later
   copy of it leave the socket before the next attempt.
6. The runner reads the Concentratord and MQTT forwarder window of the
   attempt, then ChirpStack's queue again.

An attempt counts, as a delivery or as grounds for a retry, only when the
decision is bound to the downlink ChirpStack built for the attempt's own queue
item:

- the window holds exactly one ChirpStack downlink command, as the forwarder
  logs it (`Received downlink command, downlink_id: N`);
- Concentratord took that downlink ID in RX1 or RX2 of this uplink and logged
  a refusal for it, or a TX in the slot where it was enqueued. A `Scheduled
  packet is too old` line names no downlink ID and counts for nothing. RX1 opens `RXDelay1` seconds after the
  uplink, as the join-accept told the valve (0 means 1 s), and RX2 one second
  later. A session without `RXDelay1` fails before anything is sent;
- the queue after the attempt agrees with the gateway's ack for that ID
  (`Received ack, items: [...]`): ChirpStack deletes an unconfirmed item only
  on an `OK` ack;
- an item still queued carries `f_cnt_down`. ChirpStack writes it on an
  unencrypted item each time it builds a downlink from that item. On a fresh
  open, where the item had none before the uplink, that shows the window's
  downlink came from the item. On a re-send the counter predates the attempt,
  and the tie rests on the exact receive slot of this uplink and on ChirpStack
  building the downlink from the head of the queue;
- a delivered frame carries the `f_cnt_down` ChirpStack recorded for the item
  before the attempt, compared on the low 16 bits the wire carries.

At most three attempts run. A counted fresh open leads to another attempt
when the command was late or absent at the model. A re-send leads to another
attempt only when the command reached the model late; a re-send that missed
fails the case with its receipt, so a decision for another downlink can never
add an attempt.

A retry re-sends while ChirpStack's queue still holds the item: the next
uplink alone opens a receive window for it, and the edge's expectation stays
the same one. Once ChirpStack has consumed the item and the valve got the
command late, the valve reports that run before another open is issued: it
sends the OPEN report, waits until the timed open has ended, and sends the
CLOSED report. With the clock not synchronised, the edge attaches an OPEN
report to the one pending open that has no report, and to none when two are
pending (`workers.js`, `attachUntrustedReportTx`). An expectation whose OPEN
and CLOSED reports arrived is closed to later reports. The runner waits for
both reports on that expectation and for the device to show `CLOSED` before
the next GUI open.

These outcomes fail the case on their attempt, with the receipt, and are
never retried:

- No downlink was logged at all: `no open-command downlink logged`. Decisions
  without a ChirpStack downlink command, two commands in one window, or a
  command Concentratord never took name the IDs involved and end with `the
  attempt is not credited`.
- ChirpStack's downlink was taken at another offset: `unsupported or unknown
  RX timing`, with the offset. This holds when the command arrived on time,
  too.
- A re-send of a still-queued item missed the model: `the re-send of queue
  item <id> on attempt N missed`.
- The command was delivered, but ChirpStack still holds another item for the
  valve, such as a second open: `the open was delivered, but ChirpStack still
  holds ...`.
- The item left ChirpStack's queue, Concentratord logged a decision, and the
  command never reached the model: `open command lost`. Its expectation stays
  pending for its allowance, so a second open would leave the valve's OPEN
  report unattributed.

Three attempts without an on-time delivery, each late or a refused fresh open
followed by a late re-send, end the case with `open command not received after
3 attempts`.

The outcome is bound to the attempt that succeeded. The device must show
`CLOSED` before that attempt's OPEN report and `OPEN` after it, the
expectation of that attempt must hold the OPEN report, trusted or not, and
every expectation reported over before a re-issue must keep its row, its
trusted `observed_open_at` and `observed_close_at` times and its untrusted
report exactly as they stood then. A change is named field by field. The GUI
outcome step reads the valve's reported state, which belongs to the device.

Each attempt logs one line whatever its outcome, so a refused GUI open, a
refused model uplink, a wrong payload and a downlink before the receive window
each leave a line with the reason and the parts collected until then. A
delivered attempt looks like this:

`A840410000000001 valve open attempt 1/3 (open, queue item <id>): received | edge: queue item <id> ACCEPTED at 2025-04-13T16:49:14.498Z, FPort 2 payload 4101; queued: ChirpStack holds queue item <id> next before the receive window: FPort 2 payload 4101 is_pending 0 is_encrypted 0; model: WM1302 model delivered=1; downlink: open command FPort 2 payload 4101 FCnt 1 received after 1.00 s; frame: Concentratord uplink_id 1902493660 (count_us 247517304) at 902300000 Hz, 125000 Hz, SF7, model stamp <stamp>; concentratord: ChirpStack downlink 3000953403, ack ["OK", "IGNORED"]: Concentratord took it at RX1 +1 s with 140.5 ms lead at enqueue; Scheduled packet for TX; queue after: ChirpStack queue after the attempt: empty`

A failed attempt says `missing <parts>` or `failed: <reason>` and gives
`MISSING (<reason>)` for each absent part. The Concentratord part names
ChirpStack's downlink ID and the gateway's ack, then each receive slot where
Concentratord took it and what it did: `Scheduled packet for TX`, refused at
enqueue (`too late`), or dropped (`too old`). The lead is `counter_us -
current_counter_us` of the `Enqueueing timestamped packet` line, wrap-safe.

The case row reports a pass on a later attempt with the count and the
reasons:

`Valve open and outcome     PASS    <time>  WM1302 model delivered=5, Concentratord frames received=5; passed on attempt 2/3 after 1 retry (attempt 1: open command late after 139.31 s (drained); ChirpStack downlink 3000953403, ack ["OK", "IGNORED"]: Concentratord took it at RX1 +1 s with 140.5 ms lead at enqueue; Scheduled packet for TX); 1 late open reported over before a re-issue`

After the case, pass or fail, the candidate directory holds two more files,
each written as its source is read:

- `valve-radio.log` has every Concentratord and MQTT forwarder line and every
  harness marker of the persistent logs, in order across a rotation. Node-RED
  lines and the device-profile import are left out. ChirpStack itself writes
  no syslog line in these images; the forwarder's `Received downlink command`
  and `Received ack` lines are its downlink record.
- `valve-queue.log` has the valve's expectations with their queue items and
  report evidence, and the ChirpStack queue rows, as they stand after the
  case.

A source that could not be read is marked `[incomplete]` in its file and noted
in `harness-events.log`. A capture that fails outside those reads, for example
on an unwritable receipt file, is named `capture failed: <error>`. After a pass
the case row ends with `evidence capture incomplete: <what>`; the verdict does
not change. The read of the edge's expectations before the open belongs to the
attempt: a failure there leaves the attempt's line and sends nothing.

The runner boots the factory image and reads its immutable
`/rom/etc/init.d/node-red` before selecting cases. The script's
`persistFlowHold` function identifies #714. The offline release tree must
agree with the image. An unreadable or unrecognized marker fails the full
gate with all cases required. These candidates must pass cuts on first
boot, a later boot and first Node-RED start during the 0.8.1 upgrade. The cut
guests use direct I/O. After a serial receipt gives the flows SHA-256 and
payload stamp, the runner cuts power and boots a clone with a shell as PID 1.
That shell mounts the persistent overlay and checks both values before the
original guest starts normally for the API and fixture checks.

The same candidates also require the upgrade boot-safety cases. Case A zeroes
deployed flows and checks that pristine recovery preserves migration 0073 and
its trigger definitions. Case B checks that a missing pristine copy warns
when live flows are valid and holds startup when they are zeroed. Case C cuts
the settings, init and bootstrap transfers separately and checks their bytes
and modes on a clone before checking the retained payload and fixture.
If the candidate lacks `persistFlowHold`, these eight cases appear as N/A
with that reason. A release candidate must then declare the minimal atomic
flows publication described below.
Use `--flows-power-cut-only` for the three #714 commit cuts or
`--upgrade-boot-safety-only` for A, B and C. The latter uses the offline
release and 0.8.1 fixture and can omit the candidate archive and its checksum.
Focused runs report a separate diagnostic verdict. Flags and environment
variables cannot grant N/A to any case.

### Minimal atomic flows candidates

The v0.8.3 release line can use the atomic writer without the #714 recovery
code. The factory image must declare the minimal atomic publication in its
ROM init. A minimal candidate requires the ten baseline cases and three
additional cuts. The factory cases interrupt the writer before and after
directory fsync. The upgrade case interrupts the first Node-RED start after
an offline upgrade from 0.8.1. A shell-only clone must contain the complete
old or new flows at the expected path. Normal startup of the original must
serve the patched flows and return HTTP 401 from `/api/me`.

Pass the candidate archive and the SHA-256 from its build receipt. Add
`--openwrt-host-tools "$OPENWRT_HOST_TOOLS"`, pointing to the OpenWrt
`staging_dir/host` from the build. The runner copies and verifies the
candidate and fixture archives in private scratch before extraction.
It derives the probe from the verified candidate copy, retaining the boot
partition and replacing only the Node-RED init file in the SquashFS tree.
The original and derived image digests appear in the run receipts.

The candidate's ROM init must match the offline source. The derived image
must preserve the ROM writer and seed flows and carry the instrumented init.
The cut marker records the starting flows and the running init and writer
digests. The runner checks them before accepting clone evidence. It also
derives the instrumented offline bundle from the deployment tree in scratch.

### Customer-line 0.7.0 image fixture (PROVISIONAL)

This fixture is off by default. Count it as release evidence only after a
successful owner-only qualification receipt exists for the exact factory
archive and 0.8.1 overlay. The qualification scope records that the factory
ROM GUI differs from the recorded field installation.

Set `OSI_RASPI5_CUSTOMER_IMAGE` to the private local factory archive and
`OSI_RASPI5_CUSTOMER_FIXTURE_DIR` to the matching input directory. Supply both for
customer-line upgrade qualification. With both unset the summary reports the
case as provisional and off. Use `--customer-fixture-only` for a focused run
when the workstation slot is free. Keep the inputs and artifacts outside Git
trees.

Provide `customer.tar.gz` (the private 0.8.1 offline deploy bundle) and its
`customer.tar.gz.sha256` sidecar,
`customer-install.sh` (its matching offline installer), `customer-cache.tar`
(the integrity-checked guest npm cache with `content-v2/` at archive root),
and the synthetic `populate.sql`, `snapshot.sql` and `chirpstack-fixture.cjs`
from the fixture preparation. The synthetic history must fall within the
candidate's retention window. In `fixture-provenance.json`, set
`rom_gui_sha256` to the digest of the factory ROM GUI index from image
inspection. Copy `factory_image_sha256`, `legacy_bundle_sha256` and
`legacy_revision` from the preparation receipts for the image and the 0.8.1
overlay. Include the provenance file, the factory archive's basename and each
input filename in the private `SHA256SUMS`.

The case boots the factory image, installs the 0.8.1 overlay offline, seeds the
guest, then installs the candidate offline. It compares the SQL and ChirpStack
receipts, checks the 76-to-80 ledger remap and backup, and verifies the
active payload after reboot. The runner verifies that the guest boots the
pinned ROM and the 0.8.1 ledger agrees with the overlay's migration manifest.
A pass writes the owner-only `customer-line/qualification.json` with that
scope, the artifact digests, candidate revision and versions.
Each installer leg writes an exit code and timestamped progress receipts to
`customer-line/progress.jsonl`. A newer phase, ledger version or reference
build count extends its 15-minute idle deadline, up to 90 minutes per installer
leg. The focused run can take longer than the stock suite.
This case exercises the overlay upgrade. Run a separate firmware or radio package
migration qualification when that release path ships.
