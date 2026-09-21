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
GUI_ROOT="/usr/lib/node-red/gui"
NODE_RED_INIT="/etc/init.d/node-red"
# Tracks whether this deploy's staged payload has already been flipped into
# /srv/node-red/flows.json. Set by run_schema_migration() on a successful
# migration (issue #222 / F4 — see there) and consulted by the later
# "Flip payload + local health self-check" block so it never re-flips (or,
# on the no-op path, still flips exactly once).
PAYLOAD_FLIPPED=0
ROLLBACK_RESTORED=0
NODE_RED_LOG_MARK=""
DB_MIGRATION_COMMITTED=0
PREV_CAPTURED=0
DEPLOY_HOLD_SERVICES=0
MIGRATION_RUNNER_AVAILABLE=0
SWAP_JS="$TMP_DIR/deploy-payload-swap.js"
SWAP_ROOT="${SWAP_ROOT:-/srv/node-red}"
export SWAP_ROOT

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
      const out = m[fn](process.env.SWAP_ROOT || "/srv/node-red", ...args);
      if (out === null || out === undefined) process.exit(0);
      if (typeof out === "boolean") process.exit(out ? 0 : 1);
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
        mkdir -p conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/uci-defaults
        mkdir -p conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/uci-defaults
        mkdir -p feeds/chirpstack-openwrt-feed/apps/node-red/files
        mkdir -p scripts
        fetch "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json" "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json"
        fetch "conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json" "conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json"
        fetch "conf/full_raspberrypi_bcm27xx_bcm2708/files/usr/share/flows.json" "conf/full_raspberrypi_bcm27xx_bcm2708/files/usr/share/flows.json"
        fetch "conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/uci-defaults/96_osi_server_config" "conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/uci-defaults/96_osi_server_config"
        fetch "conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/uci-defaults/96_osi_server_config" "conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/uci-defaults/96_osi_server_config"
        fetch "feeds/chirpstack-openwrt-feed/apps/node-red/files/node-red.init" "feeds/chirpstack-openwrt-feed/apps/node-red/files/node-red.init"
        fetch "feeds/chirpstack-openwrt-feed/apps/node-red/files/settings.js" "feeds/chirpstack-openwrt-feed/apps/node-red/files/settings.js"
        fetch "scripts/chirpstack-bootstrap.js" "scripts/chirpstack-bootstrap.js"
        fetch "scripts/diagnose-pi-communication.sh" "scripts/diagnose-pi-communication.sh"
        for required in \
            scripts/verify-communication-contract.js \
            conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json \
            conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json \
            conf/full_raspberrypi_bcm27xx_bcm2708/files/usr/share/flows.json \
            conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/uci-defaults/96_osi_server_config \
            conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/uci-defaults/96_osi_server_config \
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

ensure_journal_media_defaults() {
    echo "--- Journal media configuration ---"
    uci -q get osi-server.cloud.journal_photo_cache_bytes >/dev/null 2>&1 || \
        uci set osi-server.cloud.journal_photo_cache_bytes='4294967296'
    uci -q get osi-server.cloud.journal_min_free_bytes >/dev/null 2>&1 || \
        uci set osi-server.cloud.journal_min_free_bytes='4294967296'
    uci -q get osi-server.cloud.journal_media_root >/dev/null 2>&1 || \
        uci set osi-server.cloud.journal_media_root='/data/journal-media'
    uci commit osi-server
    echo "OK"
}

# --- Native sqlite3 (F148) --------------------------------------------------
# On a stock image /srv/node-red/node_modules/sqlite3 is a SYMLINK into the
# opkg package node-red-node-sqlite (conf/*/files/etc/uci-defaults/
# 98_osi_node_red_seed), because that cross-compiled binary is the only
# sqlite3 built for the gateway's CPU. The shipped package-lock.json declares
# sqlite3 as an ordinary REGISTRY dependency, so npm's arborist finds a Link
# where the lockfile says registry, marks the path CHANGE, retires the symlink
# and re-extracts the tarball -- which carries no binary and whose install
# script then runs `prebuild-install -r napi || node-gyp rebuild`. On
# armv7l + musl no prebuilt is published and the gateway has no Python, so
# that exits 1 and the whole deploy stops (re-cut 9 on the Pi 4B rehearsal
# gateway, 2026-09-17). The osi-* modules survive the same run because the
# lockfile declares THEM as links too ("file:" deps).
#
# npm leaves a REAL directory holding the locked version alone, so deploy.sh
# materialises the symlink into a real directory before npm runs. Every claim
# above is exercised against real npm in scripts/test-deploy-native-sqlite3.js,
# which also runs these functions' shell text verbatim.
NODE_RED_ROOT="/srv/node-red"
# The one place this path is written: 98_osi_node_red_seed copies the module
# from here, and deploy.sh restores from here when the path under node_modules
# is empty.
NATIVE_SQLITE3_FIRMWARE_DIR="/usr/lib/node/node-red/node_modules/node-red-node-sqlite/node_modules/sqlite3"
NATIVE_ARCH="$(uname -m 2>/dev/null || echo unknown)"
MUSL_LOADER_GLOB="/lib/ld-musl-*.so.1"

# Requires the sqlite3 module at $1 (an absolute path, or a bare specifier
# resolved from the current directory) and opens :memory: with it. Errors go to
# stderr; callers that tolerate a failure redirect it.
native_sqlite3_dir_loads() {
    node -e '
      const target = process.argv[1];
      const sqlite3 = require(target);
      const db = new sqlite3.Database(":memory:", function (err) {
        if (err) {
          console.error("sqlite3 could not open :memory: -- " + (err && err.message ? err.message : err));
          process.exit(1);
        }
        db.close(function () { process.exit(0); });
      });
    ' "$1" >/dev/null
}

native_build_toolchain_present() {
    if ! command -v python3 >/dev/null 2>&1 && ! command -v python >/dev/null 2>&1; then
        return 1
    fi
    if ! command -v make >/dev/null 2>&1; then
        return 1
    fi
    if ! command -v cc >/dev/null 2>&1 && ! command -v gcc >/dev/null 2>&1; then
        return 1
    fi
    return 0
}

# True when npm could not possibly install sqlite3 on this gateway: 32-bit arm
# with musl is the one combination sqlite3 5.x publishes no napi prebuilt for
# (it ships linux-arm/glibc, linuxmusl-arm64 and friends), so the only route
# left is a local node-gyp build, which needs a toolchain the image does not
# carry.
native_sqlite3_reinstall_impossible() {
    case "$NATIVE_ARCH" in
        arm|armv6l|armv7l|armv8l) ;;
        *) return 1 ;;
    esac
    nsri_musl=0
    for nsri_loader in $MUSL_LOADER_GLOB; do
        if [ -e "$nsri_loader" ]; then
            nsri_musl=1
        fi
    done
    if [ "$nsri_musl" != "1" ]; then
        return 1
    fi
    if native_build_toolchain_present; then
        return 1
    fi
    return 0
}

# Runs before the first write of the deploy. The one state nothing downstream
# can rescue is a lockfile that pins a sqlite3 the gateway does not have and
# cannot obtain; stopping here leaves the gateway exactly as it was found.
run_native_sqlite3_preflight() {
    echo "--- Native sqlite3 preflight ---"
    nsp_installed="$NODE_RED_ROOT/node_modules/sqlite3"
    nsp_which="installed"
    nsp_pkg=""
    if [ -e "$nsp_installed" ]; then
        nsp_pkg="$nsp_installed/package.json"
    elif [ -d "$NATIVE_SQLITE3_FIRMWARE_DIR" ]; then
        # Nothing at the path: a fresh tree, a dangling symlink, or a deploy
        # killed between the unlink and the move of the swap below. In all
        # three the module that ends up there is the firmware one, so its
        # version is the one that has to match the lockfile.
        nsp_which="firmware"
        nsp_pkg="$NATIVE_SQLITE3_FIRMWARE_DIR/package.json"
    fi
    if [ -z "$nsp_pkg" ]; then
        echo "SKIP: no sqlite3 module at $nsp_installed and none in the firmware; npm install will provide one"
        return 0
    fi
    nsp_lock="$TMP_DIR/preflight-package-lock.json"
    fetch "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/package-lock.json" "$nsp_lock"
    nsp_locked="$(node -p 'const l = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); const p = (l.packages && l.packages["node_modules/sqlite3"]) || {}; p.version || ""' "$nsp_lock" 2>/dev/null || true)"
    nsp_have="$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).version || ""' "$nsp_pkg" 2>/dev/null || true)"
    if [ -z "$nsp_locked" ]; then
        echo "WARN: the shipped package-lock.json pins no sqlite3 version; skipping the preflight"
        return 0
    fi
    if [ -z "$nsp_have" ]; then
        echo "WARN: could not read the $nsp_which sqlite3 version from $nsp_pkg; skipping the preflight"
        return 0
    fi
    if [ "$nsp_have" = "$nsp_locked" ]; then
        echo "OK: $nsp_which sqlite3 $nsp_have matches the shipped lockfile"
        return 0
    fi
    if native_sqlite3_reinstall_impossible; then
        echo "ERROR: this gateway's $nsp_which sqlite3 is $nsp_have but the shipped package-lock.json pins sqlite3 $nsp_locked." >&2
        echo "ERROR: npm would have to install sqlite3 itself, and on $NATIVE_ARCH + musl no sqlite3 prebuilt is published and this gateway has no build toolchain, so that can only fail." >&2
        echo "ERROR: refusing to start the deploy; nothing has been changed. Ship an image whose node-red-node-sqlite provides sqlite3 $nsp_locked, or pin the lockfile back to $nsp_have." >&2
        return 1
    fi
    echo "WARN: the $nsp_which sqlite3 $nsp_have differs from the locked $nsp_locked; npm will install it, which needs registry access and a prebuilt for this platform"
    return 0
}

