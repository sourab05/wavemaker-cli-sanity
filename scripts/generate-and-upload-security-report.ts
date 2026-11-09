#!/usr/bin/env npx ts-node
/**
 * Build custom HTML security report and upload to hardcoded S3 path:
 * react_native/releases/<version>/Security Vulnerabilities/security-vulnerabilities.html
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  buildSecurityS3Prefix,
  SECURITY_S3_CONFIG,
  resolveSecurityReleaseVersion,
} from '../src/config/security-project';
import { writeSecurityReport } from '../src/utils/security-report';
import { uploadReportToS3 } from '../src/s3/upload-report';
import { canPublishReports } from '../src/utils/report-artifacts';

async function buildAndUpload(
  metaPath: string, outputDir: string, s3Filename: string, upload: typeof uploadReportToS3
): Promise<void> {
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
  meta.releaseVersion = resolveSecurityReleaseVersion(meta.releaseVersion);

  const reportsDir = path.dirname(metaPath);
  const auditCopy = path.join(reportsDir, 'audit-report.txt');
  const snykCopy = path.join(reportsDir, 'snyk-report.txt');
  // Never read another mode/workspace when a snapshot's raw copy is missing.
  meta.auditReportPath = fs.existsSync(auditCopy) ? auditCopy : undefined;
  meta.snykReportPath = fs.existsSync(snykCopy) ? snykCopy : undefined;

  const htmlPath = writeSecurityReport(outputDir, meta);
  console.log(`--- Security HTML report: ${htmlPath} ---`);

  const s3Prefix = buildSecurityS3Prefix(meta.releaseVersion);
  console.log(`--- Uploading to s3://<bucket>/${s3Prefix}${s3Filename} ---`);

  const url = await upload({
    reportDir: outputDir,
    reportFile: 'index.html',
    prefix: s3Prefix,
    s3Filename,
    contentType: 'text/html; charset=utf-8',
  });
  console.log(`--- Security report uploaded: ${url} ---`);
}

export async function main(
  args: string[] = process.argv.slice(2), upload = uploadReportToS3
): Promise<void> {
  if (!canPublishReports()) {
    console.warn('Skipping security publishing: report initialization did not complete for this Jenkins build.');
    return;
  }
  if (!process.env.AWS_REGION?.trim()) {
    process.env.AWS_REGION = SECURITY_S3_CONFIG.region;
  }

  const reportInputPath =
    args[0] || path.resolve(process.cwd(), 'security-reports', 'report-meta.json');
  const outputDir =
    args[1] || path.resolve(process.cwd(), 'security-reports');

  if (!fs.existsSync(reportInputPath)) {
    console.warn(`No security scan metadata — skipping publishing: ${reportInputPath}`);
  } else {
    await buildAndUpload(reportInputPath, outputDir, SECURITY_S3_CONFIG.filename, upload);
  }

  // One report per project mode (security-reports-by-mode/<existing-project|new-project>).
  const modeRoot = path.resolve(process.cwd(), 'security-reports-by-mode');
  if (!fs.existsSync(modeRoot)) return;
  for (const slug of fs.readdirSync(modeRoot).sort()) {
    const dir = path.join(modeRoot, slug);
    const meta = path.join(dir, 'report-meta.json');
    if (!fs.existsSync(meta)) continue;
    await buildAndUpload(meta, dir, `security-vulnerabilities-${slug}.html`, upload);
  }
}

if (require.main === module) {
  require('dotenv').config();
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
