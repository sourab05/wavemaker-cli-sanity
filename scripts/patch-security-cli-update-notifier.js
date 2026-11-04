#!/usr/bin/env node
/**
 * Patch cloned security CLI runtime issues:
 * 1) update-notifier v6+ (ESM) under Node 23+
 * 2) Checked dependency installation and structured audit/Snyk results
 *
 * Usage: node scripts/patch-security-cli-update-notifier.js <path-to-index.js>
 */

const fs = require('fs');
const path = require('path');

const indexPath = process.argv[2];

if (!indexPath) {
  console.error('Usage: node patch-security-cli-update-notifier.js <path-to-index.js>');
  process.exit(1);
}

if (!fs.existsSync(indexPath)) {
  console.error('Security CLI index.js not found; cannot apply required patches');
  process.exit(1);
}

function patchUpdateNotifier(indexJsPath) {
  let source = fs.readFileSync(indexJsPath, 'utf8');

  if (source.includes('updateNotifierMod')) {
    console.log('--- Security CLI index.js already patched for update-notifier ---');
    return false;
  }

  const replacement = [
    "const pkg = require('./package.json');",
    "const { canDoAndroidBuild, canDoIosBuild, showConfirmation } = require('./src/requirements');",
    'try {',
    "    const updateNotifierMod = require('update-notifier');",
    "    const updateNotifier = typeof updateNotifierMod === 'function' ? updateNotifierMod : updateNotifierMod.default;",
    '    if (updateNotifier) {',
    '        updateNotifier({',
    '            pkg: pkg,',
    '            updateCheckInterval : 60 * 60 * 1000',
    '        }).notify({',
    '            defer: false',
    '        });',
    '    }',
    '} catch {',
    '    // update-notifier v6+ is ESM-only on some Node versions; skip version notify',
    '}',
  ].join('\n');

  const pattern =
    /const updateNotifier = require\('update-notifier'\)(?:\.default)?;\nconst pkg = require\('\.\/package\.json'\);\nconst \{ canDoAndroidBuild, canDoIosBuild, showConfirmation \} = require\('\.\/src\/requirements'\);\nupdateNotifier\(\{[\s\S]*?\}\)\.notify\(\{[\s\S]*?\}\);/;

  if (!pattern.test(source)) {
    throw new Error('Could not find required update-notifier block to patch in index.js');
  }

  source = source.replace(pattern, replacement);
  fs.writeFileSync(indexJsPath, source);
  console.log('--- Patched update-notifier in security CLI index.js ---');
  return true;
}

patchUpdateNotifier(indexPath);
const srcDir = path.join(path.dirname(indexPath), 'src');
for (const tool of ['audit', 'snyk']) {
  const entry = path.join(srcDir, `${tool}.js`);
  if (!fs.existsSync(entry)) throw new Error(`Missing required security entrypoint: ${entry}`);
  const source = fs.readFileSync(entry, 'utf8');
  if (!source.includes('extractRNZip') ||
      (!source.includes(`const ${tool} = async`) && !source.includes('wm-security-runtime'))) {
    throw new Error(`Unsupported security entrypoint: ${entry}`);
  }
}
for (const filename of ['security-scan-runtime.js', 'security-results.js']) {
  fs.copyFileSync(path.join(__dirname, filename), path.join(srcDir, filename));
}
for (const tool of ['audit', 'snyk']) {
  fs.writeFileSync(path.join(srcDir, `${tool}.js`), [
    '// wm-security-runtime: checked install and structured scan results.',
    "const { extractRNZip } = require('./command.js');",
    "const { runScan } = require('./security-scan-runtime.js');",
    `const ${tool} = async (args) => runScan('${tool}', args, extractRNZip);`,
    `module.exports = { ${tool}, extractRNZip };`,
    '',
  ].join('\n'));
}
console.log('--- Installed checked npm audit and Snyk runtime ---');
