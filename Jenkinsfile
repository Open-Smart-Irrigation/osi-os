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
            description: 'Target platform'
        )
        booleanParam(
            name: 'CLEAN_BUILD',
            defaultValue: false,
            description: 'Clean before build'
        )
    }

    options {
        buildDiscarder(logRotator(numToKeepStr: '5'))
        timestamps()
        timeout(time: 4, unit: 'HOURS')
    }

    stages {
        stage('Check Space') {
            steps {
                sh 'df -h'
            }
        }

        stage('Clean') {
            when {
                expression { params.CLEAN_BUILD }
            }
            steps {
                sh 'make clean || true'
            }
        }

        stage('Init') {
            when {
                expression { !fileExists('.initialized') }
            }
            steps {
                sh '''
                    # Initialize git submodules
                    git submodule update --init --recursive

                    # Remove existing symlinks if they exist
                    rm -f openwrt/.config
                    rm -f openwrt/files

                    # Copy feeds config
                    cp feeds.conf.default openwrt/feeds.conf.default

                    # Create symlinks
                    ln -s ../conf/.config openwrt/.config
                    ln -s ../conf/files openwrt/files

                    # Now run docker commands
                    docker compose run --rm chirpstack-gateway-os openwrt/scripts/feeds update -a
                    docker compose run --rm chirpstack-gateway-os openwrt/scripts/feeds install -a
                    docker compose run --rm chirpstack-gateway-os quilt init

                    touch .initialized
                '''
            }
        }

        stage('Update & Switch') {
            steps {
                sh '''
                    make update
                    make switch-env ENV=${TARGET_ENV}
                '''
            }
        }

        stage('Build') {
            steps {
                sh 'make'
            }
        }

        stage('Archive') {
            steps {
                archiveArtifacts artifacts: 'openwrt/bin/targets/**/*.img.gz',
                               allowEmptyArchive: true
            }
        }
    }

    post {
        always {
            sh 'df -h'
        }
    }
}