# Replaces the firmware symlink with a real directory holding the same module,
# so npm has nothing to retire. Safety: the copy is staged beside the target
# and proved loadable BEFORE the swap, the swap itself destroys only a symlink
# (the module stays where the firmware put it), and any failure puts the
# symlink back.
#
# rename(2) cannot replace a symlink with a directory, so the swap has to
# unlink before it moves. A deploy killed in that instant -- SSH drop, power
# loss, OOM -- leaves nothing at node_modules/sqlite3, which breaks Node-RED's
# sqlite nodes on the next boot and makes the next deploy the repair path. So
# an empty path is not "npm's problem": if the firmware module is still at its
# canonical location, this restores from it exactly as it would from a
# symlink, and it clears any staging directory that same kill left behind.
materialize_native_sqlite3() {
    echo "--- Native sqlite3 module (materialise before npm) ---"
    mns_modules="$NODE_RED_ROOT/node_modules"
    mns_path="$mns_modules/sqlite3"
    mns_link_target=""
    mns_source=""

    # Only this function's own staging name, only directly inside
    # node_modules. npm ignores dot-directories, so a leftover is not a
    # correctness problem, but 22 MB per interrupted deploy is not free.
    for mns_stale in "$mns_modules"/.osi-sqlite3-stage.*; do
        case "$mns_stale" in
            *'/.osi-sqlite3-stage.*') continue ;;
        esac
        if [ -d "$mns_stale" ]; then
            echo "WARN: removing a staging directory left behind by an interrupted deploy: $mns_stale" >&2
            rm -rf "$mns_stale"
        fi
    done

    if [ -L "$mns_path" ]; then
        mns_link_target="$(readlink "$mns_path" 2>/dev/null || true)"
        mns_source="$(readlink -f "$mns_path" 2>/dev/null || true)"
        if [ -z "$mns_source" ] || [ ! -d "$mns_source" ]; then
            echo "WARN: $mns_path is a dangling symlink -> ${mns_link_target:-?}; removing it" >&2
            rm -f "$mns_path"
            mns_link_target=""
            mns_source=""
        fi
    elif [ -d "$mns_path" ]; then
        echo "OK: $mns_path is already a real directory; nothing to do"
        return 0
    fi

    if [ -z "$mns_source" ]; then
        if [ ! -d "$NATIVE_SQLITE3_FIRMWARE_DIR" ]; then
            echo "SKIP: no sqlite3 module at $mns_path and none at $NATIVE_SQLITE3_FIRMWARE_DIR; npm install will provide one"
            return 0
        fi
        mns_source="$NATIVE_SQLITE3_FIRMWARE_DIR"
        echo "NOTE: nothing at $mns_path; restoring the module from $mns_source"
    fi

    if ! native_sqlite3_dir_loads "$mns_source" 2>"$TMP_DIR/sqlite3-source-load.err"; then
        echo "WARN: the firmware sqlite3 module at $mns_source does not load; leaving the install to npm" >&2
        tail -5 "$TMP_DIR/sqlite3-source-load.err" >&2 || true
        return 0
    fi

    mns_need_kb="$(du -sk "$mns_source" 2>/dev/null | awk '{print $1}')"
    case "$mns_need_kb" in ''|*[!0-9]*) mns_need_kb=0 ;; esac
    mns_avail_kb="$(df -k "$mns_modules" 2>/dev/null | tail -1 | awk '{print $4}')"
    case "$mns_avail_kb" in ''|*[!0-9]*) mns_avail_kb=0 ;; esac
    if [ "$mns_avail_kb" -gt 0 ] && [ "$mns_avail_kb" -lt $((mns_need_kb + 51200)) ]; then
        echo "ERROR: $mns_modules has ${mns_avail_kb}K free; materialising sqlite3 needs ${mns_need_kb}K plus 50M of headroom. $mns_path is left as it is." >&2
        return 1
    fi

    mkdir -p "$mns_modules" 2>/dev/null || true
    mns_stage="$(mktemp -d "$mns_modules/.osi-sqlite3-stage.XXXXXX" 2>/dev/null || true)"
    if [ -z "$mns_stage" ] || [ ! -d "$mns_stage" ]; then
        echo "ERROR: could not create a staging directory under $mns_modules; $mns_path is left as it is" >&2
        return 1
    fi
    if ! cp -a "$mns_source/." "$mns_stage/"; then
        rm -rf "$mns_stage"
        echo "ERROR: could not copy $mns_source into $mns_stage; $mns_path is left as it is" >&2
        return 1
    fi
    # The staged copy resolves its peer packages (bindings, ...) from
    # $mns_modules instead of from the firmware tree, which is precisely the
    # resolution the gateway will use after the swap -- so this check, not the
    # one on the source, is the one that decides.
    if ! native_sqlite3_dir_loads "$mns_stage" 2>"$TMP_DIR/sqlite3-stage-load.err"; then
        rm -rf "$mns_stage"
        echo "WARN: the staged copy of sqlite3 does not load from $mns_modules; $mns_path is left as it is and npm decides what to do with it." >&2
        tail -5 "$TMP_DIR/sqlite3-stage-load.err" >&2 || true
        return 0
    fi

    if [ -L "$mns_path" ]; then
        if ! rm -f "$mns_path"; then
            rm -rf "$mns_stage"
            echo "ERROR: could not remove the sqlite3 symlink at $mns_path; leaving it untouched" >&2
            return 1
        fi
    fi
    if ! mv "$mns_stage" "$mns_path"; then
        if [ -n "$mns_link_target" ]; then
            ln -s "$mns_link_target" "$mns_path" 2>/dev/null || true
        fi
        rm -rf "$mns_stage"
        echo "ERROR: could not move $mns_stage to $mns_path; the previous state is restored" >&2
        return 1
    fi
    if ! native_sqlite3_dir_loads "$mns_path"; then
        rm -rf "$mns_path"
        if [ -n "$mns_link_target" ]; then
            ln -s "$mns_link_target" "$mns_path" 2>/dev/null || true
        fi
        echo "ERROR: the materialised sqlite3 at $mns_path does not load; the previous state is restored" >&2
        return 1
    fi

    mns_owner="$(ls -ld "$mns_modules" 2>/dev/null | awk '{print $3 ":" $4}')"
    case "$mns_owner" in
        ''|:*|*:) ;;
        *) chown -R "$mns_owner" "$mns_path" 2>/dev/null || true ;;
    esac

    echo "OK: materialised $mns_path from $mns_source (${mns_need_kb}K); npm now leaves the native module alone"
    return 0
}

