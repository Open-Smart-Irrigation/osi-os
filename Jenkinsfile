pipeline {
    agent any

    options {
        buildDiscarder(logRotator(
            numToKeepStr: '2',
            artifactNumToKeepStr: '1',
            daysToKeepStr: '30',
            artifactDaysToKeepStr: '15'
        ))

        timeout(time: 4, unit: 'HOURS')
        timestamps()
        disableConcurrentBuilds()
    }

    environment {
        BUILD_ENV = 'full_raspberrypi_bcm27xx_bcm2709'
        BUILD_OUTPUT = 'openwrt/bin/targets/bcm27xx/bcm2709'
        MIN_DISK_SPACE = '25'
    }

    triggers {
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
                        docker info | grep -E 'Server Version|Storage Driver' || true

                        echo "\\n=== Disk Space ==="
                        df -h | grep -E '(Filesystem|/$|/var)'

                        echo "\\n=== Available Memory ==="
                        free -h

                        echo "\\n=== CPU Information ==="
                        echo "CPU Cores: $(nproc)"
                    '''

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
                    set -e
                    echo "Starting initialization at $(date)"
                    make init
                    echo "Initialization completed at $(date)"
                '''

                echo '✓ Build environment initialized'
            }
        }

        stage('Build Pipeline') {
            steps {
                echo '===================================='
                echo 'Running complete build pipeline'
                echo '===================================='

                script {
                    def startTime = System.currentTimeMillis()

                    // Create a script that will be executed inside the container
                    sh """
                        cat > /tmp/build-script-${BUILD_NUMBER}.sh << 'BUILD_SCRIPT_EOF'
#!/bin/bash
set -e

echo "========================================"
echo "Starting ChirpStack Gateway OS Build"
echo "========================================"

echo "\\n[1/4] Updating package feeds..."
make update
echo "✓ Feeds updated"

echo "\\n[2/4] Switching to target environment: ${BUILD_ENV}"
make switch-env ENV=${BUILD_ENV}
echo "✓ Environment switched"

echo "\\n[3/4] Building firmware (this takes 1-4 hours on first build)..."
echo "Build started at \$(date)"
echo "Using \$(nproc) CPU cores"
make -j\$(nproc)
echo "Build completed at \$(date)"
echo "✓ Build completed"

echo "\\n[4/4] Verifying build output..."
if [ -d "${BUILD_OUTPUT}" ]; then
    echo "Build output directory found"
    ls -lh ${BUILD_OUTPUT}/ | head -20

    if ls ${BUILD_OUTPUT}/*.img.gz 1> /dev/null 2>&1; then
        echo "✓ Firmware images created successfully"
        find ${BUILD_OUTPUT} -name "*.img.gz" -exec basename {} \\;
    else
        echo "ERROR: No firmware images found!"
        exit 1
    fi
else
    echo "ERROR: Build output directory not found!"
    exit 1
fi

echo "\\n========================================"
echo "Build Pipeline Completed Successfully"
echo "========================================"
BUILD_SCRIPT_EOF

                        chmod +x /tmp/build-script-${BUILD_NUMBER}.sh

                        # Execute the build script inside the Docker container
                        # The Makefile should handle launching Docker
                        # We pass the script to execute
                        make devshell-exec SCRIPT=/tmp/build-script-${BUILD_NUMBER}.sh || \
                        docker run --rm \
                            -v \$(pwd):/build \
                            -v /tmp/build-script-${BUILD_NUMBER}.sh:/tmp/build-script.sh:ro \
                            -w /build \
                            chirpstack/chirpstack-gateway-os-dev:latest \
                            bash /tmp/build-script.sh

                        # Cleanup
                        rm -f /tmp/build-script-${BUILD_NUMBER}.sh
                    """

                    def endTime = System.currentTimeMillis()
                    def duration = (endTime - startTime) / 1000 / 60
                    echo "✓ Complete build pipeline finished in ${duration.round(2)} minutes"
                }
            }
        }

        stage('Verify Build Output') {
            steps {
                echo '===================================='
                echo 'Final verification of build artifacts'
                echo '===================================='

                sh """
                    echo "=== Build Output Files ==="
                    ls -lh ${BUILD_OUTPUT}/

                    echo "\\n=== Firmware Images ==="
                    find ${BUILD_OUTPUT} -name "*.img.gz" -ls

                    echo "\\n=== File Sizes ==="
                    du -h ${BUILD_OUTPUT}/*.img.gz 2>/dev/null || echo "Checking files..."

                    echo "\\n=== SHA256 Checksums ==="
                    if [ -f "${BUILD_OUTPUT}/sha256sums" ]; then
                        cat ${BUILD_OUTPUT}/sha256sums
                    else
                        echo "No checksum file found"
                    fi
                """

                echo '✓ Build output verified'
            }
        }

        stage('Archive Artifacts') {
            steps {
                echo '===================================='
                echo 'Archiving OSI-OS build artifacts'
                echo '===================================='

                script {
                    archiveArtifacts artifacts: """
                        ${BUILD_OUTPUT}/*-factory.img.gz,
                        ${BUILD_OUTPUT}/*-sysupgrade.img.gz,
                        ${BUILD_OUTPUT}/sha256sums
                    """.trim(),
                    fingerprint: true,
                    allowEmptyArchive: false,
                    onlyIfSuccessful: true

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
                        echo "  System: \$(uname -a)" >> build-info.txt
                        echo "  Docker: \$(docker --version)" >> build-info.txt

                        cat build-info.txt
                    """

                    archiveArtifacts artifacts: 'build-info.txt', fingerprint: true
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
                echo "\\n📦 Firmware images: ${BUILD_URL}artifact/${BUILD_OUTPUT}/"
                echo "📄 Build info: ${BUILD_URL}artifact/build-info.txt"
            }
        }

        failure {
            echo '=========================================='
            echo '✗ BUILD FAILED!'
            echo '=========================================='

            script {
                echo "\\n📋 Console output: ${BUILD_URL}console"
                echo "\\n⚠️  Common issues:"
                echo "  • Insufficient disk space (need 25GB+)"
                echo "  • Network issues during feed updates"
                echo "  • Docker connectivity problems"
                echo "  • Missing docker group permissions for Jenkins"
            }
        }

        always {
            echo '===================================='
            echo 'Post-Build Cleanup'
            echo '===================================='

            script {
                sh '''
                    echo "=== Resource Usage ==="
                    df -h | grep -E '(Filesystem|/$|/var)'
                    echo ""
                    free -h
                    echo ""
                    du -sh . 2>/dev/null || echo "Workspace: unknown"
                '''

                def availableSpace = sh(
                    script: "df -BG . | tail -1 | awk '{print \$4}' | sed 's/G//'",
                    returnStdout: true
                ).trim().toInteger()

                if (availableSpace < 15) {
                    echo "⚠️ Low disk space: ${availableSpace}GB - cleaning build intermediates..."
                    sh '''
                        if [ -d openwrt ]; then
                            cd openwrt && make clean || true
                        fi
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
