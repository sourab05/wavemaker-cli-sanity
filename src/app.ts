import dotenv from 'dotenv';
dotenv.config();
import { execSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { remote, Browser } from 'webdriverio';
import { getAppConfig } from './config';
import { runCommand } from './utils/run-command';
const config = getAppConfig();

// --- Test Suite ---

describe('React Native Project Build and Run', () => {

 
  before(async function () {
    this.timeout(config.installTimeout + 60000); // Add extra time for setup

    console.log('--- Starting Test Setup ---');

    console.log(`[Step 1/4] Cleaning and recreating build artifacts directory at: ${config.buildArtifactsDir}`);
    if (fs.existsSync(config.buildArtifactsDir)) {
      console.log(`[Log] Removing existing directory...`);
      fs.rmSync(config.buildArtifactsDir, { recursive: true, force: true });
    }
    fs.mkdirSync(config.buildArtifactsDir, { recursive: true });
    console.log(`[Log] Created fresh directory: ${config.buildArtifactsDir}`);

    const rnConfigPath = path.join(config.projectPath, 'wm_rn_config.json');
    console.log(`[Step 2/3] Checking for wm_rn_config.json at: ${rnConfigPath}`);
    if (!fs.existsSync(rnConfigPath)) {
      const rnConfig = {
        "appName": config.appName,
        "version": "1.0.0",
        "buildNumber": "1",
        "bundleId": config.appPackage,
      };
      fs.writeFileSync(rnConfigPath, JSON.stringify(rnConfig, null, 2));
      console.log(`[Log] Created wm_rn_config.json.`);
    } else {
      console.log(`[Log] wm_rn_config.json already exists.`);
    }

    console.log(`[Step 3/3] Installing project dependencies (npm install)... This may take several minutes.`);
    try {
        await runCommand('npm install', {
            cwd: config.projectPath,
            timeout: config.installTimeout,
            onData: (text, child) => {
                if (text.includes('Would you like to eject the expo project') || text.includes('Would you like to empty the dest folder')) {
                    child.stdin?.write('yes\n');
                }
                if (text.includes('Use port 8082 instead?') || text.includes('Use port 8081 instead?')) {
                    child.stdin?.write('y\n');
                }
            },
        });
        console.log('✅ Dependencies installed successfully.');
    } catch (error) {
        console.error('❌ Failed to install dependencies.', error);
        throw error; // Fail fast if setup fails
    }
    console.log('--- ✅ Test Setup Complete ---');
  });

  /**
   * Teardown hook that runs once after all tests.
   * It ensures resources like the emulator are shut down.
   */
  after(function() {
    console.log('\n--- Starting Test Teardown ---');
    try {
      console.log('[Emulator] Shutting down Android emulator...');
      execSync('adb emu kill');
      console.log('✅ Emulator shut down successfully.');
    } catch (error: any) {
      console.warn('[Warning] Could not shut down emulator. It may have already been closed.', error.message);
    }
    console.log('--- ✅ Test Teardown Complete ---');
  });

  
  it('should build the Android APK successfully', async function() {
    this.timeout(config.buildTimeout);
    console.log('\n--- Starting APK Build Test ---');

    const buildCmd = `wm-reactnative build android "${config.projectPath}" --dest="${config.buildArtifactsDir}" --auto-eject=true`;
    console.log(`[Log] Build command: ${buildCmd}`);

    try {
      await runCommand(buildCmd, {
        cwd: config.projectPath,
        timeout: config.buildTimeout,
        successMessage: 'android BUILD SUCCEEDED',
        onData: (text, child) => {
          if (text.includes('Would you like to eject the expo project') || text.includes('Would you like to empty the dest folder')) {
            child.stdin?.write('yes\n');
          }
          if (text.includes('Use port 8082 instead?') || text.includes('Use port 8081 instead?')) {
            child.stdin?.write('y\n');
          }
        },
      });

      // Find the APK file after build completes
      const androidOutputDir = path.join(config.buildArtifactsDir, 'output/android');
      if (!fs.existsSync(androidOutputDir)) {
        throw new Error('Android output directory not found after build');
      }

      const apkFiles = fs.readdirSync(androidOutputDir).filter(f => f.endsWith('.apk'));
      if (apkFiles.length === 0) {
        throw new Error('No APK file found after build');
      }

      const apkPath = path.join(androidOutputDir, apkFiles[0]);
      config.androidOutputFile = apkPath; // Update config with actual APK path
      
      console.log('✅ APK file verified successfully at:', apkPath);
    } catch (error) {
      console.error('❌ APK build failed.', error);
      throw error;
    }
  });


  it('should install and verify the Android app on emulator', async function() {
    if (!config.androidOutputFile) {
      throw new Error('APK path not available for installation - previous build may have failed');
    }

    this.timeout(20 * 60 * 1000); // 20 minutes
    const { appPackage, appActivity, appVerificationId: accessibilityId } = config;
    const apkPath = config.androidOutputFile;

    let client: Browser;

    try {
      // Check for connected device/emulator
      const devicesOutput = execSync('adb devices').toString();
      const deviceLines = devicesOutput.split('\n').filter(line => line.trim() && !line.startsWith('List of devices'));
      const connectedDevices = deviceLines.filter(line => line.includes('device'));
      if (connectedDevices.length === 0) {
        throw new Error('[Device] No connected Android device/emulator found. Please start an emulator or connect a device.');
      }
      console.log('[Device] Connected devices:', connectedDevices);

      // Install APK
      console.log('[APK] Installing APK...');
      try {
        execSync(`adb install -r "${apkPath}"`, { stdio: 'inherit' });
        console.log('[APK] APK installed.');
      } catch (e) {
        throw new Error('[APK] Failed to install APK');
      }

      // Set capabilities as in WDIO config
      const platformName = process.env.PLATFORM_NAME || 'android';
      const deviceName = process.env.LOCAL_DEVICE_NAME || connectedDevices[0].split('\t')[0];
      const platformVersion = process.env.LOCAL_PLATFORM_VERSION;
      const automationName = platformName === 'android' ? 'UiAutomator2' : 'XCUITest';

      const capabilities: any = {
        platformName,
        'appium:deviceName': deviceName,
        'appium:automationName': automationName,
        'appium:app': apkPath,
        'appium:autoGrantPermissions': true,
        'appium:locationServicesEnabled': true,
        'appium:locationServicesAuthorized': true,
      };
      if (platformVersion) {
        capabilities['appium:platformVersion'] = platformVersion;
      }
      if (appPackage) {
        capabilities['appium:appPackage'] = appPackage;
      }
      if (appActivity) {
        capabilities['appium:appActivity'] = appActivity;
      }

      // Connect to Appium and verify accessibility ID
      console.log('[Appium] Connecting to Appium server...');
      const opts = {
        hostname: '127.0.0.1',
        port: 4723,
        capabilities
      };
      client = await remote(opts);
      try {
        console.log('[Appium] Activating app...');
        await client.activateApp(appPackage);
        console.log('[Appium] Looking for accessibility ID:', accessibilityId);
        const el = await client.$(accessibilityId);
        const isDisplayed = await el.isDisplayed();
        if (!isDisplayed) throw new Error('[Appium] Accessibility ID not visible');
        console.log('[Appium] Accessibility ID is visible.');
      } finally {
        await client.deleteSession();
        console.log('[Appium] Appium session closed.');
      }
    } catch (error) {
      console.error('[Test] Error during emulator/app verification:', error);
      throw error;
    }
  });

  /**
   * Test case for building the iOS IPA.
   * This test is skipped if not running on macOS or if certificates are missing.
   */
  it('should build the iOS IPA successfully', async function() {
    if (os.platform() !== 'darwin') {
      console.log('\n--- Skipping IPA Build Test (not on macOS) ---');
      this.skip();
    }

    const hasP12Cert = config.IOS_P12_CERT_PATH;
    const hasProvProfile = config.IOS_PROVISION_PROFILE_PATH;
    const hasPassword = config.IOS_P12_PASSWORD;

    if (!hasP12Cert || !hasProvProfile || !hasPassword) {
      console.log('\n--- Skipping IOS Build Test (missing certificates/provisioning profiles) ---');
      console.log('Required environment variables: IOS_P12_CERT_PATH, IOS_PROVISION_PROFILE_PATH, IOS_P12_PASSWORD');
      this.skip();
    }

    this.timeout(config.buildTimeout);
    console.log('\n--- Starting IPA Build Test ---');

    const buildCmd = `wm-reactnative build ios "${config.projectPath}" --dest="${config.buildArtifactsDir}" --iCertificate="${hasP12Cert}" --iCertificatePassword="${hasPassword}" --iProvisioningFile="${hasProvProfile}" --auto-eject=true`;
    console.log(`[Log] Build command: ${buildCmd}`);

    try {
      console.log(`[Log] Executing build command. Timeout set to ${config.buildTimeout / 60000} minutes.`);
      await runCommand(buildCmd, {
        cwd: config.projectPath,
        timeout: config.buildTimeout,
        expectedFile: config.iosOutputFile,
        expectedFilePollInterval: 5000,
        onData: (text, child) => {
          if (text.includes('Would you like to eject the expo project') || text.includes('Would you like to empty the dest folder')) {
            child.stdin?.write('yes\n');
          }
          if (text.includes('Use port 8082 instead?') || text.includes('Use port 8081 instead?')) {
            child.stdin?.write('y\n');
          }
        },
      });
      console.log(`[Log] Build command completed successfully.`);

      console.log(`[Log] Verifying final IPA file exists at: ${config.iosOutputFile}`);
      if (!fs.existsSync(config.iosOutputFile)) {
        throw new Error('Build command finished but IPA file was not found.');
      }
      console.log('✅ IPA file verified successfully.');

      // --- BrowserStack iOS App Verification ---
      if (process.env.RUN_LOCAL === 'false') {
        // Read appUrl from config/config.json
        const configJsonPath = path.resolve(__dirname, '../../config/config.json');
        const projectName = process.env.PROJECT_NAME || 'default_project';
        let appUrl: string | undefined;
        try {
          const configJson = JSON.parse(fs.readFileSync(configJsonPath, 'utf-8'));
          if (configJson[projectName] && configJson[projectName].appUrl) {
            appUrl = configJson[projectName].appUrl;
          }
        } catch (e) {
          throw new Error(`[BrowserStack] Could not read appUrl from config.json for project ${projectName}: ${e}`);
        }
        if (!appUrl) {
          throw new Error(`[BrowserStack] appUrl not found for project ${projectName} in config.json`);
        }
        console.log(`[BrowserStack] Using appUrl: ${appUrl}`);

        // Set up BrowserStack iOS capabilities
        const iosDeviceName = process.env.IOS_DEVICE_NAME || 'iPhone 15 Plus';
        const iosPlatformVersion = (process.env.IOS_PLATFORM_VERSION || '17').trim();
        const automationName = 'XCUITest';
        const bstackOptions = {
          projectName: process.env.PROJECT_NAME || 'default_project',
          buildName: `iOS_Build_${new Date().toISOString().slice(0, 10)}`,
          deviceName: iosDeviceName,
          platformVersion: iosPlatformVersion,
          appiumVersion: '2.0.0',
        };

        const capabilities: any = {
          platformName: 'iOS',
          'appium:deviceName': iosDeviceName,
          'appium:platformVersion': iosPlatformVersion,
          'appium:automationName': automationName,
          'appium:app': appUrl,
          'bstack:options': bstackOptions,
        };

        // Connect to BrowserStack Appium server
        const username = process.env.BROWSERSTACK_USERNAME;
        const accessKey = process.env.BROWSERSTACK_ACCESS_KEY;
        if (!username || !accessKey) {
          throw new Error('[BrowserStack] BROWSERSTACK_USERNAME or BROWSERSTACK_ACCESS_KEY not set in .env');
        }
        const opts = {
          protocol: 'https',
          hostname: 'hub.browserstack.com',
          port: 443,
          path: '/wd/hub',
          user: username,
          key: accessKey,
          capabilities,
        };

        let client: Browser | undefined = undefined;
        try {
          // Wait for device to be ready and app to launch
          console.log('[BrowserStack] Connecting to Appium server and launching app...');
          // @ts-ignore
          client = await remote(opts);
          // Optionally, verify a UI element by accessibility ID
          const accessibilityId = config.appVerificationId || '~mobile_navbar1_title';
          console.log('[BrowserStack] Looking for accessibility ID:', accessibilityId);
          const el = await client.$(accessibilityId);
          const isDisplayed = await el.isDisplayed();
          if (!isDisplayed) throw new Error('[BrowserStack] Accessibility ID not visible');
          console.log('[BrowserStack] Accessibility ID is visible.');
        } catch (error) {
          console.error('[BrowserStack] Error during iOS app verification:', error);
          throw error;
        } finally {
          if (client) {
            await client.deleteSession();
            console.log('[BrowserStack] Appium session closed.');
          }
        }
      }

    } catch (error) {
      console.error('❌ IPA build failed.', error);
      throw error;
    }
  });
});


// --- Helper Functions ---

/**
 * Recursively deletes a file or directory if it exists.
 * @param itemPath Path to the file or directory.
 */
function deleteIfExists(itemPath: string): void {
  if (!fs.existsSync(itemPath)) {
    console.log(`[Log] No-op: ${itemPath} does not exist.`);
    return;
  }
  try {
    const stats = fs.statSync(itemPath);
    if (stats.isDirectory()) {
      fs.rmSync(itemPath, { recursive: true, force: true });
      console.log(`[Log] Deleted directory: ${itemPath}`);
    } else {
      fs.unlinkSync(itemPath);
      console.log(`[Log] Deleted file: ${itemPath}`);
    }
  } catch (error: any) {
    console.error(`[Error] Failed to delete ${itemPath}:`, error.message);
    throw error;
  }
}

