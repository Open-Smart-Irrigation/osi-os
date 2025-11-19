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
        stage('Check Space & Environment') {
            steps {
                sh '''
                    echo "=========================================="
                    echo "=== Environment Check ==="
                    echo "Workspace: ${WORKSPACE}"
                    echo "=========================================="
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

                    echo "=== Switching to Environment: ${TARGET_ENV} ==="

                    # 1. Create dummy symlinks to prevent Makefile errors
                    rm -f openwrt/.config openwrt/files openwrt/patches
                    ln -s ../conf/.config openwrt/.config
                    ln -s ../conf/files openwrt/files
                    ln -s ../conf/patches openwrt/patches

                    # 2. Run switch-env (This runs 'git clean -fd' which deletes feeds/)
                    make QUILT_PATCHES=patches switch-env ENV=${TARGET_ENV}

                    echo "=========================================="
                    echo "=== FIXING FEEDS PATHS ==="
                    echo "=========================================="

                    cd ${WORKSPACE}

                    # 3. Copy default feed config
                    cp feeds.conf.default openwrt/feeds.conf.default

                    # 4. Rewrite Docker paths (/workdir) to Host paths (${WORKSPACE})
                    # This is the step that fixed Node-RED for you previously.
                    sed -i "s|/workdir|${WORKSPACE}|g" openwrt/feeds.conf.default

                    cd openwrt

                    # 5. Update and Install Feeds
                    echo "Updating feeds..."
                    ./scripts/feeds update -a

                    echo "Installing feeds..."
                    ./scripts/feeds install -a

                    # 6. VERIFICATION (Updated for ChirpStack v4)
                    echo "=== Verification ==="

                    # Check for Node-RED
                    if ./scripts/feeds search node-red | grep -q "node-red"; then
                        echo "✓ Node-RED found in feeds."
                    else
                        echo "✗ ERROR: Node-RED NOT found in feeds."
                        exit 1
                    fi

                    # Check for EITHER Gateway Bridge (Old) OR MQTT Forwarder (New)
                    if ./scripts/feeds search chirpstack-mqtt-forwarder | grep -q "chirpstack-mqtt-forwarder"; then
                        echo "✓ ChirpStack MQTT Forwarder found (v4 structure)."
                    elif ./scripts/feeds search chirpstack-gateway-bridge | grep -q "chirpstack-gateway-bridge"; then
                        echo "✓ ChirpStack Gateway Bridge found (Legacy structure)."
                    else
                        echo "✗ ERROR: Neither MQTT Forwarder nor Gateway Bridge found!"
                        exit 1
                    fi
                '''
            }
        }

        stage('Build') {
            steps {
                sh '''#!/bin/bash
                    set -e
                    
                    # FIX: Ensure logs directory exists immediately
                    mkdir -p ${WORKSPACE}/logs
                    
                    cd ${WORKSPACE}/openwrt

                    echo "=========================================="
                    echo "=== Configuring Build ==="
                    echo "=========================================="
                    
                    make defconfig > ../logs/defconfig.log 2>&1
                    
                    echo "=========================================="
                    echo "=== DEBUGGING RUST FAILURE ==="
                    echo "=========================================="
                    
                    # We are running this specifically to see why Rust fails.
                    # V=s ensures the error is printed to the console.
                    echo "Attempting to compile Rust Host dependency..."
                    
                    if ! make package/feeds/packages/rust/compile -j1 V=s; then
                        echo ""
                        echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
                        echo "!!! RUST COMPILATION FAILED - SEE ERROR ABOVE !!!"
                        echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
                        echo ""
                        exit 1
                    fi
                    
                    echo "✓ Rust compiled successfully."

                    echo "=========================================="
                    echo "=== Starting Full Build ==="
                    echo "=========================================="
                    
                    make -j1 download world > ../logs/build.log 2>&1
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
                archiveArtifacts artifacts: 'output/targets/**/*.img.gz, output/targets/**/*.bin', allowEmptyArchive: true
                archiveArtifacts artifacts: 'output/logs/*.log', allowEmptyArchive: true
            }
        }
    }
}
