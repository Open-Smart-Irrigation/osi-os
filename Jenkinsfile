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
            description: 'Clean before build (RECOMMENDED for this run)'
        )
    }

    options {
        buildDiscarder(logRotator(numToKeepStr: '5'))
        timestamps()
        timeout(time: 12, unit: 'HOURS')
    }

    stages {
        stage('1. System Prep & Verification') {
            steps {
                sh '''
                    echo "=== 1.1 Memory Check ==="
                    free -h
                    
                    echo "=== 1.2 Installing Dependencies ==="
                    if [ "$(id -u)" -eq 0 ]; then
                        # Update package lists
                        apt-get update -q
                        
                        # Install core build tools + Python fix + SSL
                        # Added 'rsync' and 'curl' explicitly as they are often needed
                        apt-get install -y -q build-essential libncurses5-dev zlib1g-dev \
                            gawk git gettext libssl-dev xsltproc rsync wget unzip \
                            python3 python3-setuptools file pkg-config clang \
                            cmake curl
                            
                        echo "✓ Dependencies installed"
                    else
                        echo "WARNING: Not root. Skipping apt-get."
                    fi
                    
                    echo "=== 1.3 Verify Python ==="
                    # Check if setuptools is actually recognized
                    python3 -c "import setuptools; print('✓ Python Setuptools is working')" || echo "✗ Python Setuptools ERROR"
                '''
            }
        }

        stage('2. Clean Workspace') {
            when { expression { params.CLEAN_BUILD } }
            steps {
                sh '''
                    cd ${WORKSPACE}
                    echo "Cleaning build directories..."
                    rm -rf openwrt/bin openwrt/build_dir openwrt/staging_dir openwrt/tmp
                    rm -rf logs output .initialized
                    
                    # We keep openwrt/dl to save download time
                    echo "✓ Clean complete (Downloads preserved)"
                '''
            }
        }

        stage('3. Initialize & Feeds') {
            steps {
                sh '''#!/bin/bash
                    set -e
                    cd ${WORKSPACE}
                    
                    # Init Submodules
                    if [ ! -f .initialized ]; then
                        git submodule update --init --recursive
                        touch .initialized
                    fi
                    
                    # Symlinks
                    rm -f openwrt/.config openwrt/files openwrt/patches
                    ln -s ../conf/.config openwrt/.config
                    ln -s ../conf/files openwrt/files
                    ln -s ../conf/patches openwrt/patches
                    
                    # Switch Env
                    echo "Running make switch-env..."
                    make QUILT_PATCHES=patches switch-env ENV=${TARGET_ENV}
                    
                    # Fix Feeds Paths
                    echo "Fixing feed paths..."
                    cp feeds.conf.default openwrt/feeds.conf.default
                    sed -i "s|/workdir|${WORKSPACE}|g" openwrt/feeds.conf.default
                    
                    # Update Feeds
                    cd openwrt
                    echo "Updating feeds..."
                    ./scripts/feeds update -a
                    ./scripts/feeds install -a
                    
                    echo "✓ Feeds ready"
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
                    
                    echo "Generating .config..."
                    make defconfig > ../logs/defconfig.log 2>&1
                    
                    # Show the user what is enabled
                    echo "=== Config Check ==="
                    grep "CONFIG_PACKAGE_rust" .config || echo "Rust package not found in config"
                    grep "CONFIG_PACKAGE_node-red" .config || echo "Node-RED not found in config"
                '''
            }
        }

        stage('5. Compile Rust (Targeted)') {
            steps {
                sh '''#!/bin/bash
                    set -e
                    export FORCE_UNSAFE_CONFIGURE=1
                    cd ${WORKSPACE}/openwrt
                    
                    echo "=============================================="
                    echo "=== STEP 5: COMPILING RUST (The Hard Part) ==="
                    echo "=============================================="
                    echo "We are isolating Rust. You will see VERBOSE output now."
                    echo "If this fails, the error will be on the screen."
                    echo "----------------------------------------------"
                    
                    # Command Explanation:
                    # -j1  : Single thread to save memory
                    # V=s  : Verbose (Prints everything to console)
                    # 2>&1 | tee : Show on screen AND save to file
                    
                    # We specifically build the rust compiler host package first
                    make package/feeds/packages/rust/compile -j1 V=s 2>&1 | tee ../logs/rust_verbose.log
                    
                    echo "----------------------------------------------"
                    echo "✓ RUST COMPILED SUCCESSFULLY"
                    echo "=============================================="
                '''
            }
        }

        stage('6. Compile Firmware (The Rest)') {
            steps {
                sh '''#!/bin/bash
                    set -e
                    export FORCE_UNSAFE_CONFIGURE=1
                    cd ${WORKSPACE}/openwrt
                    
                    echo "=============================================="
                    echo "=== STEP 6: BUILDING FIRMWARE IMAGE ==="
                    echo "=============================================="
                    echo "Rust is done. Now building the rest (Kernel, Node.js, etc)."
                    echo "Output is summarized to keep logs clean, but errors will be shown."
                    
                    # Here we don't use V=s because it would generate GBs of logs for the whole OS.
                    # We use standard output, which shows "Compiling x..."
                    
                    make -j1 world 2>&1 | tee ../logs/build_main.log
                    
                    echo "✓ FIRMWARE BUILD COMPLETE"
                '''
            }
        }

        stage('7. Archive') {
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
