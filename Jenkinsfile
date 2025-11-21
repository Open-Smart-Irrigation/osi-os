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
            description: 'Clean before build (Removes build artifacts)'
        )
    }

    options {
        buildDiscarder(logRotator(numToKeepStr: '5'))
        timestamps()
        timeout(time: 12, unit: 'HOURS')
    }

    stages {
        stage('1. Environment Verification') {
            steps {
                sh '''
                    echo "=== Checking Build Container Capabilities ==="
                    echo "Current User: $(whoami)"
                    
                    # Verify the critical tools you added to the Dockerfile exist
                    echo "Checking Clang (Required for Rust/Bindgen):"
                    clang --version || echo "WARNING: Clang not found"
                    
                    echo "Checking Pkg-Config (Required for SSL):"
                    pkg-config --version || echo "WARNING: Pkg-Config not found"
                    
                    echo "Checking Disk Space:"
                    df -h
                '''
            }
        }

        stage('2. Clean Workspace') {
            when { expression { params.CLEAN_BUILD } }
            steps {
                sh '''
                    cd ${WORKSPACE}
                    echo "Cleaning build directory..."
                    rm -rf openwrt/bin openwrt/build_dir openwrt/staging_dir openwrt/tmp
                    rm -rf logs output .initialized
                    
                    # We purposefully keep 'openwrt/dl' to save download time
                    echo "✓ Clean complete."
                '''
            }
        }

        stage('3. Initialize & Switch Environment') {
            steps {
                sh '''#!/bin/bash
                    set -e
                    cd ${WORKSPACE}
                    
                    # 1. Initialize Git Submodules
                    if [ ! -f .initialized ]; then
                        git submodule update --init --recursive
                        touch .initialized
                    fi
                    
                    # 2. Prepare Symlinks for Switch
                    rm -f openwrt/.config openwrt/files openwrt/patches
                    ln -s ../conf/.config openwrt/.config
                    ln -s ../conf/files openwrt/files
                    ln -s ../conf/patches openwrt/patches
                    
                    # 3. Switch Environment (This wipes the feeds directory)
                    echo "Switching to target: ${TARGET_ENV}"
                    make QUILT_PATCHES=patches switch-env ENV=${TARGET_ENV}
                    
                    # 4. Restore Feeds Config & Fix Paths
                    # This is critical because Jenkins runs on the Host path, not the Docker internal path
                    cp feeds.conf.default openwrt/feeds.conf.default
                    sed -i "s|/workdir|${WORKSPACE}|g" openwrt/feeds.conf.default
                    
                    # 5. Update & Install Feeds
                    # Must be done AFTER switch-env
                    cd openwrt
                    ./scripts/feeds update -a
                    ./scripts/feeds install -a
                    
                    echo "✓ Environment ready."
                '''
            }
        }

        stage('4. Configure & Build') {
            steps {
                sh '''#!/bin/bash
                    set -e
                    # Required for running tools like tar/gzip as root inside Docker
                    export FORCE_UNSAFE_CONFIGURE=1
                    
                    mkdir -p ${WORKSPACE}/logs
                    cd ${WORKSPACE}/openwrt

                    echo "=========================================="
                    echo "=== 4.1 Configuration ==="
                    echo "=========================================="
                    
                    # Generate the full .config from defaults
                    make defconfig > ../logs/defconfig.log 2>&1
                    
                    echo "=========================================="
                    echo "=== 4.2 Downloading Sources ==="
                    echo "=========================================="
                    
                    # We use -j4 here because downloading is not memory intensive
                    make -j4 download > ../logs/download.log 2>&1 || true
                    
                    echo "=========================================="
                    echo "=== 4.3 Compiling Firmware ==="
                    echo "=========================================="
                    echo "Starting build with -j1 (Single Core) for stability."
                    echo "Output is being logged to screen and file."
                    
                    # We use -j1 to ensure Rust has enough memory.
                    # We use 'tee' to show progress on the console.
                    
                    if ! make -j1 world 2>&1 | tee ../logs/build_main.log; then
                        echo ""
                        echo "❌❌❌ BUILD FAILED ❌❌❌"
                        echo "Check the logs above for details."
                        exit 1
                    fi
                    
                    echo "✓ Build Completed Successfully"
                '''
            }
        }

        stage('5. Archive Artifacts') {
            steps {
                sh '''
                    mkdir -p output/targets output/logs
                    cp logs/*.log output/logs/ 2>/dev/null || true
                    
                    # Copy firmware images
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