verify_native_sqlite3_after_npm() {
    echo "--- Native sqlite3 verification ---"
    if ( cd "$NODE_RED_ROOT" && native_sqlite3_dir_loads sqlite3 ); then
        echo "OK: require('sqlite3') resolves in $NODE_RED_ROOT and opens :memory:"
        return 0
    fi
    echo "ERROR: require('sqlite3') failed in $NODE_RED_ROOT after npm install." >&2
    echo "ERROR: Node-RED cannot open the edge database without it; stopping before the schema migration." >&2
    return 1
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

# identityd deploy lifecycle begin
IDENTITYD_LOCK_PATH="/var/run/osi-identityd.lock"
identityd_deploy_state="untouched"

identityd_service() {
    /etc/init.d/osi-identityd "$@"
}

identityd_sleep() {
    sleep "$1"
}

identityd_lock_present() {
    [ -e "$IDENTITYD_LOCK_PATH" ] || [ -L "$IDENTITYD_LOCK_PATH" ]
}

wait_for_identityd_quiescence() {
    identityd_quiesce_attempts=0
    while identityd_service running || identityd_lock_present; do
        identityd_quiesce_attempts=$((identityd_quiesce_attempts + 1))
        [ "$identityd_quiesce_attempts" -lt 10 ] || return 1
        identityd_sleep 1
    done
}

wait_for_identityd_ready() {
    identityd_ready_attempts=0
    while ! identityd_service ready; do
        identityd_ready_attempts=$((identityd_ready_attempts + 1))
        [ "$identityd_ready_attempts" -lt 5 ] || return 1
        identityd_sleep 1
    done
}

quiesce_identityd_instance() {
    if identityd_service running || identityd_lock_present; then
        identityd_service stop || true
    fi
    wait_for_identityd_quiescence
}

quiesce_identityd_for_deploy() {
    echo "--- Quiesce gateway identity supervisor before schema migration ---"
    if identityd_service running; then
        identityd_deploy_state="restore_running"
    else
        identityd_deploy_state="restore_stopped"
    fi
    if ! quiesce_identityd_instance; then
        echo "ERROR: identityd did not release procd state and $IDENTITYD_LOCK_PATH; refusing schema migration" >&2
        return 1
    fi
    echo "OK"
}

hold_identityd_stopped() {
    echo "ERROR: migrated database has no proven compatible active payload; keeping identityd stopped" >&2
    if ! quiesce_identityd_instance; then
        echo "ERROR: could not prove identityd stopped after the committed migration" >&2
        return 1
    fi
    identityd_deploy_state="fatal_hold"
    return 0
}

restore_identityd_prior_state() {
    case "$identityd_deploy_state" in
        untouched|disarmed|fatal_hold)
            return 0
            ;;
        restore_running|restore_stopped)
            ;;
        *)
            echo "ERROR: unknown identityd deploy state: $identityd_deploy_state" >&2
            return 1
            ;;
    esac

    echo "--- Restore gateway identity supervisor after interrupted deploy ---"
    if ! quiesce_identityd_instance; then
        echo "ERROR: could not quiesce a partial identityd activation" >&2
        return 1
    fi
    if [ "$identityd_deploy_state" = "restore_stopped" ]; then
        identityd_deploy_state="disarmed"
        echo "OK: identityd restored to stopped state"
        return 0
    fi

    identityd_service start
    if ! wait_for_identityd_ready; then
        echo "ERROR: identityd did not become ready while restoring prior state" >&2
        quiesce_identityd_instance || true
        return 1
    fi
    identityd_deploy_state="disarmed"
    echo "OK"
}

deploy_exit_handler() {
    exit_status="$1"
    trap - EXIT INT TERM
    set +e
    if [ "${ROLLBACK_RESTORED:-0}" = "1" ] && [ "$exit_status" -ne 0 ]; then
        echo "OK: preserving the verified rollback pair while returning deploy failure" >&2
        if ! restore_identityd_prior_state; then
            echo "ERROR: identityd could not be restored after the verified rollback" >&2
        fi
    elif [ "${DB_MIGRATION_COMMITTED:-0}" = "1" ] && [ "$exit_status" -ne 0 ]; then
        DEPLOY_HOLD_SERVICES=1
        if [ -z "${PREV_STAMP:-}" ] && [ -n "${DEPLOY_STAMP:-}" ] && \
            { [ "${PAYLOAD_FLIPPED:-0}" = "1" ] || [ "${node_red_restart_needed:-0}" = "1" ]; }; then
            cleanup_failed_first_payload
        else
            echo "ERROR: migrated database has no proven compatible active payload; keeping Node-RED stopped" >&2
            hold_node_red_stopped || true
            if [ -n "${DEPLOY_STAMP:-}" ] && [ "${PAYLOAD_FLIPPED:-0}" != "1" ]; then
                swap_call discardPayload "$DEPLOY_STAMP" >/dev/null 2>&1 || true
            fi
        fi
        hold_identityd_stopped || true
    elif [ "$exit_status" -ne 0 ] && [ -z "${PREV_STAMP:-}" ] && [ -n "${DEPLOY_STAMP:-}" ] && \
        { [ "${PAYLOAD_FLIPPED:-0}" = "1" ] || [ "${node_red_restart_needed:-0}" = "1" ]; }; then
        cleanup_failed_first_payload
    else
        # A pre-activation failure still has the old pair live; remove only
        # the staged directory before restoring Node-RED.
        if [ "${PAYLOAD_FLIPPED:-0}" != "1" ] && [ -n "${DEPLOY_STAMP:-}" ]; then
            swap_call discardPayload "$DEPLOY_STAMP" >/dev/null 2>&1 || true
        fi
        if [ "${node_red_restart_needed:-0}" = "1" ] && [ -n "${PREV_STAMP:-}" ] && \
            ! verify_payload_db_compatibility "$PREV_STAMP" retained; then
            echo "ERROR: fallback payload is not proven compatible with the current database; keeping services stopped" >&2
            DEPLOY_HOLD_SERVICES=1
            hold_node_red_stopped || true
            hold_identityd_stopped || true
        elif ! restart_node_red; then
            [ "$exit_status" -ne 0 ] || exit_status=1
        fi
    fi
    if [ "${DEPLOY_HOLD_SERVICES:-0}" != "1" ] && ! restore_identityd_prior_state; then
        [ "$exit_status" -ne 0 ] || exit_status=1
    fi
    cleanup
    exit "$exit_status"
}

install_deploy_exit_trap() {
    trap 'deploy_exit_handler $?' EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM
}
# identityd deploy lifecycle end

restart_node_red() {
    if [ "$node_red_restart_needed" != "1" ]; then
        return 0
    fi
    echo "--- Restart Node-RED after schema migration ---"
    if /etc/init.d/node-red start; then
        node_red_restart_needed=0
        echo "OK"
        return 0
    fi
    echo "ERROR: Node-RED did not start after schema migration" >&2
    return 1
}

# node-red service state begin
node_red_service_state() {
    local service_json

    if ! command -v ubus >/dev/null 2>&1 || ! command -v node >/dev/null 2>&1; then
        echo "unknown"
        return 2
    fi
    if ! service_json="$(ubus call service list '{"name":"node-red"}' 2>/dev/null)"; then
        echo "unknown"
        return 2
    fi

    printf '%s' "$service_json" | node -e '
let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { raw += chunk; });
process.stdin.on("end", () => {
    try {
        const response = JSON.parse(raw);
        const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
        if (!isObject(response)) {
            console.log("unknown");
            process.exitCode = 2;
            return;
        }
        if (!Object.prototype.hasOwnProperty.call(response, "node-red")) {
            console.log("stopped");
            return;
        }
        const service = response["node-red"];
        if (!isObject(service) || !isObject(service.instances)) {
            console.log("unknown");
            process.exitCode = 2;
            return;
        }
        const instances = Object.values(service.instances);
        if (instances.some((instance) => instance && instance.running === true)) {
            console.log("running");
            return;
        }
        if (instances.length === 0 || instances.every((instance) => instance && instance.running === false)) {
            console.log("stopped");
            return;
        }
        console.log("unknown");
        process.exitCode = 2;
    } catch (_) {
        console.log("unknown");
        process.exitCode = 2;
    }
});
'
}
# node-red service state end

# node-red stop wait begin
wait_for_node_red_stop() {
    local stop_timeout="$1"
    stop_wait=0
    node_red_state="unknown"

    while :; do
        if ! node_red_state="$(node_red_service_state)"; then
            return 2
        fi
        [ "$node_red_state" = "running" ] || break
        [ "$stop_wait" -lt "$stop_timeout" ] || return 1
        sleep 1
        stop_wait=$((stop_wait + 1))
    done
    [ "$node_red_state" = "stopped" ]
}
# node-red stop wait end

# node-red health wait begin
wait_for_node_red_health() {
    local health_timeout="$1"
    probe_elapsed=0
    node_red_state="unknown"

    while [ "$probe_elapsed" -lt "$health_timeout" ]; do
        if ! node_red_state="$(node_red_service_state)"; then
            return 2
        fi
        if [ "$node_red_state" = "running" ] && \
            wget -q -O /dev/null --spider "http://127.0.0.1:1880/gui" 2>/dev/null; then
            return 0
        fi
        sleep 1
        probe_elapsed=$((probe_elapsed + 1))
    done
    return 1
}
# node-red health wait end

# deploy payload lifecycle begin
hold_node_red_stopped() {
    "$NODE_RED_INIT" stop || true
    if wait_for_node_red_stop "${NODE_RED_STOP_TIMEOUT:-30}"; then
        node_red_restart_needed=0
        return 0
    fi
    node_red_restart_needed=0
    return 1
}

schema_compatibility_metadata() {
    if schema_compatibility_metadata_raw="$(sqlite3 "$DB_PATH" "SELECT COALESCE((SELECT MAX(version) FROM schema_migrations WHERE status='applied'),0) || '|' || COALESCE((SELECT group_concat(version || ':' || checksum, ',') FROM (SELECT version, checksum FROM schema_migrations WHERE status='applied' ORDER BY version)), '')" 2>/dev/null)"; then
        printf '%s\n' "$schema_compatibility_metadata_raw"
        return 0
    fi
    if sqlite3 "$DB_PATH" "SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations' LIMIT 1;" 2>/dev/null | grep -qx '1'; then
        echo "ERROR: could not read schema_migrations compatibility metadata" >&2
        return 1
    fi
    echo '0|'
}

write_payload_compatibility() {
    compatibility_stamp="$1"
    if ! compatibility_metadata="$(schema_compatibility_metadata)"; then
        return 1
    fi
    compatibility_head="${compatibility_metadata%%|*}"
    compatibility_ledger="${compatibility_metadata#*|}"
    if ! swap_call writeCompatibility "$compatibility_stamp" "$compatibility_head" "$compatibility_ledger" >/dev/null; then
        echo "ERROR: could not record schema compatibility for payload $compatibility_stamp" >&2
        return 1
    fi
}

