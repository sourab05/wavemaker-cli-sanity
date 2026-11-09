import { createHash } from 'crypto';

export interface ProvisioningContext {
  studioUrl: string;
  accountKey: string;
}

export function normalizeStudioUrl(value: string): string {
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new Error('Invalid Studio URL'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Studio URL must be HTTP(S), without credentials, query or fragment');
  }
  return url.toString().replace(/\/+$/, '');
}

/** Mutates only the supplied process environment, never persisted Jenkins credentials. */
export function applyNewProjectOverrides(env: NodeJS.ProcessEnv = process.env): void {
  if (env.PROJECT_MODE !== 'New Project') return;
  const url = normalizeStudioUrl(env.NEW_PROJECT_STUDIO_URL?.trim() ||
    env.STUDIO_BASE_URL || env.STUDIO_URL || 'https://stage-studio.wavemakeronline.com');
  const username = env.NEW_PROJECT_USERNAME?.trim() ||
    env.WM_USERNAME || env.WMO_USER || env.STUDIO_USERNAME;
  const password = env.NEW_PROJECT_PASSWORD || env.WM_PASSWORD || env.WMO_PASS || env.STUDIO_PASSWORD;
  if (username) for (const key of ['WM_USERNAME', 'WMO_USER', 'STUDIO_USERNAME']) env[key] = username;
  if (password) for (const key of ['WM_PASSWORD', 'WMO_PASS', 'STUDIO_PASSWORD']) env[key] = password;
  env.STUDIO_URL = env.STUDIO_BASE_URL = url;
  env.LOGIN_URL = `${url}/login/authenticate`;
  // An old ZIP/build shortcut must not silently replace the newly provisioned app.
  env.RN_ZIP_DOWNLOAD_URL = '';
  env.RN_SKIP_STUDIO_BUILD = 'false';
  env.RN_DOWNLOAD_FROM_STUDIO = 'true';
}

export function getProvisioningContext(env: NodeJS.ProcessEnv = process.env): ProvisioningContext {
  const effective: NodeJS.ProcessEnv = { ...env, PROJECT_MODE: 'New Project' };
  applyNewProjectOverrides(effective);
  if (!effective.WM_USERNAME || !effective.WM_PASSWORD) {
    throw new Error('New Project requires a Studio username and password (overrides or defaults)');
  }
  return {
    studioUrl: effective.STUDIO_URL!,
    accountKey: createHash('sha256').update(effective.WM_USERNAME).digest('hex'),
  };
}

export function sameProvisioningContext(
  saved: ProvisioningContext | undefined, current: ProvisioningContext
): boolean {
  return Boolean(saved && saved.studioUrl === current.studioUrl && saved.accountKey === current.accountKey);
}
