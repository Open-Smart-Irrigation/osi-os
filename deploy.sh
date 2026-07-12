#!/bin/sh
# OSI OS - Remote deploy script
# Runs ON THE PI. Downloads OSI OS components from a local HTTP server
# tunnelled through the SSH connection.
#
# Usage (from your dev machine):
#   ssh -R 9876:localhost:9876 root@<pi-ip> 'curl -fsS http://localhost:9876/deploy.sh | sh'
#
# Safety invariant: this script must never overwrite /data/db/farming.db.
# The edge database is live user data and osi-os is the operational source of
# truth. The bundled seed database is only copied when the target DB is absent.

set -eu

PORT="${1:-9876}"
BASE="http://localhost:$PORT"
DB_DIR="/data/db"
DB_PATH="$DB_DIR/farming.db"
# Pick the seed DB from the profile matching the running hardware.
# /proc/device-tree/model is canonical on Raspberry Pi OS / OpenWrt for bcm27xx.
detect_seed_db_rel() {
    model=""
    if [ -r /proc/device-tree/model ]; then
        model=$(tr -d '\0' </proc/device-tree/model 2>/dev/null || true)
    fi
    case "$model" in
        *"Raspberry Pi 5"*)
            echo "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db"
            ;;
        *"Raspberry Pi 4"*|*"Raspberry Pi 400"*|*"Raspberry Pi 3"*|*"Raspberry Pi 2"*)
            echo "conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db"
            ;;
        *"Raspberry Pi Zero"*|*"Raspberry Pi Model"*)
            echo "conf/full_raspberrypi_bcm27xx_bcm2708/files/usr/share/db/farming.db"
            ;;
        *)
            # Unknown model — fall back to bcm2712 (the canonical source-of-truth).
            echo "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db"
            ;;
    esac
}
SEED_DB_REL="$(detect_seed_db_rel)"
TMP_DIR="/tmp/osi-os-deploy.$$"
PAYLOADS_ROOT="/srv/node-red/payloads"
DEPLOY_STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
PAYLOAD_KEEP_N="${PAYLOAD_KEEP_N:-5}"
SWAP_JS="$TMP_DIR/deploy-payload-swap.js"

cleanup() {
    rm -rf "$TMP_DIR"
}
trap cleanup EXIT INT TERM

mkdir -p "$TMP_DIR" /srv/node-red "$PAYLOADS_ROOT" "$DB_DIR"

fetch() {
    src="$1"
    dest="$2"
    mkdir -p "$(dirname "$dest")"
    curl -fsSLo "$dest" "$BASE/$src"
}

fetch_required() {
    label="$1"
    src="$2"
    dest="$3"
    echo "--- $label ---"
    fetch "$src" "$dest"
    echo "OK"
}

same_fs_or_die() {
    # BusyBox ash lacks stat; fall back to df mount-point comparison
    if command -v stat >/dev/null 2>&1; then
        dev_a="$(stat -c %d /srv/node-red 2>/dev/null)"
        dev_b="$(stat -c %d "$PAYLOADS_ROOT" 2>/dev/null)"
        if [ -n "$dev_a" ] && [ -n "$dev_b" ] && [ "$dev_a" != "$dev_b" ]; then
            echo "ERROR: $PAYLOADS_ROOT is on a different filesystem than /srv/node-red; symlink flip would not be atomic." >&2
            exit 1
        fi
    else
        mnt_a="$(df /srv/node-red 2>/dev/null | tail -1 | awk '{print $NF}')"
        mnt_b="$(df "$PAYLOADS_ROOT" 2>/dev/null | tail -1 | awk '{print $NF}')"
        if [ -n "$mnt_a" ] && [ -n "$mnt_b" ] && [ "$mnt_a" != "$mnt_b" ]; then
            echo "ERROR: $PAYLOADS_ROOT is on a different filesystem than /srv/node-red; symlink flip would not be atomic." >&2
            exit 1
        fi
    fi
}

swap_call() {
    node -e '
      const m = require(process.argv[1]);
      const fn = process.argv[2];
      const args = process.argv.slice(3);
      const out = m[fn]("/srv/node-red", ...args);
      if (out === null || out === undefined) process.exit(0);
      if (typeof out === "object") process.stdout.write(JSON.stringify(out));
      else process.stdout.write(String(out));
    ' "$SWAP_JS" "$@"
}

