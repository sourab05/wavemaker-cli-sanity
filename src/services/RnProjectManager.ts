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

/** Result of Studio RN ZIP download + extract (used by security audit/snyk). */
export interface RnProjectArtifacts {
  zipPath: string;
  projectPath: string;
  outputBaseDir: string;
  downloadUrl?: string;
}

interface StudioJobMetadata {
  nativeMobileZipId?: string;
  profileName?: string;
  [key: string]: unknown;
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
  startTime?: number;
  endTime?: number;
  metadata?: StudioJobMetadata;
  outputObject?: { value?: string; message?: string; outputType?: string };
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

/** Prefer metadata.nativeMobileZipId from Studio jobs API; fall back to outputObject.value. */
function getJobNativeMobileZipId(job: StudioJob): string | undefined {
  const fromMetadata = job.metadata?.nativeMobileZipId?.trim();
  if (fromMetadata) return fromMetadata;

  const outputValue = job.outputObject?.value?.trim();
  if (!outputValue) return undefined;

  const fileServiceMatch = outputValue.match(/\/file-service\/([^/?#]+)/i);
  if (fileServiceMatch) return fileServiceMatch[1];

  if (!outputValue.includes('/')) return outputValue;
  return undefined;
}

function jobHasNativeZip(job: StudioJob): boolean {
  return Boolean(getJobNativeMobileZipId(job));
}

function sortJobsNewestFirst(jobs: StudioJob[]): StudioJob[] {
  return [...jobs].sort((a, b) => (b.startTime ?? 0) - (a.startTime ?? 0));
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
  return sortJobsNewestFirst(jobs)
    .slice(0, 5)
    .map((job) => {
      const zipId = getJobNativeMobileZipId(job);
      return `${String(job.id ?? job.jobId ?? '?')}:${job.type ?? 'unknown'}:zip=${zipId ?? 'none'}:completed=${Boolean(job.completed)}:failure=${Boolean(job.failure)}`;
    })
    .join('; ');
}

function isRetryableJobsPollError(error: unknown): boolean {
  if (axios.isAxiosError(error)) {
    const status = error.response?.status;
    if (status && [408, 429, 500, 502, 503, 504].includes(status)) return true;
  }
  return isRetryableStudioBuildError(error);
}

function isRetryableStudioBuildError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /internal server error|timeout|timed out|503|502|504|econnreset|etimedout|socket hang up/i.test(
    message
  );
}

function getRetryCount(): number {
  return Math.max(1, parseInt(process.env.RN_BUILD_MAX_RETRIES || '3', 10));
}

function getRetryDelayMs(): number {
  return parseInt(process.env.RN_BUILD_RETRY_DELAY_MS || '15000', 10);
}

function getEmptyJobsPollLimit(): number {
  return Math.max(3, parseInt(process.env.RN_BUILD_EMPTY_JOBS_POLL_LIMIT || '12', 10));
}

function shouldSkipStudioBuild(): boolean {
  return process.env.RN_SKIP_STUDIO_BUILD === 'true';
}

function previewResponseData(data: unknown): string {
  if (typeof data === 'string') return data.slice(0, 300);
  try {
    return JSON.stringify(data).slice(0, 300);
  } catch {
    return String(data).slice(0, 300);
  }
}

/** Fallback file-service URL or file id when Studio build/polling fails. */
export function getFallbackZipDownloadUrl(): string | undefined {
  const value = process.env.RN_ZIP_DOWNLOAD_URL?.trim();
  return value || undefined;
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

    const directZipUrl = process.env.RN_ZIP_DOWNLOAD_URL?.trim();
    const missing: string[] = [];
    if (!projectId) missing.push('PROJECT_ID (or WM_PROJECT_ID)');
    if (!directZipUrl && !studioProjectId) missing.push('STUDIO_PROJECT_ID');
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
      studioProjectId: studioProjectId || '',
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

  private async fetchProjectJobs(): Promise<StudioJob[]> {
    const statusUrl = `${this.baseUrl}/studio/services/jobs/project/${this.config.studioProjectId}`;
    const jobsResponse = await axios.get(statusUrl, { headers: this.studioHeaders() });
    return parseStudioJobs(jobsResponse.data);
  }

  private resolveZipFromJobs(jobs: StudioJob[], buildId?: string): string | undefined {
    if (buildId) {
      const matchedJob = jobs.find((job) => jobMatchesBuildId(job, buildId));
      if (matchedJob && isJobCompleted(matchedJob) && !isJobFailed(matchedJob)) {
        const zipId = getJobNativeMobileZipId(matchedJob);
        if (zipId) return this.resolveDownloadUrl(zipId);
      }
    }

    const latestJob = sortJobsNewestFirst(jobs).find(
      (job) =>
        isJobCompleted(job) &&
        !isJobFailed(job) &&
        (job.type === 'NATIVE_MOBILE_ZIP' || job.type?.includes('NATIVE_MOBILE')) &&
        jobHasNativeZip(job)
    );

    if (!latestJob) return undefined;
    return this.resolveDownloadUrl(getJobNativeMobileZipId(latestJob)!);
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
    let consecutiveEmptyJobs = 0;
    const emptyJobsLimit = getEmptyJobsPollLimit();

    while (Date.now() < deadline) {
      pollCount++;
      let jobs: StudioJob[] = [];
      let rawResponse: unknown;

      try {
        const jobsResponse = await axios.get(statusUrl, { headers: this.studioHeaders() });
        rawResponse = jobsResponse.data;
        jobs = parseStudioJobs(jobsResponse.data);
      } catch (error: any) {
        const status = error.response?.status;
        const body =
          typeof error.response?.data === 'string'
            ? error.response.data
            : JSON.stringify(error.response?.data ?? error.message);

        if (isRetryableJobsPollError(error) && Date.now() < deadline) {
          log.warn(
            `Jobs poll error (HTTP ${status ?? 'unknown'}) on poll ${pollCount}; retrying... ${body.slice(0, 200)}`
          );
          await sleep(this.config.pollIntervalMs || 5000);
          continue;
        }

        throw new Error(
          `Failed to poll Studio jobs for ${this.config.studioProjectId} (HTTP ${status ?? 'unknown'}): ${body}`
        );
      }

      const matchedJob = jobs.find((job) => jobMatchesBuildId(job, buildId));
      if (matchedJob && (isJobCompleted(matchedJob) || isJobFailed(matchedJob))) {
        if (isJobFailed(matchedJob)) {
          throw new Error(formatJobFailure(matchedJob, buildId));
        }

        const zipId = getJobNativeMobileZipId(matchedJob);
        if (!zipId) {
          throw new Error(
            `RN build job ${buildId} completed without nativeMobileZipId. Job summary: ${summarizeJobs([matchedJob])}`
          );
        }

        const downloadUrl = this.resolveDownloadUrl(zipId);
        log.success(
          `RN build completed after ${pollCount} poll(s). nativeMobileZipId=${zipId} → ${downloadUrl}`
        );
        return downloadUrl;
      }

      if (jobs.length === 0) {
        consecutiveEmptyJobs++;
        if (pollCount === 1 || pollCount % emptyJobsLimit === 0) {
          log.warn(
            `Jobs API returned 0 jobs (poll ${pollCount}, studioProjectId=${this.config.studioProjectId}). ` +
              `Response preview: ${previewResponseData(rawResponse)}`
          );
        }
        if (consecutiveEmptyJobs >= emptyJobsLimit) {
          throw new Error(
            `Jobs API returned 0 jobs for ${consecutiveEmptyJobs} consecutive polls (~${Math.round((consecutiveEmptyJobs * (this.config.pollIntervalMs || 5000)) / 1000)}s). ` +
              `Check Jenkins credential WM_CLI_STUDIO_PROJECT_ID is proj-xxx (not WMPRJ-xxx). ` +
              `URL: ${statusUrl}`
          );
        }
      } else {
        consecutiveEmptyJobs = 0;
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

    const fallbackJob = sortJobsNewestFirst(jobs).find(
      (job) =>
        isJobCompleted(job) &&
        !isJobFailed(job) &&
        job.type === 'NATIVE_MOBILE_ZIP' &&
        jobHasNativeZip(job)
    );

    if (fallbackJob) {
      const zipId = getJobNativeMobileZipId(fallbackJob)!;
      log.warn(
        `Build job ${buildId} not found in poll window; using latest NATIVE_MOBILE_ZIP (nativeMobileZipId=${zipId}).`
      );
      return this.resolveDownloadUrl(zipId);
    }

    throw new Error(
      `Timed out waiting for RN build job ${buildId} after ${pollCount} poll(s). ` +
        `studioProjectId=${this.config.studioProjectId}. Last jobs: ${summarizeJobs(jobs)}`
    );
  }

  /**
   * Find the latest completed native-mobile ZIP from Studio jobs (no new build).
   * Uses the same jobs API as Studio UI:
   * GET /studio/services/jobs/project/{STUDIO_PROJECT_ID}
   */
  async fetchLatestNativeZipDownloadUrl(): Promise<string | undefined> {
    if (!this.config.studioProjectId) {
      log.warn('STUDIO_PROJECT_ID not set; skipping jobs API ZIP lookup');
      return undefined;
    }

    if (!this.authCookie) await this.login();

    const statusUrl = `${this.baseUrl}/studio/services/jobs/project/${this.config.studioProjectId}`;
    log.info(`Looking up latest NATIVE_MOBILE_ZIP from jobs API (${this.config.studioProjectId})...`);

    let jobs: StudioJob[];
    try {
      jobs = await this.fetchProjectJobs();
    } catch (error: any) {
      const status = error.response?.status;
      const body =
        typeof error.response?.data === 'string'
          ? error.response.data
          : JSON.stringify(error.response?.data ?? error.message);
      throw new Error(
        `Failed to fetch Studio jobs for ${this.config.studioProjectId} (HTTP ${status ?? 'unknown'}): ${body}`
      );
    }

    if (!jobs.length) {
      log.warn(`Jobs API returned 0 jobs for studioProjectId=${this.config.studioProjectId}`);
      return undefined;
    }

    const downloadUrl = this.resolveZipFromJobs(jobs);
    if (!downloadUrl) {
      log.warn(`No completed NATIVE_MOBILE_ZIP job with nativeMobileZipId (${jobs.length} job(s) returned)`);
      return undefined;
    }

    log.success(`Found existing native ZIP from jobs API → ${downloadUrl}`);
    return downloadUrl;
  }

  /** Skip Studio build; resolve ZIP from jobs API or RN_ZIP_DOWNLOAD_URL only. */
  async prepareProjectFromExistingZip(outputBaseDir: string): Promise<string> {
    log.separator('Studio RN ZIP Download (existing ZIP, skip build)');

    if (fs.existsSync(outputBaseDir)) {
      fs.rmSync(outputBaseDir, { recursive: true, force: true });
    }
    fs.mkdirSync(outputBaseDir, { recursive: true });

    if (!this.authCookie) await this.login();

    try {
      const jobsZipUrl = await this.fetchLatestNativeZipDownloadUrl();
      if (jobsZipUrl) {
        return (await this.downloadExtractAndFindRoot(outputBaseDir, jobsZipUrl)).projectPath;
      }
    } catch (error: any) {
      log.warn(`Jobs API lookup failed: ${error.message}`);
    }

    const fallbackZip = getFallbackZipDownloadUrl();
    if (fallbackZip) {
      const downloadUrl = this.resolveDownloadUrl(fallbackZip);
      log.warn(`Using RN_ZIP_DOWNLOAD_URL → ${downloadUrl}`);
      return (await this.downloadExtractAndFindRoot(outputBaseDir, downloadUrl)).projectPath;
    }

    throw new Error(
      'RN_SKIP_STUDIO_BUILD=true but no ZIP found via jobs API and RN_ZIP_DOWNLOAD_URL is not set'
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
   * 1) Trigger Studio RN build and poll for the new ZIP file id (outputObject.value).
   * 2) On failure, use latest NATIVE_MOBILE_ZIP from jobs API.
   * 3) On failure, download RN_ZIP_DOWNLOAD_URL (file-service URL or file id).
   */
  async prepareProject(outputBaseDir: string, profileName: string = 'development'): Promise<string> {
    log.separator('Studio RN ZIP Download & Extract');

    if (fs.existsSync(outputBaseDir)) {
      log.info(`Cleaning previous download at ${outputBaseDir}...`);
      fs.rmSync(outputBaseDir, { recursive: true, force: true });
    }
    fs.mkdirSync(outputBaseDir, { recursive: true });

    if (!this.authCookie) await this.login();

    if (shouldSkipStudioBuild()) {
      log.info('RN_SKIP_STUDIO_BUILD=true — skipping new Studio build');
      return this.prepareProjectFromExistingZip(outputBaseDir);
    }

    const maxAttempts = getRetryCount();
    let buildError: Error | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        if (attempt > 1) {
          log.warn(`Retrying Studio RN build (attempt ${attempt}/${maxAttempts})...`);
        }

        const downloadUrl = await this.buildNativeMobileApp(profileName);
        const artifacts = await this.downloadExtractAndFindRoot(outputBaseDir, downloadUrl);
        return artifacts.projectPath;
      } catch (error: any) {
        buildError = error instanceof Error ? error : new Error(String(error));
        log.error(`Studio RN build attempt ${attempt}/${maxAttempts} failed: ${buildError.message}`);

        if (isRetryableStudioBuildError(buildError) && attempt < maxAttempts) {
          log.warn(
            `Transient Studio error detected; waiting ${getRetryDelayMs() / 1000}s before retry...`
          );
          await sleep(getRetryDelayMs());
          continue;
        }
        break;
      }
    }

    log.warn('Studio RN build did not produce a ZIP; trying fallback sources...');

    try {
      const jobsZipUrl = await this.fetchLatestNativeZipDownloadUrl();
      if (jobsZipUrl) {
        log.warn('Fallback: downloading latest native ZIP from Studio jobs API');
        return (await this.downloadExtractAndFindRoot(outputBaseDir, jobsZipUrl)).projectPath;
      }
    } catch (error: any) {
      const message = error instanceof Error ? error.message : String(error);
      log.warn(`Jobs API fallback failed: ${message}`);
    }

    const fallbackZip = getFallbackZipDownloadUrl();
    if (fallbackZip) {
      const downloadUrl = this.resolveDownloadUrl(fallbackZip);
      log.warn(`Fallback: downloading configured RN_ZIP_DOWNLOAD_URL → ${downloadUrl}`);
      return (await this.downloadExtractAndFindRoot(outputBaseDir, downloadUrl)).projectPath;
    }

    throw buildError ?? new Error('Studio RN build failed and no fallback ZIP source configured');
  }

  private async downloadExtractAndFindRoot(
    outputBaseDir: string,
    downloadUrl: string
  ): Promise<RnProjectArtifacts> {
    const zipPath = await this.downloadProject(downloadUrl, outputBaseDir);
    const extractPath = path.join(outputBaseDir, 'rn-project');
    await this.extractZip(zipPath, extractPath);

    const projectPath = findRnProjectRoot(extractPath);
    log.success(`RN project ready at ${projectPath}`);
    log.info(`RN ZIP saved at ${zipPath}`);
    return { zipPath, projectPath, outputBaseDir, downloadUrl };
  }

  /**
   * Download RN ZIP from Studio, extract, and return both zip path and project root.
   * Same resolution order as prepareProject (build → jobs API → RN_ZIP_DOWNLOAD_URL).
   */
  async prepareProjectWithZip(
    outputBaseDir: string,
    profileName: string = 'development'
  ): Promise<RnProjectArtifacts> {
    const projectPath = await this.prepareProject(outputBaseDir, profileName);
    const zipName = `${this.config.projectId}-native-mobile.zip`;
    const zipPath = path.join(outputBaseDir, zipName);

    if (!fs.existsSync(zipPath)) {
      throw new Error(
        `RN ZIP not found at ${zipPath} after Studio download. Cannot run audit/snyk on ZIP.`
      );
    }

    return { zipPath, projectPath, outputBaseDir };
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

/** Default: always download a fresh RN ZIP from Studio. Set RN_DOWNLOAD_FROM_STUDIO=false to use src/rn-zips/. */
export function shouldDownloadRnProjectFromStudio(_projectPath: string): boolean {
  return process.env.RN_DOWNLOAD_FROM_STUDIO !== 'false';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
