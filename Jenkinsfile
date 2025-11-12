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
                    
                    echo "Removing workspace contents..."
                    rm -rf osi-build openwrt build_dir staging_dir output logs
                    
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
                                
                                # Check if osi-build repository exists in workspace
                                if [ ! -d osi-build ]; then
                                    echo "ERROR: osi-build repository not found in workspace!"
                                    echo ""
                                    echo "This Jenkins job requires the osi-build repository to be present."
                        echo "Expected location: ${WORKSPACE}/osi-build"
                        echo ""
                        echo "Please ensure the repository is cloned to the workspace before running this job."
                        echo "You can do this by:"
                        echo "  1. Manual git clone: git clone <repo-url> ${WORKSPACE}/osi-build"
                        echo "  2. Add a 'Checkout' stage to this Jenkinsfile"
                        echo ""
                        exit 1
                    fi
                    
                    if [ ! -f osi-build/Makefile ]; then
                        echo "ERROR: Makefile not found in osi-build directory!"
                        echo "Repository may be incomplete or corrupted."
                        exit 1
                    fi
                    
                    cd osi-build
                    
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
                expression { !fileExists("${WORKSPACE}/osi-build/.initialized") }
            }
            steps {
                sh '''
                    cd ${WORKSPACE}/osi-build
                    
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
                        git submodule update --init --recursive 2>&1 | tee ../submodule.log
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
                    touch ${WORKSPACE}/osi-build/.initialized
                    
                    echo ""
                    echo "=== Post-Init Directory Structure ==="
                    ls -la openwrt/ | head -20
                    echo ""
                '''
            }
        }

        stage('Update Feeds') {
            when {
                expression { fileExists("${WORKSPACE}/osi-build/.initialized") }
            }
            steps {
                sh '''
                    cd ${WORKSPACE}/osi-build
                    
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
                    cd ${WORKSPACE}/osi-build
                    
                    echo "=========================================="
                    echo "=== Switching to Environment: ${TARGET_ENV} ==="
                    echo "=========================================="
                    
                    # Verify target environment directory exists
                    if [ ! -d "${TARGET_ENV}" ]; then
                        echo "ERROR: Target environment directory not found: ${TARGET_ENV}"
                        echo "Available environments:"
                        ls -d full_* base_* 2>/dev/null || echo "No environment directories found"
                        exit 1
                    fi
                    
                    echo "Target environment directory contents:"
                    ls -la ${TARGET_ENV}/
                    echo ""
                    
                    # Use make switch-env
                    echo "Executing: make switch-env ENV=${TARGET_ENV}"
                    make switch-env ENV=${TARGET_ENV} 2>&1 | tee switch-env.log
                    
                    SWITCH_RESULT=$?
                    
                    if [ $SWITCH_RESULT -eq 0 ]; then
                        echo "✓ Environment switch completed successfully"
                    else
                        echo "✗ Environment switch FAILED with exit code: $SWITCH_RESULT"
                        echo ""
                        echo "=== Switch Environment Log ===" 
                        cat switch-env.log
                        echo ""
                        echo "=== Checking target environment contents ===" 
                        ls -la ${TARGET_ENV}/
                        echo ""
                        echo "=== Checking for patches directory ===" 
                        if [ -d "${TARGET_ENV}/patches" ]; then
                            ls -la ${TARGET_ENV}/patches/
                        else
                            echo "No patches directory in target environment"
                        fi
                        exit $SWITCH_RESULT
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
                    echo ""
                '''
            }
        }

        stage('Build') {
            steps {
                sh '''
                    set -e
                    cd ${WORKSPACE}/osi-build/openwrt
                    
                    echo "=========================================="
                    echo "=== Starting Build for ${TARGET_ENV} ==="
                    echo "=========================================="
                    
                    # Create logs directory
                    mkdir -p ../logs
                    
                    echo "Setting FORCE_UNSAFE_CONFIGURE=1 to bypass root configure check..."
                    export FORCE_UNSAFE_CONFIGURE=1
                    
                    echo "Running defconfig to refresh config..."
                    make defconfig 2>&1 | tee ../logs/defconfig.log
                    
                    echo ""
                    echo "Starting 2-thread build (optimized for 4 vCores, 8GB RAM)..."
                    echo "Build started at: $(date)"
                    echo ""
                    
                    # 2-thread build without verbose flag for speed
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
                        echo ""
                        echo "=== TIP: Re-run with make -j1 V=s for detailed verbose debugging ==="
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
                    
                    # Create output directories
                    mkdir -p output/logs output/targets
                    
                    # Copy build logs
                    echo "Copying build logs..."
                    cp osi-build/logs/*.log output/logs/ 2>/dev/null || echo "No logs in logs/ directory"
                    cp osi-build/*.log output/logs/ 2>/dev/null || echo "No root-level logs"
                    
                    # Copy built images from OpenWrt bin directory
                    echo "Looking for build artifacts in osi-build/openwrt/bin/targets..."
                    
                    if [ -d osi-build/openwrt/bin/targets ]; then
                        echo "Found targets directory, copying to workspace..."
                        cp -r osi-build/openwrt/bin/targets/* output/targets/
                        
                        echo ""
                        echo "=== Artifact Summary ==="
                        echo "Images built:"
                        find output/targets -type f \\( -name "*.img.gz" -o -name "*.bin" \\)
                        echo ""
                        echo "Total artifact size:"
                        du -sh output/targets
                        echo ""
                        echo "✓ Artifacts copied successfully to workspace"
                    else
                        echo "✗ ERROR: No build artifacts found!"
                        echo "Expected location: osi-build/openwrt/bin/targets"
                        ls -la osi-build/openwrt/bin/ || echo "bin directory not found"
                        exit 1
                    fi
                    echo ""
                '''

                // Archive the built images
                archiveArtifacts artifacts: 'output/targets/**/*.img.gz, output/targets/**/*.bin',
                               allowEmptyArchive: false,
                               fingerprint: true

                // Archive build logs
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
                    echo "Build Location: ${WORKSPACE}/osi-build"
                    echo "Build completed at: $(date)"
                    echo ""
                    echo "=== Disk Usage After Build ==="
                    df -h
                    echo ""
                    echo "=== Workspace Size ==="
                    du -sh ${WORKSPACE}
                    echo ""
                    echo "=== OpenWrt Build Directory Size ==="
                    du -sh ${WORKSPACE}/osi-build/openwrt 2>/dev/null || echo "OpenWrt directory not found"
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
                
                # Check for build log
                if [ -f ${WORKSPACE}/osi-build/logs/build.log ]; then
                    echo ""
                    echo "=== Last 200 lines of build log ==="
                    tail -n 200 ${WORKSPACE}/osi-build/logs/build.log
                else
                    echo "No build.log found"
                fi
                
                # Check for defconfig log
                if [ -f ${WORKSPACE}/osi-build/logs/defconfig.log ]; then
                    echo ""
                    echo "=== Last 50 lines of defconfig log ==="
                    tail -n 50 ${WORKSPACE}/osi-build/logs/defconfig.log
                fi
                
                # Check for switch-env log
                if [ -f ${WORKSPACE}/osi-build/switch-env.log ]; then
                    echo ""
                    echo "=== Last 50 lines of switch-env log ==="
                    tail -n 50 ${WORKSPACE}/osi-build/switch-env.log
                fi
                
                echo ""
                echo "=== Checking for all logs ==="
                find ${WORKSPACE}/osi-build -name "*.log" -type f 2>/dev/null | while read logfile; do
                    echo "Found log: $logfile"
                    echo "--- Last 30 lines ---"
                    tail -n 30 "$logfile"
                    echo ""
                done
                
                echo ""
                echo "=== Check for package compilation errors ==="
                if [ -f ${WORKSPACE}/osi-build/openwrt/logs/package/error.txt ]; then
                    echo "Package errors found:"
                    cat ${WORKSPACE}/osi-build/openwrt/logs/package/error.txt
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
