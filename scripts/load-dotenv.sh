#!/usr/bin/env bash
# Safely export selected vars from .env (handles values with spaces via dotenv).
# Usage: eval "$(./scripts/load-dotenv.sh /path/to/.env)"

ENV_FILE="${1:-}"
if [ -z "$ENV_FILE" ] || [ ! -f "$ENV_FILE" ]; then
  exit 0
fi

node - "$ENV_FILE" <<'NODE'
require('dotenv').config({ path: process.argv[2] });
const keys = [
  'STUDIO_URL', 'STUDIO_BASE_URL', 'STUDIO_USERNAME', 'STUDIO_PASSWORD', 'LOGIN_URL',
  'WM_USERNAME', 'WM_PASSWORD', 'WMO_USER', 'WMO_PASS', 'WM_PROJECT_ID', 'PROJECT_ID',
  'STUDIO_PROJECT_ID', 'PROJECT_MODE', 'CI_PROJECT_ENV_FILE',
  'NEW_PROJECT_STUDIO_URL', 'NEW_PROJECT_USERNAME', 'NEW_PROJECT_PASSWORD',
  'CLI_EXISTING_WEB_PREVIEW_XPATH', 'CLI_EXISTING_APP_VERIFICATION_ID',
  ...['CLI', 'SECURITY'].flatMap(suite =>
    ['USERNAME', 'PASSWORD', 'STUDIO_URL', 'PROJECT_ID', 'STUDIO_PROJECT_ID']
      .map(field => `${suite}_EXISTING_${field}`)),
  'SECURITY_USERNAME', 'SECURITY_PASSWORD', 'SECURITY_PROJECT_ID', 'SECURITY_STUDIO_URL',
  'SECURITY_STUDIO_PROJECT_ID', 'SECURITY_APP_NAME', 'SECURITY_APP_PACKAGE',
  'SECURITY_RN_PROJECT_FOLDER', 'SECURITY_RN_BUILD_PROFILE', 'RN_BUILD_PROFILE',
  'RN_SKIP_STUDIO_BUILD', 'RN_DOWNLOAD_FROM_STUDIO', 'RN_ZIP_DOWNLOAD_URL',
  'S3_REPORT_BUCKET', 'S3_REPORT_VERSION', 'S3_VERSION', 'S3_REPORT_PROJECT', 'S3_REPORT_FILENAME',
  'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_REGION', 'SNYK_TOKEN',
  'SECURITY_CLI_BINARY', 'SECURITY_CLI_BRANCH', 'SECURITY_CLI_REPO_URL', 'APP_PACKAGE', 'APP_NAME',
];
for (const key of keys) {
  const val = process.env[key];
  if (val !== undefined) {
    process.stdout.write(`export ${key}='${val.replace(/'/g, "'\\''")}'\n`);
  }
}
NODE
