import * as fs from 'fs';
import * as path from 'path';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { buildS3PathPrefix } from './s3-path-builder';

export interface UploadReportOptions {
  /** Local directory containing the report file */
  reportDir: string;
  /** Optional custom prefix (default: releases/<version>/Cli/) */
  prefix?: string;
  /** Report file name inside reportDir (default: index.html) */
  reportFile?: string;
  /** S3 object key filename (default: S3_REPORT_FILENAME env or reportFile) */
  s3Filename?: string;
  /** S3 object Content-Type (default: text/html) */
  contentType?: string;
}

/**
 * Upload a single report file to S3 with public-read ACL.
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
  const reportFile = options.reportFile?.trim() || 'index.html';
  const reportPath = path.join(reportDir, reportFile);

  if (!fs.existsSync(reportPath)) {
    throw new Error(`Report file not found: ${reportPath}`);
  }

  const s3Prefix = options.prefix ?? buildS3PathPrefix();
  const filename =
    options.s3Filename?.trim() ||
    process.env.S3_REPORT_FILENAME?.trim() ||
    reportFile;
  const key = s3Prefix + filename;
  const contentType = options.contentType?.trim() || 'text/html';

  const client = new S3Client({ region });

  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: fs.readFileSync(reportPath),
      ContentType: contentType,
      ACL: 'public-read',
    })
  );

  const baseUrl = `https://${bucket}.s3.${region}.amazonaws.com`;
  const reportUrl = `${baseUrl}/${key}`;
  return reportUrl;
}

