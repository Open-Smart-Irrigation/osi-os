#!/usr/bin/env bash
# Runs ON THE WORKSTATION. Streams a deploy-bundle.sh tarball to a gateway
# over a single plain `ssh ... 'cat > /tmp/...'` pipe (the Pis have no
# sftp-server, so scp/sftp/rsync-over-ssh are not available), verifies the
# remote sha256, then kicks off deploy-offline.sh on the gateway.
#
# The upload is resumable: on a dropped connection, re-running this script
# compares the remote file's size/sha256 against the local bundle and only
# streams the missing tail, instead of restarting from byte zero.
#
# Usage:
#   scripts/deploy-push-bundle.sh <user@host> <bundle.tar.gz> [-- <deploy-offline.sh args...>]
#
# Env overrides (mainly for scripts/deploy-push-bundle.test.sh, which stubs
# SSH_CMD so this script never actually opens a network connection):
#   REPO_ROOT     repo checkout deploy-offline.sh is read from
#   SSH_CMD       ssh binary/wrapper to use (default: ssh)
#   REMOTE_TMP    remote scratch dir (default: /tmp)
#   MAX_ATTEMPTS  upload retry budget (default: 5)
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${REPO_ROOT:-$(cd "$script_dir/.." && pwd)}"
SSH_CMD="${SSH_CMD:-ssh}"
REMOTE_TMP="${REMOTE_TMP:-/tmp}"
MAX_ATTEMPTS="${MAX_ATTEMPTS:-5}"

usage() {
  echo "Usage: $0 <user@host> <bundle.tar.gz> [-- <deploy-offline.sh args...>]" >&2
}

if [ $# -lt 2 ]; then
  usage
  exit 2
fi

HOST="$1"
BUNDLE="$2"
shift 2
DEPLOY_OFFLINE_ARGS=()
if [ $# -gt 0 ]; then
  if [ "$1" = "--" ]; then
    shift
  fi
  DEPLOY_OFFLINE_ARGS=("$@")
fi

if [ ! -f "$BUNDLE" ]; then
  echo "ERROR: bundle not found: $BUNDLE" >&2
  exit 1
fi
SIDECAR="$BUNDLE.sha256"
if [ ! -f "$SIDECAR" ]; then
  echo "ERROR: sha256 sidecar not found: $SIDECAR" >&2
  exit 1
fi
DEPLOY_OFFLINE="$REPO_ROOT/scripts/deploy-offline.sh"
if [ ! -f "$DEPLOY_OFFLINE" ]; then
  echo "ERROR: deploy-offline.sh not found at $DEPLOY_OFFLINE" >&2
  exit 1
fi

bundle_name="$(basename "$BUNDLE")"
local_sha="$(cut -d ' ' -f1 "$SIDECAR")"
local_size="$(wc -c < "$BUNDLE" | tr -d ' ')"
case "$local_sha" in ''|*[!a-f0-9]*) echo "ERROR: invalid bundle digest" >&2; exit 1 ;; esac
[ "${#local_sha}" -eq 64 ] || { echo "ERROR: invalid bundle digest" >&2; exit 1; }
[ "$(sha256sum "$BUNDLE" | cut -d ' ' -f1)" = "$local_sha" ] || { echo "ERROR: local bundle digest mismatch" >&2; exit 1; }
# Resumption is keyed by content, not the source label (GUI inputs can differ).
remote_bundle="$REMOTE_TMP/osi-deploy-bundles/$local_sha/bundle.tar.gz"

remote_run() {
  # A single remote command per invocation, matching the "no interactive
  # session" streaming model. Word-splitting of "$@" into one shell command
  # string is intentional here (ssh's argv already concatenates argv[1:]).
  "$SSH_CMD" "$HOST" "$@"
}

remote_size() {
  # Braces + a leading redirect on the whole group, not a trailing one on the
  # simple command: if the `< file` open itself fails, a trailing
  # `2>/dev/null` never gets applied in time to swallow the shell's own
  # "No such file or directory" diagnostic (redirections apply in written
  # order; the failing one fires before a later one is even set up).
  remote_run "{ wc -c < '$remote_bundle'; } 2>/dev/null || echo 0"
}

remote_sha() {
  remote_run "{ sha256sum '$remote_bundle'; } 2>/dev/null | cut -d ' ' -f1"
}

echo "=== Push deploy bundle to $HOST ==="
echo "Bundle: $BUNDLE ($local_size bytes, sha256 $local_sha)"

attempt=1
uploaded_ok=0
while [ "$attempt" -le "$MAX_ATTEMPTS" ]; do
  echo "--- Upload attempt $attempt/$MAX_ATTEMPTS ---"

  existing_size="$(remote_size | tr -d '[:space:]')"
  case "$existing_size" in
    ''|*[!0-9]*) existing_size=0 ;;
  esac

  if [ "$existing_size" -ge "$local_size" ] && [ "$existing_size" -gt 0 ]; then
    existing_sha="$(remote_sha)"
    if [ "$existing_sha" = "$local_sha" ]; then
      echo "OK: remote bundle already present and sha256-verified; skipping upload"
      uploaded_ok=1
      break
    fi
    echo "Remote file present but sha256 mismatch (or oversized); restarting from scratch"
    remote_run "rm -f '$remote_bundle'"
    existing_size=0
  fi

  if [ "$existing_size" -gt 0 ]; then
    echo "Resuming upload from byte $existing_size (of $local_size)"
    if ! tail -c "+$((existing_size + 1))" "$BUNDLE" | remote_run "cat >> '$remote_bundle'"; then
      echo "WARN: resumed upload attempt $attempt failed; will retry" >&2
      attempt=$((attempt + 1))
      continue
    fi
  else
    echo "Uploading $local_size bytes"
    if ! remote_run "umask 077; mkdir -p '${remote_bundle%/*}' && cat > '$remote_bundle'" < "$BUNDLE"; then
      echo "WARN: upload attempt $attempt failed; will retry" >&2
      attempt=$((attempt + 1))
      continue
    fi
  fi

  final_sha="$(remote_sha)"
  if [ "$final_sha" = "$local_sha" ]; then
    echo "OK: remote sha256 verified after upload"
    uploaded_ok=1
    break
  fi

  echo "WARN: remote sha256 ($final_sha) did not match local ($local_sha) after attempt $attempt; will retry" >&2
  attempt=$((attempt + 1))
