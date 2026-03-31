import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { Browser } from 'webdriverio';
import dotenv from 'dotenv';
import { getPreviewCLIConfig } from '../../src/config';
import { AuthService } from '../../src/services/AuthService';
import { AppiumService } from '../../src/services/AppiumService';
import { EmulatorService } from '../../src/services/EmulatorService';
import { DriverFactory } from '../../src/helpers/DriverFactory';
import { ExpoGoAppPage } from '../../src/pages/ExpoGoApp.page';
import { WebPreviewPage } from '../../src/pages/WebPreview.page';
import { runCommand } from '../../src/utils/run-command';
import { killProcess, killPort } from '../../src/utils/process-utils';
import { createLogger } from '../../src/utils/Logger';
import { getPackageManagers, PackageManagerCommands } from '../../src/utils/package-manager';

dotenv.config();

const packageManagers = getPackageManagers();
const isRunLocal = process.env.RUN_LOCAL !== 'false';

packageManagers.forEach((pm) => {
  const cmd = new PackageManagerCommands(pm);
  const log = createLogger(`PreviewCLISpec[${cmd.label}]`);

  describe(`[${cmd.label}] WM CLI Sync Command and Web Preview`, function () {
    this.timeout(40 * 60 * 1000);

    let config: ReturnType<typeof getPreviewCLIConfig>;
    let authService: AuthService;
    let authCookie: string;
    let cookieValue: string;
    let previewUrl: string;
    let generatedProjectPath: string;
    let metroProcess: ChildProcess | undefined;
    let appiumService: AppiumService;
    let emulatorService: EmulatorService;

    let setupDone = false;
    let setupError: Error | null = null;

    async function ensureSetup() {
      if (setupDone) return;
      if (setupError) throw setupError;
      try {
        log.separator(`WM CLI Sync & Web Preview Test Suite (${cmd.label})`);

        config = getPreviewCLIConfig();
        const studioUrl = process.env.STUDIO_URL || 'https://stage-studio.wavemakeronline.com';
        authService = new AuthService(studioUrl);

        const totalSteps = isRunLocal ? 3 : 2;
        let step = 1;

        if (isRunLocal) {
          log.step(step++, totalSteps, 'Ensuring Android emulator is running...');
          emulatorService = new EmulatorService();
          await emulatorService.ensureRunning();
        } else {
          log.info('CI mode (RUN_LOCAL=false): skipping emulator setup');
        }

        log.step(step++, totalSteps, 'Authenticating with WaveMaker Studio...');
        authCookie = await authService.login(config.auth.username, config.auth.password);
        cookieValue = authService.extractCookieValue(authCookie);

        log.step(step++, totalSteps, 'Fetching preview URL...');
        previewUrl = await authService.getPreviewUrl(config.projectId, authCookie);

        log.info(`Project ID: ${config.projectId}`);
        log.info(`Preview URL: ${previewUrl}`);
        log.info(`Package Manager: ${cmd.label}`);
        log.info(`Run Local: ${isRunLocal}`);

        setupDone = true;
      } catch (err: any) {
        setupError = err;
        throw err;
      }
    }

    it('should run sync command and capture the Expo project path', async function () {
      this.timeout(5 * 60 * 1000 + 360000);
      await ensureSetup();

      const projectRootFolder = path.join(config.baseFolder, 'CliApp');
      if (fs.existsSync(projectRootFolder)) {
        fs.rmSync(projectRootFolder, { recursive: true, force: true });
      }

      const syncCmd = cmd.cli(`sync "${previewUrl}"`);
      const pathRegex = /Sync finished generated expo project at\s*:\s*(.*)/;

      log.info(`Running sync command: ${syncCmd}`);

      try {
        generatedProjectPath = await runCommand(syncCmd, {
          timeout: config.syncTimeout,
          resolveOnRegex: pathRegex,
          onData: (data, child) => {
            const cleanText = data.replace(/\x1B\[[0-9;]*[A-Za-z]/g, '').trim();
            if (/\btoken\b\s*:?\s*$/i.test(cleanText)) {
              log.info('Detected token prompt, sending auth token...');
              child.stdin!.write(`${cookieValue}\n`);
              child.stdin!.end();
            }
          },
        }) as string;

        if (!fs.existsSync(generatedProjectPath)) {
          throw new Error(
            `Sync reported success but project folder not found at: ${generatedProjectPath}`
          );
        }

        log.success(`Sync complete. Project at: ${generatedProjectPath}`);
      } catch (error: any) {
        log.error(`Sync command failed: ${error.message}`);
        throw error;
      }
    });

    it('should start the project and verify the app in Expo Go on Android', async function () {
      this.timeout(5 * 60 * 1000);
      await ensureSetup();

      if (!isRunLocal) {
        log.info('Skipping Expo Go test: requires local emulator (RUN_LOCAL=false)');
        this.skip();
      }

      if (!generatedProjectPath) {
        log.warn('Skipping: no generated project path from sync');
        this.skip();
      }
      let client: Browser | undefined;

      try {
        log.step(1, 4, 'Starting Appium server...');
        appiumService = new AppiumService();
        await appiumService.start();

        log.step(2, 4, 'Connecting to Expo Go via Appium...');
        client = await DriverFactory.createAppiumSession({
          platformName: 'Android',
          'appium:deviceName': process.env.LOCAL_DEVICE_NAME || 'emulator-5554',
          'appium:automationName': 'UiAutomator2',
          'appium:appPackage': 'host.exp.exponent',
          'appium:appActivity': '.experience.HomeActivity',
          'appium:autoGrantPermissions': true,
        });

        log.step(3, 4, 'Freeing port 8081 for Metro bundler...');
        killPort(8081);

        const metroCmd = cmd.run('android');
        log.info(`Running Metro bundler (${metroCmd})...`);
        await runCommand(metroCmd, {
          cwd: generatedProjectPath,
          timeout: 120 * 1000,
          keepAlive: true,
          onData: (data, child) => {
            metroProcess = child;
          },
          resolveOnData: (data) => {
            if (data.includes('Waiting on http://localhost:8081')) {
              log.success('Metro bundler is ready');
              return true;
            }
            return false;
          },
        });

        await new Promise((resolve) => setTimeout(resolve, 15000));

        log.step(4, 4, 'Verifying app in Expo Go...');
        const expoPage = new ExpoGoAppPage(client);
        await expoPage.verifyAppRunning(60000);

        log.success('Android Expo Go verification passed');
      } catch (error: any) {
        log.error(`Android verification failed: ${error.message}`);
        if (client) await DriverFactory.takeScreenshot(client, `android-expo-go-failure-${pm}`);
        throw error;
      } finally {
        await DriverFactory.closeSession(client);

        if (metroProcess?.pid) {
          log.info('Cleaning up Metro process...');
          killProcess(metroProcess);
          metroProcess = undefined;
        }

        if (appiumService?.isRunning()) {
          appiumService.stop();
        }
      }
    });

    it('should run Expo web-preview and generate the Expo Web App', async function () {
      this.timeout(10 * 60 * 1000);
      await ensureSetup();
      let browser: Browser | undefined;

      try {
        const webPreviewCmd = cmd.cli(`run web-preview "${previewUrl}"`);
        log.step(1, 2, `Running CLI web-preview command: ${webPreviewCmd}`);
        await runCommand(webPreviewCmd, {
          timeout: config.syncTimeout,
          successMessage: '✔ Project transpiled successfully',
          onData: (text, child) => {
            if (/token\s*:/i.test(text.trim())) {
              child.stdin!.write(`${cookieValue}\n`);
            }
          },
        });

        log.step(2, 2, 'Verifying web preview in browser...');
        browser = await DriverFactory.createBrowserSession();
        const webPreviewPage = new WebPreviewPage(browser);
        await webPreviewPage.openAndVerify(previewUrl);

        log.success('Expo web preview verified');
      } catch (error: any) {
        log.error(`Expo web-preview failed: ${error.message}`);
        if (browser) await DriverFactory.takeScreenshot(browser, `expo-web-preview-failure-${pm}`);
        throw error;
      } finally {
        await DriverFactory.closeSession(browser);
      }
    });

    it('should run Esbuild web-preview and generate the Esbuild Web App', async function () {
      this.timeout(10 * 60 * 1000);
      await ensureSetup();

      try {
        const esbuildCmd = cmd.cli(`run web-preview "${previewUrl}" --esbuild`);
        log.info(`Running CLI web-preview with --esbuild flag: ${esbuildCmd}`);
        await runCommand(esbuildCmd, {
          timeout: config.syncTimeout,
          successMessage: '✔ Project transpiled successfully',
          onData: (text, child) => {
            if (/token\s*:/i.test(text.trim())) {
              child.stdin!.write(`${cookieValue}\n`);
            }
          },
        });

        log.success('Esbuild web preview generated');
      } catch (error: any) {
        log.error(`Esbuild web-preview failed: ${error.message}`);
        throw error;
      }
    });

    after(function () {
      if (metroProcess?.pid) {
        log.info('Cleaning up Metro process...');
        killProcess(metroProcess);
      }
      if (appiumService?.isRunning()) {
        appiumService.stop();
      }
      log.separator(`Preview CLI Tests Complete (${cmd.label})`);
    });
  });
});