verify_payload_db_compatibility() {
    compatibility_stamp="$1"
    compatibility_mode="${2:-full}"
    if ! swap_call verifyPair "$compatibility_stamp" >/dev/null; then
        echo "ERROR: retained payload $compatibility_stamp is missing a complete flows+GUI pair" >&2
        return 1
    fi
    if ! compatibility_metadata="$(schema_compatibility_metadata)"; then
        echo "ERROR: could not read migrated database compatibility metadata" >&2
        return 1
    fi
    compatibility_head="${compatibility_metadata%%|*}"
    compatibility_ledger="${compatibility_metadata#*|}"
    if ! swap_call verifyCompatibility "$compatibility_stamp" "$compatibility_head" "$compatibility_ledger" >/dev/null; then
        echo "ERROR: retained payload $compatibility_stamp was recorded for a different schema head/ledger" >&2
        return 1
    fi
    if [ "$compatibility_mode" = "full" ]; then
        if ! node "$TMP_DIR/scripts/verify-head-cli.js" "$DB_PATH" --migrations-dir "$migrations_dir" >/dev/null; then
            echo "ERROR: retained payload $compatibility_stamp was not proven compatible with the migrated database" >&2
            return 1
        fi
    elif [ "$compatibility_mode" != "retained" ]; then
        echo "ERROR: unknown payload compatibility verification mode: $compatibility_mode" >&2
        return 1
    fi
    return 0
}
cleanup_failed_first_payload() {
    [ -n "${DEPLOY_STAMP:-}" ] || return 0
    echo "--- Clean up failed first payload activation ---"
    if hold_node_red_stopped; then
        echo "OK: Node-RED stopped before removing the first-deploy payload"
    else
        echo "ERROR: could not prove Node-RED stopped while cleaning up the first-deploy payload" >&2
    fi
    swap_call deactivate "$DEPLOY_STAMP" "$GUI_ROOT" >/dev/null || true
    swap_call discardPayload "$DEPLOY_STAMP" >/dev/null || true
    PAYLOAD_FLIPPED=0
    node_red_restart_needed=0
    echo "OK: first-deploy flows+GUI payload removed; Node-RED restart suppressed"
}
# deploy payload lifecycle end

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
        semantic-schema-compare.js \
        restamp-fingerprints.js \
        verify-head-cli.js \
        verify-runtime-schema-parity.js
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
    MIGRATION_RUNNER_AVAILABLE=1
}

# Fetched lazily — only when run_schema_migration's own cheap checksum probe
# (below) finds a foreign-numbered ledger — so a normal main-numbered deploy
# never pulls this extra payload. Depends on scripts/migrate-cli.js,
# scripts/baseline-existing-db.js, scripts/semantic-schema-compare.js, and
# lib/osi-migrate/*, all already fetched by fetch_migration_runner above.
fetch_reconciliation_assets() {
    fetch_required "Ledger numbering reconciliation tool" \
        "scripts/reconcile-ledger-numbering.js" \
        "$TMP_DIR/scripts/reconcile-ledger-numbering.js"

    lineage_fixtures_dir="$TMP_DIR/scripts/fixtures/lineages"
    mkdir -p "$lineage_fixtures_dir"
    for lineage in agrolink bovey; do
        mkdir -p "$lineage_fixtures_dir/$lineage"
        fetch_required "Lineage fixture manifest ($lineage)" \
            "scripts/fixtures/lineages/$lineage/CHECKSUMS.json" \
            "$lineage_fixtures_dir/$lineage/CHECKSUMS.json"
        for fixture in $(node -e "const fs=require('fs'); const manifest=JSON.parse(fs.readFileSync(process.argv[1], 'utf8')); for (const name of Object.keys(manifest).sort()) console.log(name);" "$lineage_fixtures_dir/$lineage/CHECKSUMS.json"); do
            fetch_required "Lineage fixture $lineage/$fixture" \
                "scripts/fixtures/lineages/$lineage/$fixture" \
                "$lineage_fixtures_dir/$lineage/$fixture"
        done
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

    # Best-effort self-heal prune BEFORE the disk gate below: an already-full
    # machine may have accumulated .premigrate- backups from prior deploys.
    # --prune-only touches only backup FILES in backup_dir, never the DB, so
    # it is safe to run with Node-RED still up. A prune failure must not
    # block deploy.
    node "$TMP_DIR/scripts/migrate-cli.js" "$DB_PATH" --backup-dir "$backup_dir" --prune-only || true

    # Disk preflight (fail-fast, leaves Node-RED running): refuse to start a
    # migration that cannot safely complete (fresh backup + in-place apply)
    # for lack of free space. BusyBox has no `stat`; use O(1) `ls -ln` for
    # size instead of `wc -c`.
    db_bytes=$(ls -ln "$DB_PATH" | awk '{print $5}')
    if [ -e "$DB_PATH-wal" ]; then
        wal_bytes=$(ls -ln "$DB_PATH-wal" | awk '{print $5}')
        db_bytes=$((db_bytes + wal_bytes))
    fi
    # BusyBox `df` wraps long device names onto their own line, pushing every
    # field right by one; Available is the 3rd-from-last field, NOT $4 (same
    # wrap-safe idiom as the mount-point comparison at deploy.sh:82-83).
    avail_kb=$(df -k "$backup_dir" | tail -1 | awk '{print $(NF-2)}')
    db_kb=$(( (db_bytes + 1023) / 1024 ))
    margin_mb="${MIGRATE_MIN_FREE_MARGIN_MB:-128}"
    req_kb=$(( 2 * db_kb + margin_mb * 1024 ))
    case "$avail_kb" in
        ''|*[!0-9]*)
            echo "WARNING: could not parse available disk space for $backup_dir; proceeding without a disk preflight gate" >&2
            ;;
        *)
            if [ "$avail_kb" -lt "$req_kb" ]; then
                echo "ERROR: insufficient disk for a safe schema migration on $backup_dir: need ~${req_kb}KB, have ${avail_kb}KB" >&2
                echo "Free space (prune old $backup_dir/*.premigrate-*, /data/db/backups/*, check DB growth/logs) and re-deploy" >&2
                return 1
            fi
            ;;
    esac

    if [ -n "${PREV_STAMP:-}" ]; then
        if [ "${PREV_CAPTURED:-0}" = "1" ]; then
            if ! write_payload_compatibility "$PREV_STAMP"; then
                echo "ERROR: could not record the retained payload's pre-migration schema compatibility" >&2
                return 1
            fi
        elif ! swap_call compatibilityExists "$PREV_STAMP" >/dev/null; then
            echo "ERROR: retained payload $PREV_STAMP has no immutable schema compatibility metadata; refusing migration" >&2
            return 1
        fi
    fi

    node_red_restart_needed=1

    echo "--- Stop Node-RED for schema migration ---"
    if /etc/init.d/node-red stop; then
        echo "OK"
    else
        echo "ERROR: failed to stop Node-RED before schema migration" >&2
        return 1
    fi
    NODE_RED_STOP_TIMEOUT="${NODE_RED_STOP_TIMEOUT:-30}"
    case "$NODE_RED_STOP_TIMEOUT" in
        ''|*[!0-9]*|0) NODE_RED_STOP_TIMEOUT=30 ;;
    esac
    if wait_for_node_red_stop "$NODE_RED_STOP_TIMEOUT"; then
        :
    else
        stop_wait_rc=$?
        if [ "$stop_wait_rc" = "1" ]; then
            echo "ERROR: Node-RED service did not stop within ${NODE_RED_STOP_TIMEOUT}s; refusing schema migration" >&2
        else
            echo "ERROR: could not determine Node-RED service state after stop; refusing schema migration" >&2
        fi
        return 1
    fi

    if ! checkpoint_live_db; then
        return 1
    fi
    # Everything from here to the matching "# schema decision end" marker is
    # the schema decision itself: which ledger path this database takes, and
    # the apply/verify that follows. scripts/test-deploy-fresh-install.js
    # extracts this exact fragment and runs it with real sqlite3 and real
    # node against a temp DB_DIR, the same way
    # scripts/test-deploy-reconcile-probe.js runs the nested probe fragment,
    # so the fresh-install path is covered by the shipped shell text rather
    # than a JS re-implementation of it. Keep the markers on their own lines.
    # schema decision begin
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

        # Foreign-numbered ledger detection (osi-os stabilization plan §3.5c):
        # a device that ran the AgroLink or Bovey/Valve-focused line has
        # schema_migrations rows whose version numbers collide with main's
        # own (e.g. v22 is journal_catalog_v2 there, valve_control on main).
        #
        # A cheap, read-only probe compares EVERY applied ledger row above
        # the shared 0001-0021 prefix against main's own checksum for that
        # SAME version number, and decides to reconcile at the FIRST
        # mismatch. This used to compare only MIN(version) WHERE version >
        # 21 against main's checksum for that one row — but a lineage whose
        # early foreign-numbered versions happen to be byte-identical to
        # main's own migrations at those same numbers slips straight past a
        # single-row probe (osi-os stabilization program, PR-L / external
        # consult Q1, 2026-09-16: Bovey's 0022-0024 collide with AND
        # byte-match main; only 0025's header-comment-only checksum
        # differs). That gateway's deploy never ran reconciliation and
        # lib/osi-migrate/runner.js later refused applyPending with
        # repair_required at version 25.
        #
        # A main-numbered gateway's checksums already agree at every row, so
        # it still falls straight through this block untouched (the fast
        # path): ONE read-only sqlite3 query for the whole ledger, and ONE
        # node invocation that loads the manifest once and returns as soon
        # as it finds a mismatch (empty output = none found).
        # reconcile probe begin
        recon_ledger_rows="$(sqlite3 "$DB_PATH" "SELECT version, checksum FROM schema_migrations WHERE version > 21 ORDER BY version;")"
        recon_probe_version="$(printf '%s\n' "$recon_ledger_rows" | node -e "const fs=require('fs'); const manifest=JSON.parse(fs.readFileSync(process.argv[1], 'utf8')); const lines=fs.readFileSync(0, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean); for (const line of lines) { const sep=line.indexOf('|'); if (sep===-1) continue; const version=line.slice(0, sep); const ledgerChecksum=line.slice(sep + 1); const padded=String(Number(version)).padStart(4,'0'); const name=Object.keys(manifest).find((n) => n.startsWith(padded + '__')); const mainChecksum=name ? manifest[name] : ''; if (mainChecksum && mainChecksum !== ledgerChecksum) { process.stdout.write(version); process.exit(0); } }" "$migrations_dir/CHECKSUMS.json")"
        # reconcile probe end
        if [ -n "$recon_probe_version" ]; then
            echo "--- Foreign-numbered schema_migrations ledger detected (v$recon_probe_version checksum mismatch vs main); running ledger numbering reconciliation ---"
            fetch_reconciliation_assets
            if ! node "$TMP_DIR/scripts/reconcile-ledger-numbering.js" "$DB_PATH" \
                --migrations-dir "$migrations_dir" \
                --fixtures-dir "$TMP_DIR/scripts/fixtures/lineages" \
                --backup-dir "$backup_dir" \
                --apply
            then
                echo "ERROR: ledger numbering reconciliation refused or failed; aborting schema migration" >&2
                return 1
            fi
            echo "OK: ledger numbering reconciliation applied"
        fi
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
        DB_MIGRATION_COMMITTED=1
        # osi-os stabilization program, PR-L / external consult Q1: verify the
        # post-migration ledger AND schema fingerprints agree with what main
        # expects, BEFORE flipping to the new flows payload or restarting
        # Node-RED. applyPending (above) validates each migration's checksum
        # as it applies it, but not the broader ledger-vs-manifest and
        # fingerprint-vs-live-schema agreement verifyHead checks; a ledger
        # that reconciled cleanly but a schema that still drifts from what
        # main's boot node expects must not proceed to a live restart.
        if ! node "$TMP_DIR/scripts/verify-head-cli.js" "$DB_PATH" --migrations-dir "$migrations_dir"; then
            echo "ERROR: verify-head-cli reported a non-ok ledger/schema-fingerprint state after migration; aborting before the payload flip" >&2
            return 1
        fi
        echo "OK: verify-head-cli confirmed the post-migration ledger and schema fingerprints"

        if ! write_payload_compatibility "$DEPLOY_STAMP"; then
            echo "ERROR: could not record the new payload's schema compatibility; leaving services stopped" >&2
            node_red_restart_needed=0
            return 1
        fi

        # issue #222 / F4 (Uganda 2026-09-12): flip the staged payload BEFORE
        # restarting Node-RED. This restart used to run immediately after a
        # successful migration while the new flows.json was still only
        # staged (the flip was deferred to the later health-check block far
        # below) — so it ran the PREVIOUS release's boot node against the
        # JUST-migrated schema. On Uganda that boot node's unfenced `devices`
        # rebuild cascade-deleted all of `device_data`. Flipping first means
        # any restart from this point on always runs the migration-target
        # flows against the schema it was migrated for.
        if [ "$PAYLOAD_FLIPPED" != "1" ]; then
            echo "--- Activate paired flows+GUI payload before Node-RED restart ---"
            if [ ! -d "$PAYLOADS_ROOT/$DEPLOY_STAMP" ]; then
                echo "ERROR: staged paired payload is missing; leaving Node-RED stopped" >&2
                node_red_restart_needed=0
                return 1
            fi
            if ! swap_call flipTo "$DEPLOY_STAMP" "$GUI_ROOT" >/dev/null; then
                echo "ERROR: paired payload activation failed; leaving Node-RED stopped" >&2
                node_red_restart_needed=0
                return 1
            fi
            PAYLOAD_FLIPPED=1
            echo "OK: activated flows+GUI payloads/$DEPLOY_STAMP"
        fi
        NODE_RED_LOG_MARK=0
        if command -v logread >/dev/null 2>&1; then
            NODE_RED_LOG_MARK="$(logread 2>/dev/null | wc -l)"
            case "$NODE_RED_LOG_MARK" in ''|*[!0-9]*) NODE_RED_LOG_MARK=0 ;; esac
        fi
        if ! restart_node_red; then
            return 1
        fi
        echo "OK"
        return 0
    else
        migration_rc=$?
    fi
    # schema decision end

    if [ "$migration_rc" = "3" ]; then
        node_red_restart_needed=0
        identityd_deploy_state="fatal_hold"
        echo "ERROR: migration failed and backup restore integrity check failed; leaving Node-RED and identityd stopped" >&2
        return 1
    fi
    echo "ERROR: schema migration failed; Node-RED will be restarted before deploy exits" >&2
    return 1
}

