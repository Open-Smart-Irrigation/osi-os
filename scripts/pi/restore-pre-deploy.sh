#!/bin/sh
# Restore farming.db from a pre-deploy backup.
# Runs ON the Pi. Stops Node-RED, removes WAL/SHM, copies backup,
# integrity-checks, restarts Node-RED.
# Usage: restore-pre-deploy.sh <backup-path>
set -eu

BACKUP_PATH="${1:?Usage: restore-pre-deploy.sh <backup-path>}"
DB_PATH="/data/db/farming.db"

if [ ! -f "$BACKUP_PATH" ]; then
    echo "ERROR: backup not found at $BACKUP_PATH" >&2
    exit 1
fi

echo "Stopping Node-RED..."
/etc/init.d/node-red stop 2>/dev/null || true
sleep 3

echo "Removing WAL/SHM sidecars..."
rm -f "${DB_PATH}-wal" "${DB_PATH}-shm" "${DB_PATH}-journal"

echo "Restoring from $BACKUP_PATH..."
cp "$BACKUP_PATH" "$DB_PATH"

echo "Checking restored DB integrity..."
INTEG=$(sqlite3 "$DB_PATH" "PRAGMA integrity_check" 2>&1)
if [ "$INTEG" != "ok" ]; then
    echo "ERROR: restored DB integrity_check failed: $INTEG" >&2
    echo "WARNING: Node-RED NOT restarted — manual intervention required" >&2
    exit 2
fi

echo "Restarting Node-RED..."
/etc/init.d/node-red start || true

echo "OK: restored from $BACKUP_PATH (integrity ok)"
