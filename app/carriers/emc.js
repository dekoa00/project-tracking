const { chromium } = require('playwright');

const TRACK_URL = 'https://ct.shipmentlink.com/servlet/TDB1_CargoTracking.do';

async function trackEMC(trackingNumber, options = {}) {
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
      viewport: { width: 1700, height: 1000 },
    });

    page = await context.newPage();
    page.setDefaultTimeout(30000);

    await page.goto(TRACK_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(1200);

    await acceptCookie(page);
    await searchTracking(page, trackingNumber);
    await waitForResults(page);

    const summary = await extractSummary(page);

    if (!summary.eta && summary.pod) {
      const fallbackEta = await extractEtaFromContainerMoves(page, summary.pod);
      if (fallbackEta) summary.eta = fallbackEta;
    }

    return {
      status: 'success',
      carrier: 'EMC',
      trackingNumber,
      pod: summary.pod,
      eta: summary.eta,
      error: '',
    };
  } catch (error) {
    return {
      status: 'error',
      carrier: 'EMC',
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

async function acceptCookie(page) {
  const candidates = [
    page.locator('#onetrust-accept-btn-handler'),
    page.getByRole('button', { name: /accept all/i }),
    page.getByRole('button', { name: /^accept$/i }),
    page.getByRole('button', { name: /^agree$/i }),
    page.getByRole('button', { name: /^ok$/i }),
    page.locator('button:has-text("Accept All")'),
    page.locator('button:has-text("Accept")'),
    page.locator('button:has-text("Agree")'),
    page.locator('button:has-text("OK")'),
  ];

  for (const locator of candidates) {
    try {
      const button = locator.first();
      if (await button.count()) {
        await button.click({ timeout: 2000, force: true }).catch(() => {});
        await page.waitForTimeout(600);
        break;
      }
    } catch (_) {}
  }
}

async function searchTracking(page, trackingNumber) {
  const billRadioCandidates = [
    page.locator('input[type="radio"][value="B"]'),
    page.getByLabel(/Bill of Lading No\./i),
    page.getByText(/Bill of Lading No\./i).first(),
  ];

  for (const radio of billRadioCandidates) {
    try {
      if (await radio.count()) {
        await radio.click({ timeout: 2000, force: true }).catch(() => {});
        break;
      }
    } catch (_) {}
  }

  const inputCandidates = [
    page.locator('#NO_ec-mb-1'),
    page.locator('#NO'),
    page.locator('input[name="NO"]'),
    page.locator('input[id^="NO_"]'),
  ];

  let input = null;
  for (const candidate of inputCandidates) {
    try {
      if (await candidate.count()) {
        input = candidate.first();
        await input.waitFor({ state: 'attached', timeout: 10000 });
        break;
      }
    } catch (_) {}
  }

  if (!input) {
    throw new Error('EMC tracking input not found');
  }

  await input.click({ force: true }).catch(() => {});
  await input.fill('').catch(() => {});
  try {
    await input.fill(trackingNumber);
  } catch (_) {
    await input.type(trackingNumber, { delay: 60 });
  }
  await page.waitForTimeout(300);

  const submitCandidates = [
    page.getByRole('button', { name: /submit/i }),
    page.locator('input[type="submit"][value*="Submit"]'),
    page.locator('input[type="button"][value*="Submit"]'),
    page.locator('button:has-text("Submit")'),
  ];

  for (const candidate of submitCandidates) {
    try {
      const button = candidate.first();
      if (await button.count()) {
        await button.click({ timeout: 3000, force: true });
        await page.waitForTimeout(800);
        return;
      }
    } catch (_) {}
  }

  await input.press('Enter').catch(() => {});
  await page.waitForTimeout(800);
}

async function waitForResults(page) {
  const candidates = [
    page.locator('text=/Basic Information/i').first(),
    page.locator('text=/Port of Discharge/i').first(),
    page.locator('text=/Estimated Date of Arrival at Destination/i').first(),
    page.locator('text=/B\/L No\./i').first(),
  ];

  for (const candidate of candidates) {
    try {
      await candidate.waitFor({ state: 'visible', timeout: 15000 });
      await page.waitForTimeout(800);
      return;
    } catch (_) {}
  }

  throw new Error('EMC result did not appear after search');
}

async function extractSummary(page) {
  const summary = await page.evaluate(() => {
    function clean(value) {
      return String(value || '').replace(/\s+/g, ' ').trim();
    }

    function extractDate(value) {
      const text = clean(value);
      const match = text.match(/\b[A-Z]{3}-\d{2}-\d{4}\b/i);
      return match ? match[0].toUpperCase() : '';
    }

    const rows = Array.from(document.querySelectorAll('tr'));
    let pod = '';
    let eta = '';

    for (const row of rows) {
      const cells = Array.from(row.querySelectorAll('td, th')).map(cell => clean(cell.textContent));
      if (!cells.length) continue;

      for (let i = 0; i < cells.length; i++) {
        const label = cells[i];
        const value = cells[i + 1] || '';

        if (!pod && /^Port of Discharge$/i.test(label)) {
          pod = value;
        }

        if (!eta && /^Estimated Date of Arrival at Destination:?$/i.test(label)) {
          eta = extractDate(value);
        }
      }

      const rowText = clean(row.textContent);
      if (!eta && /Estimated Date of Arrival at Destination/i.test(rowText)) {
        eta = extractDate(rowText);
      }
    }

    return { pod: clean(pod), eta: clean(eta) };
  });

  return {
    pod: cleanValue(summary.pod),
    eta: cleanValue(summary.eta),
  };
}

async function extractEtaFromContainerMoves(page, pod) {
  await openContainerMoves(page);

  const eta = await page.evaluate((pod) => {
    function clean(value) {
      return String(value || '').replace(/\s+/g, ' ').trim();
    }

    function normalizeLocation(value) {
      return clean(value)
        .toUpperCase()
        .replace(/\s+/g, ' ')
        .replace(/\s*,\s*/g, ', ')
        .trim();
    }

    function extractDate(value) {
      const text = clean(value).toUpperCase();
      const match = text.match(/\b[A-Z]{3}-\d{2}-\d{4}\b/);
      return match ? match[0] : '';
    }

    const podNorm = normalizeLocation(pod);
    if (!podNorm) return '';

    const scope = document.querySelector('#CtnMovesInfo') || document;
    const rows = Array.from(scope.querySelectorAll('tr'));

    for (const row of rows) {
      const cells = Array.from(row.querySelectorAll('td, th')).map(cell => clean(cell.textContent));
      if (cells.length < 2) continue;

      const date = extractDate(cells[0]);
      const moveText = clean(cells.slice(1).join(' '));
      if (!date || !moveText) continue;
      if (!/Discharged\s*\(FCL\)/i.test(moveText)) continue;

      const atMatch = moveText.match(/\bat\s+(.+)$/i);
      const locationText = atMatch ? atMatch[1] : moveText;
      const locationNorm = normalizeLocation(locationText);

      if (locationNorm === podNorm || locationNorm.includes(podNorm) || podNorm.includes(locationNorm)) {
        return date;
      }
    }

    return '';
  }, pod);

  return cleanValue(eta);
}

async function openContainerMoves(page) {
  async function hasVisibleMovesRows() {
    return await page.evaluate(() => {
      const scope = document.querySelector('#CtnMovesInfo');
      if (!scope) return false;
      const text = (scope.innerText || '').replace(/\s+/g, ' ').trim();
      return /Container Moves/i.test(text) && /Discharged|Loaded|Received|Empty/i.test(text);
    }).catch(() => false);
  }

  if (await hasVisibleMovesRows()) return true;

  const containerLink = page.locator('a').filter({ hasText: /^[A-Z]{4}\d{7}$/ }).first();
  if (await containerLink.isVisible({ timeout: 3000 }).catch(() => false)) {
    await containerLink.scrollIntoViewIfNeeded().catch(() => {});
    await containerLink.click({ force: true, timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(1000);
  }

  const movesLinkCandidates = [
    page.locator('a:has-text("Container Moves")').first(),
    page.getByText(/Container Moves/i).first(),
  ];

  for (const locator of movesLinkCandidates) {
    try {
      if (await locator.isVisible({ timeout: 2000 })) {
        await locator.scrollIntoViewIfNeeded().catch(() => {});
        await locator.click({ force: true, timeout: 3000 }).catch(() => {});
        await page.waitForTimeout(1000);
        if (await hasVisibleMovesRows()) return true;
      }
    } catch (_) {}
  }

  if (await hasVisibleMovesRows()) return true;

  // One more fallback: click first container number again, because EMC renders moves only after selecting a container.
  if (await containerLink.isVisible({ timeout: 1000 }).catch(() => false)) {
    await containerLink.click({ force: true, timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(1200);
  }

  return await hasVisibleMovesRows();
}

function cleanValue(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

module.exports = trackEMC;

if (require.main === module) {
  const trackingNumber = process.argv[2] || '235600496071';
  trackEMC(trackingNumber).then(result => {
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.status === 'success' ? 0 : 1);
  });
}
