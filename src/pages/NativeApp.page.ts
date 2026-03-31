import { Browser } from 'webdriverio';
import { BasePage } from './BasePage';
import { createLogger } from '../utils/Logger';

const log = createLogger('NativeAppPage');

export class NativeAppPage extends BasePage {
  private accessibilityId: string;

  constructor(driver: Browser, accessibilityId = process.env.APP_VERIFICATION_ID || '~mobile_navbar1_title') {
    super(driver);
    this.accessibilityId = accessibilityId;
  }

  get navbarTitle() {
    return this.driver.$(this.accessibilityId);
  }

  async activateApp(appPackage: string): Promise<void> {
    log.info(`Activating app: ${appPackage}`);
    await this.driver.activateApp(appPackage);
  }

  async verifyAppLaunched(timeout = 60000): Promise<boolean> {
    log.info(`Verifying app launched (looking for: ${this.accessibilityId})...`);
    try {
      const el = await this.navbarTitle;
      await el.waitForDisplayed({ timeout });
      const isDisplayed = await el.isDisplayed();

      if (!isDisplayed) {
        throw new Error(`Element ${this.accessibilityId} found but not visible`);
      }

      log.success('App verification passed - UI element is visible');
      return true;
    } catch (error: any) {
      log.error(`App verification failed: ${error.message}`);
      await this.takeScreenshot('app-verification-failure');
      throw error;
    }
  }

  async verifyAfterActivation(appPackage: string, timeout = 60000): Promise<boolean> {
    await this.activateApp(appPackage);
    return this.verifyAppLaunched(timeout);
  }
}
