pipeline {
    agent any

    options {
        // Keep last 2 builds, 1 with artifacts
        buildDiscarder(logRotator(
            numToKeepStr: '2',
            artifactNumToKeepStr: '1',
            daysToKeepStr: '30',
            artifactDaysToKeepStr: '15'
        ))

        // Timeout: 4 hours (first build takes longer)
        timeout(time: 4, unit: 'HOURS')

        // Add timestamps to console output
        timestamps()

        // Prevent concurrent builds
        disableConcurrentBuilds()
    }

    environment {
        // Target environment (Raspberry Pi 3)
        BUILD_ENV = 'full_raspberrypi_bcm27xx_bcm2709'

        // Build output directory
        BUILD_OUTPUT = 'openwrt/bin/targets/bcm27xx/bcm2709'

        // Minimum disk space required (GB)
        MIN_DISK_SPACE = '25'

        // Docker Compose project name (to avoid conflicts)
        COMPOSE_PROJECT_NAME = "chirpstack-build-${BUILD_NUMBER}"
    }

    triggers {
        // GitHub webhook trigger
        githubPush()
    }

    stages {
        stage('Checkout') {
            steps {
                echo '===================================='
                echo 'Checking out OSI-OS repository'
                echo '===================================='

                checkout scm

                sh '''
                    echo "Git Branch: $(git branch --show-current || echo 'detached HEAD')"
                    echo "Git Commit: $(git rev-parse HEAD)"
                    echo "Git Commit Message: $(git log -1 --pretty=%B | head -1)"
                '''
            }
        }

        stage('Environment Check') {
            steps {
                echo '===================================='
                echo 'Checking build environment'
                echo '===================================='

                script {
                    sh '''
                        echo "=== System Information ==="
                        uname -a

                        echo "\\n=== Docker Version ==="
                        docker --version
                        docker info | grep -E 'Server Version|Storage Driver|Kernel Version' || true

                        echo "\\n=== Docker Compose Version ==="
                        docker-compose --version || docker compose version || echo "Warning: docker-compose not found"

                        echo "\\n=== Disk Space ==="
                        df -h | grep -E '(Filesystem|/$|/var)'

                        echo "\\n=== Available Memory ==="
                        free -h

                        echo "\\n=== CPU Information ==="
                        echo "CPU Cores: $(nproc)"

                        echo "\\n=== Build Tools ==="
                        which gcc && gcc --version | head -1 || echo "gcc not in PATH (ok if in Docker)"
                        which make && make --version | head -1 || echo "make not in PATH (ok if in Docker)"
                        which python3 && python3 --version || echo "python3 not in PATH (ok if in Docker)"
                        git --version
                    '''

                    // Check minimum disk space
                    def availableSpace = sh(
                        script: "df -BG . | tail -1 | awk '{print \$4}' | sed 's/G//'",
                        returnStdout: true
                    ).trim().toInteger()

                    if (availableSpace < env.MIN_DISK_SPACE.toInteger()) {
                        error("Insufficient disk space! Available: ${availableSpace}GB, Required: ${env.MIN_DISK_SPACE}GB")
                    }

                    echo "✓ Disk space check passed: ${availableSpace}GB available"
                }
            }
        }

        stage('Initialize Build Environment') {
            when {
                // Only run if openwrt directory doesn't exist
                expression {
                    return !fileExists('openwrt')
                }
            }
            steps {
                echo '===================================='
                echo 'Initializing OpenWrt build environment'
                echo 'This downloads ~2GB and takes 10-15 minutes'
                echo '===================================='

                sh '''
                    echo "Starting initialization at $(date)"
                    make init
                    echo "Initialization completed at $(date)"
                '''

                echo '✓ Build environment initialized'
            }
        }

        stage('Update Feeds') {
            steps {
                echo '===================================='
                echo 'Updating OpenWrt package feeds'
                echo '===================================='

                retry(3) {
                    sh '''
                        set -e
                        echo "Updating feeds at $(date)"

                        # Run update command inside Docker container
                        # Using docker-compose run with --rm to clean up container after
                        docker-compose run --rm \
                            -e WORKDIR=/build \
                            chirpstack-gateway-os-dev \
                            bash -c "cd /build && make update"

                        echo "Feed update completed at $(date)"
                    '''
                }

                echo '✓ Feeds updated successfully'
            }
        }

        stage('Switch Environment') {
            steps {
                echo '===================================='
                echo "Switching to target: ${BUILD_ENV}"
                echo '===================================='

                sh """
                    set -e
                    echo "Switching to environment: ${BUILD_ENV}"

                    # Run switch-env command inside Docker container
                    docker-compose run --rm \
                        -e WORKDIR=/build \
                        chirpstack-gateway-os-dev \
                        bash -c "cd /build && make switch-env ENV=${BUILD_ENV}"

                    echo "Environment switched successfully"
                """

                echo '✓ Environment switched'
            }
        }

        stage('Build OSI-OS Image') {
            steps {
                echo '===================================='
                echo 'Building Open Smart Irrigation OS'
                echo 'This takes 1-4 hours on first build'
                echo '===================================='

                script {
                    def startTime = System.currentTimeMillis()

                    sh '''
                        set -e
                        echo "Build started at $(date)"
                        echo "Using $(nproc) CPU cores"

                        # Build with parallel jobs inside Docker container
                        docker-compose run --rm \
                            -e WORKDIR=/build \
                            chirpstack-gateway-os-dev \
                            bash -c "cd /build && make -j$(nproc)"

                        echo "Build completed at $(date)"
                    '''

                    def endTime = System.currentTimeMillis()
                    def duration = (endTime - startTime) / 1000 / 60
                    echo "✓ Build completed in ${duration.round(2)} minutes"
                }
            }
        }

        stage('Verify Build Output') {
            steps {
                echo '===================================='
                echo 'Verifying build artifacts'
                echo '===================================='

                script {
                    sh """
                        set -e
                        echo "=== Build Output Files ==="
                        if [ -d "${BUILD_OUTPUT}" ]; then
                            ls -lh ${BUILD_OUTPUT}/

                            echo "\\n=== Firmware Images ==="
                            find ${BUILD_OUTPUT} -name "*.img.gz" -o -name "*.img" || echo "No images found"

                            echo "\\n=== File Sizes ==="
                            du -h ${BUILD_OUTPUT}/*.img.gz 2>/dev/null || echo "No .img.gz files found"

                            # Verify at least one image exists
                            if ! ls ${BUILD_OUTPUT}/*.img.gz 1> /dev/null 2>&1; then
                                echo "ERROR: No firmware images found!"
                                exit 1
                            fi
                        else
                            echo "ERROR: Build output directory not found!"
                            exit 1
                        fi
                    """
                }

                echo '✓ Build output verified'
            }
        }

        stage('Archive Artifacts') {
            steps {
                echo '===================================='
                echo 'Archiving OSI-OS build artifacts'
                echo '===================================='

                script {
                    // Archive firmware images
                    archiveArtifacts artifacts: """
                        ${BUILD_OUTPUT}/*-factory.img.gz,
                        ${BUILD_OUTPUT}/*-sysupgrade.img.gz,
                        ${BUILD_OUTPUT}/sha256sums
                    """.trim(),
                    fingerprint: true,
                    allowEmptyArchive: false,
                    onlyIfSuccessful: true

                    // Create build metadata
                    sh """
                        cat > build-info.txt << 'BUILD_INFO_EOF'
=== Open Smart Irrigation OS Build Information ===

Build Number: ${BUILD_NUMBER}
Build Date: \$(date -u +"%Y-%m-%d %H:%M:%S UTC")

Git Information:
  Repository: https://github.com/Open-Smart-Irrigation/osi-os.git
  Branch: \$(git branch --show-current || echo 'detached HEAD')
  Commit: \$(git rev-parse HEAD)
  Commit Message: \$(git log -1 --pretty=%B | head -1)
  Author: \$(git log -1 --pretty=format:'%an <%ae>')

Build Environment:
  Target: ${BUILD_ENV}
  Jenkins Job: ${JOB_NAME}
  Build URL: ${BUILD_URL}

Firmware Images:
BUILD_INFO_EOF

                        find ${BUILD_OUTPUT} -name "*.img.gz" -exec basename {} \\; >> build-info.txt

                        echo "\\nBuild System:" >> build-info.txt
                        echo "  CPU Cores Used: \$(nproc)" >> build-info.txt
                        uname -a >> build-info.txt
                        echo "  Docker Version: \$(docker --version)" >> build-info.txt
                    """

                    archiveArtifacts artifacts: 'build-info.txt',
                                     fingerprint: true

                    sh '''
                        echo "\\n=== Archived Artifacts ==="
                        cat build-info.txt
                    '''
                }

                echo '✓ Artifacts archived'
            }
        }
    }

    post {
        success {
            echo '=========================================='
            echo '✓ OSI-OS BUILD SUCCESSFUL!'
            echo '=========================================='

            script {
                def artifactUrl = "${BUILD_URL}artifact/${BUILD_OUTPUT}/"
                echo "\\n📦 Firmware images available at:"
                echo artifactUrl
                echo "\\n📄 Build information:"
                echo "${BUILD_URL}artifact/build-info.txt"
            }
        }

        failure {
            echo '=========================================='
            echo '✗ BUILD FAILED!'
            echo '=========================================='

            script {
                echo "\\nCheck console output:"
                echo "${BUILD_URL}console"

                echo "\\nCommon failure causes:"
                echo "1. Insufficient disk space (need 25GB+)"
                echo "2. Network issues during feed updates"
                echo "3. Missing dependencies on host"
                echo "4. Docker connectivity problems"
                echo "5. Docker Compose not installed or not accessible"
                echo "6. Incorrect docker-compose.yml configuration"
            }
        }

        unstable {
            echo '⚠️ BUILD IS UNSTABLE'
        }

        aborted {
            echo '⚠️ BUILD WAS ABORTED'
        }

        always {
            echo '===================================='
            echo 'Post-Build Cleanup'
            echo '===================================='

            script {
                sh '''
                    echo "=== Final Resource Usage ==="
                    echo "Disk:"
                    df -h | grep -E '(Filesystem|/$|/var)'

                    echo "\\nMemory:"
                    free -h

                    echo "\\nWorkspace Size:"
                    du -sh . 2>/dev/null || echo "Unable to calculate"
                '''

                // Stop and remove any running containers from this build
                sh '''
                    echo "\\n=== Cleaning up Docker containers ==="
                    docker-compose down --remove-orphans || true
                '''

                // Aggressive cleanup if low on space
                def availableSpace = sh(
                    script: "df -BG . | tail -1 | awk '{print \$4}' | sed 's/G//'",
                    returnStdout: true
                ).trim().toInteger()

                if (availableSpace < 15) {
                    echo "⚠️ Low disk space: ${availableSpace}GB"
                    echo "Cleaning build intermediates..."

                    sh '''
                        # Clean OpenWrt build intermediates but keep downloads
                        if [ -d openwrt ]; then
                            docker-compose run --rm \
                                -e WORKDIR=/build \
                                chirpstack-gateway-os-dev \
                                bash -c "cd /build/openwrt && make clean" || true
                        fi

                        echo "✓ Build cleaned"
                    '''
                } else {
                    echo "✓ Sufficient space: ${availableSpace}GB remaining"
                }
            }

            echo '===================================='
            echo "Build #${BUILD_NUMBER} completed"
            echo "Duration: ${currentBuild.durationString}"
            echo '===================================='
        }
    }
}