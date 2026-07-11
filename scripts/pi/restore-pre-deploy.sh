#!/bin/sh
# Restore farming.db from a pre-deploy backup.
# Runs ON the Pi. Verifies backup FIRST, then stops Node-RED, removes
# WAL/SHM, copies backup, integrity-checks, restarts Node-RED.
# Usage: restore-pre-deploy.sh <backup-path>
set -eu

BACKUP_PATH="${1:?Usage: restore-pre-deploy.sh <backup-path>}"
DB_PATH="/data/db/farming.db"

# Preflight: sqlite3 CLI must exist
command -v sqlite3 >/dev/null 2>&1 || {
    echo "ERROR: sqlite3 CLI not found — install via 'opkg install sqlite3-cli' first" >&2
    exit 3
}

if [ ! -f "$BACKUP_PATH" ]; then
    echo "ERROR: backup not found at $BACKUP_PATH" >&2
    exit 1
fi

# Verify backup integrity BEFORE touching anything (Fable review: don't
# destroy current state before verifying the replacement is good)
echo "Verifying backup integrity before restore..."
BACKUP_INTEG=$(sqlite3 "$BACKUP_PATH" "PRAGMA integrity_check" 2>&1) || true
if [ "$BACKUP_INTEG" != "ok" ]; then
    echo "ERROR: backup integrity_check failed BEFORE restore: $BACKUP_INTEG" >&2
    echo "Current database is UNTOUCHED — no changes made." >&2
    exit 2
fi

echo "Stopping Node-RED..."
/etc/init.d/node-red stop 2>/dev/null || true

# Wait for Node-RED to actually exit
i=0
while pgrep -f 'node-red' >/dev/null 2>&1 && [ "$i" -lt 30 ]; do
    sleep 1; i=$((i + 1))
done
if pgrep -f 'node-red' >/dev/null 2>&1; then
    echo "ERROR: Node-RED did not stop within 30s; refusing restore (writers may be active)" >&2
    /etc/init.d/node-red start >/dev/null 2>&1 || true
    exit 1
fi

echo "Removing WAL/SHM sidecars..."
rm -f "${DB_PATH}-wal" "${DB_PATH}-shm" "${DB_PATH}-journal"

echo "Restoring from $BACKUP_PATH..."
cp "$BACKUP_PATH" "$DB_PATH"

echo "Checking restored DB integrity..."
INTEG=$(sqlite3 "$DB_PATH" "PRAGMA integrity_check" 2>&1) || true
if [ "$INTEG" != "ok" ]; then
    echo "ERROR: restored DB integrity_check failed: $INTEG" >&2
    echo "WARNING: Node-RED NOT restarted — manual intervention required" >&2
    exit 2
fi

echo "Restarting Node-RED..."
/etc/init.d/node-red start || true

echo "OK: restored from $BACKUP_PATH (integrity ok)"
