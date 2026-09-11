# Deploying over a flaky link

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
| `scripts/deploy-bundle.sh` | workstation | Packs every file `deploy.sh` can fetch, plus `deploy.sh` and `deploy-local-server.js` themselves, into `dist/deploy-bundle-<sha>-<ts>.tar.gz` + a `.sha256` sidecar. |
| `scripts/deploy-push-bundle.sh` | workstation | Streams that tarball to the gateway over one `ssh … 'cat > /tmp/...'` pipe (resumable), then launches `deploy-offline.sh` there. |
| `scripts/deploy-local-server.js` | gateway | Zero-dependency Node static file server bound to `127.0.0.1`; ships inside the bundle. |
| `scripts/deploy-offline.sh` | gateway | Extracts the bundle, brings up the local server under `setsid`, then runs `deploy.sh` under a second `setsid` session so it keeps running after your SSH connection ends. |

`deploy.sh` itself is unmodified: it still does `curl -fsSLo dest "$BASE/$src"`
against `$BASE`. The only difference is that `$BASE` now points at a Node
server on the gateway's own loopback interface instead of a tunnel back to
your workstation, so the fetch loop is immune to the exact link that keeps
dropping.

### Which paths get bundled

`scripts/deploy-fetch-list.js` derives the file list by parsing `deploy.sh`'s
own `fetch()`/`fetch_required()` call sites — including the ones computed in
loops (the migration corpus from `database/migrations/ordered/CHECKSUMS.json`,
the AgroLink/Bovey ledger-reconciliation lineage fixtures, the seed DB for
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
cd web/react-gui && npm install && npm run build && cd ../..
tar czf react_gui.tar.gz -C web/react-gui/build .

# 2. Build the bundle
scripts/deploy-bundle.sh react_gui.tar.gz
# -> dist/deploy-bundle-<sha>-<ts>.tar.gz (+ .sha256)

# 3. Push it and launch the deploy
scripts/deploy-push-bundle.sh root@<pi-ip> dist/deploy-bundle-<sha>-<ts>.tar.gz --wait
```

`deploy-push-bundle.sh` forwards everything after the bundle path to
`deploy-offline.sh` on the gateway. Drop `--wait` to hand the deploy off and
return immediately — the log path and a `tail -f` hint print before the
command exits:

```bash
scripts/deploy-push-bundle.sh root@<pi-ip> dist/deploy-bundle-<sha>-<ts>.tar.gz
# ...
#   Log:  /data/deploy-20260911T120000Z.log
#   Follow it with: tail -f /data/deploy-20260911T120000Z.log
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
  `SIGHUP`. Reconnect and run `tail -f /data/deploy-<ts>.log`.

### Manually, without `deploy-push-bundle.sh`

If you'd rather copy the tarball over yourself:

```bash
scp dist/deploy-bundle-<sha>-<ts>.tar.gz dist/deploy-bundle-<sha>-<ts>.tar.gz.sha256 root@<pi-ip>:/tmp/
scp scripts/deploy-offline.sh root@<pi-ip>:/tmp/
ssh root@<pi-ip> 'sh /tmp/deploy-offline.sh /tmp/deploy-bundle-<sha>-<ts>.tar.gz --wait'
```

(The Pis have no `sftp-server`, which plain `scp` needs, so it will fail.
`deploy-push-bundle.sh` uses an `ssh … 'cat > file'` pipe instead of `scp`
for exactly this reason.)

## What `deploy-offline.sh` actually does

1. Verifies the bundle's sha256 against its `.sha256` sidecar.
2. Checks free space under `/tmp` before extracting (bundle size × 3 +
   4 MB margin, the same wrap-safe `df -k` idiom `deploy.sh` uses for its own
   migration disk gate).
3. Extracts to `/tmp/deploy-bundle-<ts>`.
4. Starts `deploy-local-server.js` under `setsid`, polls
   `http://127.0.0.1:<port>/deploy.sh` until it answers (up to 30s).
5. Launches `sh deploy.sh <port> > /data/deploy-<ts>.log 2>&1` inside a
   *second* `setsid` session that also owns stopping the local server once
   `deploy.sh` exits — success or failure, `--wait` or not. This is what
   makes "the local server always gets stopped" true even when nothing is
   left attached to watch it: the watcher is detached too.
6. With `--wait`, follows the log and exits with `deploy.sh`'s own exit code.
   Without it, prints the log path and returns immediately.

`deploy.sh`'s own `EXIT`/`INT`/`TERM` traps (Node-RED restart after a
migration failure, `identityd` state restoration) are untouched: the offline
path runs the identical `sh deploy.sh <port>` invocation the tunnel flow
runs, just reading `deploy.sh` from local disk instead of via the first
`curl … | sh` fetch.

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
