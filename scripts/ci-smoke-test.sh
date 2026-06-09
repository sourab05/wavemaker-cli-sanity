#!/usr/bin/env bash
# Quick CI smoke checks (no full Mocha suite). Run: ./scripts/ci-smoke-test.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "=== CI smoke test ==="

echo "--- TypeScript compile ---"
npx tsc --noEmit

echo "--- RN ZIP download (jobs API + extract) ---"
npx ts-node scripts/test-rn-zip-download.ts

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
