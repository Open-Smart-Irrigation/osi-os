#!/bin/sh
# OSI_ORACLE_NODE wrapper for the cb2 nourl probes: the pinned oracle Node with the
# preload that blanks CHIRPSTACK_API_URL. OSI_ORACLE_NODE_REAL overrides
# the Node binary (default: ~/.local/node-v<pinned>-linux-x64/bin/node in the
# account's home; the harness sets HOME to the run directory for the oracle).
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
root=$(CDPATH= cd -- "$here/../../../.." && pwd)
pinned=$(sed -n "s/.*OSI_SMOKE_NODE_VERSION: *'\([^']*\)'.*/\1/p" "$root/.github/workflows/release-smoke.yml" | head -n 1)
home=$(getent passwd "$(id -u)" | cut -d: -f6)
node=${OSI_ORACLE_NODE_REAL:-${home:-$HOME}/.local/node-v$pinned-linux-x64/bin/node}
exec "$node" -r "$here/oracle-nourl-preload.cjs" "$@"
