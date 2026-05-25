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
  id?: string | number;
  jobId?: string | number;
  buildId?: string | number;
  completed?: boolean;
  failure?: boolean;
  failed?: boolean;
  type?: string;
  status?: string;
  message?: string;
  errorMessage?: string;
  outputObject?: { value?: string; message?: string };
}

function parseStudioJobs(data: unknown): StudioJob[] {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== 'object') return [];

  const obj = data as Record<string, unknown>;
  if (Array.isArray(obj.result)) return obj.result;
  if (Array.isArray(obj.jobs)) return obj.jobs;
  if (Array.isArray(obj.content)) return obj.content;

  if (obj.result && typeof obj.result === 'object' && !Array.isArray(obj.result)) {
    return Object.values(obj.result as Record<string, StudioJob>);
  }

  return [];
}

function jobMatchesBuildId(job: StudioJob, buildId: string): boolean {
  return [job.id, job.jobId, job.buildId].some(
    (value) => value !== undefined && value !== null && String(value) === buildId
  );
}

function isJobCompleted(job: StudioJob): boolean {
  return job.completed === true || job.status === 'COMPLETED' || job.status === 'SUCCESS';
}

function isJobFailed(job: StudioJob): boolean {
  return job.failure === true || job.failed === true || job.status === 'FAILED' || job.status === 'FAILURE';
}

function getJobDownloadValue(job: StudioJob): string | undefined {
  return job.outputObject?.value;
}

function formatJobFailure(job: StudioJob, buildId: string): string {
  const details = [
    job.message,
    job.errorMessage,
    job.outputObject?.message,
    job.status ? `status=${job.status}` : undefined,
    job.type ? `type=${job.type}` : undefined,
  ].filter(Boolean);

  return details.length
    ? `RN build job ${buildId} failed: ${details.join(' | ')}`
    : `RN build job ${buildId} failed`;
}

function summarizeJobs(jobs: StudioJob[]): string {
  if (!jobs.length) return 'no jobs returned';
  return jobs
    .slice(0, 5)
    .map((job) => `${String(job.id ?? job.jobId ?? '?')}:${job.type ?? 'unknown'}:completed=${Boolean(job.completed)}:failure=${Boolean(job.failure)}`)
    .join('; ');
}

export class RnProjectManager {
  private config: RnProjectManagerConfig;
  private baseUrl: string;
  private fileServiceUrl: string;
  private authCookie?: string;

  constructor(config: RnProjectManagerConfig) {
    this.config = {
      pollIntervalMs: 5000,
      pollTimeoutMs: 15 * 60 * 1000,
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
      pollTimeoutMs: parseInt(process.env.RN_BUILD_POLL_TIMEOUT_MS || `${15 * 60 * 1000}`, 10),
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
    log.info(
      `Polling jobs at studioProjectId=${this.config.studioProjectId} (timeout ${Math.round((this.config.pollTimeoutMs || 0) / 60000)} min)...`
    );

    const statusUrl = `${this.baseUrl}/studio/services/jobs/project/${this.config.studioProjectId}`;
    const deadline = Date.now() + (this.config.pollTimeoutMs ?? 15 * 60 * 1000);
    let pollCount = 0;

    while (Date.now() < deadline) {
      pollCount++;
      let jobs: StudioJob[] = [];

      try {
        const jobsResponse = await axios.get(statusUrl, { headers: this.studioHeaders() });
        jobs = parseStudioJobs(jobsResponse.data);
      } catch (error: any) {
        const status = error.response?.status;
        const body =
          typeof error.response?.data === 'string'
            ? error.response.data
            : JSON.stringify(error.response?.data ?? error.message);
        throw new Error(
          `Failed to poll Studio jobs for ${this.config.studioProjectId} (HTTP ${status ?? 'unknown'}): ${body}`
        );
      }

      const matchedJob = jobs.find((job) => jobMatchesBuildId(job, buildId));
      if (matchedJob && (isJobCompleted(matchedJob) || isJobFailed(matchedJob))) {
        if (isJobFailed(matchedJob)) {
          throw new Error(formatJobFailure(matchedJob, buildId));
        }

        const downloadValue = getJobDownloadValue(matchedJob);
        if (!downloadValue) {
          throw new Error(
            `RN build job ${buildId} completed without download URL. Job summary: ${summarizeJobs([matchedJob])}`
          );
        }

        const downloadUrl = this.resolveDownloadUrl(downloadValue);
        log.success(`RN build completed after ${pollCount} poll(s). Download URL resolved.`);
        return downloadUrl;
      }

      log.info(
        `Poll ${pollCount}: ${jobs.length} job(s), buildId=${buildId} not complete yet (${summarizeJobs(jobs)})`
      );
      await sleep(this.config.pollIntervalMs || 5000);
    }

    let jobs: StudioJob[] = [];
    try {
      const jobsResponse = await axios.get(statusUrl, { headers: this.studioHeaders() });
      jobs = parseStudioJobs(jobsResponse.data);
    } catch {
      jobs = [];
    }

    const fallbackJob = [...jobs]
      .reverse()
      .find(
        (job) =>
          isJobCompleted(job) &&
          !isJobFailed(job) &&
          job.type === 'NATIVE_MOBILE_ZIP' &&
          getJobDownloadValue(job)
      );

    if (fallbackJob) {
      const downloadValue = getJobDownloadValue(fallbackJob)!;
      log.warn(`Build job ${buildId} not found in poll window; using latest NATIVE_MOBILE_ZIP job.`);
      return this.resolveDownloadUrl(downloadValue);
    }

    throw new Error(
      `Timed out waiting for RN build job ${buildId} after ${pollCount} poll(s). ` +
        `studioProjectId=${this.config.studioProjectId}. Last jobs: ${summarizeJobs(jobs)}`
    );
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
