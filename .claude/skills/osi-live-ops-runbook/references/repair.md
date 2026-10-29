# Live repair

Part of the osi-live-ops-runbook skill; read SKILL.md first.

## Pre-repair backup script

```sh
# Run on the Pi (ash-compatible)
TS=$(date +%Y%m%d-%H%M%S)
LABEL="pre-repair"          # e.g. "pre-eui-fix", "pre-fingerprint-restamp"
BK="/data/db/backups/${LABEL}-${TS}"
mkdir -p "$BK"
# Raw copy, ONLY with the writer stopped: a raw copy of farming.db and its
# sidecars taken while Node-RED writes is not a consistent backup.
raw_copy_stopped() {
  /etc/init.d/node-red stop
  trap '/etc/init.d/node-red start' EXIT  # remove if the repair needs it stopped
  i=0; while pgrep -f '[n]ode-red' >/dev/null 2>&1 && [ "$i" -lt 30 ]; do sleep 1; i=$((i + 1)); done
  pgrep -f '[n]ode-red' >/dev/null 2>&1 && { echo "FATAL: Node-RED still running - no raw copy"; exit 1; }
  cp -a /data/db/farming.db "$BK/farming.db" \
    || { echo "FATAL: primary DB backup failed - do NOT proceed with the repair"; exit 1; }
  for f in farming.db-wal farming.db-shm farming.db-journal; do
    [ -e "/data/db/$f" ] && cp -a "/data/db/$f" "$BK/$f"
  done
}
if command -v sqlite3 >/dev/null 2>&1; then
  # ONLINE backup via sqlite3 .backup (WAL-consistent while Node-RED writes). The
  # output is one self-contained file: do not copy the live -wal/-shm next to it.
  sqlite3 -cmd ".timeout 5000" /data/db/farming.db ".backup '$BK/farming.db'" || raw_copy_stopped
  # Same check as scripts/pi/backup-pre-deploy.sh: the copy must pass integrity_check.
  INTEG=$(sqlite3 "$BK/farming.db" "PRAGMA integrity_check" 2>&1) || true
  [ "$INTEG" = "ok" ] || { echo "FATAL: backup integrity_check failed: $INTEG - do NOT proceed"; exit 1; }
else
  raw_copy_stopped
  echo "WARN: no sqlite3 - integrity unchecked"
fi
# flows.json is a SYMLINK into /srv/node-red/payloads/<stamp>; -L copies the
# active payload's contents, not a dangling link.
cp -aL /srv/node-red/flows.json "$BK/flows.json"
cp -a /srv/node-red/settings.js "$BK/settings.js"
cp -a /srv/node-red/flows_cred.json "$BK/flows_cred.json" 2>/dev/null || true  # MQTT credentials
# ChirpStack state — REQUIRED before any direct chirpstack.sqlite edit
[ -e /srv/chirpstack/chirpstack.sqlite ] && cp -a /srv/chirpstack/chirpstack.sqlite "$BK/chirpstack.sqlite"
mkdir -p "$BK/gui"
cp -a /usr/lib/node-red/gui/. "$BK/gui/" 2>/dev/null || true
echo "Backup at $BK"
ls -la "$BK"
```

## Stale-fingerprint recovery

`scripts/restamp-fingerprints.js` re-baselines `schema_object_fingerprints` to
whatever the live schema currently is:

```bash
node scripts/restamp-fingerprints.js /data/db/farming.db
```

