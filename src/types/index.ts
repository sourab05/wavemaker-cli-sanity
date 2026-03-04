import { Browser } from 'webdriverio';
import { ChildProcess } from 'child_process';

export interface WMProjectConfig {
  projectId: string;
  username: string;
  password: string;
  environment: 'stage' | 'prod';
  outputDir: string;
  authCookie?: string;
}

export interface PreviewCLIConfig {
  projectId: string;
  baseFolder: string;
  auth: { username: string; password: string };
  loginUrl: string;
  syncTimeout: number;
  appStartTimeout: number;
  setupTimeout: number;
}

export interface AppConfig {
  projectPath: string;
  buildArtifactsDir: string;
  androidOutputFile: string;
  iosOutputFile: string;
  installTimeout: number;
  buildTimeout: number;
  appName: string;
  appPackage: string;
  appActivity: string;
  appVerificationId: string;
  androidEmulatorName: string;
  ANDROID_KEYSTORE_PATH?: string;
  ANDROID_STORE_PASSWORD?: string;
  ANDROID_KEY_ALIAS?: string;
  ANDROID_KEY_PASSWORD?: string;
  ANDROID_BUILD_TYPE?: string;
  IOS_P12_CERT_PATH?: string;
  IOS_PROVISION_PROFILE_PATH?: string;
  IOS_P12_PASSWORD?: string;
}

export interface MavenBuildResult {
  stdout: string;
  stderr: string;
  artifactPath?: string;
}

export interface AppiumCapabilities {
  platformName: string;
  'appium:deviceName': string;
  'appium:automationName': string;
  'appium:appPackage'?: string;
  'appium:appActivity'?: string;
  'appium:app'?: string;
  'appium:bundleId'?: string;
  'appium:platformVersion'?: string;
  'appium:autoGrantPermissions'?: boolean;
  'appium:autoAcceptAlerts'?: boolean;
  'appium:locationServicesEnabled'?: boolean;
  'appium:locationServicesAuthorized'?: boolean;
  [key: string]: any;
}

export interface BrowserStackOptions {
  projectName: string;
  buildName: string;
  deviceName: string;
  platformVersion: string;
  appiumVersion?: string;
}

export interface DriverSession {
  client: Browser;
  cleanup: () => Promise<void>;
}
