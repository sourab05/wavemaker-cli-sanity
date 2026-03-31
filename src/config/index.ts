import * as path from 'path';
import * as os from 'os';

export type { WMProjectConfig, PreviewCLIConfig, AppConfig } from '../types';

import type { WMProjectConfig, PreviewCLIConfig, AppConfig } from '../types';

export function getWMProjectConfig(): WMProjectConfig {
  const projectId = process.env.WM_PROJECT_ID;
  const username = process.env.WM_USERNAME;
  const password = process.env.WM_PASSWORD;

  if (!projectId || !username || !password) {
    throw new Error(
      'Missing required env vars: WM_PROJECT_ID, WM_USERNAME, WM_PASSWORD. Set them in .env'
    );
  }

  return {
    projectId,
    username,
    password,
    environment: (process.env.WM_ENVIRONMENT as 'stage' | 'prod') || 'stage',
    outputDir: path.resolve(__dirname, '..', '..', 'downloaded-projects'),
  };
}

export function getPreviewCLIConfig(): PreviewCLIConfig {
  const username = process.env.WMO_USER || process.env.WM_USERNAME;
  const password = process.env.WMO_PASS || process.env.WM_PASSWORD;

  if (!username || !password) {
    throw new Error(
      'Missing required env vars: WMO_USER/WM_USERNAME, WMO_PASS/WM_PASSWORD. Set them in .env'
    );
  }

  return {
    projectId:
      process.env.PROJECT_ID ||
      process.env.WM_PROJECT_ID ||
      'WMPRJ2c91808598ab1fa50198ae14a1aa0005',
    baseFolder: path.join(os.homedir(), '.wm-reactnative-cli', 'wm-projects'),
    auth: { username, password },
    loginUrl:
      process.env.LOGIN_URL || 'https://stage-studio.wavemakeronline.com/login/authenticate',
    syncTimeout: parseInt(process.env.SYNC_TIMEOUT || '300000', 10),
    appStartTimeout: parseInt(process.env.APP_START_TIMEOUT || '150000', 10),
    setupTimeout: 60 * 1000,
  };
}

export function getPreviewUrl(projectId: string): string {
  const base = process.env.STUDIO_URL || 'https://stage-studio.wavemakeronline.com';
  return `${base}/studio/services/projects/${projectId}/deployment/inplaceDeploy`;
}

export function getAppConfig(): AppConfig {
  return {
    projectPath: path.resolve(
      __dirname,
      '..',
      'rn-zips',
      process.env.RN_PROJECT_FOLDER || 'CliSanity-native-mobile_0.0.1'
    ),
    buildArtifactsDir: path.resolve(__dirname, '..', '..', 'Artifacts'),
    androidOutputFile: '',
    iosOutputFile: path.resolve(__dirname, '..', '..', 'Artifacts', 'output/ios/app-debug.ipa'),
    appName: process.env.APP_NAME || 'CliApp',
    appPackage: process.env.APP_PACKAGE || 'com.cliapp',
    appActivity: process.env.APP_ACTIVITY || '.MainActivity',
    appVerificationId: process.env.APP_VERIFICATION_ID || '~mobile_navbar1_title',
    androidEmulatorName: process.env.ANDROID_EMULATOR_NAME || 'Pixel8',
    installTimeout: parseInt(process.env.INSTALL_TIMEOUT || '300000', 10),
    buildTimeout: parseInt(process.env.BUILD_TIMEOUT || '2700000', 10),
    ANDROID_KEYSTORE_PATH: process.env.ANDROID_KEYSTORE_PATH,
    ANDROID_STORE_PASSWORD: process.env.ANDROID_STORE_PASSWORD,
    ANDROID_KEY_ALIAS: process.env.ANDROID_KEY_ALIAS,
    ANDROID_KEY_PASSWORD: process.env.ANDROID_KEY_PASSWORD,
    ANDROID_BUILD_TYPE: process.env.ANDROID_BUILD_TYPE || 'debug',
    IOS_P12_CERT_PATH: process.env.IOS_P12_CERT_PATH,
    IOS_PROVISION_PROFILE_PATH: process.env.IOS_PROVISION_PROFILE_PATH,
    IOS_P12_PASSWORD: process.env.IOS_P12_PASSWORD,
  };
}
