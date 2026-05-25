import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { AuthService } from './AuthService';
import { extractZip } from '../utils/zip-utils';
import { createLogger } from '../utils/Logger';

const log = createLogger('RnProjectManager');

export interface RnProjectManagerConfig {
  baseUrl: string;
  projectId: string;
  studioProjectId: string;
  username: string;
  password: string;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
}

interface StudioJob {
  id?: string;
  completed?: boolean;
  failure?: boolean;
  type?: string;
  outputObject?: { value?: string };
}

export class RnProjectManager {
  private config: RnProjectManagerConfig;
  private baseUrl: string;
  private fileServiceUrl: string;
  private authCookie?: string;

  constructor(config: RnProjectManagerConfig) {
    this.config = {
      pollIntervalMs: 5000,
      pollTimeoutMs: 5 * 60 * 1000,
      ...config,
    };
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.fileServiceUrl = `${this.baseUrl}/file-service`;
  }

  static fromEnv(): RnProjectManager {
    const baseUrl = (
      process.env.STUDIO_BASE_URL ||
      process.env.STUDIO_URL ||
      'https://stage-studio.wavemakeronline.com'
    ).replace(/\/$/, '');

    const projectId = process.env.PROJECT_ID || process.env.WM_PROJECT_ID;
    const studioProjectId = process.env.STUDIO_PROJECT_ID;
    const username =
      process.env.STUDIO_USERNAME || process.env.WM_USERNAME || process.env.WMO_USER;
    const password =
      process.env.STUDIO_PASSWORD || process.env.WM_PASSWORD || process.env.WMO_PASS;

    const missing: string[] = [];
    if (!projectId) missing.push('PROJECT_ID');
    if (!studioProjectId) missing.push('STUDIO_PROJECT_ID');
    if (!username) missing.push('STUDIO_USERNAME (or WM_USERNAME)');
    if (!password) missing.push('STUDIO_PASSWORD (or WM_PASSWORD)');

    if (missing.length) {
      throw new Error(
        'Missing required env vars for RN ZIP download (RnProjectManager):\n' +
          `  ${missing.join('\n  ')}\n` +
          'Also set STUDIO_BASE_URL (or STUDIO_URL) for login, build API, job polling, and file-service downloads.\n' +
          'Note: PROJECT_ID (build trigger) and STUDIO_PROJECT_ID (job polling) are often different in WaveMaker.'
      );
    }

    return new RnProjectManager({
      baseUrl,
      projectId: projectId!,
      studioProjectId: studioProjectId!,
      username: username!,
      password: password!,
      pollIntervalMs: parseInt(process.env.RN_BUILD_POLL_INTERVAL_MS || '5000', 10),
      pollTimeoutMs: parseInt(process.env.RN_BUILD_POLL_TIMEOUT_MS || `${5 * 60 * 1000}`, 10),
    });
  }

  async login(): Promise<string> {
    const authService = new AuthService(this.baseUrl);
    this.authCookie = await authService.login(this.config.username, this.config.password);
    return this.authCookie;
  }

  private getCookieValue(): string {
    if (!this.authCookie) {
      throw new Error('Not authenticated. Call login() first.');
    }
    return this.authCookie.includes('=')
      ? this.authCookie.split('=').slice(1).join('=').split(';')[0].trim()
      : this.authCookie;
  }

  private studioHeaders(): Record<string, string> {
    return {
      Accept: 'application/json, text/plain, */*',
      'Content-Type': 'application/json',
      Cookie: `auth_cookie=${this.getCookieValue()}`,
      Origin: this.baseUrl,
      Referer: `${this.baseUrl}/s/page/Main?project-id=${this.config.projectId}`,
      'x-requested-with': 'XMLHttpRequest',
    };
  }

  resolveDownloadUrl(value: string): string {
    if (value.startsWith('http')) return value;
    if (value.startsWith('/')) return `${this.baseUrl}${value}`;
    return `${this.fileServiceUrl}/${value}`;
  }

