import { execSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { Browser } from 'webdriverio';
import dotenv from 'dotenv';
import { getAppConfig } from '../../src/config';
import { DriverFactory } from '../../src/helpers/DriverFactory';
import { NativeAppPage } from '../../src/pages/NativeApp.page';
import { runCommand } from '../../src/utils/run-command';
import { createLogger } from '../../src/utils/Logger';
import { AppiumCapabilities, BrowserStackOptions } from '../../src/types';
import { getPackageManagers, PackageManagerCommands } from '../../src/utils/package-manager';
import { getCliVariant } from '../../src/utils/cli-variant';
import { EmulatorService } from '../../src/services/EmulatorService';
import { AppiumService } from '../../src/services/AppiumService';
import { RnProjectManager, shouldDownloadRnProjectFromStudio } from '../../src/services/RnProjectManager';
import { resolveBrowserStackAppUrl } from '../../src/services/BrowserStackService';
import { ensureNpmRegistry } from '../../src/utils/npm-registry';

dotenv.config();

const packageManagers = getPackageManagers();
const isRunLocal = process.env.RUN_LOCAL !== 'false';
const variant = getCliVariant();

function shouldVerifyOnBrowserStack(): boolean {
  if (isRunLocal) return false;
  if (process.env.SKIP_BROWSERSTACK_VERIFY === 'true') return false;
  const username = process.env.BROWSERSTACK_USERNAME?.trim();
  const accessKey = process.env.BROWSERSTACK_ACCESS_KEY?.trim();
  return Boolean(username && accessKey && username !== 'your_browserstack_username');
}

packageManagers.forEach((pm) => {
  const cmd = new PackageManagerCommands(pm);
  const log = createLogger(`AppBuildSpec[${cmd.label}]`);

  describe(`[${cmd.label}] React Native Project Build and Run`, function () {
    let config: ReturnType<typeof getAppConfig>;
    let emulatorService: EmulatorService;
    let appiumService: AppiumService;

    let setupDone = false;
    let setupError: Error | null = null;

    async function ensureSetup() {
      if (setupDone) return;
      if (setupError) throw setupError;
      try {
        config = getAppConfig();

        log.separator(`React Native Build & Run Test Suite (${cmd.label})`);
        log.info(`Project path: ${config.projectPath}`);
        log.info(`Build artifacts: ${config.buildArtifactsDir}`);
        log.info(`Package Manager: ${cmd.label}`);
        log.info(`Run Local: ${isRunLocal}`);

        let step = 1;
        const totalSteps = isRunLocal ? 7 : 5;

        if (isRunLocal) {
          log.step(step++, totalSteps, 'Ensuring Android emulator is running...');
          emulatorService = new EmulatorService(config.androidEmulatorName);
          await emulatorService.ensureRunning();

          log.step(step++, totalSteps, 'Starting Appium server...');
          appiumService = new AppiumService();
          await appiumService.start();
        } else {
          log.info('CI mode (RUN_LOCAL=false): skipping emulator/Appium setup, will use BrowserStack');
        }

        log.step(step++, totalSteps, 'Cleaning build artifacts directory...');
        if (fs.existsSync(config.buildArtifactsDir)) {
          fs.rmSync(config.buildArtifactsDir, { recursive: true, force: true });
        }
        fs.mkdirSync(config.buildArtifactsDir, { recursive: true });

        if (shouldDownloadRnProjectFromStudio(config.projectPath)) {
          log.step(step++, totalSteps, 'Downloading RN ZIP from Studio and extracting project...');
          const rnManager = RnProjectManager.fromEnv();
          const profileName = process.env.RN_BUILD_PROFILE || 'development';
          const outputBaseDir = path.join(path.dirname(config.projectPath), '.studio-download');
          const downloadedProjectPath = await rnManager.prepareProject(outputBaseDir, profileName);
          config.projectPath = downloadedProjectPath;
          log.info(`Using Studio RN project at: ${config.projectPath}`);
          syncAppConfigFromProject(config.projectPath, config, log);
        } else {
          log.info(`Using existing RN project at: ${config.projectPath}`);
        }

        log.step(step++, totalSteps, 'Ensuring wm_rn_config.json exists...');
        const rnConfigPath = path.join(config.projectPath, 'wm_rn_config.json');
        if (!fs.existsSync(config.projectPath)) {
          throw new Error(`RN project directory not found: ${config.projectPath}`);
        }
        if (!fs.existsSync(rnConfigPath)) {
          const rnConfig = {
            appName: config.appName,
            version: '1.0.0',
            buildNumber: '1',
            bundleId: config.appPackage,
          };
          fs.writeFileSync(rnConfigPath, JSON.stringify(rnConfig, null, 2));
          log.info('Created wm_rn_config.json');
        }

        const removed = cmd.cleanForInstall(config.projectPath);
        if (removed.length) log.info(`Cleaned for ${cmd.label}: removed ${removed.join(', ')}`);

        ensureNpmRegistry(config.projectPath);
        log.info('Configured npm registry, then installing dependencies');

        const installCmd = cmd.install();
        log.step(step++, totalSteps, `Installing project dependencies (${installCmd})...`);
        try {
          await runCommand(installCmd, {
            cwd: config.projectPath,
            timeout: config.installTimeout,
            onData: (text, child) => {
              if (
                text.includes('Would you like to eject the expo project') ||
                text.includes('Would you like to empty the dest folder')
              ) {
                child.stdin?.write('yes\n');
              }
              if (text.includes('Use port 8082 instead?') || text.includes('Use port 8081 instead?')) {
                child.stdin?.write('y\n');
              }
            },
          });
          log.success('Dependencies installed');
        } catch (error: any) {
          log.error(`Failed to install dependencies: ${error.message}`);
          throw error;
        }

        if (cmd.type === 'yarn') {
          const cliBin = path.join(config.projectPath, 'node_modules', '.bin', variant.binaryName);
          if (!fs.existsSync(cliBin)) {
            log.step(step++, totalSteps, `Installing CLI in project (yarn add --dev ${variant.packageName})...`);
            await runCommand(`yarn add --dev ${variant.packageName}`, {
              cwd: config.projectPath, timeout: config.installTimeout,
            });
            log.success('CLI installed (binary now in node_modules/.bin)');

            try {
              log.step(step, totalSteps, `Overlaying with local linked version (yarn link ${variant.packageName})...`);
              await runCommand(`yarn link ${variant.packageName}`, {
                cwd: config.projectPath, timeout: 60000,
              });
              log.success('CLI overridden with locally linked branch');
            } catch {
              log.info('No local link registered, using npm registry version');
            }
          }
        }

        setupDone = true;
      } catch (err: any) {
        setupError = err;
        log.error(`Setup failed: ${err.message}`);
        if (err.response?.status) {
          log.error(`HTTP ${err.response.status}: ${JSON.stringify(err.response.data)}`);
        }
        throw err;
      }
    }

    it('should build the Android APK successfully', async function () {
      await ensureSetup();
      this.timeout(config.buildTimeout + 5 * 60 * 1000);

      const buildCmd = cmd.cliBinary(`build android "${config.projectPath}" --dest="${config.buildArtifactsDir}" --auto-eject=true`);
      log.info(`Build command: ${buildCmd}`);
      log.info(`ANDROID_HOME=${process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || 'not set'}`);
      log.info(`JAVA_HOME=${process.env.JAVA_HOME || 'not set'}`);

      try {
        await runCommand(buildCmd, {
          cwd: config.projectPath,
          timeout: config.buildTimeout,
          onData: (text, child) => {
            ensureAndroidLocalProperties(config.projectPath, log);
            if (
              text.includes('Would you like to eject the expo project') ||
              text.includes('Would you like to empty the dest folder')
            ) {
              child.stdin?.write('yes\n');
            }
            if (text.includes('Use port 8082 instead?') || text.includes('Use port 8081 instead?')) {
              child.stdin?.write('y\n');
            }
          },
        });

        config.androidOutputFile = findAndroidApk(config.buildArtifactsDir);
        log.success(`APK built: ${config.androidOutputFile}`);
      } catch (error: any) {
        log.error(`APK build failed: ${error.message}`);
        logCliBuildLogs(config.buildArtifactsDir, log);
        throw error;
      }
    });

    it('should install and verify the Android app', async function () {
      this.timeout(shouldVerifyOnBrowserStack() ? 45 * 60 * 1000 : 20 * 60 * 1000);
      await ensureSetup();

      if (!config.androidOutputFile) {
        log.warn('Skipping: APK not available (previous build may have failed)');
        this.skip();
      }

      if (!isRunLocal && !shouldVerifyOnBrowserStack()) {
        log.warn('Skipping BrowserStack Android verification (SKIP_BROWSERSTACK_VERIFY or missing creds)');
        this.skip();
      }

      const { appPackage, appActivity, appVerificationId } = config;
      const apkPath = config.androidOutputFile;
      let client: Browser | undefined;

      try {
        if (isRunLocal) {
          log.step(1, 3, 'Waiting for device to be ready and installing APK...');
          try {
            execSync('adb wait-for-device shell "while [[ -z $(getprop sys.boot_completed) ]]; do sleep 1; done"', {
              stdio: 'inherit',
              timeout: 120000,
            });
            log.info('Device fully booted, installing APK...');
            execSync(`adb install -r "${apkPath}"`, { stdio: 'inherit' });
            log.success('APK installed');
          } catch {
            throw new Error(`Failed to install APK: ${apkPath}`);
          }

          log.step(2, 3, 'Creating local Appium session...');
          const platformName = process.env.PLATFORM_NAME || 'android';
          const deviceName = process.env.LOCAL_DEVICE_NAME || emulatorService.getConnectedDevices()[0] || 'emulator-5554';
          const automationName = platformName === 'android' ? 'UiAutomator2' : 'XCUITest';

          const capabilities: AppiumCapabilities = {
            platformName,
            'appium:deviceName': deviceName,
            'appium:automationName': automationName,
            'appium:app': apkPath,
            'appium:autoGrantPermissions': true,
            'appium:locationServicesEnabled': true,
            'appium:locationServicesAuthorized': true,
          };

          if (process.env.LOCAL_PLATFORM_VERSION) {
            capabilities['appium:platformVersion'] = process.env.LOCAL_PLATFORM_VERSION;
          }
          if (appPackage) capabilities['appium:appPackage'] = appPackage;
          if (appActivity) capabilities['appium:appActivity'] = appActivity;

          client = await DriverFactory.createAppiumSession(capabilities);

          log.step(3, 3, 'Verifying app via accessibility ID...');
          const nativeApp = new NativeAppPage(client, appVerificationId);
          await nativeApp.verifyAfterActivation(appPackage);

          log.success('Android app verified on emulator');
        } else {
          await verifyAndroidOnBrowserStack(config, apkPath, log);
        }
      } catch (error: any) {
        const target = isRunLocal ? 'emulator' : 'BrowserStack';
        if (!isRunLocal && process.env.BROWSERSTACK_VERIFY_SOFT_FAIL === 'true') {
          log.warn(`Android ${target} verification failed (soft fail): ${error.message}`);
          if (client) await DriverFactory.takeScreenshot(client, `android-${target}-failure-${pm}`);
          return;
        }
        log.error(`Android ${target} verification failed: ${error.message}`);
        if (client) await DriverFactory.takeScreenshot(client, `android-${target}-failure-${pm}`);
        throw error;
      } finally {
        await DriverFactory.closeSession(client);
      }
    });

    it('should build the iOS IPA successfully', async function () {
      await ensureSetup();
      this.timeout(config.buildTimeout + 5 * 60 * 1000);

      if (os.platform() !== 'darwin') {
        log.info('Skipping IPA build (not on macOS)');
        this.skip();
      }

      const { IOS_P12_CERT_PATH, IOS_PROVISION_PROFILE_PATH, IOS_P12_PASSWORD } = config;

      if (!IOS_P12_CERT_PATH || !IOS_PROVISION_PROFILE_PATH || !IOS_P12_PASSWORD) {
        log.info('Skipping IPA build (missing iOS certificates/provisioning profiles)');
        this.skip();
      }

      const iosDestDir = path.join(config.buildArtifactsDir, 'ios-workspace');
      const buildCmd = cmd.cliBinary([
        `build ios "${config.projectPath}"`,
        `--dest="${iosDestDir}"`,
        `--iCertificate="${IOS_P12_CERT_PATH}"`,
        `--iCertificatePassword="${IOS_P12_PASSWORD}"`,
        `--iProvisioningFile="${IOS_PROVISION_PROFILE_PATH}"`,
        `--auto-eject=true`,
      ].join(' '));

      log.info(`IPA build command: ${buildCmd}`);

      try {
        await runCommand(buildCmd, {
          cwd: config.projectPath,
          timeout: config.buildTimeout,
          successMessage: 'ios BUILD SUCCEEDED',
          onData: (text, child) => {
            if (
              text.includes('Would you like to eject the expo project') ||
              text.includes('Would you like to empty the dest folder')
            ) {
              child.stdin?.write('yes\n');
            }
            if (text.includes('Use port 8082 instead?') || text.includes('Use port 8081 instead?')) {
              child.stdin?.write('y\n');
            }
          },
        });

        const iosOutputDir = path.join(iosDestDir, 'output/ios');
        if (!fs.existsSync(iosOutputDir)) {
          throw new Error('iOS output directory not found after build');
        }
        const ipaFiles = fs.readdirSync(iosOutputDir).filter((f) => f.endsWith('.ipa'));
        if (ipaFiles.length === 0) {
          throw new Error('Build completed but no IPA file was found');
        }
        config.iosOutputFile = path.join(iosOutputDir, ipaFiles[0]);
        log.success(`IPA built: ${config.iosOutputFile}`);

        if (shouldVerifyOnBrowserStack()) {
          await verifyOnBrowserStack(config, log);
        } else if (!isRunLocal) {
          log.warn('Skipping BrowserStack iOS verification (SKIP_BROWSERSTACK_VERIFY or missing creds)');
        }
      } catch (error: any) {
        log.error(`IPA build failed: ${error.message}`);
        throw error;
      }
    });

    after(function () {
      if (isRunLocal) {
        if (appiumService?.isRunning()) {
          appiumService.stop();
        }
        emulatorService?.shutdown();
      }
      log.separator(`Build & Run Tests Complete (${cmd.label})`);
    });
  });
});

function findAndroidApk(artifactsDir: string): string {
  const cliOutputDir = path.join(artifactsDir, 'output', 'android');
  if (fs.existsSync(cliOutputDir)) {
    const apks = fs.readdirSync(cliOutputDir).filter((f) => f.endsWith('.apk'));
    if (apks.length) {
      return path.join(cliOutputDir, apks[0]);
    }
  }

  const gradleApkRoot = path.join(artifactsDir, 'android', 'app', 'build', 'outputs', 'apk');
  const gradleApk = findNewestFileUnder(gradleApkRoot, '.apk');
  if (gradleApk) {
    return gradleApk;
  }

  throw new Error(
    `No APK found under ${cliOutputDir} or ${gradleApkRoot}. ` +
      'The CLI may have been stopped before copying the artifact to output/android.'
  );
}

function findNewestFileUnder(dir: string, extension: string): string | undefined {
  if (!fs.existsSync(dir)) return undefined;

  let newest: { path: string; mtime: number } | undefined;

  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.name.endsWith(extension)) {
        const mtime = fs.statSync(fullPath).mtimeMs;
        if (!newest || mtime > newest.mtime) {
          newest = { path: fullPath, mtime };
        }
      }
    }
  };

  walk(dir);
  return newest?.path;
}

