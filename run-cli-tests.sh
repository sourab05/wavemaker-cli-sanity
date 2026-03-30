#!/usr/bin/env bash

# Exit immediately if a command exits with a non-zero status.
set -e

# --- CLI variant detection from STUDIO_URL ---
# classic: stage-studio.wavemakeronline.com, dev-studio, etc.
# ai:      stage-platform.wavemaker.ai, platform.wavemaker.ai
detect_cli_variant() {
  local url="${STUDIO_URL:-}"
  if echo "$url" | grep -qi "platform.wavemaker.ai"; then
    CLI_PLATFORM="ai"
    CLI_REPO_URL="https://github.com/wavemaker/wm-reactnative-cli.git"
    CLI_PKG_NAME="@wavemaker-ai/wm-reactnative-cli"
    CLI_BINARY="wm-reactnative-ai"
  else
    CLI_PLATFORM="classic"
    CLI_REPO_URL="https://github.com/wavemaker/wm-reactnative-cli.git"
    CLI_PKG_NAME="@wavemaker/wm-reactnative-cli"
    CLI_BINARY="wm-reactnative"
  fi
}

detect_cli_variant

echo "--- CLI Platform: $CLI_PLATFORM ---"
echo "--- CLI Package:  $CLI_PKG_NAME ---"
echo "--- CLI Binary:   $CLI_BINARY ---"

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
#   Automation repo: npm link $CLI_PKG_NAME
#
# yarn link flow:
#   CLI repo:        yarn install →  yarn link          (register in yarn registry)
#   Automation repo: yarn link $CLI_PKG_NAME

link_with_npm() {
  echo "--- [NPM] Installing CLI dependencies ---"
  rm -f yarn.lock
  npm install
  echo "--- [NPM] Creating global link ---"
  npm link --force
}

link_with_yarn() {
  echo "--- [YARN] Installing CLI dependencies ---"
  rm -f package-lock.json
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
ACTIVE_CLI_VERSION=$($CLI_BINARY --version)
EXPECTED_CLI_VERSION=$(CLI_REPO_PATH="$CLI_REPO_PATH" node -e "const p=require('path'); console.log(require(p.join(process.env.CLI_REPO_PATH,'package.json')).version)")

echo "Expected version (from CLI repo package.json): $EXPECTED_CLI_VERSION"
echo "Active version (from '$CLI_BINARY --version'): $ACTIVE_CLI_VERSION"

if [ "$ACTIVE_CLI_VERSION" != "$EXPECTED_CLI_VERSION" ]; then
  echo "Error: Version Mismatch!"
  echo "The linked CLI version ($ACTIVE_CLI_VERSION) does not match the expected version from the '$BRANCH_NAME' branch ($EXPECTED_CLI_VERSION)."
  echo "This could be an issue with the link step. Please check your environment."
  exit 1
fi

echo "--- Successfully linked and verified $CLI_BINARY version: $ACTIVE_CLI_VERSION ---"

# --- Link CLI in the automation project ---
cd "$AUTOMATION_REPO_PATH"
echo "--- Linking automation project to the local CLI ---"

case "$PKG_MANAGER" in
  npm)
    npm link "$CLI_PKG_NAME"
    echo "[NPM] linked $CLI_PKG_NAME"
    ;;
  yarn)
    yarn link "$CLI_PKG_NAME"
    echo "[YARN] linked $CLI_PKG_NAME"
    ;;
  both)
    npm link "$CLI_PKG_NAME"
    echo "[NPM] linked $CLI_PKG_NAME"
    yarn link "$CLI_PKG_NAME"
    echo "[YARN] linked $CLI_PKG_NAME"
    ;;
esac

# Verify the CLI resolves correctly from the automation project
echo "--- Verifying CLI version in automation project ---"
LINKED_VERSION=$(npx $CLI_BINARY --version 2>/dev/null)
echo "CLI version in automation project: $LINKED_VERSION"
echo "Expected version: $EXPECTED_CLI_VERSION"

if [ "$LINKED_VERSION" != "$EXPECTED_CLI_VERSION" ]; then
  echo "Warning: CLI version in automation project ($LINKED_VERSION) does not match expected ($EXPECTED_CLI_VERSION)."
  echo "The link may not have been consumed correctly."
fi

echo "--- Running automation tests (PACKAGE_MANAGER=$PKG_MANAGER) ---"

# Clean previous allure results so reports only contain current run
rm -rf allure-results allure-report

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
echo "CLI_Platform=$CLI_PLATFORM" >> allure-results/environment.properties
echo "CLI_Binary=$CLI_BINARY" >> allure-results/environment.properties
echo "Branch=$BRANCH_NAME" >> allure-results/environment.properties
echo "Package_Manager=$PKG_MANAGER" >> allure-results/environment.properties

allure generate allure-results --clean --single-file -o allure-report

echo "--- Single-file Allure report generated: $AUTOMATION_REPO_PATH/allure-report/index.html ---"

# --- Upload single HTML report to S3 as cli.html ---
if [ -f "$AUTOMATION_REPO_PATH/.env" ]; then
  export $(grep -v '^#' "$AUTOMATION_REPO_PATH/.env" | grep -E '^(S3_|AWS_)' | xargs)
fi

S3_BUCKET="${S3_REPORT_BUCKET:-}"
S3_REGION="${AWS_REGION:-us-west-2}"

if [ -n "$S3_BUCKET" ] && [ -f "allure-report/index.html" ]; then
  S3_VERSION="${S3_REPORT_VERSION:-$ACTIVE_CLI_VERSION}"
  S3_PATH="react_native/releases/${S3_VERSION}/Cli/"
  S3_DEST="s3://${S3_BUCKET}/${S3_PATH}cli.html"

  echo "--- Uploading report to S3 as cli.html ---"
  echo "S3 destination: ${S3_DEST}"

  aws s3 cp allure-report/index.html "$S3_DEST" \
    --region "$S3_REGION" \
    --acl public-read \
    --content-type "text/html"

  REPORT_URL="https://${S3_BUCKET}.s3.${S3_REGION}.amazonaws.com/${S3_PATH}cli.html"
  echo "--- Report uploaded: ${REPORT_URL} ---"
else
  if [ -z "$S3_BUCKET" ]; then
    echo "--- Skipping S3 upload (S3_REPORT_BUCKET not set) ---"
  else
    echo "--- Skipping S3 upload (allure-report/index.html not found) ---"
  fi
fi

echo "--- Test run finished with exit code: $TEST_EXIT_CODE ---"

exit $TEST_EXIT_CODE
