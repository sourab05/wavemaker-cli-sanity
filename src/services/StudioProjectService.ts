import axios, { AxiosInstance } from 'axios';
import { AuthService } from './AuthService';
import { createLogger } from '../utils/Logger';
import {
  deriveAppPackage,
  deriveRnProjectFolder,
  generateStudioProjectName,
  type ProvisionedProjectEnv,
} from '../utils/studio-project-env';

const log = createLogger('StudioProjectService');

export interface CreateProjectResult extends ProvisionedProjectEnv {
  rawResponse: unknown;
}

interface CreateProjectPayload {
  name: string;
  displayName: string;
  template: string;
  platformVersion: string;
  platformType: string;
  projectType: string;
  projectShell: { name: string; displayName: string };
}

function extractAuthCookieValue(authCookie: string): string {
  const idx = authCookie.indexOf('=');
  return idx >= 0 ? authCookie.slice(idx + 1).trim() : authCookie.trim();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function collectStringValues(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') {
    out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStringValues(item, out);
    return out;
  }
  if (value && typeof value === 'object') {
    for (const v of Object.values(value as Record<string, unknown>)) {
      collectStringValues(v, out);
    }
  }
  return out;
}

function pickWmpProjectId(data: unknown): string | undefined {
  const values = collectStringValues(data);
  return values.find((v) => /^WMPRJ[a-f0-9]+$/i.test(v));
}

function pickStudioProjectId(data: unknown): string | undefined {
  const values = collectStringValues(data);
  return values.find((v) => /^proj-[a-zA-Z0-9-]+$/i.test(v));
}

function pickPlatformVersion(data: unknown): string | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const obj = data as Record<string, unknown>;
  for (const key of ['platformVersion', 'defaultPlatformVersion', 'version']) {
    const v = obj[key];
    if (typeof v === 'string' && /^\d+\.\d+/.test(v)) return v;
  }
  for (const v of Object.values(obj)) {
    const nested = pickPlatformVersion(v);
    if (nested) return nested;
  }
  return undefined;
}

function pickFlowId(data: unknown): number | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const obj = data as Record<string, unknown>;
  for (const key of ['flowId', 'id', 'journeyId']) {
    const v = obj[key];
    if (typeof v === 'number' && v > 0) return v;
    if (typeof v === 'string' && /^\d+$/.test(v)) return parseInt(v, 10);
  }
  for (const v of Object.values(obj)) {
    const nested = pickFlowId(v);
    if (nested) return nested;
  }
  return undefined;
}

function projectDefaults(baseUrl: string): Omit<CreateProjectPayload, 'name' | 'displayName'> {
  const isAi = /platform\.wavemaker\.ai/i.test(baseUrl);
  return {
    template: 'PRISM',
    platformVersion: isAi ? '1.0.0' : '11.11.4',
    platformType: 'NATIVE_MOBILE',
    projectType: 'APPLICATION',
    projectShell: { name: 'Default Project', displayName: 'Default Project' },
  };
}

export class StudioProjectService {
  private readonly baseUrl: string;
  private readonly http: AxiosInstance;
  private authCookieValue = '';

  constructor(baseUrl: string, authCookie: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.authCookieValue = extractAuthCookieValue(authCookie);
    this.http = axios.create({
      baseURL: `${this.baseUrl}/projects/services`,
      headers: {
        Accept: 'application/json, text/plain, */*',
        'Content-Type': 'application/json',
        Cookie: `auth_cookie=${this.authCookieValue}`,
        Origin: this.baseUrl,
        Referer: `${this.baseUrl}/projects/`,
        'x-requested-with': 'XMLHttpRequest',
      },
      validateStatus: (status) => status >= 200 && status < 500,
    });
  }

  static async createNewProjectFromEnv(): Promise<CreateProjectResult> {
    const baseUrl = (
      process.env.STUDIO_BASE_URL ||
      process.env.STUDIO_URL ||
      'https://stage-studio.wavemakeronline.com'
    ).replace(/\/$/, '');

    const username =
      process.env.STUDIO_USERNAME || process.env.WM_USERNAME || process.env.WMO_USER;
    const password =
      process.env.STUDIO_PASSWORD || process.env.WM_PASSWORD || process.env.WMO_PASS;

    if (!username || !password) {
      throw new Error('WM_USERNAME and WM_PASSWORD are required to create a Studio project');
    }

    const authService = new AuthService(baseUrl);
    const authCookie = await authService.login(username, password);
    const service = new StudioProjectService(baseUrl, authCookie);

    const projectName = generateStudioProjectName();
    log.info(`Creating NATIVE_MOBILE project "${projectName}" on ${baseUrl}...`);
    return service.createNativeMobileProject(projectName);
  }

  async runOnboardingPreflight(): Promise<number> {
    log.info('Running Studio onboarding preflight...');

    const journeyRes = await this.http.get('/onboardingFlow/developerOnboardingJourney');
    if (journeyRes.status >= 400) {
      log.warn(`developerOnboardingJourney returned HTTP ${journeyRes.status} — continuing`);
    }

    const flowId = pickFlowId(journeyRes.data) ?? 5;
    log.info(`Using onboarding flowId=${flowId}`);

    await this.http.get('/onboardingFlow/journeyDetailsById', { params: { flowId } });
    await this.http.get('/onboardingFlow/journeyDetailsById', {
      params: { flowId, previousStepId: 4 },
    });

    return flowId;
  }