echo "=== OSI OS Deploy ==="
echo "Source: $BASE"

run_communication_preflight
run_native_sqlite3_preflight || exit 1

fetch_required "Node-RED settings.js" \
    "feeds/chirpstack-openwrt-feed/apps/node-red/files/settings.js" \
    "/srv/node-red/settings.js"

fetch_required "Node-RED init script" \
    "feeds/chirpstack-openwrt-feed/apps/node-red/files/node-red.init" \
    "/etc/init.d/node-red"
chmod 755 /etc/init.d/node-red
ensure_journal_media_defaults

fetch_required "Gateway identity helper" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/libexec/osi-gateway-identity.sh" \
    "/usr/libexec/osi-gateway-identity.sh"
chmod 755 /usr/libexec/osi-gateway-identity.sh

fetch_required "Gateway identity daemon" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/libexec/osi-identityd.sh" \
    "/usr/libexec/osi-identityd.sh"
chmod 755 /usr/libexec/osi-identityd.sh

fetch_required "Gateway identity service" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/init.d/osi-identityd" \
    "/etc/init.d/osi-identityd"
chmod 755 /etc/init.d/osi-identityd

fetch_required "Gateway identity service enable script" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/uci-defaults/94_osi_identityd_enable" \
    "/etc/uci-defaults/94_osi_identityd_enable"
chmod 755 /etc/uci-defaults/94_osi_identityd_enable

fetch_required "ChirpStack bootstrap service" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/init.d/osi-bootstrap" \
    "/etc/init.d/osi-bootstrap"
chmod 755 /etc/init.d/osi-bootstrap

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

echo "--- flows.json + React GUI (staged payload; activation deferred to migration) ---"
STAGED_FLOWS="$TMP_DIR/flows.json"
fetch "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json" "$STAGED_FLOWS"
STAGED_GUI_ARCHIVE="$TMP_DIR/react_gui.tar.gz"
STAGED_GUI="$TMP_DIR/gui"
fetch "react_gui.tar.gz" "$TMP_DIR/react_gui.tar.gz"
mkdir -p "$STAGED_GUI"
tar xzf "$TMP_DIR/react_gui.tar.gz" -C "$STAGED_GUI"
swap_call stagePayload "$DEPLOY_STAMP" "$STAGED_FLOWS" "$STAGED_GUI" >/dev/null
PREV_STAMP="$(swap_call currentStamp || true)"
PREV_GUI_STAMP="$(swap_call guiStamp "$GUI_ROOT" || true)"
# legacy payload capture begin
if [ -n "${PREV_STAMP:-}" ] && [ ! -d "$GUI_ROOT" ]; then
    echo "WARN: existing flows have no GUI directory; skipping retained-pair capture"
    PREV_STAMP=""
    PREV_GUI_STAMP=""
