#!/usr/bin/env bash
# Safely export selected vars from .env (handles values with spaces via dotenv).
# Usage: eval "$(./scripts/load-dotenv.sh /path/to/.env)"

ENV_FILE="${1:-}"
if [ -z "$ENV_FILE" ] || [ ! -f "$ENV_FILE" ]; then
  exit 0
fi

node -e "
require('dotenv').config({ path: process.argv[1] });
const keys = process.argv[2].split(',');
for (const key of keys) {
  const val = process.env[key];
  if (val !== undefined && val !== '') {
    process.stdout.write('export ' + key + '=' + JSON.stringify(val) + '\n');
  }
}
" "$ENV_FILE" "STUDIO_URL,STUDIO_BASE_URL,WM_USERNAME,WM_PASSWORD,WM_PROJECT_ID,PROJECT_ID,STUDIO_PROJECT_ID,RN_ZIP_DOWNLOAD_URL,RN_BUILD_PROFILE,RN_SKIP_STUDIO_BUILD,RN_DOWNLOAD_FROM_STUDIO,S3_REPORT_BUCKET,S3_REPORT_VERSION,S3_VERSION,S3_REPORT_PROJECT,S3_REPORT_FILENAME,AWS_ACCESS_KEY_ID,AWS_SECRET_ACCESS_KEY,AWS_REGION,SNYK_TOKEN,SECURITY_CLI_BINARY,SECURITY_CLI_BRANCH,SECURITY_CLI_REPO_URL,APP_PACKAGE,APP_NAME"
