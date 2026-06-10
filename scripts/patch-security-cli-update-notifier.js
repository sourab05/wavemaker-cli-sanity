#!/usr/bin/env node
/**
 * Patch cloned security CLI index.js for update-notifier v6+ (ESM) under Node 23+.
 * Usage: node scripts/patch-security-cli-update-notifier.js <path-to-index.js>
 */
const fs = require('fs');
const path = process.argv[2];

if (!path) {
  console.error('Usage: node patch-security-cli-update-notifier.js <path-to-index.js>');
  process.exit(1);
}

if (!fs.existsSync(path)) {
  console.log('--- Security CLI index.js not found; skipping update-notifier patch ---');
  process.exit(0);
}

let source = fs.readFileSync(path, 'utf8');

if (source.includes('updateNotifierMod')) {
  console.log('--- Security CLI index.js already patched for update-notifier ---');
  process.exit(0);
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
  console.warn('--- Could not find update-notifier block to patch in index.js ---');
  process.exit(0);
}

fs.writeFileSync(path, source.replace(pattern, replacement));
console.log('--- Patched update-notifier in security CLI index.js ---');
