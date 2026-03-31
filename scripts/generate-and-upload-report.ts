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
 * Optional: S3_REPORT_ENV, S3_REPORT_PROJECT, S3_REPORT_PLATFORM, S3_PATH_PREFIX
 */

import { execSync } from 'child_process';
import * as path from 'path';
import { uploadReportToS3 } from '../src/s3/upload-report';

async function main(): Promise<void> {
  require('dotenv').config();

  const reportDir =
    process.argv[2] ||
    path.resolve(process.cwd(), 'allure-report');

  // Ensure allure-results exists; if not, we might be called after tests
  const resultsDir = path.resolve(process.cwd(), 'allure-results');
  if (!require('fs').existsSync(resultsDir)) {
    console.warn(
      'allure-results/ not found. Run tests with mocha-allure-reporter first, or pass a pre-generated report dir.'
    );
  } else {
    console.log('--- Generating single-file Allure report ---');
    execSync('allure generate allure-results --clean --single-file -o allure-report', {
      stdio: 'inherit',
      cwd: process.cwd(),
    });
    console.log('--- Single-file Allure report generated ---');
  }

  if (!require('fs').existsSync(reportDir)) {
    console.error(`Report directory not found: ${reportDir}`);
    process.exit(1);
  }

  console.log('--- Uploading report to S3 ---');
  const url = await uploadReportToS3({ reportDir });
  console.log(`--- Report uploaded: ${url} ---`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
