#!/usr/bin/env npx ts-node
/**
 * Build security-vulnerabilities.txt from audit-report.txt + snyk-report.txt
 * and upload to S3 under react_native/releases/<version>/Security Vulnerabilities/
 */

import * as fs from 'fs';
import * as path from 'path';
import { writeSecurityReportTxt } from '../src/utils/security-report';
import { uploadReportToS3 } from '../src/s3/upload-report';

async function main(): Promise<void> {
  require('dotenv').config();

  const reportInputPath =
    process.argv[2] || path.resolve(process.cwd(), 'security-reports', 'report-meta.json');
  const outputDir =
    process.argv[3] || path.resolve(process.cwd(), 'security-reports');

  if (!fs.existsSync(reportInputPath)) {
    console.error(`Report metadata not found: ${reportInputPath}`);
    process.exit(1);
  }

  const meta = JSON.parse(fs.readFileSync(reportInputPath, 'utf-8'));
  const reportsDir = path.dirname(reportInputPath);
  const auditCopy = path.join(reportsDir, 'audit-report.txt');
  const snykCopy = path.join(reportsDir, 'snyk-report.txt');
  if (fs.existsSync(auditCopy)) meta.auditReportPath = auditCopy;
  if (fs.existsSync(snykCopy)) meta.snykReportPath = snykCopy;

  writeSecurityReportTxt(outputDir, meta);

  // Always use security path (Jenkins pipeline env defaults to Cli/stage-ai-cli.html)
  process.env.S3_REPORT_PROJECT = 'Security Vulnerabilities';
  process.env.S3_REPORT_FILENAME = 'security-vulnerabilities.txt';

  console.log('--- Uploading security report to S3 ---');
  const url = await uploadReportToS3({
    reportDir: outputDir,
    reportFile: 'security-vulnerabilities.txt',
    contentType: 'text/plain',
  });
  console.log(`--- Security report uploaded: ${url} ---`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
