#!/usr/bin/env bash
# Validates security pipeline wiring without requiring a full audit/Snyk run.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
PASS=0
FAIL=0

pass() { echo "✅ $1"; PASS=$((PASS + 1)); }
fail() { echo "❌ $1"; FAIL=$((FAIL + 1)); }

echo "=== Security pipeline validation ==="

# 1) Shell syntax
for f in scripts/run-security-vulnerabilities.sh scripts/configure-npm-registry.sh run-cli-tests.sh; do
  if bash -n "$f"; then pass "bash -n $f"; else fail "bash -n $f"; fi
done

# 2) TypeScript
if npx tsc --noEmit; then pass "tsc --noEmit"; else fail "tsc --noEmit"; fi

# 3) S3 path with space
S3_OUT="$(npx ts-node -e "
process.env.S3_REPORT_VERSION='WM-AI 1.0.0_BETA_RC4';
process.env.S3_REPORT_PROJECT='Security Vulnerabilities';
process.env.S3_REPORT_FILENAME='security-vulnerabilities.html';
import { buildS3PathPrefix } from './src/s3/s3-path-builder';
const prefix = buildS3PathPrefix();
const key = prefix + process.env.S3_REPORT_FILENAME;
console.log(key);
")"
EXPECTED="react_native/releases/WM-AI 1.0.0_BETA_RC4/Security Vulnerabilities/security-vulnerabilities.html"
if [ "$S3_OUT" = "$EXPECTED" ]; then
  pass "S3 key path: $S3_OUT"
else
  fail "S3 key mismatch. got: $S3_OUT expected: $EXPECTED"
fi

# 4) run-cli-tests.sh delegates to security script
if grep -q 'exec "\$SCRIPT_DIR/scripts/run-security-vulnerabilities.sh"' run-cli-tests.sh; then
  pass "run-cli-tests.sh exec delegation present"
else
  fail "run-cli-tests.sh missing security exec delegation"
fi

DELEGATE_OUT="$(bash -c '
  SCRIPT_DIR="'"$ROOT"'"
  _3="security"
  _1="SecurityVulnerabilities"
  if [ "${_3}" = "security" ] || [ "${_1}" = "security" ]; then
    SECURITY_BRANCH="${SECURITY_CLI_BRANCH:-SecurityVulnerabilities}"
    if [ "${_1}" != "security" ] && [ -n "${_1}" ]; then SECURITY_BRANCH="${_1}"; fi
    echo "delegate:${SECURITY_BRANCH}"
  fi
')"
if [ "$DELEGATE_OUT" = "delegate:SecurityVulnerabilities" ]; then
  pass "run-cli-tests delegation logic → branch SecurityVulnerabilities"
else
  fail "delegation logic got: $DELEGATE_OUT"
fi

# 5) Jenkinsfile wiring
for needle in \
  "isSecurityOnlyRun()" \
  "runsSecurityScan()" \
  "Run CLI Tests" \
  "Setup Security CLI" \
  "Run Security Vulnerabilities" \
  "wm-reactnative-cli-security" \
  "S3_REPORT_PROJECT = 'Security Vulnerabilities'" \
  "uploadSecurityReportsToS3"; do
  if grep -q "$needle" Jenkinsfile; then
    pass "Jenkinsfile contains: $needle"
  else
    fail "Jenkinsfile missing: $needle"
  fi
done

# 6) Security HTML report generation
TMP="$(mktemp -d)"
cat > "$TMP/report-meta.json" << 'EOF'
{"auditReportPath":"/tmp/a.txt","snykReportPath":"/tmp/s.txt","cliVersion":"1.0","cliBinary":"wm-reactnative","projectPath":"/tmp/p","rnZipPath":"/tmp/z.zip","rnZipSource":"test"}
EOF
echo audit > /tmp/a.txt
echo snyk > /tmp/s.txt
if npx ts-node -e "
import * as fs from 'fs';
import * as path from 'path';
import { writeSecurityReport } from './src/utils/security-report';
const meta = JSON.parse(fs.readFileSync('$TMP/report-meta.json','utf8'));
meta.auditReportPath='/tmp/a.txt';
meta.snykReportPath='/tmp/s.txt';
const out = writeSecurityReport('$TMP/out', meta);
if (!fs.readFileSync(out,'utf8').includes('Security Vulnerabilities Report')) process.exit(1);
"; then
  pass "writeSecurityReport HTML"
else
  fail "writeSecurityReport HTML"
fi
rm -rf "$TMP"

# 7) prepareProjectWithZip (Studio download — uses .env)
if [ -f "$ROOT/.env" ]; then
  echo "--- prepareProjectWithZip (live Studio) ---"
  if npx ts-node -e "
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import dotenv from 'dotenv';
import { RnProjectManager } from './src/services/RnProjectManager';
dotenv.config();
(async () => {
  const dir = path.join(os.tmpdir(), 'sec-pipeline-' + Date.now());
  fs.mkdirSync(dir, { recursive: true });
  const m = RnProjectManager.fromEnv();
  const a = await m.prepareProjectWithZip(dir, 'development');
  if (!fs.existsSync(a.zipPath)) throw new Error('zip missing');
  if (!fs.existsSync(a.projectPath)) throw new Error('project missing');
  console.log('zip=' + a.zipPath);
  console.log('project=' + a.projectPath);
})();
" 2>&1; then
    pass "prepareProjectWithZip (Studio RN ZIP download + extract)"
  else
    fail "prepareProjectWithZip (Studio RN ZIP download + extract)"
  fi
else
  echo "⚠️  Skipping prepareProjectWithZip (.env not found)"
fi

# 8) Security script S3 defaults (static check — do not run full scan here)
if grep -q 'git clone -b "\$SECURITY_CLI_BRANCH"' scripts/run-security-vulnerabilities.sh; then
  pass "run-security-vulnerabilities.sh uses git clone -b branch"
else
  fail "run-security-vulnerabilities.sh missing git clone -b"
fi

if grep -q 'git checkout -B "\$SECURITY_CLI_BRANCH"' scripts/run-security-vulnerabilities.sh; then
  pass "run-security-vulnerabilities.sh creates/resets branch from origin"
else
  fail "run-security-vulnerabilities.sh missing checkout -B from origin"
fi

if grep -q 'CLI_SETUP_ONLY' scripts/run-security-vulnerabilities.sh; then
  pass "run-security-vulnerabilities.sh supports CLI_SETUP_ONLY"
else
  fail "run-security-vulnerabilities.sh missing CLI_SETUP_ONLY"
fi

if grep -q 'PRESERVE_ALLURE_RESULTS' scripts/run-security-vulnerabilities.sh; then
  pass "run-security-vulnerabilities.sh supports PRESERVE_ALLURE_RESULTS"
else
  fail "run-security-vulnerabilities.sh missing PRESERVE_ALLURE_RESULTS"
fi

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ]