run_communication_preflight() {
    echo "--- Communication preflight ---"
    preflight_dir="$TMP_DIR/preflight"
    mkdir -p "$preflight_dir"
    fetch "scripts/verify-communication-contract.js" "$preflight_dir/scripts/verify-communication-contract.js"
    (
        cd "$preflight_dir"
        mkdir -p conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share
        mkdir -p conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share
        mkdir -p conf/full_raspberrypi_bcm27xx_bcm2708/files/usr/share
        mkdir -p feeds/chirpstack-openwrt-feed/apps/node-red/files
        mkdir -p scripts
        fetch "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json" "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json"
        fetch "conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json" "conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json"
        fetch "conf/full_raspberrypi_bcm27xx_bcm2708/files/usr/share/flows.json" "conf/full_raspberrypi_bcm27xx_bcm2708/files/usr/share/flows.json"
        fetch "feeds/chirpstack-openwrt-feed/apps/node-red/files/node-red.init" "feeds/chirpstack-openwrt-feed/apps/node-red/files/node-red.init"
        fetch "feeds/chirpstack-openwrt-feed/apps/node-red/files/settings.js" "feeds/chirpstack-openwrt-feed/apps/node-red/files/settings.js"
        fetch "scripts/chirpstack-bootstrap.js" "scripts/chirpstack-bootstrap.js"
        fetch "scripts/diagnose-pi-communication.sh" "scripts/diagnose-pi-communication.sh"
        for required in \
            scripts/verify-communication-contract.js \
            conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json \
            conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json \
            conf/full_raspberrypi_bcm27xx_bcm2708/files/usr/share/flows.json \
            feeds/chirpstack-openwrt-feed/apps/node-red/files/node-red.init \
            feeds/chirpstack-openwrt-feed/apps/node-red/files/settings.js \
            scripts/chirpstack-bootstrap.js \
            scripts/diagnose-pi-communication.sh
        do
            [ -s "$required" ] || { echo "ERROR: preflight artifact missing or empty: $required" >&2; exit 1; }
        done
        REPO_ROOT="$preflight_dir" node "$preflight_dir/scripts/verify-communication-contract.js"
    )
    echo "OK"
}

seed_db_if_missing() {
    echo "--- farming.db ---"
    if [ -e "$DB_PATH" ]; then
        echo "SKIP: existing live database preserved at $DB_PATH"
        return 0
    fi
    if [ -e "$DB_PATH-wal" ] || [ -e "$DB_PATH-shm" ] || [ -e "$DB_PATH-journal" ]; then
        echo "ERROR: $DB_PATH is missing but SQLite sidecar files exist." >&2
        echo "Refusing to seed; inspect $DB_DIR before continuing." >&2
        return 1
    fi

    seed_tmp="$TMP_DIR/farming.db"
    fetch "$SEED_DB_REL" "$seed_tmp"
    if command -v sqlite3 >/dev/null 2>&1; then
        sqlite3 "$seed_tmp" "PRAGMA integrity_check;" | grep -qx "ok"
    fi
    if [ -e "$DB_PATH" ]; then
        echo "SKIP: existing live database appeared during deploy and was preserved at $DB_PATH"
        return 0
    fi
    mv "$seed_tmp" "$DB_PATH"
    echo "OK: seeded new database at $DB_PATH"
}

node_red_restart_needed=0

restore_deploy_trap() {
    trap cleanup EXIT INT TERM
}

restart_node_red() {
    if [ "$node_red_restart_needed" != "1" ]; then
        return 0
    fi
    node_red_restart_needed=0
    echo "--- Restart Node-RED after schema migration ---"
    if /etc/init.d/node-red start; then
        echo "OK"
        return 0
    fi
    echo "ERROR: Node-RED did not start after schema migration" >&2
    return 1
}

checkpoint_live_db() {
    if ! sqlite3 "$DB_PATH" "PRAGMA wal_checkpoint(TRUNCATE);" >/dev/null; then
        echo "ERROR: failed to checkpoint $DB_PATH before migration" >&2
        return 1
    fi
    if ! integrity="$(sqlite3 "$DB_PATH" "PRAGMA integrity_check;")"; then
        echo "ERROR: failed to run integrity_check on $DB_PATH before migration" >&2
        return 1
    fi
    if [ "$integrity" != "ok" ]; then
        echo "ERROR: $DB_PATH integrity_check failed before migration: $integrity" >&2
        return 1
    fi
}

