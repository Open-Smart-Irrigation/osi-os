#!/bin/sh
set -eu

# Hermetic image-boot guard smoke test.  It deliberately runs the ROM scripts
# against a private root and never invokes a real reboot, service, or gateway.
REPO_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
BOUNDARY="/tmp/osi-image-guard-tests-$(id -u)"
mkdir -p "$BOUNDARY"
chmod 700 "$BOUNDARY"
CASE=$(mktemp -d "$BOUNDARY/case-XXXXXX")
trap 'rm -rf "$CASE"' EXIT HUP INT TERM

copy_profile() {
    profile=$1
    source="$REPO_ROOT/conf/full_raspberrypi_bcm27xx_${profile}/files"
    rom="$CASE/$profile/rom"
    data="$CASE/$profile/data"
    run="$CASE/$profile/run"
    mkdir -p "$rom" "$data" "$run"
    for rel in \
        usr/share/osi-deploy/image-guard-manifest.json \
        usr/share/osi-deploy/factory-image-provenance.json \
        usr/share/db/farming.db \
        etc/uci-defaults/93_osi_deploy_guard_init \
        etc/uci-defaults/97_osi_db_seed \
        usr/libexec/osi-deployment-state-cli.js \
        usr/libexec/osi-factory-image-provenance-cli.js \
        usr/libexec/osi-factory-database-seed-cli.js \
        usr/libexec/osi-audit-command-ack-state.js \
        usr/libexec/osi-sync-protocol-capability-cli.js; do
        mkdir -p "$rom/$(dirname "$rel")"
        cp "$source/$rel" "$rom/$rel"
    done
    # The provenance CLI checks this resident copy as a trusted candidate.
    mkdir -p "$rom/usr/libexec"
    cp "$source/usr/libexec/osi-factory-image-provenance.js" "$rom/usr/libexec/osi-factory-image-provenance.js"
    chmod 700 "$data" "$run"

    # Commit 1 intentionally rejects image-baseline verbs.  The real ROM
    # script must fail before creating state/database; commit 4 supplies the
    # state verb.
    status=0
    OSI_REPAIR_PROGRAM_MODE=1 OSI_DEPLOY_ARTIFACT_MODE=test \
    OSI_ROM_ROOT="$rom" OSI_DATA_ROOT="$data" OSI_RUN_ROOT="$run" \
    OSI_IMAGE_PROFILE="$profile" OSI_REBOOT_COMMAND=false \
        sh "$rom/etc/uci-defaults/93_osi_deploy_guard_init" >/dev/null 2>"$CASE/$profile/err" || status=$?
    [ "$status" -ne 0 ] || { echo "93 unexpectedly succeeded before image-baseline verb" >&2; exit 1; }
    [ ! -e "$data/osi-deploy" ] || { echo "93 created state after fail-closed rejection" >&2; exit 1; }
    [ ! -e "$data/db/farming.db" ] || { echo "93 created database after fail-closed rejection" >&2; exit 1; }

    # Exercise the same first-boot argv with a private state adapter. This
    # models the later image-baseline verb without granting the fixture any
    # service, reboot, network, or application authority.
    cat > "$CASE/$profile/state-adapter.js" <<'EOF'
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args[0] !== 'initialize-image-baseline') process.exit(2);
function value(name) { const i = args.indexOf(name); return i < 0 ? null : args[i + 1]; }
const state = value('--state');
if (!state || !path.isAbsolute(state)) process.exit(3);
const data = path.dirname(path.dirname(state));
fs.mkdirSync(path.dirname(state), { recursive: true, mode: 0o700 });
fs.mkdirSync(path.join(data, 'db'), { recursive: true, mode: 0o700 });
fs.copyFileSync(path.join(process.env.OSI_ROM_ROOT, 'usr/share/db/farming.db'), path.join(data, 'db/farming.db'));
fs.writeFileSync(state, JSON.stringify({ phase: 'image-baseline-initializing' }) + '\n', { mode: 0o600 });
EOF
    cp "$CASE/$profile/state-adapter.js" "$rom/usr/libexec/osi-deployment-state-cli.js"
    rm -rf "$data" "$run"
    mkdir -p "$data" "$run"
    status=0
    OSI_REPAIR_PROGRAM_MODE=1 OSI_DEPLOY_ARTIFACT_MODE=test \
    OSI_ROM_ROOT="$rom" OSI_DATA_ROOT="$data" OSI_RUN_ROOT="$run" \
    OSI_IMAGE_PROFILE="$profile" OSI_NODE=node OSI_REBOOT_COMMAND=false \
        sh "$rom/etc/uci-defaults/93_osi_deploy_guard_init" >/dev/null 2>"$CASE/$profile/adapter-err" || status=$?
    [ "$status" -ne 0 ] || { echo "93 unexpectedly hid reboot failure" >&2; exit 1; }
    [ -f "$data/db/farming.db" ] || { echo "state adapter did not receive seed authority" >&2; cat "$CASE/$profile/adapter-err" >&2; exit 1; }
    [ -f "$data/osi-deploy/deployment-state.json" ] || { echo "state adapter did not publish initializing state" >&2; exit 1; }

    # 97 is idempotent and never overwrites an existing database.
    printf 'sentinel' > "$data/db/farming.db"
    before=$(sha256sum "$data/db/farming.db" | awk '{print $1}')
    OSI_REPAIR_PROGRAM_MODE=1 OSI_DEPLOY_ARTIFACT_MODE=test \
    OSI_ROM_ROOT="$rom" OSI_DATA_ROOT="$data" OSI_IMAGE_PROFILE="$profile" \
        sh "$rom/etc/uci-defaults/97_osi_db_seed"
    after=$(sha256sum "$data/db/farming.db" | awk '{print $1}')
    [ "$before" = "$after" ] || { echo "97 overwrote an existing database" >&2; exit 1; }
}

for profile in bcm2712 bcm2709; do copy_profile "$profile"; done

# The image build must preserve the exact shared initializer/bootstrap bytes.
cmp "$REPO_ROOT/conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/uci-defaults/93_osi_deploy_guard_init" \
    "$REPO_ROOT/conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/uci-defaults/93_osi_deploy_guard_init"
cmp "$REPO_ROOT/conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/uci-defaults/97_osi_db_seed" \
    "$REPO_ROOT/conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/uci-defaults/97_osi_db_seed"
node "$REPO_ROOT/scripts/verify-factory-image-provenance.js" >/dev/null
echo "test-image-guard-bootstrap: PASS"
