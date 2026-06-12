import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import dotenv from 'dotenv';
import assert from 'assert';
import { createLogger } from '../../src/utils/Logger';
import { getCliVariant } from '../../src/utils/cli-variant';
import { runCommand } from '../../src/utils/run-command';
import { writeSecurityReport, writeSecurityReportTxt } from '../../src/utils/security-report';
import {
  RnProjectManager,
  RnProjectArtifacts,
} from '../../src/services/RnProjectManager';
import { getAppConfig } from '../../src/config';
import {
  applySecurityProjectEnv,
  getSecurityProjectPath,
  resolveSecurityReleaseVersion,
} from '../../src/config/security-project';

dotenv.config();
applySecurityProjectEnv();

const log = createLogger('SecurityVulnerabilitiesSpec');
const variant = getCliVariant();
const scanTimeout = Number(process.env.SECURITY_SCAN_TIMEOUT || 45 * 60 * 1000);
const failOnVuln = process.env.SECURITY_FAIL_ON_VULN === 'true';

function resolveCliBinary(): string {
  return (
    process.env.SECURITY_CLI_BINARY?.trim() ||
    process.env.CLI_BINARY?.trim() ||
    variant.binaryName
  );
}

function resolveCliAuditCommand(subcommand: 'audit' | 'snyk', targetPath: string): string {
  const repoPath = process.env.SECURITY_CLI_REPO_PATH?.trim();
  if (repoPath) {
    const cliEntry = path.join(repoPath, 'index.js');
    return `node "${cliEntry}" ${subcommand} "${targetPath}"`;
  }
  return `${resolveCliBinary()} ${subcommand} "${targetPath}"`;
}

function resolveReportPathFromOutput(output: string, fallbackPath: string): string {
  const match = output.match(/report saved to (.+)/i);
  if (match?.[1]) {
    return match[1].trim();
  }
  return fallbackPath;
}

async function runSecurityCommand(
  label: string,
  command: string,
  fallbackReportPath: string
): Promise<{ exitCode: number; reportPath: string; reportExists: boolean }> {
  log.info(`Running ${label}: ${command}`);
  let exitCode = 0;
  let stdout = '';
  let stderr = '';

  try {
    const result = await runCommand(command, {
      cwd: process.cwd(),
      timeout: scanTimeout,
      onData: (text, child) => {
        if (text.includes('Snyk API Token:')) {
          const token = process.env.SNYK_TOKEN?.trim();
          if (token) {
            child.stdin?.write(`${token}\n`);
          }
        }
      },
    });
    if (typeof result === 'object' && result !== null && 'stdout' in result) {
      stdout = result.stdout;
      stderr = result.stderr;
    } else if (typeof result === 'string') {
      stdout = result;
    }
  } catch (error: any) {
    exitCode = 1;
    const message = error.message || String(error);
    stdout = message;
    log.warn(`${label} exited with error: ${message}`);
  }

  const combinedOutput = `${stdout}\n${stderr}`;
  const reportPath = resolveReportPathFromOutput(combinedOutput, fallbackReportPath);
  const reportExists = fs.existsSync(reportPath);

  if (reportExists) {
    log.success(`${label} report saved: ${reportPath}`);
  } else {
    log.error(`${label} report not found: ${reportPath}`);
  }

  return { exitCode, reportPath, reportExists };
}

