#!/usr/bin/env npx ts-node
/**
 * Combined script: Generate Allure report from test results and upload to S3.
 *
 * Usage:
 *   npx ts-node scripts/generate-and-upload-report.ts [report-dir]
 *
 * Default report dir: allure-report (after running allure generate)
 *
 * Requires: S3_REPORT_BUCKET, AWS credentials (env or ~/.aws/credentials)
 * Optional: S3_REPORT_VERSION / S3_VERSION, S3_REPORT_PROJECT, S3_REPORT_FILENAME
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { uploadReportToS3 } from '../src/s3/upload-report';
import { canPublishReports, hasAllureResults, isJenkinsBuild } from '../src/utils/report-artifacts';

export function generateAllureReport(resultsDir: string, reportDir: string): boolean {
  // Never leave old/partial HTML behind after a skipped or failed generation.
  fs.rmSync(reportDir, { recursive: true, force: true });
  if (!hasAllureResults(resultsDir)) {
    console.warn(`No valid Allure test results in ${resultsDir} — skipping report generation.`);
    return false;
  }
  console.log('--- Generating single-file Allure report ---');
  try {
    execFileSync('npx', ['allure', 'generate', resultsDir, '--clean', '--single-file', '-o', reportDir],
      { stdio: 'inherit', cwd: process.cwd() });
    return fs.existsSync(path.join(reportDir, 'index.html'));
  } catch (error) {
    fs.rmSync(reportDir, { recursive: true, force: true });
    throw error;
  }
}

export async function main(
  args: string[] = process.argv.slice(2),
  upload = uploadReportToS3,
  generate = generateAllureReport
): Promise<void> {
  if (!canPublishReports()) {
    console.warn('Skipping CLI publishing: report initialization did not complete for this Jenkins build.');
    return;
  }
  const reportDir = path.resolve(isJenkinsBuild() ? 'allure-report' : (args[0] || 'allure-report'));
  // Explicit pre-generated reports remain supported locally, not in Jenkins.
  if (!args[0] || isJenkinsBuild()) {
    if (!generate(path.resolve('allure-results'), reportDir)) return;
  }
  if (!fs.existsSync(path.join(reportDir, 'index.html'))) {
    throw new Error(`Single-file report not found: ${reportDir}`);
  }

  console.log('--- Uploading report to S3 ---');
  const url = await upload({ reportDir });
  console.log(`--- Report uploaded: ${url} ---`);

  // CLI runs leave one report per project mode (cli-reports/<existing-project|new-project>/report).
  const modeRoot = path.resolve(process.cwd(), 'cli-reports');
  if (!fs.existsSync(modeRoot)) return;
  for (const slug of fs.readdirSync(modeRoot).sort()) {
    const dir = path.join(modeRoot, slug, 'report');
    if (!generate(path.join(modeRoot, slug, 'results'), dir)) continue;
    const modeUrl = await upload({ reportDir: dir, s3Filename: `cli-${slug}.html` });
    console.log(`--- ${slug} report uploaded: ${modeUrl} ---`);
  }
}

if (require.main === module) {
  require('dotenv').config();
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
