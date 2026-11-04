import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import { ChildProcess, execFileSync } from 'child_process';
import { runCommand, CommandError } from '../../src/utils/run-command';
import { killProcess } from '../../src/utils/process-utils';
import { waitForPreviewHttp } from '../../src/utils/web-preview';
import { buildSecurityReportHtml, parseAuditSummary, parseSnykSummary } from '../../src/utils/security-report';
import { writeProjectNpmrc, DEFAULT_WM_NPM_REGISTRY } from '../../src/utils/npm-registry';
const { normalizeResult } = require('../../scripts/security-results');
const { runScan, findProjectRoot } = require('../../scripts/security-scan-runtime');

const cleanAudit = {
  auditReportVersion: 2, vulnerabilities: {},
  metadata: { vulnerabilities: { critical: 0, high: 0, moderate: 0, low: 0, total: 0 } },
};
const findingAudit = {
  auditReportVersion: 2,
  vulnerabilities: { example: {
    severity: 'high', range: '<2', fixAvailable: true,
    via: [{ title: 'Example advisory', severity: 'high', url: 'https://example.com/advisory' }],
  } },
  metadata: { vulnerabilities: { critical: 0, high: 1, moderate: 0, low: 0, total: 1 } },
};
const cleanSnyk = { ok: true, dependencyCount: 10, vulnerabilities: [] };
const envelope = (tool: string, result: object, exitCode = 0) =>
  JSON.stringify({ format: 'wm-security-v1', tool, result, exitCode, status: exitCode ? 'findings' : 'clean' });