function ensureAndroidLocalProperties(
  projectPath: string,
  log: ReturnType<typeof createLogger>
): void {
  const androidHome = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  if (!androidHome) return;

  const androidDir = path.join(projectPath, 'android');
  if (!fs.existsSync(androidDir)) return;

  const propsPath = path.join(androidDir, 'local.properties');
  const sdkDir = androidHome.replace(/\\/g, '/');
  const content = `sdk.dir=${sdkDir}\n`;
  if (!fs.existsSync(propsPath) || !fs.readFileSync(propsPath, 'utf8').includes(sdkDir)) {
    fs.writeFileSync(propsPath, content);
    log.info(`Set android/local.properties sdk.dir=${sdkDir}`);
  }
}

function syncAppConfigFromProject(
  projectPath: string,
  config: ReturnType<typeof getAppConfig>,
  log: ReturnType<typeof createLogger>
): void {
  const appJsonPath = path.join(projectPath, 'app.json');
  if (!fs.existsSync(appJsonPath)) return;

  try {
    const appJson = JSON.parse(fs.readFileSync(appJsonPath, 'utf8'));
    const pkg = appJson.expo?.android?.package || appJson.android?.package;
    const name = appJson.expo?.name || appJson.name;

    if (pkg) {
      config.appPackage = pkg;
      log.info(`Using Android package from project app.json: ${pkg}`);
    }
    if (name && process.env.APP_NAME === undefined) {
      config.appName = name;
      log.info(`Using app name from project app.json: ${name}`);
    }
  } catch (error: any) {
    log.warn(`Could not read app.json for package sync: ${error.message}`);
  }
}

