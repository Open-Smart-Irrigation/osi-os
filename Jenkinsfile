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
                    whoami
                    docker --version || echo "Docker command failed"
                    echo "=========================================="
                '''
            }
        }

        stage('Clean') {
            when { expression { params.CLEAN_BUILD } }
            steps {
                sh '''
                    cd ${WORKSPACE}
                    echo "Removing build artifacts..."
                    rm -rf openwrt/bin openwrt/build_dir openwrt/staging_dir openwrt/tmp
                    rm -rf logs output .initialized
                '''
            }
        }

        stage('Setup Build Directory') {
            steps {
                sh '''
                    cd ${WORKSPACE}
                    mkdir -p logs output
                    if [ ! -f Makefile ]; then
                        echo "ERROR: Makefile not found at workspace root."
                        exit 1
                    fi
                '''
            }
        }

        stage('Initialize Build Environment') {
            when { expression { !fileExists("${WORKSPACE}/.initialized") } }
            steps {
                sh '''
                    cd ${WORKSPACE}
                    rm -f openwrt/.config openwrt/files 2>/dev/null || true
                    
                    if [ -d openwrt/.git ]; then
                        echo "Submodules already initialized"
                    else
                        git submodule update --init --recursive
                    fi
                    
                    cp feeds.conf.default openwrt/feeds.conf.default
                    
                    # We only do a basic update here. Detailed install happens after switch-env
                    cd openwrt
                    docker compose run --rm chirpstack-gateway-os openwrt/scripts/feeds update -a
                    
                    touch ${WORKSPACE}/.initialized
                '''
            }
        }

        stage('Switch Environment & Install Feeds') {
                    steps {
                        sh '''#!/bin/bash
                            set -e
                            export QUILT_PATCHES=patches
                            cd ${WORKSPACE}

                            echo "=========================================="
                            echo "=== Switching to Environment: ${TARGET_ENV} ==="
                            echo "=========================================="

                            # 1. PRE-SWITCH: Ensure basic symlinks exist so Makefile doesn't error
                            rm -f openwrt/.config openwrt/files openwrt/patches
                            ln -s ../conf/.config openwrt/.config
                            ln -s ../conf/files openwrt/files
                            ln -s ../conf/patches openwrt/patches

                            # 2. EXECUTE SWITCH
                            # WARNING: This runs 'git clean -fd' which deletes the 'feeds' directory!
                            make QUILT_PATCHES=patches switch-env ENV=${TARGET_ENV} 2>&1 | tee switch-env.log

                            echo "=========================================="
                            echo "=== RE-INITIALIZING FEEDS (Critical Fix) ==="
                            echo "=========================================="

                            # 3. RESTORE CONFIG
                            # 'make switch-env' might have reverted feeds.conf.default to vanilla OpenWrt.
                            # We must ensure your custom version (with Chirpstack/Node-RED repos) is used.
                            echo "Restoring feeds.conf.default..."
                            cp feeds.conf.default openwrt/feeds.conf.default

                            cd openwrt

                            # 4. UPDATE FEEDS
                            # 'git clean' deleted the downloaded feeds. We must fetch them again.
                            echo "Updating feeds (this may take a minute)..."
                            ./scripts/feeds update -a 2>&1 | tee ../feeds-update-switch.log

                            # 5. INSTALL FEEDS
                            # Create the symlinks so the build system sees the packages
                            echo "Installing feeds..."
                            ./scripts/feeds install -a 2>&1 | tee ../feeds-install-switch.log

                            echo "✓ Feeds restored."

                            # 6. VERIFICATION
                            echo "=== Verifying Package Availability ==="
                            if ./scripts/feeds search node-red > /dev/null; then
                                echo "✓ Node-RED found in feeds."
                            else
                                echo "✗ ERROR: Node-RED still missing from feeds!"
                                exit 1
                            fi

                            if ./scripts/feeds search chirpstack-gateway-bridge > /dev/null; then
                                echo "✓ Chirpstack Gateway Bridge found in feeds."
                            else
                                echo "✗ ERROR: Chirpstack Gateway Bridge missing from feeds!"
                                exit 1
                            fi
                        '''
                    }
                }

        stage('Build') {
            steps {
                sh '''#!/bin/bash
                    set -e
                    cd ${WORKSPACE}/openwrt

                    echo "=========================================="
                    echo "=== Configuring Build ==="
                    echo "=========================================="

                    # Force defconfig to expand dependencies properly
                    # This ensures that if Node-RED needs nodejs, nodejs gets selected
                    make defconfig 2>&1 | tee ../logs/defconfig.log

                    # Check if critical packages are still enabled after config expansion
                    echo "=== Checking Config Content ==="
                    if grep -q "CONFIG_PACKAGE_chirpstack-gateway-bridge=y" .config; then
                        echo "✓ ChirpStack Gateway Bridge enabled"
                    else
                        echo "✗ WARNING: ChirpStack Gateway Bridge DISABLED"
                    fi
                    
                    if grep -q "CONFIG_PACKAGE_node-red=y" .config; then
                        echo "✓ Node-RED enabled"
                    else
                        echo "✗ WARNING: Node-RED DISABLED (Will be missing from image)"
                    fi

                    echo "=========================================="
                    echo "=== Starting Build for ${TARGET_ENV} ==="
                    echo "=========================================="
                    
                    mkdir -p ../logs
                    export FORCE_UNSAFE_CONFIGURE=1
                    
                    # Using -j$(nproc) allows using all available cores, or stick to -j2 if memory is tight
                    make -j2 2>&1 | tee ../logs/build.log
                    
                    BUILD_RESULT=${PIPESTATUS[0]}
                    
                    if [ $BUILD_RESULT -eq 0 ]; then
                        echo "✓ Build completed successfully"
                    else
                        echo "✗ Build FAILED"
                        exit $BUILD_RESULT
                    fi
                '''
            }
        }

        stage('Archive Artifacts') {
            steps {
                sh '''
                    cd ${WORKSPACE}
                    mkdir -p output/targets output/logs
                    
                    cp logs/*.log output/logs/ 2>/dev/null || true
                    
                    if [ -d openwrt/bin/targets ]; then
                        cp -r openwrt/bin/targets/* output/targets/
                        echo "✓ Artifacts copied"
                    else
                        echo "✗ No binaries found"
                        exit 1
                    fi
                '''
                archiveArtifacts artifacts: 'output/targets/**/*.img.gz, output/targets/**/*.bin, output/logs/*.log',
                               allowEmptyArchive: false,
                               fingerprint: true
            }
        }
    }

    post {
        always {
            sh 'echo "Build process finished."'
        }
    }
}
