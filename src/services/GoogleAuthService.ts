import { remote, Browser } from 'webdriverio';
import * as fs from 'fs';
import * as path from 'path';
import { TOTP, Secret } from 'otpauth';
import { createLogger } from '../utils/Logger';

const log = createLogger('GoogleAuth');

const CACHE_DIR = path.join(process.cwd(), '.test-cache');
const SESSION_FILE = path.join(CACHE_DIR, 'google-auth-state.json');
const PROFILE_DIR = path.join(CACHE_DIR, 'google-browser-profile');
const SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000;

export interface GoogleAuthResult {
  cookieHeader: string;
  authCookie: string;
  cookieValue: string;
}

/**
 * Google OAuth + TOTP login for WaveMaker AI platform using WebDriverIO.
 *
 * Uses a persistent Chrome profile so Google remembers "trust this device".
 * On the first run (or when session expires), a visible browser window
 * opens. After that, the session is cached and reused for ~12 hours.
 *
 * Local only — not designed for headless CI.
 */
export class GoogleAuthService {
  private baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  async login(): Promise<GoogleAuthResult> {
    const email = process.env.GOOGLE_EMAIL;
    const password = process.env.GOOGLE_PASSWORD;

    if (!email || !password) {
      throw new Error('GOOGLE_EMAIL and GOOGLE_PASSWORD must be set in .env for AI platform login');
    }

    const cached = this.tryLoadCachedSession();
    if (cached) {
      const valid = await this.verifyCachedSession(cached);
      if (valid) {
        log.info('Reusing cached Google session (still valid)');
        return cached;
      }
      log.info('Cached session expired, performing fresh login...');
    }

    if (!fs.existsSync(PROFILE_DIR)) {
      fs.mkdirSync(PROFILE_DIR, { recursive: true });
    }

    log.info('Launching Chrome for Google OAuth login...');
    log.info('If 2FA is prompted, it will be auto-filled via TOTP secret.');

    const browser = await remote({
      logLevel: 'warn',
      capabilities: {
        browserName: 'chrome',
        'goog:chromeOptions': {
          args: [
            `--user-data-dir=${PROFILE_DIR}`,
            '--disable-blink-features=AutomationControlled',
            '--no-first-run',
            '--no-default-browser-check',
            '--window-size=1280,800',
          ],
          excludeSwitches: ['enable-automation'],
        },
      },
    });

    try {
      const result = await this.loginInBrowser(browser, email, password);
      this.saveCachedSession(result);
      return result;
    } finally {
      await browser.deleteSession();
    }
  }

  private async loginInBrowser(
    browser: Browser,
    email: string,
    password: string,
  ): Promise<GoogleAuthResult> {
    log.info(`Navigating to ${this.baseUrl}/login ...`);
    await browser.url(`${this.baseUrl}/login`);
    await browser.pause(3000);

    if (this.isOnStudioPage(await browser.getUrl())) {
      log.info('Already authenticated via persistent session');
      return this.extractCookies(browser);
    }

    await this.clickGoogleButton(browser);
    await this.fillGoogleCredentials(browser, email, password);
    await this.handle2FA(browser);
    await this.handlePostAuthPages(browser);

    log.info('Waiting for Studio redirect...');
    const timeout = process.env.GOOGLE_TOTP_SECRET ? 90_000 : 180_000;
    await browser.waitUntil(
      async () => this.isOnStudioPage(await browser.getUrl()),
      { timeout, timeoutMsg: 'Timed out waiting for Studio redirect after Google login' },
    );

    await browser.pause(3000);

    log.success('Google OAuth login complete, extracting cookies...');
    return this.extractCookies(browser);
  }

  private isOnStudioPage(url: string): boolean {
    try {
      const host = new URL(url).hostname;
      const studioHost = new URL(this.baseUrl).hostname;
      return host === studioHost && !url.includes('/login');
    } catch {
      return false;
    }
  }

