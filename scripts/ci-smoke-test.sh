#!/usr/bin/env bash
# Quick CI smoke checks (no full Mocha suite). Run: ./scripts/ci-smoke-test.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "=== CI smoke test ==="

echo "--- TypeScript compile ---"
npx tsc --noEmit

if [ -f "$ROOT/scripts/source-ci-project-env.sh" ]; then
  # shellcheck disable=SC1091
  . "$ROOT/scripts/source-ci-project-env.sh"
fi

if [ "${PROJECT_MODE:-Existing Project}" = "New Project" ]; then
  echo "--- New Project mode: skipping RN ZIP download smoke (first build runs in app-build spec) ---"
  if [ -z "${WM_PROJECT_ID:-}" ] || [ -z "${STUDIO_PROJECT_ID:-}" ]; then
    echo "ERROR: .ci-project-env.sh missing WM_PROJECT_ID / STUDIO_PROJECT_ID — run provision-studio-project first"
    exit 1
  fi
  echo "Provisioned WM_PROJECT_ID prefix: $(echo "$WM_PROJECT_ID" | cut -c1-12)..."
  echo "Provisioned STUDIO_PROJECT_ID prefix: $(echo "$STUDIO_PROJECT_ID" | cut -c1-12)..."
else
  echo "--- RN ZIP download (jobs API + extract) ---"
  npx ts-node scripts/test-rn-zip-download.ts
fi

echo "--- App verification env ---"
npx ts-node -e "
import dotenv from 'dotenv';
import { getAppVerificationSelectors, getWebPreviewXPath } from './src/utils/app-verification';
dotenv.config();
const ids = getAppVerificationSelectors();
const xpath = getWebPreviewXPath();
if (!ids.length) throw new Error('No app verification selectors');
if (!xpath) throw new Error('No web preview xpath');
console.log('APP selectors:', ids.join(', '));
console.log('WEB xpath:', xpath);
"

echo "=== CI smoke test passed ==="
