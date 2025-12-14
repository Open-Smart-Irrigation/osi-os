pipeline {
    agent any
    
    parameters {
        choice(
            name: 'TARGET_ENV',
            choices: [
                'full_raspberrypi_bcm27xx_bcm2711',
                'full_raspberrypi_bcm27xx_bcm2712'
            ],
            description: 'Target platform (bcm2711 = Pi 4, bcm2712 = Pi 5)'
        )
        booleanParam(
            name: 'CLEAN_BUILD',
            defaultValue: false,
            description: 'Clean before build (UNCHECK THIS)'
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
                    echo "=== Verifying Container Dependencies ==="
                    
                    # Fixed: Use standard redirection or force bash
                    if ! command -v pkg-config > /dev/null 2>&1; then
                        echo "❌ CRITICAL ERROR: 'pkg-config' is missing!"
                        echo "Current PATH: $PATH"
                        exit 1
                    fi
                    
                    if ! command -v clang > /dev/null 2>&1; then
                        echo "❌ CRITICAL ERROR: 'clang' is missing!"
                        exit 1
                    fi
                    
                    echo "✓ Docker environment looks good."
                '''
            }
        }

              stage('2. Initialize') {
                  steps {
                      sh '''#!/bin/bash
                          set -e
                          cd ${WORKSPACE}

                          # ... [Keep your existing init logic up to feeds update] ...

                          # 3. ENTER OPENWRT DIRECTORY
                          cd openwrt

                          # Fix feeds.conf to use correct workspace paths
                          echo "=== Configuring feeds with correct workspace paths ==="
                          cat > feeds.conf << EOF
src-git packages https://git.openwrt.org/feed/packages.git^d8cd30f4e281d6853b3de134c4f147a807583e43
src-git luci https://git.openwrt.org/project/luci.git^2ac26e56cc55102cb10e7b0867c2b78e0f6d5fd8
src-git routing https://git.openwrt.org/feed/routing.git^c9b636698881059a3c981032770968f5a98ff201
src-link chirpstack ${WORKSPACE}/feeds/chirpstack-openwrt-feed
src-link custom ${WORKSPACE}/feeds/custom-feed
EOF
                          echo "✓ Created feeds.conf with workspace paths"

                          # Update & Install Feeds
                          ./scripts/feeds update -a
                          ./scripts/feeds install -a

                          # === FIX: Remove Duplicate --locked Flag ===
                          # We target the source file in feeds/ which is symlinked to package/
                          echo "Applying fix for duplicate --locked flag in Chirpstack..."

                          # Target the specific Chirpstack Makefile
                          TARGET_MK="feeds/chirpstack/chirpstack/Makefile"

                          if [ -f "$TARGET_MK" ]; then
                              echo "Found $TARGET_MK. removing --locked..."
                              # Remove --locked if it appears with a space before it
                              sed -i 's/ --locked//g' "$TARGET_MK"
                              # Remove --locked if it appears at start of value or without space
                              sed -i 's/--locked//g' "$TARGET_MK"

                              # Verification
                              if grep -q "--locked" "$TARGET_MK"; then
                                  echo "⚠️ WARNING: --locked still present in $TARGET_MK"
                                  grep "--locked" "$TARGET_MK"
                              else
                                  echo "✓ Successfully removed --locked from $TARGET_MK"
                              fi
                          else
                              echo "❌ Error: Could not find Chirpstack Makefile at $TARGET_MK"
                              # Fallback search to debug
                              find feeds -name "Makefile" -print0 | xargs -0 grep -l "chirpstack"
                          fi

                          # Generate Config
                          make defconfig > ../logs/defconfig.log 2>&1
                      '''
                  }
              }

        stage('3. Build React GUI') {
            steps {
                sh '''#!/bin/bash
                    set -e
                    cd ${WORKSPACE}/web/react-gui
                    echo "=== Building Open Smart Irrigation React Application ==="

                    # Check if Node.js is available
                    if ! command -v node > /dev/null 2>&1; then
                        echo "❌ Node.js is not installed"
                        exit 1
                    fi

                    # Check if npm is available
                    if ! command -v npm > /dev/null 2>&1; then
                        echo "❌ npm is not installed"
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

                    # Verify copy was successful
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
                    # Clean node-red package to force rebuild with new React files (safe for clean builds)
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
                    # FIX: Disable downloading expired CI artifacts
                    sed -i 's/llvm.download-ci-llvm=true/llvm.download-ci-llvm=false/g' feeds/packages/lang/rust/Makefile

                    echo "=== Ensuring Rust Rebuilds ==="
                    # Only clean if directories exist (safe for clean builds)
                    [ -d staging_dir ] && find staging_dir -path "*rust*" -name ".built" -delete 2>/dev/null || true
                    [ -d staging_dir ] && find staging_dir -path "*rust*" -name ".prepared" -delete 2>/dev/null || true
                    [ -d build_dir ] && find build_dir -path "*rust*" -name ".built" -delete 2>/dev/null || true
                    [ -d build_dir ] && rm -rf build_dir/host/rust* || true
                '''
            }
        }

        stage('6. Build Toolchain') {
            steps {
                sh '''#!/bin/bash
                    set -e
                    export FORCE_UNSAFE_CONFIGURE=1
                    cd ${WORKSPACE}/openwrt

                    echo "=== Building Toolchain ==="
                    # Build toolchain first (required for Rust compilation)
                    make -j2 toolchain/compile V=s 2>&1 | tee ../logs/toolchain.log

                    echo "✓ Toolchain built successfully."
                '''
            }
        }

        stage('7. Compile Rust') {
            steps {
                sh '''#!/bin/bash
                    set -e
                    export FORCE_UNSAFE_CONFIGURE=1
        
                    # --- CRITICAL MEMORY SETTINGS ---
                    # Limit Cargo (Rust) to 2 parallel jobs
                    export CARGO_BUILD_JOBS=2
                    # Limit CMake/Ninja (LLVM) to 2 parallel jobs
                    export CMAKE_BUILD_PARALLEL_LEVEL=2
        
                    cd ${WORKSPACE}/openwrt
        
                    # Fix duplicate --locked flag
                    find . -name "Makefile" -exec sed -i 's/--locked --locked/--locked/g' {} +
        
                    echo "=== Compiling Rust (Source Mode) ==="
                    echo "Detected 8GB RAM + Swap. Throttling build to prevent OOM."
        
                    if ! make package/feeds/packages/rust/compile -j2 V=s 2>&1 | tee ../logs/rust_verbose.log; then
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

                    # Build protobuf for host (required for chirpstack code generation)
                    echo "Building protobuf/host..."
                    if ! make package/feeds/packages/protobuf/host/compile -j2 V=s 2>&1 | tee ../logs/protobuf_host.log; then
                        echo "❌ protobuf/host failed - check logs/protobuf_host.log"
                        tail -50 ../logs/protobuf_host.log
                        exit 1
                    fi

                    # Build node-yarn for host (required for chirpstack UI build)
                    echo "Building node-yarn/host..."
                    if ! make package/feeds/packages/node-yarn/host/compile -j2 V=s 2>&1 | tee ../logs/node_yarn_host.log; then
                        echo "❌ node-yarn/host failed - check logs/node_yarn_host.log"
                        tail -50 ../logs/node_yarn_host.log
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
                    # --- CRITICAL MEMORY SETTINGS FOR RUST PACKAGES ---
                    export CARGO_BUILD_JOBS=2
                    export CMAKE_BUILD_PARALLEL_LEVEL=2
                    cd ${WORKSPACE}/openwrt
                    echo "=== Compiling Chirpstack (Verbose Mode) ==="
                    echo "Memory limits: CARGO_BUILD_JOBS=2, CMAKE_BUILD_PARALLEL_LEVEL=2"
        
                    # Compile chirpstack with full verbose output
                    if ! make package/feeds/chirpstack/chirpstack/compile -j1 V=s 2>&1 | tee ../logs/chirpstack_build.log; then
                        echo ""
                        echo "❌❌❌ CHIRPSTACK COMPILATION FAILED ❌❌❌"
                        echo "Full log saved to: logs/chirpstack_build.log"
                        echo ""
                        echo "=== Last 100 lines of error log ==="
                        tail -100 ../logs/chirpstack_build.log
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

                    # Ensure we are in the correct directory
                    cd ${WORKSPACE}/openwrt

                    # Ensure the log directory exists (using absolute path to be safe)
                    mkdir -p ${WORKSPACE}/logs

                    echo "=== Building Final Image (Verbose Mode) ==="

                    # Use absolute path for the log file to avoid relative path confusion
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

                    # Check for firmware images
                    IMAGES=$(find openwrt/bin/targets -name "*.img.gz" -o -name "*.img" -o -name "*.bin" 2>/dev/null | wc -l)

                    if [ "$IMAGES" -eq 0 ]; then
                        echo "❌ CRITICAL ERROR: No firmware images found!"
                        echo "Expected files in: openwrt/bin/targets/"
                        echo "Contents of bin/targets:"
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
                archiveArtifacts artifacts: 'openwrt/bin/targets/**/*.img.gz, openwrt/bin/targets/**/*.img, openwrt/bin/targets/**/*.bin, output/logs/*.log', allowEmptyArchive: false
            }
        }

    }

    post {
        always {
            // Always archive logs, even on failure
            archiveArtifacts artifacts: 'logs/*.log, output/logs/*.log', allowEmptyArchive: true, fingerprint: true
        }
        failure {
            echo '❌ Build failed! Check the archived logs for details.'
        }
        success {
            echo '✓ Build completed successfully!'
        }
    }
}
