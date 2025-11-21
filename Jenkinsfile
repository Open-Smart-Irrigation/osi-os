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
        // DEFAULT IS NOW FALSE -> WE WANT TO RESUME!
        booleanParam(
            name: 'CLEAN_BUILD',
            defaultValue: false,
            description: 'Clean before build (UNCHECK THIS TO SAVE TIME)'
        )
    }

    options {
        buildDiscarder(logRotator(numToKeepStr: '5'))
        timestamps()
        timeout(time: 12, unit: 'HOURS')
    }

    stages {
        stage('1. System Prep') {
            steps {
                sh '''
                    echo "=== Disk Space Check (CRITICAL) ==="
                    df -h
                    
                    if [ "$(id -u)" -eq 0 ]; then
                        apt-get update -q
                        apt-get install -y -q build-essential libncurses5-dev zlib1g-dev \
                            gawk git gettext libssl-dev xsltproc rsync wget unzip \
                            python3 python3-setuptools file pkg-config clang \
                            cmake curl
                    fi
                '''
            }
        }

        stage('2. Clean Workspace') {
            when { expression { params.CLEAN_BUILD } }
            steps {
                sh '''
                    # ONLY RUNS IF YOU CHECK THE BOX
                    cd ${WORKSPACE}
                    rm -rf openwrt/bin openwrt/build_dir openwrt/staging_dir openwrt/tmp
                    rm -rf logs output .initialized
                '''
            }
        }

        stage('3. Initialize & Feeds') {
            steps {
                sh '''#!/bin/bash
                    set -e
                    cd ${WORKSPACE}
                    
                    if [ ! -f .initialized ]; then
                        git submodule update --init --recursive
                        touch .initialized
                    fi
                    
                    # Refresh Feeds (Fast)
                    rm -f openwrt/.config openwrt/files openwrt/patches
                    ln -s ../conf/.config openwrt/.config
                    ln -s ../conf/files openwrt/files
                    ln -s ../conf/patches openwrt/patches
                    
                    make QUILT_PATCHES=patches switch-env ENV=${TARGET_ENV}
                    
                    cp feeds.conf.default openwrt/feeds.conf.default
                    sed -i "s|/workdir|${WORKSPACE}|g" openwrt/feeds.conf.default
                    
                    cd openwrt
                    ./scripts/feeds update -a
                    ./scripts/feeds install -a
                '''
            }
        }

        stage('4. Configuration') {
            steps {
                sh '''#!/bin/bash
                    set -e
                    export FORCE_UNSAFE_CONFIGURE=1
                    mkdir -p ${WORKSPACE}/logs
                    cd ${WORKSPACE}/openwrt
                    make defconfig > ../logs/defconfig.log 2>&1
                '''
            }
        }

        stage('5. Bootstrap Toolchain') {
            steps {
                sh '''#!/bin/bash
                    set -e
                    export FORCE_UNSAFE_CONFIGURE=1
                    cd ${WORKSPACE}/openwrt
                    
                    # Ensure toolchain is present (Should be fast if already done)
                    make -j4 tools/install toolchain/install 2>&1 | tee ../logs/toolchain_build.log
                '''
            }
        }

        stage('6. Compile Rust (HOST + TARGET)') {
            steps {
                sh '''#!/bin/bash
                    set -e
                    set -o pipefail
                    export FORCE_UNSAFE_CONFIGURE=1
                    
                    cd ${WORKSPACE}/openwrt
                    
                    echo "=============================================="
                    echo "=== STEP 6: COMPILING RUST (VERBOSE) ==="
                    echo "=============================================="
                    echo "Disk Space Remaining:"
                    df -h .
                    echo "----------------------------------------------"
                    
                    # FIX: We explicitly build HOST compile first. 
                    # This is where it failed last time. We use V=s to see why.
                    
                    echo ">>> Compiling Rust [HOST]..."
                    make package/feeds/packages/rust/host-compile -j1 V=s 2>&1 | tee ../logs/rust_host_verbose.log
                    
                    echo ">>> Compiling Rust [TARGET]..."
                    make package/feeds/packages/rust/compile -j1 V=s 2>&1 | tee ../logs/rust_target_verbose.log
                    
                    echo "✓ RUST FULLY COMPILED"
                '''
            }
        }

        stage('7. Compile Firmware (Resume)') {
            steps {
                sh '''#!/bin/bash
                    set -e
                    set -o pipefail
                    export FORCE_UNSAFE_CONFIGURE=1
                    
                    cd ${WORKSPACE}/openwrt
                    
                    echo "=============================================="
                    echo "=== STEP 7: RESUMING BUILD ==="
                    echo "=============================================="
                    echo "Since we did NOT clean, this will skip Node.js if it is already done."
                    
                    make -j1 world 2>&1 | tee ../logs/build_main.log
                    
                    echo "✓ FIRMWARE BUILD COMPLETE"
                '''
            }
        }

        stage('8. Archive') {
            steps {
                sh '''
                    mkdir -p output/targets output/logs
                    cp logs/*.log output/logs/ 2>/dev/null || true
                    if [ -d openwrt/bin/targets ]; then
                        cp -r openwrt/bin/targets/* output/targets/
                    fi
                '''
                archiveArtifacts artifacts: 'output/targets/**/*.img.gz', allowEmptyArchive: true
                archiveArtifacts artifacts: 'output/logs/*.log', allowEmptyArchive: true
            }
        }
    }
}
