pipeline {
    agent any
    
    parameters {
        choice(
            name: 'TARGET_ENV',
            choices: [
                'full_raspberrypi_bcm27xx_bcm2712'
            ],
            description: 'Target platform'
        )
        booleanParam(
            name: 'CLEAN_BUILD',
            defaultValue: false,
            description: 'Clean before build (LEAVE UNCHECKED)'
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
                    if [ "$(id -u)" -eq 0 ]; then
                        apt-get update -q
                        apt-get install -y -q build-essential libncurses5-dev zlib1g-dev \
                            gawk git gettext libssl-dev xsltproc rsync wget unzip \
                            python3 python3-setuptools file pkg-config clang \
                            cmake curl ca-certificates
                        update-ca-certificates
                    fi
                '''
            }
        }

        stage('2. Initialize') {
            steps {
                sh '''#!/bin/bash
                    set -e
                    cd ${WORKSPACE}
                    if [ ! -f .initialized ]; then git submodule update --init --recursive; touch .initialized; fi
                    
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
                    make defconfig > ../logs/defconfig.log 2>&1
                '''
            }
        }

        stage('3. FORCE Rust Rebuild') {
            steps {
                sh '''#!/bin/bash
                    set -e
                    export FORCE_UNSAFE_CONFIGURE=1
                    cd ${WORKSPACE}/openwrt
                    
                    echo "=========================================="
                    echo "=== FORCING RUST REBUILD (Mode: -B) ==="
                    echo "=========================================="
                    
                    # 1. Clean artifacts
                    make package/feeds/packages/rust/clean
                    
                    # 2. Touch the makefile (Tricks make into thinking it changed)
                    touch feeds/packages/lang/rust/Makefile
                    
                    # 3. COMPILE WITH FORCE FLAG (-B)
                    # -B: Unconditionally build all targets, ignoring timestamps.
                    echo "Running make -B ... (This MUST rebuild now)"
                    
                    if ! make -B package/feeds/packages/rust/compile -j1 V=s 2>&1 | tee ../logs/rust_force.log; then
                        echo ""
                        echo "❌❌❌ RUST FAILED ❌❌❌"
                        echo "Error is above."
                        exit 1
                    fi
                    
                    echo "✓ Rust built successfully."
                '''
            }
        }

        stage('4. Finish Firmware') {
            steps {
                sh '''#!/bin/bash
                    set -e
                    export FORCE_UNSAFE_CONFIGURE=1
                    cd ${WORKSPACE}/openwrt
                    make -j1 world 2>&1 | tee ../logs/build_main.log
                '''
            }
        }
        
        stage('Archive') {
            steps {
                archiveArtifacts artifacts: 'output/targets/**/*.img.gz, output/logs/*.log', allowEmptyArchive: true
            }
        }
    }
}
