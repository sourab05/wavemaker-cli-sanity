import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Resolve version from CLI (wm-reactnative --version).
 * Fallback: S3_REPORT_VERSION env var, then package.json.
 */
export function resolveVersion(): string {
  const envVersion = process.env.S3_REPORT_VERSION;
  if (envVersion) return envVersion;

  try {
    const version = execSync('wm-reactnative --version', {
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();
    if (version) return version;
  } catch {
    // CLI not available, fall through
  }

  try {
    const pkgPath = path.resolve(__dirname, '../../package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    return pkg.version || '1.0.0';
  } catch {
    return '1.0.0';
  }
}

/**
 * Build S3 key prefix for CLI reports: wm-qa-automation/releases/<version>/Cli/
 */
export function buildS3PathPrefix(options?: {
  version?: string;
}): string {
  const version = options?.version ?? resolveVersion();
  const projectName = process.env.S3_REPORT_PROJECT || 'Cli';
  const segments = ['releases', version, projectName];
  return segments.join('/') + '/';
}
