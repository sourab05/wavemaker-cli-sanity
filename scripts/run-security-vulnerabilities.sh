#!/usr/bin/env bash
# Security vulnerabilities scan: clone Karthik7bk SecurityVulnerabilities CLI fork (clean),
# run npm audit + Snyk against Studio RN ZIP, upload report to a separate S3 path.
#
# Usage:
#   ./scripts/run-security-vulnerabilities.sh [branch]
#
# Default clone:
#   git clone https://github.com/Karthik7bk/wm-reactnative-cli.git -b SecurityVulnerabilities
#
# S3 path (not Cli/):
#   s3://<bucket>/react_native/releases/<S3_VERSION>/Security Vulnerabilities/security-vulnerabilities.html
#
# Env:
#   SKIP_CLI_SETUP=true       Skip clone/link (Jenkins already ran Setup Security CLI)
#   CLI_SETUP_ONLY=true       Clone/link security fork only, then exit (Jenkins setup stage)
#   PRESERVE_ALLURE_RESULTS=true  Keep existing allure-results (All Tests after CLI suite)
#   SKIP_S3_UPLOAD=true       Skip upload (Jenkins post block handles it)
#   SNYK_TOKEN                Required for Snyk scan

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [ -f "$ROOT/.env" ]; then
  # shellcheck disable=SC1090
  eval "$(bash "$ROOT/scripts/load-dotenv.sh" "$ROOT/.env")"
fi

SECURITY_CLI_REPO_URL="${SECURITY_CLI_REPO_URL:-https://github.com/Karthik7bk/wm-reactnative-cli.git}"
SECURITY_CLI_BRANCH="${1:-${SECURITY_CLI_BRANCH:-SecurityVulnerabilities}}"
SECURITY_CLI_BINARY="${SECURITY_CLI_BINARY:-wm-reactnative}"
SECURITY_CLI_PKG="@wavemaker/wm-reactnative-cli"
SKIP_CLI_SETUP="${SKIP_CLI_SETUP:-false}"
SKIP_S3_UPLOAD="${SKIP_S3_UPLOAD:-false}"
CLI_SETUP_ONLY="${CLI_SETUP_ONLY:-false}"
PRESERVE_ALLURE_RESULTS="${PRESERVE_ALLURE_RESULTS:-false}"

# Security project + S3 from env (see src/config/security-project.ts)
export S3_REPORT_PROJECT="Security Vulnerabilities"
export S3_REPORT_FILENAME="security-vulnerabilities.html"
export SECURITY_CLI_REPO_URL="${SECURITY_CLI_REPO_URL:-https://github.com/Karthik7bk/wm-reactnative-cli.git}"
export SECURITY_CLI_BRANCH="${SECURITY_CLI_BRANCH:-SecurityVulnerabilities}"
export SECURITY_CLI_BINARY="${SECURITY_CLI_BINARY:-wm-reactnative}"

if [ -n "${WORKSPACE:-}" ]; then
  echo "--- Jenkins environment detected. Using WORKSPACE: $WORKSPACE ---"
  CLI_REPO_PATH="${CLI_REPO_PATH:-$WORKSPACE/wm-reactnative-cli-security}"
  AUTOMATION_REPO_PATH="${AUTOMATION_REPO_PATH:-$WORKSPACE}"
else
  echo "--- Local environment detected ---"
  CLI_REPO_PATH="${CLI_REPO_PATH:-$ROOT/wm-reactnative-cli-security}"
  AUTOMATION_REPO_PATH="${AUTOMATION_REPO_PATH:-$ROOT}"
fi

echo "CLI Repo Path set to: $CLI_REPO_PATH"
echo "Automation Repo Path set to: $AUTOMATION_REPO_PATH"

if [ -z "${SECURITY_USERNAME:-}" ] || [ -z "${SECURITY_PASSWORD:-}" ]; then
  echo "ERROR: SECURITY_USERNAME and SECURITY_PASSWORD are required."
  echo "  Security uses separate Studio credentials — not WM_USERNAME / WM_PASSWORD."
  echo "  Set them in .env or export before running this script."
  exit 1
