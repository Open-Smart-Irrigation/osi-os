# Raspberry Pi 5 candidate acceptance

Run this local step of Release Runtime Smoke for each candidate image before sending
the real-device test sheet to Phil. The stock cases take about 45 minutes in
one `osi-heavy` slot. Candidates with #714 need more time for the boot and
upgrade cases below.
The hosted smoke jobs use runtime fixtures. The emulator run needs the built
candidate, previous factory images and the workstation's offline deployment cache.

## Prepare the inputs

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
tools/raspi5/acceptance.sh \
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
restricted to the emulated link and a host-loopback GUI forward. The radio
exchanges simulated frames over a Unix socket.

Record the command's exit code, `inputs.txt` and `results.log` from the printed
run directory with the candidate SHA and image checksum. The selected cases
must exit zero. The runner removes guest disks and USB media after cleanup and
keeps the compact receipts. Use `--keep-scratch` for an owner-only copy of
the scratch media when diagnosing a failure. Keep private receipts local.
A missing or failed run holds the candidate. Physical SD power-cut, upgrade and
valve checks still belong on the real-device sheet.

## Additional cases

The default suite checks cold boot, GUI registration and login, WM1302 uplinks,
a STREGA valve open and its reported state, reboot persistence, three SQLite
power cuts and offline upgrades from 0.8.0 and 0.8.1.

The init script's `persistFlowHold` function identifies candidates with the
recovery code from PR #714. The cold boot checks that the guest image and the
offline tree agree on this capability. These candidates must pass cuts on first
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
Earlier candidates report each case as `not applicable to this candidate`.
Use `--flows-power-cut-only` for the three commit cuts or
`--upgrade-boot-safety-only` for A, B and C. The latter uses the offline
release and 0.8.1 fixture and can omit the candidate archive and its checksum.

### Customer-line 0.7.0 image fixture

Set `OSI_RASPI5_CUSTOMER_IMAGE` to the private local factory archive and
`OSI_RASPI5_CUSTOMER_FIXTURE_DIR` to the matching input directory. Supply both for
customer-line upgrade qualification. With both unset the runner records the
case as pending. Use `--customer-fixture-only` for a focused run with the same
input arguments. Keep the input directory and all artifacts outside Git trees.

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
A pass writes `customer-line/qualification.json` for the exact checked media,
candidate revision and versions. The known factory archive has a different
ROM GUI asset from the recorded field installation.
Each installer leg writes an exit code and timestamped progress receipts to
`customer-line/progress.jsonl`. A newer phase, ledger version or reference
build count extends its 15-minute idle deadline, up to 90 minutes per installer
leg. The focused run can take longer than the stock suite.
This case exercises the overlay upgrade. Run a separate firmware or radio package
migration qualification when that release path ships.