describe('CLI Security Vulnerabilities (npm audit + Snyk)', function () {
  this.timeout(scanTimeout * 2 + 30 * 60 * 1000);

  let artifacts: RnProjectArtifacts;
  let cliBinary = '';
  let cliVersion = 'unknown';
  let auditReportPath = '';
  let snykReportPath = '';

  before(async function () {
    if (process.env.SKIP_SECURITY_SCAN === 'true') {
      log.info('Skipping security scan (SKIP_SECURITY_SCAN=true)');
      this.skip();
    }

    applySecurityProjectEnv();
    log.info(
      `Security project: ${process.env.SECURITY_PROJECT_ID} (${process.env.APP_NAME})`
    );

    const config = getAppConfig();
    config.projectPath = getSecurityProjectPath();
    cliBinary = resolveCliBinary();

    try {
      cliVersion = execSync(`${cliBinary} --version`, { encoding: 'utf-8' }).trim();
    } catch {
      log.warn(`Could not read version from ${cliBinary} --version`);
    }

    log.separator('Security Vulnerabilities Scan');
    log.info(`CLI binary: ${cliBinary} (${cliVersion})`);
    log.info(`CLI variant: ${variant.platform}`);

    log.step(1, 3, 'Downloading RN ZIP from Studio and extracting (RnProjectManager)...');
    const rnManager = RnProjectManager.fromSecurityEnv();
    const profileName = process.env.RN_BUILD_PROFILE || 'development';
    const outputBaseDir = path.join(
      path.dirname(config.projectPath),
      '.studio-download-security'
    );

    artifacts = await rnManager.prepareProjectWithZip(outputBaseDir, profileName);

    log.info(`RN ZIP: ${artifacts.zipPath} (${(fs.statSync(artifacts.zipPath).size / 1024 / 1024).toFixed(2)} MB)`);
    log.info(`Extracted project: ${artifacts.projectPath}`);
    assert.ok(fs.existsSync(artifacts.zipPath), `ZIP missing: ${artifacts.zipPath}`);
    assert.ok(fs.existsSync(artifacts.projectPath), `Project missing: ${artifacts.projectPath}`);
  });

  it('should run npm audit on Studio RN ZIP via CLI', async function () {
    log.step(2, 3, 'Running npm audit on Studio RN ZIP...');
    const zipPath = artifacts.zipPath;
    const command = resolveCliAuditCommand('audit', zipPath);
    const fallbackReportPath = path.join(artifacts.projectPath, 'audit-report.txt');

    const { exitCode, reportPath, reportExists } = await runSecurityCommand(
      'npm audit',
      command,
      fallbackReportPath
    );
    auditReportPath = reportPath;

    assert.ok(reportExists, `Expected audit report at ${reportPath}`);
    if (failOnVuln && exitCode !== 0) {
      assert.fail('npm audit reported vulnerabilities (SECURITY_FAIL_ON_VULN=true)');
    }
  });

  it('should run Snyk on Studio RN ZIP via CLI', async function () {
    if (!process.env.SNYK_TOKEN?.trim()) {
      log.warn('Skipping Snyk scan (SNYK_TOKEN not set)');
      this.skip();
    }

    log.step(3, 3, 'Running Snyk on Studio RN ZIP...');
    process.env.SNYK_API_TOKEN = process.env.SNYK_TOKEN;

    const zipPath = artifacts.zipPath;
    const command = resolveCliAuditCommand('snyk', zipPath);
    const fallbackReportPath = path.join(artifacts.projectPath, 'snyk-report.txt');

    const { exitCode, reportPath, reportExists } = await runSecurityCommand(
      'Snyk',
      command,
      fallbackReportPath
    );
    snykReportPath = reportPath;

    assert.ok(reportExists, `Expected Snyk report at ${reportPath}`);
    if (failOnVuln && exitCode !== 0) {
      assert.fail('Snyk reported vulnerabilities (SECURITY_FAIL_ON_VULN=true)');
    }
  });

  after(function () {
    const workspaceReportsDir = path.resolve(process.cwd(), 'security-reports');

    fs.mkdirSync(workspaceReportsDir, { recursive: true });

    let auditPathForMeta = auditReportPath;
    let snykPathForMeta = snykReportPath;

    const meta = {
      auditReportPath: auditPathForMeta,
      snykReportPath: snykPathForMeta,
      cliVersion,
      cliBinary,
      projectPath: artifacts?.projectPath,
      rnZipPath: artifacts?.zipPath,
      rnZipSource: artifacts?.downloadUrl || process.env.RN_ZIP_DOWNLOAD_URL || 'Studio jobs API',
      releaseVersion: resolveSecurityReleaseVersion(cliVersion),
    };

    if (auditReportPath && fs.existsSync(auditReportPath)) {
      auditPathForMeta = path.join(workspaceReportsDir, 'audit-report.txt');
      fs.copyFileSync(auditReportPath, auditPathForMeta);
      meta.auditReportPath = auditPathForMeta;
    }
    if (snykReportPath && fs.existsSync(snykReportPath)) {
      snykPathForMeta = path.join(workspaceReportsDir, 'snyk-report.txt');
      fs.copyFileSync(snykReportPath, snykPathForMeta);
      meta.snykReportPath = snykPathForMeta;
    }
    if (artifacts?.zipPath && fs.existsSync(artifacts.zipPath)) {
      fs.copyFileSync(
        artifacts.zipPath,
        path.join(workspaceReportsDir, path.basename(artifacts.zipPath))
      );
    }

    writeSecurityReportTxt(workspaceReportsDir, meta);
    const htmlReportPath = writeSecurityReport(workspaceReportsDir, meta);
    const archiveReportDir = path.resolve(process.cwd(), 'security-report');
    fs.mkdirSync(archiveReportDir, { recursive: true });
    fs.copyFileSync(htmlReportPath, path.join(archiveReportDir, 'index.html'));
    fs.writeFileSync(
      path.join(workspaceReportsDir, 'report-meta.json'),
      JSON.stringify(meta, null, 2),
      'utf-8'
    );
    log.success(`Security HTML report: ${htmlReportPath}`);
    log.separator('Security Vulnerabilities Scan Complete');
  });
});