fi
if { [ -z "${PREV_STAMP:-}" ] || [ "$PREV_GUI_STAMP" != "$PREV_STAMP" ]; } && [ -f /srv/node-red/flows.json ] && [ -d "$GUI_ROOT" ]; then
    if PREV_LEGACY_STAMP="$(swap_call legacyCaptureStamp "/srv/node-red/flows.json" "$GUI_ROOT")"; then
        if [ -n "$PREV_LEGACY_STAMP" ]; then
            PREV_STAMP="$PREV_LEGACY_STAMP"
            PREV_CAPTURED=0
            echo "OK: reused immutable legacy flows+GUI capture payloads/$PREV_STAMP"
        else
            PREV_STAMP="${DEPLOY_STAMP}-previous"
            swap_call captureExisting "$PREV_STAMP" "/srv/node-red/flows.json" "$GUI_ROOT" >/dev/null
            PREV_CAPTURED=1
            echo "OK: captured existing flows+GUI pair as payloads/$PREV_STAMP"
        fi
    else
        echo "ERROR: legacy flows+GUI evidence is missing or changed; refusing recapture" >&2
        exit 1
    fi
fi
# legacy payload capture end
if [ -n "${PREV_STAMP:-}" ]; then
    swap_call captureGui "$PREV_STAMP" "$GUI_ROOT" >/dev/null
fi
echo "OK: staged paired payloads/$DEPLOY_STAMP (current: ${PREV_STAMP:-none}; activation deferred)"

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

fetch_required "osi-scope-helper package.json" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-scope-helper/package.json" \
    "/srv/node-red/osi-scope-helper/package.json"

fetch_required "osi-scope-helper index.js" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-scope-helper/index.js" \
    "/srv/node-red/osi-scope-helper/index.js"

fetch_required "osi-scoped-access-commands package.json" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-scoped-access-commands/package.json" \
    "/srv/node-red/osi-scoped-access-commands/package.json"

fetch_required "osi-scoped-access-commands index.js" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-scoped-access-commands/index.js" \
    "/srv/node-red/osi-scoped-access-commands/index.js"

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

fetch_required "osi-journal package.json" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-journal/package.json" \
    "/srv/node-red/osi-journal/package.json"

fetch_required "osi-journal index.js" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-journal/index.js" \
    "/srv/node-red/osi-journal/index.js"

fetch_required "osi-journal catalog.js" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-journal/catalog.js" \
    "/srv/node-red/osi-journal/catalog.js"

fetch_required "osi-journal definition.js" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-journal/definition.js" \
    "/srv/node-red/osi-journal/definition.js"

fetch_required "osi-journal units.js" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-journal/units.js" \
    "/srv/node-red/osi-journal/units.js"

fetch_required "osi-journal unit-family.js" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-journal/unit-family.js" \
    "/srv/node-red/osi-journal/unit-family.js"

fetch_required "osi-journal cascade.js" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-journal/cascade.js" \
    "/srv/node-red/osi-journal/cascade.js"

fetch_required "osi-journal aggregate.js" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-journal/aggregate.js" \
    "/srv/node-red/osi-journal/aggregate.js"

fetch_required "osi-journal context.js" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-journal/context.js" \
    "/srv/node-red/osi-journal/context.js"

fetch_required "osi-journal lifecycle.js" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-journal/lifecycle.js" \
    "/srv/node-red/osi-journal/lifecycle.js"

fetch_required "osi-journal api.js" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-journal/api.js" \
    "/srv/node-red/osi-journal/api.js"

fetch_required "osi-journal commands.js" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-journal/commands.js" \
    "/srv/node-red/osi-journal/commands.js"

# osi-module-defaults declares the four switchable gateway modules (key, GUI
# field, shipped default) that both osi-journal-replication and
# osi-system-settings require. Fetched before them so a half-applied deploy
# cannot leave a consumer requiring a file that is not there yet.
fetch_required "osi-module-defaults package.json" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-module-defaults/package.json" \
    "/srv/node-red/osi-module-defaults/package.json"

fetch_required "osi-module-defaults index.js" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-module-defaults/index.js" \
    "/srv/node-red/osi-module-defaults/index.js"

fetch_required "osi-journal-replication package.json" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-journal-replication/package.json" \
    "/srv/node-red/osi-journal-replication/package.json"

fetch_required "osi-journal-replication index.js" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-journal-replication/index.js" \
    "/srv/node-red/osi-journal-replication/index.js"

fetch_required "osi-journal-replication canonicalization.js" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-journal-replication/canonicalization.js" \
    "/srv/node-red/osi-journal-replication/canonicalization.js"

fetch_required "osi-command-ledger package.json" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-command-ledger/package.json" \
    "/srv/node-red/osi-command-ledger/package.json"

fetch_required "osi-command-ledger index.js" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-command-ledger/index.js" \
    "/srv/node-red/osi-command-ledger/index.js"

fetch_required "osi-zone-commands package.json" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-zone-commands/package.json" \
    "/srv/node-red/osi-zone-commands/package.json"

fetch_required "osi-zone-commands index.js" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-zone-commands/index.js" \
    "/srv/node-red/osi-zone-commands/index.js"

fetch_required "osi-device-commands package.json" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-device-commands/package.json" \
    "/srv/node-red/osi-device-commands/package.json"

fetch_required "osi-device-commands index.js" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-device-commands/index.js" \
    "/srv/node-red/osi-device-commands/index.js"

fetch_required "osi-device-commands weather.js" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-device-commands/weather.js" \
    "/srv/node-red/osi-device-commands/weather.js"

fetch_required "osi-entity-name package.json" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-entity-name/package.json" \
    "/srv/node-red/osi-entity-name/package.json"

fetch_required "osi-entity-name index.js" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-entity-name/index.js" \
    "/srv/node-red/osi-entity-name/index.js"

fetch_required "osi-entity-name commands.js" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-entity-name/commands.js" \
    "/srv/node-red/osi-entity-name/commands.js"

fetch_required "osi-radio-helper chirpstack.js" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-radio-helper/chirpstack.js" \
    "/srv/node-red/osi-radio-helper/chirpstack.js"

fetch_required "osi-radio-helper index.js" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-radio-helper/index.js" \
    "/srv/node-red/osi-radio-helper/index.js"

fetch_required "osi-radio-helper migrations/0001__radio_store.sql" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-radio-helper/migrations/0001__radio_store.sql" \
    "/srv/node-red/osi-radio-helper/migrations/0001__radio_store.sql"

fetch_required "osi-radio-helper migrations/0002__radio_store_ledger.sql" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-radio-helper/migrations/0002__radio_store_ledger.sql" \
    "/srv/node-red/osi-radio-helper/migrations/0002__radio_store_ledger.sql"

fetch_required "osi-radio-helper normalize.js" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-radio-helper/normalize.js" \
    "/srv/node-red/osi-radio-helper/normalize.js"

fetch_required "osi-network-api package.json" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-network-api/package.json" \
    "/srv/node-red/osi-network-api/package.json"

fetch_required "osi-network-api index.js" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-network-api/index.js" \
    "/srv/node-red/osi-network-api/index.js"

fetch_required "osi-radio-helper package.json" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-radio-helper/package.json" \
    "/srv/node-red/osi-radio-helper/package.json"

fetch_required "osi-radio-helper store.js" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-radio-helper/store.js" \
    "/srv/node-red/osi-radio-helper/store.js"

fetch_required "osi-installation-location-helper commands.js" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-installation-location-helper/commands.js" \
    "/srv/node-red/osi-installation-location-helper/commands.js"

fetch_required "osi-installation-location-helper package.json" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-installation-location-helper/package.json" \
    "/srv/node-red/osi-installation-location-helper/package.json"

fetch_required "osi-installation-location-helper index.js" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-installation-location-helper/index.js" \
    "/srv/node-red/osi-installation-location-helper/index.js"

fetch_required "osi-history-sync-helper package.json" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-sync-helper/package.json" \
    "/srv/node-red/osi-history-sync-helper/package.json"

fetch_required "osi-history-sync-helper index.js" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-sync-helper/index.js" \
    "/srv/node-red/osi-history-sync-helper/index.js"

fetch_required "osi-installation-helper package.json" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-installation-helper/package.json" \
    "/srv/node-red/osi-installation-helper/package.json"

fetch_required "osi-installation-helper index.js" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-installation-helper/index.js" \
    "/srv/node-red/osi-installation-helper/index.js"

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

fetch_required "osi-lsn50-normalize package.json" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-lsn50-normalize/package.json" \
    "/srv/node-red/osi-lsn50-normalize/package.json"

fetch_required "osi-lsn50-normalize index.js" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-lsn50-normalize/index.js" \
    "/srv/node-red/osi-lsn50-normalize/index.js"

fetch_required "osi-uc512-normalize package.json" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-uc512-normalize/package.json" \
    "/srv/node-red/osi-uc512-normalize/package.json"

fetch_required "osi-uc512-normalize index.js" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-uc512-normalize/index.js" \
    "/srv/node-red/osi-uc512-normalize/index.js"

fetch_required "osi-uplink-dedup-guard package.json" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-uplink-dedup-guard/package.json" \
    "/srv/node-red/osi-uplink-dedup-guard/package.json"

fetch_required "osi-uplink-dedup-guard index.js" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-uplink-dedup-guard/index.js" \
    "/srv/node-red/osi-uplink-dedup-guard/index.js"

fetch_required "osi-sdi12-normalize package.json" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-sdi12-normalize/package.json" \
    "/srv/node-red/osi-sdi12-normalize/package.json"

