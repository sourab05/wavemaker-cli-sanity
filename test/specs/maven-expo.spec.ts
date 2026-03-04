import { ChildProcess, execSync, spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { Browser } from 'webdriverio';
import dotenv from 'dotenv';
import { getWMProjectConfig } from '../../src/config';
import { ProjectService } from '../../src/services/ProjectService';
import { MavenService } from '../../src/services/MavenService';
import { AppiumService } from '../../src/services/AppiumService';
import { EmulatorService } from '../../src/services/EmulatorService';
import { SimulatorService } from '../../src/services/SimulatorService';
import { DriverFactory } from '../../src/helpers/DriverFactory';
import { ExpoGoAppPage } from '../../src/pages/ExpoGoApp.page';
import { killProcess } from '../../src/utils/process-utils';
import { createLogger } from '../../src/utils/Logger';
import { WMProjectConfig } from '../../src/types';
import { getPackageManagers, PackageManagerCommands } from '../../src/utils/package-manager';

dotenv.config();

const packageManagers = getPackageManagers();

packageManagers.forEach((pm) => {
  const cmd = new PackageManagerCommands(pm);
  const log = createLogger(`MavenExpoSpec[${cmd.label}]`);

  describe(`[${cmd.label}] WaveMaker React Native Maven Build and Expo Go Verification`, function () {
    this.timeout(30 * 60 * 1000);

    let wmConfig: WMProjectConfig;
    let projectPath: string;
    let warFilePath: string;
    let devRnZipPath: string;
    let deployedRnZipPath: string;
    let devExtractedPath: string;
    let deployedExtractedPath: string;
    let appiumService: AppiumService;
    let emulatorService: EmulatorService;
    let simulatorService: SimulatorService;

    const devServerUrl = 'dev';
    const deployedServerUrl = process.env.DEPLOYED_SERVER_URL || 'https://your-deployed-app.com/services';
    const appVerificationId = process.env.APP_VERIFICATION_ID || '~mobile_navbar1_title';

    before(async function () {
      this.timeout(5 * 60 * 1000);
      wmConfig = getWMProjectConfig();

      log.separator(`Maven Build & Expo Go Verification (${cmd.label})`);
      log.info(`Project ID: ${wmConfig.projectId}`);
      log.info(`Environment: ${wmConfig.environment}`);
      log.info(`Output Dir: ${wmConfig.outputDir}`);
      log.info(`Dev Server: WaveMaker Preview`);
      log.info(`Deployed Server: ${deployedServerUrl}`);
      log.info(`Package Manager: ${cmd.label}`);

      log.info('Ensuring Android emulator is running...');
      emulatorService = new EmulatorService();
      await emulatorService.ensureRunning();

      log.info('Starting Appium server...');
      appiumService = new AppiumService();
      await appiumService.start();
    });

    it('should download and extract WaveMaker project from studio', async function () {
      this.timeout(10 * 60 * 1000);

      log.info('Downloading and extracting WaveMaker project...');
      const projectService = new ProjectService(wmConfig);
      projectPath = await projectService.downloadAndExtract();

      if (!fs.existsSync(projectPath)) {
        throw new Error('Project extraction failed - directory not found');
      }

      const pomPath = path.join(projectPath, 'pom.xml');
      if (!fs.existsSync(pomPath)) {
        throw new Error('pom.xml not found in extracted project');
      }

      log.success('Project downloaded and verified');
    });

    it('should build backend WAR file using mvn clean install', async function () {
      this.timeout(15 * 60 * 1000);
      if (!projectPath) {
        log.warn('Skipping: project not downloaded');
        this.skip();
      }

      const maven = new MavenService(projectPath);
      const result = await maven.cleanInstall();

      if (!result.artifactPath || !fs.existsSync(result.artifactPath)) {
        throw new Error('WAR file not generated or not found');
      }

      warFilePath = result.artifactPath;
      log.success(`Backend WAR verified: ${path.basename(warFilePath)}`);
    });

    it('should generate React Native ZIP with DEV server URL (WaveMaker Preview)', async function () {
      this.timeout(20 * 60 * 1000);
      if (!projectPath) {
        log.warn('Skipping: project not available');
        this.skip();
      }

      log.info('Building RN ZIP for DEV environment...');
      const maven = new MavenService(projectPath);
      devRnZipPath = await maven.buildRnZip(devServerUrl, 'dev');
      log.success(`DEV RN ZIP: ${path.basename(devRnZipPath)}`);
    });

    it('should generate React Native ZIP with DEPLOYED server URL', async function () {
      this.timeout(20 * 60 * 1000);
      if (!projectPath) {
        log.warn('Skipping: project not available');
        this.skip();
      }

      log.info('Building RN ZIP for DEPLOYED environment...');
      const maven = new MavenService(projectPath);
      deployedRnZipPath = await maven.buildRnZip(deployedServerUrl, 'deployed');
      log.success(`DEPLOYED RN ZIP: ${path.basename(deployedRnZipPath)}`);
    });

    it('should extract and prepare DEV React Native project', function () {
      if (!devRnZipPath) {
        log.warn('Skipping: DEV RN ZIP not available');
        this.skip();
      }

      log.info('Extracting DEV RN project...');
      devExtractedPath = MavenService.extractAndPrepareProject(
        devRnZipPath,
        wmConfig.outputDir,
        'rn-dev-project'
      );
      log.success(`DEV RN project prepared at: ${devExtractedPath}`);
    });

    it('should extract and prepare DEPLOYED React Native project', function () {
      if (!deployedRnZipPath) {
        log.warn('Skipping: DEPLOYED RN ZIP not available');
        this.skip();
      }

      log.info('Extracting DEPLOYED RN project...');
      deployedExtractedPath = MavenService.extractAndPrepareProject(
        deployedRnZipPath,
        wmConfig.outputDir,
        'rn-deployed-project'
      );
      log.success(`DEPLOYED RN project prepared at: ${deployedExtractedPath}`);
    });

    it('should run and verify DEV app in Expo Go on Android emulator', async function () {
      if (process.env.SKIP_EXPO_GO === 'true') this.skip();
      this.timeout(10 * 60 * 1000);
      if (!devExtractedPath) {
        log.warn('Skipping: DEV RN project not prepared');
        this.skip();
      }

      log.info('Running DEV app in Expo Go on Android...');
      await runInExpoGo(devExtractedPath, 'android', 'dev', appVerificationId, cmd, log);
      log.success('DEV app verified in Expo Go on Android');
    });

    it('should run and verify DEPLOYED app in Expo Go on Android emulator', async function () {
      if (process.env.SKIP_EXPO_GO === 'true') this.skip();
      this.timeout(10 * 60 * 1000);
      if (!deployedExtractedPath) {
        log.warn('Skipping: DEPLOYED RN project not prepared');
        this.skip();
      }

      log.info('Running DEPLOYED app in Expo Go on Android...');
      await runInExpoGo(deployedExtractedPath, 'android', 'deployed', appVerificationId, cmd, log);
      log.success(`DEPLOYED app verified (backend: ${deployedServerUrl})`);
    });

    it('should run and verify DEV app in Expo Go on iOS simulator (macOS only)', async function () {
      if (process.env.SKIP_EXPO_GO === 'true') this.skip();
      if (os.platform() !== 'darwin') this.skip();
      this.timeout(10 * 60 * 1000);
      if (!devExtractedPath) {
        log.warn('Skipping: DEV RN project not prepared');
        this.skip();
      }

      log.info('Ensuring iOS Simulator is running...');
      simulatorService = new SimulatorService();
      await simulatorService.ensureRunning();

      log.info('Running DEV app in Expo Go on iOS...');
      await runInExpoGo(devExtractedPath, 'ios', 'dev', appVerificationId, cmd, log);
      log.success('DEV app verified in Expo Go on iOS');
    });

    it('should run and verify DEPLOYED app in Expo Go on iOS simulator (macOS only)', async function () {
      if (process.env.SKIP_EXPO_GO === 'true') this.skip();
      if (os.platform() !== 'darwin') this.skip();
      this.timeout(10 * 60 * 1000);
      if (!deployedExtractedPath) {
        log.warn('Skipping: DEPLOYED RN project not prepared');
        this.skip();
      }

      if (!simulatorService) {
        log.info('Ensuring iOS Simulator is running...');
        simulatorService = new SimulatorService();
        await simulatorService.ensureRunning();
      }

      log.info('Running DEPLOYED app in Expo Go on iOS...');
      await runInExpoGo(deployedExtractedPath, 'ios', 'deployed', appVerificationId, cmd, log);
      log.success(`DEPLOYED app verified on iOS (backend: ${deployedServerUrl})`);
    });

    after(function () {
      if (appiumService?.isRunning()) {
        appiumService.stop();
      }
      emulatorService?.shutdown();
      simulatorService?.shutdown();

      log.separator('Test Suite Summary');
      if (warFilePath) log.info(`Backend WAR: ${path.basename(warFilePath)}`);
      if (devRnZipPath) log.info(`DEV RN ZIP: ${path.basename(devRnZipPath)}`);
      if (deployedRnZipPath) log.info(`DEPLOYED RN ZIP: ${path.basename(deployedRnZipPath)}`);
      log.separator(`Maven Expo Tests Complete (${cmd.label})`);
    });
  });
});

async function runInExpoGo(
  projectPath: string,
  platform: 'android' | 'ios',
  serverType: 'dev' | 'deployed',
  appVerificationId: string,
  cmd: PackageManagerCommands,
  log: ReturnType<typeof createLogger>
): Promise<void> {
  let metroProcess: ChildProcess | undefined;
  let client: Browser | undefined;

  try {
    const capabilities =
      platform === 'android'
        ? {
            platformName: 'Android',
            'appium:deviceName': process.env.ANDROID_DEVICE_NAME || 'emulator-5554',
            'appium:automationName': 'UiAutomator2',
            'appium:appPackage': 'host.exp.exponent',
            'appium:appActivity': '.experience.HomeActivity',
            'appium:autoGrantPermissions': true,
          }
        : {
            platformName: 'iOS',
            'appium:deviceName': 'iPhone 15',
            'appium:platformVersion': '17.0',
            'appium:automationName': 'XCUITest',
            'appium:bundleId': 'host.exp.Exponent',
            'appium:autoAcceptAlerts': true,
          };

    log.info(`Connecting to Expo Go on ${platform}...`);
    client = await DriverFactory.createAppiumSession(capabilities);

    const runCmd = cmd.run(platform === 'android' ? 'android' : 'ios');
    log.info(`Starting Metro bundler via "${runCmd}" (${serverType.toUpperCase()}) on ${platform}...`);

    const runPromise = new Promise<void>((resolve, reject) => {
      metroProcess = spawn(runCmd, {
        shell: true,
        cwd: projectPath,
        detached: true,
        stdio: 'pipe',
      });

      metroProcess.stdout?.on('data', (data: Buffer) => {
        const text = data.toString();
        process.stdout.write(text);
        if (text.includes('Waiting on http://localhost:8081')) {
          log.success(`Metro bundler ready for ${serverType.toUpperCase()} project`);
          resolve();
        }
      });

      metroProcess.stderr?.on('data', (data: Buffer) => {
        process.stderr.write(data);
      });

      metroProcess.on('error', reject);
      setTimeout(() => reject(new Error('Metro bundler startup timeout (120s)')), 120000);
    });

    await runPromise;
    await new Promise((resolve) => setTimeout(resolve, platform === 'ios' ? 20000 : 15000));

    log.info(`Verifying ${serverType.toUpperCase()} app on ${platform}...`);
    const expoPage = new ExpoGoAppPage(client, appVerificationId);
    await expoPage.verifyAppRunning(60000);

    log.success(`${serverType.toUpperCase()} app verified in Expo Go on ${platform}`);
  } catch (error: any) {
    log.error(`Expo Go verification failed (${platform}/${serverType}): ${error.message}`);
    if (client) await DriverFactory.takeScreenshot(client, `expo-${platform}-${serverType}-${cmd.type}-failure`);
    throw error;
  } finally {
    await DriverFactory.closeSession(client);
    if (metroProcess?.pid) {
      log.info('Cleaning up Metro process...');
      killProcess(metroProcess);
    }
  }
}