  private async clickGoogleButton(browser: Browser): Promise<void> {
    const selectors = [
      'button*=Sign in with Google',
      'button*=Continue with Google',
      'button*=Google',
      'a*=Sign in with Google',
      'a*=Continue with Google',
      '[data-provider="google"]',
      '.google-login-btn',
      '#google-login',
    ];

    for (const sel of selectors) {
      const el = await browser.$(sel);
      if (await el.isExisting() && await el.isDisplayed()) {
        log.info(`Clicking Google button: ${sel}`);
        await el.click();
        await browser.pause(3000);
        return;
      }
    }

    const currentUrl = await browser.getUrl();
    if (currentUrl.includes('accounts.google.com')) {
      log.info('Already redirected to Google login');
      return;
    }

    throw new Error(`Could not find Google login button on ${this.baseUrl}/login`);
  }

  private async fillGoogleCredentials(
    browser: Browser,
    email: string,
    password: string,
  ): Promise<void> {
    await browser.waitUntil(
      async () => (await browser.getUrl()).includes('accounts.google.com'),
      { timeout: 30_000, timeoutMsg: 'Did not reach Google sign-in page' },
    ).catch(() => log.info('Not on accounts.google.com, proceeding...'));

    const emailInput = await browser.$('input[type="email"]');
    if (await emailInput.isExisting() && await emailInput.isDisplayed()) {
      await emailInput.setValue(email);
      log.info(`Entered email: ${email}`);
      const nextBtn = await browser.$('#identifierNext button');
      if (await nextBtn.isExisting()) await nextBtn.click();
      else {
        const nextBtn2 = await browser.$('button*=Next');
        if (await nextBtn2.isExisting()) await nextBtn2.click();
      }
      await browser.pause(3000);
    }

    // Handle "Choose how you want to sign in" page
    await this.handleChallengeSelection(browser);

    let passwordInput = await browser.$('input[type="password"]');
    let passwordVisible = await passwordInput.isDisplayed().catch(() => false);

    if (passwordVisible) {
      await passwordInput.setValue(password);
      log.info('Entered password');
      const nextBtn = await browser.$('#passwordNext button');
      if (await nextBtn.isExisting()) await nextBtn.click();
      else {
        const nextBtn2 = await browser.$('button*=Next');
        if (await nextBtn2.isExisting()) await nextBtn2.click();
      }
      await browser.pause(3000);
    } else {
      log.info('Password field not shown (session may still be active)');
    }
  }

  private async handleChallengeSelection(browser: Browser): Promise<void> {
    const url = await browser.getUrl();
    if (!url.includes('/challenge/selection') && !url.includes('/challenge/pwd')) return;

    log.info('On challenge selection page, looking for password option...');
    await browser.pause(2000);

    const selectors = [
      'li*=Enter your password',
      'li*=password',
      '[data-challengeindex="0"]',
    ];

    for (const sel of selectors) {
      const el = await browser.$(sel);
      if (await el.isExisting() && await el.isDisplayed()) {
        log.info(`Clicking password option: ${sel}`);
        await el.click();
        await browser.pause(3000);
        return;
      }
    }
  }