**Only run this when both are true:**
- `applyPending`/`verifyHead` (the migration runner's own checks) report fingerprint
  drift specifically because of a crash between a migration's commit and its
  fingerprint stamp — not because the schema is actually wrong.
- You (or the operator) have independently confirmed the live schema is correct for
  the intended migration state.

The script refuses to run against a nonexistent path (it deliberately does not let
`sqlite3` silently create-and-restamp an empty DB at a typo'd path). It has no other
guard: it does not verify the schema is correct itself, it only re-stamps whatever
is there. That judgment call is the operator's, not the script's.

This is the **only** sanctioned way to overwrite the fingerprint baseline. Never
hand-edit rows in `schema_object_fingerprints` directly. After running it, run
`verifyHead` again and confirm `ok:true` before considering the drift resolved. The
migration model this fingerprint mechanism belongs to (what a "commit" vs "stamp"
step is, what drift means structurally) is `osi-schema-change-control`'s territory.

---

## Foreign-numbered ledger recovery

`AGENTS.md` ("Live-deploy safety rules") keeps the rule lines; this section holds
the long form that moved out of it on 2026-10-22 and carries the same authority.

A gateway that ran one of the two customer lines (one valve-focused, one not) has
`schema_migrations` rows numbered under that branch's own scheme, which can collide
with main's numbering (e.g. v22 is `journal_catalog_v2` on the non-valve customer
line, `valve_control` on main) — `applyPending` correctly refuses on the checksum
mismatch (`repair_required`), and `deploy.sh` aborts before the payload flip, but
the device is then wedged with no forward path.

`node scripts/reconcile-ledger-numbering.js <db> --report` (dry run; add `--apply`
plus `--backup-dir` to act) is the ONLY sanctioned recovery: it proves, row by row,
that a foreign-numbered ledger entry's content is exactly what some main migration
already delivers — either byte-identical, or identical after stripping the leading
`-- NNNN:` header comment and structurally proving equal schema effect via
`scripts/semantic-schema-compare.js` — before rewriting that row's
`version`/`name`/`checksum` to match main. It refuses on any unproven, unknown, or
ambiguous row and touches nothing when it refuses.

`deploy.sh`'s `run_schema_migration()` calls it automatically (between the ledger
inspection and `migrate-cli.js`) whenever any applied ledger row above version 21
has a checksum that disagrees with main's `CHECKSUMS.json`; a main-numbered
gateway's checksums already agree there and never triggers it.

`--clear-repair-required` is the narrower, separate recovery for a row already
stuck `repair_required` whose checksum, at its own current version, already matches
main (e.g. a prior reconcile run committed the remap but crashed before the status
flip) — it never clears a row whose checksum still disagrees. Never hand-edit
`schema_migrations` outside these two sanctioned tools.

### Rehearsing that cutover on a copy

`node scripts/rehearse-ledger-cutover.js --db <pulled copy> --work <scratch directory>`
runs, on a copy only, the same chain deploy.sh runs for such a gateway (reconcile
`--report`, `--apply`, `migrate-cli.js`, `verify-head-cli.js`), then the
devices-rebuild rehearsal twice, the shipped boot node with the gateway's EUI,
`integrity_check`/`foreign_key_check`, a schema comparison against `seed-blank.sql`,
and per-table row counts and content hashes before and after; a second pass on the
result must change nothing. Row changes the migrations make by design are listed in
its `EXPECTED_CHANGES`; any other change fails. It refuses paths under `/data/db`
and a non-empty `--work` it did not create, and writes
`<work>/rehearsal-report.json` with every step's result and duration.

---

## Live-repair recipes

### Stale `.chirpstack.env` overriding runtime identity

`/srv/node-red/.chirpstack.env` can carry a stale `DEVICE_EUI*` value that overrides
the runtime identity even after UCI has been corrected. During an identity repair,
remove or regenerate this file so the helper/UCI path (canonical, uppercase EUI)
is what actually takes effect. **Save a copy first**: the same file carries the
`CHIRPSTACK_APP_*`/`CHIRPSTACK_PROFILE_*` values, and `CHIRPSTACK_PROFILE_LORAIN`
reaches the Node-RED runtime ONLY through this file (`node-red.init` does not
export it from UCI) — a regenerated env missing it silently breaks LoRain ingest
until the ChirpStack bootstrap rewrites the file. Full flag semantics and where
this file's other variables come from: `osi-config-and-flags`.

### Credential env-file refusal: exit 74 with `UNSAFE_ENTRY`

`chirpstack-bootstrap.js` exits `74` and prints `Credential env-file operation
failed {...}` on stderr when it refuses a credential file; `deploy.sh` stops with
the same status. On first boot `osi-bootstrap` logs only `bootstrap failed, will
retry next boot` (`logread -e osi-bootstrap`). The JSON diagnostic went to the
init script's stderr and is not in `logread`, and every later boot fails the
same way.

