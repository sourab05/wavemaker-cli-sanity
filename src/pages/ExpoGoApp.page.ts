import { Browser } from 'webdriverio';
import { BasePage } from './BasePage';
import { createLogger } from '../utils/Logger';
import { getAppVerificationSelectors, waitForAnyDisplayed } from '../utils/app-verification';

const log = createLogger('ExpoGoAppPage');

export class ExpoGoAppPage extends BasePage {
  private selectors: string[];

  constructor(driver: Browser, appVerificationId?: string) {
    super(driver);
    if (appVerificationId) {
      this.selectors = [appVerificationId.replace(/^['"]|['"]$/g, '').trim()];
    } else {
      this.selectors = getAppVerificationSelectors();
    }
  }

  async waitForAppToLoad(timeout = 60000): Promise<void> {
    log.info(`Waiting for Expo Go app to load (timeout: ${timeout}ms)...`);
    const matched = await waitForAnyDisplayed(this.driver, this.selectors, timeout);
    log.success(`Expo Go app loaded (matched: ${matched})`);
  }

  async verifyAppRunning(timeout = 60000): Promise<boolean> {
    log.info(`Verifying Expo Go app (selectors: ${this.selectors.join(' | ')})...`);
    try {
      const matched = await waitForAnyDisplayed(this.driver, this.selectors, timeout);
      log.success(`Expo Go app verification passed (matched: ${matched})`);
      return true;
    } catch (error: any) {
      log.error(`Expo Go app verification failed: ${error.message}`);
      await this.takeScreenshot('expo-go-verification-failure');
      throw error;
    }
  }
}
