pipeline {
    agent any
    
    parameters {
        choice(name: 'TARGET_ENV', choices: ['full_raspberrypi_bcm27xx_bcm2712'], description: 'Target')
        booleanParam(name: 'CLEAN_BUILD', defaultValue: false, description: 'Leave UNCHECKED')
    }

    stages {
        stage('1. Setup') {
            steps {
                sh '''
                    # Basic Prep
                    if [ "$(id -u)" -eq 0 ]; then
                        apt-get update -q
                        apt-get install -y -q build-essential libncurses5-dev zlib1g-dev \
                            gawk git gettext libssl-dev xsltproc rsync wget unzip \
                            python3 python3-setuptools file pkg-config clang \
                            cmake curl ca-certificates
                    fi
                    
                    cd ${WORKSPACE}
                    if [ ! -f .initialized ]; then git submodule update --init --recursive; touch .initialized; fi
                    
                    # Link Configs
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

        stage('2. Rust Diagnostic') {
            steps {
                sh '''#!/bin/bash
                    cd ${WORKSPACE}/openwrt
                    export FORCE_UNSAFE_CONFIGURE=1
                    
                    echo "=============================================="
                    echo "=== DIAGNOSTIC MODE: RUST HOST ==="
                    echo "=============================================="
                    
                    # 1. Clean ONLY Rust
                    echo ">>> Cleaning Rust..."
                    make package/feeds/packages/rust/clean
                    
                    # 2. Download Step (Verbose)
                    echo ">>> Step 1: Downloading Rust Sources..."
                    if ! make package/feeds/packages/rust/download V=s; then
                        echo "❌ FAILED AT DOWNLOAD STEP"
                        exit 1
                    fi
                    
                    # 3. Prepare Step (Verbose) - Unzipping & Patching
                    echo ">>> Step 2: Preparing/Unzipping Rust..."
                    if ! make package/feeds/packages/rust/prepare V=s; then
                        echo "❌ FAILED AT PREPARE STEP"
                        exit 1
                    fi
                    
                    # 4. Host Compile Step (Verbose) - THE CRASH SITE
                    echo ">>> Step 3: Compiling Rust Host Tools..."
                    
                    # We use 2>&1 to force output to console
                    if ! make package/feeds/packages/rust/host-compile V=s 2>&1; then
                        echo ""
                        echo "❌❌❌ FAILED AT HOST-COMPILE STEP ❌❌❌"
                        echo "SEARCHING FOR HIDDEN LOGS..."
                        
                        # Safe syntax that works in Jenkins Groovy:
                        if [ -d "logs/package/feeds/packages/rust" ]; then
                            find logs/package/feeds/packages/rust -name "*.txt" | while read logfile; do
                                echo "--- LOG FILE FOUND: $logfile ---"
                                cat "$logfile"
                                echo "--- END LOG FILE ---"
                            done
                        else
                            echo "No internal log files found."
                        fi
                        
                        exit 1
                    fi
                    
                    echo "✓ Rust Host Compiled Successfully"
                '''
            }
        }
    }
}