One cause has a known repair. The writer creates a missing file by `link()`ing
a flushed staging copy into place and then `unlink()`ing the staging name. A
crash or power cut between the two leaves the published file complete but with
a second link in its staging directory:
`/srv/node-red/..chirpstack.env.tmp-XXXXXX/env` (first-boot provisioning of
`.chirpstack.env`) or `/srv/node-red/..chirpstack.env.pre-gen2.tmp-XXXXXX/env`
(the deploy's first Gen2 recovery backup). The writer refuses any credential
file with more than one link, so the refusal repeats until the leftover is gone.

1. Reproduce the diagnostic with the file-only check. It reads and narrows
   the two env files and makes no ChirpStack call. Pick a writer that supports
   the flag: an older image's ROM copy ignores unknown flags and runs a full
   provisioning pass.
   ```sh
   S=
   for f in /usr/share/node-red/chirpstack-bootstrap.js /srv/node-red/chirpstack-bootstrap.js; do
     if [ -z "$S" ] && [ -f "$f" ] && grep -q -- '--secure-env-file' "$f"; then S="$f"; fi
   done
   echo "writer: ${S:-none}"
   [ -n "$S" ] && node "$S" --secure-env-file; echo "exit=$?"
   ```
   No writer means the `74` came from somewhere else; stop. This recipe
   applies when the diagnostic reads `"reason":"UNSAFE_ENTRY"`; current
   writers add `"linkCount":2,"stagingLeftover":true` for this case. Other
   reasons have other causes: `ROOT_REQUIRED` (not run as root),
   `SNAPSHOT_CHANGED` (a concurrent writer), `OS_ERROR` with an `osCode` such
   as `ENOSPC` or `EROFS` (fix the filesystem, then rerun).
2. Inspect both credential entries and every staging directory. In `ls -li`
   output the first column is the inode number and the third the link count.
   ```sh
   ls -lid /srv/node-red/.chirpstack.env /srv/node-red/.chirpstack.env.pre-gen2
   ls -lid /srv/node-red/..chirpstack.env*.tmp-*
   ls -lia /srv/node-red/..chirpstack.env*.tmp-*/
   ```
3. Delete nothing unless all of these hold for the entry with two links:
   it is a regular file (`-rw-------`, owner root); its link count is exactly
   2; exactly one staging directory exists for that entry
   (`..chirpstack.env.tmp-*` for `.chirpstack.env`,
   `..chirpstack.env.pre-gen2.tmp-*` for `.chirpstack.env.pre-gen2`); and that
   directory holds only `env`, with the same inode number as the entry. A
   symlink, a directory, a link count above 2, or a second link outside a
   staging directory is not an interrupted publication: leave the gateway
   refusing and escalate. When the checks hold, remove the staging link and
   its directory, never a globbed `rm -rf`:
   ```sh
   D=/srv/node-red/..chirpstack.env.tmp-XXXXXX   # the directory found in step 2
   rm "$D/env" && rmdir "$D"
   ls -li /srv/node-red/.chirpstack.env          # link count back to 1
   node "$S" --secure-env-file; echo "exit=$?"   # exit=0
   ```
   The published file and its bytes stay in place; only the second name goes.
4. Rerun the step that failed. After a deploy, rerun `deploy.sh`. After a
   first-boot failure, `.chirpstack.env` already holds the API key the failed
   run created; pass it in so the rerun does not create a second key (#181):
   ```sh
   rm -f /etc/osi-bootstrap.done && CHIRPSTACK_API_KEY="$(sed -n 's/^CHIRPSTACK_API_KEY=//p' /srv/node-red/.chirpstack.env | head -1)" /etc/init.d/osi-bootstrap start
   ```

A staging directory that is empty, or whose `env` has link count 1, comes from
an interruption before publication or after a rename. It does not block later
runs, and the writer leaves its contents root-owned mode `0600` inside a mode
`0700` directory. An unpublished `env` from a first-boot run can hold the only
copy of the key that run created, so keep it until the gateway provisions
cleanly, then remove it the same way.

### Changing DEVICE_EUI breaks linked login

The offline verifier is `bcrypt(password::DEVICE_EUI)` (see `AGENTS.md` "Security").
If the EUI changes (fixing a wrong one, replacing hardware), every stored verifier
for that gateway stops matching and logins fail. Repair sequence:

1. Fix the UCI value:
   ```bash
   uci set osi-server.cloud.device_eui='<CORRECT_EUI_UPPERCASE>'
   uci commit osi-server
   ```
2. Regenerate the verifier on the Pi with `bcryptjs` (placeholders `<password>` /
   `<eui>` — uppercase EUI, same delimiter):
   ```bash
   node -e "const b=require('/srv/node-red/node_modules/bcryptjs'); console.log(b.hashSync('<password>::<eui>', 10))"
   ```
3. Write the new hash into the DB:
   ```bash
   sqlite3 /data/db/farming.db "UPDATE users SET server_offline_verifier = '<hash>' WHERE username = '<username>';"
   ```
4. Restart Node-RED, then have the operator unlink and re-link the cloud account so
   a fresh sync token issues for the corrected EUI.

Also check `irrigation_zones` rows created before the fix — a sync trigger applies a
`COALESCE(gateway_device_eui, <fallback>)` only on `INSERT`, so already-existing zone
rows keep whatever EUI they were created with and need an explicit `UPDATE`.

### ChirpStack v4 has no plain REST API

ChirpStack v4.x is gRPC-web only; `curl http://127.0.0.1:8080/api/...` 404s
regardless of payload. To inspect or change ChirpStack config on a live Pi:

- **Read:** `sqlite3 /srv/chirpstack/chirpstack.sqlite "SELECT ...;"`
- **Write:** stop ChirpStack first (the DB is locked while it runs), modify via
  `sqlite3`, then start it again:
  ```bash
  /etc/init.d/chirpstack stop
  sqlite3 /srv/chirpstack/chirpstack.sqlite "UPDATE ... ;"
  /etc/init.d/chirpstack start
  ```

### Flows fail to load / all routes 404

`functionExternalModules: true` is set in `settings.js` (confirmed at
`feeds/chirpstack-openwrt-feed/apps/node-red/files/settings.js`). If a function
node's `libs` array references a helper module (e.g. `osi-db-helper`) not declared
in `/srv/node-red/package.json`, Node-RED tries to `npm install` it, fails (not a
published package), and refuses to load **all** flows — every route returns 404
with nothing obviously wrong in standard logs. Fix: ensure `package.json` declares
it as a `file:` dependency, e.g.:
```json
"osi-db-helper": "file:osi-db-helper"
```
`deploy.sh` deploys this file itself, so this mostly bites hand-edited or
partially-deployed Pis. To see the real error, run Node-RED in the foreground:
```bash
node-red --userDir /srv/node-red
```
Triage tables for narrowing down *which* symptom you're looking at belong to
`osi-debugging-playbook`; this recipe is specifically the "declared helper module
missing from package.json" root cause.

### Live valve testing (STREGA)

STREGA valves accept `OPEN_FOR_DURATION` only in normal operation; the valve closes
itself when the commanded duration elapses. There is no safe bare `CLOSE` in this
model — the reconciliation monitor (`strega-reconciliation-monitor` in `flows.json`)
explicitly does not emit a CLOSE downlink on timer elapse, "STREGA self-closes" per
its own comment.

- Never send a bare `CLOSE` command during testing or debugging.
- Use short durations (60 s) when reproducing a valve-open bug; let it auto-close.
- Operator-driven cancellation of an in-progress duration is a real, separate path:
  ```bash
  curl -X POST http://127.0.0.1:1880/api/v1/valves/<deveui>/cancel
  ```
  (confirmed route: `POST /api/v1/valves/:deveui/cancel`, node
  `cancel-valve-http-in` in `flows.json`, tab `device-api-tab`). Reserve this for
  genuine operator cancel intent, not as test cleanup.

---
