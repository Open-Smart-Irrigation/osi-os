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

cleanup() {
    rm -rf "$TMP_DIR"
}
trap cleanup EXIT INT TERM

mkdir -p "$TMP_DIR" /srv/node-red "$DB_DIR"

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

refresh_local_node_red_helpers() {
    echo "--- Node-RED local helpers ---"
    mkdir -p /srv/node-red/node_modules
    for module in osi-chameleon-helper \
                  osi-chirpstack-helper \
                  osi-cloud-http \
                  osi-db-helper \
                  osi-dendro-helper \
                  osi-history-helper; do
        if [ -d "/srv/node-red/$module" ]; then
            rm -rf "/srv/node-red/node_modules/$module"
            cp -a "/srv/node-red/$module" "/srv/node-red/node_modules/$module"
        fi
    done
    echo "OK"
}

validate_node_red_runtime_dependencies() {
    (
        cd /srv/node-red
        node <<'NODE'
const fs = require('fs');

const explicitModuleChecks = [
  ['@chirpstack/chirpstack-api/api/device_grpc_pb', () => require('@chirpstack/chirpstack-api/api/device_grpc_pb')],
  ['sqlite3', () => require('sqlite3')],
];

const requiredModules = [
  '@chirpstack/chirpstack-api/api/device_pb',
  '@chirpstack/chirpstack-api/api/application_grpc_pb',
  '@chirpstack/chirpstack-api/api/application_pb',
  '@chirpstack/chirpstack-api/api/tenant_grpc_pb',
  '@chirpstack/chirpstack-api/api/tenant_pb',
  '@chirpstack/chirpstack-api/api/device_profile_grpc_pb',
  '@chirpstack/chirpstack-api/api/device_profile_pb',
  '@chirpstack/chirpstack-api/api/gateway_grpc_pb',
  '@chirpstack/chirpstack-api/api/gateway_pb',
  '@chirpstack/chirpstack-api/common/common_pb',
  '@grpc/grpc-js',
  'bcryptjs',
  'google-protobuf',
  'osi-chameleon-helper',
  'osi-chirpstack-helper',
  'osi-cloud-http',
  'osi-db-helper',
  'osi-dendro-helper',
  'osi-history-helper',
];

const advisoryFiles = [
  'node_modules/@rakwireless/field-tester-server/package.json',
];

const optionalAlternatives = [
  [
    'node-red-node-sqlite',
    'node_modules/node-red-node-sqlite/package.json',
    '/usr/lib/node/node-red/node_modules/node-red-node-sqlite/package.json',
  ],
];

let ok = true;
for (const [moduleName, load] of explicitModuleChecks) {
  try {
    load();
  } catch (error) {
    ok = false;
    const message = error && error.message ? error.message : String(error);
    console.error('missing or unusable Node-RED module: ' + moduleName + ' - ' + message);
  }
}

for (const moduleName of requiredModules) {
  try {
    require(moduleName);
  } catch (error) {
    ok = false;
    const message = error && error.message ? error.message : String(error);
    console.error('missing or unusable Node-RED module: ' + moduleName + ' - ' + message);
  }
}

for (const filePath of advisoryFiles) {
  if (!fs.existsSync(filePath)) {
    console.error('WARN: optional Node-RED runtime package file is missing: ' + filePath);
  }
}

for (const [label, ...paths] of optionalAlternatives) {
  if (!paths.some((filePath) => fs.existsSync(filePath))) {
    ok = false;
    console.error('missing Node-RED runtime package: ' + label + ' (' + paths.join(' or ') + ')');
  }
}

process.exit(ok ? 0 : 1);
NODE
    )
}

