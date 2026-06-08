import { Browser } from 'webdriverio';
import { BasePage } from './BasePage';
import { createLogger } from '../utils/Logger';
import { getAppVerificationSelectors, waitForAnyDisplayed } from '../utils/app-verification';

const log = createLogger('NativeAppPage');

export class NativeAppPage extends BasePage {
  private selectors: string[];

  constructor(driver: Browser, accessibilityId?: string) {
    super(driver);
    if (accessibilityId) {
      this.selectors = [accessibilityId.replace(/^['"]|['"]$/g, '').trim()];
    } else {
      this.selectors = getAppVerificationSelectors();
    }
  }

  async activateApp(appPackage: string): Promise<void> {
    log.info(`Activating app: ${appPackage}`);
    await this.driver.activateApp(appPackage);
  }

  async verifyAppLaunched(timeout = 60000): Promise<boolean> {
    log.info(`Verifying app launched (selectors: ${this.selectors.join(' | ')})...`);
    try {
      const matched = await waitForAnyDisplayed(this.driver, this.selectors, timeout);
      log.success(`App verification passed (matched: ${matched})`);
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