fi

if [ -z "${SECURITY_PROJECT_ID:-}" ]; then
  echo "ERROR: SECURITY_PROJECT_ID is required (WMPRJ build trigger id)."
  echo "  Set in .env or Jenkins credential SECURITY_WM_PROJECT_ID."
  echo "  Security does not use WM_PROJECT_ID / WM_CLI_PROJECT_ID."
  exit 1
fi

if [ -z "${SECURITY_STUDIO_URL:-}" ]; then
  echo "ERROR: SECURITY_STUDIO_URL is required."
  echo "  Set in .env or Jenkins credential SECURITY_WM_STUDIO_URL."
  echo "  Security does not use STUDIO_URL / WM_CLI_STUDIO_URL."
  exit 1
fi

export PROJECT_ID="${SECURITY_PROJECT_ID}"
export APP_NAME="${SECURITY_APP_NAME:-StyleWorkSpaceAutomation}"
export APP_PACKAGE="${SECURITY_APP_PACKAGE:-com.wavemaker.styleworkspaceautomation}"
export RN_BUILD_PROFILE="${SECURITY_RN_BUILD_PROFILE:-development}"
export RN_PROJECT_FOLDER="${SECURITY_RN_PROJECT_FOLDER:-StyleWorkSpaceAutomation-native-mobile_0.0.1}"

echo "============================================================"
echo "  Security Vulnerabilities Scan"
echo "============================================================"
echo "  CLI repo:    $SECURITY_CLI_REPO_URL"
echo "  CLI branch:  $SECURITY_CLI_BRANCH"
echo "  CLI binary:  $SECURITY_CLI_BINARY"
echo "  S3 project:  $S3_REPORT_PROJECT"
echo "  S3 file:     $S3_REPORT_FILENAME"
echo "  Project ID:  ${SECURITY_PROJECT_ID}"
echo "  Studio user: ${SECURITY_USERNAME}"
echo "  Studio URL:  ${SECURITY_STUDIO_URL}"
echo "  Jobs API id: ${SECURITY_STUDIO_PROJECT_ID:-not set}"
echo "============================================================"

chmod +x "$ROOT/scripts/configure-npm-registry.sh"
"$ROOT/scripts/configure-npm-registry.sh" "$AUTOMATION_REPO_PATH"