install_node_red_runtime_dependencies_if_needed() {
    echo "--- Node-RED runtime dependencies ---"
    refresh_local_node_red_helpers
    if validate_node_red_runtime_dependencies; then
        echo "OK: existing Node-RED runtime dependencies are usable"
        return 0
    fi

    echo "WARN: Node-RED runtime dependencies incomplete; trying npm install without lifecycle scripts" >&2
    npm_log="$TMP_DIR/npm-install.log"
    if cd /srv/node-red && npm install --omit=dev --no-fund --no-audit --ignore-scripts >"$npm_log" 2>&1; then
        tail -20 "$npm_log"
    else
        tail -80 "$npm_log" >&2
        echo "WARN: npm install --ignore-scripts failed" >&2
    fi

    refresh_local_node_red_helpers
    if validate_node_red_runtime_dependencies; then
        echo "OK: Node-RED runtime dependencies are usable after no-lifecycle install"
        return 0
    fi

    echo "WARN: Node-RED runtime dependencies still incomplete; trying full npm install" >&2
    npm_full_log="$TMP_DIR/npm-install-full.log"
    if cd /srv/node-red && npm install --omit=dev --no-fund --no-audit >"$npm_full_log" 2>&1; then
        tail -20 "$npm_full_log"
    else
        tail -80 "$npm_full_log" >&2
        echo "ERROR: npm install failed and Node-RED runtime dependencies are still incomplete" >&2
        echo "Hint: field Pi images may lack the Python/toolchain needed for sqlite3 native rebuilds; preserve a working /srv/node-red/node_modules or deploy target-built modules." >&2
        return 1
    fi

    refresh_local_node_red_helpers
    validate_node_red_runtime_dependencies || {
        echo "ERROR: Node-RED runtime dependency validation failed after npm install" >&2
        return 1
    }
    echo "OK: Node-RED runtime dependencies are usable after full install"
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

ensure_dendro_schema() {
    echo "--- Live dendrometer schema repair ---"
    if [ ! -e "$DB_PATH" ]; then
        echo "SKIP: no live database at $DB_PATH"
        return 0
    fi
    node <<'NODE'
const fs = require('fs');
const dbPath = '/data/db/farming.db';
if (!fs.existsSync(dbPath)) {
  console.log('SKIP: no live database at ' + dbPath);
  process.exit(0);
}
const sqlite3 = require('/srv/node-red/node_modules/sqlite3');
const db = new sqlite3.Database(dbPath);
function run(sql) {
  return new Promise((resolve, reject) => db.run(sql, (err) => err ? reject(err) : resolve()));
}
function all(sql) {
  return new Promise((resolve, reject) => db.all(sql, (err, rows) => err ? reject(err) : resolve(rows || [])));
}
(async () => {
  await run('PRAGMA busy_timeout=5000');
  for (const sql of [
    'ALTER TABLE devices ADD COLUMN dendro_ratio_at_retracted REAL',
    'ALTER TABLE devices ADD COLUMN dendro_ratio_at_extended REAL'
  ]) {
    try {
      await run(sql);
    } catch (err) {
      if (!/duplicate column name/i.test(String(err && err.message || err))) throw err;
    }
  }
  await run(`UPDATE devices SET dendro_ratio_at_retracted = CASE
    WHEN dendro_invert_direction = 1 THEN dendro_ratio_span
    ELSE dendro_ratio_zero
  END
  WHERE dendro_ratio_at_retracted IS NULL
    AND (dendro_ratio_zero IS NOT NULL OR dendro_ratio_span IS NOT NULL)`);
  await run(`UPDATE devices SET dendro_ratio_at_extended = CASE
    WHEN dendro_invert_direction = 1 THEN dendro_ratio_zero
    ELSE dendro_ratio_span
  END
  WHERE dendro_ratio_at_extended IS NULL
    AND (dendro_ratio_zero IS NOT NULL OR dendro_ratio_span IS NOT NULL)`);
  const cols = await all('PRAGMA table_info(devices)');
  const names = new Set(cols.map((row) => row.name));
  if (!names.has('dendro_ratio_at_retracted') || !names.has('dendro_ratio_at_extended')) {
    throw new Error('dendrometer calibration columns are still missing after deploy repair');
  }
  console.log('OK');
  db.close();
})().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  db.close();
  process.exit(1);
});
NODE
}

