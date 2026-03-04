import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import axios from 'axios';
import qs from 'qs';
import { remote, Browser } from 'webdriverio';
import dotenv from 'dotenv';
import { getPreviewCLIConfig, getPreviewUrl } from './config';
import { runCommand } from './utils/run-command';

dotenv.config();

describe('WM CLI Sync Command and RUN Web Preview Command', function () {
  this.timeout(20 * 60 * 1000); // 20 minutes total timeout

  let authCookie = '';
  let previewUrl = '';
  let generatedProjectPath = '';
  let config: ReturnType<typeof getPreviewCLIConfig>;

  before(async function () {
    config = getPreviewCLIConfig();
    const loginPayload = qs.stringify({ j_username: config.auth.username, j_password: config.auth.password });
    const loginRes = await axios.post(config.loginUrl, loginPayload, { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, maxRedirects: 0, validateStatus: (status) => status === 302 });
    const cookieLine = loginRes.headers['set-cookie']?.find((c) => c.startsWith('auth_cookie='));
    if (!cookieLine) throw new Error('auth_cookie not found in login response.');
    authCookie = cookieLine.split(';')[0];

    const previewApiUrl = getPreviewUrl(config.projectId);
    const cookieValue = authCookie.split('=')[1];
    const previewRes = await axios.post(previewApiUrl, {}, { headers: { 'Accept': 'application/json', 'Content-Type': 'application/json', 'Cookie': `auth_cookie=${cookieValue}` } });
    if (previewRes.status !== 200 || !previewRes.data.result) throw new Error(`Failed to retrieve webPreviewUrl. Status: ${previewRes.status}`);
    const resultUrl = previewRes.data.result;
    previewUrl = resultUrl.startsWith('http') ? resultUrl : `https:${resultUrl}`;
    
  });

  it('should run sync command and capture the Expo project path', async function () {
    const projectRootFolder = path.join(config.baseFolder, 'CliApp');
    if (fs.existsSync(projectRootFolder)) {
      fs.rmSync(projectRootFolder, { recursive: true, force: true });
    }
    const syncCmd = `npx @wavemaker/wm-reactnative-cli sync "${previewUrl}"`;
    const cookieValue = authCookie.split('=')[1].trim();
    const pathRegex = /Sync finished generated expo project at\s*:\s*(.*)/;
    try {
      generatedProjectPath = await runCommand(syncCmd, {
        timeout: config.syncTimeout,
        resolveOnRegex: pathRegex,
        onData: (data, child) => {
          // Improved token detection and input handling
          const cleanText = data.replace(/\x1B\[[0-9;]*[A-Za-z]/g, '').trim(); // strip ANSI codes
          if (/\btoken\b\s*:?\s*$/i.test(cleanText)) {
            console.log('🔑 Detected token prompt, sending token...');
            child.stdin!.write(`${cookieValue}\n`);
            child.stdin!.end();
          }
        },
      }) as string;
      if (!fs.existsSync(generatedProjectPath)) {
        throw new Error('Sync reported success, but the captured project folder was not found.');
      }
    } catch (error) {
      throw error;
    }
  });

  let metroProcess: ChildProcess | undefined;
  let appiumProcess: ChildProcess | undefined;

 it('should start the project and trigger the Android build and run Appium', async function () {
    if (!generatedProjectPath) {
      this.skip();
    }

    try {
      // 1. Start Appium and connect to Expo Go first.
      const appiumProcess = spawn('appium', { shell: true, detached: false });
      await new Promise(resolve => setTimeout(resolve, 5000));

      // 2. Connect to Expo Go app via Appium.
      const capabilities = {
        platformName: 'Android',
        'appium:deviceName': process.env.LOCAL_DEVICE_NAME || 'emulator-5554',
        'appium:automationName': 'UiAutomator2',
        'appium:appPackage': 'host.exp.exponent',
        'appium:appActivity': '.experience.HomeActivity',
        'appium:autoGrantPermissions': true,
      };

      console.log('Connecting to Appium...');
      const client = await remote({
        hostname: '127.0.0.1',
        port: 4723,
        capabilities,
      });

      // 3. Now run Metro/Expo Go project (npm run android) to open the project in Expo Go.
      await runCommand('npm run android', {
        cwd: generatedProjectPath,
        timeout: 120 * 1000,
        keepAlive: true,
        onData: (data, child) => {
          metroProcess = child;
        },
        resolveOnData: (data) => {
          if (data.includes('Waiting on http://localhost:8081')) {
            console.log('✅ Metro bundler is waiting. Expo Go should open the project.');
            return true;
          }
          return false;
        }
      });

      // Add a small delay to ensure the app has time to open after the message is logged.
      await new Promise(resolve => setTimeout(resolve, 15000));

      // 4. Verify the accessibility ID in the running Expo Go project.
      console.log('Connected. Waiting for element to be displayed...');
      const el = await client.$('~mobile_navbar1_title');
      await el.waitForDisplayed({ timeout: 60000 }); 
      console.log('✅ Accessibility ID is visible, app is running.');
      await client.deleteSession();

    } catch (error) {
      console.error('Android test failed:', error);
      throw error;
    } finally {
      // 3. This will now run AFTER the Appium test is complete.
      if (metroProcess && metroProcess.pid) {
        console.log(`Cleaning up Metro process (PID: ${metroProcess.pid})...`);
        try {
          if (os.platform() === 'win32') { 
            spawn('taskkill', ['/pid', String(metroProcess.pid), '/t', '/f']); 
          } else { 
            process.kill(-metroProcess.pid, 'SIGKILL'); 
          }
        } catch (e: any) {
          if (e.code !== 'ESRCH') console.error('Failed to kill process:', e);
        }
      }
      if (appiumProcess && appiumProcess.pid) {
        console.log(`Cleaning up Appium process (PID: ${appiumProcess.pid})...`);
        try {
          if (os.platform() === 'win32') { 
            spawn('taskkill', ['/pid', String(appiumProcess.pid), '/t', '/f']); 
          } else { 
            process.kill(-appiumProcess.pid, 'SIGKILL'); 
          }
        } catch (e: any) {
          if (e.code !== 'ESRCH') console.error('Failed to kill process:', e);
        }
      }
    }
  });

  it('should run Expo web-preview and generate the Expo Web App', async function () {
    const cookieValue = authCookie.split('=')[1].trim();
    const runCmd = `npx @wavemaker/wm-reactnative-cli run web-preview "${previewUrl}"`;
    await runCommand(runCmd, {
      timeout: config.syncTimeout,
      successMessage: '✔ Project transpiled successfully',
      onData: (text, child) => {
        if (/token\s*:/i.test(text.trim())) {
          child.stdin!.write(`${cookieValue}\n`);
        }
      },
    });

    // Immediately after running the CLI, open the preview URL in a browser and check the placeholder XPath
    const browser = await remote({
      logLevel: 'error',
      capabilities: { browserName: 'chrome' }
    });
    try {
      await browser.url(previewUrl);
      const placeholderXPath = "(//h1[@aria-label='mobile_navbar1_title'][normalize-space()='Title'])[2]";
      const el = await browser.$(placeholderXPath);
      await el.waitForDisplayed({ timeout: 30000 });
      console.log('✅ XPath is visible, web preview is working.');
    } finally {
      await browser.deleteSession();
    }
  });

  it('should run Esbuild web-preview and generate the Esbuild Web App', async function () {
    const cookieValue = authCookie.split('=')[1].trim();
    const runCmd = `npx @wavemaker/wm-reactnative-cli run web-preview "${previewUrl}" --esbuild`;
    await runCommand(runCmd, {
      timeout: config.syncTimeout,
      successMessage: '✔ Project transpiled successfully',
      onData: (text, child) => {
        if (/token\s*:/i.test(text.trim())) {
          child.stdin!.write(`${cookieValue}\n`);
        }
      },
    });
  });
});

