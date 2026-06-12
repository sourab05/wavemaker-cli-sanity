#!/usr/bin/env npx ts-node
/**
 * Build custom HTML security report and upload to hardcoded S3 path:
 * react_native/releases/<version>/Security Vulnerabilities/security-vulnerabilities.html
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  applySecurityProjectEnv,
  buildSecurityS3Prefix,
  SECURITY_S3_CONFIG,
  resolveSecurityReleaseVersion,
} from '../src/config/security-project';
import { writeSecurityReport } from '../src/utils/security-report';
import { uploadReportToS3 } from '../src/s3/upload-report';

async function main(): Promise<void> {
  require('dotenv').config();
  applySecurityProjectEnv();

  const reportInputPath =
    process.argv[2] || path.resolve(process.cwd(), 'security-reports', 'report-meta.json');
  const outputDir =
    process.argv[3] || path.resolve(process.cwd(), 'security-reports');

  if (!fs.existsSync(reportInputPath)) {
    console.error(`Report metadata not found: ${reportInputPath}`);
    process.exit(1);
  }

  const meta = JSON.parse(fs.readFileSync(reportInputPath, 'utf-8'));
  meta.releaseVersion = resolveSecurityReleaseVersion(meta.releaseVersion);

  const reportsDir = path.dirname(reportInputPath);
  const auditCopy = path.join(reportsDir, 'audit-report.txt');
  const snykCopy = path.join(reportsDir, 'snyk-report.txt');
  if (fs.existsSync(auditCopy)) meta.auditReportPath = auditCopy;
  if (fs.existsSync(snykCopy)) meta.snykReportPath = snykCopy;

  const htmlPath = writeSecurityReport(outputDir, meta);
  console.log(`--- Security HTML report: ${htmlPath} ---`);

  const s3Prefix = buildSecurityS3Prefix(meta.releaseVersion);
  console.log(`--- Uploading to s3://<bucket>/${s3Prefix}${SECURITY_S3_CONFIG.filename} ---`);

  const url = await uploadReportToS3({
    reportDir: outputDir,
    reportFile: 'index.html',
    prefix: s3Prefix,
    s3Filename: SECURITY_S3_CONFIG.filename,
    contentType: 'text/html; charset=utf-8',
  });
  console.log(`--- Security report uploaded: ${url} ---`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
