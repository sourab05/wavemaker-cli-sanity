import * as path from 'path';

/**
 * Security scan defaults (Studio project ids come from SECURITY_* env / Jenkins — not hardcoded).
 */
export const SECURITY_PROJECT_CONFIG = {
  appName: 'SecurityVulnerabilities',
  appPackage: 'com.securityvulnerabilities',
  rnBuildProfile: 'development',
  rnProjectFolder: 'SecurityVulnerabilities-native-mobile_0.0.1',
  cliRepoUrl: 'https://github.com/Karthik7bk/wm-reactnative-cli.git',
  cliBranch: 'SecurityVulnerabilities',
  cliBinary: 'wm-reactnative',
} as const;

export interface SecurityStudioConfig {
  baseUrl: string;
  projectId: string;
  studioProjectId: string;
  username: string;
  password: string;
}

export function resolveSecurityProjectId(): string {
  const projectId = process.env.SECURITY_PROJECT_ID?.trim();
  if (!projectId) {
    throw new Error(
      'Missing SECURITY_PROJECT_ID (WMPRJ build trigger id).\n' +
        '  Set SECURITY_PROJECT_ID in .env or Jenkins credential SECURITY_WM_PROJECT_ID.\n' +
        '  Security scans do not use WM_PROJECT_ID / WM_CLI_PROJECT_ID.'
    );
  }
  return projectId;
}

export function resolveSecurityStudioUrl(): string {
  const url = process.env.SECURITY_STUDIO_URL?.trim();
  if (!url) {
    throw new Error(
      'Missing SECURITY_STUDIO_URL.\n' +
        '  Set in .env or Jenkins credential SECURITY_WM_STUDIO_URL.\n' +
        '  Security scans do not use STUDIO_URL / WM_CLI_STUDIO_URL.'
    );
  }
  return url.replace(/\/$/, '');
}

/**
 * Studio login + ZIP download — SECURITY_* env only (never WM_USERNAME / WM_PASSWORD / WM_PROJECT_ID).
 */
export function getSecurityStudioConfig(): SecurityStudioConfig {
  const username = process.env.SECURITY_USERNAME?.trim();
  const password = process.env.SECURITY_PASSWORD?.trim();
  if (!username || !password) {
    throw new Error(
      'Missing SECURITY_USERNAME and SECURITY_PASSWORD.\n' +
        '  Set them in .env or Jenkins credentials SECURITY_WM_USERNAME / SECURITY_WM_PASSWORD.'
    );
  }

  const baseUrl = resolveSecurityStudioUrl();

  const projectId = resolveSecurityProjectId();
  const studioProjectId = process.env.SECURITY_STUDIO_PROJECT_ID?.trim() || '';
  const directZipUrl = process.env.RN_ZIP_DOWNLOAD_URL?.trim();

  if (!directZipUrl && !studioProjectId) {
    throw new Error(
      'Missing SECURITY_STUDIO_PROJECT_ID (jobs API proj-xxx id).\n' +
        '  Set SECURITY_STUDIO_PROJECT_ID in .env or Jenkins credential SECURITY_WM_STUDIO_PROJECT_ID,\n' +
        '  or set RN_ZIP_DOWNLOAD_URL for a direct ZIP fallback.'
    );
  }

  return {
    baseUrl,
    projectId,
    studioProjectId,
    username,
    password,
  };
}

/** Hardcoded S3 layout — never uses Cli/ or stage-ai-cli.html */
export const SECURITY_S3_CONFIG = {
  region: 'us-west-2',
  pathSegments: ['react_native', 'releases'] as const,
  projectFolder: 'Security Vulnerabilities',
  filename: 'security-vulnerabilities.html',
  defaultReleaseVersion: 'WM-AI 1.0.0_BETA_RC4',
} as const;

