pipeline {
    agent any
    
    parameters {
        choice(name: 'TARGET_ENV', choices: ['full_raspberrypi_bcm27xx_bcm2712'], description: 'Target')
        booleanParam(name: 'CLEAN_BUILD', defaultValue: false, description: 'Leave UNCHECKED')
    }

    options {
        timestamps()
        timeout(time: 12, unit: 'HOURS')
    }

    stages {
        stage('1. Setup') {
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
                    make defconfig
                '''
            }
        }

        stage('2. Rust Repair') {
            steps {
                sh '''#!/bin/bash
                    set -e
                    export FORCE_UNSAFE_CONFIGURE=1
                    cd ${WORKSPACE}/openwrt
                    
                    echo "=============================================="
                    echo "=== FIXING RUST BUILD STATE ==="
                    echo "=============================================="
                    
                    # 1. MANUALLY DELETE THE HOST BUILD
                    # The standard 'make clean' was missing this folder, causing the fake success.
                    echo "Nuking Rust build directories..."
                    rm -rf build_dir/host/rust*
                    rm -rf build_dir/target-*/rust*
                    
                    # 2. COMPILE (This time it MUST run because files are gone)
                    echo ">>> Compiling Rust (This will take 30+ minutes)..."
                    echo "If this fails, the error will be printed below."
                    
                    # We use the standard 'compile' target which automatically triggers host-compile
                    if ! make package/feeds/packages/rust/compile -j1 V=s 2>&1; then
                         echo ""
                         echo "❌❌❌ RUST COMPILATION FAILED ❌❌❌"
                         exit 1
                    fi
                    
                    echo "✓ Rust compiled successfully (Host + Target)"
                '''
            }
        }

        stage('3. Finish Firmware') {
            steps {
                sh '''#!/bin/bash
                    set -e
                    export FORCE_UNSAFE_CONFIGURE=1
                    cd ${WORKSPACE}/openwrt
                    
                    echo "=== Building Final Image ==="
                    make -j1 world 2>&1 | tee ../logs/build_final.log
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
