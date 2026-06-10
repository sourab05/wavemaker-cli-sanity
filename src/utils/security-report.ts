import * as fs from 'fs';
import * as path from 'path';

export interface SecurityReportInput {
  auditReportPath?: string;
  snykReportPath?: string;
  cliVersion?: string;
  cliBinary?: string;
  projectPath?: string;
  rnZipPath?: string;
  rnZipSource?: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function readReportFile(reportPath?: string): string {
  if (!reportPath || !fs.existsSync(reportPath)) {
    return 'Report not generated.';
  }
  return fs.readFileSync(reportPath, 'utf-8');
}

function buildReportMetaHeader(input: SecurityReportInput): string {
  const generatedAt = new Date().toISOString();
  return [
    'Security Vulnerabilities Report',
    `Generated: ${generatedAt}`,
    `CLI: ${input.cliBinary || 'unknown'} ${input.cliVersion || ''}`.trim(),
    `Project: ${input.projectPath || 'n/a'}`,
    `RN ZIP: ${input.rnZipPath || 'n/a'}`,
    `RN ZIP source: ${input.rnZipSource || 'Studio download'}`,
    '',
  ].join('\n');
}

/** Build a combined plain-text report from npm audit and Snyk outputs. */
export function buildSecurityReportText(input: SecurityReportInput): string {
  const auditBody = readReportFile(input.auditReportPath);
  const snykBody = readReportFile(input.snykReportPath);

  return [
    buildReportMetaHeader(input),
    '=== npm audit ===',
    auditBody,
    '',
    '=== Snyk ===',
    snykBody,
    '',
  ].join('\n');
}

/** Build a single HTML page from npm audit and Snyk text reports. */
export function buildSecurityReportHtml(input: SecurityReportInput): string {
  const auditBody = readReportFile(input.auditReportPath);
  const snykBody = readReportFile(input.snykReportPath);
  const generatedAt = new Date().toISOString();

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Security Vulnerabilities Report</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; margin: 24px; color: #1a1a1a; }
    h1 { margin-bottom: 8px; }
    .meta { color: #555; margin-bottom: 24px; }
    section { margin-bottom: 32px; }
    pre { background: #f6f8fa; border: 1px solid #d0d7de; border-radius: 8px; padding: 16px; overflow: auto; white-space: pre-wrap; word-break: break-word; }
    h2 { border-bottom: 1px solid #d0d7de; padding-bottom: 8px; }
  </style>
</head>
<body>
  <h1>Security Vulnerabilities Report</h1>
  <div class="meta">
    <div>Generated: ${escapeHtml(generatedAt)}</div>
    <div>CLI: ${escapeHtml(input.cliBinary || 'unknown')} ${escapeHtml(input.cliVersion || '')}</div>
    <div>Project: ${escapeHtml(input.projectPath || 'n/a')}</div>
    <div>RN ZIP: ${escapeHtml(input.rnZipPath || 'n/a')}</div>
    <div>RN ZIP source: ${escapeHtml(input.rnZipSource || 'Studio download')}</div>
  </div>
  <section>
    <h2>npm audit</h2>
    <pre>${escapeHtml(auditBody)}</pre>
  </section>
  <section>
    <h2>Snyk</h2>
    <pre>${escapeHtml(snykBody)}</pre>
  </section>
</body>
</html>`;
}

export function writeSecurityReportTxt(
  outputDir: string,
  input: SecurityReportInput,
  filename = 'security-vulnerabilities.txt'
): string {
  fs.mkdirSync(outputDir, { recursive: true });
  const reportPath = path.join(outputDir, filename);
  fs.writeFileSync(reportPath, buildSecurityReportText(input), 'utf-8');
  return reportPath;
}

export function writeSecurityReport(
  outputDir: string,
  input: SecurityReportInput
): string {
  fs.mkdirSync(outputDir, { recursive: true });
  const indexPath = path.join(outputDir, 'index.html');
  fs.writeFileSync(indexPath, buildSecurityReportHtml(input), 'utf-8');
  return indexPath;
}