  async buildNativeMobileApp(profileName: string = 'development'): Promise<string> {
    if (!this.authCookie) await this.login();

    const buildUrl =
      `${this.baseUrl}/studio/services/projects/${this.config.projectId}` +
      `/native-mobile/build/NATIVE_MOBILE?profileName=${encodeURIComponent(profileName)}`;

    log.info(`Triggering Studio RN build (profile: ${profileName})...`);

    const buildResponse = await axios.post(buildUrl, {}, { headers: this.studioHeaders() });
    const rawBuildId =
      buildResponse.data?.buildId ??
      buildResponse.data?.result ??
      buildResponse.data?.id ??
      buildResponse.data;

    if (rawBuildId === undefined || rawBuildId === null || rawBuildId === '') {
      throw new Error(`Unexpected build response: ${JSON.stringify(buildResponse.data)}`);
    }

    const buildId = String(rawBuildId);

    log.info(`RN build started. buildId=${buildId}`);

    const statusUrl = `${this.baseUrl}/studio/services/jobs/project/${this.config.studioProjectId}`;
    const deadline = Date.now() + (this.config.pollTimeoutMs ?? 5 * 60 * 1000);

    while (Date.now() < deadline) {
      const jobsResponse = await axios.get(statusUrl, { headers: this.studioHeaders() });
      const jobs: StudioJob[] = Array.isArray(jobsResponse.data)
        ? jobsResponse.data
        : jobsResponse.data?.result || jobsResponse.data?.jobs || [];

      const matchedJob = jobs.find((job) => String(job.id) === String(buildId));
      if (matchedJob?.completed) {
        if (matchedJob.failure) {
          throw new Error(`RN build job ${buildId} failed`);
        }
        const downloadValue = matchedJob.outputObject?.value;
        if (!downloadValue) {
          throw new Error(`RN build job ${buildId} completed without download URL`);
        }
        const downloadUrl = this.resolveDownloadUrl(downloadValue);
        log.success(`RN build completed. Download URL resolved.`);
        return downloadUrl;
      }

      await sleep(this.config.pollIntervalMs || 5000);
    }

    const jobsResponse = await axios.get(statusUrl, { headers: this.studioHeaders() });
    const jobs: StudioJob[] = Array.isArray(jobsResponse.data)
      ? jobsResponse.data
      : jobsResponse.data?.result || jobsResponse.data?.jobs || [];

    const fallbackJob = [...jobs]
      .reverse()
      .find(
        (job) =>
          job.completed &&
          !job.failure &&
          job.type === 'NATIVE_MOBILE_ZIP' &&
          job.outputObject?.value
      );

    if (fallbackJob?.outputObject?.value) {
      log.warn(`Build job ${buildId} not found in poll window; using latest NATIVE_MOBILE_ZIP job.`);
      return this.resolveDownloadUrl(fallbackJob.outputObject.value);
    }

    throw new Error(`Timed out waiting for RN build job ${buildId}`);
  }

  async downloadProject(downloadUrl: string, outputDir: string): Promise<string> {
    if (!this.authCookie) await this.login();

    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const zipPath = path.join(outputDir, `${this.config.projectId}-native-mobile.zip`);
    log.info(`Downloading RN ZIP to ${zipPath}...`);

    const response = await axios.get(downloadUrl, {
      headers: {
        Cookie: `auth_cookie=${this.getCookieValue()}`,
        Referer: `${this.baseUrl}/s/page/Main?project-id=${this.config.projectId}`,
      },
      responseType: 'stream',
    });

    const writer = fs.createWriteStream(zipPath);
    response.data.pipe(writer);

    await new Promise<void>((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
    });

    const fileSize = fs.statSync(zipPath).size;
    log.success(`RN ZIP downloaded (${(fileSize / 1024 / 1024).toFixed(2)} MB)`);
    return zipPath;
  }

  async extractZip(zipPath: string, extractTo: string): Promise<string> {
    log.info(`Extracting ${path.basename(zipPath)} to ${extractTo}...`);
    extractZip(zipPath, extractTo);
    log.success('RN ZIP extracted');
    return extractTo;
  }

  /**
   * Trigger Studio RN build, download ZIP, extract, and return the RN project root path.
   */
  async prepareProject(outputBaseDir: string, profileName: string = 'development'): Promise<string> {
    log.separator('Studio RN ZIP Download & Extract');

    const downloadUrl = await this.buildNativeMobileApp(profileName);
    const zipPath = await this.downloadProject(downloadUrl, outputBaseDir);
    const extractPath = path.join(outputBaseDir, 'rn-project');
    await this.extractZip(zipPath, extractPath);

    const projectPath = findRnProjectRoot(extractPath);
    log.success(`RN project ready at ${projectPath}`);
    return projectPath;
  }
}

export function findRnProjectRoot(searchDir: string): string {
  const packageJsonPath = path.join(searchDir, 'package.json');
  if (fs.existsSync(packageJsonPath)) {
    return searchDir;
  }

  const entries = fs
    .readdirSync(searchDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'));

  if (entries.length === 1) {
    return findRnProjectRoot(path.join(searchDir, entries[0].name));
  }

  const nativeMobileDir = entries.find((entry) => entry.name.includes('-native-mobile_'));
  if (nativeMobileDir) {
    return path.join(searchDir, nativeMobileDir.name);
  }

  throw new Error(`Could not locate RN project root under ${searchDir}`);
}

export function shouldDownloadRnProjectFromStudio(projectPath: string): boolean {
  if (process.env.RN_DOWNLOAD_FROM_STUDIO === 'true') return true;
  if (process.env.RN_DOWNLOAD_FROM_STUDIO === 'false') return false;
  if (process.env.RUN_LOCAL === 'false') return true;

  const packageJsonPath = path.join(projectPath, 'package.json');
  return !fs.existsSync(projectPath) || !fs.existsSync(packageJsonPath);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
