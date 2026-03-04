#!/usr/bin/env bash

# Exit immediately if a command exits with a non-zero status.
set -e

# --- Configuration ---
CLI_REPO_URL="https://github.com/wavemaker/wm-reactnative-cli.git"

# Check if the WORKSPACE environment variable is set (standard in Jenkins)
if [ -n "$WORKSPACE" ]; then
  echo "--- Jenkins environment detected. Using WORKSPACE: $WORKSPACE ---"
  CLI_REPO_PATH="$WORKSPACE/wm-reactnative-cli"
  AUTOMATION_REPO_PATH="$WORKSPACE"
else
  echo "--- Local environment detected. Using local paths. ---"
  CLI_REPO_PATH="/Users/jeevansi_700069/Documents/CLi/wm-reactnative-cli"
  AUTOMATION_REPO_PATH="/Users/jeevansi_700069/Documents/wavemaker-cli-sanity/"
fi

echo "CLI Repo Path set to: $CLI_REPO_PATH"
echo "Automation Repo Path set to: $AUTOMATION_REPO_PATH"

# --- Arguments ---
# $1 = branch name (required)
# $2 = package manager: npm | yarn | both (optional, default: npm)

if [ -z "$1" ]; then
  echo "Error: No branch name supplied."
  echo "Usage: ./run-cli-tests.sh <branch-name> [npm|yarn|both]"
  exit 1
fi

BRANCH_NAME=$1
PKG_MANAGER="${2:-npm}"

# Validate PACKAGE_MANAGER value
case "$PKG_MANAGER" in
  npm|yarn|both) ;;
  *)
    echo "Error: Invalid package manager '$PKG_MANAGER'. Must be: npm, yarn, or both"
    exit 1
    ;;
esac

echo "--- Setting up CLI for branch: $BRANCH_NAME ---"
echo "--- Package manager mode: $PKG_MANAGER ---"

# --- Clone or update the CLI repository ---
if [ ! -d "$CLI_REPO_PATH" ]; then
  echo "CLI repository not found. Cloning from $CLI_REPO_URL..."
  git clone "$CLI_REPO_URL" "$CLI_REPO_PATH"
  cd "$CLI_REPO_PATH"
else
  echo "CLI repository found. Updating..."
  cd "$CLI_REPO_PATH"
  echo "--- Discarding all local changes in CLI repo ---"
  git reset --hard HEAD
  git clean -fd
  git fetch origin
fi

# Checkout the specified branch
git checkout main
git reset --hard origin/main
git checkout "$BRANCH_NAME"
git reset --hard "origin/$BRANCH_NAME"

# --- Install & Link CLI (package-manager aware) ---
#
# npm link flow:
#   CLI repo:        npm install  →  npm link --force   (global symlink)
#   Automation repo: npm link @wavemaker/wm-reactnative-cli
#
# yarn link flow:
#   CLI repo:        yarn install →  yarn link          (register in yarn registry)
#   Automation repo: yarn link @wavemaker/wm-reactnative-cli

link_with_npm() {
  echo "--- [NPM] Installing CLI dependencies ---"
  npm install
  echo "--- [NPM] Creating global link ---"
  npm link --force
}

link_with_yarn() {
  echo "--- [YARN] Installing CLI dependencies ---"
  yarn install
  echo "--- [YARN] Registering yarn link ---"
  yarn link
}

cd "$CLI_REPO_PATH"

case "$PKG_MANAGER" in
  npm)
    link_with_npm
    ;;
  yarn)
    link_with_yarn
    ;;
  both)
    link_with_npm
    link_with_yarn
    ;;
esac

# Verify the linked CLI version
echo "--- Verifying linked CLI version ---"
ACTIVE_CLI_VERSION=$(wm-reactnative --version)
EXPECTED_CLI_VERSION=$(CLI_REPO_PATH="$CLI_REPO_PATH" node -e "const p=require('path'); console.log(require(p.join(process.env.CLI_REPO_PATH,'package.json')).version)")

echo "Expected version (from CLI repo package.json): $EXPECTED_CLI_VERSION"
echo "Active version (from 'wm-reactnative --version'): $ACTIVE_CLI_VERSION"