done

if [ "$uploaded_ok" != "1" ]; then
  echo "ERROR: failed to upload a verified bundle to $HOST after $MAX_ATTEMPTS attempt(s)" >&2
  exit 1
fi

# Each invocation owns a private launcher set. A concurrent push can neither
# truncate these files nor replace the digest passed to this supervisor.
remote_run "mkdir -p '$REMOTE_TMP'"
remote_launch_dir="$(remote_run "umask 077; mktemp -d '$REMOTE_TMP/osi-deploy-run.XXXXXX'")"
[ -n "$remote_launch_dir" ] || { echo 'ERROR: no private launcher directory' >&2; exit 1; }
for companion in deploy-offline-runtime.js deploy-archive.js deploy-local-server.js; do
  [ -f "$REPO_ROOT/scripts/$companion" ] || { echo "ERROR: missing launcher companion $companion" >&2; exit 1; }
  remote_run "umask 077; cat > '$remote_launch_dir/$companion.part' && mv '$remote_launch_dir/$companion.part' '$remote_launch_dir/$companion'" < "$REPO_ROOT/scripts/$companion"
done
echo "--- Push deploy-offline.sh ---"
remote_offline="$remote_launch_dir/deploy-offline.sh"
remote_run "umask 077; cat > '$remote_offline.part' && mv '$remote_offline.part' '$remote_offline' && chmod 700 '$remote_offline'" < "$DEPLOY_OFFLINE"
echo "OK"

echo "--- Launch deploy-offline.sh on $HOST ---"
remote_cmd="sh '$remote_offline' '$remote_bundle' --expected-sha256 '$local_sha'"
for arg in "${DEPLOY_OFFLINE_ARGS[@]+"${DEPLOY_OFFLINE_ARGS[@]}"}"; do
  remote_cmd="$remote_cmd '$arg'"
done
remote_run "$remote_cmd"
