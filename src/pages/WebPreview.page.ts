import { Browser } from 'webdriverio';
import { BasePage } from './BasePage';
import { createLogger } from '../utils/Logger';

const log = createLogger('WebPreviewPage');

export class WebPreviewPage extends BasePage {
  constructor(driver: Browser) {
    super(driver);
  }

  private get navbarTitleXPath() {
    return "//h1[normalize-space()='MainPage']";
  }

  get navbarTitle() {
    return this.driver.$(this.navbarTitleXPath);
  }

  async open(url: string): Promise<void> {
    log.info(`Opening web preview: ${url}`);
    await this.driver.url(url);
  }

  async verifyPreviewLoaded(timeout = 180000): Promise<boolean> {
    log.info('Verifying web preview is loaded...');
    try {
      const el = await this.navbarTitle;
      await el.waitForDisplayed({ timeout });
      log.success('Web preview loaded and verified');
      return true;
    } catch (error: any) {
      log.error(`Web preview verification failed: ${error.message}`);
      await this.takeScreenshot('web-preview-failure');
      throw error;
    }
  }

  async openAndVerify(url: string, timeout = 180000): Promise<boolean> {
    await this.open(url);
    return this.verifyPreviewLoaded(timeout);
  }
}