fetch_required "osi-sdi12-normalize index.js" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-sdi12-normalize/index.js" \
    "/srv/node-red/osi-sdi12-normalize/index.js"

fetch_required "osi-sdi12-recipe package.json" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-sdi12-recipe/package.json" \
    "/srv/node-red/osi-sdi12-recipe/package.json"

fetch_required "osi-sdi12-recipe index.js" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-sdi12-recipe/index.js" \
    "/srv/node-red/osi-sdi12-recipe/index.js"

fetch_required "osi-sdi12-commissioning package.json" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-sdi12-commissioning/package.json" \
    "/srv/node-red/osi-sdi12-commissioning/package.json"

fetch_required "osi-sdi12-commissioning index.js" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-sdi12-commissioning/index.js" \
    "/srv/node-red/osi-sdi12-commissioning/index.js"

fetch_required "osi-sdi12-reassemble package.json" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-sdi12-reassemble/package.json" \
    "/srv/node-red/osi-sdi12-reassemble/package.json"

fetch_required "osi-sdi12-reassemble index.js" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-sdi12-reassemble/index.js" \
    "/srv/node-red/osi-sdi12-reassemble/index.js"

fetch_required "osi-valve-control package.json" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-valve-control/package.json" \
    "/srv/node-red/osi-valve-control/package.json"

fetch_required "osi-valve-control index.js" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-valve-control/index.js" \
    "/srv/node-red/osi-valve-control/index.js"

fetch_required "osi-valve-control plan.js" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-valve-control/plan.js" \
    "/srv/node-red/osi-valve-control/plan.js"

fetch_required "osi-valve-control ack.js" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-valve-control/ack.js" \
    "/srv/node-red/osi-valve-control/ack.js"

fetch_required "osi-valve-control store.js" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-valve-control/store.js" \
    "/srv/node-red/osi-valve-control/store.js"

fetch_required "osi-valve-control push.js" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-valve-control/push.js" \
    "/srv/node-red/osi-valve-control/push.js"

fetch_required "osi-valve-control api.js" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-valve-control/api.js" \
    "/srv/node-red/osi-valve-control/api.js"

fetch_required "osi-valve-control workers.js" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-valve-control/workers.js" \
    "/srv/node-red/osi-valve-control/workers.js"

# index.js require()s this at module load, so a gateway without it fails to load
# osi-valve-control ENTIRELY -- schedules, pushes and ACKs, not just the cloud
# commands it serves. verify-helper-registration.js does not catch intra-module
# files, only whole modules.
fetch_required "osi-valve-control cloud-commands.js" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-valve-control/cloud-commands.js" \
    "/srv/node-red/osi-valve-control/cloud-commands.js"

# cloud-commands.js require()s this at module load (CANCEL_VALVE_ACTUATION applier), and
# the "Cancel STREGA Actuation" HTTP route delegates to it too -- same missing-file failure
# mode as cloud-commands.js above.
fetch_required "osi-valve-control cancel.js" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-valve-control/cancel.js" \
    "/srv/node-red/osi-valve-control/cancel.js"

# index.js require()s this at module load too -- same missing-file failure mode as
# cloud-commands.js and cancel.js above: a gateway without it fails to load
# osi-valve-control ENTIRELY.
fetch_required "osi-valve-control runtime.js" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-valve-control/runtime.js" \
    "/srv/node-red/osi-valve-control/runtime.js"

# index.js require()s this at module load as well (the device-unclaim plan clearing, F104)
# -- same missing-file failure mode again. Without it a gateway keeps the old behaviour of
# leaving an unclaimed valve's weekly plan running inside the valve, but only after failing
# to load osi-valve-control at all.
fetch_required "osi-valve-control unclaim.js" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-valve-control/unclaim.js" \
    "/srv/node-red/osi-valve-control/unclaim.js"

fetch_required "osi-system-settings package.json" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-system-settings/package.json" \
    "/srv/node-red/osi-system-settings/package.json"

fetch_required "osi-system-settings index.js" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-system-settings/index.js" \
    "/srv/node-red/osi-system-settings/index.js"

fetch_required "osi-system-settings api.js" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-system-settings/api.js" \
    "/srv/node-red/osi-system-settings/api.js"

fetch_required "edge-channels.json" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/edge-channels.json" \
    "/srv/node-red/edge-channels.json"

fetch_required "chirpstack-bootstrap.js" \
    "scripts/chirpstack-bootstrap.js" \
    "/srv/node-red/chirpstack-bootstrap.js"

fetch_required "STREGA codec" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/codecs/strega_gen1_decoder.js" \
    "/srv/node-red/codecs/strega_gen1_decoder.js"

fetch_required "STREGA Gen2 codec" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/codecs/strega_gen2_decoder.js" \
    "/srv/node-red/codecs/strega_gen2_decoder.js"

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

fetch_required "SDI12 codec" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/codecs/dragino_sdi12_decoder.js" \
    "/srv/node-red/codecs/dragino_sdi12_decoder.js"

fetch_required "Agroscope uplink transform" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/codecs/agroscope_uplink_transform.js" \
    "/srv/node-red/codecs/agroscope_uplink_transform.js"

if [ -f /srv/node-red/.chirpstack.env ] && \
   ! grep -q 'CHIRPSTACK_PROFILE_STREGA_GEN2=' /srv/node-red/.chirpstack.env 2>/dev/null; then
    echo "--- Provisioning STREGA Gen2 device profile (one-time) ---"
    # Reuse the gateway's existing osi-nodered token; bootstrap only calls
    # `chirpstack create-api-key` when CHIRPSTACK_API_KEY is empty, so this
    # avoids leaving a second admin key behind. Empty value = old behaviour.
    cs_api_key="$(sed -n 's/^CHIRPSTACK_API_KEY=//p' /srv/node-red/.chirpstack.env | head -1 | tr -d '\r')"
    # bootstrap rewrites .chirpstack.env wholesale with only the CHIRPSTACK_* keys
    # it manages, so any operator-added line (AGROSCOPE_*, LOG_*, ...) is dropped.
    # Keep a copy and restore the non-CHIRPSTACK lines afterwards.
    cs_env_backup="/srv/node-red/.chirpstack.env.pre-gen2"
    cp /srv/node-red/.chirpstack.env "$cs_env_backup" || {
        echo "ERROR: could not back up .chirpstack.env; skipping Gen2 provisioning"
        cs_env_backup=""
    }
    if [ -n "$cs_env_backup" ]; then
        if CHIRPSTACK_API_KEY="$cs_api_key" node /srv/node-red/chirpstack-bootstrap.js; then
            echo "OK: Gen2 profile provisioned"
        else
            echo "WARN: Gen2 profile provisioning failed; valves will register on the Gen1 profile"
            echo "NOTE: pre-provisioning env backup kept at $cs_env_backup"
        fi
        # Restore unconditionally: bootstrap rewrites .chirpstack.env BEFORE its
        # last steps (writeUciConfig), so a late failure leaves the file already
        # stripped of operator keys -- including DEVICE_EUI. The loop is
        # idempotent, so running it after success or failure is equally safe.
        if [ -f /srv/node-red/.chirpstack.env ]; then
            while IFS= read -r cs_line || [ -n "$cs_line" ]; do
                case "$cs_line" in
                    ''|\#*) continue ;;
                esac
                cs_key="${cs_line%%=*}"
                [ "$cs_key" = "$cs_line" ] && continue
                if ! grep -q "^${cs_key}=" /srv/node-red/.chirpstack.env 2>/dev/null; then
                    echo "$cs_line" >> /srv/node-red/.chirpstack.env
                    echo "NOTE: restored env key ${cs_key} dropped by the bootstrap rewrite"
                fi
            done < "$cs_env_backup"
        fi
        chmod 600 "$cs_env_backup" 2>/dev/null || true
    fi
fi

materialize_native_sqlite3 || exit 1

echo "--- Node-RED runtime dependencies ---"
npm_log="$TMP_DIR/npm-install.log"
if cd /srv/node-red && npm install --omit=dev --no-fund --no-audit >"$npm_log" 2>&1; then
    tail -20 "$npm_log"
else
    tail -80 "$npm_log" >&2
    echo "ERROR: npm install failed" >&2
    exit 1
fi

verify_native_sqlite3_after_npm || exit 1

install_deploy_exit_trap
quiesce_identityd_for_deploy || exit 1
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

# osi-os stabilization program, PR-L / external consult Q1: a refused boot-node
# devices-CHECK rebuild does not stop Node-RED or its HTTP listener (it logs
# `node.error('devices rebuild ABORTED ...')` and carries on) -- so /gui
# reachability alone cannot prove schema initialization actually completed.
# Mark the log BEFORE the restart so only lines from THIS restart are
# considered; a stale abort from a much earlier boot must not fail a healthy
# deploy. Captured here, before the flip, since nothing between this point and
# the restart below touches logread -- the flip/no-op and restart must stay
# directly adjacent (issue #222 / F4).
if [ -z "$NODE_RED_LOG_MARK" ]; then
    NODE_RED_LOG_MARK=0
    if command -v logread >/dev/null 2>&1; then
        NODE_RED_LOG_MARK="$(logread 2>/dev/null | wc -l)"
        case "$NODE_RED_LOG_MARK" in ''|*[!0-9]*) NODE_RED_LOG_MARK=0 ;; esac
    fi
