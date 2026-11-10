import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';
import { createLogger } from '../utils/Logger';

const log = createLogger('NativeBackendService');

function backendUrl(value: string): string {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Native backend must be an HTTP(S) URL without credentials, query or fragment');
  }
  return url.href.replace(/\/+$/, '');
}

/** Studio run deployments can expire while Gradle builds the APK. */
export async function ensureNativeBackendReady(
  projectPath: string,
  refreshDeployment: () => Promise<string>,
  { timeoutMs = 180000, pollIntervalMs = 2000 } = {}
): Promise<void> {
  const config = JSON.parse(fs.readFileSync(path.join(projectPath, 'wm_rn_config.json'), 'utf8'));
  if (!config.serverPath || config.serverPath === 'http://NOSERVERREQUIRED.com') {
    log.info('Native project is serverless; no deployment refresh required');
    return;
  }
  const embeddedUrl = backendUrl(config.serverPath);
  log.info('Refreshing Studio deployment before native app verification...');
  const deployedUrl = backendUrl(await refreshDeployment());
  if (deployedUrl !== embeddedUrl) {
    throw new Error(
      'Refreshed Studio deployment does not match the backend embedded in the native app; ' +
      'regenerate the native project instead of verifying against a different backend'
    );
  }

  const deadline = Date.now() + timeoutMs;
  let lastError = 'startup endpoints were not ready';
  while (Date.now() < deadline) {
    let ready = true;
    for (const endpoint of ['application/wmProperties.js', 'security/info']) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) { ready = false; break; }
      try {
        // Probe as the fresh device will: no Studio cookie and no login redirects.
        const response = await axios.get(`${embeddedUrl}/services/${endpoint}`, {
          timeout: Math.min(10000, remaining),
          maxRedirects: 0,
          responseType: 'text',
          validateStatus: () => true,
        });
        const data = String(response.data);
        let valid = response.status === 200;
        if (endpoint === 'security/info') {
          let security: any;
          try { security = JSON.parse(data); } catch { /* Not a security-info response. */ }
          valid = valid && security !== null && typeof security === 'object' &&
            typeof security.securityEnabled === 'boolean';
        } else {
          valid = valid && !/^\s*</.test(data) && /\bhomePage\b/.test(data);
        }
        if (!valid) {
          ready = false;
          lastError = `${endpoint}: HTTP ${response.status}, invalid startup response`;
        }
      } catch (error: any) {
        ready = false;
        // Do not include response bodies or Axios request configuration in reports.
        lastError = `${endpoint}: ${error.code || 'request failed'}`;
      }
    }
    if (ready) {
      log.success('Embedded native backend is ready for unauthenticated device startup');
      return;
    }
    const remaining = deadline - Date.now();
    if (remaining > 0) await new Promise(resolve => setTimeout(resolve, Math.min(pollIntervalMs, remaining)));
  }
  throw new Error(`Native backend was not ready within ${timeoutMs}ms. ${lastError}`);
}
