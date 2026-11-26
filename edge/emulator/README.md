# Pi 5 arm64 backend comparison

Use a checksum-listed Pi 5 factory archive and an existing raspi5b QEMU build.
Keep the test inputs and evidence outside the Git worktree. The driver selects
the newest non-emulator-only candidate in the supplied directory by default.
Use `--candidate` to pin a specific checksum-listed archive.

Install the replay fixture dependencies and build the two arm64 executables.
Set `EVIDENCE`, `QEMU`, and `CANDIDATES` to absolute paths. The evidence
directory must already exist.

```sh
source /home/phil/builds/edge-rewrite-20261123/spike/env.sh
npm ci --prefix scripts/fixtures/release-smoke --no-audit --no-fund
(
    cd edge/go
    CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -trimpath -ldflags='-s -w' \
        -o "$EVIDENCE/osi-edge" ./cmd/osi-edge
    CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go test -trimpath -c -ldflags='-s -w' \
        -o "$EVIDENCE/store-arm64.test" ./internal/store
)
PYTHONDONTWRITEBYTECODE=1 osi-heavy wait --contain --need-gib 8 --label edge-emulator-g1 -- \
    python3 edge/emulator/compare.py --run-dir "$EVIDENCE" --binary "$EVIDENCE/osi-edge" \
        --engine-test "$EVIDENCE/store-arm64.test" --qemu "$QEMU" --candidates "$CANDIDATES"
```

The vector test binary is optional. The contained run needs the Mosquitto
image pinned by the cassette recorder in local Podman storage. QEMU slirp
uses loopback HTTP and MQTT forwards and a guest forward to the recorder.
Use `--dry-run` with a separate evidence directory to verify the inputs and
stage the boot media without starting a guest.

Each backend starts on a separate factory image copy. For an earlier schema
head, the driver runs the ordered migration runner and its verifier on the
image's database with Node-RED stopped. If the image shipped the schedule
trigger at migration 81, the ledger reconciliation tool verifies and moves
that entry to 84 before the upgrade. A refused migration ends that
comparison. Both backends receive the first 500 messages from the KIWI
scenario with QoS 1. The driver records broker acknowledgements, new rows,
RSS before load and the process high-water mark through load.

The power test kills QEMU while the publisher is running and a timed open
is pending in ChirpStack's queue. The driver compares queue item IDs before
and after reboot and redelivers the same MQTT inputs to check keyed rows.
The MQTT 5 recorder holds a telemetry PUBACK, restarts the broker, and
checks the reconnect and acknowledged retry.

Read `results.jsonl` for measurements and failures. Each guest directory
contains its serial and QEMU logs. The SQLite vector comparison writes the
guest JSON and an SQL-by-SQL diff in the evidence directory.
