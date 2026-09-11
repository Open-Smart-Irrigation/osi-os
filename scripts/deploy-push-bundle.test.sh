#!/bin/sh
# Exercises deploy-push-bundle.sh's upload/resume/verify/invoke logic with a
# stub SSH_CMD that runs "remote" commands locally against a scratch
# directory (REMOTE_TMP) -- this test never opens a network connection or
# touches a real gateway, per the "no SSH to gateways" constraint.
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
pusher="$script_dir/deploy-push-bundle.sh"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT INT TERM

# --- fixtures -----------------------------------------------------------
ssh_stub="$work/ssh"
cat > "$ssh_stub" <<'EOF'
#!/bin/sh
# $1 = host (ignored, this is a local stub), $2 = remote command string
set -eu
host="$1"
shift
sh -c "$1"
EOF
chmod +x "$ssh_stub"

fixture_repo="$work/repo"
mkdir -p "$fixture_repo/scripts"
run_log="$work/deploy-offline-invocations.log"
cat > "$fixture_repo/scripts/deploy-offline.sh" <<EOF
#!/bin/sh
echo "deploy-offline.sh invoked with: \$*" >> "$run_log"
exit "\${STUB_DEPLOY_OFFLINE_EXIT:-0}"
EOF
chmod +x "$fixture_repo/scripts/deploy-offline.sh"

remote_tmp="$work/remote"
mkdir -p "$remote_tmp"

bundle="$work/deploy-bundle-abc123-20260911T000000Z.tar.gz"
printf 'A%.0s' $(seq 1 5000) > "$bundle"
sha256sum "$bundle" | cut -d ' ' -f1 > "$work/sha.txt"
printf '%s  %s\n' "$(cat "$work/sha.txt")" "$(basename "$bundle")" > "$bundle.sha256"

push() {
  SSH_CMD="$ssh_stub" REPO_ROOT="$fixture_repo" REMOTE_TMP="$remote_tmp" \
    sh "$pusher" "test-host" "$bundle" "$@"
}

echo "=== fresh upload streams the whole bundle and invokes deploy-offline.sh ==="
: > "$run_log"
push --port 19999 --wait
remote_bundle="$remote_tmp/$(basename "$bundle")"
[ -f "$remote_bundle" ] || { echo "remote bundle missing" >&2; exit 1; }
cmp -s "$bundle" "$remote_bundle" || { echo "remote bundle content differs" >&2; exit 1; }
grep -q "invoked with: .*$remote_bundle.*--port 19999 --wait" "$run_log" || {
  echo "expected deploy-offline.sh invocation with forwarded args" >&2
  cat "$run_log" >&2
  exit 1
}
echo "OK"

echo "=== re-running with an already-complete, matching remote bundle skips upload ==="
before_mtime=$(date -r "$remote_bundle" +%s 2>/dev/null || stat -c %Y "$remote_bundle")
sleep 1
: > "$run_log"
push --port 19999 --wait > "$work/skip.out" 2>&1
grep -qi "already present and sha256-verified" "$work/skip.out"
after_mtime=$(date -r "$remote_bundle" +%s 2>/dev/null || stat -c %Y "$remote_bundle")
[ "$before_mtime" = "$after_mtime" ] || { echo "expected remote bundle to be left untouched" >&2; exit 1; }
echo "OK"

echo "=== a partial remote file is resumed, not restarted ==="
rm -f "$remote_bundle" "$remote_bundle.sha256"
head -c 1000 "$bundle" > "$remote_bundle"
: > "$run_log"
push --port 19999 > "$work/resume.out" 2>&1
grep -qi "Resuming upload from byte 1000" "$work/resume.out" || {
  echo "expected a resume message" >&2
  cat "$work/resume.out" >&2
  exit 1
}
cmp -s "$bundle" "$remote_bundle" || { echo "resumed bundle content differs from local" >&2; exit 1; }
echo "OK"

echo "=== a corrupted/mismatched remote file is restarted from scratch ==="
rm -f "$remote_bundle" "$remote_bundle.sha256"
printf 'not the right bytes at all, wrong length even' > "$remote_bundle"
: > "$run_log"
push --port 19999 > "$work/corrupt.out" 2>&1
cmp -s "$bundle" "$remote_bundle" || { echo "restarted bundle content differs from local" >&2; exit 1; }
echo "OK"

echo "=== deploy-offline.sh's exit code propagates ==="
: > "$run_log"
set +e
STUB_DEPLOY_OFFLINE_EXIT=0 SSH_CMD="$ssh_stub" REPO_ROOT="$fixture_repo" REMOTE_TMP="$remote_tmp" \
  sh "$pusher" "test-host" "$bundle" >/dev/null 2>&1
rc_zero=$?
set -e
[ "$rc_zero" = "0" ] || { echo "expected exit 0 to propagate" >&2; exit 1; }

rm -f "$remote_bundle" "$remote_bundle.sha256"
set +e
STUB_DEPLOY_OFFLINE_EXIT=9 SSH_CMD="$ssh_stub" REPO_ROOT="$fixture_repo" REMOTE_TMP="$remote_tmp" \
  sh "$pusher" "test-host" "$bundle" >/dev/null 2>&1
rc_nine=$?
set -e
[ "$rc_nine" = "9" ] || { echo "expected exit 9 to propagate, got $rc_nine" >&2; exit 1; }
echo "OK"

echo "=== missing bundle fails clearly ==="
if push_missing=$(SSH_CMD="$ssh_stub" REPO_ROOT="$fixture_repo" REMOTE_TMP="$remote_tmp" \
    sh "$pusher" "test-host" "$work/nope.tar.gz" 2>&1); then
  echo "expected failure for a missing bundle" >&2
  exit 1
fi
echo "$push_missing" | grep -qi 'not found'
echo "OK"

echo "deploy-push-bundle.test: OK"
