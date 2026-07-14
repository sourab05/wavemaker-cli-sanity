#!/usr/bin/env node
/**
 * Patch cloned security CLI runtime issues:
 * 1) update-notifier v6+ (ESM) under Node 23+
 * 2) Snyk scan npm install cwd resolution (avoid ENOENT on temp parent path)
 * 3) Snyk report capture from stdout+stderr (avoid empty report files on CI)
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
  console.log('--- Security CLI index.js not found; skipping security CLI runtime patches ---');
  process.exit(0);
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
    console.warn('--- Could not find update-notifier block to patch in index.js ---');
    return false;
  }

  source = source.replace(pattern, replacement);
  fs.writeFileSync(indexJsPath, source);
  console.log('--- Patched update-notifier in security CLI index.js ---');
  return true;
}

function patchSnykInstallAndReport(snykJsPath) {
  if (!fs.existsSync(snykJsPath)) {
    console.log('--- Security CLI src/snyk.js not found; skipping Snyk hardening patch ---');
    return false;
  }

  let source = fs.readFileSync(snykJsPath, 'utf8');
  let changed = false;

  if (!source.includes('Skipping npm install: package.json not found')) {
    const installBlockPattern =
      /  \/\/ Install Node modules[\s\S]*?console\.log\("Proceeding with Snyk test anyway\.\.\."\);\n  \}/m;
    const installBlockReplacement = [
      '  // Install Node modules',
      "  const installCwd = fs.existsSync(path.join(absolutePath, 'package.json'))",
      '    ? absolutePath',
      "    : (fs.existsSync(path.join(parentDir, 'package.json')) ? parentDir : null);",
      '  console.log("Installing node modules...");',
      '  try {',
      '    if (!installCwd) {',
      '      console.warn(`Skipping npm install: package.json not found in ${absolutePath} or ${parentDir}`);',
      '    } else {',
      "      execSync('npm install', { cwd: installCwd, stdio: 'inherit' });",
      "      execSync('npm update', { cwd: installCwd, stdio: 'inherit' });",
      '      console.log(`Node modules installed in ${installCwd}.`);',
      '    }',
      '  } catch (npmError) {',
      '    console.warn(`Failed to install npm packages: ${npmError.message}`);',
      '    console.log("Proceeding with Snyk test anyway...");',
      '  }',
    ].join('\n');

    if (installBlockPattern.test(source)) {
      source = source.replace(installBlockPattern, installBlockReplacement);
      changed = true;
      console.log('--- Patched Snyk npm install cwd hardening in src/snyk.js ---');
    } else {
      console.warn('--- Could not find Snyk npm install block to patch in src/snyk.js ---');
    }
  } else {
    console.log('--- Security CLI src/snyk.js already patched for npm install cwd hardening ---');
  }

  if (!source.includes('Snyk test failed and no report output was captured.')) {
    const reportBlockPattern =
      /  } catch \(error\) {\n\s*console\.error\("Vulnerabilities detected during Snyk test\."\);[\s\S]*?console\.log\(`Snyk report saved to \$\{reportPath\}`\);\n  }/m;
    const reportBlockReplacement = [
      '  } catch (error) {',
      '    console.error("Vulnerabilities detected during Snyk test.");',
      "    const reportPath = path.join(absolutePath, 'snyk-report.txt');",
      '    const reportContent = [',
      "      error?.stdout?.toString?.() || '',",
      "      error?.stderr?.toString?.() || '',",
      "    ].filter(Boolean).join('\\n').trim();",
      '    fs.writeFileSync(',
      '      reportPath,',
      "      reportContent || String(error?.message || 'Snyk test failed and no report output was captured.')",
      '    );',
      '    console.log(`Snyk report saved to ${reportPath}`);',
      '  }',
    ].join('\n');

    if (reportBlockPattern.test(source)) {
      source = source.replace(reportBlockPattern, reportBlockReplacement);
      changed = true;
      console.log('--- Patched Snyk report capture hardening in src/snyk.js ---');
    } else {
      console.warn('--- Could not find Snyk catch/report block to patch in src/snyk.js ---');
    }
  } else {
    console.log('--- Security CLI src/snyk.js already patched for report capture hardening ---');
  }

  if (changed) {
    fs.writeFileSync(snykJsPath, source);
  }

  return changed;
}

const notifierPatched = patchUpdateNotifier(indexPath);
const snykPath = path.join(path.dirname(indexPath), 'src', 'snyk.js');
const snykPatched = patchSnykInstallAndReport(snykPath);

if (!notifierPatched && !snykPatched) {
  console.log('--- Security CLI patches already present or no changes needed ---');
}