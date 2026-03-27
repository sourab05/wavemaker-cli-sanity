import { remote, Browser } from 'webdriverio';
import * as fs from 'fs';
import * as path from 'path';
import { AppiumCapabilities, BrowserStackOptions } from '../types';
import { createLogger } from '../utils/Logger';

const log = createLogger('DriverFactory');

export class DriverFactory {
  private static screenshotDir = path.resolve(__dirname, '..', '..', 'allure-results');

  static async createAppiumSession(capabilities: AppiumCapabilities): Promise<Browser> {
    log.info(`Creating Appium session for ${capabilities.platformName}...`);
    try {
      const client = await remote({
        hostname: '127.0.0.1',
        port: 4723,
        logLevel: 'warn',
        capabilities,
      });
      log.success('Appium session created');
      return client;
    } catch (error: any) {
      log.error(`Failed to create Appium session: ${error.message}`);
      throw error;
    }
  }

  static async createBrowserSession(browserName = 'chrome'): Promise<Browser> {
    const isHeadless = process.env.HEADLESS === 'true';
    log.info(`Creating browser session (${browserName}, headless: ${isHeadless})...`);

    const capabilities: Record<string, any> = { browserName };
    if (isHeadless && browserName === 'chrome') {
      capabilities['goog:chromeOptions'] = {
        args: ['--headless=new', '--no-sandbox', '--disable-gpu', '--window-size=1920,1080'],
      };
    }

    try {
      const client = await remote({
        logLevel: 'error',
        capabilities,
      });
      log.success('Browser session created');
      return client;
    } catch (error: any) {
      log.error(`Failed to create browser session: ${error.message}`);
      throw error;
    }
  }

  static async createBrowserStackSession(
    capabilities: AppiumCapabilities,
    bstackOptions: BrowserStackOptions,
    credentials: { username: string; accessKey: string }
  ): Promise<Browser> {
    log.info('Creating BrowserStack session...');

    const fullCapabilities = {
      ...capabilities,
      'bstack:options': bstackOptions,
    };

    try {
      const client = await remote({
        protocol: 'https' as const,
        hostname: 'hub.browserstack.com',
        port: 443,
        path: '/wd/hub',
        user: credentials.username,
        key: credentials.accessKey,
        logLevel: 'warn',
        capabilities: fullCapabilities,
      });
      log.success('BrowserStack session created');
      return client;
    } catch (error: any) {
      log.error(`Failed to create BrowserStack session: ${error.message}`);
      throw error;
    }
  }

  static async takeScreenshot(client: Browser, name: string): Promise<string | null> {
    try {
      if (!fs.existsSync(this.screenshotDir)) {
        fs.mkdirSync(this.screenshotDir, { recursive: true });
      }
      const filePath = path.join(this.screenshotDir, `${name}-${Date.now()}.png`);
      await client.saveScreenshot(filePath);
      log.info(`Screenshot saved: ${filePath}`);
      return filePath;
    } catch (err: any) {
      log.warn(`Failed to take screenshot: ${err.message}`);
      return null;
    }
  }

  static async closeSession(client: Browser | undefined): Promise<void> {
    if (!client) return;
    try {
      await client.deleteSession();
      log.info('Session closed');
    } catch (err: any) {
      log.warn(`Error closing session: ${err.message}`);
    }
  }
}
