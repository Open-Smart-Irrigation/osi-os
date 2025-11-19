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
        stage('Check Environment') {
            steps {
                sh '''
                    echo "=== Workspace Info ==="
                    echo "Workspace: ${WORKSPACE}"
                    echo "User: $(whoami)"
                    echo "Disk Space:"
                    df -h
                '''
            }
        }

        stage('Clean') {
            when { expression { params.CLEAN_BUILD } }
            steps {
                sh '''
                    cd ${WORKSPACE}
                    echo "Cleaning build directory..."
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
                    # Ensure git submodules are ready
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
                    
                    # 1. Prepare symlinks so Makefile doesn't complain
                    rm -f openwrt/.config openwrt/files openwrt/patches
                    ln -s ../conf/.config openwrt/.config
                    ln -s ../conf/files openwrt/files
                    ln -s ../conf/patches openwrt/patches
                    
                    # 2. Run standard switch-env (Warning: This wipes feeds/)
                    make QUILT_PATCHES=patches switch-env ENV=${TARGET_ENV}
                    
                    echo "=== REPAIRING FEEDS ==="
                    
                    cd ${WORKSPACE}
                    
                    # 3. Restore the config
                    cp feeds.conf.default openwrt/feeds.conf.default
                    
                    # 4. CRITICAL: Rewrite Docker paths to Host paths
                    # This ensures we can find the packages on the VPS disk
                    sed -i "s|/workdir|${WORKSPACE}|g" openwrt/feeds.conf.default
                    
                    cd openwrt
                    
                    # 5. Update and Install
                    # We must re-download because switch-env deleted the folders
                    ./scripts/feeds update -a
                    ./scripts/feeds install -a
                    
                    # 6. Simple Verification
                    if ./scripts/feeds search node-red | grep -q "node-red"; then
                        echo "✓ Node-RED found."
                    else
                        echo "✗ ERROR: Node-RED missing from feeds."
                        exit 1
                    fi
                '''
            }
        }

        stage('Build') {
            steps {
                sh '''#!/bin/bash
                    set -e
                    
                    # CRITICAL FOR DOCKER:
                    # Many tools (tar, gzip) fail to build as root without this flag.
                    export FORCE_UNSAFE_CONFIGURE=1
                    
                    mkdir -p ${WORKSPACE}/logs
                    cd ${WORKSPACE}/openwrt

                    echo "=========================================="
                    echo "=== Configuring ==="
                    echo "=========================================="
                    
                    # Apply config and expand dependencies
                    make defconfig > ../logs/defconfig.log 2>&1
                    
                    echo "=== Checking Critical Packages in .config ==="
                    grep "CONFIG_PACKAGE_node-red=y" .config && echo "✓ Node-RED Enabled" || echo "warning: Node-RED Disabled"
                    grep "CONFIG_PACKAGE_chirpstack-mqtt-forwarder=y" .config && echo "✓ ChirpStack Forwarder Enabled" || echo "warning: ChirpStack Forwarder Disabled"

                    echo "=========================================="
                    echo "=== Building (Single Thread) ==="
                    echo "=========================================="
                    
                    echo "Starting build... This will take time."
                    echo "Using -j1 to prevent memory crashes."
                    
                    # We use standard 'make download world'.
                    # We trust OpenWrt to handle the order (tools -> toolchain -> rust -> packages).
                    # If this fails, we print the tail of the log.
                    
                    if ! make -j1 download world > ../logs/build.log 2>&1; then
                        echo ""
                        echo "✗✗✗ BUILD FAILED ✗✗✗"
                        echo "Displaying last 100 lines of build log:"
                        echo "----------------------------------------"
                        tail -n 100 ../logs/build.log
                        echo "----------------------------------------"
                        
                        # Check specifically for package errors
                        if [ -f "logs/package/error.txt" ]; then
                            echo "Found specific package error:"
                            cat logs/package/error.txt
                        fi
                        
                        exit 1
                    fi
                    
                    echo "✓ Build Completed Successfully"
                '''
            }
        }

        stage('Archive') {
            steps {
                sh '''
                    mkdir -p output/targets output/logs
                    cp logs/*.log output/logs/ 2>/dev/null || true
                    
                    # Copy the images
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
