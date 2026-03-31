import * as fs from 'fs';
import * as path from 'path';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { buildS3PathPrefix } from './s3-path-builder';

export interface UploadReportOptions {
  /** Local directory containing the single-file report (e.g. allure-report) */
  reportDir: string;
  /** Optional custom prefix (default: releases/<version>/Cli/) */
  prefix?: string;
}

/**
 * Upload the single-file index.html report to S3 with public-read ACL.
 */
export async function uploadReportToS3(
  options: UploadReportOptions
): Promise<string> {
  const bucket = process.env.S3_REPORT_BUCKET;
  const region = process.env.S3_REPORT_REGION || process.env.AWS_REGION || 'us-east-1';

  if (!bucket) {
    throw new Error(
      'S3_REPORT_BUCKET is required. Set it in .env or environment.'
    );
  }

  const reportDir = path.resolve(options.reportDir);
  const indexPath = path.join(reportDir, 'index.html');

  if (!fs.existsSync(indexPath)) {
    throw new Error(`Single-file report not found: ${indexPath}. Run 'allure generate --single-file' first.`);
  }

  const s3Prefix = options.prefix ?? buildS3PathPrefix();
  const key = s3Prefix + 'cli.html';

  const client = new S3Client({ region });

  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: fs.readFileSync(indexPath),
      ContentType: 'text/html',
      ACL: 'public-read',
    })
  );

  const baseUrl = `https://${bucket}.s3.${region}.amazonaws.com`;
  const reportUrl = `${baseUrl}/${key}`;
  return reportUrl;
}

