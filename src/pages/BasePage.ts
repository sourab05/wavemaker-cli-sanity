import { Browser } from 'webdriverio';
import { DriverFactory } from '../helpers/DriverFactory';
import { createLogger } from '../utils/Logger';

const log = createLogger('BasePage');

export abstract class BasePage {
  protected driver: Browser;

  constructor(driver: Browser) {
    this.driver = driver;
  }

  async waitForElement(selector: string, timeout = 60000): Promise<WebdriverIO.Element> {
    log.info(`Waiting for element: ${selector} (timeout: ${timeout}ms)`);
    const el = await this.driver.$(selector);
    await el.waitForDisplayed({ timeout });
    return el;
  }

  async isElementDisplayed(selector: string, timeout = 10000): Promise<boolean> {
    try {
      const el = await this.driver.$(selector);
      await el.waitForDisplayed({ timeout });
      return true;
    } catch {
      return false;
    }
  }

  async takeScreenshot(name: string): Promise<string | null> {
    return DriverFactory.takeScreenshot(this.driver, name);
  }

  async closeSession(): Promise<void> {
    await DriverFactory.closeSession(this.driver);
  }
}