describe('CLI and security reliability (offline)', () => {
  let tmp: string;
  let originalEnv: NodeJS.ProcessEnv;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-reliability-test-'));
    originalEnv = { ...process.env };
  });
  afterEach(() => {
    process.exitCode = 0;
    for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
    Object.assign(process.env, originalEnv);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('routes @wm and default installs through WaveMaker even with a public NPM_REGISTRY override', () => {
    process.env.NPM_REGISTRY = 'https://registry.npmjs.org/';
    delete process.env.WM_NPM_REGISTRY;
    writeProjectNpmrc(tmp);
    const config = fs.readFileSync(path.join(tmp, '.npmrc'), 'utf8');
    assert(config.includes(`registry=${DEFAULT_WM_NPM_REGISTRY}`));
    assert(config.includes(`@wm:registry=${DEFAULT_WM_NPM_REGISTRY}`));
    assert(!config.includes('registry.npmjs.org'));
  });

  it('passes WaveMaker registry to child commands', async () => {
    delete process.env.WM_NPM_REGISTRY;
    const result = await runCommand(`"${process.execPath}" -p "process.env.npm_config_registry"`, { timeout: 3000 });
    assert(typeof result === 'object' && result.stdout.includes(DEFAULT_WM_NPM_REGISTRY));
  });

  it('preserves nonzero exit codes and captured output', async () => {
    await assert.rejects(runCommand(`"${process.execPath}" -e "console.log('finding');process.exit(1)"`, { timeout: 3000 }),
      (err: any) => err instanceof CommandError && err.exitCode === 1 && err.stdout.includes('finding'));
  });

  it('rejects a persistent server that exits before readiness', async () => {
    await assert.rejects(runCommand(`"${process.execPath}" -e "process.exit(0)"`, {
      timeout: 3000, keepAlive: true, successMessage: 'ready',
    }), /exited before readiness/);
  });

  it('fails promptly on installation errors instead of waiting for a browser timeout', async () => {
    await assert.rejects(runCommand(`"${process.execPath}" -e "console.log('npm error code E404');setInterval(()=>{},1000)"`, {
      timeout: 3000, keepAlive: true, successMessage: 'ready', failureRegex: /npm error code E404/,
    }), /operational failure/);
  });

  it('keeps a ready server alive until explicitly stopped', async () => {
    let child: ChildProcess | undefined;
    try {
      await runCommand(`"${process.execPath}" -e "console.log('ready');setInterval(()=>{},1000)"`, {
        timeout: 3000, keepAlive: true, successMessage: 'ready',
        onData: (_, process) => { child = process; },
      });
      assert(child?.pid);
      process.kill(child.pid, 0);
    } finally { if (child) killProcess(child); }
  });

  it('waits through HTTP errors rather than accepting the transpilation log as readiness', async () => {
    let requests = 0;
    const server = http.createServer((_, response) => {
      requests++;
      response.writeHead(requests === 1 ? 503 : 200);
      response.end(requests === 1 ? 'starting' : '<html><body>ready</body></html>');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const port = (server.address() as import('net').AddressInfo).port;
      await waitForPreviewHttp(`http://127.0.0.1:${port}`, { exitCode: null, signalCode: null } as ChildProcess, 3000);
      assert(requests >= 2);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });

  it('validates clean and findings JSON with matching scanner exits', () => {
    assert.equal(normalizeResult('audit', cleanAudit, 0).status, 'clean');
    assert.equal(normalizeResult('audit', findingAudit, 1).status, 'findings');
    assert.equal(normalizeResult('snyk', cleanSnyk, 0).status, 'clean');
    assert.equal(normalizeResult('audit', findingAudit, 0).status, 'failed');
    assert.equal(normalizeResult('audit', cleanAudit, 1).status, 'failed');
    assert.equal(normalizeResult('snyk', cleanSnyk, 2).status, 'failed');
  });

  for (const raw of ['', 'Authentication failed', '{"error":"endpoint unavailable"}', '{', '{}']) {
    it(`rejects unknown/error scanner output: ${JSON.stringify(raw)}`, () => {
      for (const tool of ['audit', 'snyk']) assert.equal(normalizeResult(tool, raw, 1).status, 'failed');
    });
  }

  it('does not parse operational errors as zero findings', () => {
    assert(Number.isNaN(parseAuditSummary('npm ERR! audit endpoint unavailable').total));
    assert(Number.isNaN(parseSnykSummary('Authentication failed').total));
    assert.equal(parseSnykSummary('No vulnerabilities found.').status, 'clean');
  });

  it('validates Snyk findings, deduplicates paths and rejects authentication JSON', () => {
    const issue = { id: 'SNYK-EXAMPLE-1', packageName: 'example', version: '1.0.0',
      title: 'Example vulnerability', severity: 'medium', fixedIn: ['2.0.0'] };
    const result = normalizeResult('snyk', { ok: false, dependencyCount: 10, vulnerabilities: [issue, issue] }, 1);
    assert.equal(result.status, 'findings');
    assert.equal(result.counts.total, 1);
    assert.equal(result.counts.moderate, 1);
    assert.equal(normalizeResult('snyk', { ok: false, error: 'Authentication failed', code: 401 }, 2).status, 'failed');
  });

  it('retains audit transitive-only findings rather than rendering clean', () => {
    const result = JSON.parse(JSON.stringify(findingAudit));
    result.vulnerabilities.example.via = ['another-package'];
    assert.equal(normalizeResult('audit', result, 1).findings.length, 1);
  });

  it('does not let saved clean metadata override missing or malformed reports', () => {
    const html = buildSecurityReportHtml({ auditStatus: 'clean', snykStatus: 'clean' });
    assert(html.includes('SCAN INCOMPLETE'));
    assert(!html.includes('No vulnerabilities found.'));
  });

  it('marks empty, failed, partial and skipped scans incomplete while retaining valid findings', () => {
    const audit = path.join(tmp, 'audit.txt');
    const snyk = path.join(tmp, 'snyk.txt');
    fs.writeFileSync(audit, '');
    fs.writeFileSync(snyk, 'Authentication failed');
    let html = buildSecurityReportHtml({ auditReportPath: audit, snykReportPath: snyk });
    assert(html.includes('SCAN INCOMPLETE'));
    assert(!html.includes('No vulnerabilities found.'));
    fs.writeFileSync(audit, envelope('audit', findingAudit, 1));
    html = buildSecurityReportHtml({ auditReportPath: audit, snykStatus: 'skipped', environment: 'stage', projectMode: 'Existing Project' });
    assert(html.includes('Example advisory'));
    assert(html.includes('SCAN INCOMPLETE'));
    assert(html.includes('Existing Project'));
    assert(html.includes('Snyk: skipped'));
    fs.writeFileSync(audit, envelope('audit', cleanAudit));
    fs.writeFileSync(snyk, envelope('snyk', cleanSnyk));
    html = buildSecurityReportHtml({ auditReportPath: audit, snykReportPath: snyk });
    assert(!html.includes('SCAN INCOMPLETE'));
    assert(html.includes('No vulnerabilities found.'));
  });

  it('finds nested package roots and rejects ambiguity', () => {
    const nested = path.join(tmp, 'project', 'src');
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(nested, 'package.json'), '{}');
    assert.equal(findProjectRoot(tmp), nested);
    fs.mkdirSync(path.join(tmp, 'other'));
    fs.writeFileSync(path.join(tmp, 'other', 'package.json'), '{}');
    assert.throws(() => findProjectRoot(tmp), /found 2/);
  });

  it('never runs a scanner after dependency installation fails', async () => {
    const zip = path.join(tmp, 'app.zip');
    fs.writeFileSync(zip, 'fixture');
    fs.writeFileSync(path.join(tmp, 'package.json'), '{}');
    process.env.SECURITY_LOCK_DIR = path.join(tmp, 'locks');
    const calls: string[][] = [];
    await runScan('audit', { src: zip }, async () => tmp, (_command: string, args: string[]) => {
      calls.push(args); return { status: 1, stdout: '', stderr: 'E404' };
    });
    assert.equal(process.exitCode, 2);
    assert.equal(calls.length, 1);
    const report = JSON.parse(fs.readFileSync(path.join(tmp, 'audit-report.txt'), 'utf8'));
    assert.equal(report.status, 'failed');
  });

  it('reuses the same lock between scanners without npm update or global registry mutations', async () => {
    const zip = path.join(tmp, 'app.zip');
    fs.writeFileSync(zip, 'fixture');
    process.env.SECURITY_LOCK_DIR = path.join(tmp, 'locks');
    process.env.SNYK_TOKEN = 'offline-fixture-not-a-secret';
    const calls: string[][] = [];
    let extraction = 0;
    const extract = async () => {
      const root = path.join(tmp, `extract-${++extraction}`);
      fs.mkdirSync(root);
      fs.writeFileSync(path.join(root, 'package.json'), '{}');
      return root;
    };
    const run = (command: string, args: string[], options: any) => {
      calls.push(args);
      assert.equal(options.env.npm_config_registry, process.env.WM_NPM_REGISTRY || DEFAULT_WM_NPM_REGISTRY);
      if (['install', 'ci'].includes(args[0])) {
        fs.writeFileSync(path.join(options.cwd, 'package-lock.json'), '{"lockfileVersion":3}');
        return { status: 0 };
      }
      if (args[0] === '--version') return { status: 0, stdout: '1.2.3' };
      return { status: 0, stdout: JSON.stringify(command === 'npm' ? cleanAudit : cleanSnyk) };
    };
    await runScan('audit', { src: zip }, extract, run);
    assert.equal(process.exitCode, 0);
    await runScan('snyk', { src: zip }, extract, run);
    assert.equal(process.exitCode, 0);
    assert(calls.some(args => args[0] === 'install'));
    assert(calls.some(args => args[0] === 'ci'));
    assert(!calls.some(args => ['update', 'config', 'cache', 'auth'].includes(args[0])));
    const audit = JSON.parse(fs.readFileSync(path.join(tmp, 'extract-1/audit-report.txt'), 'utf8'));
    const snyk = JSON.parse(fs.readFileSync(path.join(tmp, 'extract-2/snyk-report.txt'), 'utf8'));
    assert.equal(audit.lockHash, snyk.lockHash);
  });

  it('installs idempotent security patches and fails on missing required entrypoints', () => {
    const src = path.join(tmp, 'src');
    fs.mkdirSync(src);
    const index = path.join(tmp, 'index.js');
    fs.writeFileSync(index, '// updateNotifierMod already patched fixture');
    for (const tool of ['audit', 'snyk']) {
      fs.writeFileSync(path.join(src, `${tool}.js`), `const ${tool} = async () => extractRNZip();`);
    }
    const patcher = path.resolve('scripts/patch-security-cli-update-notifier.js');
    execFileSync(process.execPath, [patcher, index]);
    const first = fs.readFileSync(path.join(src, 'audit.js'), 'utf8');
    execFileSync(process.execPath, [patcher, index]);
    assert.equal(fs.readFileSync(path.join(src, 'audit.js'), 'utf8'), first);
    fs.unlinkSync(path.join(src, 'snyk.js'));
    assert.throws(() => execFileSync(process.execPath, [patcher, index], { stdio: 'pipe' }));
  });
});
