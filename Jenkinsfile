def uploadReportsToS3(Map args = [:]) {
    def nonFatal = args.nonFatal == true
    if (!env.S3_REPORT_BUCKET?.trim()) {
        echo '--- Skipping S3 upload (S3_REPORT_BUCKET not set) ---'
        return
    }
    if (!params.S3_VERSION?.trim()) {
        echo '--- S3_VERSION is empty — skipping S3 report upload. Set the build parameter to upload under react_native/releases/<version>/Cli/... ---'
        return
    }
    def cmd = 'npx ts-node scripts/generate-and-upload-report.ts'
    if (nonFatal) {
        sh "${cmd} || echo \"S3 upload skipped or failed (non-fatal)\""
    } else {
        sh cmd
    }
}

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
            choices: ['All Tests', 'AppChef Version', 'Sync & Web Preview', 'App Build'],
            description: 'Which test suite to run'
        )
        choice(
            name: 'PKG_MANAGER',
            choices: ['npm', 'yarn', 'both'],
            description: 'Package manager mode for tests'
        )
        string(
            name: 'APP_PACKAGE',
            defaultValue: 'com.wavemaker.styleworkspaceautomation',
            description: 'Android app package / bundle id (must match Studio project)'
        )
        string(
            name: 'APP_NAME',
            defaultValue: 'StyleWorkSpaceAutomation',
            description: 'App name for wm_rn_config.json'
        )
        string(
            name: 'APP_VERIFICATION_ID',
            defaultValue: '~button_link_caption',
            description: 'Expo Go / native build accessibility id to verify app loaded'
        )
        string(
            name: 'WEB_PREVIEW_XPATH',
            defaultValue: "//div[@aria-label='page_title_label_caption']",
            description: 'Web preview XPath to verify page loaded'
        )
        string(
            name: 'S3_VERSION',
            defaultValue: 'WM-AI 1.0.0_BETA_RC4',
            description: 'S3 release folder under react_native/releases/<S3_VERSION>/ (e.g. WM-AI 1.0.0_BETA_RC4, 12.0.0)'
        )
        string(
            name: 'RN_ZIP_DOWNLOAD_URL',
            defaultValue: '',
            description: 'Optional last-resort ZIP (file-service URL or id). Leave empty to resolve nativeMobileZipId dynamically from Studio jobs API.'
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
        S3_VERSION            = "${params.S3_VERSION}"
        S3_REPORT_VERSION     = "${params.S3_VERSION}"
        S3_REPORT_PROJECT     = 'Cli'
        S3_REPORT_FILENAME    = 'stage-ai-cli.html'

        STUDIO_URL      = credentials('WM_CLI_STUDIO_URL')
        STUDIO_BASE_URL = credentials('WM_CLI_STUDIO_URL')
        PROJECT_ID      = credentials('WM_CLI_PROJECT_ID')
        STUDIO_PROJECT_ID = credentials('WM_CLI_STUDIO_PROJECT_ID')

        WM_NPM_REGISTRY = 'https://repository.wavemaker.com/repository/wavemaker-npm-repo/'

        RN_BUILD_PROFILE = 'development'
        RN_ZIP_DOWNLOAD_URL = "${params.RN_ZIP_DOWNLOAD_URL}"
        RN_BUILD_EMPTY_JOBS_POLL_LIMIT = '15'
        BROWSERSTACK_VERIFY_SOFT_FAIL = 'true'

        // 2x local defaults: BUILD 45→90 min, INSTALL 5→10 min
        BUILD_TIMEOUT   = '5400000'
        INSTALL_TIMEOUT = '600000'

        RUN_LOCAL       = 'false'
        HEADLESS        = 'true'
        SYNC_TIMEOUT    = '900000'
        PACKAGE_MANAGER = "${params.PKG_MANAGER}"
        APP_PACKAGE     = "${params.APP_PACKAGE}"
        APP_NAME        = "${params.APP_NAME}"
        APP_VERIFICATION_ID = "${params.APP_VERIFICATION_ID}"
        WEB_PREVIEW_XPATH   = "${params.WEB_PREVIEW_XPATH}"
    }

    stages {
        stage('Checkout') {
            steps {
                checkout scm
                sh 'node --version && npm --version'
            }
        }

        stage('Configure NPM Registry') {
            steps {
                sh '''
                    chmod +x scripts/configure-npm-registry.sh
                    ./scripts/configure-npm-registry.sh
                '''
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
                    echo "  Studio:    \$STUDIO_URL"
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

                    echo "--- Configuring npm registry for CLI repo ---"
                    "\${WORKSPACE}/scripts/configure-npm-registry.sh" "\$CLI_REPO_PATH"

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
                    echo "--- Configuring npm registry for automation project ---"
                    ./scripts/configure-npm-registry.sh "\${WORKSPACE}"

                    echo "--- Linking CLI in automation project (${env.CLI_PKG_NAME}) ---"
                    npm link ${env.CLI_PKG_NAME}

                    echo "--- Installing automation dependencies ---"
                    npm install
                """
            }
        }

        stage('Setup Android Build Tools') {
            when {
                expression { params.RUN_TARGET in ['App Build', 'All Tests'] }
            }
            steps {
                sh '''
                    chmod +x scripts/setup-android-ci.sh
                    bash scripts/setup-android-ci.sh
                '''
            }
        }

        stage('CI Smoke Test') {
            steps {
                sh '''
                    chmod +x scripts/ci-smoke-test.sh
                    ./scripts/ci-smoke-test.sh
                '''
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
                                './test/specs/app-build.spec.ts'
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
                    }

                    // Username with password cred maps to BROWSERSTACK_USERNAME / BROWSERSTACK_ACCESS_KEY
                    withCredentials([usernamePassword(
                        credentialsId: 'BROWSERSTACK_CREDS',
                        usernameVariable: 'BROWSERSTACK_USERNAME',
                        passwordVariable: 'BROWSERSTACK_ACCESS_KEY'
                    )]) {
                        sh """
                            if [ -f "${WORKSPACE}/.ci-env.sh" ]; then
                                echo "--- Loading Android CI env ---"
                                set -a
                                . "${WORKSPACE}/.ci-env.sh"
                                set +a
                                gradle --version
                                echo "ANDROID_HOME=\${ANDROID_HOME}"
                            fi

                            echo "--- RN ZIP env (masked) ---"
                            echo "STUDIO_URL=\${STUDIO_URL}"
                            echo "WM_PROJECT_ID prefix: \$(echo \"\$WM_PROJECT_ID\" | cut -c1-8)..."
                            echo "STUDIO_PROJECT_ID prefix: \$(echo \"\$STUDIO_PROJECT_ID\" | cut -c1-8)..."
                            if [ -n "\$RN_ZIP_DOWNLOAD_URL" ]; then echo "RN_ZIP_DOWNLOAD_URL set: yes"; else echo "RN_ZIP_DOWNLOAD_URL set: no"; fi
                            echo "RN_BUILD_EMPTY_JOBS_POLL_LIMIT=\${RN_BUILD_EMPTY_JOBS_POLL_LIMIT:-12}"
                            echo "APP_VERIFICATION_ID=\${APP_VERIFICATION_ID}"
                            echo "WEB_PREVIEW_XPATH=\${WEB_PREVIEW_XPATH}"

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
    }

    post {
        always {
            sh '''
                if [ -d "allure-results" ] && [ "$(ls -A allure-results 2>/dev/null)" ]; then
                    echo "--- Generating Allure report ---"
                    npx allure generate allure-results --clean --single-file -o allure-report \
                        || echo "allure generate skipped"
                else
                    echo "--- Skipping Allure report (no allure-results) ---"
                fi
            '''
            archiveArtifacts artifacts: 'allure-report/**', allowEmptyArchive: true
            archiveArtifacts artifacts: 'allure-results/**', allowEmptyArchive: true
            echo "Run complete. Platform: ${env.CLI_PLATFORM}, Branch: ${env.EFFECTIVE_BRANCH}, Target: ${params.RUN_TARGET}, PM: ${params.PKG_MANAGER}"
        }
        success {
            script {
                uploadReportsToS3()
            }
            echo "Pipeline completed successfully — ${env.CLI_PLATFORM} CLI, branch: ${env.EFFECTIVE_BRANCH}"
        }
        failure {
            script {
                uploadReportsToS3(nonFatal: true)
            }
            echo "Pipeline failed — ${env.CLI_PLATFORM} CLI, branch: ${env.EFFECTIVE_BRANCH} — check archived reports."
        }
        unstable {
            script {
                uploadReportsToS3(nonFatal: true)
            }
        }
    }
}
