#!/bin/sh
# install-osi-os.sh — lay OSI OS overlay onto a running ChirpStack Gateway OS Pi.
#
# What this does:
#   1. Copies conf/full_raspberrypi_bcm27xx_bcm2712/files/ tree onto the Pi's root
#   2. Runs each uci-defaults script in numeric order (idempotent; scripts exit 0
#      if already applied)
#   3. Does NOT touch /data/db/farming.db — that is handled by 97_osi_db_seed
#      on first boot or by deploy.sh for subsequent updates
#
# Usage:
#   ./scripts/install-osi-os.sh <pi-host>
#   ./scripts/install-osi-os.sh 192.168.178.125
#
# Prerequisites:
#   - SSH root access to the Pi (password-less or key-based)
#   - rsync available locally; tar available on the Pi
#   - Run from the repo root

set -e

PI="${1:-}"
if [ -z "$PI" ]; then
    echo "Usage: $0 <pi-host>" >&2
    exit 1
fi

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OVERLAY="$REPO_ROOT/conf/full_raspberrypi_bcm27xx_bcm2712/files"

if [ ! -d "$OVERLAY" ]; then
    echo "Overlay directory not found: $OVERLAY" >&2
    exit 1
fi

echo "==> Installing OSI OS overlay on $PI"

# ---------------------------------------------------------------------------
# 1. Rsync overlay tree to Pi (excludes the seed DB — deployed via uci-default)
# ---------------------------------------------------------------------------
echo "--> Syncing overlay files..."
# Use tar over ssh since the Pi does not expose SFTP
tar -C "$OVERLAY" -czf - . | ssh -o StrictHostKeyChecking=no root@"$PI" "tar -C / -xzf -"

echo "--> Overlay files synced"

# ---------------------------------------------------------------------------
# 2. Run uci-defaults scripts in order
# ---------------------------------------------------------------------------
echo "--> Running uci-defaults..."
ssh -o StrictHostKeyChecking=no root@"$PI" '
    for script in $(ls /etc/uci-defaults/ | sort); do
        path="/etc/uci-defaults/$script"
        [ -f "$path" ] || continue
        echo "  Running $script..."
        sh "$path" && rm -f "$path" || echo "  WARNING: $script exited non-zero"
    done
    uci commit 2>/dev/null || true
'

echo "--> uci-defaults complete"

# ---------------------------------------------------------------------------
# 3. Install osi-bootstrap init service (if not already enabled)
# ---------------------------------------------------------------------------
echo "--> Enabling osi-bootstrap init service..."
ssh -o StrictHostKeyChecking=no root@"$PI" '
    if [ -f /etc/init.d/osi-bootstrap ]; then
        /etc/init.d/osi-bootstrap enable 2>/dev/null || true
        echo "  osi-bootstrap enabled"
    else
        echo "  WARNING: /etc/init.d/osi-bootstrap not found"
    fi
'

echo ""
echo "==> OSI OS overlay installed on $PI"
echo ""
echo "Next steps:"
echo "  1. Run deploy.sh to push Node-RED flows and React GUI"
echo "  2. Reboot the Pi — first boot will auto-provision ChirpStack via osi-bootstrap"
echo "     (watch: ssh root@$PI logread -f -e osi-bootstrap)"
