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

                   # 1. Go to Workspace Root to handle submodules/configs
                   cd ${WORKSPACE}

                   # Create log directories
                   mkdir -p logs
                   mkdir -p output/logs

                   # Initialize submodules if needed
                   if [ ! -f .initialized ]; then git submodule update --init --recursive; touch .initialized; fi

                   # Reset Configs (Symlinking from your config folder)
                   rm -f openwrt/.config openwrt/files openwrt/patches
                   ln -s ../conf/.config openwrt/.config
                   ln -s ../conf/files openwrt/files
                   ln -s ../conf/patches openwrt/patches

                   # 2. Switch Environment (Make changes in root, often runs make in openwrt)
                   make QUILT_PATCHES=patches switch-env ENV=${TARGET_ENV}

                   # Fix Feeds Path
                   cp feeds.conf.default openwrt/feeds.conf.default
                   sed -i "s|/workdir|${WORKSPACE}|g" openwrt/feeds.conf.default

                   # 3. ENTER OPENWRT DIRECTORY (This was missing!)
                   cd openwrt

                   # Update & Install Feeds
                   ./scripts/feeds update -a
                   ./scripts/feeds install -a

                   # === GLOBAL FIX for duplicate --locked flags ===
                   # We are now inside 'openwrt/', so 'feeds/' is a valid relative path.
                   echo "Applying global fix for duplicate --locked flag..."
                    find feeds/chirpstack -name "Makefile" -exec sed -i 's/--locked//g' {} +
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

                    # Verify build output
                    if [ -f "${WORKSPACE}/feeds/chirpstack-openwrt-feed/apps/node-red/files/gui/index.html" ]; then
                        echo "✓ React GUI built successfully"
                    else
                        echo "❌ Build failed - index.html not found"
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
                    
                    echo "=== Compiling Rust (Source Mode) ==="
                    echo "Detected 8GB RAM + Swap. Throttling build to prevent OOM."
                    
                    # We use -j2 here to match the exports above. 
                    # -j1 is too safe/slow, -j4 might crash. -j2 is the sweet spot for 24GB virt mem.
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
