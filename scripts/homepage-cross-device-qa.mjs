import { chromium } from 'playwright';

const BASE_URL = process.env.ARSTORE_BASE_URL || 'https://shopeecelana.celanaarstore.workers.dev/';
const devices = [
  { name: 'Desktop 1440×900', width: 1440, height: 900, mobile: false },
  { name: 'Laptop 1366×768', width: 1366, height: 768, mobile: false },
  { name: 'Tablet 1024×768', width: 1024, height: 768, mobile: false },
  { name: 'Tablet Portrait 768×1024', width: 768, height: 1024, mobile: true },
  { name: 'Phone 390×844', width: 390, height: 844, mobile: true },
  { name: 'Phone 412×915', width: 412, height: 915, mobile: true }
];

const results = [];
const failures = [];
const record = (device, name, pass, detail = '') => {
  results.push({ device, name, pass, detail });
  if (!pass) failures.push({ device, name, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  [${device}] ${name}${detail ? ` — ${detail}` : ''}`);
};

const assetUrls = [
  new URL('assets/video/arstore%201.mp4', BASE_URL).href,
  new URL('assets/video/arstore%202.mp4', BASE_URL).href
];
const assetChecks = [];
for (const url of assetUrls) {
  try {
    const response = await fetch(url, { method: 'GET', headers: { Range: 'bytes=0-0' } });
    assetChecks.push({ url, status: response.status, ok: response.ok || response.status === 206 });
    try { await response.body?.cancel(); } catch {}
  } catch (error) {
    assetChecks.push({ url, status: 0, ok: false, error: error.message });
  }
}
record('Assets', 'Existing AR STORE video files are reachable', assetChecks.every((item) => item.ok), assetChecks.map((item) => `${item.status}:${item.url.split('/').pop()}`).join(', '));

const browser = await chromium.launch({ headless: true });

try {
  for (const device of devices) {
    const context = await browser.newContext({
      viewport: { width: device.width, height: device.height },
      screen: { width: device.width, height: device.height },
      isMobile: device.mobile,
      hasTouch: device.mobile,
      deviceScaleFactor: device.mobile ? 2 : 1,
      reducedMotion: 'no-preference'
    });

    const page = await context.newPage();
    const runtimeErrors = [];
    let appJsStatus = 0;
    page.on('pageerror', (error) => runtimeErrors.push(`pageerror: ${error.message}`));
    page.on('console', (message) => {
      if (message.type() === 'error') runtimeErrors.push(`console: ${message.text()}`);
    });
    page.on('response', (response) => {
      try {
        const url = new URL(response.url());
        if (url.pathname.endsWith('/app.js')) appJsStatus = response.status();
      } catch {}
    });

    let response;
    try {
      response = await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      await page.evaluate(async () => { if (document.fonts?.ready) await document.fonts.ready; });
      await page.waitForTimeout(1100);
    } catch (error) {
      record(device.name, 'Homepage loads', false, error.message);
      await context.close();
      continue;
    }

    record(device.name, 'Homepage loads', Boolean(response?.ok()), `HTTP ${response?.status() ?? 'n/a'}`);
    record(device.name, 'Homepage app.js loads', appJsStatus >= 200 && appJsStatus < 400, `HTTP ${appJsStatus || 'n/a'}`);

    const state = await page.evaluate(async () => {
      const hero = document.querySelector('.hero');
      const word = document.querySelector('.hero-display > div');
      const wordRect = word?.getBoundingClientRect();
      const heroRect = hero?.getBoundingClientRect();
      const width = window.innerWidth;
      const scrollWidth = document.documentElement.scrollWidth;
      const bodyOverflowX = getComputedStyle(document.body).overflowX;
      const htmlOverflowX = getComputedStyle(document.documentElement).overflowX;

      const originalBehavior = document.documentElement.style.scrollBehavior;
      const originalBodyBehavior = document.body.style.scrollBehavior;
      document.documentElement.style.scrollBehavior = 'auto';
      document.body.style.scrollBehavior = 'auto';
      const originalY = window.scrollY;
      window.scrollTo(64, originalY);
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const attemptedScrollX = window.scrollX;
      window.scrollTo(0, originalY);
      document.documentElement.style.scrollBehavior = originalBehavior;
      document.body.style.scrollBehavior = originalBodyBehavior;

      return {
        width,
        scrollWidth,
        attemptedScrollX,
        bodyOverflowX,
        htmlOverflowX,
        motionReady: document.documentElement.classList.contains('motion-v1-ready'),
        motionEntered: document.documentElement.classList.contains('motion-page-entered'),
        motionDataset: document.body.dataset.homeMotion,
        wordRect: wordRect ? { left: wordRect.left, right: wordRect.right, top: wordRect.top, bottom: wordRect.bottom, width: wordRect.width } : null,
        heroRect: heroRect ? { left: heroRect.left, right: heroRect.right, top: heroRect.top, bottom: heroRect.bottom } : null
      };
    });

    record(device.name, 'Global Premium Motion V1 wired', state.motionReady && state.motionEntered && state.motionDataset === 'v1');
    const horizontallyContained = Math.abs(state.attemptedScrollX) <= 1 && ['hidden', 'clip'].includes(state.bodyOverflowX);
    record(
      device.name,
      'No user-scrollable horizontal page drift',
      horizontallyContained,
      `scrollWidth=${state.scrollWidth}, viewport=${state.width}, attemptedScrollX=${state.attemptedScrollX}, bodyOverflowX=${state.bodyOverflowX}, htmlOverflowX=${state.htmlOverflowX}`
    );

    const safeInset = device.width <= 640 ? 4 : 2;
    const wordSafe = Boolean(state.wordRect && state.heroRect) &&
      state.wordRect.left >= state.heroRect.left + safeInset &&
      state.wordRect.right <= state.heroRect.right - safeInset;
    record(
      device.name,
      'Hero AR STORE wordmark stays inside safe frame',
      wordSafe,
      state.wordRect ? `left=${state.wordRect.left.toFixed(1)}, right=${state.wordRect.right.toFixed(1)}, viewport=${device.width}` : 'wordmark missing'
    );

    const majorSections = ['#collection', '#fit', '#best', '.spotlight', '.statement', '#shopee', '#faq-title', '.site-footer'];
    const sectionState = await page.evaluate((selectors) => selectors.map((selector) => {
      const element = document.querySelector(selector);
      const target = selector === '#faq-title' ? element?.closest('section') : element;
      const rect = target?.getBoundingClientRect();
      return { selector, exists: Boolean(target), width: rect?.width || 0, height: rect?.height || 0 };
    }), majorSections);
    const sectionsHealthy = sectionState.every((item) => item.exists && item.width > 0 && item.height > 0);
    record(device.name, 'Major homepage sections have valid layout boxes', sectionsHealthy, sectionsHealthy ? '' : JSON.stringify(sectionState.filter((x) => !x.exists || x.width <= 0 || x.height <= 0)));

    const signatureSelectors = ['#collection', '#fit', '#best', '.spotlight', '.statement', '#why-title', '#lookbook-title', '.proof', '#shopee', '#faq-title', '.site-footer'];
    let signaturePass = true;
    const missingSignatures = [];
    for (const selector of signatureSelectors) {
      const locator = page.locator(selector).first();
      if (!(await locator.count())) {
        signaturePass = false;
        missingSignatures.push(`${selector}:missing`);
        continue;
      }
      await locator.scrollIntoViewIfNeeded();
      await page.waitForTimeout(180);
      const entered = await locator.evaluate((el, sel) => {
        const section = (sel === '#why-title' || sel === '#lookbook-title' || sel === '#faq-title') ? el.closest('section') : el;
        return Boolean(section?.classList.contains('is-motion-in'));
      }, selector);
      if (!entered) {
        signaturePass = false;
        missingSignatures.push(`${selector}:not-entered`);
      }
    }
    record(device.name, 'Signature section reveals trigger while scrolling', signaturePass, missingSignatures.join(', '));

    await page.locator('.spotlight').scrollIntoViewIfNeeded();
    await page.evaluate(() => window.scrollBy(0, Math.round(window.innerHeight * 0.9)));
    await page.waitForTimeout(160);
    const spotlightState = await page.evaluate(() => {
      const spotlight = document.querySelector('.spotlight');
      return {
        progress: spotlight?.style.getPropertyValue('--spot-progress') || '',
        active: document.querySelectorAll('.spotlight .feature-point.is-active').length
      };
    });
    record(device.name, 'Spotlight scroll narrative updates', Boolean(spotlightState.progress) && spotlightState.active === 1, `progress=${spotlightState.progress || 'none'}, active=${spotlightState.active}`);

    await page.locator('#faq-title').scrollIntoViewIfNeeded();
    const faqButton = page.locator('.faq-button').first();
    if (await faqButton.count()) {
      await faqButton.click();
      const faqState = await faqButton.evaluate((button) => ({
        expanded: button.getAttribute('aria-expanded'),
        open: button.closest('.faq-item')?.classList.contains('open')
      }));
      record(device.name, 'FAQ interaction opens correctly', faqState.expanded === 'true' && faqState.open === true);
    } else {
      record(device.name, 'FAQ interaction opens correctly', false, 'FAQ button missing');
    }

    if (device.mobile) {
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(120);
      const menuButton = page.locator('.menu-toggle');
      const menuVisible = await menuButton.isVisible().catch(() => false);
      if (menuVisible) {
        await menuButton.click();
        await page.waitForTimeout(120);
        const openState = await page.evaluate(() => ({
          open: document.querySelector('.mobile-menu')?.classList.contains('open'),
          motion: document.querySelector('.mobile-menu')?.classList.contains('motion-menu-open'),
          body: document.body.classList.contains('menu-open')
        }));
        await page.keyboard.press('Escape');
        await page.waitForTimeout(80);
        const closed = await page.evaluate(() => !document.querySelector('.mobile-menu')?.classList.contains('open'));
        record(device.name, 'Mobile menu opens with motion and closes on Escape', openState.open && openState.motion && openState.body && closed);
      } else {
        record(device.name, 'Mobile menu opens with motion and closes on Escape', false, 'menu toggle not visible');
      }
    }

    record(device.name, 'No uncaught browser/runtime errors', runtimeErrors.length === 0, runtimeErrors.slice(0, 3).join(' | '));
    await context.close();
  }

  const reducedContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    reducedMotion: 'reduce'
  });
  const reducedPage = await reducedContext.newPage();
  try {
    const response = await reducedPage.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await reducedPage.waitForTimeout(500);
    const reducedState = await reducedPage.evaluate(() => ({
      media: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
      sections: [...document.querySelectorAll('.motion-section')].length,
      entered: [...document.querySelectorAll('.motion-section')].filter((element) => element.classList.contains('is-motion-in')).length,
      activeFeatures: document.querySelectorAll('.feature-point.is-active').length
    }));
    record('Reduced Motion 390×844', 'Homepage loads', Boolean(response?.ok()), `HTTP ${response?.status() ?? 'n/a'}`);
    record('Reduced Motion 390×844', 'Reduced-motion preference is honored', reducedState.media && reducedState.sections > 0 && reducedState.entered === reducedState.sections && reducedState.activeFeatures > 0, `sections=${reducedState.entered}/${reducedState.sections}`);
  } finally {
    await reducedContext.close();
  }
} finally {
  await browser.close();
}

console.log(`\nCross-device QA: ${results.length - failures.length}/${results.length} PASS`);
if (failures.length) {
  console.error('\nFailures:');
  failures.forEach((item) => console.error(`- [${item.device}] ${item.name}${item.detail ? ` — ${item.detail}` : ''}`));
  process.exit(1);
}
