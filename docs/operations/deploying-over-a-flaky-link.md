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
| `scripts/deploy-local-server.js` | gateway | Zero-dependency Node static file server bound to `127.0.0.1`; ships inside the bundle. |
| `scripts/deploy-offline.sh` | gateway | Extracts the bundle, brings up the local server under `setsid`, then runs `deploy.sh` under a second `setsid` session so it keeps running after your SSH connection ends. |

`deploy.sh` still does `curl -fsSLo dest "$BASE/$src"`
against `$BASE`. The only difference is that `$BASE` now points at a Node
server on the gateway's own loopback interface instead of a tunnel back to
your workstation, so the fetch loop is immune to the exact link that keeps
dropping.

### Repeatability and file verification

For the same source tree and GUI archive bytes, the builder produces the same
bundle bytes. It sorts archive entries, sets owners to 0, normalizes file and
directory modes, fixes mtimes to epoch zero and uses `gzip -n`. Set
`SOURCE_DATE_EPOCH` to select another fixed mtime. `BUNDLE_TS` is an optional
legacy filename suffix; it never enters the archive. The manifest records the
source SHA label and a SHA-256 digest for every regular file except itself.
It contains no build-machine paths or build times.

The prebuilt GUI archive is an input: rebuilding it with different timestamps
changes the input bytes and therefore the bundle. To package an existing GUI
build reproducibly with GNU tar:

```bash
tar --sort=name --format=gnu --mtime=@0 --owner=0 --group=0 --numeric-owner \
  -cf - -C web/react-gui/build . | gzip -n > react_gui.tar.gz
```

The gateway checks the archive checksum, rejects links, special files and unsafe
paths before extraction, then verifies the manifest against the entire extracted
file set before starting the server. A missing, changed or extra file refuses the
deploy. Older bundles without the manifest must be rebuilt. These checks detect
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
tar --sort=name --format=gnu --mtime=@0 --owner=0 --group=0 --numeric-owner \
  -cf - -C web/react-gui/build . | gzip -n > react_gui.tar.gz

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
#   Read result: cat '/data/deploy-20260911T120000Z-1234.result'
#   Launch accepted; the result is pending until state=complete.
```

If the SSH session then drops (during the upload, during `--wait`, or any
time after hand-off), the deploy itself is unaffected:

- **Upload drops mid-transfer**: re-run `deploy-push-bundle.sh`. It checks
  the remote file's size and, once the upload finishes, its sha256; a
  partial remote file is resumed from the last byte (`tail -c +N`), not
  restarted from zero. A remote file whose sha256 doesn't match on
  completion is deleted and re-uploaded.
- **Session drops after hand-off**: `deploy-offline.sh` already backgrounded
  `sh deploy.sh <port>` under `setsid`, in a session with no controlling
  terminal, so it is not a child of the SSH session and receives no
  `SIGHUP`. Reconnect and run `cat /data/deploy-<run>.result`, then read the named log.

### Manually, without `deploy-push-bundle.sh`

If you'd rather copy the tarball over yourself:

```bash
ssh root@<pi-ip> 'cat > /tmp/deploy-bundle.tar.gz' < dist/deploy-bundle-<sha>.tar.gz
ssh root@<pi-ip> 'cat > /tmp/deploy-bundle.tar.gz.sha256' < dist/deploy-bundle-<sha>.tar.gz.sha256
ssh root@<pi-ip> 'cat > /tmp/deploy-offline.sh' < scripts/deploy-offline.sh
ssh root@<pi-ip> 'sh /tmp/deploy-offline.sh /tmp/deploy-bundle.tar.gz --wait'
```

(The Pis have no `sftp-server`, which plain `scp` needs, so it will fail.
`deploy-push-bundle.sh` uses an `ssh … 'cat > file'` pipe instead of `scp`
for exactly this reason.)

## What `deploy-offline.sh` actually does

1. Verifies the bundle's sha256 against its `.sha256` sidecar.
2. Checks free space under `/tmp` before extracting (bundle size × 3 +
   4 MB margin, the same wrap-safe `df -k` idiom `deploy.sh` uses for its own
   migration disk gate).
3. Rejects unsafe archive entries, extracts to `/tmp/deploy-bundle-<run>` and
   verifies `bundle-manifest.json`. The default run identifier includes UTC time
   and the launcher PID; an existing run is refused rather than overwritten.
4. Starts `deploy-local-server.js` under `setsid`, polls
   `http://127.0.0.1:<port>/deploy.sh` until it answers (up to 30s).
5. Launches `sh deploy.sh <port> > /data/deploy-<run>.log 2>&1` inside a
   *second* `setsid` session that also owns stopping the local server once
   `deploy.sh` exits — success or failure, `--wait` or not. This is what
   makes "the local server always gets stopped" true even when nothing is
   left attached to watch it: the watcher is detached too.
6. Records the terminal verdict in `/data/deploy-<run>.result` with an atomic
   rename. `--wait` prints that result and returns its `exit_code`. Without
   `--wait`, the launcher prints the result path and returns immediately.

### Reading the final outcome

Both push and direct offline delivery print the command for that run:

```sh
cat /data/deploy-<run>.result
```

The result is plain text, never a shell script: read it with `cat`, do not source
it. `state=pending` or `state=running` with `verdict=pending` means no final
verdict exists. If a process is killed without running its exit handler, or the
gateway loses power, that pending record remains inconclusive. Check its log and
the payload state before retrying.

| Final verdict | Meaning | `--wait` status |
|---|---|---|
| `success` | Activation, local health check and identity supervisor readiness completed. | 0 |
| `auto-rollback` | Deploy failed; the compatible previous payload was restored and its readiness confirmed. | Nonzero deploy status |
| `hold` | The deploy left services deliberately stopped for operator recovery. | Nonzero deploy status |
| `refused` | Verification or a deploy prerequisite refused the run. | Nonzero deploy status |
| `failed` | Activation or migration failed without a confirmed rollback. | Nonzero deploy status |
| `unverified` | The new payload runs, but its startup could not be confirmed, or no final lifecycle report was received. | 3 |

`payload_stamp` identifies the attempted payload; `active_payload_stamp` identifies
the final active link, which can differ after rollback. A refusal before
`deploy.sh` starts uses `unknown`. The result also records `reason`, `bundle_sha256`, `log` and
`deploy_exit_code` (the raw script status). The bundle runner returns 3 for an
unverified start even though the native deploy script retains its existing exit-0
behavior and leaves the running payload alone. A failed migration, activation or
health check cannot become a successful bundle verdict.

The detached watcher publishes the final result before its temporary completion
marker. Its server cleanup and result writing continue after the SSH session ends.
An SSH transport error during `--wait` describes the connection; reconnect and
read the result file to learn the deploy outcome.

`deploy.sh`'s own `EXIT`/`INT`/`TERM` traps (Node-RED restart after a
migration failure, `identityd` state restoration) are untouched: the offline
path runs the identical `sh deploy.sh <port>` invocation the tunnel flow
runs, just reading `deploy.sh` from local disk instead of via the first
`curl … | sh` fetch.

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
