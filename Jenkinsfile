pipeline {
    agent any
    
    parameters {
        choice(
            name: 'TARGET_ENV',
            choices: [
                'full_raspberrypi_bcm27xx_bcm2712' // Defaulting to Pi 5 as per your logs
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

        stage('3. NUCLEAR CLEAN (Rust Only)') {
            steps {
                sh '''#!/bin/bash
                    set -e
                    cd ${WORKSPACE}/openwrt
                    
                    echo "=========================================="
                    echo "=== DELETING HIDDEN STAMP FILES ==="
                    echo "=========================================="
                    
                    # 1. Use Make to clean (Best effort)
                    make package/feeds/packages/rust/clean
                    
                    # 2. DELETE THE HIDDEN FILES (The actual fix)
                    # These are the files that tell Make "Don't worry, I'm already done"
                    
                    echo "Finding and destroying rust stamp files..."
                    find staging_dir -name ".built" -path "*rust*" -delete
                    find staging_dir -name ".prepared" -path "*rust*" -delete
                    find build_dir -name ".built" -path "*rust*" -delete
                    
                    # 3. Delete the build directories explicitly
                    rm -rf build_dir/host/rust*
                    rm -rf build_dir/target-*/rust*
                    rm -rf feeds/packages/lang/rust/host-build
                    
                    echo "✓ Rust history has been erased."
                '''
            }
        }

        stage('4. Compile Rust (VERBOSE)') {
            steps {
                sh '''#!/bin/bash
                    set -e
                    export FORCE_UNSAFE_CONFIGURE=1
                    cd ${WORKSPACE}/openwrt
                    
                    echo "=========================================="
                    echo "=== COMPILING RUST (Must take >10 mins) ==="
                    echo "=========================================="
                    
                    # We use tee to show logs on screen.
                    # If this fails, the error WILL be on the screen now.
                    
                    if ! make package/feeds/packages/rust/compile -j1 V=s 2>&1 | tee ../logs/rust_verbose.log; then
                        echo ""
                        echo "❌❌❌ RUST FAILED ❌❌❌"
                        echo "The error should be visible above."
                        exit 1
                    fi
                    
                    echo "✓ Rust built successfully."
                '''
            }
        }

        stage('5. Finish Firmware') {
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
