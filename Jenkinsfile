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
                    if [ ! -f .initialized ]; then git submodule update --init --recursive; touch .initialized; fi
                    
                    # Reset Configs
                    rm -f openwrt/.config openwrt/files openwrt/patches
                    ln -s ../conf/.config openwrt/.config
                    ln -s ../conf/files openwrt/files
                    ln -s ../conf/patches openwrt/patches
                    
                    make QUILT_PATCHES=patches switch-env ENV=${TARGET_ENV}
                    
                    # Fix Feeds Path
                    cp feeds.conf.default openwrt/feeds.conf.default
                    sed -i "s|/workdir|${WORKSPACE}|g" openwrt/feeds.conf.default
                    
                    cd openwrt
                    ./scripts/feeds update -a
                    ./scripts/feeds install -a
                    make defconfig > ../logs/defconfig.log 2>&1
                '''
            }
        }

          stage('3. Prepare Rust (Auto-Fix)') {
            steps {
                sh '''#!/bin/bash
                    set -e
                    cd ${WORKSPACE}/openwrt
                    
                    echo "=== Applying Rust Artifact Fix ==="
                    # FIX: Disable downloading expired CI artifacts
                    sed -i 's/llvm.download-ci-llvm=true/llvm.download-ci-llvm=false/g' feeds/packages/lang/rust/Makefile
                    
                    echo "=== Ensuring Rust Rebuilds ==="
                    find staging_dir -path "*rust*" -name ".built" -delete
                    find staging_dir -path "*rust*" -name ".prepared" -delete
                    find build_dir -path "*rust*" -name ".built" -delete
                    rm -rf build_dir/host/rust*
                '''
            }
        }

        stage('4. Compile Rust') {
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


        stage('5. Finish Firmware') {
            steps {
                sh '''#!/bin/bash
                    set -e
                    export FORCE_UNSAFE_CONFIGURE=1
                    cd ${WORKSPACE}/openwrt
                    
                    echo "=== Building Final Image ==="
                    make -j1 world 2>&1 | tee ../logs/build_main.log
                '''
            }
        }
        
        stage('Archive') {
            steps {
                archiveArtifacts artifacts: 'openwrt/bin/targets/**/*.img.gz, openwrt/bin/targets/**/*.img, openwrt/bin/targets/**/*.bin, output/logs/*.log', allowEmptyArchive: true
            }
        }

    }
}
