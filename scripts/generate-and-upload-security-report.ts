#!/usr/bin/env npx ts-node
/**
 * Generate security-report/index.html from audit-report.txt + snyk-report.txt
 * and upload to S3 under react_native/releases/<version>/SecurityVulnerablilities/
 */

import * as fs from 'fs';
import * as path from 'path';
import { writeSecurityReport } from '../src/utils/security-report';
import { uploadReportToS3 } from '../src/s3/upload-report';

async function main(): Promise<void> {
  require('dotenv').config();

  const reportInputPath =
    process.argv[2] || path.resolve(process.cwd(), 'security-reports', 'report-meta.json');
  const outputDir =
    process.argv[3] || path.resolve(process.cwd(), 'security-report');

  if (!fs.existsSync(reportInputPath)) {
    console.error(`Report metadata not found: ${reportInputPath}`);
    process.exit(1);
  }

  const meta = JSON.parse(fs.readFileSync(reportInputPath, 'utf-8'));
  writeSecurityReport(outputDir, meta);

  if (!process.env.S3_REPORT_PROJECT) {
    process.env.S3_REPORT_PROJECT = 'SecurityVulnerablilities';
  }
  if (!process.env.S3_REPORT_FILENAME) {
    process.env.S3_REPORT_FILENAME = 'security-vulnerabilities.html';
  }

  console.log('--- Uploading security report to S3 ---');
  const url = await uploadReportToS3({ reportDir: outputDir });
  console.log(`--- Security report uploaded: ${url} ---`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
