import { Browser } from 'webdriverio';
import { BasePage } from './BasePage';
import { createLogger } from '../utils/Logger';

const log = createLogger('ExpoGoAppPage');

export class ExpoGoAppPage extends BasePage {
  private appVerificationId: string;

  constructor(driver: Browser, appVerificationId = '~mobile_navbar1_title') {
    super(driver);
    this.appVerificationId = appVerificationId;
  }

  get navbarTitle() {
    return this.driver.$(this.appVerificationId);
  }

  async waitForAppToLoad(timeout = 60000): Promise<void> {
    log.info(`Waiting for Expo Go app to load (timeout: ${timeout}ms)...`);
    const el = await this.navbarTitle;
    await el.waitForDisplayed({ timeout });
    log.success('Expo Go app loaded');
  }

  async verifyAppRunning(timeout = 60000): Promise<boolean> {
    log.info(`Verifying Expo Go app (element: ${this.appVerificationId})...`);
    try {
      const el = await this.navbarTitle;
      await el.waitForDisplayed({ timeout });
      const isDisplayed = await el.isDisplayed();

      if (!isDisplayed) {
        throw new Error(`Element ${this.appVerificationId} found but not visible`);
      }

      log.success('Expo Go app verification passed');
      return true;
    } catch (error: any) {
      log.error(`Expo Go app verification failed: ${error.message}`);
      await this.takeScreenshot('expo-go-verification-failure');
      throw error;
    }
  }
}
