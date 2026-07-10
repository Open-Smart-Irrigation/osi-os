#!/bin/sh
# Backup farming.db safely for pre-deploy snapshot.
# Runs ON the Pi. Stops Node-RED, uses sqlite3 .backup (WAL-safe),
# integrity-checks the copy, restarts Node-RED.
# Usage: backup-pre-deploy.sh [timestamp]
set -eu

TIMESTAMP="${1:-$(date -u +%Y%m%dT%H%M%SZ)}"
DB_PATH="/data/db/farming.db"
BACKUP_DIR="/data/backups"
BACKUP_PATH="$BACKUP_DIR/pre-deploy-${TIMESTAMP}.db"

# Preflight: sqlite3 CLI must exist (kaba100 may not have it — 1.B1 spec §B)
command -v sqlite3 >/dev/null 2>&1 || {
    echo "ERROR: sqlite3 CLI not found — install via 'opkg install sqlite3-cli' first" >&2
    exit 3
}

# Validate timestamp (caller is trusted but cheap to guard)
case "$TIMESTAMP" in *[!0-9TZ]*|"") echo "ERROR: invalid timestamp" >&2; exit 1;; esac

mkdir -p "$BACKUP_DIR"

if [ ! -f "$DB_PATH" ]; then
    echo "ERROR: database not found at $DB_PATH" >&2
    exit 1
fi

# Ensure Node-RED restarts on ANY exit after stop (trap before stop)
trap '/etc/init.d/node-red start >/dev/null 2>&1 || true' EXIT

echo "Stopping Node-RED for consistent backup..."
/etc/init.d/node-red stop 2>/dev/null || true

# Wait for Node-RED to actually exit (not just SIGTERM sent)
i=0
while pgrep -f 'node-red' >/dev/null 2>&1 && [ "$i" -lt 30 ]; do
    sleep 1; i=$((i + 1))
done
if pgrep -f 'node-red' >/dev/null 2>&1; then
    echo "ERROR: Node-RED did not stop within 30s; refusing backup" >&2
    exit 1
fi

echo "Taking .backup to $BACKUP_PATH..."
sqlite3 -cmd ".timeout 5000" "$DB_PATH" ".backup '$BACKUP_PATH'"

echo "Checking backup integrity..."
INTEG=$(sqlite3 "$BACKUP_PATH" "PRAGMA integrity_check" 2>&1) || true
if [ "$INTEG" != "ok" ]; then
    echo "ERROR: backup integrity_check failed: $INTEG" >&2
    exit 2
fi

# Record pre-deploy baselines (portable PRAGMA syntax)
echo "Recording baselines..."
PAGE_COUNT=$(sqlite3 "$BACKUP_PATH" "PRAGMA page_count;" 2>/dev/null || echo 0)
PAGE_SIZE=$(sqlite3 "$BACKUP_PATH" "PRAGMA page_size;" 2>/dev/null || echo 4096)
echo "db_size_bytes=$((PAGE_COUNT * PAGE_SIZE))"
sqlite3 "$BACKUP_PATH" "SELECT 'device_data_rows=' || COUNT(*) FROM device_data;"
sqlite3 "$BACKUP_PATH" "SELECT 'irrigation_schedules_rows=' || COUNT(*) FROM irrigation_schedules;"
sqlite3 "$BACKUP_PATH" "SELECT 'sync_outbox_pending=' || COUNT(*) FROM sync_outbox WHERE delivered_at IS NULL;"

echo "OK: backup at $BACKUP_PATH (integrity ok)"
echo "BACKUP_PATH=$BACKUP_PATH"
echo "TIMESTAMP=$TIMESTAMP"
# EXIT trap restarts Node-RED