setup_security_cli() {
  echo "--- Setting up security CLI for branch: $SECURITY_CLI_BRANCH ---"

  clone_security_cli() {
    echo "Cloning from $SECURITY_CLI_REPO_URL (branch: $SECURITY_CLI_BRANCH)..."
    rm -rf "$CLI_REPO_PATH"
    git clone -b "$SECURITY_CLI_BRANCH" "$SECURITY_CLI_REPO_URL" "$CLI_REPO_PATH"
  }

  if [ ! -d "$CLI_REPO_PATH/.git" ]; then
    clone_security_cli
  else
    cd "$CLI_REPO_PATH"
    CURRENT_URL="$(git remote get-url origin 2>/dev/null || true)"
    if [ "$CURRENT_URL" != "$SECURITY_CLI_REPO_URL" ]; then
      echo "CLI origin changed ($CURRENT_URL -> $SECURITY_CLI_REPO_URL). Re-cloning..."
      cd "$ROOT"
      clone_security_cli
    else
      echo "CLI repository found. Updating..."
      echo "--- Discarding all local changes in CLI repo ---"
      git remote set-url origin "$SECURITY_CLI_REPO_URL"
      git reset --hard HEAD
      git clean -fd
      git fetch origin
      git checkout -B "$SECURITY_CLI_BRANCH" "origin/$SECURITY_CLI_BRANCH"
    fi
  fi

  cd "$CLI_REPO_PATH"
  git reset --hard "origin/$SECURITY_CLI_BRANCH"

  echo "--- [NPM] Configuring registry for CLI repo ---"
  "$AUTOMATION_REPO_PATH/scripts/configure-npm-registry.sh" "$CLI_REPO_PATH"

  echo "--- [NPM] Installing CLI dependencies ---"
  rm -f yarn.lock
  npm install

  echo "--- [NPM] Creating global link ---"
  npm link --force

  cd "$AUTOMATION_REPO_PATH"
  echo "--- Configuring npm registry for automation project ---"
  "$AUTOMATION_REPO_PATH/scripts/configure-npm-registry.sh" "$AUTOMATION_REPO_PATH"

  echo "--- Linking automation project to the local CLI (path: $CLI_REPO_PATH) ---"
  npm link "$CLI_REPO_PATH" --save=false
  echo "[NPM] linked $SECURITY_CLI_PKG → $CLI_REPO_PATH"

  echo "--- Verifying linked CLI version ---"
  EXPECTED_CLI_VERSION="$(node -e "console.log(require('$CLI_REPO_PATH/package.json').version)")"
  ACTIVE_CLI_VERSION="$("$SECURITY_CLI_BINARY" --version 2>/dev/null | tail -1 || true)"
  if [ -z "$ACTIVE_CLI_VERSION" ]; then
    ACTIVE_CLI_VERSION="$(node -e "console.log(require('$CLI_REPO_PATH/package.json').version)")"
  fi

  echo "Expected version (from CLI repo package.json): $EXPECTED_CLI_VERSION"
  echo "Active version (from '$SECURITY_CLI_BINARY --version'): $ACTIVE_CLI_VERSION"

  if [ "$ACTIVE_CLI_VERSION" != "$EXPECTED_CLI_VERSION" ]; then
    echo "Error: Version Mismatch!"
    echo "The linked CLI version ($ACTIVE_CLI_VERSION) does not match the expected version from the '$SECURITY_CLI_BRANCH' branch ($EXPECTED_CLI_VERSION)."
    exit 1
  fi

  echo "--- Successfully linked and verified $SECURITY_CLI_BINARY version: $ACTIVE_CLI_VERSION ---"
  export SECURITY_CLI_REPO_PATH="$CLI_REPO_PATH"
}

if [ "$SKIP_CLI_SETUP" != "true" ]; then
  setup_security_cli
else
  echo "--- Skipping CLI setup (SKIP_CLI_SETUP=true) ---"
  export SECURITY_CLI_REPO_PATH="${SECURITY_CLI_REPO_PATH:-$CLI_REPO_PATH}"
  cd "$AUTOMATION_REPO_PATH"
fi

if [ "$CLI_SETUP_ONLY" = "true" ]; then
  echo "--- CLI setup complete (CLI_SETUP_ONLY=true) ---"
  exit 0
fi

ensure_snyk_cli() {
  export PATH="$AUTOMATION_REPO_PATH/node_modules/.bin:${PATH:-}"

  if command -v snyk >/dev/null 2>&1; then
    echo "--- Snyk CLI found: $(snyk --version 2>/dev/null | head -1) ---"
    return 0
  fi

  echo "--- Snyk CLI not found — installing snyk via npm (local) ---"
  cd "$AUTOMATION_REPO_PATH"
  npm install --no-save snyk
  export PATH="$AUTOMATION_REPO_PATH/node_modules/.bin:${PATH:-}"

  if ! command -v snyk >/dev/null 2>&1; then
    echo "--- Local install failed — trying global snyk install ---"
    npm install -g snyk
    export PATH="$(npm root -g 2>/dev/null)/../bin:${PATH:-}"
  fi

  if ! command -v snyk >/dev/null 2>&1; then
    echo "ERROR: Snyk CLI unavailable after install. Ensure npm bin is on PATH."
    exit 1
  fi
  echo "--- Snyk CLI ready: $(snyk --version 2>/dev/null | head -1) ---"
}

if [ -n "${SNYK_TOKEN:-}" ]; then
  export SNYK_API_TOKEN="$SNYK_TOKEN"
  ensure_snyk_cli
  # Pre-authenticate so the security CLI auth check succeeds
  snyk config set api="$SNYK_TOKEN" >/dev/null 2>&1 || true
