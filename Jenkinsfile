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
        // Optional: control parallelism later
        // choice(name: 'BUILD_THREADS', choices: ['1','2','4','auto'], description: 'Number of parallel build threads')
        // booleanParam(name: 'VERBOSE_BUILD', defaultValue: false, description: 'Enable verbose build output')
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
                    echo "=========================================="
                    echo ""
                    echo "=== Current User ==="
                    whoami
                    id
                    echo ""
                    echo "=== Disk Space ==="
                    df -h
                    echo ""
                    echo "=== Jenkins Workspace ==="
                    echo "WORKSPACE: ${WORKSPACE}"
                    ls -la ${WORKSPACE}
                    echo ""
                    echo "=== Docker Environment ==="
                    which docker || echo "Docker not found in PATH"
                    docker --version || echo "Docker command failed"
                    docker compose version || echo "Docker Compose V2 not available"
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
                    
                    cd ${WORKSPACE}
                    
                    echo "Removing build artifacts and caches..."
                    rm -rf openwrt/bin openwrt/build_dir openwrt/staging_dir openwrt/tmp
                    rm -rf logs output .initialized
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
                    
                    cd ${WORKSPACE}
                    
                    echo "Workspace location: ${WORKSPACE}"
                    echo ""
                    
                    # Create necessary directories
                    mkdir -p logs output
                    
                    # Ensure osi-build contents exist at workspace root
                    if [ ! -f Makefile ]; then
                        echo "ERROR: Makefile not found at workspace root. Ensure the repository is checked out here."
                        echo "Expected: ${WORKSPACE}/Makefile"
                        ls -la
                        exit 1
                    fi
                    
                    echo ""
                    echo "=== Build Repository Contents ==="
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
                    echo "✓ Build directory setup complete"
                    echo ""
                '''
            }
        }

        stage('Initialize Build Environment') {
            when {
                expression { !fileExists("${WORKSPACE}/.initialized") }
            }
            steps {
                sh '''
                    cd ${WORKSPACE}
                    
                    echo "=========================================="
                    echo "=== Initializing Build Environment ==="
                    echo "=========================================="
                    
                    # Basic cleanup
                    rm -f openwrt/.config 2>/dev/null || true
                    rm -f openwrt/files 2>/dev/null || true
                    
                    # Initialize submodules if needed
                    if [ -d openwrt/.git ]; then
                        echo "Submodules already initialized"
                    else
                        echo "Initializing git submodules..."
                        git submodule update --init --recursive 2>&1 | tee submodule.log
                    fi
                    
                    # Feeds setup
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
                    echo "=== Step 4: Create patches symlink ==="
                    rm -f openwrt/patches
                    ln -s ../conf/patches openwrt/patches
                    ls -l openwrt/patches
                    
                    echo ""
                    echo "=== Step 5: Update feeds ==="
                    cd openwrt
                    ./scripts/feeds update -a 2>&1 | tee ../feeds-update.log
                    
                    echo ""
                    echo "=== Step 6: Install feeds ==="
                    ./scripts/feeds install -a 2>&1 | tee ../feeds-install.log
                    
                    cd ..
                    
                    echo ""
                    echo "✓ Initialization completed successfully"
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
                expression { fileExists("${WORKSPACE}/.initialized") }
            }
            steps {
                sh '''
                    cd ${WORKSPACE}
                    
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
                sh '''#!/bin/bash
                    set -e
                    export QUILT_PATCHES=patches
                    
                    cd ${WORKSPACE}
                    
                    echo "=========================================="
                    echo "=== Switching to Environment: ${TARGET_ENV} ==="
                    echo "=========================================="
                    
                    # Remove any previous patch-related assumptions
                    # (no quilt patch fixers in this streamlined flow)
                    
                    # Verify target environment directory exists in conf/
                    if [ ! -d "conf/${TARGET_ENV}" ]; then
                        echo "ERROR: Target environment directory not found: conf/${TARGET_ENV}"
                        echo "See available environments:"
                        ls -d conf/full_* conf/base_* 2>/dev/null || echo "No environment directories found"
                        exit 1
                    fi
                    
                    echo "Target environment directory contents:"
                    ls -la conf/${TARGET_ENV}/
                    echo ""
                    
                    echo "=== Ensuring openwrt symlinks exist ==="
                    # Create these BEFORE switch-env so quilt can find patches
                    rm -f openwrt/.config openwrt/files openwrt/patches
                    ln -s ../conf/.config openwrt/.config
                    ln -s ../conf/files openwrt/files
                    ln -s ../conf/patches openwrt/patches
                    echo "Symlinks created:"
                    ls -l openwrt/.config openwrt/files openwrt/patches
                    echo ""
                    
                    echo "=== Debugging patch symlink chain ==="
                    echo "1. Check openwrt/patches symlink:"
                    ls -la openwrt/patches
                    echo ""
                    echo "2. Check where openwrt/patches points (should be ../conf/patches):"
                    readlink openwrt/patches
                    echo ""
                    echo "3. Check if ../conf/patches exists from openwrt dir:"
                    ls -la openwrt/../conf/patches 2>&1 || echo "Does not exist or broken"
                    echo ""
                    echo "4. Check conf/patches symlink:"
                    ls -la conf/patches 2>&1 || echo "conf/patches does not exist yet"
                    echo ""
                    echo "5. Try to access openwrt/patches/series:"
                    ls -la openwrt/patches/series 2>&1 || echo "Cannot access openwrt/patches/series"
                    echo ""
                    echo "6. Try to cd to openwrt and list patches:"
                    (cd openwrt && ls -la patches/) 2>&1 || echo "Cannot list patches from openwrt"
                    echo ""
                    echo "7. Try to cd to openwrt and read patches/series:"
                    (cd openwrt && cat patches/series) 2>&1 || echo "Cannot read patches/series from openwrt"
                    echo ""
                    
                    echo "Executing: make switch-env ENV=${TARGET_ENV}"
                    make switch-env ENV=${TARGET_ENV} 2>&1 | tee switch-env.log
                    
                    if [ ${PIPESTATUS[0]} -eq 0 ]; then
                        echo "✓ Environment switch completed successfully"
                    else
                        echo "✗ Environment switch FAILED"
                        tail -n 100 switch-env.log || true
                        exit 1
                    fi
                    
                    echo ""
                    echo "=== Verifying patches/series is accessible ==="
                    if [ -f openwrt/patches/series ]; then
                        echo "✓ patches/series found"
                        echo "Series file contents:"
                        cat openwrt/patches/series
                    else
                        echo "✗ WARNING: patches/series not found!"
                        echo "Symlink chain:"
                        ls -la openwrt/patches
                        ls -la conf/patches
                    fi
                    echo ""
                    echo "=== Current Configuration ==="
                    if [ -f openwrt/.config ]; then
                        echo "Config file exists (symlink):"
                        ls -l openwrt/.config
                        echo ""
                        echo "Config file size: $(wc -l < openwrt/.config 2>/dev/null || echo 'N/A') lines"
                        echo "First 20 lines of config:"
                        head -20 openwrt/.config 2>/dev/null || echo "Cannot read config"
                    else
                        echo "WARNING: openwrt/.config not found or broken symlink"
                        ls -la openwrt/.config 2>/dev/null || echo "No .config found"
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
                    echo "=== Starting Build for ${TARGET_ENV} ==="
                    echo "=========================================="
                    
                    mkdir -p ../logs
                    export FORCE_UNSAFE_CONFIGURE=1
                    
                    echo "Running defconfig to refresh config..."
                    make defconfig 2>&1 | tee ../logs/defconfig.log
                    
                    echo ""
                    echo "Starting 2-thread build (uses 2 cores by default)"
                    echo "Build started at: $(date)"
                    echo ""
                    
                    make -j2 2>&1 | tee ../logs/build.log
                    
                    BUILD_RESULT=${PIPESTATUS[0]}
                    
                    echo ""
                    echo "Build finished at: $(date)"
                    
                    if [ $BUILD_RESULT -eq 0 ]; then
                        echo "✓ Build completed successfully"
                    else
                        echo "✗ Build FAILED with exit code: $BUILD_RESULT"
                        echo ""
                        echo "=== Last 200 lines of build output ==="
                        tail -n 200 ../logs/build.log
                        exit $BUILD_RESULT
                    fi
                    
                    echo ""
                    echo "=== Build Output Directory Contents ==="
                    if [ -d bin ]; then
                        echo "Firmware images created:"
                        find bin -type f \\( -name "*.img.gz" -o -name "*.bin" \\) | head -20
                        echo ""
                        echo "Total binary size:"
                        du -sh bin
                    else
                        echo "✗ ERROR: bin directory not found!"
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
                    
                    cd ${WORKSPACE}
                    
                    mkdir -p output/logs output/targets
                    
                    echo "Copying build logs..."
                    cp logs/*.log output/logs/ 2>/dev/null || echo "No logs in logs/ directory"
                    cp *.log output/logs/ 2>/dev/null || echo "No root-level logs"
                    
                    echo "Looking for build artifacts in openwrt/bin/targets..."
                    if [ -d openwrt/bin/targets ]; then
                        echo "Found targets directory, copying to workspace..."
                        cp -r openwrt/bin/targets/* output/targets/
                        echo ""
                        echo "=== Artifact Summary ==="
                        find output/targets -type f \\( -name "*.img.gz" -o -name "*.bin" \\)
                        echo ""
                        echo "Total artifact size:"
                        du -sh output/targets
                        echo ""
                        echo "✓ Artifacts copied successfully to workspace"
                    else
                        echo "✗ ERROR: No build artifacts found!"
                        ls -la openwrt/bin/ || echo "bin directory not found"
                        exit 1
                    fi
                    echo ""
                '''

                archiveArtifacts artifacts: 'output/targets/**/*.img.gz, output/targets/**/*.bin',
                               allowEmptyArchive: false,
                               fingerprint: true

                archiveArtifacts artifacts: 'output/logs/*.log',
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
                    echo "Build Location: ${WORKSPACE}"
                    echo "Build completed at: $(date)"
                    echo ""
                    echo "=== Disk Usage After Build ==="
                    df -h
                    echo ""
                    echo "=== Workspace Size ==="
                    du -sh ${WORKSPACE}
                    echo ""
                    echo "=== OpenWrt Build Directory Size ==="
                    du -sh ${WORKSPACE}/openwrt 2>/dev/null || echo "OpenWrt directory not found"
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
            sh '''
                echo "✓✓✓ BUILD SUCCESS ✓✓✓"
                echo "Build completed successfully for ${TARGET_ENV}"
                echo "Artifacts have been archived and are available for download"
                echo ""
                echo "Artifact location in workspace:"
                ls -la ${WORKSPACE}/output/
            '''
        }
        failure {
            sh '''
                echo "✗✗✗ BUILD FAILED ✗✗✗"
                echo "Build failed for ${TARGET_ENV}"
                echo ""
                echo "=== Troubleshooting Information ==="
                
                # Show last part of build log if present
                if [ -f ${WORKSPACE}/logs/build.log ]; then
                    tail -n 200 ${WORKSPACE}/logs/build.log
                fi
                
                # Show defconfig log if present
                if [ -f ${WORKSPACE}/logs/defconfig.log ]; then
                    tail -n 50 ${WORKSPACE}/logs/defconfig.log
                fi
                
                # Show switch-env log if present
                if [ -f ${WORKSPACE}/switch-env.log ]; then
                    tail -n 50 ${WORKSPACE}/switch-env.log
                fi
                
                # List all logs
                echo ""
                echo "=== Checking for all logs ==="
                find ${WORKSPACE} -name "*.log" -type f 2>/dev/null | while read logfile; do
                    echo "Found log: $logfile"
                    tail -n 30 "$logfile"
                    echo ""
                done
                
                # Check for package errors
                if [ -f ${WORKSPACE}/openwrt/logs/package/error.txt ]; then
                    echo "Package errors found:"
                    cat ${WORKSPACE}/openwrt/logs/package/error.txt
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
                echo "=== Workspace Size ==="
                du -sh ${WORKSPACE}
                echo "=========================================="
            '''
        }
    }
}