ensure_zone_irrigation_calibration_schema() {
    echo "--- Live zone irrigation calibration schema repair ---"
    if [ ! -e "$DB_PATH" ]; then
        echo "SKIP: no live database at $DB_PATH"
        return 0
    fi
    node <<'NODE'
const fs = require('fs');
const dbPath = '/data/db/farming.db';
if (!fs.existsSync(dbPath)) {
  console.log('SKIP: no live database at ' + dbPath);
  process.exit(0);
}
const sqlite3 = require('/srv/node-red/node_modules/sqlite3');
const db = new sqlite3.Database(dbPath);
function run(sql) {
  return new Promise((resolve, reject) => db.run(sql, (err) => err ? reject(err) : resolve()));
}
function all(sql) {
  return new Promise((resolve, reject) => db.all(sql, (err, rows) => err ? reject(err) : resolve(rows || [])));
}
(async () => {
  await run('PRAGMA busy_timeout=5000');
  await run(`CREATE TABLE IF NOT EXISTS zone_irrigation_calibration (
    zone_id                INTEGER PRIMARY KEY,
    valve_device_eui       TEXT,
    measured_flow_rate_lpm REAL,
    measurement_method     TEXT,
    measured_at            TEXT,
    created_at             TEXT,
    updated_at             TEXT
  )`);
  for (const sql of [
    'ALTER TABLE zone_irrigation_calibration ADD COLUMN valve_device_eui TEXT',
    'ALTER TABLE zone_irrigation_calibration ADD COLUMN measured_flow_rate_lpm REAL',
    'ALTER TABLE zone_irrigation_calibration ADD COLUMN measurement_method TEXT',
    'ALTER TABLE zone_irrigation_calibration ADD COLUMN measured_at TEXT',
    'ALTER TABLE zone_irrigation_calibration ADD COLUMN created_at TEXT',
    'ALTER TABLE zone_irrigation_calibration ADD COLUMN updated_at TEXT'
  ]) {
    try {
      await run(sql);
    } catch (err) {
      if (!/duplicate column name/i.test(String(err && err.message || err))) throw err;
    }
  }
  const cols = await all('PRAGMA table_info(zone_irrigation_calibration)');
  const names = new Set(cols.map((row) => row.name));
  for (const required of ['zone_id', 'measured_flow_rate_lpm', 'measurement_method', 'updated_at']) {
    if (!names.has(required)) {
      throw new Error('zone irrigation calibration column is still missing after deploy repair: ' + required);
    }
  }
  console.log('OK');
  db.close();
})().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  db.close();
  process.exit(1);
});
NODE
}

ensure_analysis_views_schema() {
    echo "--- Live analysis views schema repair ---"
    if [ ! -e "$DB_PATH" ]; then
        echo "SKIP: no live database at $DB_PATH"
        return 0
    fi
    node <<'NODE'
const fs = require('fs');
const dbPath = '/data/db/farming.db';
if (!fs.existsSync(dbPath)) {
  console.log('SKIP: no live database at ' + dbPath);
  process.exit(0);
}
const sqlite3 = require('/srv/node-red/node_modules/sqlite3');
const db = new sqlite3.Database(dbPath);
function run(sql) {
  return new Promise((resolve, reject) => db.run(sql, (err) => err ? reject(err) : resolve()));
}
function all(sql) {
  return new Promise((resolve, reject) => db.all(sql, (err, rows) => err ? reject(err) : resolve(rows || [])));
}
(async () => {
  await run('PRAGMA busy_timeout=5000');
  await run(`CREATE TABLE IF NOT EXISTS analysis_views (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    owner_user_uuid TEXT,
    name TEXT NOT NULL,
    view_json TEXT NOT NULL,
    is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0,1)),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`);
  const cols = await all('PRAGMA table_info(analysis_views)');
  const names = new Set(cols.map((row) => row.name));
  for (const required of ['id', 'user_id', 'owner_user_uuid', 'name', 'view_json', 'is_default', 'created_at', 'updated_at']) {
    if (!names.has(required)) {
      throw new Error('analysis_views column is still missing after deploy repair: ' + required);
    }
  }
  console.log('OK');
  db.close();
})().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  db.close();
  process.exit(1);
});
NODE
}