ensure_sqlite3_cli() {
    if command -v sqlite3 >/dev/null 2>&1; then
        return 0
    fi
    if command -v opkg >/dev/null 2>&1; then
        echo "sqlite3 CLI absent; installing sqlite3-cli via opkg"
        opkg update >/dev/null 2>&1 || true
        opkg install sqlite3-cli >/dev/null 2>&1 || true
    fi
    if command -v sqlite3 >/dev/null 2>&1; then
        return 0
    fi
    echo "ERROR: sqlite3 CLI unavailable and could not be installed; refusing schema migration" >&2
    return 1
}

fetch_migration_runner() {
    migrations_dir="$TMP_DIR/database/migrations/ordered"
    mkdir -p "$migrations_dir" "$TMP_DIR/scripts" "$TMP_DIR/lib/osi-migrate"

    fetch_required "Migration checksum manifest" \
        "database/migrations/ordered/CHECKSUMS.json" \
        "$migrations_dir/CHECKSUMS.json"

    for migration in $(node -e "const fs=require('fs'); const manifest=JSON.parse(fs.readFileSync(process.argv[1], 'utf8')); for (const name of Object.keys(manifest).sort()) console.log(name);" "$migrations_dir/CHECKSUMS.json"); do
        fetch_required "Migration $migration" \
            "database/migrations/ordered/$migration" \
            "$migrations_dir/$migration"
    done

    for script in \
        baseline-existing-db.js \
        repair-sync-outbox-v2.js \
        migrate-cli.js \
        semantic-schema-compare.js
    do
        fetch_required "Migration script $script" "scripts/$script" "$TMP_DIR/scripts/$script"
    done

    for module in \
        backup.js \
        fingerprints.js \
        index.js \
        ledger.js \
        migrations-loader.js \
        runner-iface.js \
        runner.js \
        sql-normalize.js
    do
        fetch_required "Migration runner module $module" "lib/osi-migrate/$module" "$TMP_DIR/lib/osi-migrate/$module"
    done
}

run_schema_migration() {
    echo "--- Edge schema migration runner ---"
    if [ ! -e "$DB_PATH" ]; then
        echo "SKIP: no live database at $DB_PATH"
        return 0
    fi
    if ! ensure_sqlite3_cli; then
        return 1
    fi
    if ! command -v node >/dev/null 2>&1; then
        echo "ERROR: node is required for schema migrations" >&2
        return 1
    fi

    fetch_migration_runner

    backup_dir="${MIGRATE_BACKUP_DIR:-/data/backups/migrate}"
    mkdir -p "$backup_dir"

    node_red_restart_needed=1
    trap 'restart_node_red || true; cleanup' EXIT INT TERM

    echo "--- Stop Node-RED for schema migration ---"
    if /etc/init.d/node-red stop; then
        echo "OK"
    else
        echo "ERROR: failed to stop Node-RED before schema migration" >&2
        return 1
    fi
    stop_wait=0
    while command -v pgrep >/dev/null 2>&1 && pgrep -f 'node-red' >/dev/null 2>&1 && [ "$stop_wait" -lt 30 ]; do
        sleep 1
        stop_wait=$((stop_wait + 1))
    done
    if command -v pgrep >/dev/null 2>&1 && pgrep -f 'node-red' >/dev/null 2>&1; then
        echo "ERROR: Node-RED did not stop within 30s; refusing schema migration" >&2
        return 1
    fi

    if ! checkpoint_live_db; then
        return 1
    fi
    if ! ledger_present="$(sqlite3 "$DB_PATH" "SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations' LIMIT 1;")"; then
        echo "ERROR: failed to inspect schema_migrations ledger before migration" >&2
        return 1
    fi
    ledger_rows="0"
    if [ "$ledger_present" = "1" ]; then
        if ! ledger_rows="$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM schema_migrations;")"; then
            echo "ERROR: failed to inspect schema_migrations rows before migration" >&2
            return 1
        fi
    fi
    if [ "$ledger_rows" != "0" ]; then
        echo "SKIP: schema_migrations ledger already has rows"
    else
        if ! node "$TMP_DIR/scripts/repair-sync-outbox-v2.js" "$DB_PATH"; then
            return 1
        fi
        if ! node "$TMP_DIR/scripts/baseline-existing-db.js" "$DB_PATH" --migrations-dir "$migrations_dir"; then
            return 1
        fi
    fi
    if ! checkpoint_live_db; then
        return 1
    fi

    if node "$TMP_DIR/scripts/migrate-cli.js" "$DB_PATH" --backup-dir "$backup_dir" --migrations-dir "$migrations_dir"; then
        if ! restart_node_red; then
            restore_deploy_trap
            return 1
        fi
        restore_deploy_trap
        echo "OK"
        return 0
    else
        migration_rc=$?
    fi

    if [ "$migration_rc" = "3" ]; then
        echo "ERROR: migration failed and backup restore integrity check failed; leaving Node-RED stopped" >&2
        node_red_restart_needed=0
        restore_deploy_trap
        return 1
    fi
    echo "ERROR: schema migration failed; Node-RED will be restarted before deploy exits" >&2
    return 1
}

