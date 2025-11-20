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
            defaultValue: true,
            description: 'Clean before build (RECOMMENDED)'
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
                            cmake curl
                    fi
                    # Check python setuptools
                    python3 -c "import setuptools; print('✓ Python Setuptools OK')" || echo "Warning: Python check failed"
                '''
            }
        }

        stage('2. Clean Workspace') {
            when { expression { params.CLEAN_BUILD } }
            steps {
                sh '''
                    cd ${WORKSPACE}
                    rm -rf openwrt/bin openwrt/build_dir openwrt/staging_dir openwrt/tmp
                    rm -rf logs output .initialized
                    # Keep openwrt/dl to save download time
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

        stage('5. Bootstrap Toolchain (CRITICAL)') {
            steps {
                sh '''#!/bin/bash
                    set -e
                    # This makes the pipe fail if the build fails (fixing the false success msg)
                    set -o pipefail 
                    export FORCE_UNSAFE_CONFIGURE=1
                    
                    cd ${WORKSPACE}/openwrt
                    
                    echo "=============================================="
                    echo "=== STEP 5: BUILDING TOOLCHAIN ==="
                    echo "=============================================="
                    echo "Compiling GCC and Musl Libc. This creates the missing ld-musl files."
                    echo "We use -j4 here because C compilation is safe and faster."
                    
                    # FIX: We build 'tools' and 'toolchain' first.
                    # This puts ld-musl-*.so into staging_dir so Rust can find it.
                    
                    make -j4 tools/install toolchain/install 2>&1 | tee ../logs/toolchain_build.log
                    
                    echo "✓ Toolchain installed. Staging directory is ready."
                '''
            }
        }

        stage('6. Compile Rust (Targeted)') {
            steps {
                sh '''#!/bin/bash
                    set -e
                    set -o pipefail
                    export FORCE_UNSAFE_CONFIGURE=1
                    
                    cd ${WORKSPACE}/openwrt
                    
                    echo "=============================================="
                    echo "=== STEP 6: COMPILING RUST ==="
                    echo "=============================================="
                    echo "Toolchain is ready. Now compiling Rust."
                    echo "Using -j1 to prevent memory crashes."
                    
                    # Now we can safely compile Rust because the toolchain exists
                    make package/feeds/packages/rust/compile -j1 V=s 2>&1 | tee ../logs/rust_verbose.log
                    
                    echo "✓ RUST COMPILED SUCCESSFULLY"
                '''
            }
        }

        stage('7. Compile Firmware (The Rest)') {
            steps {
                sh '''#!/bin/bash
                    set -e
                    set -o pipefail
                    export FORCE_UNSAFE_CONFIGURE=1
                    
                    cd ${WORKSPACE}/openwrt
                    
                    echo "=============================================="
                    echo "=== STEP 7: BUILDING FINAL IMAGE ==="
                    echo "=============================================="
                    
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