ensure_chameleon_schema() {
    echo "--- Live Chameleon SWT schema repair ---"
    if [ ! -e "$DB_PATH" ]; then
        echo "SKIP: no live database at $DB_PATH"
        return 0
    fi
    node <<'NODE'
const fs = require('fs');
const dbPath = '/data/db/farming.db';
if (!fs.existsSync(dbPath)) {
  console.log('SKIP: no live database at ' + dbPath);
  process.exit(0);
}
const sqlite3 = require('/srv/node-red/node_modules/sqlite3');
const db = new sqlite3.Database(dbPath);
function run(sql) {
  return new Promise((resolve, reject) => db.run(sql, (err) => err ? reject(err) : resolve()));
}
function all(sql) {
  return new Promise((resolve, reject) => db.all(sql, (err, rows) => err ? reject(err) : resolve(rows || [])));
}
(async () => {
  await run('PRAGMA busy_timeout=5000');
  // V42 — kept columns. swt_{1,2,3} on device_data and depth/enabled on devices.
  for (const sql of [
    'ALTER TABLE devices ADD COLUMN chameleon_enabled INTEGER DEFAULT 0',
    'ALTER TABLE devices ADD COLUMN chameleon_swt1_depth_cm REAL',
    'ALTER TABLE devices ADD COLUMN chameleon_swt2_depth_cm REAL',
    'ALTER TABLE devices ADD COLUMN chameleon_swt3_depth_cm REAL',
    'ALTER TABLE device_data ADD COLUMN swt_1 REAL',
    'ALTER TABLE device_data ADD COLUMN swt_2 REAL',
    'ALTER TABLE device_data ADD COLUMN swt_3 REAL'
  ]) {
    try {
      await run(sql);
    } catch (err) {
      if (!/duplicate column name/i.test(String(err && err.message || err))) throw err;
    }
  }
  await run('UPDATE devices SET chameleon_enabled = 0 WHERE chameleon_enabled IS NULL');

  // V42 — global calibration tables. Calibration values are intrinsic to the
  // Chameleon hardware (keyed by array_id) and sourced from via.farm via the
  // cloud sync endpoint. The miss table is a 24h negative cache.
  await run(`CREATE TABLE IF NOT EXISTS chameleon_calibrations (
    array_id                TEXT PRIMARY KEY,
    sensor_id               TEXT NOT NULL,
    sensor1_a               REAL NOT NULL,
    sensor1_b               REAL NOT NULL,
    sensor1_c               REAL NOT NULL,
    sensor1_r2              REAL,
    sensor2_a               REAL NOT NULL,
    sensor2_b               REAL NOT NULL,
    sensor2_c               REAL NOT NULL,
    sensor2_r2              REAL,
    sensor3_a               REAL NOT NULL,
    sensor3_b               REAL NOT NULL,
    sensor3_c               REAL NOT NULL,
    sensor3_r2              REAL,
    test_rig_run_start_date TEXT,
    source                  TEXT NOT NULL,
    fetched_at              TEXT NOT NULL
  )`);
  await run('CREATE INDEX IF NOT EXISTS idx_chameleon_calibrations_sensor_id ON chameleon_calibrations(sensor_id)');
  await run(`CREATE TABLE IF NOT EXISTS chameleon_calibration_misses (
    array_id   TEXT PRIMARY KEY,
    last_tried TEXT NOT NULL,
    reason     TEXT
  )`);

  // V42 — calibration_status, swt_1/2/3, and chameleon_array_id additions.
  for (const sql of [
    'ALTER TABLE chameleon_readings ADD COLUMN calibration_status TEXT',
    'ALTER TABLE chameleon_readings ADD COLUMN swt_1 REAL',
    'ALTER TABLE chameleon_readings ADD COLUMN swt_2 REAL',
    'ALTER TABLE chameleon_readings ADD COLUMN swt_3 REAL',
    'ALTER TABLE devices ADD COLUMN chameleon_array_id TEXT'
  ]) {
    try {
      await run(sql);
    } catch (err) {
      if (!/duplicate column name/i.test(String(err && err.message || err))) throw err;
    }
  }

  // V43 — data_invalid and comp_pending for Chameleon V2 firmware decoding.
  for (const sql of [
    'ALTER TABLE chameleon_readings ADD COLUMN data_invalid INTEGER DEFAULT 0',
    'ALTER TABLE chameleon_readings ADD COLUMN comp_pending INTEGER DEFAULT 0'
  ]) {
    try {
      await run(sql);
    } catch (err) {
      if (!/duplicate column name/i.test(String(err && err.message || err))) throw err;
    }
  }

  // V42 — drop per-device coefficient columns. The bundled DB no longer has
  // them; live DBs from pre-V42 builds must drop them so the new flows.json
  // queries don't try to SELECT non-existent columns. SQLite >= 3.35 supports
  // ALTER TABLE ... DROP COLUMN; older versions will error and we leave the
  // columns in place (they're unused but not harmful).
  for (const name of [
    'chameleon_swt1_a','chameleon_swt1_b','chameleon_swt1_c',
    'chameleon_swt2_a','chameleon_swt2_b','chameleon_swt2_c',
    'chameleon_swt3_a','chameleon_swt3_b','chameleon_swt3_c'
  ]) {
    try {
      await run(`ALTER TABLE devices DROP COLUMN ${name}`);
    } catch (err) {
      const msg = String(err && err.message || err);
      if (/no such column/i.test(msg) || /near "DROP": syntax error/i.test(msg)) continue;
      throw err;
    }
  }

  // Schema repair intentionally does not mutate device_data.swt_*.
  // Historical Chameleon SWT corrections must use scripts/repair-chameleon-swt-history.js
  // so valid calibrated rows are preserved across repeat deploys.

  const deviceNames = new Set((await all('PRAGMA table_info(devices)')).map((row) => row.name));
  const dataNames = new Set((await all('PRAGMA table_info(device_data)')).map((row) => row.name));
  const readingsNames = new Set((await all('PRAGMA table_info(chameleon_readings)')).map((row) => row.name));
  const tableNames = new Set((await all("SELECT name FROM sqlite_master WHERE type = 'table'")).map((row) => row.name));

  for (const name of [
    'chameleon_enabled',
    'chameleon_swt1_depth_cm',
    'chameleon_swt2_depth_cm',
    'chameleon_swt3_depth_cm',
    'chameleon_array_id'
  ]) {
    if (!deviceNames.has(name)) throw new Error('Chameleon devices column is still missing after deploy repair: ' + name);
  }
  for (const name of ['swt_1', 'swt_2', 'swt_3']) {
    if (!dataNames.has(name)) throw new Error('Chameleon device_data column is still missing after deploy repair: ' + name);
  }
  for (const name of ['calibration_status', 'swt_1', 'swt_2', 'swt_3', 'data_invalid', 'comp_pending']) {
    if (!readingsNames.has(name)) throw new Error('chameleon_readings.' + name + ' is still missing after deploy repair');
  }
  for (const name of ['chameleon_calibrations', 'chameleon_calibration_misses']) {
    if (!tableNames.has(name)) throw new Error('Chameleon global table is still missing after deploy repair: ' + name);
  }
  console.log('OK');
  db.close();
})().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  db.close();
  process.exit(1);
});
NODE
}