echo "=== OSI OS Deploy ==="
echo "Source: $BASE"

run_communication_preflight

fetch_required "Node-RED settings.js" \
    "feeds/chirpstack-openwrt-feed/apps/node-red/files/settings.js" \
    "/srv/node-red/settings.js"

fetch_required "Node-RED init script" \
    "feeds/chirpstack-openwrt-feed/apps/node-red/files/node-red.init" \
    "/etc/init.d/node-red"
chmod 755 /etc/init.d/node-red

fetch_required "Gateway identity helper" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/libexec/osi-gateway-identity.sh" \
    "/usr/libexec/osi-gateway-identity.sh"
chmod 755 /usr/libexec/osi-gateway-identity.sh

echo "--- Remove legacy gateway GPS sidecar ---"
if [ -x /etc/init.d/osi-gateway-gps ]; then
    /etc/init.d/osi-gateway-gps stop || true
    /etc/init.d/osi-gateway-gps disable || true
fi
rm -f /etc/init.d/osi-gateway-gps /usr/bin/osi-gateway-gps.js
echo "OK"

echo "--- Deploy payload swap helper ---"
fetch "scripts/deploy-payload-swap.js" "$SWAP_JS"
same_fs_or_die
echo "OK"

echo "--- flows.json (staged payload; flip deferred to post-migration) ---"
STAGED_FLOWS="$TMP_DIR/flows.json"
fetch "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json" "$STAGED_FLOWS"
swap_call stagePayload "$DEPLOY_STAMP" "$STAGED_FLOWS" >/dev/null
PREV_STAMP="$(swap_call currentStamp || true)"
echo "OK: staged payloads/$DEPLOY_STAMP (current: ${PREV_STAMP:-none}; flip deferred)"

seed_db_if_missing

fetch_required "Node-RED runtime package.json" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/package.json" \
    "/srv/node-red/package.json"

fetch_required "Node-RED runtime package-lock.json" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/package-lock.json" \
    "/srv/node-red/package-lock.json"

fetch_required "osi-chirpstack-helper package.json" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-chirpstack-helper/package.json" \
    "/srv/node-red/osi-chirpstack-helper/package.json"

fetch_required "osi-chirpstack-helper index.js" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-chirpstack-helper/index.js" \
    "/srv/node-red/osi-chirpstack-helper/index.js"

fetch_required "osi-db-helper package.json" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-db-helper/package.json" \
    "/srv/node-red/osi-db-helper/package.json"

fetch_required "osi-db-helper index.js" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-db-helper/index.js" \
    "/srv/node-red/osi-db-helper/index.js"

fetch_required "osi-health-helper package.json" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-health-helper/package.json" \
    "/srv/node-red/osi-health-helper/package.json"

fetch_required "osi-health-helper index.js" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-health-helper/index.js" \
    "/srv/node-red/osi-health-helper/index.js"

fetch_required "osi-dendro-helper package.json" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-dendro-helper/package.json" \
    "/srv/node-red/osi-dendro-helper/package.json"

fetch_required "osi-dendro-helper index.js" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-dendro-helper/index.js" \
    "/srv/node-red/osi-dendro-helper/index.js"

fetch_required "osi-dendro-analytics package.json" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-dendro-analytics/package.json" \
    "/srv/node-red/osi-dendro-analytics/package.json"

fetch_required "osi-dendro-analytics index.js" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-dendro-analytics/index.js" \
    "/srv/node-red/osi-dendro-analytics/index.js"

