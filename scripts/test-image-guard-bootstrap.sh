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
        usr/libexec/osi-deployment-state.js \
        usr/libexec/osi-factory-image-provenance-cli.js \
        usr/libexec/osi-factory-image-provenance.js \
        usr/libexec/osi-factory-database-seed.js \
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

    # 97 refuses to accept a database without the 93-owned state/receipt/
    # lineage chain; even an existing sentinel remains unchanged.
    mkdir -p "$data/db"
    printf 'sentinel' > "$data/db/farming.db"
    before=$(sha256sum "$data/db/farming.db" | awk '{print $1}')
    status=0
    OSI_REPAIR_PROGRAM_MODE=1 OSI_DEPLOY_ARTIFACT_MODE=test \
    OSI_ROM_ROOT="$rom" OSI_DATA_ROOT="$data" OSI_IMAGE_PROFILE="$profile" \
        sh "$rom/etc/uci-defaults/97_osi_db_seed" 2>/dev/null || status=$?
    [ "$status" -ne 0 ] || { echo "97 accepted a database without factory authority" >&2; exit 1; }
    after=$(sha256sum "$data/db/farming.db" | awk '{print $1}')
    [ "$before" = "$after" ] || { echo "97 overwrote an existing database" >&2; exit 1; }

    # A minimal/forged phase marker cannot stand in for the exact valid parent
    # lineage and helper-owned publication chain.
    mkdir -p "$data/osi-deploy/receipts"
    printf '%s\n' '{"phase":"image-baseline-initializing"}' > "$data/osi-deploy/deployment-state.json"
    printf '%s\n' '{}' > "$data/osi-deploy/receipts/factory-seed.json"
    printf '%s\n' '{}' > "$data/osi-deploy/database-lineage.json"
    chmod 600 "$data/osi-deploy/deployment-state.json" "$data/osi-deploy/receipts/factory-seed.json" "$data/osi-deploy/database-lineage.json"
    status=0
    OSI_REPAIR_PROGRAM_MODE=1 OSI_DEPLOY_ARTIFACT_MODE=test \
    OSI_ROM_ROOT="$rom" OSI_DATA_ROOT="$data" OSI_IMAGE_PROFILE="$profile" \
        sh "$rom/etc/uci-defaults/97_osi_db_seed" 2>/dev/null || status=$?
    [ "$status" -ne 0 ] || { echo "97 accepted a forged minimal baseline state" >&2; exit 1; }
}

for profile in bcm2712 bcm2709; do copy_profile "$profile"; done

# The image build must preserve the exact shared initializer/bootstrap bytes.
cmp "$REPO_ROOT/conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/uci-defaults/93_osi_deploy_guard_init" \
    "$REPO_ROOT/conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/uci-defaults/93_osi_deploy_guard_init"
cmp "$REPO_ROOT/conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/uci-defaults/97_osi_db_seed" \
    "$REPO_ROOT/conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/uci-defaults/97_osi_db_seed"
node "$REPO_ROOT/scripts/verify-factory-image-provenance.js" >/dev/null
echo "test-image-guard-bootstrap: PASS"
