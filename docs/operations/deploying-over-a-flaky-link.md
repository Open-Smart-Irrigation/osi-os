# Deploying over a flaky link

Follow the mandatory [migration source and SSH prerequisites](migration-manifest-trust.md#required-deployment-prerequisites) before either tunnel or offline delivery.

`deploy.sh` normally fetches every file it needs via `curl $BASE/<path>`,
where `$BASE` is an SSH reverse tunnel (`ssh -R 9876:localhost:9876 ...`)
back to a `python3 -m http.server` on your workstation (see
[README.md](../../README.md#step-2--deploy-osi-os-components)). That tunnel
and the `curl … | sh` pipeline share one SSH session. The Uganda gateway
rides Tailscale over an intermittent rural link; if the session drops, both
die at once, potentially mid schema-migration.

The tools below remove that dependency. Build one self-contained tarball on
your workstation, push it to the gateway once, then run the deploy from a
process that survives the SSH session ending. Use this path for any gateway
on an unreliable link; the tunnel flow in the README is still the right
choice on a stable LAN.

## How it fits together

| Script | Runs on | Job |
|---|---|---|
| `scripts/deploy-bundle.sh` | workstation | Packs every file `deploy.sh` can fetch, plus `deploy.sh` and `deploy-local-server.js` themselves, into `dist/deploy-bundle-<sha>.tar.gz` + a `.sha256` sidecar. |
| `scripts/deploy-push-bundle.sh` | workstation | Streams that tarball to the gateway over one `ssh … 'cat > /tmp/...'` pipe (resumable), then launches `deploy-offline.sh` there. |
| `scripts/deploy-local-server.js` | gateway | Serves an immutable verified byte snapshot on `127.0.0.1`; a trusted copy travels beside the launcher. |
| `scripts/deploy-offline.sh` | gateway | Starts a detached Node supervisor that verifies inputs, owns the server and deploy child, and records the final outcome. |

`deploy.sh` still does `curl -fsSLo dest "$BASE/$src"`
against `$BASE`. The only difference is that `$BASE` now points at a Node
server on the gateway's own loopback interface instead of a tunnel back to
your workstation, so the fetch loop is immune to the exact link that keeps
dropping.

### Repeatability and file verification

For the same source tree, source SHA label, GUI archive bytes and
`SOURCE_DATE_EPOCH`, the builder produces the same bundle bytes. It sorts archive
entries, sets owners to 0, normalizes file and directory modes, fixes mtimes to epoch zero and uses `gzip -n`. Set
`SOURCE_DATE_EPOCH` to select another fixed mtime. `BUNDLE_TS` is an optional
legacy filename suffix; it never enters the archive. The manifest records the
source SHA label and a SHA-256 digest for every regular file except itself.
It contains no build-machine paths or build times.

The prebuilt GUI archive is an input: rebuilding it with different timestamps
changes the input bytes and therefore the bundle. To package an existing GUI
build reproducibly with GNU tar:

```bash
bash scripts/package-deploy-gui.sh web/react-gui/build react_gui.tar.gz
```

The helper stages a copy, sets files to 0644 and directories to 0755, and resets
the locale and tar/gzip environment overrides before packaging. Source executable
bits and the caller's umask do not change the GUI archive.

The trusted launcher checks the archive checksum, manifest hashes and complete
file inventory from one buffered read. It validates the nested GUI tarball too:
links, special files and unsafe paths in either archive refuse the deploy before
extraction or service changes. It never executes the bundled verifier to verify
that verifier. The server retains its own hash-checked buffers for all requests;
changing an extracted file cannot change the bytes served. A missing, changed or
extra file refuses the deploy. Older bundles without the manifest must be rebuilt. These checks detect
incomplete or changed content relative to the supplied sidecar; source selection
and SSH authentication remain the operator's responsibility.

### Which paths get bundled

`scripts/deploy-fetch-list.js` derives the file list by parsing `deploy.sh`'s
own `fetch()`/`fetch_required()` call sites — including the ones computed in
loops (the migration corpus from `database/migrations/ordered/CHECKSUMS.json`,
the foreign-numbered ledger-reconciliation lineage fixtures, the seed DB for
all three Pi hardware profiles) — rather than hand-maintaining a list that
can silently drift out of sync with `deploy.sh`. `scripts/deploy-fetch-list.test.js`
and `scripts/deploy-bundle.test.sh` both assert the derived list, and the
tarball built from it, stay exhaustive; if a future `deploy.sh` edit adds a
fetch shape the parser doesn't recognize, `deploy-fetch-list.js` raises
instead of quietly omitting the file from the bundle.

## Running it

```bash
# 1. Build and package the React GUI (same as the tunnel flow — not built by
#    deploy-bundle.sh itself; frontend builds OOM this workstation)
cd web/react-gui && npm ci && npm run build && cd ../..
bash scripts/package-deploy-gui.sh web/react-gui/build react_gui.tar.gz

# 2. Build the bundle
scripts/deploy-bundle.sh react_gui.tar.gz
# -> dist/deploy-bundle-<sha>.tar.gz (+ .sha256)

# 3. Push it and launch the deploy
scripts/deploy-push-bundle.sh root@<pi-ip> dist/deploy-bundle-<sha>.tar.gz --wait
```

`deploy-push-bundle.sh` forwards everything after the bundle path to
`deploy-offline.sh` on the gateway. Drop `--wait` to hand the deploy off and
return immediately — the log path and a `tail -f` hint print before the
command exits (exit 0 means launch accepted):

```bash
scripts/deploy-push-bundle.sh root@<pi-ip> dist/deploy-bundle-<sha>.tar.gz
# ...
#   Log:  /data/deploy-20260911T120000Z-1234.log
#   Read result: sh '/tmp/osi-deploy-run.<id>/deploy-offline.sh' --result '/data/deploy-20260911T120000Z-1234.result'
#   Launch accepted; the result is pending until state=complete.
```

If the SSH session then drops (during the upload, during `--wait`, or any
time after hand-off), the deploy itself is unaffected:

- **Upload drops mid-transfer**: re-run `deploy-push-bundle.sh`. It checks
  the remote file's size and, once the upload finishes, its sha256; a
  partial remote file is resumed from the last byte (`tail -c +N`), not
  restarted from zero. A remote file whose sha256 doesn't match on
  completion is deleted and re-uploaded. Archive staging is keyed by SHA-256,
  so different GUI builds with one source label cannot replace each other.
  Each invocation uploads its trusted launcher set into a new mode-0700
  directory and passes the workstation digest directly to that launcher.
- **Session drops after hand-off**: the supervisor runs in its own session,
  without a controlling terminal. Launcher HUP or TERM leaves it running.
  HUP or TERM sent directly to the supervisor is forwarded to the deploy
  process group; the supervisor waits for the deploy's recovery handler and
  records its actual exit status. Reconnect and read the result and deploy log.

### Manually, without `deploy-push-bundle.sh`

For manual delivery, create a fresh private directory and bind the invocation
to the workstation digest. This example does not resume transfers:

```bash
bundle=dist/deploy-bundle-<sha>.tar.gz
expected=$(sha256sum "$bundle" | cut -d ' ' -f1)
run_dir=$(ssh root@<pi-ip> 'umask 077; mktemp -d /tmp/osi-deploy-run.XXXXXX')
ssh root@<pi-ip> "umask 077; cat > '$run_dir/bundle.tar.gz'" < "$bundle"
for file in deploy-offline.sh deploy-offline-runtime.js deploy-archive.js deploy-local-server.js; do
  ssh root@<pi-ip> "umask 077; cat > '$run_dir/$file'" < "scripts/$file"
done
ssh root@<pi-ip> "sh '$run_dir/deploy-offline.sh' '$run_dir/bundle.tar.gz' --expected-sha256 '$expected' --wait"
```

(The Pis have no `sftp-server`, which plain `scp` needs, so it will fail.
`deploy-push-bundle.sh` uses an `ssh … 'cat > file'` pipe instead of `scp`
for exactly this reason.)

## What `deploy-offline.sh` actually does

1. Starts the detached supervisor before any deploy can start. It creates a
   persistent pending receipt and preallocates a recovery receipt under `/data`.
2. Checks the bundle checksum and both archive trees, verifies all manifest
   entries, then extracts to a new `/tmp/deploy-bundle-<run>` directory.
   An existing run is refused rather than overwritten.
3. Binds its own server to loopback and probes it with a unique instance token.
   An occupied port refuses the deploy; another listener cannot satisfy readiness.
   Offline curl fetches use that exact IPv4 literal, with proxies and user curl
   configuration disabled. Native tunnel delivery retains its localhost endpoint.
   Access-log write failures warn without stopping the server or supervisor.
4. Runs the verified `deploy.sh` bytes from memory, serving verified buffers for
   every fetch. The child receives its own process group for signal forwarding.
5. Waits for the child's real exit, reconciles its private lifecycle report,
   stops the server and durably writes `/data/deploy-<run>.result`.
6. `--wait` observes supervisor exit and returns the final status. A missing
   scratch completion marker cannot strand it. A dead supervisor returns 125;
   a receipt persistence failure returns 74, never success.

### Reading the final outcome

Both push and direct offline delivery print the command for that run:

```sh
sh /tmp/osi-deploy-run.<id>/deploy-offline.sh --result /data/deploy-<run>.result
```

Use the trusted reader command printed for the run. It checks the publication
guard and syncs the result directory before acknowledging a committed receipt.
The waiter uses the same reader. `state=pending` or `state=running` returns 125.
An uncommitted complete candidate returns the reserved recovery receipt and 74;
it cannot acknowledge success, even if both publication and fallback fail.

The raw `.result` file is diagnostic data: `cat` can expose a candidate between
rename and directory fsync. A raw `state=complete` alone is not an acknowledgement.
Never source a receipt or manually remove `.publishing`. If a reboot clears the
launcher directory, copy the matching trusted launcher set into a new private
directory before reading the persistent receipt.

| Final verdict | Meaning | `--wait` status |
|---|---|---|
| `success` | Activation, local health check and identity supervisor readiness completed. | 0 |
| `auto-rollback` | Deploy failed; the compatible previous payload was restored and its readiness confirmed. | Nonzero deploy status |
| `incomplete-recovery` | Recovery could not be confirmed; `service_state` says stopped or unknown. | Nonzero deploy status, or 74 for receipt persistence failure |
| `interrupted` | A catchable signal interrupted the run; the reason distinguishes pre-start cancellation from an interrupted deploy. | 128 + signal number |
| `hold` | Required Node-RED and identityd stops were positively established. | Nonzero deploy status |
| `refused` | Verification or a deploy prerequisite refused the run. | Nonzero deploy status |
| `failed` | The deploy process failed without a confirmed rollback, including interruption after its lifecycle report. | Nonzero deploy status |
| `unverified` | The new payload runs, but its startup could not be confirmed, or no final lifecycle report was received. | 3 |

`payload_stamp` identifies the attempted payload; `active_payload_stamp` identifies
the final active link, which can differ after rollback. A refusal before
`deploy.sh` starts uses `unknown`. The result also records `reason_code`, a fixed
`reason`, `bundle_sha256` and `deploy_exit_code` (the raw script status). `service_state` refers to Node-RED;
`identityd_state` reports the identity supervisor. Each is running, stopped or
unknown. A failed required stop or restoration yields `incomplete-recovery`,
including identityd failure after Node-RED rollback readiness. The bundle runner returns 3 for an
unverified start even though the native deploy script retains its existing exit-0
behavior and leaves the running payload alone. A failed migration, activation or
health check cannot become a successful bundle verdict.

The deploy script writes a private outcome. After the process exits, the detached
supervisor reconciles that outcome with the actual exit status and publishes the
final result before its temporary completion marker. A late failure or SIGKILL
cannot leave an earlier success receipt visible. Server cleanup and result
writing continue after the SSH session ends.
An SSH transport error during `--wait` describes the connection; reconnect and
read the result file to learn the deploy outcome.

The deploy's lifecycle traps still handle migration recovery and `identityd`
restoration. Offline delivery feeds the verified script buffer to `sh`, as the
tunnel flow feeds the initial `curl` response to `sh`.

### The ordering rule this path (and every deploy path) must preserve

**Never restart Node-RED against a newly reconciled/migrated schema while it
is still running an older flows payload.** The 2026-09-12 Uganda incident
(issue #222 / F4) happened this way on the catch-up window: schema migrations
ran, then a trap restarted Node-RED before the new flows payload had actually
been flipped in (it was only staged — "flip deferred"). The old boot node's
unfenced `devices` rebuild then ran against the new schema and
cascade-deleted `device_data`.

`deploy.sh`'s `run_schema_migration()` now enforces the fix directly: on a
successful migration it flips the staged payload (`swap_call flipTo
"$DEPLOY_STAMP"`) *before* calling `restart_node_red()`, tracked by a
`PAYLOAD_FLIPPED` flag so the later "Flip payload + local health self-check"
block doesn't re-flip. This applies to every deploy over this offline path
exactly as it does to the tunnel flow — `deploy.sh` runs the same lifecycle
between the two, so the fix lands here for free. The historical Uganda catch-up window script
(`scripts/ops/uganda-catchup-window.sh`) enforced the same rule independently
with its optional `--expected-flows-sha` check, since that script restarts
Node-RED without ever flipping a payload itself. The neutral
[ledger catch-up guide](ledger-catchup-runbook.md) states the requirement
(confirm the active payload before any restart) but supplies no enforcement
mechanism of its own.

## Constraints and non-goals

- `deploy-bundle.sh` never builds the GUI itself (see AGENTS.md's build
  memory-pressure rule); it fails with a clear message if the
  `react_gui.tar.gz` path it's given doesn't exist.
- `deploy-offline.sh` is BusyBox ash-compatible (no bashisms — the Pis run
  BusyBox `ash`, not bash). `deploy-bundle.sh` and `deploy-push-bundle.sh`
  are bash on the workstation side.
- None of this changes `deploy.sh`'s database safety invariant: the bundled
  seed `farming.db` is still only ever written when `/data/db/farming.db` is
  absent.
- The tunnel flow in the README remains the default for a stable LAN; this
  path exists for links (Tailscale over rural cellular/satellite, congested
  wifi) where a dropped SSH session is a real, recurring risk rather than an
  edge case.

Receipts and private lifecycle reports are mode 0600, outside the served tree.
Reasons use allowlisted codes and fixed messages; raw errors, identifiers and
URLs stay in `/data/deploy-<run>.log`. Pending, running and final receipts use a
temporary file, file fsync, rename and directory fsync. Before deployment, the
supervisor persists a publication guard and preallocated `.result.recovery`
receipt. The guard is removed only after final publication syncs succeed.
Readers keep the recovery receipt authoritative while the guard remains, then
sync the acknowledgement directory themselves. A failed access log cannot take
down supervision; failed receipt acknowledgement returns 74.
