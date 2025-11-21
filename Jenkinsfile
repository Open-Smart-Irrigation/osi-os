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
        timeout(time: 12, unit: 'HOURS')
    }

    stages {
        stage('1. Forensic Prep') {
            steps {
                sh '''
                    echo "=== 1. Installing Certificates & Tools ==="
                    if [ "$(id -u)" -eq 0 ]; then
                        apt-get update -q
                        # ca-certificates is CRITICAL for Rust downloads
                        apt-get install -y -q build-essential libncurses5-dev zlib1g-dev \
                            gawk git gettext libssl-dev xsltproc rsync wget unzip \
                            python3 python3-setuptools file pkg-config clang \
                            cmake curl ca-certificates
                        update-ca-certificates
                    fi
                    
                    echo "=== 2. PURGING RUST CACHE (The Fix) ==="
                    cd ${WORKSPACE}/openwrt
                    # FIX: Using 'rm -rf' to handle directories correctly
                    echo "Deleting cached Rust/Cargo downloads..."
                    rm -rf dl/rust* 
                    rm -rf dl/carg*
                    rm -rf build_dir/host/rust*
                    rm -rf feeds/packages/lang/rust/host-build
                '''
            }
        }

        stage('2. Initialize') {
            steps {
                sh '''#!/bin/bash
                    set -e
                    cd ${WORKSPACE}
                    
                    if [ ! -f .initialized ]; then
                        git submodule update --init --recursive
                        touch .initialized
                    fi
                    
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

        stage('3. Compile Rust (Forensic Mode)') {
            steps {
                sh '''#!/bin/bash
                    set -e
                    # ALLOW ROOT BUILD
                    export FORCE_UNSAFE_CONFIGURE=1
                    # TELL CARGO IT IS OKAY TO RUN AS ROOT
                    export CARGO_HOME=${WORKSPACE}/openwrt/dl/cargo_home
                    mkdir -p $CARGO_HOME
                    
                    cd ${WORKSPACE}/openwrt
                    
                    echo "=============================================="
                    echo "=== ATTEMPTING TO BUILD RUST ==="
                    echo "=============================================="
                    echo "We cleaned the cache. This should trigger a download."
                    
                    # We use -j1 V=s to capture everything.
                    # If this fails, the '||' block below captures the logs.
                    
                    if ! make package/feeds/packages/rust/compile -j1 V=s > ../logs/rust_debug.log 2>&1; then
                        echo ""
                        echo "❌❌❌ RUST FAILED AGAIN ❌❌❌"
                        echo "BUT NOW WE WILL SEE WHY."
                        echo ""
                        
                        echo "=== 1. CHECKING CONSOLE OUTPUT ==="
                        # Print the last 200 lines of what just happened
                        tail -n 200 ../logs/rust_debug.log
                        
                        echo ""
                        echo "=== 2. CHECKING INTERNAL OPENWRT LOGS ==="
                        # Safe syntax to find and cat files
                        if [ -d "logs/package/feeds/packages/rust" ]; then
                            find logs/package/feeds/packages/rust -name "*.txt" -exec cat {} +
                        else
                            echo "No internal error logs found."
                        fi
                        
                        echo ""
                        echo "=== END OF FORENSIC REPORT ==="
                        exit 1
                    fi
                    
                    echo "✓ Rust compiled successfully!"
                '''
            }
        }

        stage('4. Compile Firmware (Resume)') {
            steps {
                sh '''#!/bin/bash
                    set -e
                    export FORCE_UNSAFE_CONFIGURE=1
                    cd ${WORKSPACE}/openwrt
                    make -j1 world > ../logs/build_main.log 2>&1
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
