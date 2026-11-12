# Upgrade a gateway without erasing the farm

Use `deploy.sh` to upgrade an existing gateway. An image is for a new device or a deliberate factory reset. OSI images through v0.8.2 do not provide a safe preserving image upgrade: the old keep list omits `/data`, the archive goes through RAM and a 64 MiB boot partition, and copying live SQLite files can lose committed writes despite passing integrity checks.

## Source-side refusal

Application deploy installs the image guard beside the Node-RED init script. This installation belongs to the image-safety PR, not the payload-switch PR. Both tunnel and offline deploy use the same `deploy.sh` and fetch manifest. The guard refuses when a farm database contains an account, ChirpStack state exists, SQLite sidecars are orphaned, or the farm database cannot be proved readable. Empty devices are allowed. `sysupgrade -n` and `--force` do not bypass it.

| Entry point | Refusal before destructive work |
|---|---|
| CLI `/sbin/sysupgrade`, including `-b` archive creation | Wrapper checks state before entering the stock script |
| LuCI firmware flash, forced flash and backup download | LuCI executes `/sbin/sysupgrade`; the same wrapper applies |
| CGI backup download (`cgi-backup`) | CGI invokes `/sbin/sysupgrade --create-backup -`; refused before collection |
| rpcd `rpc-sys upgrade_start`, with or without keep | rpcd executes `/sbin/sysupgrade`; the same wrapper applies |
| rpcd file execution of the LuCI flash command | Same absolute script path |
| Direct procd `ubus call system sysupgrade`, including force and supplied backup | Procd calls the guarded `/usr/libexec/validate_firmware_image` before stopping services; validator failure aborts even with force |

Read-only `--help` and `--list-backup` remain available. The CLI and LuCI file-exec path receive the refusal paragraph. Legacy rpcd upgrade-start acknowledges its fork before the child exits, and CGI backup closes stderr; those clients can show a generic failure or acknowledgement rather than that paragraph. The guard still prevents their archive/flash work and writes the reason to syslog. The preserved stock scripts have `.osi-stock` suffixes and checksum receipts. They are recovery artifacts, not alternate upgrade commands. Root can remove wrappers, invoke those artifacts, call low-level flashing tools, replace the card or restore arbitrary files; those actions bypass the supported entry points. Package reinstall can replace a wrapper; rerun current application deploy to reinstall and verify the guard. A changed stock script requires an operator disposition rather than silently replacing its saved checksum. An interrupted installer may leave `/tmp/osi-image-guard-install.lock`; after proving no installer runs, remove the empty directory and retry. Reboot also clears this temporary lock.

Gateways on 0.8.0–0.8.2 that have not received the guard remain exposed. Installing a newer image cannot protect an earlier archive collection or recover writes that were never captured. Changing only `/etc/sysupgrade.conf` does not fix this. Do an application deploy first; do not then use the image as a farm upgrade.

## Destination hold

The new image records initialization at `/etc/osi-image-initialization.json`, with its phase, step, timestamp and reason. This is a bounded atomic file, independent of the system log ring. Script 93 inspects again even if an operator's archive carried an older ready receipt. Before seeding or copying application code, it inspects for a retained farm database, SQLite recovery files, ChirpStack files or old application/provisioning state. Any such state holds the application. A kept database is unproven even when its schema is already at the image head: this patch never migrates it at boot.

Node-RED's init checks the hold before payload repair, identity reads or application startup. W5's `payload_switch_repair` must remain after W7's hold and before the normal flow-file reads. While held, Node-RED's service runs only a small recovery-page responder on port 1880; the normal GUI proxy displays that page. Bootstrap is also held. Reboot and manual service start preserve the hold. The page has no forms, recovery endpoints or registration action.

On an empty device, the image publishes its seed atomically, installs image code and verifies the native sqlite module as before. A recorded fresh initialization can retry a failed step; it becomes ready only at the end of script 98. Directory/symlink collision repair is restricted to that fresh initialization. It is never used to place new helpers over a retained database. An application deploy onto an older image does not install the image-required marker and continues its existing migration and payload path.

## Recovery and verified backups

Keep the held gateway down until an operator chooses one of these routes:

- Restore a verified complete device backup with its matching firmware and state. A database-only restore needs operator assistance to restore the matching account secret, radio keys/configuration, media and compatible application. Restoring an old farm DB into this held new image does not release the hold or authorize boot migration. There is no command here that marks a retained DB trusted. After recovering a working compatible installation, use application deploy for its schema/code upgrade.
- From a root console terminal, run `osi-factory-reset --erase-farm-and-radio-state`. This invokes OpenWrt's full overlay reset and reboots. It erases farm history and accounts together with ChirpStack devices/keys, credentials and local configuration. This is deliberate data erasure, not an upgrade. It is unavailable through the recovery page. The command refuses separately mounted or linked `/data`/`/srv` storage, which needs an operator erasure procedure.

Before reset or repair, take backups outside the storage that will be erased. Stop Node-RED and verify its writers exited; stop ChirpStack and other state writers before capturing their state. Ensure the backup filesystem has enough free space for the DB and WAL before proceeding. For the farm database, use SQLite's online backup operation, never independent file copies of live DB/WAL/SHM files:

```sh
backup_dir="/data/db/backups/osi-os-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$backup_dir" && chmod 700 "$backup_dir"
sqlite3 /data/db/farming.db ".backup '$backup_dir/farming.db'"
test "$(sqlite3 "$backup_dir/farming.db" 'PRAGMA integrity_check;')" = ok
```

Stop on any nonzero result. Compare application-level state too: most recent history, account count, schedules and running valve expectations. A structurally valid stale copy can omit all of these. Preserve the auth-token secret and the runbook's configuration/radio/media inventory with the backup. Copy the resulting files to an operator-controlled device over authenticated SSH, protect credential files, compare transfer checksums and rerun integrity/state checks on the receiving copy before erasing anything. A backup left under `/data` is erased by reset; `sysupgrade -b` is not this backup procedure.

The image builder must qualify guarded upgrades from both older fixture images, unsupported restores with and without kept DBs, repeated hold boots/manual starts, the recovery page, console reset and the empty-device control. Repository fixtures cover the shell/Node decisions and entry-point scripts; they do not prove a physical power cut or a booted image.