/** Apply security-only env. Does not read WM_USERNAME / WM_PASSWORD / WM_PROJECT_ID. */
export function applySecurityProjectEnv(): void {
  const studioUrl = resolveSecurityStudioUrl();

  if (process.env.SECURITY_PROJECT_ID?.trim()) {
    process.env.PROJECT_ID = process.env.SECURITY_PROJECT_ID.trim();
  }

  process.env.APP_NAME =
    process.env.SECURITY_APP_NAME?.trim() || SECURITY_PROJECT_CONFIG.appName;
  process.env.APP_PACKAGE =
    process.env.SECURITY_APP_PACKAGE?.trim() || SECURITY_PROJECT_CONFIG.appPackage;
  process.env.RN_BUILD_PROFILE =
    process.env.SECURITY_RN_BUILD_PROFILE?.trim() || SECURITY_PROJECT_CONFIG.rnBuildProfile;
  process.env.RN_PROJECT_FOLDER =
    process.env.SECURITY_RN_PROJECT_FOLDER?.trim() || SECURITY_PROJECT_CONFIG.rnProjectFolder;
  process.env.SECURITY_CLI_REPO_URL = SECURITY_PROJECT_CONFIG.cliRepoUrl;
  process.env.SECURITY_CLI_BRANCH = SECURITY_PROJECT_CONFIG.cliBranch;
  process.env.SECURITY_CLI_BINARY = SECURITY_PROJECT_CONFIG.cliBinary;

  process.env.STUDIO_URL = studioUrl;
  process.env.STUDIO_BASE_URL = studioUrl;
  if (!process.env.LOGIN_URL?.trim()) {
    process.env.LOGIN_URL = `${studioUrl}/login/authenticate`;
  }

  if (process.env.SECURITY_STUDIO_PROJECT_ID?.trim()) {
    process.env.STUDIO_PROJECT_ID = process.env.SECURITY_STUDIO_PROJECT_ID.trim();
  }

  process.env.S3_REPORT_PROJECT = SECURITY_S3_CONFIG.projectFolder;
  process.env.S3_REPORT_FILENAME = SECURITY_S3_CONFIG.filename;
  if (!process.env.S3_REPORT_VERSION?.trim() && !process.env.S3_VERSION?.trim()) {
    process.env.S3_REPORT_VERSION = SECURITY_S3_CONFIG.defaultReleaseVersion;
    process.env.S3_VERSION = SECURITY_S3_CONFIG.defaultReleaseVersion;
  }
  if (!process.env.AWS_REGION?.trim()) {
    process.env.AWS_REGION = SECURITY_S3_CONFIG.region;
  }
}

const SEMVER_PATTERN = /\d+\.\d+\.\d+(?:[-+][\w.]+)?/;

/** Extract a semver from noisy CLI `--version` output (may be multi-line). */
export function parseCliVersionString(raw?: string): string {
  if (!raw?.trim()) return 'unknown';
  const lines = raw.trim().split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    const match = line.match(SEMVER_PATTERN);
    if (match) return match[0];
  }
  const match = raw.match(SEMVER_PATTERN);
  return match ? match[0] : lines[0] || 'unknown';
}

/** Reject multi-line or CLI banner text mistakenly used as an S3 release folder name. */
export function isValidReleaseVersion(value?: string): boolean {
  if (!value?.trim()) return false;
  if (value.includes('\n') || value.includes('\r')) return false;
  if (/wm\s*=/i.test(value) || /reactnative-cli/i.test(value)) return false;
  return true;
}

/** S3 release folder: Jenkins S3_VERSION first, then valid meta fallback, then default. */
export function resolveSecurityReleaseVersion(fallback?: string): string {
  const fromEnv =
    process.env.S3_REPORT_VERSION?.trim() || process.env.S3_VERSION?.trim();
  if (fromEnv) return fromEnv;

  const fb = fallback?.trim();
  if (fb && isValidReleaseVersion(fb)) return fb;

  return SECURITY_S3_CONFIG.defaultReleaseVersion;
}

export function buildSecurityS3Prefix(releaseVersion?: string): string {
  const version = resolveSecurityReleaseVersion(releaseVersion);
  return [...SECURITY_S3_CONFIG.pathSegments, version, SECURITY_S3_CONFIG.projectFolder].join('/') + '/';
}

export function buildSecurityS3Key(releaseVersion?: string): string {
  return buildSecurityS3Prefix(releaseVersion) + SECURITY_S3_CONFIG.filename;
}

export function getSecurityProjectPath(): string {
  const folder =
    process.env.SECURITY_RN_PROJECT_FOLDER?.trim() ||
    process.env.RN_PROJECT_FOLDER?.trim() ||
    SECURITY_PROJECT_CONFIG.rnProjectFolder;
  return path.resolve(__dirname, '..', 'rn-zips', folder);
}
