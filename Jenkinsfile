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
        stage('1. Verify Docker Tools') {
            steps {
                sh '''
                    echo "=== Verifying Container Dependencies ==="
                    # If these fail, you MUST rebuild your Docker image on the VPS
                    
                    if ! command -v pkg-config &> /dev/null; then
                        echo "❌ CRITICAL ERROR: 'pkg-config' is missing!"
                        echo "Rust cannot compile without it. Please update your Dockerfile and rebuild the container."
                        exit 1
                    fi
                    
                    if ! command -v clang &> /dev/null; then
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
                    
                    echo "=== Ensuring Rust Rebuilds ==="
                    # We silently delete the stamp files so Make doesn't skip this step
                    # This fixes the "Nothing to be done" error
                    
                    find staging_dir -path "*rust*" -name ".built" -delete
                    find staging_dir -path "*rust*" -name ".prepared" -delete
                    find build_dir -path "*rust*" -name ".built" -delete
                    
                    # We also remove the host build directory to force a clean host compile
                    rm -rf build_dir/host/rust*
                '''
            }
        }

        stage('4. Compile Rust') {
            steps {
                sh '''#!/bin/bash
                    set -e
                    export FORCE_UNSAFE_CONFIGURE=1
                    cd ${WORKSPACE}/openwrt
                    
                    echo "=== Compiling Rust (Standard Mode) ==="
                    # -j1 to save memory
                    # V=s to see errors
                    
                    if ! make package/feeds/packages/rust/compile -j1 V=s 2>&1 | tee ../logs/rust_verbose.log; then
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
                archiveArtifacts artifacts: 'output/targets/**/*.img.gz, output/logs/*.log', allowEmptyArchive: true
            }
        }
    }
}
