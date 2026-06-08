import { Browser } from 'webdriverio';

/** Strip optional quotes from dotenv values like '~foo' */
function stripQuotes(value: string): string {
  return value.replace(/^['"]|['"]$/g, '').trim();
}

/**
 * Build ordered list of selectors to verify the app loaded.
 * APP_VERIFICATION_ID — comma-separated accessibility ids (~widget_id)
 * APP_VERIFICATION_TEXT — fallback: match visible Android text (e.g. page title)
 */
export function getAppVerificationSelectors(): string[] {
  const selectors: string[] = [];

  const rawIds = process.env.APP_VERIFICATION_ID || '~mobile_navbar1_title';
  for (const id of rawIds.split(',')) {
    const trimmed = stripQuotes(id);
    if (trimmed) selectors.push(trimmed);
  }

  const text = process.env.APP_VERIFICATION_TEXT?.trim();
  if (text) {
    selectors.push(`android=new UiSelector().text("${text}")`);
    selectors.push(`//*[@text="${text}"]`);
  }

  return selectors;
}

/** Web preview XPath — set WEB_PREVIEW_XPATH, or WEB_PREVIEW_TITLE for h1 text match. */
export function getWebPreviewXPath(): string {
  const xpath = process.env.WEB_PREVIEW_XPATH?.trim();
  if (xpath) {
    return stripQuotes(xpath);
  }

  const title = process.env.WEB_PREVIEW_TITLE?.trim();
  if (title) {
    return `//h1[normalize-space()='${title}']`;
  }

  return "(//h1[@aria-label='mobile_navbar1_title'][normalize-space()='Title'])[2]";
}

export async function waitForAnyDisplayed(
  driver: Browser,
  selectors: string[],
  timeout: number
): Promise<string> {
  const deadline = Date.now() + timeout;
  let lastError = 'no selectors configured';

  while (Date.now() < deadline) {
    for (const selector of selectors) {
      try {
        const el = await driver.$(selector);
        if (await el.isDisplayed()) {
          return selector;
        }
      } catch (error: any) {
        lastError = error.message;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  throw new Error(
    `None of the verification selectors matched within ${timeout}ms. ` +
      `Tried: ${selectors.join(', ')}. Last error: ${lastError}`
  );
}