  async createNativeMobileProject(projectName: string): Promise<CreateProjectResult> {
    let platformVersion = projectDefaults(this.baseUrl).platformVersion;

    try {
      const flowId = await this.runOnboardingPreflight();
      const details = await this.http.get('/onboardingFlow/journeyDetailsById', {
        params: { flowId },
      });
      platformVersion = pickPlatformVersion(details.data) || platformVersion;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      log.warn(`Onboarding preflight skipped or failed: ${message}`);
    }

    const defaults = projectDefaults(this.baseUrl);
    const payload: CreateProjectPayload = {
      name: projectName,
      displayName: projectName,
      template: defaults.template,
      platformVersion,
      platformType: defaults.platformType,
      projectType: defaults.projectType,
      projectShell: defaults.projectShell,
    };

    log.info(
      `POST postCreateProject template=${payload.template} platform=${payload.platformType} version=${payload.platformVersion}`
    );

    const createRes = await this.http.post(
      '/manageProjectsListing/postCreateProject',
      payload
    );

    if (createRes.status >= 400) {
      const body =
        typeof createRes.data === 'string'
          ? createRes.data
          : JSON.stringify(createRes.data).slice(0, 500);
      throw new Error(`postCreateProject failed (HTTP ${createRes.status}): ${body}`);
    }

    let wmProjectId = pickWmpProjectId(createRes.data);
    let studioProjectId = pickStudioProjectId(createRes.data);

    if (!wmProjectId || !studioProjectId) {
      log.info('Resolving project IDs from projects listing...');
      const resolved = await this.resolveProjectIdsFromListing(projectName, wmProjectId);
      wmProjectId = wmProjectId || resolved.wmProjectId;
      studioProjectId = studioProjectId || resolved.studioProjectId;
    }

    if (!wmProjectId) {
      throw new Error(
        `Could not resolve WMPRJ project id after create. Response: ${JSON.stringify(createRes.data).slice(0, 400)}`
      );
    }
    if (!studioProjectId) {
      throw new Error(
        `Could not resolve proj-xxx studio project id for ${wmProjectId}. ` +
          'Jobs API polling requires STUDIO_PROJECT_ID — check Studio listing API access.'
      );
    }

    const appName = projectName;
    const result: CreateProjectResult = {
      wmProjectId,
      studioProjectId,
      projectName,
      appName,
      appPackage: deriveAppPackage(projectName),
      rnProjectFolder: deriveRnProjectFolder(appName),
      rawResponse: createRes.data,
    };

    log.success(
      `Project created: ${result.wmProjectId} (studio ${result.studioProjectId}) name=${result.appName}`
    );
    return result;
  }

  private async resolveProjectIdsFromListing(
    projectName: string,
    knownWmpId?: string
  ): Promise<{ wmProjectId?: string; studioProjectId?: string }> {
    const deadline = Date.now() + 120_000;
    let lastError: Error | undefined;

    while (Date.now() < deadline) {
      try {
        const match = await this.findProjectInListing(projectName, knownWmpId);
        if (match.wmProjectId && match.studioProjectId) return match;
        if (match.wmProjectId && knownWmpId && match.wmProjectId === knownWmpId) {
          return match;
        }
      } catch (error: unknown) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }
      log.info('Waiting for new project to appear in listing...');
      await sleep(5000);
    }

    throw lastError ?? new Error(`Timed out waiting for project "${projectName}" in listing`);
  }

  private async findProjectInListing(
    projectName: string,
    knownWmpId?: string
  ): Promise<{ wmProjectId?: string; studioProjectId?: string }> {
    const listEndpoints = [
      '/manageProjectsListing/getRecentProjects',
      '/manageProjectsListing/getProjectsList',
      '/manageProjectsListing/getAllProjects',
    ];

    for (const endpoint of listEndpoints) {
      try {
        const res = await this.http.get(endpoint);
        if (res.status >= 400) continue;
        const match = this.matchProjectInTree(res.data, projectName, knownWmpId);
        if (match.wmProjectId) return match;
      } catch {
        // try next endpoint
      }
    }

    return {};
  }

  private matchProjectInTree(
    data: unknown,
    projectName: string,
    knownWmpId?: string
  ): { wmProjectId?: string; studioProjectId?: string } {
    const items = this.flattenProjectRecords(data);
    const normalizedName = projectName.toLowerCase();

    for (const item of items) {
      const name = String(item.name || item.displayName || item.projectName || '').toLowerCase();
      const wmId = String(
        item.projectId || item.wmProjectId || item.wmpProjectId || item.WMPRJ || ''
      );
      const studioId = String(item.id || item.studioProjectId || item.projectStudioId || '');

      const wmpMatch =
        (knownWmpId && wmId === knownWmpId) ||
        (name && name === normalizedName) ||
        pickWmpProjectId(item);

      if (!wmpMatch && !pickWmpProjectId(item)) continue;

      const wmProjectId = /^WMPRJ/i.test(wmId) ? wmId : pickWmpProjectId(item);
      const studioProjectId = /^proj-/i.test(studioId) ? studioId : pickStudioProjectId(item);

      if (wmProjectId) {
        return { wmProjectId, studioProjectId };
      }
    }

    return {};
  }

  private flattenProjectRecords(data: unknown): Record<string, unknown>[] {
    if (!data) return [];
    if (Array.isArray(data)) {
      return data.filter((x) => x && typeof x === 'object') as Record<string, unknown>[];
    }
    if (typeof data !== 'object') return [];

    const obj = data as Record<string, unknown>;
    for (const key of ['result', 'projects', 'content', 'data', 'items']) {
      const val = obj[key];
      if (Array.isArray(val)) {
        return val.filter((x) => x && typeof x === 'object') as Record<string, unknown>[];
      }
    }

    const values = Object.values(obj);
    if (values.every((v) => v && typeof v === 'object' && !Array.isArray(v))) {
      return values as Record<string, unknown>[];
    }

    return [obj];
  }
}
