#!/bin/sh
# Run the init wrapper with stub UCI and procd against a scratch root.
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
INIT=${OSI_EDGE_TEST_INIT:-$HERE/../files/etc/init.d/osi-edge}
SCRATCH=${OSI_TEST_SCRATCH:?set OSI_TEST_SCRATCH to a scratch directory}
root=$(mktemp -d "$SCRATCH/osi-edge-init.XXXXXX")
trap 'rm -rf "$root"' EXIT
mkdir -p "$root/etc" "$root/srv/node-red" "$root/var/run" "$root/var/lock" "$root/bin"
printf '%s\n' edge > "$root/etc/osi-backend"
printf '%s\n' 'CHIRPSTACK_PROFILE_CLOVER = "legacy-clover"' > "$root/srv/node-red/.chirpstack.env"
sed -e "s|/etc/osi-backend|$root/etc/osi-backend|g" \
    -e "s|/var/|$root/var/|g" \
    -e "s|/usr/libexec/osi-boot/|$root/boot/|g" \
    -e "s|/srv/|$root/srv/|g" \
    -e "s|/data/db/|$root/data/db/|g" \
    -e "s|/usr/libexec/osi-gateway-identity.sh|$root/missing-identity-helper|g" \
    "$INIT" > "$root/init"

# The detached switch is exercised end to end by osi-init-autofallback.test.sh.
setsid() { :; }
logger() {
    if [ "$*" = '-t osi-edge-boot' ]; then
        cat >> "$root/boot-log"
    elif [ "$2" = osi-edge-boot ]; then
        printf '%s\n' "$3" >> "$root/boot-log"
    fi
}
cat > "$root/bin/node" <<'NODE'
#!/bin/sh
set -eu
[ "$1" = "$TEST_ROOT/boot/run-sync-init.js" ]
[ "$OSI_BOOT_DB" = "$TEST_ROOT/data/db/farming.db" ]
[ "$OSI_BOOT_NODE_RED_DIR" = "$TEST_ROOT/srv/node-red" ]
printf '%s\n' "$DEVICE_EUI" >> "$TEST_ROOT/runner-eui"
case "${TEST_RUNNER_MODE:-0}" in
    1) printf '%s\n' 'sync-init-fn ERROR  synthetic failure' '    detail' >&2; exit 1 ;;
    crash) kill -TERM "$$" ;;
    timeout) exec sleep 10 ;;
    *) exit "${TEST_RUNNER_MODE:-0}" ;;
esac
NODE
chmod +x "$root/bin/node"
export PATH="$root/bin:$PATH" TEST_ROOT="$root"
pgrep() { [ "${node_red_running:-}" = "$*" ]; }
uci() {
    case "$*" in
        *osi-server.cloud.device_eui) printf '%s' "$test_device_eui" ;;
        *osi-server.cloud.link_gateway_device_eui) printf '%s' "$test_link_eui" ;;
        *osi-server.cloud.edge_boot_timeout_seconds) printf %s "${test_timeout:-30}" ;;
        *osi-server.cloud.server_host) [ -n "$test_host" ] && printf '%s' "$test_host" ;;
        *) return 1 ;;
    esac
}
procd_open_instance() { : > "$root/procd-open"; }
procd_close_instance() { :; }
procd_set_param() {
    if [ "$1" = env ]; then
        shift
        printf '%s\n' "$@" > "$root/env"
    fi
}

expect() {
    if ! grep -Fxq "$1" "$root/env"; then
        printf 'FAIL: expected %s\n' "$1" >&2
        exit 1
    fi
}

# An older image may have the UCI keys but lack the identity helper.
. "$root/init"
test_device_eui=00:16:c0:01:f1:00:00:01
test_link_eui=00:16:c0:00:00:01
test_host=
start_service
expect 'DEVICE_EUI=0016C001F1000001'
expect 'LINK_GATEWAY_DEVICE_EUI=0016C0FFFE000001'
expect 'OSI_CLOUD_BROKER_URL=wss://server.opensmartirrigation.org/mqtt'
expect 'DEVICE_MQTT_PASSWORD='
expect 'CHIRPSTACK_PROFILE_CLOVER=legacy-clover'