ensure_sync_link_state() {
    echo "--- Sync link-state gate ---"
    if [ ! -e "$DB_PATH" ]; then
        echo "SKIP: no live database at $DB_PATH"
        return 0
    fi
    node <<'NODE'
const fs = require('fs');
const cp = require('child_process');
const dbPath = '/data/db/farming.db';
if (!fs.existsSync(dbPath)) {
  console.log('SKIP: no live database at ' + dbPath);
  process.exit(0);
}
const sqlite3 = require('/srv/node-red/node_modules/sqlite3');
const db = new sqlite3.Database(dbPath);
function run(sql, params = []) {
  return new Promise((resolve, reject) => db.run(sql, params, (err) => err ? reject(err) : resolve()));
}
function all(sql, params = []) {
  return new Promise((resolve, reject) => db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows || [])));
}
function normalizeGatewayDeviceEui(value) {
  const raw = String(value || '').trim().replace(/[^0-9a-fA-F]/g, '').toUpperCase();
  if (!raw) return '';
  if (raw.length === 16) return raw === '0101010101010101' ? '' : raw;
  if (raw.length === 12) return raw.slice(0, 6) + 'FFFE' + raw.slice(6);
  return '';
}
function readUci(key) {
  try {
    return String(cp.execFileSync('/bin/sh', ['-lc', 'uci -q get ' + key + ' 2>/dev/null || true'], { encoding: 'utf8' }) || '').trim();
  } catch (_) {
    return '';
  }
}
(async () => {
  await run('PRAGMA busy_timeout=5000');
  await run(`CREATE TABLE IF NOT EXISTS sync_link_state (
    peer_node TEXT PRIMARY KEY,
    linked INTEGER NOT NULL DEFAULT 0,
    server_url TEXT,
    cloud_user_id TEXT,
    gateway_device_eui TEXT,
    updated_at TEXT NOT NULL
  )`);
  const linkStateColumns = new Set((await all('PRAGMA table_info(sync_link_state)')).map((row) => row.name));
  for (const requiredColumn of ['peer_node', 'linked']) {
    if (!linkStateColumns.has(requiredColumn)) {
      throw new Error('sync_link_state column is missing and cannot be repaired safely: ' + requiredColumn);
    }
  }
  for (const [columnName, columnType] of [
    ['server_url', 'TEXT'],
    ['cloud_user_id', 'TEXT'],
    ['gateway_device_eui', 'TEXT'],
    ['updated_at', 'TEXT']
  ]) {
    if (!linkStateColumns.has(columnName)) {
      await run(`ALTER TABLE sync_link_state ADD COLUMN ${columnName} ${columnType}`);
    }
  }
  const linkedUsers = await all(`
    SELECT id, username, server_url, cloud_user_id, server_linked_at
      FROM users
     WHERE auth_mode = 'server'
       AND server_url IS NOT NULL
       AND trim(server_url) <> ''
     ORDER BY COALESCE(server_linked_at, '') DESC, id DESC
     LIMIT 1`);
  if (!linkedUsers.length) {
    console.log('OK: no linked users; sync_link_state may remain unlinked');
    db.close();
    return;
  }

  const linkedRows = await all("SELECT peer_node FROM sync_link_state WHERE peer_node='cloud' AND linked=1 LIMIT 1");
  const gatewayRows = await all(`
    SELECT gateway_device_eui FROM devices
     WHERE deleted_at IS NULL
       AND gateway_device_eui IS NOT NULL
       AND trim(gateway_device_eui) <> ''
     UNION ALL
    SELECT gateway_device_eui FROM irrigation_zones
     WHERE deleted_at IS NULL
       AND gateway_device_eui IS NOT NULL
       AND trim(gateway_device_eui) <> ''
     LIMIT 1`);
  const gatewayDeviceEui = normalizeGatewayDeviceEui(readUci('osi-server.cloud.link_gateway_device_eui'))
    || normalizeGatewayDeviceEui(readUci('osi-server.cloud.device_eui'))
    || normalizeGatewayDeviceEui(gatewayRows[0] && gatewayRows[0].gateway_device_eui);
  if (!gatewayDeviceEui) {
    throw new Error('linked users exist but no gateway EUI is available to repair sync_link_state');
  }
  if (!linkedRows.length) {
    console.error('WARN: linked users exist but sync_link_state has no linked cloud row; repairing from users');
  }
  const user = linkedUsers[0];
  await run(
    `INSERT INTO sync_link_state(peer_node, linked, server_url, cloud_user_id, gateway_device_eui, updated_at)
       VALUES('cloud', 1, ?, ?, ?, ?)
       ON CONFLICT(peer_node) DO UPDATE SET
         linked=1,
         server_url=excluded.server_url,
         cloud_user_id=excluded.cloud_user_id,
         gateway_device_eui=excluded.gateway_device_eui,
         updated_at=excluded.updated_at`,
    [
      String(user.server_url || '').trim(),
      user.cloud_user_id == null ? null : String(user.cloud_user_id),
      gatewayDeviceEui,
      new Date().toISOString()
    ]
  );
  const okRows = await all("SELECT COUNT(*) AS count FROM sync_link_state WHERE peer_node='cloud' AND linked=1 AND gateway_device_eui IS NOT NULL AND trim(gateway_device_eui) <> ''");
  if (!okRows[0] || Number(okRows[0].count) !== 1) {
    throw new Error('sync_link_state validation failed after deploy repair');
  }
  console.log('OK: sync_link_state linked for cloud gateway ' + gatewayDeviceEui);
  db.close();
})().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  db.close();
  process.exit(1);
});
NODE
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

