'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { normalizeResult } = require('./security-results');

const registry = 'https://repository.wavemaker.com/repository/wavemaker-npm-repo/';
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function findProjectRoot(extracted) {
  const base = path.resolve(extracted);
  const roots = [base, path.dirname(base)];
  for (const root of roots) {
    if (fs.existsSync(path.join(root, 'package.json'))) return root;
  }
  const candidates = [];
  function visit(dir, depth) {
    if (fs.existsSync(path.join(dir, 'package.json'))) { candidates.push(dir); return; }
    if (depth === 0) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.isSymbolicLink() &&
          !['node_modules', '.git', '__MACOSX'].includes(entry.name)) {
        visit(path.join(dir, entry.name), depth - 1);
      }
    }
  }
  visit(base, 4);
  if (candidates.length !== 1) throw new Error(`Expected one package.json root, found ${candidates.length}`);
  return candidates[0];
}

async function runScan(tool, args, extractRNZip, run = spawnSync) {
  let reportPath;
  const startedAt = new Date().toISOString();
  try {
    const zipHash = hash(path.resolve(args.src));
    const root = findProjectRoot(await extractRNZip(args.src));
    reportPath = path.join(root, `${tool === 'audit' ? 'audit' : 'snyk'}-report.txt`);
    const wmRegistry = process.env.WM_NPM_REGISTRY || registry;
    const env = { ...process.env, npm_config_registry: wmRegistry, NPM_CONFIG_REGISTRY: wmRegistry };
    const redact = text => {
      let value = String(text || '');
      for (const secret of [env.SNYK_TOKEN, env.SNYK_API_TOKEN]) {
        if (secret) value = value.split(secret).join('[REDACTED]');
      }
      return value;
    };
    // Override extracted public/scope settings without changing the user's npm config.
    fs.appendFileSync(path.join(root, '.npmrc'), `\nregistry=${wmRegistry}\n@wm:registry=${wmRegistry}\n@wavemaker:registry=${wmRegistry}\n@wavemaker-ai:registry=${wmRegistry}\n`);
    const execute = (command, argv) => run(command, argv, {
      cwd: root, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
      timeout: Number(process.env.SECURITY_SCAN_TIMEOUT || 45 * 60 * 1000),
    });
    // Both scanners reuse the first resolved lock for this ZIP within this suite run.
    const cache = process.env.SECURITY_LOCK_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'wm-security-lock-'));
    fs.mkdirSync(cache, { recursive: true });
    const savedLock = path.join(cache, `${zipHash}.json`);
    const lock = path.join(root, 'package-lock.json');
    if (fs.existsSync(savedLock)) fs.copyFileSync(savedLock, lock);
    const hasLock = fs.existsSync(lock) || fs.existsSync(path.join(root, 'npm-shrinkwrap.json'));
    const install = execute('npm', [hasLock ? 'ci' : 'install', '--no-audit', '--no-fund']);
    if (install.error || install.status !== 0) {
      fs.writeFileSync(path.join(root, 'dependency-install.log'),
        redact(`${install.stdout || ''}\n${install.stderr || ''}`));
      throw new Error(`Dependency installation failed (exit ${install.status}); scanner was not run`);
    }
    if (fs.existsSync(lock) && !fs.existsSync(savedLock)) fs.copyFileSync(lock, savedLock);
    if (fs.existsSync(savedLock) && hash(lock) !== hash(savedLock)) {
      throw new Error('Dependency lock changed between scanners');
    }
    const lockPath = fs.existsSync(path.join(root, 'npm-shrinkwrap.json'))
      ? path.join(root, 'npm-shrinkwrap.json') : lock;
    if (!fs.existsSync(lockPath)) throw new Error('Installation did not produce a dependency lock');
    const command = tool === 'audit' ? 'npm' : 'snyk';
    const version = execute(command, ['--version']);
    if (version.error || version.status !== 0) throw new Error(`${command} is unavailable`);
    if (tool === 'snyk' && !env.SNYK_TOKEN) throw new Error('SNYK_TOKEN is required');
    // The WaveMaker Nexus registry serves private packages but has no advisory API.
    // Override only audit; installation and private scope resolution stay on WaveMaker.
    const scan = execute(command, tool === 'audit'
      ? ['audit', '--json', '--registry=https://registry.npmjs.org/']
      : ['test', '--json']);
    const normalized = normalizeResult(tool, scan.stdout || '', scan.status);
    const envelope = {
      format: 'wm-security-v1', tool, status: normalized.status, exitCode: scan.status,
      startedAt, finishedAt: new Date().toISOString(), zipHash, lockHash: hash(lockPath),
      scannerVersion: String(version.stdout).trim(), generatedLock: !hasLock,
      result: (() => { try { return JSON.parse(scan.stdout); } catch { return null; } })(),
      // Raw scanner output is retained; never include environment/auth values.
      stdout: redact(scan.stdout), stderr: redact(scan.stderr),
      reason: scan.error?.message || normalized.reason,
    };
    fs.writeFileSync(reportPath, redact(JSON.stringify(envelope, null, 2)));
    console.log(`${tool === 'audit' ? 'Audit' : 'Snyk'} report saved to ${reportPath}`);
    process.exitCode = normalized.status === 'failed' ? 2 : normalized.status === 'findings' ? 1 : 0;
  } catch (error) {
    process.exitCode = 2;
    console.error(`${tool} scan FAILED: ${error.message}`);
    if (reportPath) {
      fs.writeFileSync(reportPath, JSON.stringify({
        format: 'wm-security-v1', tool, status: 'failed', startedAt,
        finishedAt: new Date().toISOString(), reason: error.message,
      }, null, 2));
      console.log(`${tool === 'audit' ? 'Audit' : 'Snyk'} report saved to ${reportPath}`);
    }
  }
}

module.exports = { runScan, findProjectRoot };
