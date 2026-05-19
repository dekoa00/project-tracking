const { chromium } = require('playwright');

const TRACK_URL = 'https://www.interasia.cc/Service/Form?servicetype=0';

async function trackIAL(trackingNumber, options = {}) {
  let browser, context, page;
  const headless = options.headless ?? (process.env.CI ? true : false);
  const slowMo = options.slowMo ?? 100;

  try {
    browser = await chromium.launch({ ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : (process.env.CI ? {} : { channel: 'msedge' })), headless, slowMo });
    context = await browser.newContext({ viewport: { width: 1700, height: 1000 } });
    page = await context.newPage();
    page.setDefaultTimeout(30000);

    await page.goto(TRACK_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await searchTracking(page, trackingNumber);
    await openFirstDetail(page);
    const summary = await extractPodEta(page);

    return {
      status: 'success',
      carrier: 'IAL',
      trackingNumber,
      pod: summary.pod,
      eta: summary.eta,
      error: '',
    };
  } catch (error) {
    return {
      status: 'error',
      carrier: 'IAL',
      trackingNumber,
      pod: '',
      eta: '',
      error: error.message || String(error),
    };
  } finally {
    if (page) await page.close().catch(() => {});
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }
}

async function searchTracking(page, trackingNumber) {
  const input = page.locator('input[name="query"]').first();
  await input.waitFor({ state: 'visible', timeout: 20000 });
  await input.click({ force: true }).catch(() => {});
  await input.fill('').catch(() => {});
  try {
    await input.fill(trackingNumber);
  } catch (_) {
    await input.type(trackingNumber, { delay: 35 });
  }
  await page.waitForTimeout(300);

  const searchButton = page.getByRole('button', { name: /^search$/i }).first();
  if (await searchButton.isVisible({ timeout: 3000 }).catch(() => false)) {
    await Promise.allSettled([
      page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {}),
      searchButton.click({ force: true }),
    ]);
  } else {
    await input.press('Enter').catch(() => {});
  }

  const listReady = [
    page.getByText(/B\/L No\s*\|/i).first(),
    page.getByText(/Show Detail/i).first(),
    page.locator('table').first(),
  ];
  for (const locator of listReady) {
    try {
      await locator.waitFor({ state: 'visible', timeout: 20000 });
      break;
    } catch (_) {}
  }
  await page.waitForTimeout(800);
}

async function openFirstDetail(page) {
  const detailLink = page.getByText(/Show Detail/i).first();
  await detailLink.waitFor({ state: 'visible', timeout: 20000 });
  await Promise.allSettled([
    page.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(() => {}),
    detailLink.click({ force: true }),
  ]);

  const detailReady = [
    page.getByText(/Discharging Port/i).first(),
    page.getByText(/Estimated Arrival Date/i).first(),
    page.getByText(/Cargo Tracking/i).first(),
  ];
  for (const locator of detailReady) {
    try {
      await locator.waitFor({ state: 'visible', timeout: 20000 });
      break;
    } catch (_) {}
  }
  await page.waitForTimeout(800);
}

async function extractPodEta(page) {
  const result = await page.evaluate(() => {
    const clean = (v) => String(v || '').replace(/\s+/g, ' ').trim();

    function extractFromHeaderValueTable() {
      const tables = Array.from(document.querySelectorAll('table'));
      for (const table of tables) {
        const rows = Array.from(table.querySelectorAll('tr'));
        for (let i = 0; i < rows.length - 1; i++) {
          const headers = Array.from(rows[i].querySelectorAll('th,td')).map(x => clean(x.textContent));
          const values = Array.from(rows[i + 1].querySelectorAll('th,td')).map(x => clean(x.textContent));
          if (!headers.length || headers.length !== values.length) continue;

          const podIdx = headers.findIndex(t => /^Discharging Port$/i.test(t));
          const etaIdx = headers.findIndex(t => /^Estimated Arrival Date$/i.test(t));
          if (podIdx >= 0 || etaIdx >= 0) {
            return {
              pod: podIdx >= 0 ? (values[podIdx] || '') : '',
              eta: etaIdx >= 0 ? (values[etaIdx] || '') : '',
            };
          }
        }
      }
      return { pod: '', eta: '' };
    }

    const extracted = extractFromHeaderValueTable();
    const etaMatch = clean(extracted.eta).match(/\d{4}\/\d{2}\/\d{2}\s+\d{2}:\d{2}:\d{2}/);
    return {
      pod: clean(extracted.pod),
      eta: etaMatch ? etaMatch[0] : clean(extracted.eta),
    };
  });

  return { pod: cleanValue(result.pod), eta: cleanValue(result.eta) };
}

function cleanValue(v) {
  return String(v || '').replace(/\s+/g, ' ').trim();
}

module.exports = trackIAL;

if (require.main === module) {
  const trackingNumber = process.argv[2] || 'A59FOO2298';
  trackIAL(trackingNumber).then(result => {
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.status === 'success' ? 0 : 1);
  });
}
