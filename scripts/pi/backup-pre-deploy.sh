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

mkdir -p "$BACKUP_DIR"

if [ ! -f "$DB_PATH" ]; then
    echo "ERROR: database not found at $DB_PATH" >&2
    exit 1
fi

echo "Stopping Node-RED for consistent backup..."
/etc/init.d/node-red stop 2>/dev/null || true
sleep 3

echo "Taking .backup to $BACKUP_PATH..."
sqlite3 "$DB_PATH" ".backup '$BACKUP_PATH'"

echo "Checking backup integrity..."
INTEG=$(sqlite3 "$BACKUP_PATH" "PRAGMA integrity_check" 2>&1)
if [ "$INTEG" != "ok" ]; then
    echo "ERROR: backup integrity_check failed: $INTEG" >&2
    /etc/init.d/node-red start || true
    exit 2
fi

# Record pre-deploy baselines
echo "Recording baselines..."
sqlite3 "$BACKUP_PATH" "SELECT 'db_size_bytes=' || (SELECT page_count * page_size FROM pragma_page_count(), pragma_page_size());"
sqlite3 "$BACKUP_PATH" "SELECT 'device_data_rows=' || COUNT(*) FROM device_data;"
sqlite3 "$BACKUP_PATH" "SELECT 'irrigation_schedules_rows=' || COUNT(*) FROM irrigation_schedules;"
sqlite3 "$BACKUP_PATH" "SELECT 'sync_outbox_pending=' || COUNT(*) FROM sync_outbox WHERE delivered_at IS NULL;"

echo "Restarting Node-RED..."
/etc/init.d/node-red start || true

echo "OK: backup at $BACKUP_PATH (integrity ok)"
echo "BACKUP_PATH=$BACKUP_PATH"
echo "TIMESTAMP=$TIMESTAMP"