fi

if ! write_payload_compatibility "$DEPLOY_STAMP"; then
    echo "ERROR: could not record the payload's schema compatibility; refusing activation" >&2
    node_red_restart_needed=0
    exit 1
fi

PAYLOAD_WAS_FLIPPED="$PAYLOAD_FLIPPED"
if [ "$PAYLOAD_FLIPPED" != "1" ]; then
    if ! swap_call flipTo "$DEPLOY_STAMP" "$GUI_ROOT" >/dev/null; then
        echo "ERROR: paired payload activation failed; leaving Node-RED stopped" >&2
        node_red_restart_needed=0
        exit 1
    fi
    PAYLOAD_FLIPPED=1
    echo "OK: activated flows+GUI payloads/$DEPLOY_STAMP"
else
    echo "OK: paired payload already active -> payloads/$DEPLOY_STAMP (activated before the post-migration Node-RED restart)"
fi

if [ "$PAYLOAD_WAS_FLIPPED" != "1" ]; then
    /etc/init.d/node-red restart || true
else
    echo "OK: Node-RED already restarted on the activated pair during migration"
fi

# osi-os stabilization program, PR-L / external consult Q1 fix 2 (PR #242
# YELLOW should-fix): a single immediate grep here races the boot node it is
# meant to catch. /gui is served by Node-RED's static-file route as soon as
# the HTTP listener binds -- before flows finish deploying -- while
# sync-init-fn (the node that can log the abort, and now also logs a positive
# completion marker on success) is only triggered by the sync-init-inject
# inject node (onceDelay: 1s after flow deploy) and then runs a long async
# sequence of sqlite exec() calls before it can reach either branch. The old
# single grep, run the instant /gui answers, could observe neither line yet
# and would report PROBE_OK=0 (commit) regardless of what the boot node was
# about to decide -- exactly the false-negative this safety net exists to
# prevent (the Uganda cascade-delete incident this PR cites).
#
# Poll logread for up to NODE_RED_INIT_TIMEOUT seconds (default 45,
# env-overridable like NODE_RED_HEALTH_TIMEOUT above) for EITHER the positive
# "sync-init: schema init complete" marker (-> OK) OR the negative
# "devices rebuild ABORTED" line (-> PROBE_OK=1, ALERT). If the window
# elapses with neither line seen, fail closed: WARN that schema
# initialization could not be confirmed and set PROBE_OK=1 so the payload is
# NOT committed (the auto-rollback path below runs) -- an unconfirmed boot is
# treated as unhealthy, not healthy, on the theory that a false rollback is
# recoverable but a false commit of an aborted rebuild is not.
# init log check begin
PROBE_OK=1
if command -v logread >/dev/null 2>&1; then
    NODE_RED_INIT_TIMEOUT="${NODE_RED_INIT_TIMEOUT:-45}"
    case "$NODE_RED_INIT_TIMEOUT" in
        ''|*[!0-9]*|0) NODE_RED_INIT_TIMEOUT=45 ;;
    esac
    INIT_LOG_RESULT=""
    init_elapsed=0
    while [ "$init_elapsed" -lt "$NODE_RED_INIT_TIMEOUT" ]; do
        INIT_LOG_TAIL="$(logread 2>/dev/null | tail -n "+$((NODE_RED_LOG_MARK + 1))")"
        if printf '%s\n' "$INIT_LOG_TAIL" | grep -q "devices rebuild ABORTED"; then
            INIT_LOG_RESULT="ABORTED"
            break
        fi
        if printf '%s\n' "$INIT_LOG_TAIL" | grep -q "sync-init: schema init complete"; then
            INIT_LOG_RESULT="OK"
            break
        fi
        sleep 2
        init_elapsed=$((init_elapsed + 2))
    done
    case "$INIT_LOG_RESULT" in
        ABORTED)
            echo "ALERT: /gui is reachable but the boot node logged 'devices rebuild ABORTED' during this restart; schema initialization did not complete (PR-L / external consult Q1)" >&2
            PROBE_OK=1
            ;;
        OK)
            echo "OK: boot node confirmed 'sync-init: schema init complete' after ${init_elapsed}s"
            PROBE_OK=0
            ;;
        *)
            echo "WARN: schema initialization could not be confirmed via logread within ${NODE_RED_INIT_TIMEOUT}s (neither the completion marker nor an abort line was seen); failing closed - NOT committing this payload (PR #242 verifier fix 2)" >&2
            PROBE_OK=1
            ;;
    esac
else
    echo "WARN: logread is unavailable; schema initialization cannot be proven - failing closed" >&2
fi
# init log check end

NODE_RED_HEALTH_TIMEOUT="${NODE_RED_HEALTH_TIMEOUT:-30}"
case "$NODE_RED_HEALTH_TIMEOUT" in
    ''|*[!0-9]*|0) NODE_RED_HEALTH_TIMEOUT=30 ;;
esac
if [ "$PROBE_OK" = "0" ]; then
    if wait_for_node_red_health "$NODE_RED_HEALTH_TIMEOUT"; then
        echo "OK: local health self-check PASSED (Node-RED service running, /gui reachable after ${probe_elapsed}s)"
    else
        health_wait_rc=$?
        PROBE_OK=1
        if [ "$health_wait_rc" = "2" ]; then
            echo "ALERT: could not determine Node-RED service state during local health self-check" >&2
        fi
    fi
fi
if [ "$PROBE_OK" != "0" ] && [ -n "${node_red_state:-}" ]; then
    case "$node_red_state" in
        running) echo "WARN: Node-RED service is running but /gui was not reachable within ${NODE_RED_HEALTH_TIMEOUT}s" >&2 ;;
        stopped) echo "ALERT: Node-RED service is stopped after ${NODE_RED_HEALTH_TIMEOUT}s" >&2 ;;
        *) echo "ALERT: Node-RED service state is unknown; local health self-check failed closed" >&2 ;;
    esac
fi

if [ "$PROBE_OK" = "0" ]; then
    echo "OK: committing payload $DEPLOY_STAMP"
    swap_call clearLegacyCapture >/dev/null || true
    swap_call prunePayloads "$PAYLOAD_KEEP_N" >/dev/null
else
    echo "ALERT: local health self-check FAILED - AUTO-ROLLING-BACK the flows payload and paired GUI" >&2
    # payload rollback begin
    if [ -n "${PREV_STAMP:-}" ]; then
        if ! hold_node_red_stopped; then
            echo "ERROR: could not prove Node-RED stopped before rollback activation; leaving payload links unchanged" >&2
            exit 1
        fi
        rollback_verify_mode="full"
        if [ "${MIGRATION_RUNNER_AVAILABLE:-0}" != "1" ]; then
            rollback_verify_mode="retained"
        fi
        if ! verify_payload_db_compatibility "$PREV_STAMP" "$rollback_verify_mode"; then
            node_red_restart_needed=0
            echo "ERROR: refusing rollback restart because the retained payload/database pair was not proven compatible" >&2
            exit 1
        fi
        if ! swap_call flipTo "$PREV_STAMP" "$GUI_ROOT" >/dev/null; then
            echo "ERROR: retained paired payload activation failed; Node-RED remains stopped" >&2
            node_red_restart_needed=0
            exit 1
        fi
        if ! swap_call verifyPair "$PREV_STAMP" "$GUI_ROOT" >/dev/null; then
            node_red_restart_needed=0
            echo "ERROR: restored payload pair could not be verified after activation; Node-RED remains stopped" >&2
            exit 1
        fi
        if ! "$NODE_RED_INIT" restart; then
            node_red_restart_needed=0
            echo "ERROR: Node-RED failed to restart on the restored payload pair; leaving it stopped" >&2
            exit 1
        fi
        ROLLBACK_RESTORED=1
        PAYLOAD_FLIPPED=0
        echo "ROLLED BACK: flows+GUI -> payloads/$PREV_STAMP; Node-RED restarted on last-known-good pair" >&2
        echo "NOTE: any committed DB migration is NOT auto-undone (DD10); restore is an operator call via 1.B1 backup." >&2
        echo "NOTE: run deploy-canary-gate.js from your operator machine for the full cloud verdict." >&2
        exit 1
    fi
    # payload rollback end
    cleanup_failed_first_payload
    echo "ERROR: no previous payload to roll back to; first-deploy payload was removed and Node-RED remains stopped." >&2
    exit 1
fi

echo "--- Gateway identity supervisor ---"
if ! identityd_service enable; then
    echo "ERROR: failed to enable identityd" >&2
    exit 1
fi
identityd_service start
if ! wait_for_identityd_ready; then
    echo "ERROR: identityd did not become ready after activation" >&2
    exit 1
fi
identityd_deploy_state="disarmed"
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