[ "$(cat "$root/runner-eui")" = '0016C001F1000001' ]
[ ! -s "$root/boot-log" ]
[ -e "$root/procd-open" ]

export TEST_RUNNER_MODE=1
rm "$root/procd-open"
start_service
[ -e "$root/procd-open" ]
printf '%s\n' 'sync-init-fn ERROR  synthetic failure' '    detail' > "$root/expected-log"
cmp "$root/expected-log" "$root/boot-log"

for TEST_RUNNER_MODE in 2 crash timeout; do
    test_timeout=1
    rm -f "$root/procd-open" "$root/boot-log"
    if start_service; then
        printf 'FAIL: runner %s allowed edge to start\n' "$TEST_RUNNER_MODE" >&2
        exit 1
    fi
    [ ! -e "$root/procd-open" ]
    case "$TEST_RUNNER_MODE" in
        2) reason='runner refused (exit 2)' ;;
        crash) reason='runner failed (exit 143)' ;;
        timeout) reason='runner timed out or was killed (1s limit)' ;;
    esac
    grep -Fq "$reason" "$root/boot-log"
    grep -Fq "$reason" "$root/var/run/osi-edge-boot.failed"
    [ "$(cat "$root/etc/osi-backend")" = edge ]
done
unset TEST_RUNNER_MODE
unset test_timeout

test_device_eui=01:01:01:01:01:01:01:01
test_link_eui=invalid
test_host=example.invalid:443
start_service
expect 'DEVICE_EUI='
expect 'LINK_GATEWAY_DEVICE_EUI='
expect 'OSI_CLOUD_BROKER_URL=wss://example.invalid:443/mqtt'
[ ! -e "$root/var/run/osi-edge-boot.failed" ]

node_red_running='-f /usr/lib/node/node-red/red.js'
if start_service; then
    printf 'FAIL: Node-RED entrypoint allowed edge to start\n' >&2
    exit 1
fi
node_red_running='-x node-red'
if start_service; then
    printf 'FAIL: Node-RED process title allowed edge to start\n' >&2
    exit 1
fi
# Both inits on one stub UCI and one .chirpstack.env: every variable both
# export has the same value, every ChirpStack id Node-RED gets the edge gets,
# and the edge exports nothing Node-RED does not (TZ above all).
REPO=$(cd "$HERE/../../.." && pwd)
sed -e "s|/srv/|$root/srv/|g" \
    -e "s|/data/db/|$root/data/db/|g" \
    -e "s|/usr/libexec/osi-gateway-identity.sh|$root/missing-identity-helper|g" \
    "$REPO/feeds/chirpstack-openwrt-feed/apps/node-red/files/node-red.init" > "$root/node-red.init"
cat > "$root/uci" <<'UCI'
osi-server.cloud.device_eui=00:16:c0:01:f1:00:00:01
osi-server.cloud.link_gateway_device_eui=00:16:c0:01:f1:00:00:01
osi-server.cloud.mqtt_password=synthetic-pw
osi-server.cloud.server_host=example.invalid:443
osi-server.cloud.scoped_access_enabled=1
osi-server.cloud.weather_provider_default=bogus
osi-server.cloud.chirpstack_app_sensors=uci-sensors
osi-server.cloud.chirpstack_profile_kiwi=uci-kiwi
osi-server.cloud.chirpstack_profile_lsn50=11111111-1111-4111-8111-111111111113
osi-server.cloud.chirpstack_profile_sdi12=11111111-1111-4111-8111-111111111118
osi-server.cloud.chirpstack_profile_strega=11111111-1111-4111-8111-111111111112
UCI
cat > "$root/srv/node-red/.chirpstack.env" <<'ENVFILE'
# CHIRPSTACK_PROFILE_RAK10701=commented-out
  CHIRPSTACK_PROFILE_KIWI = "env-kiwi-loses-to-uci"
