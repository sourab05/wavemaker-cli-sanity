import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import dotenv from 'dotenv';
import assert from 'assert';
import { getAppConfig } from '../../src/config';
import { createLogger } from '../../src/utils/Logger';
import { getCliVariant } from '../../src/utils/cli-variant';
import { runCommand } from '../../src/utils/run-command';
import { writeSecurityReport } from '../../src/utils/security-report';
import {
  RnProjectManager,
  shouldDownloadRnProjectFromStudio,
} from '../../src/services/RnProjectManager';

dotenv.config();

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

function resolveRnZipSource(): string {
  if (process.env.RN_ZIP_DOWNLOAD_URL?.trim()) {
    return process.env.RN_ZIP_DOWNLOAD_URL.trim();
  }
  return 'Studio jobs API (nativeMobileZipId)';
}

async function runSecurityCommand(
  label: string,
  command: string,
  reportPath: string
): Promise<{ exitCode: number; reportExists: boolean }> {
  log.info(`Running ${label}: ${command}`);
  let exitCode = 0;

  try {
    await runCommand(command, {
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
  } catch (error: any) {
    exitCode = 1;
    log.warn(`${label} exited with error: ${error.message}`);
  }

  const reportExists = fs.existsSync(reportPath);
  if (reportExists) {
    log.success(`${label} report saved: ${reportPath}`);
  } else {
    log.error(`${label} report not found: ${reportPath}`);
  }

  return { exitCode, reportExists };
}

describe('CLI Security Vulnerabilities (npm audit + Snyk)', function () {
  this.timeout(scanTimeout * 2 + 30 * 60 * 1000);

  let config: ReturnType<typeof getAppConfig>;
  let projectPath = '';
  let cliBinary = '';
  let cliVersion = 'unknown';

  before(async function () {
    if (process.env.SKIP_SECURITY_SCAN === 'true') {
      log.info('Skipping security scan (SKIP_SECURITY_SCAN=true)');
      this.skip();
    }

    config = getAppConfig();
    cliBinary = resolveCliBinary();

    try {
      cliVersion = execSync(`${cliBinary} --version`, { encoding: 'utf-8' }).trim();
    } catch {
      log.warn(`Could not read version from ${cliBinary} --version`);
    }

    log.separator('Security Vulnerabilities Scan');
    log.info(`CLI binary: ${cliBinary} (${cliVersion})`);
    log.info(`CLI variant: ${variant.platform}`);
    log.info(`RN ZIP source: ${resolveRnZipSource()}`);

    if (shouldDownloadRnProjectFromStudio(config.projectPath)) {
      log.step(1, 3, 'Downloading RN ZIP from Studio...');
      const rnManager = RnProjectManager.fromEnv();
      const profileName = process.env.RN_BUILD_PROFILE || 'development';
      const outputBaseDir = path.join(path.dirname(config.projectPath), '.studio-download');
      projectPath = await rnManager.prepareProject(outputBaseDir, profileName);
      log.info(`Using RN project at: ${projectPath}`);
    } else if (fs.existsSync(config.projectPath)) {
      projectPath = config.projectPath;
      log.info(`Using local RN project at: ${projectPath}`);
    } else {
      throw new Error(
        `RN project not found at ${config.projectPath}. Set RN_DOWNLOAD_FROM_STUDIO=true or provide a valid project path.`
      );
    }

    assert.ok(fs.existsSync(projectPath), `Project path does not exist: ${projectPath}`);
  });

  it('should run npm audit via CLI and produce audit-report.txt', async function () {
    const auditReportPath = path.join(projectPath, 'audit-report.txt');
    const command = `${cliBinary} audit "${projectPath}"`;
    const { exitCode, reportExists } = await runSecurityCommand('npm audit', command, auditReportPath);

    assert.ok(reportExists, `Expected audit report at ${auditReportPath}`);
    if (failOnVuln && exitCode !== 0) {
      assert.fail('npm audit reported vulnerabilities (SECURITY_FAIL_ON_VULN=true)');
    }
  });

  it('should run Snyk via CLI and produce snyk-report.txt', async function () {
    if (!process.env.SNYK_TOKEN?.trim()) {
      log.warn('Skipping Snyk scan (SNYK_TOKEN not set)');
      this.skip();
    }

    process.env.SNYK_API_TOKEN = process.env.SNYK_TOKEN;

    const snykReportPath = path.join(projectPath, 'snyk-report.txt');
    const command = `${cliBinary} snyk "${projectPath}"`;
    const { exitCode, reportExists } = await runSecurityCommand('Snyk', command, snykReportPath);

    assert.ok(reportExists, `Expected Snyk report at ${snykReportPath}`);
    if (failOnVuln && exitCode !== 0) {
      assert.fail('Snyk reported vulnerabilities (SECURITY_FAIL_ON_VULN=true)');
    }
  });

  after(function () {
    const workspaceReportsDir = path.resolve(process.cwd(), 'security-reports');
    const securityReportDir = path.resolve(process.cwd(), 'security-report');
    const auditReportPath = path.join(projectPath, 'audit-report.txt');
    const snykReportPath = path.join(projectPath, 'snyk-report.txt');

    fs.mkdirSync(workspaceReportsDir, { recursive: true });

    const meta = {
      auditReportPath,
      snykReportPath,
      cliVersion,
      cliBinary,
      projectPath,
      rnZipSource: resolveRnZipSource(),
    };

    fs.writeFileSync(
      path.join(workspaceReportsDir, 'report-meta.json'),
      JSON.stringify(meta, null, 2),
      'utf-8'
    );

    if (auditReportPath && fs.existsSync(auditReportPath)) {
      fs.copyFileSync(auditReportPath, path.join(workspaceReportsDir, 'audit-report.txt'));
    }
    if (snykReportPath && fs.existsSync(snykReportPath)) {
      fs.copyFileSync(snykReportPath, path.join(workspaceReportsDir, 'snyk-report.txt'));
    }

    writeSecurityReport(securityReportDir, meta);
    log.success(`Security HTML report: ${path.join(securityReportDir, 'index.html')}`);
    log.separator('Security Vulnerabilities Scan Complete');
  });
});
