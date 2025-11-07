pipeline {
    agent any

    parameters {
        choice(
            name: 'TARGET_ENV',
            choices: [
                'full_raspberrypi_bcm27xx_bcm2709',
                'full_raspberrypi_bcm27xx_bcm2708',
                'full_raspberrypi_bcm27xx_bcm2710',
                'full_raspberrypi_bcm27xx_bcm2711',
                'base_raspberrypi_bcm27xx_bcm2709',
                'base_raspberrypi_bcm27xx_bcm2708',
                'base_raspberrypi_bcm27xx_bcm2710',
                'base_raspberrypi_bcm27xx_bcm2711'
            ],
            description: 'Target platform'
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
        timeout(time: 6, unit: 'HOURS')
    }

    stages {
        stage('Check Space & Environment') {
            steps {
                sh '''
                    echo "=========================================="
                    echo "=== Environment Check ==="
                    echo "=========================================="
                    echo ""
                    echo "=== Current User ==="
                    whoami
                    id
                    echo ""
                    echo "=== Disk Space ==="
                    df -h
                    echo ""
                    echo "=== Build Cache Location ==="
                    ls -la /build_cache || echo "Build cache not found"
                    df -h /build_cache 2>/dev/null || echo "Build cache not mounted"
                    echo ""
                    echo "=== Docker Environment ==="
                    which docker || echo "Docker not found in PATH"
                    docker --version || echo "Docker command failed"
                    docker compose version || echo "Docker Compose V2 not available"
                    echo ""
                    echo "=== Docker Socket Permissions ==="
                    ls -l /var/run/docker.sock
                    echo ""
                    echo "=== Test Docker Access ==="
                    docker ps || echo "Cannot access Docker daemon"
                    echo ""
                    echo "=========================================="
                '''
            }
        }

        stage('Clean') {
            when {
                expression { params.CLEAN_BUILD }
            }
            steps {
                sh '''
                    echo "=========================================="
                    echo "=== Performing Clean Build ==="
                    echo "=========================================="
                    echo "Removing /build_cache/osi-build completely"
                    rm -rf /build_cache/osi-build || true
                    echo "Removing initialization flags"
                    rm -f ${WORKSPACE}/.initialized || true
                    rm -f /build_cache/.initialized || true
                    echo "Clean completed"
                    echo ""
                '''
            }
        }

        stage('Setup Build Directory') {
            steps {
                sh '''
                    echo "=========================================="
                    echo "=== Setting Up Build Directory ==="
                    echo "=========================================="

                    # Ensure build_cache directory exists
                    mkdir -p /build_cache

                    # Check if we need to setup from scratch
                    if [ ! -d /build_cache/osi-build ] || [ ! -d /build_cache/osi-build/.git ]; then
                        echo "Build directory doesn't exist or is incomplete. Setting up fresh copy..."

                        # Remove any partial builds
                        rm -rf /build_cache/osi-build

                        # Clone the workspace to build_cache
                        echo "Copying workspace to /build_cache/osi-build..."
                        cp -r ${WORKSPACE} /build_cache/osi-build

                        echo "✓ Build directory created"
                    else
                        echo "Build directory already exists, checking for updates..."

                        # Sync any changes from workspace (for code updates)
                        rsync -av --exclude='.git' --exclude='openwrt' ${WORKSPACE}/ /build_cache/osi-build/ || true

                        echo "✓ Build directory synced"
                    fi

                    cd /build_cache/osi-build

                    echo ""
                    echo "=== Repository Contents ==="
                    ls -la

                    echo ""
                    echo "=== Checking for Makefile ==="
                    if [ -f Makefile ]; then
                        echo "✓ Makefile found"
                        echo "Available make targets:"
                        grep "^[a-zA-Z_-]*:" Makefile | head -20
                    else
                        echo "✗ ERROR: Makefile not found!"
                        exit 1
                    fi
                    echo ""
                '''
            }
        }

        stage('Initialize Build Environment') {
            when {
                expression { !fileExists('/build_cache/osi-build/.initialized') }
            }
            steps {
                sh '''
                    cd /build_cache/osi-build

                    echo "=========================================="
                    echo "=== Initializing Build Environment ==="
                    echo "=========================================="

                    # Clean up any existing symlinks or config files that might conflict
                    echo "Cleaning up potential conflicts..."
                    rm -f openwrt/.config 2>/dev/null || true
                    rm -f openwrt/files 2>/dev/null || true

                    # If openwrt directory doesn't exist, git submodule hasn't been initialized
                    if [ ! -d openwrt/.git ]; then
                        echo "Initializing git submodules..."
                        git submodule update --init --recursive 2>&1 | tee submodule.log
                    fi

                    # Now run make init manually step-by-step to avoid conflicts
                    echo ""
                    echo "=== Step 1: Copy feeds config ==="
                    cp feeds.conf.default openwrt/feeds.conf.default

                    echo ""
                    echo "=== Step 2: Create .config symlink ==="
                    rm -f openwrt/.config
                    ln -s ../conf/.config openwrt/.config
                    ls -l openwrt/.config

                    echo ""
                    echo "=== Step 3: Create files symlink ==="
                    rm -f openwrt/files
                    ln -s ../conf/files openwrt/files
                    ls -l openwrt/files

                    echo ""
                    echo "=== Step 4: Update feeds ==="
                    cd openwrt
                    ./scripts/feeds update -a 2>&1 | tee ../feeds-update.log

                    echo ""
                    echo "=== Step 5: Install feeds ==="
                    ./scripts/feeds install -a 2>&1 | tee ../feeds-install.log

                    cd ..

                    echo ""
                    echo "✓ Initialization completed successfully"
                    touch /build_cache/osi-build/.initialized
                    touch ${WORKSPACE}/.initialized

                    echo ""
                    echo "=== Post-Init Directory Structure ==="
                    ls -la openwrt/ | head -20
                    echo ""
                '''
            }
        }

        stage('Update Feeds') {
            when {
                expression { fileExists('/build_cache/osi-build/.initialized') }
            }
            steps {
                sh '''
                    cd /build_cache/osi-build

                    echo "=========================================="
                    echo "=== Updating Feeds ==="
                    echo "=========================================="

                    cd openwrt
                    ./scripts/feeds update -a 2>&1 | tee ../feeds-update-refresh.log
                    ./scripts/feeds install -a 2>&1 | tee ../feeds-install-refresh.log
                    cd ..

                    echo "✓ Feeds updated successfully"
                    echo ""
                '''
            }
        }

        stage('Switch Environment') {
            steps {
                sh '''
                    cd /build_cache/osi-build

                    echo "=========================================="
                    echo "=== Switching to Environment: ${TARGET_ENV} ==="
                    echo "=========================================="

                    # Use make switch-env
                    make switch-env ENV=${TARGET_ENV} 2>&1 | tee switch-env.log

                    if [ $? -eq 0 ]; then
                        echo "✓ Environment switch completed successfully"
                    else
                        echo "✗ Environment switch FAILED"
                        cat switch-env.log
                        exit 1
                    fi

                    echo ""
                    echo "=== Current Configuration ==="
                    if [ -f openwrt/.config ]; then
                        echo "Config file exists (symlink):"
                        ls -l openwrt/.config
                        echo ""
                        echo "Config file size: $(wc -l < openwrt/.config 2>/dev/null || echo 'N/A')"
                        echo "First 20 lines of config:"
                        head -20 openwrt/.config 2>/dev/null || echo "Cannot read config"
                    else
                        echo "WARNING: openwrt/.config not found"
                    fi
                    echo ""
                '''
            }
        }

        stage('Build') {
            steps {
                sh '''
                    set -e
                    cd /build_cache/osi-build/openwrt

                    echo "=========================================="
                    echo "=== Starting Build for ${TARGET_ENV} ==="
                    echo "=========================================="

                    echo "Setting FORCE_UNSAFE_CONFIGURE=1 to bypass root configure check..."
                    export FORCE_UNSAFE_CONFIGURE=1

                    echo "Running defconfig to refresh config..."
                    make defconfig 2>&1 | tee ../logs/defconfig.log

                    echo "Starting verbose single-threaded build (this may take hours)..."
                    make -j1 V=s 2>&1 | tee ../logs/build_verbose.log

                    BUILD_RESULT=${PIPESTATUS[0]}

                    if [ $BUILD_RESULT -eq 0 ]; then
                        echo "✓ Build completed successfully"
                    else
                        echo "✗ Build FAILED with exit code: $BUILD_RESULT"
                        echo "=== Last 200 lines of build output ==="
                        tail -n 200 ../logs/build_verbose.log
                        exit $BUILD_RESULT
                    fi

                    echo ""
                    echo "=== Build Output Directory Contents ==="
                    if [ -d bin ]; then
                        find bin -type f \\( -name "*.img.gz" -o -name "*.bin" \\) | head -20
                        du -sh bin
                    else
                        echo "Warning: bin directory not found!"
                        exit 1
                    fi
                    echo ""
                '''
            }
        }

        stage('Archive Artifacts') {
            steps {
                sh '''
                    echo "=========================================="
                    echo "=== Archiving Build Artifacts ==="
                    echo "=========================================="

                    # Create output directory in workspace
                    mkdir -p ${WORKSPACE}/output
                    mkdir -p ${WORKSPACE}/logs

                    # Copy build logs
                    echo "Copying build logs..."
                    cp /build_cache/osi-build/logs/*.log ${WORKSPACE}/logs/ 2>/dev/null || echo "No logs in logs/ directory"
                    cp /build_cache/osi-build/*.log ${WORKSPACE}/logs/ 2>/dev/null || echo "No root-level logs"

                    # Copy built images
                    if [ -d /build_cache/osi-build/openwrt/bin/targets ]; then
                        echo "Copying build artifacts..."
                        cp -r /build_cache/osi-build/openwrt/bin/targets ${WORKSPACE}/output/

                        echo ""
                        echo "=== Artifact Summary ==="
                        echo "Images built:"
                        find ${WORKSPACE}/output/targets -type f \\( -name "*.img.gz" -o -name "*.bin" \\)
                        echo ""
                        echo "Total artifact size:"
                        du -sh ${WORKSPACE}/output/targets

                    else
                        echo "✗ ERROR: No build artifacts found!"
                        echo "Build may have failed or not produced output"
                        exit 1
                    fi
                    echo ""
                '''

                // Archive the built images
                archiveArtifacts artifacts: 'output/targets/**/*.img.gz, output/targets/**/*.bin',
                               allowEmptyArchive: false,
                               fingerprint: true

                // Archive build logs
                archiveArtifacts artifacts: 'logs/*.log',
                               allowEmptyArchive: true,
                               fingerprint: false
            }
        }

        stage('Build Summary') {
            steps {
                sh '''
                    echo "=========================================="
                    echo "=== Build Summary ==="
                    echo "=========================================="
                    echo "Target Environment: ${TARGET_ENV}"
                    echo "Build Location: /build_cache/osi-build"
                    echo "Build completed at: $(date)"
                    echo ""
                    echo "=== Disk Usage After Build ==="
                    df -h /build_cache
                    echo ""
                    echo "=== Build Cache Size ==="
                    du -sh /build_cache/osi-build 2>/dev/null || echo "Build directory not accessible"
                    echo ""
                    echo "=== OpenWrt Build Directory Size ==="
                    du -sh /build_cache/osi-build/openwrt 2>/dev/null || echo "OpenWrt directory not found"
                    echo ""
                    echo "=== Final Artifacts ==="
                    find ${WORKSPACE}/output -type f \\( -name "*.img.gz" -o -name "*.bin" \\) -exec ls -lh {} \\;
                    echo ""
                    echo "=========================================="
                '''
            }
        }
    }

    post {
        success {
            echo "✓✓✓ BUILD SUCCESS ✓✓✓"
            echo "Build completed successfully for ${params.TARGET_ENV}"
            echo "Artifacts have been archived and are available for download"
        }
        failure {
            echo "✗✗✗ BUILD FAILED ✗✗✗"
            echo "Build failed for ${params.TARGET_ENV}"
            sh '''
                echo ""
                echo "=== Troubleshooting Information ==="

                # Check if logs exist
                if [ -f /build_cache/osi-build/logs/build.log ]; then
                    echo "=== Last 150 lines of build log ==="
                    tail -n 150 /build_cache/osi-build/logs/build.log
                else
                    echo "No build.log found at /build_cache/osi-build/logs/build.log"
                fi

                echo ""
                echo "=== Checking for other logs ==="
                find /build_cache/osi-build -name "*.log" -type f 2>/dev/null | while read logfile; do
                    echo "Found log: $logfile"
                    echo "--- Last 50 lines of $logfile ---"
                    tail -n 50 "$logfile"
                    echo ""
                done

                echo ""
                echo "=== Build directory contents ==="
                ls -la /build_cache/osi-build 2>/dev/null || echo "Build directory not accessible"

                echo ""
                echo "=== OpenWrt directory check ==="
                ls -la /build_cache/osi-build/openwrt 2>/dev/null | head -30 || echo "OpenWrt directory not found"

                echo ""
                echo "=== Check for compilation errors ==="
                if [ -f /build_cache/osi-build/openwrt/logs/package/error.txt ]; then
                    echo "Package compilation errors found:"
                    cat /build_cache/osi-build/openwrt/logs/package/error.txt
                fi
            '''
        }
        always {
            sh '''
                echo ""
                echo "=========================================="
                echo "=== Final Status ==="
                echo "=========================================="
                echo "=== Final Disk Space ==="
                df -h
                echo ""
                echo "=== Build Cache Size ==="
                du -sh /build_cache/osi-build 2>/dev/null || echo "Build directory not found"
                echo ""
                echo "=== Workspace Size ==="
                du -sh ${WORKSPACE}
                echo "=========================================="
            '''
        }
    }
}