CHIRPSTACK_PROFILE_CLOVER = "legacy-clover"
CHIRPSTACK_PROFILE_S2120='env-s2120'
CHIRPSTACK_APP_ACTUATORS=env-actuators
CHIRPSTACK_APP_FIELD_TESTER=legacy-tester
ENVFILE
uci() {
    [ "$1" = -q ] && shift
    [ "$1" = get ] || return 1
    awk -v key="$2" 'index($0, key "=") == 1 { print substr($0, length(key) + 2); found = 1; exit } END { exit !found }' "$root/uci"
}
. "$REPO/conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/libexec/osi-gateway-identity.sh"
gateway_identity_resolve() { return 1; }
gateway_identity_heal() { return 1; }
node_red_running=
start_service
mv "$root/env" "$root/edge-env"
(
    set +u
    . "$root/node-red.init"
    gateway_identity_resolve() { return 1; }
    gateway_identity_heal() { return 1; }
    payload_switch_repair() { :; }
    payload_schema_check() { :; }
    payload_hold_check() { :; }
    ensure_persistent_syslog_sink() { :; }
    validate_journal_media_settings() { printf '%s' "$3"; }
    node() { cat >/dev/null; }
    start_service
)
mv "$root/env" "$root/node-red-env"
while IFS= read -r line; do
    name=${line%%=*}
    case "$name" in OSI_EDGE_*) continue ;; esac
    theirs=$(grep "^$name=" "$root/node-red-env" || true)
    [ -n "$theirs" ] || { printf 'FAIL: edge exports %s; node-red.init does not\n' "$name" >&2; exit 1; }
    [ "$theirs" = "$line" ] || { printf 'FAIL: %s differs: edge %s, node-red %s\n' "$name" "$line" "$theirs" >&2; exit 1; }
done < "$root/edge-env"
for name in $(sed -n 's/^\(CHIRPSTACK_[A-Z0-9_]*\)=.*/\1/p' "$root/node-red-env"); do
    grep -q "^$name=" "$root/edge-env" || { printf 'FAIL: edge does not export %s\n' "$name" >&2; exit 1; }
done
grep -Fxq 'CHIRPSTACK_PROFILE_LSN50=11111111-1111-4111-8111-111111111113' "$root/edge-env" || { echo 'FAIL: LSN50 id' >&2; exit 1; }
grep -Fxq 'CHIRPSTACK_PROFILE_KIWI=uci-kiwi' "$root/edge-env" || { echo 'FAIL: UCI wins over the env file' >&2; exit 1; }
grep -Fxq 'CHIRPSTACK_PROFILE_CLOVER=legacy-clover' "$root/edge-env" || { echo 'FAIL: env-file fallback' >&2; exit 1; }
grep -Fxq 'CHIRPSTACK_PROFILE_RAK10701=' "$root/edge-env" || { echo 'FAIL: a commented key must stay unset' >&2; exit 1; }
grep -Fxq 'OSI_WEATHER_PROVIDER_DEFAULT=open_meteo' "$root/edge-env" || { echo 'FAIL: weather provider normalisation' >&2; exit 1; }
if grep -q '^TZ=' "$root/edge-env"; then echo 'FAIL: edge exports TZ' >&2; exit 1; fi
# tls_check (osi-backend's switch precondition) runs the binary's tls-check
# with the broker URL and database start_service gives the service.
cat > "$root/fake-edge" <<'FAKE'
#!/bin/sh
printf 'args=%s\n' "$*"
printf 'OSI_CLOUD_BROKER_URL=%s\n' "$OSI_CLOUD_BROKER_URL"
printf 'OSI_EDGE_DB=%s\n' "$OSI_EDGE_DB"
FAKE
chmod +x "$root/fake-edge"
PROG="$root/fake-edge"
tls_check > "$root/tls-check"
grep -Fxq 'args=tls-check' "$root/tls-check" || { echo 'FAIL: tls_check does not run tls-check' >&2; exit 1; }
for name in OSI_CLOUD_BROKER_URL OSI_EDGE_DB; do
    [ "$(grep "^$name=" "$root/tls-check")" = "$(grep "^$name=" "$root/edge-env")" ] ||
        { printf 'FAIL: tls_check %s differs from the service\n' "$name" >&2; exit 1; }
