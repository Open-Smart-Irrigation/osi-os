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
            description: 'Clean before build (removes entire build directory)'
        )
    }

    options {
        buildDiscarder(logRotator(numToKeepStr: '5'))
        timestamps()
        timeout(time: 12, unit: 'HOURS')
    }

    stages {
       stage('System Prep') {
            steps {
                sh '''
                    echo "=== Installing Critical Build Dependencies ==="
                    
                    if [ "$(id -u)" -eq 0 ]; then
                        apt-get update
                        
                        # FIXED: Removed 'python3-distutils' (deprecated/removed in Debian 12+)
                        # Added 'python3-setuptools' instead.
                        
                        apt-get install -y build-essential libncurses5-dev zlib1g-dev \
                            gawk git gettext libssl-dev xsltproc rsync wget unzip \
                            python3 python3-setuptools file pkg-config clang \
                            cmake
                    else
                        echo "WARNING: Not running as root. Cannot install dependencies."
                    fi
                    
                    echo "=== Memory Check ==="
                    free -h
                '''
            }
        }

        stage('Clean') {
            when { expression { params.CLEAN_BUILD } }
            steps {
                sh '''
                    cd ${WORKSPACE}
                    rm -rf openwrt/bin openwrt/build_dir openwrt/staging_dir openwrt/tmp
                    rm -rf logs output .initialized
                    # Also clean downloads if we suspect corruption
                    # rm -rf openwrt/dl
                '''
            }
        }

        stage('Initialize') {
            when { expression { !fileExists("${WORKSPACE}/.initialized") } }
            steps {
                sh '''
                    cd ${WORKSPACE}
                    git submodule update --init --recursive
                    touch ${WORKSPACE}/.initialized
                '''
            }
        }

        stage('Switch Environment & Fix Feeds') {
            steps {
                sh '''#!/bin/bash
                    set -e
                    cd ${WORKSPACE}
                    
                    # Setup Symlinks
                    rm -f openwrt/.config openwrt/files openwrt/patches
                    ln -s ../conf/.config openwrt/.config
                    ln -s ../conf/files openwrt/files
                    ln -s ../conf/patches openwrt/patches
                    
                    # Switch Env
                    make QUILT_PATCHES=patches switch-env ENV=${TARGET_ENV}
                    
                    # Fix Feeds
                    cd ${WORKSPACE}
                    cp feeds.conf.default openwrt/feeds.conf.default
                    sed -i "s|/workdir|${WORKSPACE}|g" openwrt/feeds.conf.default
                    
                    # Update Feeds
                    cd openwrt
                    ./scripts/feeds update -a
                    ./scripts/feeds install -a
                '''
            }
        }

        stage('Build') {
            steps {
                sh '''#!/bin/bash
                    set -e
                    export FORCE_UNSAFE_CONFIGURE=1
                    export REJECT_MSG="Rust build failed"
                    
                    mkdir -p ${WORKSPACE}/logs
                    cd ${WORKSPACE}/openwrt
                    
                    make defconfig > ../logs/defconfig.log 2>&1
                    
                    echo "=========================================="
                    echo "=== ATTEMPTING BUILD (With Logs) ==="
                    echo "=========================================="
                    
                    # We try to compile everything with -j1
                    # If it fails, we go into Forensic Mode
                    
                    if ! make -j1 download world > ../logs/build.log 2>&1; then
                        echo ""
                        echo "❌❌❌ BUILD FAILED ❌❌❌"
                        echo ""
                        echo "=== ANALYZING FAILURE ==="
                        
                        # 1. Check for the Rust specific error log
                        # OpenWrt saves package build logs in logs/package/feeds/...
                        
                        echo "Searching for Rust build logs..."
                        RUST_LOGS=$(find logs/package/feeds/packages/rust -name "*.txt" 2>/dev/null)
                        
                        if [ -n "$RUST_LOGS" ]; then
                            echo "Found Rust logs at: $RUST_LOGS"
                            echo "--- CONTENT OF RUST LOG ---"
                            cat $RUST_LOGS
                            echo "--- END OF RUST LOG ---"
                        else
                            echo "No specific Rust log file found."
                        fi
                        
                        # 2. Check the main error file
                        if [ -f "logs/package/error.txt" ]; then
                            echo "--- CONTENT OF PACKAGE ERROR LOG ---"
                            cat logs/package/error.txt
                            echo "------------------------------------"
                        fi
                        
                        # 3. Tail the main build log
                        echo "--- TAIL OF MAIN BUILD LOG ---"
                        tail -n 100 ../logs/build.log
                        
                        exit 1
                    fi
                    
                    echo "✓ Build Successful"
                '''
            }
        }

        stage('Archive') {
            steps {
                sh '''
                    mkdir -p output/targets output/logs
                    cp logs/*.log output/logs/ 2>/dev/null || true
                    if [ -d openwrt/bin/targets ]; then
                        cp -r openwrt/bin/targets/* output/targets/
                    fi
                '''
                archiveArtifacts artifacts: 'output/targets/**/*.img.gz', allowEmptyArchive: true
            }
        }
    }
}
