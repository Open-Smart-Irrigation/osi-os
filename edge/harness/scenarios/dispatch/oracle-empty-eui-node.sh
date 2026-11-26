#!/bin/sh
# OSI_ORACLE_NODE wrapper for r3-q3-claim-empty-device-eui: the pinned oracle Node with the
# preload that sets DEVICE_EUI to the empty string. OSI_ORACLE_NODE_REAL overrides
# the Node binary (default: ~/.local/node-v<pinned>-linux-x64/bin/node in the
# account's home; the harness sets HOME to the run directory for the oracle).
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
root=$(CDPATH= cd -- "$here/../../../.." && pwd)
pinned=$(sed -n "s/.*OSI_SMOKE_NODE_VERSION: *'\([^']*\)'.*/\1/p" "$root/.github/workflows/release-smoke.yml" | head -n 1)
home=$(getent passwd "$(id -u)" | cut -d: -f6)
node=${OSI_ORACLE_NODE_REAL:-${home:-$HOME}/.local/node-v$pinned-linux-x64/bin/node}
exec "$node" -r "$here/oracle-empty-eui-preload.cjs" "$@"
