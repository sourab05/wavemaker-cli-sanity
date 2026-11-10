import assert from 'assert';
import { Browser } from 'webdriverio';
import { previewBrowserCapabilities } from '../../src/helpers/DriverFactory';
import { WebPreviewPage } from '../../src/pages/WebPreview.page';
import { browserStackAndroidDevice } from '../../src/services/BrowserStackService';

describe('Jenkins browser acceptance configuration (offline)', () => {
  it('does not block navigation on cold compilation and preserves headless configuration', () => {
    const capabilities = previewBrowserCapabilities('chrome', true);
    assert.equal(capabilities.pageLoadStrategy, 'none');
    assert(capabilities['goog:chromeOptions'].args.includes('--headless=new'));
    assert.equal(previewBrowserCapabilities('chrome', false)['goog:chromeOptions'], undefined);
    assert.equal(previewBrowserCapabilities('firefox', true)['goog:chromeOptions'], undefined);
  });

  it('waits for the visible app element after nonblocking navigation', async () => {
    const events: string[] = [];
    const page = new WebPreviewPage({
      url: async () => { events.push('navigate'); },
      $: async (selector: string) => {
        assert(selector.length > 0);
        return { waitForDisplayed: async ({ timeout }: { timeout: number }) => {
          assert.equal(timeout, 180000);
          await new Promise(resolve => setTimeout(resolve, 10));
          events.push('visible');
        } };
      },
    } as unknown as Browser);
    assert.equal(await page.openAndVerify('http://localhost/preview'), true);
    assert.deepEqual(events, ['navigate', 'visible']);
  });

  it('still fails when navigation succeeds but the app never becomes visible', async () => {
    const failure = new Error('App did not render');
    const page = new WebPreviewPage({
      url: async () => {},
      $: async () => ({ waitForDisplayed: async ({ timeout }: { timeout: number }) => {
        assert.equal(timeout, 25);
        throw failure;
      } }),
    } as unknown as Browser);
    page.takeScreenshot = async () => null;
    await assert.rejects(page.openAndVerify('http://localhost/preview', 25), error => error === failure);
  });

  it('uses the supported Pixel 8 OS version and preserves explicit overrides', () => {
    assert.deepEqual(browserStackAndroidDevice({}), { deviceName: 'Google Pixel 8', platformVersion: '14.0' });
    assert.deepEqual(browserStackAndroidDevice({
      BS_ANDROID_DEVICE_NAME: ' Samsung Galaxy S24 ', BS_ANDROID_PLATFORM_VERSION: ' 15.0 ',
    }), { deviceName: 'Samsung Galaxy S24', platformVersion: '15.0' });
    assert.equal(browserStackAndroidDevice({ BS_ANDROID_PLATFORM_VERSION: ' ' }).platformVersion, '14.0');
  });
});
