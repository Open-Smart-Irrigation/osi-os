pipeline {
    agent any

    parameters {
        choice(
            name: 'TARGET_ENV',
            choices: [
                'full_raspberrypi_bcm27xx_bcm2709',
                'full_raspberrypi_bcm27xx_bcm2708',
                'full_raspberrypi_bcm27xx_bcm2710',
                'full_raspberrypi_bcm27xx_bcm2711'
            ],
            description: 'Target environment for build'
        )
        booleanParam(
            name: 'CLEAN_BUILD',
            defaultValue: false,
            description: 'Perform a clean build (removes all build artifacts)'
        )
        booleanParam(
            name: 'FORCE_INIT',
            defaultValue: false,
            description: 'Force re-initialization of build environment'
        )
    }

    environment {
        // Ensure Docker is available
        DOCKER_BUILDKIT = '1'
        // Set workspace for large builds
        BUILD_DIR = "${WORKSPACE}/chirpstack-gateway-os"
    }

    options {
        // Keep builds for 30 days or 10 builds
        buildDiscarder(logRotator(numToKeepStr: '10', daysToKeepStr: '30'))
        // Add timestamps to console output
        timestamps()
        // Timeout for the entire build
        timeout(time: 4, unit: 'HOURS')
        // Don't allow concurrent builds on same node
        disableConcurrentBuilds()
    }

    stages {
        stage('Check Prerequisites') {
            steps {
                script {
                    echo "Checking build prerequisites..."
                    sh '''
                        echo "=== System Information ==="
                        uname -a
                        echo ""
                        echo "=== Docker Version ==="
                        docker --version
                        echo ""
                        echo "=== Disk Space ==="
                        df -h ${WORKSPACE}
                    '''

                    // Check minimum disk space (20GB)
                    def diskSpace = sh(
                        script: "df ${WORKSPACE} | tail -1 | awk '{print \$4}'",
                        returnStdout: true
                    ).trim().toLong()

                    if (diskSpace < 20000000) { // 20GB in KB
                        error("Insufficient disk space. Need at least 20GB free.")
                    }
                }
            }
        }

        stage('Clean Workspace') {
            when {
                expression { params.CLEAN_BUILD == true }
            }
            steps {
                echo "Performing clean build..."
                sh '''
                    echo "Cleaning build artifacts..."
                    make clean || true
                '''
            }
        }

        stage('Initialize Build Environment') {
            when {
                anyOf {
                    expression { params.FORCE_INIT == true }
                    expression { !fileExists('.initialized') }
                }
            }
            steps {
                echo "Initializing OpenWrt build environment..."
                sh '''
                    echo "Running make init..."
                    make init

                    # Create marker file to skip this step on subsequent builds
                    touch .initialized
                    echo "Initialization completed at $(date)" >> .initialized
                '''
            }
        }

        stage('Update Feeds') {
            steps {
                echo "Updating OpenWrt feeds..."
                sh 'make update'
            }
        }

        stage('Switch Environment') {
            steps {
                echo "Switching to target environment: ${params.TARGET_ENV}"
                sh 'make switch-env ENV=${TARGET_ENV}'
            }
        }

        stage('Build Image') {
            steps {
                echo "Building ChirpStack Gateway OS image..."
                echo "This may take 1-3 hours depending on hardware..."
                sh 'make'
            }
        }

        stage('Collect Artifacts') {
            steps {
                script {
                    echo "Collecting build artifacts..."

                    // Find the target directory based on environment
                    def targetPath = sh(
                        script: '''
                            find openwrt/bin/targets -type f -name "*.img.gz" -o -name "*.bin" | head -1 | xargs dirname || echo "openwrt/bin/targets"
                        ''',
                        returnStdout: true
                    ).trim()

                    if (targetPath && fileExists(targetPath)) {
                        echo "Artifacts found in: ${targetPath}"

                        // Archive the artifacts
                        archiveArtifacts artifacts: "${targetPath}/*",
                                       fingerprint: true,
                                       allowEmptyArchive: true

                        // List built images
                        sh "ls -lh ${targetPath}/"
                    } else {
                        echo "Warning: No artifacts found. Build may have failed."
                    }
                }
            }
        }

        stage('Generate Build Report') {
            steps {
                script {
                    def buildReport = """
                    ╔════════════════════════════════════════════════════╗
                    ║     ChirpStack Gateway OS Build Report            ║
                    ╚════════════════════════════════════════════════════╝

                    Build Number:    ${env.BUILD_NUMBER}
                    Target:          ${params.TARGET_ENV}
                    Clean Build:     ${params.CLEAN_BUILD}
                    Build Time:      ${currentBuild.durationString}
                    Status:          ${currentBuild.result ?: 'SUCCESS'}

                    Build Artifacts:
                    """.stripIndent()

                    sh '''
                        echo "Finding build artifacts..."
                        find openwrt/bin/targets -type f \\( -name "*.img.gz" -o -name "*.bin" \\) -exec ls -lh {} \\; || echo "No artifacts found"
                    '''

                    echo buildReport
                }
            }
        }
    }

    post {
        success {
            echo "✅ Build completed successfully!"
            echo "Build artifacts have been archived and are available in Jenkins."
        }

        failure {
            echo "❌ Build failed!"
            echo "Check the console output for errors."

            // Collect logs for debugging
            sh '''
                echo "=== Docker Containers ==="
                docker ps -a || true
                echo ""
                echo "=== Recent Docker Logs ==="
                docker ps -q | xargs -r docker logs --tail=50 || true
                echo ""
                echo "=== Disk Space ==="
                df -h
            '''
        }

        unstable {
            echo "⚠️ Build completed with warnings"
        }

        always {
            // Clean up Docker resources to free space
            sh '''
                echo "Cleaning up..."
                docker ps -aq | xargs -r docker stop || true
                docker ps -aq | xargs -r docker rm || true
            '''

            // Record build metrics
            script {
                def buildDuration = currentBuild.duration / 1000 / 60 // in minutes
                echo "Build took ${buildDuration} minutes"
            }
        }
    }
}