  private async handle2FA(browser: Browser): Promise<void> {
    const totpSecret = process.env.GOOGLE_TOTP_SECRET;
    if (!totpSecret) {
      log.info('No GOOGLE_TOTP_SECRET set — complete 2FA manually in the browser window');
      return;
    }

    await browser.pause(3000);

    const currentUrl = await browser.getUrl();
    if (!currentUrl.includes('accounts.google.com')) {
      log.info('Already past 2FA, continuing...');
      return;
    }

    // Check if TOTP input is already visible
    let totpInput = await this.findTotpInput(browser);
    if (totpInput) {
      await this.fillAndSubmitTotp(browser, totpInput, totpSecret);
      return;
    }

    // Check if on method selection page
    if (currentUrl.includes('/challenge/selection')) {
      log.info('On 2FA method selection, picking Authenticator...');
      await this.clickAuthenticatorOption(browser);
    } else {
      // On a different 2FA challenge — try "Try another way"
      const tryAnother = await browser.$('button*=Try another way');
      const tryAnotherLink = await browser.$('a*=Try another way');
      const el = (await tryAnother.isDisplayed().catch(() => false)) ? tryAnother : tryAnotherLink;

      if (await el.isDisplayed().catch(() => false)) {
        log.info('Clicking "Try another way"...');
        await el.click();
        await browser.pause(3000);
        await this.clickAuthenticatorOption(browser);
      }
    }

    await browser.pause(3000);

    totpInput = await this.findTotpInput(browser);
    if (!totpInput) {
      log.info('Waiting 5s more for TOTP input...');
      await browser.pause(5000);
      totpInput = await this.findTotpInput(browser);
    }

    if (totpInput) {
      await this.fillAndSubmitTotp(browser, totpInput, totpSecret);
    } else {
      log.warn('TOTP input not found — complete 2FA manually in the browser window');
    }
  }

  private async findTotpInput(browser: Browser): Promise<WebdriverIO.Element | null> {
    const selectors = [
      '#totpPin',
      'input[name="totpPin"]',
      'input[name="pin"]',
      'input[autocomplete="one-time-code"]',
      'input[type="number"]',
    ];

    for (const sel of selectors) {
      const el = await browser.$(sel);
      if (await el.isExisting() && await el.isDisplayed()) {
        log.info(`Found TOTP input: ${sel}`);
        return el;
      }
    }
    return null;
  }

  private async clickAuthenticatorOption(browser: Browser): Promise<void> {
    const selectors = [
      'li*=Google Authenticator',
      'li*=Authenticator',
      'li*=verification code',
      '[data-challengetype="6"]',
    ];

    for (const sel of selectors) {
      const el = await browser.$(sel);
      if (await el.isExisting() && await el.isDisplayed()) {
        log.info(`Clicking Authenticator option: ${sel}`);
        await el.click();
        await browser.pause(5000);
        return;
      }
    }
    log.warn('Could not find Authenticator option in 2FA list');
  }

  private async fillAndSubmitTotp(
    browser: Browser,
    input: WebdriverIO.Element,
    totpSecret: string,
  ): Promise<void> {
    const totp = new TOTP({
      secret: Secret.fromBase32(totpSecret.replace(/\s+/g, '').toUpperCase()),
      digits: 6,
      period: 30,
    });
    const code = totp.generate();

    log.info('Auto-filling TOTP code...');
    await input.setValue(code);

    const submitSelectors = [
      '#totpNext button',
      '#totpNext',
      'button*=Next',
      'button*=Verify',
    ];

    for (const sel of submitSelectors) {
      const btn = await browser.$(sel);
      if (await btn.isExisting() && await btn.isDisplayed()) {
        log.info(`Clicking submit: ${sel}`);
        await btn.click();
        break;
      }
    }

    await browser.pause(3000);
    log.success('TOTP code submitted');
  }

  private async handlePostAuthPages(browser: Browser): Promise<void> {
    await browser.pause(3000);

    const currentUrl = await browser.getUrl();
    if (!currentUrl.includes('accounts.google.com')) return;

    log.info('Handling post-auth pages...');

    const actionSelectors = [
      'button*=Yes',
      'button*=Continue',
      'button*=Allow',
      'button*=Next',
      'button*=Confirm',
      'button*=I agree',
      'button*=Done',
      '#submit_approve_access',
    ];

    for (const sel of actionSelectors) {
      const btn = await browser.$(sel);
      if (await btn.isExisting() && await btn.isDisplayed()) {
        log.info(`Clicking post-auth button: ${sel}`);
        await btn.click();
        await browser.pause(5000);

        if (!(await browser.getUrl()).includes('accounts.google.com')) {
          log.info('Redirected away from Google after post-auth click');
          return;
        }
        break;
      }
    }
  }

