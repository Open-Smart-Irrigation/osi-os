#!/bin/sh
# Exercises deploy-offline.sh with deploy.sh stubbed out (the real deploy.sh
# assumes a live gateway: /etc/init.d, uci, opkg, sqlite3, identityd -- none
# of which exist in a generic test environment). Requires BusyBox ash + node
# + tar + sha256sum + wget + setsid: run it under a busybox/node image, e.g.
#   docker run --rm -v "$PWD":/repo -w /repo node:22-alpine sh scripts/deploy-offline.test.sh
# (this workstation has neither busybox nor dash installed natively).
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
offline="$script_dir/deploy-offline.sh"
server_js="$script_dir/deploy-local-server.js"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT INT TERM

build_bundle() {
    exit_code="$1"
    bundle_out="$2"
    fixture="$work/fixture-$$-$RANDOM_SEED"
    RANDOM_SEED=$((RANDOM_SEED + 1))
    mkdir -p "$fixture/scripts"
    cp "$server_js" "$fixture/scripts/deploy-local-server.js"
    cat > "$fixture/deploy.sh" <<EOF
#!/bin/sh
set -eu
port="\$1"
base="http://127.0.0.1:\$port"
echo "stub deploy.sh starting against \$base"
wget -q -O /dev/null --spider "\$base/deploy.sh"
echo "stub deploy.sh confirmed local server reachable"
exit $exit_code
EOF
    tar czf "$bundle_out" -C "$fixture" .
    sha256sum "$bundle_out" | awk '{print $1"  bundle.tar.gz"}' > "$bundle_out.sha256"
}

RANDOM_SEED=1

echo "=== missing bundle fails clearly ==="
if sh "$offline" "$work/does-not-exist.tar.gz" 2>"$work/err.log"; then
    echo "expected failure for a missing bundle" >&2
    exit 1
fi
grep -qi 'not found' "$work/err.log"
echo "OK"

echo "=== sha256 mismatch is rejected ==="
build_bundle 0 "$work/bad.tar.gz"
printf 'deadbeef  bundle.tar.gz\n' > "$work/bad.tar.gz.sha256"
if sh "$offline" "$work/bad.tar.gz" 2>"$work/err.log"; then
    echo "expected sha256 mismatch to fail" >&2
    exit 1
fi
grep -qi 'sha256 mismatch' "$work/err.log"
echo "OK"

echo "=== successful deploy, --wait mode, returns deploy.sh's exit code ==="
build_bundle 0 "$work/good.tar.gz"
DEPLOY_OFFLINE_TMP_ROOT="$work/tmp" \
DEPLOY_OFFLINE_LOG_DIR="$work/data" \
DEPLOY_OFFLINE_TS="okwait" \
    sh "$offline" "$work/good.tar.gz" --port 18761 --wait > "$work/wait.out" 2>&1
rc=$?
[ "$rc" = "0" ] || { echo "expected exit 0, got $rc" >&2; cat "$work/wait.out" >&2; exit 1; }
[ -f "$work/data/deploy-okwait.log" ] || { echo "missing deploy log" >&2; exit 1; }
grep -q "stub deploy.sh confirmed local server reachable" "$work/data/deploy-okwait.log"
echo "OK"

echo "=== local server is stopped after --wait completes ==="
sleep 1
if wget -q -O /dev/null --spider "http://127.0.0.1:18761/deploy.sh" 2>/dev/null; then
    echo "expected local server to be stopped after deploy.sh finished" >&2
    exit 1
fi
echo "OK"

echo "=== failing deploy.sh propagates a nonzero exit code under --wait ==="
build_bundle 7 "$work/fail.tar.gz"
set +e
DEPLOY_OFFLINE_TMP_ROOT="$work/tmp" \
DEPLOY_OFFLINE_LOG_DIR="$work/data" \
DEPLOY_OFFLINE_TS="failwait" \
    sh "$offline" "$work/fail.tar.gz" --port 18762 --wait > "$work/failwait.out" 2>&1
rc=$?
set -e
[ "$rc" = "7" ] || { echo "expected exit 7, got $rc" >&2; cat "$work/failwait.out" >&2; exit 1; }
echo "OK"

echo "=== fire-and-forget mode returns immediately, deploy finishes async, server stops ==="
build_bundle 0 "$work/async.tar.gz"
start_ts=$(date +%s)
DEPLOY_OFFLINE_TMP_ROOT="$work/tmp" \
DEPLOY_OFFLINE_LOG_DIR="$work/data" \
DEPLOY_OFFLINE_TS="async1" \
    sh "$offline" "$work/async.tar.gz" --port 18763 > "$work/async.out" 2>&1
rc=$?
end_ts=$(date +%s)
[ "$rc" = "0" ] || { echo "expected fire-and-forget hand-off to exit 0, got $rc" >&2; cat "$work/async.out" >&2; exit 1; }
elapsed=$((end_ts - start_ts))
[ "$elapsed" -lt 10 ] || { echo "fire-and-forget mode took too long ($elapsed s); should return immediately after hand-off" >&2; exit 1; }
grep -q 'Follow it with: tail -f' "$work/async.out"
echo "OK: returned in ${elapsed}s"

echo "waiting for the detached deploy to finish..."
waited=0
while [ ! -f "$work/data/deploy-async1.log" ] || ! grep -q 'confirmed local server reachable' "$work/data/deploy-async1.log" 2>/dev/null; do
    waited=$((waited + 1))
    [ "$waited" -lt 20 ] || { echo "detached deploy never completed" >&2; exit 1; }
    sleep 1
done
sleep 1
if wget -q -O /dev/null --spider "http://127.0.0.1:18763/deploy.sh" 2>/dev/null; then
    echo "expected local server to be stopped once the detached deploy finished" >&2
    exit 1
fi
echo "OK"

echo "deploy-offline.test: OK"