if [ "$ACTIVE_CLI_VERSION" != "$EXPECTED_CLI_VERSION" ]; then
  echo "Error: Version Mismatch!"
  echo "The linked CLI version ($ACTIVE_CLI_VERSION) does not match the expected version from the '$BRANCH_NAME' branch ($EXPECTED_CLI_VERSION)."
  echo "This could be an issue with the link step. Please check your environment."
  exit 1
fi

echo "--- Successfully linked and verified wm-reactnative-cli version: $ACTIVE_CLI_VERSION ---"

# --- Link CLI in the automation project ---
cd "$AUTOMATION_REPO_PATH"
echo "--- Linking automation project to the local CLI ---"

case "$PKG_MANAGER" in
  npm)
    npm link @wavemaker/wm-reactnative-cli
    echo "[NPM] linked @wavemaker/wm-reactnative-cli"
    ;;
  yarn)
    yarn link @wavemaker/wm-reactnative-cli
    echo "[YARN] linked @wavemaker/wm-reactnative-cli"
    ;;
  both)
    npm link @wavemaker/wm-reactnative-cli
    echo "[NPM] linked @wavemaker/wm-reactnative-cli"
    yarn link @wavemaker/wm-reactnative-cli
    echo "[YARN] linked @wavemaker/wm-reactnative-cli"
    ;;
esac

echo "--- Running automation tests (PACKAGE_MANAGER=$PKG_MANAGER) ---"

# Temporarily disable 'exit on error' to ensure reporting always runs
set +e

(PACKAGE_MANAGER="$PKG_MANAGER" npx mocha \
  --reporter allure-mocha \
  --require ts-node/register \
  ./test/specs/appchef-version.spec.ts \
  ./test/specs/preview-cli.spec.ts \
  ./test/specs/app-build.spec.ts \
  ./test/specs/maven-expo.spec.ts
) &

TEST_PID=$!
wait $TEST_PID
TEST_EXIT_CODE=$?

set -e

# --- Generate Allure report ---
echo "--- Generating Allure report ---"

mkdir -p allure-results
echo "CLI_Version=$ACTIVE_CLI_VERSION" > allure-results/environment.properties
echo "Branch=$BRANCH_NAME" >> allure-results/environment.properties
echo "Package_Manager=$PKG_MANAGER" >> allure-results/environment.properties

allure generate allure-results --clean -o allure-report

echo "--- Allure report generated in: $AUTOMATION_REPO_PATH/allure-report ---"

# --- Upload Allure report to S3 ---
if [ -f "$AUTOMATION_REPO_PATH/.env" ]; then
  export $(grep -v '^#' "$AUTOMATION_REPO_PATH/.env" | grep -E '^(S3_|AWS_)' | xargs)
fi

S3_BUCKET="${S3_REPORT_BUCKET:-}"
S3_REGION="${AWS_REGION:-us-west-2}"

if [ -n "$S3_BUCKET" ] && [ -d "allure-report" ]; then
  S3_VERSION="${S3_REPORT_VERSION:-$ACTIVE_CLI_VERSION}"
  S3_PATH="releases/${S3_VERSION}/Cli/"
  S3_DEST="s3://${S3_BUCKET}/${S3_PATH}"

  echo "--- Uploading Allure report to S3 ---"
  echo "S3 destination: ${S3_DEST}"

  aws s3 sync allure-report/ "$S3_DEST" \
    --region "$S3_REGION" \
    --acl public-read

  REPORT_URL="https://${S3_BUCKET}.s3.${S3_REGION}.amazonaws.com/${S3_PATH}index.html"
  echo "--- Report uploaded: ${REPORT_URL} ---"
else
  if [ -z "$S3_BUCKET" ]; then
    echo "--- Skipping S3 upload (S3_REPORT_BUCKET not set) ---"
  else
    echo "--- Skipping S3 upload (allure-report directory not found) ---"
  fi
fi

echo "--- Test run finished with exit code: $TEST_EXIT_CODE ---"

exit $TEST_EXIT_CODE
