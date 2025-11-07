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
                    git submodule update --init --recursive
                    make init
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