import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { getSecurityStudioConfig } from '../../src/config/security-project';
import { applyProvisionedProjectToSecurityEnv } from '../../src/utils/studio-project-env';
import { canPublishReports, hasAllureResults } from '../../src/utils/report-artifacts';
import { main as publishCli, generateAllureReport } from '../../scripts/generate-and-upload-report';
import { main as publishSecurity } from '../../scripts/generate-and-upload-security-report';

const repo = path.resolve(__dirname, '../..');
const cleanAudit = {
  auditReportVersion: 2, vulnerabilities: {},
  metadata: { vulnerabilities: { critical: 0, high: 0, moderate: 0, low: 0, total: 0 } },
};
const cleanSnyk = { ok: true, dependencyCount: 10, vulnerabilities: [] };
const envelope = (tool: string, result: object) =>
  ({ format: 'wm-security-v1', tool, result, exitCode: 0, status: 'clean' });

describe('credential overrides and report publishing (offline)', () => {
  let tmp: string;
  let env: NodeJS.ProcessEnv;
  let cwd: string;
  const write = (file: string, value: unknown) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
  };
  beforeEach(() => {
    env = { ...process.env };
    cwd = process.cwd();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-report-test-'));
    process.chdir(tmp);
    for (const key of ['JENKINS_URL', 'BUILD_TAG', 'BUILD_NUMBER', 'JOB_NAME', 'REPORT_RUN_ID',
      'S3_REPORT_VERSION', 'S3_VERSION']) delete process.env[key];
  });
  afterEach(() => {
    process.chdir(cwd);
    for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
    Object.assign(process.env, env);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('preserves exact security password whitespace and rejects only empty passwords', () => {
    Object.assign(process.env, {
      SECURITY_USERNAME: 'fixture', SECURITY_STUDIO_URL: 'https://example.test',
      SECURITY_PROJECT_ID: 'WMPRJ-fixture', SECURITY_STUDIO_PROJECT_ID: 'proj-fixture',
    });
    for (const password of ['  fixture $\\\'"\t  ', '   ']) {
      process.env.SECURITY_PASSWORD = password;
      assert.strictEqual(getSecurityStudioConfig().password, password);
    }
    process.env.SECURITY_PASSWORD = '';
    assert.throws(() => getSecurityStudioConfig(), /Missing SECURITY_USERNAME/);
  });

  it('preserves New Project password bytes and alias fallback order', () => {
    Object.assign(process.env, { PROJECT_MODE: 'New Project', WM_PASSWORD: '  wm  ',
      WMO_PASS: '  wmo  ', STUDIO_PASSWORD: '  studio  ' });
    for (const [key, expected] of [['WM_PASSWORD', '  wm  '], ['WMO_PASS', '  wmo  '],
      ['STUDIO_PASSWORD', '  studio  ']]) {
      applyProvisionedProjectToSecurityEnv();
      assert.strictEqual(process.env.SECURITY_PASSWORD, expected);
      process.env[key] = '';
    }
  });

  for (const mode of ['Existing Project', 'New Project']) {
    it(`keeps CLI/security aliases isolated in ${mode}`, () => {
      const output = execFileSync('bash', ['-c', `
        . "$OVERRIDE_SCRIPT" >/dev/null
        node -e 'const e=process.env;const existing=e.PROJECT_MODE==="Existing Project";
          for(const key of ["WM_USERNAME","WMO_USER","STUDIO_USERNAME"])
            if(e[key] !== (existing ? "new-user" : "baseline")) process.exit(1);
          for(const key of ["WM_PASSWORD","WMO_PASS","STUDIO_PASSWORD"])
            if(e[key] !== (existing ? e.CLI_EXISTING_PASSWORD : "baseline")) process.exit(2);
          if(e.SECURITY_PASSWORD !== "security-baseline") process.exit(3);'
      `], { env: { ...process.env, OVERRIDE_SCRIPT: path.join(repo, 'scripts/apply-existing-project-overrides.sh'),
        PROJECT_MODE: mode, CLI_EXISTING_USERNAME: 'new-user', CLI_EXISTING_PASSWORD: '  fixture $ " \\  ',
        WM_USERNAME: 'baseline', WMO_USER: 'baseline', STUDIO_USERNAME: 'baseline',
        WM_PASSWORD: 'baseline', WMO_PASS: 'baseline', STUDIO_PASSWORD: 'baseline',
        SECURITY_PASSWORD: 'security-baseline', SECURITY_EXISTING_PASSWORD: '',
      } });
      assert.equal(output.length, 0);
    });
  }

  it('fails closed for missing/mismatched Jenkins initialization but permits local API settings', () => {
    assert(canPublishReports({ JENKINS_URL: 'https://jenkins.example.test' }));
    assert(!canPublishReports({ JOB_NAME: 'job', BUILD_NUMBER: '2' }));
    assert(!canPublishReports({ BUILD_TAG: 'build-2' }));
    assert(!canPublishReports({ BUILD_TAG: 'build-2', REPORT_RUN_ID: 'build-1' }));
    assert(canPublishReports({ BUILD_TAG: 'build-2', REPORT_RUN_ID: 'build-2' }));
  });

  it('ignores properties, attachments and malformed records but retains failed tests', () => {
    assert(!hasAllureResults('allure-results'));
    write('allure-results/environment.properties', 'Project_Mode=Existing Project');
    write('allure-results/attachment.txt', 'diagnostics');
    write('allure-results/bad-result.json', '{');
    write('allure-results/empty-result.json', {});
    assert(!hasAllureResults('allure-results'));
    write('allure-results/test-result.json', { uuid: 'test', name: 'failed test', status: 'failed' });
    assert(hasAllureResults('allure-results'));
  });

  it('does not generate or upload stale artifacts after initialization fails', async () => {
    Object.assign(process.env, { BUILD_TAG: 'current', REPORT_RUN_ID: 'previous' });
    write('allure-report/index.html', 'OLD');
    write('security-reports/report-meta.json', { auditStatus: 'clean' });
    const neverUpload = async () => { throw new Error('Uploader must not run'); };
    await publishCli([], neverUpload, () => { throw new Error('Generator must not run'); });
    await publishSecurity([], neverUpload);
    assert(!fs.existsSync('security-reports/index.html'));
  });

  it('skips publishing after early setup failure and removes existing default HTML', async () => {
    Object.assign(process.env, { BUILD_TAG: 'current', REPORT_RUN_ID: 'current' });
    write('allure-report/index.html', 'OLD');
    write('allure-results/environment.properties', 'Environment=fixture');
    const neverUpload = async () => { throw new Error('Uploader must not run'); };
    await publishCli([], neverUpload);
    await publishSecurity([], neverUpload);
    assert(!fs.existsSync('allure-report/index.html'));
  });

  it('rebuilds combined and both mode reports from current test results before upload', async () => {
    Object.assign(process.env, { BUILD_TAG: 'current', REPORT_RUN_ID: 'current' });
    for (const root of ['allure', 'cli-reports/existing-project', 'cli-reports/new-project']) {
      const results = root === 'allure' ? 'allure-results' : `${root}/results`;
      const report = root === 'allure' ? 'allure-report' : `${root}/report`;
      write(`${results}/test-result.json`, { uuid: root, name: root, status: 'failed' });
      write(`${report}/index.html`, 'OLD');
    }
    write('cli-reports/not-run/report/index.html', 'OLD');
    const uploads: string[] = [];
    await publishCli([], async (options) => {
      assert.equal(fs.readFileSync(path.join(options.reportDir!, 'index.html'), 'utf8'), 'CURRENT');
      uploads.push(options.s3Filename || 'combined');
      return 'mock://uploaded';
    }, (results, report) => {
      if (!hasAllureResults(results)) return false;
      write(path.join(report, 'index.html'), 'CURRENT');
      return true;
    });
    assert.deepEqual(uploads, ['combined', 'cli-existing-project.html', 'cli-new-project.html']);
  });

  it('allows explicitly supplied local HTML even with Jenkins API configuration', async () => {
    process.env.JENKINS_URL = 'https://jenkins.example.test';
    write('saved-report/index.html', 'LOCAL');
    let uploaded = false;
    await publishCli(['saved-report'], async () => { uploaded = true; return 'mock://local'; },
      () => { throw new Error('Must not regenerate explicit local report'); });
    assert(uploaded);
  });

  it('publishes incomplete mode reports without borrowing another mode’s raw scans or credentials', async () => {
    delete process.env.SECURITY_STUDIO_URL;
    const latest = 'security-reports';
    write(`${latest}/audit-report.txt`, envelope('audit', cleanAudit));
    write(`${latest}/snyk-report.txt`, envelope('snyk', cleanSnyk));
    const meta = { auditStatus: 'clean', snykStatus: 'clean', releaseVersion: 'fixture-release',
      environment: 'https://fixture.example.test', projectMode: 'New Project',
      auditReportPath: path.resolve(latest, 'audit-report.txt'),
      snykReportPath: path.resolve(latest, 'snyk-report.txt') };
    write(`${latest}/report-meta.json`, meta);
    write('security-reports-by-mode/existing-project/report-meta.json',
      { ...meta, projectMode: 'Existing Project' });
    write('security-reports-by-mode/new-project/report-meta.json', meta);
    write('security-reports-by-mode/new-project/audit-report.txt', envelope('audit', cleanAudit));
    write('security-reports-by-mode/new-project/snyk-report.txt', envelope('snyk', cleanSnyk));
    const seen: string[] = [];
    await publishSecurity([], async (options) => {
      const html = fs.readFileSync(path.join(options.reportDir!, 'index.html'), 'utf8');
      assert(html.includes('https://fixture.example.test'));
      assert.equal(options.prefix, 'react_native/releases/fixture-release/Security Vulnerabilities/');
      if (options.s3Filename!.includes('existing-project')) {
        assert(html.includes('Existing Project'));
        assert(html.includes('SCAN INCOMPLETE'));
        assert(!html.includes('No vulnerabilities found.'));
      } else {
        assert(html.includes('New Project'));
        assert(!html.includes('SCAN INCOMPLETE'));
        assert(html.includes('No vulnerabilities found.'));
      }
      seen.push(options.s3Filename!);
      return 'mock://security';
    });
    assert.equal(seen.length, 3);
  });

  it('retains an earlier mode when the last mode fails before writing metadata', async () => {
    Object.assign(process.env, { BUILD_TAG: 'current', REPORT_RUN_ID: 'current' });
    write('security-reports-by-mode/existing-project/report-meta.json',
      { projectMode: 'Existing Project', auditStatus: 'failed', snykStatus: 'skipped' });
    const uploads: string[] = [];
    await publishSecurity([], async (options) => {
      const html = fs.readFileSync(path.join(options.reportDir, 'index.html'), 'utf8');
      assert(html.includes('SCAN INCOMPLETE'));
      uploads.push(options.s3Filename!);
      return 'mock://retained';
    });
    assert.deepEqual(uploads, ['security-vulnerabilities-existing-project.html']);
  });

  it('clears only generated reports before checkout, preserving env and source files', () => {
    const pipeline = fs.readFileSync(path.join(repo, 'Jenkinsfile'), 'utf8');
    assert(pipeline.includes('skipDefaultCheckout(true)'));
    assert(pipeline.indexOf("stage('Initialize Reports')") < pipeline.indexOf("stage('Checkout')"));
    const init = pipeline.split("stage('Initialize Reports')")[1].split("stage('Checkout')")[0];
    const shell = init.match(/sh '''([\s\S]*?)'''/)![1];
    for (const dir of ['allure-results', 'allure-report', 'cli-reports', 'security-report',
      'security-reports', 'security-reports-by-mode']) write(`${dir}/old.txt`, 'OLD');
    write('.env', 'fixture');
    write('.ci-project-env.sh', 'fixture');
    write('src/keep.ts', 'fixture');
    execFileSync('sh', ['-e', '-c', shell]);
    assert(!fs.existsSync('allure-results'));
    assert(!fs.existsSync('security-reports'));
    assert.equal(fs.readFileSync('.env', 'utf8'), 'fixture');
    assert(fs.existsSync('.ci-project-env.sh'));
    assert(fs.existsSync('src/keep.ts'));
    assert(init.indexOf("sh '''") < init.indexOf('env.REPORT_RUN_ID = env.BUILD_TAG'));
  });

  it('removes partial HTML when Allure generation fails', () => {
    write('allure-results/test-result.json', { uuid: 'test', name: 'test', status: 'failed' });
    write('report/index.html', 'OLD');
    write('bin/npx', '#!/bin/sh\nmkdir -p report\nprintf PARTIAL > report/index.html\nexit 1\n');
    fs.chmodSync('bin/npx', 0o755);
    process.env.PATH = `${path.resolve('bin')}${path.delimiter}${process.env.PATH}`;
    assert.throws(() => generateAllureReport(path.resolve('allure-results'), path.resolve('report')));
    assert(!fs.existsSync('report'));
  });

  it('removes stale HTML when real Allure generation has no usable test records', () => {
    write('report/index.html', 'OLD');
    assert(!generateAllureReport(path.resolve('missing-results'), path.resolve('report')));
    assert(!fs.existsSync('report'));
  });
});
