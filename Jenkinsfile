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
                    ls -la ${WORKSPACE}
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
                    # Ensure submodules are pulled (including the chirpstack feed)
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

                    # 1. Create dummy config links so Makefile doesn't crash
                    rm -f openwrt/.config openwrt/files openwrt/patches
                    ln -s ../conf/.config openwrt/.config
                    ln -s ../conf/files openwrt/files
                    ln -s ../conf/patches openwrt/patches

                    # 2. Run switch-env (Note: This runs 'git clean -fd' inside openwrt)
                    # This wipes out openwrt/feeds and openwrt/feeds.conf.default
                    make QUILT_PATCHES=patches switch-env ENV=${TARGET_ENV}

                    echo "=========================================="
                    echo "=== FIXING FEEDS PATHS (Critical Fix) ==="
                    echo "=========================================="

                    cd ${WORKSPACE}

                    # 3. Copy the default feeds config
                    cp feeds.conf.default openwrt/feeds.conf.default

                    # 4. REWRITE PATHS
                    # The default config uses '/workdir/...' which only exists inside the Docker container.
                    # We are building on the Host, so we must point it to ${WORKSPACE}.
                    echo "Original feeds.conf.default:"
                    cat openwrt/feeds.conf.default

                    echo "Rewriting '/workdir' to '${WORKSPACE}'..."
                    sed -i "s|/workdir|${WORKSPACE}|g" openwrt/feeds.conf.default

                    # Also handle relative paths just in case 'src-link chirpstack ../feeds/...'
                    # If we are in openwrt/, ../feeds is correct.

                    echo "Corrected feeds.conf.default:"
                    cat openwrt/feeds.conf.default

                    # 5. UPDATE & INSTALL FEEDS
                    cd openwrt
                    echo "Updating feeds..."
                    ./scripts/feeds update -a

                    echo "Installing feeds..."
                    ./scripts/feeds install -a

                    # 6. VERIFY PACKAGES EXIST
                    echo "=== Verification ==="
                    if ./scripts/feeds search chirpstack-gateway-bridge | grep -q "chirpstack-gateway-bridge"; then
                        echo "✓ ChirpStack Gateway Bridge found in feeds."
                    else
                        echo "✗ ERROR: ChirpStack Gateway Bridge NOT found in feeds."
                        echo "Debug: Content of feeds directory:"
                        ls -la feeds/
                        ls -la feeds/chirpstack/ 2>/dev/null || echo "feeds/chirpstack missing"
                        exit 1
                    fi

                    if ./scripts/feeds search node-red | grep -q "node-red"; then
                        echo "✓ Node-RED found in feeds."
                    else
                        echo "✗ ERROR: Node-RED NOT found in feeds."
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

                    # Run defconfig to apply the target and expand dependencies
                    make defconfig > ../logs/defconfig.log 2>&1

                    echo "=== checking .config for critical packages ==="
                    # We grep strictly; if these are missing, the image will be broken.

                    MISSING=0

                    if grep -q "CONFIG_PACKAGE_chirpstack-gateway-bridge=y" .config; then
                        echo "✓ ChirpStack Gateway Bridge: ENABLED"
                    else
                        echo "✗ ChirpStack Gateway Bridge: DISABLED/MISSING"
                        MISSING=1
                    fi

                    if grep -q "CONFIG_PACKAGE_node-red=y" .config; then
                        echo "✓ Node-RED: ENABLED"
                    else
                        echo "✗ Node-RED: DISABLED/MISSING"
                        MISSING=1
                    fi

                    if [ "$MISSING" -eq "1" ]; then
                        echo ""
                        echo "!!! STOPPING BUILD DUE TO MISSING PACKAGES !!!"
                        echo "Check logs/defconfig.log for dependency errors."
                        tail -n 50 ../logs/defconfig.log
                        exit 1
                    fi

                    echo "=========================================="
                    echo "=== Starting Compilation ==="
                    echo "=========================================="

                    mkdir -p ../logs
                    # IGNORE_ERRORS=m allows the build to continue if non-essential modules fail,
                    # but we usually want strict builds.
                    make -j2 download world 2>&1 | tee ../logs/build.log
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