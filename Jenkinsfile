pipeline {
    agent any

    parameters {
        choice(
            name: 'TARGET_ENV',
            choices: [
                'full_raspberrypi_bcm27xx_bcm2712',
                'full_raspberrypi_bcm27xx_bcm2711'
            ],
            description: 'Target platform (bcm2712 = Pi 5 [default], bcm2711 = Pi 4)'
        )
        booleanParam(
            name: 'CLEAN_BUILD',
            defaultValue: false,
            description: 'Clean before build (full rebuild from scratch)'
        )
    }

    options {
        buildDiscarder(logRotator(numToKeepStr: '5'))
        timestamps()
    }

    stages {
        stage('1. Verify Docker Tools') {
            steps {
                sh '''#!/bin/bash
                    set -e
                    echo "=== Verifying Container Dependencies ==="

                    MISSING=0
                    for cmd in pkg-config clang node npm; do
                        if ! command -v "$cmd" > /dev/null 2>&1; then
                            echo "❌ CRITICAL: '$cmd' is missing!"
                            MISSING=1
                        else
                            echo "✓ $cmd: $($cmd --version 2>&1 | head -1)"
                        fi
                    done

                    if [ "$MISSING" -eq 1 ]; then
                        echo "Current PATH: $PATH"
                        exit 1
                    fi

                    # rustc is built from source by OpenWrt (stage 7), just report if present
                    if command -v rustc > /dev/null 2>&1; then
                        echo "✓ rustc (pre-installed): $(rustc --version)"
                    else
                        echo "- rustc: not pre-installed (will be built from source)"
                    fi

                    # Disk space check
                    AVAIL_KB=$(df -k "${WORKSPACE}" | tail -1 | awk '{print $4}')
                    AVAIL_GB=$((AVAIL_KB / 1024 / 1024))
                    echo "Available disk space: ${AVAIL_GB}GB"
                    if [ "$AVAIL_GB" -lt 20 ]; then
                        echo "⚠️ WARNING: Less than 20GB free — build may fail"
                    fi

                    echo "✓ Docker environment looks good."
                '''
            }
        }

        stage('2. Initialize') {
            steps {
                sh '''#!/bin/bash
                    set -e
                    set -o pipefail
                    cd ${WORKSPACE}

                    # 1. Create logs directory first (used by all subsequent stages)
                    mkdir -p ${WORKSPACE}/logs

                    # 2. Clean build if requested
                    if [ "${CLEAN_BUILD}" = "true" ]; then
                        echo "=== CLEAN BUILD requested — cleaning OpenWrt ==="
                        cd openwrt
                        make clean 2>&1 | tee ${WORKSPACE}/logs/clean.log || true
                        cd ${WORKSPACE}
                    fi

                    # 3. Initialize git submodules (OpenWrt source)
                    echo "=== Initializing git submodules ==="
                    git submodule init
                    git submodule update
                    echo "✓ Git submodules initialized"

                    # 4. Enter OpenWrt directory
                    cd openwrt

                    # 5. Copy .config from target environment
                    echo "=== Copying .config for ${TARGET_ENV} ==="
                    cp ${WORKSPACE}/conf/${TARGET_ENV}/.config .config
                    echo "✓ .config copied from conf/${TARGET_ENV}/"

                    # 6. Set up files/ symlink for target-specific overlay
                    echo "=== Setting up files overlay ==="
                    rm -f files
                    ln -sf ${WORKSPACE}/conf/${TARGET_ENV}/files files
                    echo "✓ files/ symlinked to conf/${TARGET_ENV}/files/"

                    # 7. Configure feeds (NO custom-feed — it doesn't exist)
                    echo "=== Configuring feeds ==="
                    cat > feeds.conf << EOF
src-git packages https://git.openwrt.org/feed/packages.git^d8cd30f4e281d6853b3de134c4f147a807583e43
src-git luci https://git.openwrt.org/project/luci.git^2ac26e56cc55102cb10e7b0867c2b78e0f6d5fd8
src-git routing https://git.openwrt.org/feed/routing.git^c9b636698881059a3c981032770968f5a98ff201
src-link chirpstack ${WORKSPACE}/feeds/chirpstack-openwrt-feed
EOF
                    echo "✓ Created feeds.conf (no custom-feed)"

                    # 8. Update & install feeds
                    echo "=== Updating feeds ==="
                    ./scripts/feeds update -a 2>&1 | tee ${WORKSPACE}/logs/feeds_update.log
                    ./scripts/feeds install -a 2>&1 | tee ${WORKSPACE}/logs/feeds_install.log
                    echo "✓ Feeds updated and installed"

                    # 9. Apply patches from target config
                    # Patches use openwrt/ prefix, so apply from workspace root
                    cd ${WORKSPACE}
                    PATCH_DIR="${WORKSPACE}/conf/${TARGET_ENV}/patches"
                    if [ -d "$PATCH_DIR" ] && [ -f "$PATCH_DIR/series" ]; then
                        echo "=== Applying patches from ${TARGET_ENV} ==="
                        while IFS= read -r patchfile; do
                            # Skip empty lines and comments
                            case "$patchfile" in ''|\#*) continue ;; esac
                            echo "Applying $patchfile..."
                            if ! patch -p0 --forward -i "$PATCH_DIR/$patchfile"; then
                                # --forward returns 1 if already applied
                                echo "  (patch already applied or skipped)"
                            fi
                        done < "$PATCH_DIR/series"
                        echo "✓ Patches applied"
                    else
                        echo "⚠️ No patches directory or series file for ${TARGET_ENV}"
                    fi
                    cd ${WORKSPACE}/openwrt

                    # 10. Fix: Remove --locked flag from Chirpstack Makefile
                    echo "=== Removing --locked flag from Chirpstack Makefile ==="
                    TARGET_MK="${WORKSPACE}/feeds/chirpstack-openwrt-feed/chirpstack/chirpstack/Makefile"
                    if [ -f "$TARGET_MK" ]; then
                        sed -i 's/ --locked//g' "$TARGET_MK"
                        sed -i 's/--locked//g' "$TARGET_MK"
                        if grep -q -- "--locked" "$TARGET_MK"; then
                            echo "⚠️ WARNING: --locked still present in $TARGET_MK"
                        else
                            echo "✓ Removed --locked from Chirpstack Makefile"
                        fi
                    else
                        echo "❌ Chirpstack Makefile not found at $TARGET_MK"
                        find ${WORKSPACE}/feeds -name "Makefile" -type f | grep chirpstack | head -10
                        exit 1
                    fi

                    # 11. Generate defconfig (TERM=dumb avoids 'Error opening terminal' in headless CI)
                    echo "=== Running make defconfig ==="
                    TERM=dumb make defconfig 2>&1 | tee ${WORKSPACE}/logs/defconfig.log
                    echo "✓ Initialization complete"
                '''
            }
        }

        stage('3. Build React GUI') {
            steps {
                sh '''#!/bin/bash
                    set -e
                    cd ${WORKSPACE}/web/react-gui
                    echo "=== Building Open Smart Irrigation React Application ==="

                    if ! command -v node > /dev/null 2>&1; then
                        echo "❌ Node.js is not installed"
                        exit 1
                    fi

                    echo "Node version: $(node --version)"
                    echo "npm version: $(npm --version)"

                    # Install dependencies
                    echo "Installing dependencies..."
                    npm install

                    # Build the React application
                    echo "Building React application..."
                    npm run build

                    # Verify build output in dist directory
                    if [ ! -f "dist/index.html" ]; then
                        echo "❌ Build failed - index.html not found in dist"
                        exit 1
                    fi

                    # Copy built GUI to chirpstack location
                    echo "Copying GUI build to chirpstack location..."
                    TARGET_DIR="${WORKSPACE}/feeds/chirpstack-openwrt-feed/apps/node-red/files/gui"
                    mkdir -p "$TARGET_DIR"
                    cp -r dist/* "$TARGET_DIR/"

                    if [ -f "$TARGET_DIR/index.html" ]; then
                        echo "✓ React GUI built and copied successfully"
                    else
                        echo "❌ Copy failed - index.html not found in target directory"
                        exit 1
                    fi
                '''
            }
        }

        stage('4. Force Node-RED Rebuild') {
            steps {
                sh '''#!/bin/bash
                    set -e
                    cd ${WORKSPACE}/openwrt

                    echo "=== Forcing Node-RED to rebuild with updated GUI ==="
                    [ -d build_dir ] && rm -rf build_dir/target-*/node-red* || true
                    [ -d build_dir ] && rm -rf build_dir/target-*/packages/node-red* || true
                    [ -d staging_dir ] && find staging_dir -name "node-red" -type d -exec rm -rf {} + 2>/dev/null || true

                    echo "✓ Node-RED build cache cleared"
                '''
            }
        }

        stage('5. Prepare Rust (Auto-Fix)') {
            steps {
                sh '''#!/bin/bash
                    set -e
                    cd ${WORKSPACE}/openwrt

                    echo "=== Applying Rust Artifact Fix ==="
                    sed -i 's/llvm.download-ci-llvm=true/llvm.download-ci-llvm=false/g' feeds/packages/lang/rust/Makefile

                    # Only clear Rust stamp files on clean builds
                    if [ "${CLEAN_BUILD}" = "true" ]; then
                        echo "=== Clean build: clearing Rust stamp files ==="
                        [ -d staging_dir ] && find staging_dir -path "*rust*" -name ".built" -delete 2>/dev/null || true
                        [ -d staging_dir ] && find staging_dir -path "*rust*" -name ".prepared" -delete 2>/dev/null || true
                        [ -d build_dir ] && find build_dir -path "*rust*" -name ".built" -delete 2>/dev/null || true
                        [ -d build_dir ] && rm -rf build_dir/host/rust* || true
                    else
                        echo "Incremental build: keeping existing Rust artifacts"
                    fi
                '''
            }
        }

        stage('6. Build Toolchain') {
            steps {
                sh '''#!/bin/bash
                    set -e
                    set -o pipefail
                    export FORCE_UNSAFE_CONFIGURE=1
                    cd ${WORKSPACE}/openwrt

                    echo "=== Building Toolchain ==="
                    if ! make -j2 toolchain/compile V=s 2>&1 | tee ${WORKSPACE}/logs/toolchain.log; then
                        echo "❌ Toolchain build failed — check logs/toolchain.log"
                        tail -50 ${WORKSPACE}/logs/toolchain.log
                        exit 1
                    fi

                    echo "✓ Toolchain built successfully."
                '''
            }
        }

        stage('7. Compile Rust') {
            steps {
                sh '''#!/bin/bash
                    set -e
                    set -o pipefail
                    export FORCE_UNSAFE_CONFIGURE=1

                    # --- CRITICAL MEMORY SETTINGS ---
                    export CARGO_BUILD_JOBS=2
                    export CMAKE_BUILD_PARALLEL_LEVEL=2

                    cd ${WORKSPACE}/openwrt

                    echo "=== Compiling Rust (Source Mode) ==="
                    echo "Memory limits: CARGO_BUILD_JOBS=2, CMAKE_BUILD_PARALLEL_LEVEL=2"

                    if ! make package/feeds/packages/rust/compile -j2 V=s 2>&1 | tee ${WORKSPACE}/logs/rust_verbose.log; then
                        echo ""
                        echo "❌❌❌ RUST FAILED ❌❌❌"
                        echo "The error log is printed above."
                        exit 1
                    fi

                    echo "✓ Rust compiled successfully."
                '''
            }
        }

        stage('8. Build Chirpstack Dependencies') {
            steps {
                sh '''#!/bin/bash
                    set -e
                    set -o pipefail
                    export FORCE_UNSAFE_CONFIGURE=1

                    cd ${WORKSPACE}/openwrt

                    echo "=== Building Chirpstack Dependencies ==="

                    echo "Building protobuf/host..."
                    if ! make package/feeds/packages/protobuf/host/compile -j2 V=s 2>&1 | tee ${WORKSPACE}/logs/protobuf_host.log; then
                        echo "❌ protobuf/host failed — check logs/protobuf_host.log"
                        tail -50 ${WORKSPACE}/logs/protobuf_host.log
                        exit 1
                    fi

                    echo "Building node-yarn/host..."
                    if ! make package/feeds/packages/node-yarn/host/compile -j2 V=s 2>&1 | tee ${WORKSPACE}/logs/node_yarn_host.log; then
                        echo "❌ node-yarn/host failed — check logs/node_yarn_host.log"
                        tail -50 ${WORKSPACE}/logs/node_yarn_host.log
                        exit 1
                    fi

                    echo "✓ Chirpstack dependencies built successfully."
                '''
            }
        }

        stage('9. Compile Chirpstack') {
            steps {
                sh '''#!/bin/bash
                    set -e
                    set -o pipefail
                    export FORCE_UNSAFE_CONFIGURE=1
                    export CARGO_BUILD_JOBS=2
                    export CMAKE_BUILD_PARALLEL_LEVEL=2
                    cd ${WORKSPACE}/openwrt
                    echo "=== Compiling Chirpstack (Verbose Mode) ==="
                    echo "Memory limits: CARGO_BUILD_JOBS=2, CMAKE_BUILD_PARALLEL_LEVEL=2"

                    # --- FIX: home@0.5.12 requires rustc 1.88, but we have 1.85 ---
                    echo "Preparing chirpstack source..."
                    make package/feeds/chirpstack/chirpstack/prepare -j1 V=s 2>&1 | tee ${WORKSPACE}/logs/chirpstack_prepare.log

                    # Find the extracted Cargo.lock and downgrade 'home' crate
                    CARGO_LOCK=$(find build_dir -name "Cargo.lock" -path "*/chirpstack-*/chirpstack/*" 2>/dev/null | head -1)
                    if [ -n "$CARGO_LOCK" ]; then
                        SRC_DIR=$(dirname "$CARGO_LOCK")
                        echo "Patching home crate in $SRC_DIR"
                        HOST_CARGO=$(find staging_dir/host -name "cargo" -type f 2>/dev/null | head -1)
                        if [ -z "$HOST_CARGO" ]; then
                            echo "❌ Could not find host cargo binary"
                            exit 1
                        fi
                        cd "$SRC_DIR"
                        "$HOST_CARGO" update home --precise 0.5.11
                        cd ${WORKSPACE}/openwrt
                        echo "✓ home crate pinned to 0.5.11"
                    else
                        echo "❌ Could not find Cargo.lock in chirpstack build dir"
                        exit 1
                    fi

                    # Compile chirpstack
                    if ! make package/feeds/chirpstack/chirpstack/compile -j1 V=s 2>&1 | tee ${WORKSPACE}/logs/chirpstack_build.log; then
                        echo ""
                        echo "❌❌❌ CHIRPSTACK COMPILATION FAILED ❌❌❌"
                        echo "Full log saved to: logs/chirpstack_build.log"
                        echo ""
                        echo "=== Last 100 lines of error log ==="
                        tail -100 ${WORKSPACE}/logs/chirpstack_build.log
                        exit 1
                    fi
                    echo "✓ Chirpstack compiled successfully."
                '''
            }
        }

        stage('10. Finish Firmware') {
            steps {
                sh '''#!/bin/bash
                    set -e
                    set -o pipefail
                    cd ${WORKSPACE}/openwrt

                    echo "=== Building Final Image (Verbose Mode) ==="

                    if ! make -j1 V=s world 2>&1 | tee ${WORKSPACE}/logs/build_main.log; then
                        echo "❌ Firmware build failed!"
                        exit 1
                    fi

                    echo "✓ Firmware built successfully."
                '''
            }
        }

        stage('11. Verify Artifacts') {
            steps {
                sh '''#!/bin/bash
                    set -e
                    cd ${WORKSPACE}

                    echo "=== Verifying Build Artifacts ==="

                    IMAGES=$(find openwrt/bin/targets -name "*.img.gz" -o -name "*.img" -o -name "*.bin" 2>/dev/null | wc -l)

                    if [ "$IMAGES" -eq 0 ]; then
                        echo "❌ CRITICAL ERROR: No firmware images found!"
                        echo "Expected files in: openwrt/bin/targets/"
                        ls -R openwrt/bin/targets/ || echo "Directory does not exist"
                        exit 1
                    fi

                    echo "✓ Found $IMAGES firmware image(s)"
                    find openwrt/bin/targets -name "*.img.gz" -o -name "*.img" -o -name "*.bin"
                '''
            }
        }

        stage('12. Archive') {
            steps {
                archiveArtifacts artifacts: 'openwrt/bin/targets/**/*.img.gz, openwrt/bin/targets/**/*.img, openwrt/bin/targets/**/*.bin', allowEmptyArchive: false
            }
        }

    }

    post {
        always {
            archiveArtifacts artifacts: 'logs/*.log', allowEmptyArchive: true, fingerprint: true
        }
        failure {
            echo '❌ Build failed! Check the archived logs for details.'
        }
        success {
            echo '✓ Build completed successfully!'
        }
    }
}
