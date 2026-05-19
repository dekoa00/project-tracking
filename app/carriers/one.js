const { chromium } = require('playwright');

const TRACK_URL = 'https://ecomm.one-line.com/one-ecom/manage-shipment/cargo-tracking';

async function trackONE(trackingNumber, options = {}) {
  let browser;
  let context;
  let page;

  const headless = options.headless ?? (process.env.CI ? true : false);
  const slowMo = options.slowMo ?? 100;

  try {
    browser = await chromium.launch({
      ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : (process.env.CI ? {} : { channel: 'msedge' })),
      headless,
      slowMo,
    });

    context = await browser.newContext({
      viewport: { width: 1800, height: 1000 },
    });

    page = await context.newPage();
    page.setDefaultTimeout(30000);

    await openTrackingPage(page);

    const searchNumbers = buildONESearchNumbers(trackingNumber);
    const tried = [];

    for (let i = 0; i < searchNumbers.length; i += 1) {
      const searchNumber = searchNumbers[i];
      tried.push(searchNumber);

      // ONE sometimes keeps failed search state/chips on the page. Reloading between
      // fallback candidates is slower but much more stable.
      if (i > 0) {
        await openTrackingPage(page);
      }

      await searchTracking(page, searchNumber);
      await waitForResults(page);

      const summary = await extractFirstPodArrival(page);
      if (summary.pod || summary.eta) {
        return {
          status: 'success',
          carrier: 'ONE',
          trackingNumber,
          searchedTrackingNumber: searchNumber,
          pod: summary.pod,
          eta: summary.eta,
          error: '',
        };
      }
    }

    return {
      status: 'error',
      carrier: 'ONE',
      trackingNumber,
      pod: '',
      eta: '',
      error: `No ONE tracking result found. Tried: ${tried.join(', ')}`,
    };
  } catch (error) {
    return {
      status: 'error',
      carrier: 'ONE',
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

async function openTrackingPage(page) {
  await page.goto(TRACK_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(1500);
  await skipIntro(page);
  await dismissCookieBar(page);
}

async function skipIntro(page) {
  const candidates = [
    page.getByRole('button', { name: /^skip$/i }),
    page.locator('button:has-text("Skip")'),
    page.locator('text=Customize Columns').locator('xpath=ancestor::*[self::div or self::section][1]').locator('button:has-text("Skip")'),
  ];

  for (const locator of candidates) {
    try {
      const button = locator.first();
      if (await button.isVisible({ timeout: 2500 }).catch(() => false)) {
        await button.click({ timeout: 3000, force: true }).catch(() => {});
        await page.waitForTimeout(500);
        return;
      }
    } catch (_) {}
  }
}

async function dismissCookieBar(page) {
  const candidates = [
    page.locator('button:has-text("Accept")'),
    page.locator('button:has-text("Accept All")'),
    page.locator('#onetrust-accept-btn-handler'),
    page.locator('.cc-dismiss, .cookie-dismiss, .ot-sdk-show-settings'),
  ];

  for (const locator of candidates) {
    try {
      const button = locator.first();
      if (await button.isVisible({ timeout: 1500 }).catch(() => false)) {
        await button.click({ timeout: 2000, force: true }).catch(() => {});
        await page.waitForTimeout(400);
        return;
      }
    } catch (_) {}
  }

  const closeBar = page.locator('div[role="button"]').filter({ hasText: '×' }).last();
  if (await closeBar.isVisible({ timeout: 1000 }).catch(() => false)) {
    await closeBar.click({ force: true }).catch(() => {});
    await page.waitForTimeout(400);
  }
}

async function searchTracking(page, trackingNumber) {
  const inputCandidates = [
    page.locator('input[data-testid="tnt-search-multiple-input"]').first(),
    page.locator('input[placeholder*="B/L" i]').first(),
    page.locator('input[placeholder*="Booking" i]').first(),
    page.locator('input').first(),
  ];

  let input = null;
  for (const candidate of inputCandidates) {
    if (await candidate.isVisible({ timeout: 5000 }).catch(() => false)) {
      input = candidate;
      break;
    }
  }

  if (!input) throw new Error('ONE search input not found');

  await input.click({ force: true });
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A').catch(() => {});
  await page.keyboard.press('Backspace').catch(() => {});
  await input.fill('');
  await input.fill(trackingNumber);
  await page.waitForTimeout(300);

  const searchBtnCandidates = [
    page.locator('button[data-testid="tnt-search-multiple-button"]'),
    page.locator('#cargo-tracking-search-btn'),
    page.getByRole('button', { name: /^search$/i }),
    page.locator('button:has-text("Search")'),
  ];

  for (const locator of searchBtnCandidates) {
    try {
      const button = locator.first();
      if (await button.isVisible({ timeout: 2000 }).catch(() => false)) {
        await button.click({ timeout: 5000, force: true });
        await page.waitForTimeout(1000);
        return;
      }
    } catch (_) {}
  }

  await input.press('Enter').catch(() => {});
  await page.waitForTimeout(1000);
}

async function waitForResults(page) {
  const candidates = [
    page.locator('div[data-testid="tnt-cargo-tracking-table"]'),
    page.locator('text=/POD\/Vessel Arrival/i').first(),
    page.locator('text=/Total \d+ results/i').first(),
    page.locator('text=/No result|No data|not found/i').first(),
    page.locator('[role="row"]').nth(1),
  ];

  for (const candidate of candidates) {
    try {
      await candidate.waitFor({ state: 'visible', timeout: 15000 });
      break;
    } catch (_) {}
  }

  await page.waitForTimeout(1800);
}

async function extractFirstPodArrival(page) {
  const result = await page.evaluate(() => {
    function clean(value) {
      return String(value || '').replace(/\s+/g, ' ').trim();
    }

    function looksLikeDateTime(value) {
      return /^\d{4}-\d{2}-\d{2}(?:\s+\d{2}:\d{2}(?::\d{2})?)?$/.test(clean(value));
    }

    const table = document.querySelector('div[data-testid="tnt-cargo-tracking-table"]') || document.body;
    const body = table.querySelector('div[class*="Table_body__"]') || table;
    const rows = Array.from(body.querySelectorAll('div[role="row"]'));

    const dataRow = rows.find(row => row.querySelector('a, div[class*="pod-vessel-arrival-selector-alias"]'));
    if (!dataRow) return { pod: '', eta: '' };

    const podCell = dataRow.querySelector('div[class*="Table_pod-vessel-arrival-selector-alias"], div[class*="pod-vessel-arrival-selector-alias"]');
    if (!podCell) return { pod: '', eta: '' };

    const directDivs = Array.from(podCell.querySelectorAll(':scope > div'))
      .map(el => clean(el.textContent))
      .filter(Boolean);

    let pod = '';
    let eta = '';

    if (directDivs.length) {
      pod = directDivs.find(t => !looksLikeDateTime(t)) || '';
      eta = directDivs.find(looksLikeDateTime) || '';
    }

    const raw = clean(podCell.textContent);
    if (!eta) {
      const m = raw.match(/\b\d{4}-\d{2}-\d{2}(?:\s+\d{2}:\d{2}(?::\d{2})?)?\b/);
      eta = m ? m[0] : '';
    }
    if (!pod) {
      pod = raw.replace(eta, '').replace(/\s+[A-Z]$/, '').trim();
    }
    pod = pod.replace(/\s+,/g, ',').trim();

    return { pod, eta };
  });

  return {
    pod: cleanValue(result.pod),
    eta: cleanValue(result.eta),
  };
}

function buildONESearchNumbers(value) {
  const raw = cleanValue(value).toUpperCase().replace(/\s+/g, '');
  const candidates = [];

  function add(v) {
    const cleaned = cleanValue(v).toUpperCase().replace(/\s+/g, '');
    if (cleaned && !candidates.includes(cleaned)) candidates.push(cleaned);
  }

  add(raw);

  // ONE B/L can appear as either ONEYSGNG90089500 or SGNG90089500.
  // Try both every time so Excel can keep either format.
  if (raw.startsWith('ONEY') && raw.length > 4) {
    add(raw.slice(4));
  } else if (raw) {
    add(`ONEY${raw}`);
  }

  return candidates;
}

function cleanValue(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

module.exports = trackONE;

if (require.main === module) {
  const trackingNumber = process.argv[2] || 'SGNG81645300';
  trackONE(trackingNumber).then(result => {
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.status === 'success' ? 0 : 1);
  });
}