  private async extractCookies(browser: Browser): Promise<GoogleAuthResult> {
    const cookies = await browser.getCookies();
    const headerParts: string[] = [];

    const authCookie = cookies.find((c) => c.name === 'auth_cookie');
    if (authCookie) headerParts.push(`auth_cookie=${authCookie.value}`);

    const jsession = cookies.find((c) => c.name === 'JSESSIONID');
    if (jsession) headerParts.push(`JSESSIONID=${jsession.value}`);

    if (!headerParts.length) {
      const sessionCookies = cookies.filter(
        (c) =>
          c.name.toLowerCase().includes('session') ||
          c.name.toLowerCase().includes('auth') ||
          c.name.toLowerCase().includes('token')
      );
      for (const sc of sessionCookies) {
        headerParts.push(`${sc.name}=${sc.value}`);
      }
    }

    if (!headerParts.length) {
      log.warn('No auth cookies found, sending all cookies');
      for (const c of cookies) {
        headerParts.push(`${c.name}=${c.value}`);
      }
    }

    const cookieHeader = headerParts.join('; ');
    const authCookieStr = authCookie ? `auth_cookie=${authCookie.value}` : cookieHeader.split(';')[0];
    const cookieValue = authCookie ? authCookie.value : cookieHeader.split('=')[1]?.split(';')[0] || '';

    log.info(`Captured cookie header (length: ${cookieHeader.length})`);

    return { cookieHeader, authCookie: authCookieStr, cookieValue };
  }

  async getPreviewUrl(projectId: string, cookieHeader: string): Promise<string> {
    const axios = (await import('axios')).default;
    const previewApiUrl = `${this.baseUrl}/studio/services/projects/${projectId}/deployment/inplaceDeploy`;

    log.info(`Fetching preview URL for project ${projectId}...`);

    const response = await axios.post(previewApiUrl, {}, {
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Cookie: cookieHeader,
      },
    });

    if (response.status !== 200 || !response.data.result) {
      throw new Error(`Unexpected response: status=${response.status}`);
    }

    const resultUrl = response.data.result;
    const previewUrl = resultUrl.startsWith('http') ? resultUrl : `https:${resultUrl}`;

    log.success(`Preview URL obtained: ${previewUrl}`);
    return previewUrl;
  }

  private saveCachedSession(result: GoogleAuthResult): void {
    try {
      if (!fs.existsSync(CACHE_DIR)) {
        fs.mkdirSync(CACHE_DIR, { recursive: true });
      }
      fs.writeFileSync(SESSION_FILE, JSON.stringify({
        ...result,
        timestamp: Date.now(),
      }));
      log.info('Session cached for future runs (~12h)');
    } catch (e: any) {
      log.warn(`Failed to cache session: ${e?.message}`);
    }
  }

  private tryLoadCachedSession(): GoogleAuthResult | null {
    try {
      if (!fs.existsSync(SESSION_FILE)) return null;
      const raw = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf-8'));
      if (Date.now() - raw.timestamp > SESSION_MAX_AGE_MS) {
        log.info('Cached session older than 12h, ignoring');
        return null;
      }
      return { cookieHeader: raw.cookieHeader, authCookie: raw.authCookie, cookieValue: raw.cookieValue };
    } catch {
      return null;
    }
  }

  private async verifyCachedSession(cached: GoogleAuthResult): Promise<boolean> {
    try {
      const axios = (await import('axios')).default;
      const resp = await axios.get(`${this.baseUrl}/studio/services/projects`, {
        headers: { Cookie: cached.cookieHeader },
        maxRedirects: 0,
        validateStatus: (status) => status < 400,
      });
      return resp.status >= 200 && resp.status < 400;
    } catch {
      return false;
    }
  }
}
