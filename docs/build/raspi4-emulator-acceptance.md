# Raspberry Pi 4 candidate acceptance

Run the Pi 4 and Pi 5 emulator suites for each candidate before sending the
real-device sheet to Phil. Pi 4 currently ships the 32-bit **bcm2709** image.
Use the Pi 4 factory archive and SHA-256 from the candidate build receipt.
Hosted Release Runtime Smoke runs the host tests. The VM suites run locally
at the candidate stage. [Pi 5 runbook](raspi5-emulator-acceptance.md).

## Prepare inputs

Use `GATE_TREE` and `GATE_SHA` from the separate, pinned `main` checkout
in [Release workflow, Step 5](../versioning-workflow.md#step-5--build-the-factory-images).

Build the emulator through `osi-heavy` or use a matching pinned build. The
host also needs `qemu-system-x86_64` with user networking, mtools, dosfstools,
Python 3.11 or later, Node.js, Playwright and Chromium. Set `NODE_PATH` if
Playwright is installed outside the usual module search paths, and
`CHROMIUM_PATH` if using a browser outside the Playwright cache.
[Build instructions and source pins](../../tools/raspi4/README.md#build-on-linux).

Stage the candidate archive, checksum and offline deployment tree in the
external release input directory. The offline tree uses the candidate revision,
its `react_gui.tar.gz` and a `SERVED-FROM.txt` with the full commit SHA.
[Release workflow, Step 5](../versioning-workflow.md#step-5--build-the-factory-images).
Populate the host npm cache from the candidate runtime lockfile. The runner
verifies the cached package content before creating read-only guest media.

Supply one Pi 4 image archive with its `SHA256SUMS` in each of the
`v0.8.0/` and `v0.8.1/` fixture directories. Use factory or synthetic test
images. To make the synthetic pair, use the pinned Pi 4 0.8.2 archive and its
OpenWrt `staging_dir/host` tools. The generator checks the archive digest,
uses the older release Git revisions for the OSI payload, and records the
resulting archive and key payload hashes. It keeps the 0.8.2 kernel and
native packages. The OpenWrt host tools can stay in their build checkout.

```bash
osi-heavy wait --contain --need-gib 4 -- \
  env STAGING_DIR_HOST="$OPENWRT_HOST_TOOLS" "$OPENWRT_HOST_TOOLS/bin/fakeroot" -- \
  python3 -B "$GATE_TREE/tools/raspi4/fixtures.py" \
  --base "$PI4_082_FACTORY_IMAGE" --tools "$OPENWRT_HOST_TOOLS" \
  --output "$FIXTURE_ROOT"
```

Keep the image inputs, offline tree, fixture output and evidence root
outside all Git trees and `/tmp`. On the build workstation use a directory
under `$HOME/builds`.
Keep private inputs and evidence local. The guest network is restricted
and the browser forward binds to loopback.

## Run the gate

```bash
"$GATE_TREE/tools/raspi4/acceptance.sh" --tools-revision "$GATE_SHA" \
  --candidate "$PI4_FACTORY_IMAGE" --candidate-sha256 "$PI4_FACTORY_SHA256" \
  --osi-version "$OSI_VERSION" --chirpstack-version "$CHIRPSTACK_VERSION" \
  --release "$OFFLINE_RELEASE_TREE" --release-revision "$CANDIDATE_SHA" \
  --fixtures "$FIXTURE_ROOT" --run-root "$EVIDENCE_ROOT" --qemu "$PI4_QEMU"
```

The entry point takes its own contained slot. Set `OSI_HEAVY` if the
wrapper is outside `PATH`. Check `osi-heavy status` on a shared workstation.
Set `OSI_HEAVY_WAIT_SECONDS=0` to make a single admission attempt through
the FIFO queue. The suite is bounded by a four-hour deadline after admission.

Record the exit code, `inputs.txt`, `stopped.utc` and `results.log` from the
printed run directory with the candidate SHA, image checksum, and tools revision.
Review the final table for each required case and every
N/A reason and named replacement. A release pass requires 18 of 18 cases for a #714 image
or 13 of 13 for a minimal atomic-write image.
The runner removes writable guest media after teardown. Use
`--keep-scratch` to retain owner-only disks and diagnostics for debugging.

## What the gate covers

Ten baseline cases cover cold boot and board checks, GUI registration and
login, WM1302 uplinks, a timed STREGA open with a reported outcome, reboot
persistence, three interrupted SQLite transactions and offline upgrades from
0.8.0 and 0.8.1. Each SQLite cut checks the clone for committed rows, rollback
of the interrupted write and integrity before starting the original disk.

The runner reads `/rom/etc/init.d/node-red` inside the booted factory image
to select #714 recovery or the minimal atomic writer. The offline init must
agree. A missing or unrecognized marker fails the full gate. A #714
candidate requires the three flows cuts and all five upgrade boot-safety
cases. It reports the minimal cuts as N/A. A supported minimal candidate
reports each #714 case as N/A because `persistFlowHold` is absent. It must
pass both factory cuts and the first post-upgrade cut. The table names all
required replacements for every N/A row. For a minimal candidate, pass
`--openwrt-host-tools "$OPENWRT_HOST_TOOLS"` to derive the probe from the
verified Pi 4 archive in scratch.
[Shared cases and probe preparation](raspi5-emulator-acceptance.md#minimal-atomic-flows-candidates).

Use `--historical` for the ten baseline diagnostics on an image and offline
tree that precede both flows fixes. The historical verdict is diagnostic.
Flags and environment variables cannot grant N/A to any case.

The real-device sheet covers early EEPROM and VideoCore firmware, VL805
firmware, USB timing, real radio behavior, SD power loss and physical
valves. Include a real upgrade alongside the physical power-cut and valve
tests.
