import * as fs from 'fs';
import * as path from 'path';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { buildS3PathPrefix } from './s3-path-builder';

export interface UploadReportOptions {
  /** Local directory to upload (e.g. allure-report) */
  reportDir: string;
  /** Optional custom prefix (default: wm-qa-automation/releases/<version>/Cli/) */
  prefix?: string;
}

/**
 * Upload a report directory to S3 with public-read ACL.
 * Uses path: wm-qa-automation/releases/<version>/Cli/
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
  if (!fs.existsSync(reportDir) || !fs.statSync(reportDir).isDirectory()) {
    throw new Error(`Report directory does not exist or is not a directory: ${reportDir}`);
  }

  const s3Prefix = options.prefix ?? buildS3PathPrefix();

  const client = new S3Client({ region });

  const uploadedKeys: string[] = [];
  await uploadDir(client, bucket, reportDir, reportDir, s3Prefix, uploadedKeys);

  const baseUrl = `https://${bucket}.s3.${region}.amazonaws.com`;
  const reportUrl = `${baseUrl}/${s3Prefix.replace(/\/$/, '')}/index.html`;
  return reportUrl;
}

async function uploadDir(
  client: S3Client,
  bucket: string,
  rootDir: string,
  currentDir: string,
  s3Prefix: string,
  uploadedKeys: string[]
): Promise<void> {
  const entries = fs.readdirSync(currentDir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(currentDir, entry.name);
    const relativePath = path.relative(rootDir, fullPath);
    const key = s3Prefix + relativePath.replace(/\\/g, '/');

    if (entry.isDirectory()) {
      await uploadDir(client, bucket, rootDir, fullPath, s3Prefix, uploadedKeys);
    } else {
      const body = fs.readFileSync(fullPath);
      const contentType = getContentType(entry.name);

      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
          ACL: 'public-read',
        })
      );
      uploadedKeys.push(key);
    }
  }
}

function getContentType(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  const map: Record<string, string> = {
    '.html': 'text/html',
    '.htm': 'text/html',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.xml': 'application/xml',
  };
  return map[ext] || 'application/octet-stream';
}