fetch_required "osi-zone-env package.json" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-zone-env/package.json" \
    "/srv/node-red/osi-zone-env/package.json"

fetch_required "osi-zone-env index.js" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-zone-env/index.js" \
    "/srv/node-red/osi-zone-env/index.js"

fetch_required "osi-history-helper package.json" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-helper/package.json" \
    "/srv/node-red/osi-history-helper/package.json"

fetch_required "osi-history-helper index.js" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-helper/index.js" \
    "/srv/node-red/osi-history-helper/index.js"

fetch_required "osi-history-helper analysis.js" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-helper/analysis.js" \
    "/srv/node-red/osi-history-helper/analysis.js"

fetch_required "osi-history-router package.json" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-router/package.json" \
    "/srv/node-red/osi-history-router/package.json"

fetch_required "osi-history-router index.js" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-router/index.js" \
    "/srv/node-red/osi-history-router/index.js"

fetch_required "osi-history-sync-helper package.json" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-sync-helper/package.json" \
    "/srv/node-red/osi-history-sync-helper/package.json"

fetch_required "osi-history-sync-helper index.js" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-sync-helper/index.js" \
    "/srv/node-red/osi-history-sync-helper/index.js"

fetch_required "osi-chameleon-helper package.json" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-chameleon-helper/package.json" \
    "/srv/node-red/osi-chameleon-helper/package.json"

fetch_required "osi-chameleon-helper index.js" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-chameleon-helper/index.js" \
    "/srv/node-red/osi-chameleon-helper/index.js"

fetch_required "osi-cloud-http package.json" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-cloud-http/package.json" \
    "/srv/node-red/osi-cloud-http/package.json"

fetch_required "osi-cloud-http index.js" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-cloud-http/index.js" \
    "/srv/node-red/osi-cloud-http/index.js"

fetch_required "osi-lib package.json" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-lib/package.json" \
    "/srv/node-red/osi-lib/package.json"

fetch_required "osi-lib index.js" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-lib/index.js" \
    "/srv/node-red/osi-lib/index.js"

fetch_required "osi-device-writer package.json" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-device-writer/package.json" \
    "/srv/node-red/osi-device-writer/package.json"

fetch_required "osi-device-writer index.js" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-device-writer/index.js" \
    "/srv/node-red/osi-device-writer/index.js"

fetch_required "osi-uc512-normalize package.json" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-uc512-normalize/package.json" \
    "/srv/node-red/osi-uc512-normalize/package.json"

fetch_required "osi-uc512-normalize index.js" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-uc512-normalize/index.js" \
    "/srv/node-red/osi-uc512-normalize/index.js"

fetch_required "edge-channels.json" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/edge-channels.json" \
    "/srv/node-red/edge-channels.json"

fetch_required "chirpstack-bootstrap.js" \
    "scripts/chirpstack-bootstrap.js" \
    "/srv/node-red/chirpstack-bootstrap.js"

fetch_required "STREGA codec" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/codecs/strega_gen1_decoder.js" \
    "/srv/node-red/codecs/strega_gen1_decoder.js"

fetch_required "LSN50 codec" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/codecs/dragino_lsn50_decoder.js" \
    "/srv/node-red/codecs/dragino_lsn50_decoder.js"

fetch_required "S2120 codec" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/codecs/sensecap_s2120_decoder.js" \
    "/srv/node-red/codecs/sensecap_s2120_decoder.js"

fetch_required "LoRain codec" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/codecs/aquascope_lorain_decoder.js" \
    "/srv/node-red/codecs/aquascope_lorain_decoder.js"

fetch_required "UC512 codec" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/codecs/milesight_uc512_decoder.js" \
    "/srv/node-red/codecs/milesight_uc512_decoder.js"

fetch_required "Agroscope uplink transform" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/codecs/agroscope_uplink_transform.js" \
    "/srv/node-red/codecs/agroscope_uplink_transform.js"

echo "--- Node-RED runtime dependencies ---"
npm_log="$TMP_DIR/npm-install.log"
if cd /srv/node-red && npm install --omit=dev --no-fund --no-audit >"$npm_log" 2>&1; then
    tail -20 "$npm_log"
else
    tail -80 "$npm_log" >&2
    echo "ERROR: npm install failed" >&2
    exit 1
fi

run_schema_migration || exit 1