done
# Static pins (round 5 of the shared-cron check). procd parses
# `respawn <threshold> <timeout> <retry>` with atoi into uint32 (procd
# service/instance.c:1311-1325); retry -1 is 4294967295, and the crash-loop
# stop `respawn_count > respawn_retry && respawn_retry > 0` (instance.c:853)
# can never hold, so either backend respawns every 5 s without end. A Go
# runtime crash loop therefore never reaches the Node-RED fallback: the only
# automatic `osi-backend use node-red` is the boot runner's. Changing either
# fails here on purpose.
NODE_RED_INIT=${OSI_NODE_RED_TEST_INIT:-$HERE/../../../feeds/chirpstack-openwrt-feed/apps/node-red/files/node-red.init}
BACKEND_TOOL=${OSI_BACKEND_TEST_TOOL:-$HERE/../files/usr/sbin/osi-backend}
for file in "$INIT" "$NODE_RED_INIT"; do
    [ "$(grep -c 'procd_set_param respawn' "$file")" = 1 ] ||
        { printf 'FAIL: %s must set respawn exactly once\n' "$file" >&2; exit 1; }
    grep -Eq '^[[:space:]]*procd_set_param respawn 3600 5 -1$' "$file" ||
        { printf 'FAIL: %s respawn is not "3600 5 -1" (unlimited retries)\n' "$file" >&2; exit 1; }
done
uses=$(grep -n 'osi-backend use' "$INIT" | grep -v '^[0-9]*:#' || true)
[ "$(printf '%s\n' "$uses" | grep -c .)" = 1 ] ||
    { printf 'FAIL: the init script must invoke osi-backend use exactly once:\n%s\n' "$uses" >&2; exit 1; }
printf '%s\n' "$uses" | grep -Fq '/usr/sbin/osi-backend use node-red --reason boot-runner' ||
    { printf 'FAIL: the only automatic switch must be the boot-runner fallback:\n%s\n' "$uses" >&2; exit 1; }
line=${uses%%:*}
runner=$(awk '/^run_boot_init\(\) \($/ { start = NR } /^\) 8>\/var\/lock\/osi-edge-boot.lock$/ { if (start) { print start ":" NR; exit } }' "$INIT")
[ -n "$runner" ] && [ "$line" -gt "${runner%%:*}" ] && [ "$line" -lt "${runner##*:}" ] ||
    { printf 'FAIL: the fallback switch (line %s) is not inside run_boot_init (%s)\n' "$line" "$runner" >&2; exit 1; }
if grep -Eq 'instance\.fail|procd_add_.*trigger|service_triggers' "$INIT"; then
    echo 'FAIL: the init script reacts to procd events; the fallback pin needs review' >&2; exit 1
fi
others=$(grep -rln 'osi-backend use' "$HERE/../files" | grep -v -e '/etc/init.d/osi-edge$' -e '/usr/sbin/osi-backend$' || true)
[ -z "$others" ] || { printf 'FAIL: other files switch the backend:\n%s\n' "$others" >&2; exit 1; }
grep -Fq "[ \"\$2 \$3 \$4\" = 'node-red --reason boot-runner' ]" "$BACKEND_TOOL" ||
    { echo 'FAIL: osi-backend no longer accepts only the boot-runner reason' >&2; exit 1; }
echo 'osi-edge init tests: PASS'
