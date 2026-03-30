pipeline {
    agent any

    parameters {
        string(
            name: 'CLI_BRANCH',
            defaultValue: 'main',
            description: 'Branch of wm-reactnative-cli repo to clone, link, and test'
        )
        choice(
            name: 'RUN_TARGET',
            choices: ['All Tests', 'AppChef Version', 'Sync & Web Preview', 'App Build', 'Maven Tests'],
            description: 'Which test suite to run'
        )
        choice(
            name: 'PKG_MANAGER',
            choices: ['npm', 'yarn', 'both'],
            description: 'Package manager mode for tests'
        )
    }

    tools {
        nodejs 'NodeJS 20.8.1'
    }

    environment {
        // Reuse existing Jenkins credentials (Global scope)
        WM_USERNAME        = credentials('WM_CLI_USERNAME')
        WM_PASSWORD        = credentials('WM_CLI_PASSWORD')
        WM_PROJECT_ID      = credentials('WM_CLI_PROJECT_ID')
        WMO_USER           = "${WM_USERNAME}"
        WMO_PASS           = "${WM_PASSWORD}"

        // Reuse existing AWS/S3 credentials
        AWS_ACCESS_KEY_ID     = credentials('AWS_ACCESS_KEY_ID')
        AWS_SECRET_ACCESS_KEY = credentials('AWS_SECRET_ACCESS_KEY')
        S3_REPORT_BUCKET      = credentials('S3_BUCKET_NAME')
        AWS_REGION            = 'us-west-2'

        STUDIO_URL      = credentials('WM_CLI_STUDIO_URL')

        RUN_LOCAL       = 'false'
        HEADLESS        = 'true'
        PACKAGE_MANAGER = "${params.PKG_MANAGER}"
    }

    stages {
        stage('Checkout') {
            steps {
                checkout scm
                sh 'node --version && npm --version'
            }
        }

        stage('Detect CLI Variant') {
            steps {
                script {
                    def studioUrl = env.STUDIO_URL ?: ''
                    if (studioUrl.contains('platform.wavemaker.ai')) {
                        env.CLI_PLATFORM = 'ai'
                        env.CLI_PKG_NAME = '@wavemaker-ai/wm-reactnative-cli'
                        env.CLI_BINARY = 'wm-reactnative-ai'
                        env.CLI_DEFAULT_BRANCH = 'wavemaker-ai'
                    } else {
                        env.CLI_PLATFORM = 'classic'
                        env.CLI_PKG_NAME = '@wavemaker/wm-reactnative-cli'
                        env.CLI_BINARY = 'wm-reactnative'
                        env.CLI_DEFAULT_BRANCH = 'main'
                    }

                    // Use variant default branch unless user explicitly changed CLI_BRANCH
                    env.EFFECTIVE_BRANCH = (params.CLI_BRANCH == 'main')
                        ? env.CLI_DEFAULT_BRANCH
                        : params.CLI_BRANCH
                }
                sh """
                    echo "--- CLI Variant Detected ---"
                    echo "  Platform:  ${env.CLI_PLATFORM}"
                    echo "  Package:   ${env.CLI_PKG_NAME}"
                    echo "  Binary:    ${env.CLI_BINARY}"
                    echo "  Branch:    ${env.EFFECTIVE_BRANCH}"
                    echo "  Studio:    ${env.STUDIO_URL}"
                """
            }
        }

        stage('Setup CLI') {
            steps {
                sh """
                    echo "--- Setting up CLI for branch: ${env.EFFECTIVE_BRANCH} ---"

                    CLI_REPO_URL="https://github.com/wavemaker/wm-reactnative-cli.git"
                    CLI_REPO_PATH="\${WORKSPACE}/wm-reactnative-cli"

                    if [ ! -d "\$CLI_REPO_PATH" ]; then
                        echo "Cloning CLI repo..."
                        git clone "\$CLI_REPO_URL" "\$CLI_REPO_PATH"
                    else
                        echo "Updating CLI repo..."
                        cd "\$CLI_REPO_PATH"
                        git reset --hard HEAD
                        git clean -fd
                        git fetch origin
                    fi

                    cd "\$CLI_REPO_PATH"
                    git checkout "${env.EFFECTIVE_BRANCH}"
                    git reset --hard "origin/${env.EFFECTIVE_BRANCH}"

                    echo "--- Installing CLI dependencies ---"
                    npm install

                    echo "--- Creating global npm link ---"
                    npm link --force

                    echo "--- Verifying CLI version ---"
                    EXPECTED=\$(node -e "console.log(require('./package.json').version)")
                    ACTUAL=\$(${env.CLI_BINARY} --version)
                    echo "Expected: \$EXPECTED | Active: \$ACTUAL"

                    if [ "\$ACTUAL" != "\$EXPECTED" ]; then
                        echo "ERROR: Version mismatch! Expected \$EXPECTED but got \$ACTUAL"
                        exit 1
                    fi
                    echo "--- CLI version verified: \$ACTUAL ---"
                """
            }
        }

        stage('Install Dependencies') {
            steps {
                sh """
                    echo "--- Linking CLI in automation project (${env.CLI_PKG_NAME}) ---"
                    npm link ${env.CLI_PKG_NAME}

                    echo "--- Installing automation dependencies ---"
                    npm install
                """
            }
        }

        stage('Run Tests') {
            steps {
                script {
                    def specFiles = ''
                    switch (params.RUN_TARGET) {
                        case 'All Tests':
                            specFiles = [
                                './test/specs/appchef-version.spec.ts',
                                './test/specs/preview-cli.spec.ts',
                                './test/specs/app-build.spec.ts',
                                './test/specs/maven-expo.spec.ts'
                            ].join(' ')
                            break
                        case 'AppChef Version':
                            specFiles = './test/specs/appchef-version.spec.ts'
                            break
                        case 'Sync & Web Preview':
                            specFiles = './test/specs/preview-cli.spec.ts'
                            break
                        case 'App Build':
                            specFiles = './test/specs/app-build.spec.ts'
                            break
                        case 'Maven Tests':
                            specFiles = './test/specs/maven-expo.spec.ts'
                            break
                    }

                    // browserstack() injects BROWSERSTACK_USERNAME and BROWSERSTACK_ACCESS_KEY
                    browserstack(credentialsId: 'BROWSERSTACK_CREDS') {
                        sh """
                            rm -rf allure-results allure-report

                            CLI_VERSION=\$(${env.CLI_BINARY} --version 2>/dev/null || echo 'unknown')
                            mkdir -p allure-results
                            echo "CLI_Version=\$CLI_VERSION" > allure-results/environment.properties
                            echo "CLI_Platform=${env.CLI_PLATFORM}" >> allure-results/environment.properties
                            echo "CLI_Binary=${env.CLI_BINARY}" >> allure-results/environment.properties
                            echo "Branch=${env.EFFECTIVE_BRANCH}" >> allure-results/environment.properties
                            echo "Package_Manager=${params.PKG_MANAGER}" >> allure-results/environment.properties
                            echo "Run_Target=${params.RUN_TARGET}" >> allure-results/environment.properties

                            set +e
                            PACKAGE_MANAGER="${params.PKG_MANAGER}" \
                            RUN_LOCAL="false" \
                            HEADLESS="true" \
                            npx mocha \
                                --reporter allure-mocha \
                                --require ts-node/register \
                                --timeout 999999 \
                                ${specFiles}
                            TEST_EXIT=\$?
                            set -e

                            exit \$TEST_EXIT
                        """
                    }
                }
            }
        }

        stage('Generate Report') {
            when { expression { return true } }
            steps {
                sh '''
                    if command -v allure >/dev/null 2>&1 && [ -d "allure-results" ]; then
                        echo "--- Generating Allure report ---"
                        allure generate allure-results --clean --single-file -o allure-report
                        echo "--- Report generated at allure-report/index.html ---"
                    else
                        echo "--- Skipping Allure report (allure CLI not found or no results) ---"
                    fi
                '''
            }
            post {
                always {
                    archiveArtifacts artifacts: 'allure-report/**', allowEmptyArchive: true
                    archiveArtifacts artifacts: 'allure-results/**', allowEmptyArchive: true
                }
            }
        }

        stage('Upload Report to S3') {
            when {
                expression { return env.S3_REPORT_BUCKET?.trim() }
            }
            steps {
                sh '''
                    if [ -f "allure-report/index.html" ]; then
                        CLI_VERSION=$(${env.CLI_BINARY} --version 2>/dev/null || echo 'unknown')
                        S3_VERSION="${S3_REPORT_VERSION:-$CLI_VERSION}"
                        S3_PATH="react_native/releases/${S3_VERSION}/Cli/"
                        S3_DEST="s3://${S3_REPORT_BUCKET}/${S3_PATH}cli.html"

                        echo "--- Uploading report to S3: ${S3_DEST} ---"
                        aws s3 cp allure-report/index.html "$S3_DEST" \
                            --region "$AWS_REGION" \
                            --acl public-read \
                            --content-type "text/html"

                        REPORT_URL="https://${S3_REPORT_BUCKET}.s3.${AWS_REGION}.amazonaws.com/${S3_PATH}cli.html"
                        echo "--- Report uploaded: ${REPORT_URL} ---"
                    else
                        echo "--- Skipping S3 upload (no report found) ---"
                    fi
                '''
            }
        }
    }

    post {
        success {
            echo "Pipeline completed successfully — ${env.CLI_PLATFORM} CLI, branch: ${env.EFFECTIVE_BRANCH}"
        }
        failure {
            echo "Pipeline failed — ${env.CLI_PLATFORM} CLI, branch: ${env.EFFECTIVE_BRANCH} — check archived reports."
        }
        always {
            echo "Run complete. Platform: ${env.CLI_PLATFORM}, Branch: ${env.EFFECTIVE_BRANCH}, Target: ${params.RUN_TARGET}, PM: ${params.PKG_MANAGER}"
        }
    }
}