fix_mosquitto_ownership() {
    echo "--- Mosquitto ownership ---"
    if [ ! -e /etc/mosquitto/mosquitto.conf ]; then
        echo "SKIP: mosquitto not installed"
        return 0
    fi
    local user="mosquitto"
    if command -v uci >/dev/null 2>&1; then
        local uci_user="$(uci -q get mosquitto.@mosquitto[0].user 2>/dev/null || true)"
        [ -n "$uci_user" ] && user="$uci_user"
    fi
    if ! id -u "$user" >/dev/null 2>&1; then
        echo "SKIP: mosquitto user '$user' does not exist"
        return 0
    fi
    for f in /etc/mosquitto/mosquitto.passwd \
             /etc/mosquitto/mosquitto.acl \
             /var/lib/mosquitto; do
        if [ -e "$f" ]; then
            chown -R "$user:$user" "$f"
            [ -d "$f" ] && chmod 750 "$f" || chmod 0600 "$f" 2>/dev/null || true
        fi
    done
    if [ -e /var/lib/mosquitto/mosquitto.db ]; then
        chown "$user:$user" /var/lib/mosquitto/mosquitto.db
        chmod 0600 /var/lib/mosquitto/mosquitto.db 2>/dev/null || true
    fi
    echo "OK"
}

fix_mosquitto_ownership

echo "--- Flip payload + local health self-check + auto-rollback (5.3 / DD10) ---"
swap_call flipTo "$DEPLOY_STAMP" >/dev/null
echo "OK: flipped /srv/node-red/flows.json -> payloads/$DEPLOY_STAMP"

/etc/init.d/node-red restart || true

PROBE_OK=1
if pgrep -f 'node-red' >/dev/null 2>&1; then
    sleep 5
    if wget -q -O /dev/null --spider "http://127.0.0.1:1880/gui" 2>/dev/null; then
        echo "OK: local health self-check PASSED (Node-RED alive, /gui reachable)"
        PROBE_OK=0
    else
        echo "WARN: Node-RED process alive but /gui not reachable after 5s" >&2
    fi
else
    echo "ALERT: Node-RED process not found after restart" >&2
fi

if [ "$PROBE_OK" = "0" ]; then
    echo "OK: committing payload $DEPLOY_STAMP"
    swap_call prunePayloads "$PAYLOAD_KEEP_N" >/dev/null
else
    echo "ALERT: local health self-check FAILED - AUTO-ROLLING-BACK the flows payload" >&2
    if [ -n "${PREV_STAMP:-}" ]; then
        swap_call flipTo "$PREV_STAMP" >/dev/null
        /etc/init.d/node-red restart || true
        echo "ROLLED BACK: flows.json -> payloads/$PREV_STAMP; Node-RED restarted on last-known-good payload" >&2
        echo "NOTE: any committed DB migration is NOT auto-undone (DD10); restore is an operator call via 1.B1 backup." >&2
        echo "NOTE: run deploy-canary-gate.js from your operator machine for the full cloud verdict." >&2
        exit 1
    fi
    echo "ERROR: no previous payload to roll back to. Payload $DEPLOY_STAMP left live; investigate." >&2
    exit 1
fi

echo "--- React GUI ---"
fetch "react_gui.tar.gz" "$TMP_DIR/react_gui.tar.gz"
mkdir -p /usr/lib/node-red/gui
for entry in /usr/lib/node-red/gui/* /usr/lib/node-red/gui/.[!.]* /usr/lib/node-red/gui/..?*; do
    [ -e "$entry" ] || continue
    rm -rf "$entry"
done
tar xzf "$TMP_DIR/react_gui.tar.gz" -C /usr/lib/node-red/gui/
echo "OK"

echo ""
echo "=== Deploy complete. ==="
echo "  Payload:  /srv/node-red/payloads/$DEPLOY_STAMP (flipped + local health self-checked)"
echo "  UI:       http://<device-ip>:1880/gui"
echo "  Rollback: automatic for payload failure; committed DB migration restore is the 1.B1 operator path, not auto."
echo ""
echo "  NOTE: ChirpStack provisioning runs automatically on first boot via"
echo "        osi-bootstrap (START=99).  No manual bootstrap step needed on"
echo "        a freshly installed gateway.  To re-provision manually run:"
echo "        node /usr/share/node-red/chirpstack-bootstrap.js"