else
  echo "--- SNYK_TOKEN not set — Snyk scan will be skipped in spec ---"
fi

echo "--- Running security vulnerabilities spec ---"
echo "--- RN ZIP will be downloaded from Studio via RnProjectManager (same as app-build) ---"
export RN_DOWNLOAD_FROM_STUDIO="${RN_DOWNLOAD_FROM_STUDIO:-true}"

if [ "$PRESERVE_ALLURE_RESULTS" = "true" ]; then
  rm -rf security-report security-reports
  mkdir -p allure-results
else
  rm -rf allure-results allure-report security-report security-reports
  mkdir -p allure-results
fi

CLI_VERSION="$(node -e "console.log(require('${SECURITY_CLI_REPO_PATH:-$CLI_REPO_PATH}/package.json').version)" 2>/dev/null || echo 'unknown')"
if [ "$PRESERVE_ALLURE_RESULTS" = "true" ]; then
  {
    echo "Security_CLI_Version=$CLI_VERSION"
    echo "Security_CLI_Binary=$SECURITY_CLI_BINARY"
    echo "Security_Branch=$SECURITY_CLI_BRANCH"
    echo "Security_Run_Target=Security Vulnerabilities"
    echo "Security_S3_Project=$S3_REPORT_PROJECT"
  } >> allure-results/environment.properties
else
  echo "CLI_Version=$CLI_VERSION" > allure-results/environment.properties
  echo "CLI_Binary=$SECURITY_CLI_BINARY" >> allure-results/environment.properties
  echo "Branch=$SECURITY_CLI_BRANCH" >> allure-results/environment.properties
  echo "Run_Target=Security Vulnerabilities" >> allure-results/environment.properties
  echo "S3_Project=$S3_REPORT_PROJECT" >> allure-results/environment.properties
fi

set +e
RUN_LOCAL="${RUN_LOCAL:-false}" \
HEADLESS="${HEADLESS:-true}" \
SECURITY_CLI_BINARY="$SECURITY_CLI_BINARY" \
SECURITY_CLI_REPO_PATH="${SECURITY_CLI_REPO_PATH:-$CLI_REPO_PATH}" \
SNYK_API_TOKEN="${SNYK_API_TOKEN:-${SNYK_TOKEN:-}}" \
PATH="${AUTOMATION_REPO_PATH}/node_modules/.bin:${PATH:-}" \
npx mocha \
  --reporter allure-mocha \
  --require ts-node/register \
  --timeout 999999 \
  ./test/specs/security-vulnerabilities.spec.ts
MOCHA_EXIT=$?
set -e
TEST_EXIT="${MOCHA_EXIT:-1}"

echo "--- Generating Allure report (optional) ---"
if [ -d allure-results ] && [ "$(ls -A allure-results 2>/dev/null)" ]; then
  npx allure generate allure-results --clean --single-file -o allure-report \
    || echo "allure generate skipped"
fi

upload_security_report() {
  if [ "$SKIP_S3_UPLOAD" = "true" ]; then
    echo "--- Skipping S3 upload (SKIP_S3_UPLOAD=true) ---"
    return 0
  fi

  if [ -z "${S3_REPORT_BUCKET:-}" ]; then
    echo "--- Skipping S3 upload (S3_REPORT_BUCKET not set) ---"
    return 0
  fi

  if [ ! -f "security-reports/report-meta.json" ] && [ ! -f "security-reports/index.html" ]; then
    echo "--- Skipping S3 upload (no security report generated) ---"
    return 0
  fi

  echo "--- Uploading security report to S3 ($S3_REPORT_PROJECT/) ---"
  S3_REPORT_PROJECT="$S3_REPORT_PROJECT" \
  S3_REPORT_FILENAME="$S3_REPORT_FILENAME" \
  npx ts-node scripts/generate-and-upload-security-report.ts \
    || echo "Security S3 upload failed (non-fatal)"
}

upload_security_report

echo "--- Security scan finished with exit code: $TEST_EXIT ---"
exit "$TEST_EXIT"
