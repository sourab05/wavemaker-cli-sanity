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

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { uploadReportToS3 } from '../src/s3/upload-report';

function generateAllureReport(): boolean {
  const resultsDir = path.resolve(process.cwd(), 'allure-results');
  if (!fs.existsSync(resultsDir)) {
    console.warn(
      'allure-results/ not found. Run tests with allure-mocha first, or pass a pre-generated report dir.'
    );
    return false;
  }

  const entries = fs.readdirSync(resultsDir).filter((name) => !name.startsWith('.'));
  if (entries.length === 0) {
    console.warn('allure-results/ is empty — skipping report generation.');
    return false;
  }

  console.log('--- Generating single-file Allure report ---');
  const generateCmd =
    'npx allure generate allure-results --clean --single-file -o allure-report';
  try {
    execSync(generateCmd, { stdio: 'inherit', cwd: process.cwd() });
    console.log('--- Single-file Allure report generated ---');
    return true;
  } catch (error) {
    console.warn(`Allure generate failed (${generateCmd})`);
    throw error;
  }
}

async function main(): Promise<void> {
  require('dotenv').config();

  const reportDir =
    process.argv[2] ||
    path.resolve(process.cwd(), 'allure-report');

  if (!fs.existsSync(reportDir)) {
    generateAllureReport();
  }

  if (!fs.existsSync(reportDir)) {
    console.error(`Report directory not found: ${reportDir}`);
    process.exit(1);
  }

  const indexPath = path.join(reportDir, 'index.html');
  if (!fs.existsSync(indexPath)) {
    generateAllureReport();
  }

  if (!fs.existsSync(indexPath)) {
    console.error(`Single-file report not found: ${indexPath}`);
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