function logCliBuildLogs(artifactsDir: string, log: ReturnType<typeof createLogger>): void {
  const logsDir = path.join(artifactsDir, 'output/logs');
  if (!fs.existsSync(logsDir)) {
    log.warn(`No CLI build logs at ${logsDir}`);
    return;
  }

  const logFiles = fs
    .readdirSync(logsDir)
    .filter((f) => f.endsWith('.log') || f.endsWith('.txt'))
    .map((f) => ({ name: f, mtime: fs.statSync(path.join(logsDir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, 3);

  for (const { name } of logFiles) {
    const content = fs.readFileSync(path.join(logsDir, name), 'utf8');
    const tail = content.split('\n').slice(-50).join('\n');
    log.error(`--- CLI log: ${name} (last 50 lines) ---\n${tail}`);
  }
}

async function verifyAndroidOnBrowserStack(
  config: ReturnType<typeof getAppConfig>,
  apkPath: string,
  log: ReturnType<typeof createLogger>
): Promise<void> {
  const username = process.env.BROWSERSTACK_USERNAME;
  const accessKey = process.env.BROWSERSTACK_ACCESS_KEY;
  if (!username || !accessKey) {
    throw new Error('BROWSERSTACK_USERNAME or BROWSERSTACK_ACCESS_KEY not set');
  }

  const projectName = process.env.PROJECT_NAME || 'default_project';
  const androidDeviceName = process.env.BS_ANDROID_DEVICE_NAME || 'Google Pixel 8';
  const androidPlatformVersion = (process.env.BS_ANDROID_PLATFORM_VERSION || '14').trim();

  const credentials = { username, accessKey };

  const appUrl = await resolveBrowserStackAppUrl(apkPath, credentials);
  log.info(`BrowserStack app capability: ${appUrl}`);

  const capabilities: AppiumCapabilities = {
    platformName: 'Android',
    'appium:deviceName': androidDeviceName,
    'appium:platformVersion': androidPlatformVersion,
    'appium:automationName': 'UiAutomator2',
    'appium:app': appUrl,
  };

  const bstackOptions: BrowserStackOptions = {
    projectName,
    buildName: `Android_Build_${new Date().toISOString().slice(0, 10)}`,
    deviceName: androidDeviceName,
    platformVersion: androidPlatformVersion,
    appiumVersion: '2.0.0',
  };

  let client: Browser | undefined;
  try {
    log.info('Verifying Android app on BrowserStack...');
    client = await DriverFactory.createBrowserStackSession(capabilities, bstackOptions, credentials);

    const nativeApp = new NativeAppPage(client, config.appVerificationId);
    await nativeApp.verifyAppLaunched();
    log.success('BrowserStack Android verification passed');
  } catch (error: any) {
    log.error(`BrowserStack Android verification failed: ${error.message}`);
    if (client) await DriverFactory.takeScreenshot(client, 'browserstack-android-failure');
    throw error;
  } finally {
    await DriverFactory.closeSession(client);
  }
}

async function verifyOnBrowserStack(config: ReturnType<typeof getAppConfig>, log: ReturnType<typeof createLogger>): Promise<void> {
  const configJsonPath = path.resolve(__dirname, '../../config/config.json');
  const projectName = process.env.PROJECT_NAME || 'default_project';

  let appUrl: string | undefined;
  try {
    const configJson = JSON.parse(fs.readFileSync(configJsonPath, 'utf-8'));
    appUrl = configJson[projectName]?.appUrl;
  } catch (e: any) {
    throw new Error(`Could not read appUrl from config.json: ${e.message}`);
  }

  if (!appUrl) {
    throw new Error(`appUrl not found for project ${projectName} in config.json`);
  }

  const username = process.env.BROWSERSTACK_USERNAME;
  const accessKey = process.env.BROWSERSTACK_ACCESS_KEY;
  if (!username || !accessKey) {
    throw new Error('BROWSERSTACK_USERNAME or BROWSERSTACK_ACCESS_KEY not set');
  }

  const iosDeviceName = process.env.IOS_DEVICE_NAME || 'iPhone 15 Plus';
  const iosPlatformVersion = (process.env.IOS_PLATFORM_VERSION || '17').trim();

  const capabilities: AppiumCapabilities = {
    platformName: 'iOS',
    'appium:deviceName': iosDeviceName,
    'appium:platformVersion': iosPlatformVersion,
    'appium:automationName': 'XCUITest',
    'appium:app': appUrl,
  };

  const bstackOptions: BrowserStackOptions = {
    projectName,
    buildName: `iOS_Build_${new Date().toISOString().slice(0, 10)}`,
    deviceName: iosDeviceName,
    platformVersion: iosPlatformVersion,
    appiumVersion: '2.0.0',
  };

  let client: Browser | undefined;
  try {
    log.info('Verifying iOS app on BrowserStack...');
    client = await DriverFactory.createBrowserStackSession(capabilities, bstackOptions, {
      username,
      accessKey,
    });

    const nativeApp = new NativeAppPage(client, config.appVerificationId);
    await nativeApp.verifyAppLaunched();
    log.success('BrowserStack iOS verification passed');
  } catch (error: any) {
    log.error(`BrowserStack verification failed: ${error.message}`);
    if (client) await DriverFactory.takeScreenshot(client, 'browserstack-ios-failure');
    throw error;
  } finally {
    await DriverFactory.closeSession(client);
  }
}
