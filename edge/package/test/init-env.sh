#!/bin/sh
# Prints the environment the osi-edge init gives the service, one NAME=value
# per line, by running the init's start_service against a scratch root with
# stub uci, procd, pgrep and logger. The T1 harness uses it (--init-env) so a
# replay runs the Go backend with exactly the init-derived environment.
#   init-env.sh ROOT [INIT]
# ROOT holds the files the init reads, at their device paths:
#   ROOT/etc/osi-backend, ROOT/srv/node-red/.chirpstack.env, ROOT/data/db/
# and ROOT/uci, one "osi-server.cloud.key=value" line per configured key.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
root=${1:?usage: init-env.sh ROOT [INIT]}
INIT=${2:-$HERE/../files/etc/init.d/osi-edge}
mkdir -p "$root/srv/node-red"
sed -e "s|/etc/osi-backend|$root/etc/osi-backend|g" \
    -e "s|/srv/|$root/srv/|g" \
    -e "s|/data/db/|$root/data/db/|g" \
    -e "s|/usr/libexec/osi-gateway-identity.sh|$root/missing-identity-helper|g" \
    "$INIT" > "$root/init-env.init"

logger() { :; }
pgrep() { return 1; }
uci() {
    [ "$1" = -q ] && shift
    [ "$1" = get ] || return 1
    [ -f "$root/uci" ] || return 1
    awk -v key="$2" 'index($0, key "=") == 1 { print substr($0, length(key) + 2); found = 1; exit } END { exit !found }' "$root/uci"
}
procd_open_instance() { :; }
procd_close_instance() { :; }
procd_set_param() {
    if [ "$1" = env ]; then
        shift
        printf '%s\n' "$@"
    fi
}
. "$root/init-env.init"
start_service
