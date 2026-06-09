import { execFileSync } from 'child_process';
import * as fs from 'fs';
import { createLogger } from '../utils/Logger';

const log = createLogger('BrowserStackService');

const UPLOAD_URL = 'https://api-cloud.browserstack.com/app-automate/upload';

export interface BrowserStackCredentials {
  username: string;
  accessKey: string;
}

/** Upload a local APK/IPA to BrowserStack and return bs:// app_url. */
export async function resolveBrowserStackAppUrl(
  appPath: string,
  credentials: BrowserStackCredentials
): Promise<string> {
  if (appPath.startsWith('bs://')) {
    return appPath;
  }

  if (!fs.existsSync(appPath)) {
    throw new Error(`App file not found for BrowserStack upload: ${appPath}`);
  }

  const fileSizeMb = (fs.statSync(appPath).size / 1024 / 1024).toFixed(2);
  log.info(`Uploading app to BrowserStack (${fileSizeMb} MB): ${appPath}`);

  const args = [
    '-sS',
    '-u',
    `${credentials.username}:${credentials.accessKey}`,
    '-X',
    'POST',
    UPLOAD_URL,
    '-F',
    `file=@${appPath}`,
  ];

  const customId = process.env.BROWSERSTACK_APP_CUSTOM_ID?.trim();
  if (customId) {
    args.push('-F', `custom_id=${customId}`);
  }

  const output = execFileSync('curl', args, {
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
  });

  let parsed: { app_url?: string; error?: string };
  try {
    parsed = JSON.parse(output) as { app_url?: string; error?: string };
  } catch {
    throw new Error(`BrowserStack upload returned non-JSON response: ${output.slice(0, 500)}`);
  }

  if (!parsed.app_url) {
    throw new Error(`BrowserStack upload failed: ${output}`);
  }

  log.success(`App uploaded to BrowserStack: ${parsed.app_url}`);
  return parsed.app_url;
}
