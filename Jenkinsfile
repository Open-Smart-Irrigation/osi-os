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
                    echo "=== System Dependencies ==="
                    if [ "$(id -u)" -eq 0 ]; then
                        apt-get update -q
                        # Ensure certificates and tools are present
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

        stage('3. Force Rust Rebuild') {
            steps {
                sh '''#!/bin/bash
                    set -e
                    export FORCE_UNSAFE_CONFIGURE=1
                    cd ${WORKSPACE}/openwrt
                    
                    echo "=========================================="
                    echo "=== STEP 3: FORCING RUST CLEAN & BUILD ==="
                    echo "=========================================="
                    
                    # 1. TELL MAKE TO CLEAN RUST
                    # This updates the timestamps so it knows to rebuild
                    echo "Cleaning Rust package..."
                    make package/feeds/packages/rust/clean
                    
                    # 2. COMPILE WITH LOGS ON SCREEN
                    echo "Compiling Rust (This should take >15 mins)..."
                    echo "If this finishes in 10 seconds, IT FAILED."
                    
                    # We pipe to 'tee' so we see it on the console AND save it
                    make package/feeds/packages/rust/compile -j1 V=s 2>&1 | tee ../logs/rust_build.log
                    
                    echo "✓ Rust compilation finished."
                '''
            }
        }

        stage('4. Compile Firmware') {
            steps {
                sh '''#!/bin/bash
                    set -e
                    export FORCE_UNSAFE_CONFIGURE=1
                    cd ${WORKSPACE}/openwrt
                    
                    echo "=========================================="
                    echo "=== STEP 4: FINISHING BUILD ==="
                    echo "=========================================="
                    
                    # We use 'tee' here too so we can see if it crashes
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