fetch_required "flows.json" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json" \
    "/srv/node-red/flows.json"

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

fetch_required "osi-dendro-helper package.json" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-dendro-helper/package.json" \
    "/srv/node-red/osi-dendro-helper/package.json"

fetch_required "osi-dendro-helper index.js" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-dendro-helper/index.js" \
    "/srv/node-red/osi-dendro-helper/index.js"

fetch_required "osi-history-helper package.json" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-helper/package.json" \
    "/srv/node-red/osi-history-helper/package.json"

fetch_required "osi-history-helper index.js" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-helper/index.js" \
    "/srv/node-red/osi-history-helper/index.js"

fetch_required "osi-history-helper analysis.js" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-helper/analysis.js" \
    "/srv/node-red/osi-history-helper/analysis.js"

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

install_node_red_runtime_dependencies_if_needed

ensure_dendro_schema
ensure_zone_irrigation_calibration_schema
ensure_analysis_views_schema
ensure_chameleon_schema
ensure_sync_link_state

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
echo "=== Deploy complete. Next steps: ==="
echo "  1. Restart Node-RED:  /etc/init.d/node-red restart"
echo "  2. Open the UI:       http://<device-ip>:1880/gui"
echo ""
echo "  NOTE: ChirpStack provisioning runs automatically on first boot via"
echo "        osi-bootstrap (START=99).  No manual bootstrap step needed on"
echo "        a freshly installed gateway.  To re-provision manually run:"
echo "        node /usr/share/node-red/chirpstack-bootstrap.js"
