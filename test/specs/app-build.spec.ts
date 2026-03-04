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
import { EmulatorService } from '../../src/services/EmulatorService';
import { AppiumService } from '../../src/services/AppiumService';

dotenv.config();

const packageManagers = getPackageManagers();

packageManagers.forEach((pm) => {
  const cmd = new PackageManagerCommands(pm);
  const log = createLogger(`AppBuildSpec[${cmd.label}]`);

  describe(`[${cmd.label}] React Native Project Build and Run`, function () {
    let config: ReturnType<typeof getAppConfig>;
    let emulatorService: EmulatorService;
    let appiumService: AppiumService;

    before(async function () {
      config = getAppConfig();
      this.timeout(config.installTimeout + 120000);

      log.separator(`React Native Build & Run Test Suite (${cmd.label})`);
      log.info(`Project path: ${config.projectPath}`);
      log.info(`Build artifacts: ${config.buildArtifactsDir}`);
      log.info(`Package Manager: ${cmd.label}`);

      log.step(1, 4, 'Ensuring Android emulator is running...');
      emulatorService = new EmulatorService(config.androidEmulatorName);
      await emulatorService.ensureRunning();

      log.step(2, 4, 'Starting Appium server...');
      appiumService = new AppiumService();
      await appiumService.start();

      log.step(3, 5, 'Cleaning build artifacts directory...');
      if (fs.existsSync(config.buildArtifactsDir)) {
        fs.rmSync(config.buildArtifactsDir, { recursive: true, force: true });
      }
      fs.mkdirSync(config.buildArtifactsDir, { recursive: true });

      log.step(4, 5, 'Ensuring wm_rn_config.json exists...');
      const rnConfigPath = path.join(config.projectPath, 'wm_rn_config.json');
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

      const installCmd = cmd.install();
      log.step(5, 5, `Installing project dependencies (${installCmd})...`);
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
    });

    it('should build the Android APK successfully', async function () {
      this.timeout(config.buildTimeout);

      const buildCmd = cmd.cliBinary(`build android "${config.projectPath}" --dest="${config.buildArtifactsDir}" --auto-eject=true`);
      log.info(`Build command: ${buildCmd}`);

      try {
        await runCommand(buildCmd, {
          cwd: config.projectPath,
          timeout: config.buildTimeout,
          successMessage: 'android BUILD SUCCEEDED',
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

        const androidOutputDir = path.join(config.buildArtifactsDir, 'output/android');
        if (!fs.existsSync(androidOutputDir)) {
          throw new Error('Android output directory not found after build');
        }

        const apkFiles = fs.readdirSync(androidOutputDir).filter((f) => f.endsWith('.apk'));
        if (apkFiles.length === 0) {
          throw new Error('No APK file found after build');
        }

        config.androidOutputFile = path.join(androidOutputDir, apkFiles[0]);
        log.success(`APK built: ${config.androidOutputFile}`);
      } catch (error: any) {
        log.error(`APK build failed: ${error.message}`);
        throw error;
      }
    });

    it('should install and verify the Android app on emulator', async function () {
      if (!config.androidOutputFile) {
        log.warn('Skipping: APK not available (previous build may have failed)');
        this.skip();
      }

      this.timeout(20 * 60 * 1000);

      const { appPackage, appActivity, appVerificationId } = config;
      const apkPath = config.androidOutputFile;
      let client: Browser | undefined;

      try {
        log.step(1, 3, 'Installing APK on emulator...');
        try {
          execSync(`adb install -r "${apkPath}"`, { stdio: 'inherit' });
          log.success('APK installed');
        } catch {
          throw new Error(`Failed to install APK: ${apkPath}`);
        }

        log.step(2, 3, 'Creating Appium session...');
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
      } catch (error: any) {
        log.error(`Emulator verification failed: ${error.message}`);
        if (client) await DriverFactory.takeScreenshot(client, `android-emulator-failure-${pm}`);
        throw error;
      } finally {
        await DriverFactory.closeSession(client);
      }
    });

    it('should build the iOS IPA successfully', async function () {
      if (os.platform() !== 'darwin') {
        log.info('Skipping IPA build (not on macOS)');
        this.skip();
      }

      const { IOS_P12_CERT_PATH, IOS_PROVISION_PROFILE_PATH, IOS_P12_PASSWORD } = config;

      if (!IOS_P12_CERT_PATH || !IOS_PROVISION_PROFILE_PATH || !IOS_P12_PASSWORD) {
        log.info('Skipping IPA build (missing iOS certificates/provisioning profiles)');
        this.skip();
      }

      this.timeout(config.buildTimeout);

      const buildCmd = cmd.cliBinary([
        `build ios "${config.projectPath}"`,
        `--dest="${config.buildArtifactsDir}"`,
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
          expectedFile: config.iosOutputFile,
          expectedFilePollInterval: 5000,
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

        if (!fs.existsSync(config.iosOutputFile)) {
          throw new Error('Build completed but IPA file was not found');
        }
        log.success(`IPA built: ${config.iosOutputFile}`);

        if (process.env.RUN_LOCAL === 'false') {
          await verifyOnBrowserStack(config, log);
        }
      } catch (error: any) {
        log.error(`IPA build failed: ${error.message}`);
        throw error;
      }
    });

    after(function () {
      if (appiumService?.isRunning()) {
        appiumService.stop();
      }
      emulatorService?.shutdown();
      log.separator(`Build & Run Tests Complete (${cmd.label})`);
    });
  });
});

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
